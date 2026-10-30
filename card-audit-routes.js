// card-audit-routes.js — Card audit page (Accounting) + a password login for the money pages.
//
// Installed with two lines in server.js:
//   EARLY (right after express.json):  installCardAuditGate(app)   — login for money pages
//   LATE  (after the payouts line):    installCardAudit(app, rvFetch)
//
// Secrets (Google Secret Manager, project property-agent-496300) — never in env vars, never logged:
//   card-audit-password   the shared password for the money pages
//   plaid-client-id       Plaid client ID
//   plaid-secret          Plaid production secret
//   plaid-token-chase     the Chase connection (written by this page after you connect Chase)
// Notes people leave on charges are saved to gs://aloe-hub-data-496300/card-audit/marks.json
// Read-only against Rentvine. Never writes to Rentvine, Chase or Plaid (except creating the connection you start).

import crypto from 'crypto';
import fetch from 'node-fetch';
import { matchAll, money } from './card-audit-match.js';

const PROJECT = 'property-agent-496300';
const BUCKET = 'aloe-hub-data-496300';
const MARKS_OBJECT = 'card-audit/marks.json';
const PAYEES = ['3229', '3380']; // Aloe PM - REIMBURSEMENTS, Aloe Property Management-Vendor
const PLAID_BASE = 'https://production.plaid.com';
const COOKIE = 'aloe_money';
const SESSION_HOURS = 12;

// ── Google access (metadata server token, same way the hub already reaches storage) ──
let gTok = null;
async function gToken() {
  if (gTok && gTok.exp > Date.now() + 60000) return gTok.v;
  const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
  if (!r.ok) throw new Error('Google token unavailable (' + r.status + ')');
  const j = await r.json();
  gTok = { v: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return gTok.v;
}
const secretCache = {};
async function readSecret(name, { fresh = false } = {}) {
  const c = secretCache[name];
  if (!fresh && c && c.exp > Date.now()) return c.v;
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${name}/versions/latest:access`, { headers: { Authorization: 'Bearer ' + (await gToken()) } });
  if (r.status === 404) { secretCache[name] = { v: null, exp: Date.now() + 60000 }; return null; }
  if (!r.ok) throw new Error(`secret ${name} not readable (${r.status})`);
  const v = Buffer.from((await r.json()).payload.data, 'base64').toString('utf8').trim();
  secretCache[name] = { v: v || null, exp: Date.now() + 5 * 60000 };
  return v || null;
}
async function addSecretVersion(name, value) {
  const r = await fetch(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${name}:addVersion`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + (await gToken()), 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: { data: Buffer.from(value, 'utf8').toString('base64') } }),
  });
  if (!r.ok) throw new Error(`could not save ${name} (${r.status})`);
  secretCache[name] = { v: value, exp: Date.now() + 5 * 60000 };
}

// ── Login for the money pages ────────────────────────────────────────────────
const PROTECTED = [/^\/card-audit(\/|$)/, /^\/recon-bills/, /^\/recon\/?$/, /^\/bank-setup/, /^\/plaid-setup/, /^\/api\/plaid\//, /^\/api\/card-audit\//];
const OPEN = new Set(['/card-audit/login', '/api/card-audit/login', '/api/card-audit/logout']);
const attempts = new Map();
const keyFor = (pw) => crypto.createHash('sha256').update('aloe-card-audit-cookie|' + pw).digest();
function sign(pw, exp) { return exp + '.' + crypto.createHmac('sha256', keyFor(pw)).update(String(exp)).digest('base64url'); }
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim()); }
  return null;
}
async function isAuthed(req) {
  const v = readCookie(req, COOKIE);
  if (!v) return false;
  const pw = await readSecret('card-audit-password');
  if (!pw) return false;
  const exp = parseInt(v.split('.')[0], 10);
  if (!exp || exp < Date.now()) return false;
  const want = Buffer.from(sign(pw, exp)), got = Buffer.from(v);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export function installCardAuditGate(app) {
  app.use(async (req, res, next) => {
    const p = req.path;
    if (OPEN.has(p) || !PROTECTED.some((re) => re.test(p))) return next();
    try {
      if (await isAuthed(req)) return next();
    } catch (e) {
      console.error('[card-audit] login check failed:', e.message);
      return res.status(503).type('text').send('The login for this page is not set up yet (password secret not readable).');
    }
    if (p.startsWith('/api/')) return res.status(401).json({ error: 'login required' });
    return res.redirect('/card-audit/login?next=' + encodeURIComponent(req.originalUrl));
  });

  app.get('/card-audit/login', (req, res) => res.type('html').send(LOGIN_HTML));
  app.post('/api/card-audit/login', async (req, res) => {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const a = attempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 15 * 60000) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 10) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes.' });
    let pw;
    try { pw = await readSecret('card-audit-password', { fresh: true }); } catch (e) { return res.status(503).json({ error: 'Login is not set up yet.' }); }
    if (!pw) return res.status(503).json({ error: 'Login is not set up yet.' });
    const given = String((req.body && req.body.password) || '');
    const ok = given.length === pw.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(pw));
    if (!ok) { a.n++; attempts.set(ip, a); return res.status(401).json({ error: 'Wrong password.' }); }
    attempts.delete(ip);
    const exp = Date.now() + SESSION_HOURS * 3600000;
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(sign(pw, exp))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`);
    res.json({ ok: true });
  });
  app.post('/api/card-audit/logout', (req, res) => { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`); res.json({ ok: true }); });
}

