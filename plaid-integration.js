// ============================================================
// plaid-integration.js  —  Aloe PM Plaid Bank Integration
//
// Add to server.js:
//   import { initPlaidRoutes } from './plaid-integration.js';
//   initPlaidRoutes(app);
//
// Env vars needed:
//   PLAID_CLIENT_ID
//   PLAID_SECRET
//   PLAID_ENV  (sandbox | development | production)
// ============================================================

import fetch from 'node-fetch';

const PLAID_BASE_URLS = {
  sandbox:     'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production:  'https://production.plaid.com',
};

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET    = process.env.PLAID_SECRET;
const PLAID_ENV       = process.env.PLAID_ENV || 'production';
const PLAID_BASE      = PLAID_BASE_URLS[PLAID_ENV];

// In-memory token store — replace with a DB/env var for persistence
// Keys are your internal account IDs (e.g. 'trust', 'security', 'employee')
// Values are Plaid access_tokens obtained from the Link flow
const ACCESS_TOKENS = {
  trust:    process.env.PLAID_TOKEN_TRUST    || null,
  security: process.env.PLAID_TOKEN_SECURITY || null,
  employee: process.env.PLAID_TOKEN_EMPLOYEE || null,
  chase:    process.env.PLAID_TOKEN_CHASE    || null,
};

const ACCOUNT_MAP = {
  trust:    { name: 'Rental Trust Account',    rvId: '129', number: '1000', mask: '3221' },
  security: { name: 'Security Deposit Account', rvId: '130', number: '1100', mask: '3248' },
  employee: { name: 'Employee Trust',           rvId: '149', number: '3100', mask: '0327' },
  chase:    { name: 'Chase Card (Reimbursements)', rvId: null, number: '8412', mask: null },
};

async function plaidPost(endpoint, body) {
  const r = await fetch(`${PLAID_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      ...body,
    }),
  });
  const data = await r.json();
  if (data.error_code) throw new Error(`Plaid ${data.error_code}: ${data.error_message}`);
  return data;
}

export function initPlaidRoutes(app) {

  // ── Step 1: Create a link_token (called when user opens setup page) ────────
  app.post('/api/plaid/create-link-token', async (req, res) => {
    try {
      const data = await plaidPost('/link/token/create', {
        user: { client_user_id: 'aloe-pm-admin' },
        client_name: 'Aloe Property Management',
        products: ['transactions'],
        country_codes: ['US'],
        language: 'en',
        // If re-linking an existing account, pass access_token here
        ...(req.body.access_token ? {
          access_token: req.body.access_token,
          products: undefined,
        } : {}),
      });
      res.json({ link_token: data.link_token });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Step 2: Exchange public_token for access_token (called after Link flow) -
  app.post('/api/plaid/exchange-token', async (req, res) => {
    const { public_token, account_key } = req.body;
    if (!public_token || !account_key) {
      return res.status(400).json({ error: 'public_token and account_key required' });
    }
    try {
      const data = await plaidPost('/item/public_token/exchange', { public_token });
      // Store token — in production save to DB or Render env var
      ACCESS_TOKENS[account_key] = data.access_token;
      console.log(`[plaid] Token saved for ${account_key} — item_id: ${data.item_id}`);
      // (access token intentionally not logged)
      res.json({ success: true, item_id: data.item_id, account_key });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Step 3: Get transactions for an account ─────────────────────────────────
  app.get('/api/plaid/transactions', async (req, res) => {
    const { account_key, start_date, end_date } = req.query;
    if (!account_key) return res.status(400).json({ error: 'account_key required' });

    const token = ACCESS_TOKENS[account_key];
    if (!token) return res.status(400).json({ error: `No access token for ${account_key} — complete setup first` });

    try {
      // Use /transactions/get (sync) — works for up to 2 years of history
      const data = await plaidPost('/transactions/get', {
        access_token: token,
        start_date: start_date || new Date(Date.now() - 90*24*60*60*1000).toISOString().slice(0,10),
        end_date: end_date || new Date().toISOString().slice(0,10),
        options: { count: 500, offset: 0, include_personal_finance_category: true },
      });

      // Find the specific account_id matching our mask for this account slot
      const targetMask = ACCOUNT_MAP[account_key]?.mask;
      const matchedAccount = targetMask
        ? data.accounts?.find(a => a.mask === targetMask)
        : data.accounts?.[0];
      const targetAccountId = matchedAccount?.account_id;
      const isCreditCard = matchedAccount?.type === 'credit' || account_key === 'chase';

      // Filter to only transactions from the matching account
      const filtered = targetAccountId
        ? data.transactions.filter(t => t.account_id === targetAccountId)
        : data.transactions;

      // Normalize to the same shape the recon tool expects
      const normalized = filtered.map(t => ({
        date: t.date,
        description: t.name || t.merchant_name || '',
        amount: Math.abs(t.amount),
        // Plaid: positive amount = debit/charge (money out), negative = credit/payment (money in)
        // For credit cards this is the same convention — positive = charge
        direction: t.amount > 0 ? 'out' : 'in',
        pending: t.pending,
        category: t.personal_finance_category?.primary || '',
        transactionId: t.transaction_id,
        accountMask: matchedAccount?.mask || '',
      }));

      res.json({
        account: ACCOUNT_MAP[account_key],
        total: normalized.length,
        start_date,
        end_date,
        transactions: normalized,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Get balance for all connected accounts ──────────────────────────────────
  app.get('/api/plaid/balances', async (req, res) => {
    const results = {};
    for (const [key, token] of Object.entries(ACCESS_TOKENS)) {
      if (!token) { results[key] = { connected: false }; continue; }
      try {
        const data = await plaidPost('/accounts/balance/get', { access_token: token });
        // Find the specific sub-account matching our mask
        const targetMask = ACCOUNT_MAP[key]?.mask;
        const matched = targetMask
          ? data.accounts?.find(a => a.mask === targetMask)
          : data.accounts?.[0];
        results[key] = {
          connected: true,
          name: ACCOUNT_MAP[key].name,
          // Primary balance — the correct sub-account
          available: matched?.balances?.available ?? null,
          current: matched?.balances?.current ?? null,
          accountName: matched?.name || null,
          mask: matched?.mask || null,
          // All accounts on this token for reference
          accounts: data.accounts.map(a => ({
            name: a.name,
            mask: a.mask,
            available: a.balances.available,
            current: a.balances.current,
            type: a.type,
            subtype: a.subtype,
            isTarget: a.mask === targetMask,
          })),
        };
      } catch (e) {
        results[key] = { connected: true, error: e.message };
      }
    }
    res.json(results);
  });

  // ── Check which accounts are connected ─────────────────────────────────────
  app.get('/api/plaid/status', (req, res) => {
    const status = {};
    for (const [key, token] of Object.entries(ACCESS_TOKENS)) {
      status[key] = {
        connected: !!token,
        name: ACCOUNT_MAP[key].name,
        number: ACCOUNT_MAP[key].number,
        rvId: ACCOUNT_MAP[key].rvId,
      };
    }
    res.json({ env: PLAID_ENV, accounts: status });
  });
}