// ── Plaid ────────────────────────────────────────────────────────────────────
async function plaid(endpoint, body) {
  const [client_id, secret] = await Promise.all([readSecret('plaid-client-id'), readSecret('plaid-secret')]);
  if (!client_id || !secret) throw Object.assign(new Error('Plaid keys are not set up yet'), { code: 'NO_KEYS' });
  const r = await fetch(PLAID_BASE + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id, secret, ...body }) });
  const j = await r.json();
  if (j.error_code) throw Object.assign(new Error(j.error_message || j.error_code), { code: j.error_code });
  return j;
}
let txCache = null;
async function chaseTransactions(days) {
  if (txCache && txCache.days >= days && txCache.exp > Date.now()) return txCache.v;
  const token = await readSecret('plaid-token-chase');
  if (!token) return null;
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  let offset = 0, total = Infinity, tx = [], accounts = [];
  while (offset < total && offset < 10000) {
    const j = await plaid('/transactions/get', { access_token: token, start_date: start, end_date: end, options: { count: 500, offset } });
    accounts = j.accounts || accounts;
    total = j.total_transactions;
    tx.push(...j.transactions);
    if (!j.transactions.length) break;
    offset += j.transactions.length;
  }
  const credit = new Set(accounts.filter((a) => a.type === 'credit').map((a) => a.account_id));
  const useIds = credit.size ? credit : new Set(accounts.map((a) => a.account_id));
  const maskOf = Object.fromEntries(accounts.map((a) => [a.account_id, a.mask || '']));
  const v = tx.filter((t) => useIds.has(t.account_id)).map((t) => ({
    id: t.transaction_id, date: t.authorized_date || t.date, description: t.merchant_name ? `${t.name}` : t.name, amount: money(t.amount), pending: !!t.pending,
    card: t.account_owner || maskOf[t.account_id] || '',
  }));
  txCache = { v, days, exp: Date.now() + 10 * 60000 };
  return v;
}

// ── Rentvine bills (read-only) ───────────────────────────────────────────────
const rows = (r) => (Array.isArray(r) ? r : (r && (r.rows || r.data)) || []).map((x) => x.data || x);
async function allPages(rvFetch, route, report, max = 20) {
  const out = []; let prev = null;
  for (let page = 1; page <= max; page++) {
    const r = await rvFetch('/reports/' + route, { exportTypeID: 1, json: JSON.stringify(report), page, pageSize: 200 });
    if (r && r.error) throw new Error(route + ': ' + r.error);
    const b = rows(r);
    if (!b.length) break;
    const sig = b.length + JSON.stringify(b[0]) + JSON.stringify(b[b.length - 1]);
    if (sig === prev) break; prev = sig;
    out.push(...b);
    if (b.length < 200) break;
  }
  return out;
}
let addrCache = null;
async function addresses(rvFetch) {
  if (addrCache && addrCache.exp > Date.now()) return addrCache.v;
  const list = await allPages(rvFetch, 'property', { displayColumns: ['propertyID', 'propertyAddress', 'propertyCity'], filters: [] }, 10);
  const v = {}; for (const p of list) v[String(p.propertyID)] = [p.propertyAddress, p.propertyCity].filter(Boolean).join(', ');
  addrCache = { v, exp: Date.now() + 3600000 };
  return v;
}
let billCache = null;
async function reimbursementBills(rvFetch, days) {
  if (billCache && billCache.days >= days && billCache.exp > Date.now()) return billCache.v;
  const start = new Date(Date.now() - (days + 30) * 86400000).toISOString().slice(0, 10);
  const end = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const report = {
    displayColumns: ['billID', 'datePosted', 'propertyID', 'contact', 'amount', 'description', 'reference', 'isVoided'],
    filters: [{ name: 'datePosted', comparator: 'betweenDate', startDate: start, endDate: end }, { name: 'payeeContactID', comparator: 'in', values: PAYEES }, { name: 'isVoided', comparator: 'booleanFalse' }],
  };
  // Second pull: every bill in the same window (any payee). A card charge whose only bill is
  // payable to the vendor itself (not Reimbursements) is shown as orange — the vendor could be paid twice.
  const allReport = { displayColumns: report.displayColumns, filters: [report.filters[0], report.filters[2]] };
  const [list, everyBill, addr] = await Promise.all([allPages(rvFetch, 'payables', report, 25), allPages(rvFetch, 'payables', allReport, 60).catch((e) => { console.error('[card-audit] vendor bills:', e.message); return []; }), addresses(rvFetch)]);
  const reimbIds = new Set(list.map((b) => String(b.billID)));
  const seen = new Set(); const v = [];
  const add = (b, vendorBill) => {
    if (!b.billID) return;
    const voided = b.isVoided === true || b.isVoided === 1 || b.isVoided === '1';
    const payee = String(b.payeeContactID || b.contactID || '');
    if (voided || (!vendorBill && payee && !PAYEES.includes(payee))) return;
    if (b.datePosted && (b.datePosted < start && /^\d{4}-/.test(b.datePosted))) return;
    const key = b.billID + '|' + b.propertyID + '|' + b.amount + '|' + b.description;
    if (seen.has(key)) return; seen.add(key);
    v.push({ billID: b.billID, date: b.datePosted, propertyID: String(b.propertyID || ''), address: addr[String(b.propertyID)] || '', amount: money(b.amount), description: b.description || '', reference: b.reference || '', payee: b.contactName || (typeof b.contact === 'string' ? b.contact : '') || '', vendorBill });
  };
  for (const b of list) add(b, false);
  for (const b of everyBill) if (!reimbIds.has(String(b.billID))) add(b, true);
  billCache = { v, days, exp: Date.now() + 10 * 60000 };
  return v;
}

// ── Marks (people's notes on charges), stored in the hub's storage bucket ────
async function readMarks() {
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(MARKS_OBJECT)}?alt=media`, { headers: { Authorization: 'Bearer ' + (await gToken()) } });
  if (r.status === 404) return {};
  if (!r.ok) throw new Error('could not read notes (' + r.status + ')');
  return r.json();
}
let marksChain = Promise.resolve();
function saveMark(id, mark) {
  marksChain = marksChain.then(async () => {
    const m = await readMarks();
    if (mark) m[id] = mark; else delete m[id];
    const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(MARKS_OBJECT)}`, { method: 'POST', headers: { Authorization: 'Bearer ' + (await gToken()), 'Content-Type': 'application/json' }, body: JSON.stringify(m) });
    if (!r.ok) throw new Error('could not save note (' + r.status + ')');
    return m;
  });
  return marksChain;
}

// ── Routes ───────────────────────────────────────────────────────────────────
export function installCardAudit(app, rvFetch) {
  app.get('/card-audit', (req, res) => res.sendFile(new URL('./public/card-audit.html', import.meta.url).pathname));

  app.get('/api/card-audit/status', async (req, res) => {
    const out = { keys: false, connected: false, accounts: [] };
    try {
      out.keys = !!((await readSecret('plaid-client-id')) && (await readSecret('plaid-secret')));
      const token = out.keys && (await readSecret('plaid-token-chase'));
      if (token) {
        const j = await plaid('/accounts/get', { access_token: token });
        out.connected = true;
        out.accounts = j.accounts.map((a) => ({ name: a.name, mask: a.mask, type: a.type, subtype: a.subtype }));
      }
    } catch (e) { out.error = e.code === 'ITEM_LOGIN_REQUIRED' ? 'Chase needs to be reconnected (the bank asked for a new sign-in).' : e.message; }
    res.json(out);
  });

  app.post('/api/card-audit/plaid/link-token', async (req, res) => {
    try {
      const j = await plaid('/link/token/create', { user: { client_user_id: 'aloe-card-audit' }, client_name: 'Aloe Property Management', products: ['transactions'], transactions: { days_requested: 365 }, country_codes: ['US'], language: 'en' });
      res.json({ link_token: j.link_token });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/card-audit/plaid/exchange', async (req, res) => {
    try {
      const pub = req.body && req.body.public_token;
      if (!pub) return res.status(400).json({ error: 'public_token required' });
      const j = await plaid('/item/public_token/exchange', { public_token: pub });
      await addSecretVersion('plaid-token-chase', j.access_token);
      txCache = null;
      console.log('[card-audit] Chase connected (connection saved to Secret Manager)');
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/card-audit/data', async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 120, 14), 400);
    try {
      const [charges, bills, marks] = await Promise.all([chaseTransactions(days), reimbursementBills(rvFetch, days), readMarks().catch(() => ({}))]);
      if (!charges) return res.json({ connected: false, bills: bills.length });
      const out = matchAll(charges, bills, { today: new Date(), marks });
      const counts = out.charges.reduce((m, c) => ((m[c.color] = (m[c.color] || 0) + 1), m), {});
      res.json({ connected: true, days, asOf: new Date().toISOString(), counts, billCount: bills.length, ...out });
    } catch (e) {
      console.error('[card-audit] data error:', e.message);
      res.status(500).json({ error: e.code === 'PRODUCT_NOT_READY' ? 'Chase was just connected — Plaid is still loading the history. Try again in a few minutes.' : e.message });
    }
  });

  app.post('/api/card-audit/mark', async (req, res) => {
    try {
      const { id, status, note, by } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const ok = ['company', 'reimbursed', 'ignore', 'billing', ''].includes(status || '');
      if (!ok) return res.status(400).json({ error: 'bad status' });
      const mark = status || note ? { status: status || '', note: String(note || '').slice(0, 500), by: String(by || '').slice(0, 60), at: new Date().toISOString() } : null;
      await saveMark(String(id), mark);
      res.json({ ok: true, mark });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

const LOGIN_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aloe PM · Sign in</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#F8FAFC;display:grid;place-items:center;min-height:100vh;color:#0f2a33}
form{background:#fff;border:1px solid #dbe3e6;border-radius:12px;padding:28px;width:min(340px,90vw);box-shadow:0 4px 18px rgba(0,0,0,.05)}
h1{font-size:18px;margin:0 0 4px}p{margin:0 0 18px;color:#5b6b70;font-size:14px}input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #c8d3d6;border-radius:8px;font-size:15px}
button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:8px;background:#3CC3E1;color:#06303a;font-weight:600;font-size:15px;cursor:pointer}#e{color:#b42318;font-size:13px;min-height:18px;margin-top:8px}</style></head>
<body><form id="f"><h1>Accounting pages</h1><p>Enter the shared password.</p><input id="p" type="password" autocomplete="current-password" autofocus required><button>Sign in</button><div id="e"></div></form>
<script>document.getElementById('f').onsubmit=async function(ev){ev.preventDefault();var e=document.getElementById('e');e.textContent='';
var r=await fetch('/api/card-audit/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});
var j=await r.json().catch(function(){return{}});if(!r.ok){e.textContent=j.error||'Sign in failed';return}
var n=new URLSearchParams(location.search).get('next')||'/card-audit';location.href=n.charAt(0)==='/'&&n.charAt(1)!=='/'?n:'/card-audit';};</script></body></html>`;
