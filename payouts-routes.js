// Owner Payouts area for the Internal Hub. READ-ONLY against Rentvine (reports only). Nothing here writes to Rentvine.
// Scope: Rental Trust account only (bank account 129). Security-deposit account (130) is left off.
//
// Install (one line in server.js, right after the Maintenance install line):
//   const { installPayouts } = await import('./payouts-routes.js'); installPayouts(app, rvFetch);
import { portfolio, recurringExpected, FLAG_TEXT } from './payouts-data.js';
import { sessionOk } from './maintenance-routes.js';

export const TRUST_BANK_ACCOUNT_ID = 129;
const TTL = 2 * 60 * 1000;

// ---- helpers (exported for tests) ----
export const num = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
// Rentvine reports come back as { rows: [ { data: {...fields} } ] } (the hub's other report code reads them the same way).
// Also accept a bare array or { data: [...] }, and unwrap each record's `data`.
export const rows = (r) => {
  const a = Array.isArray(r) ? r : (Array.isArray(r && r.rows) ? r.rows : (Array.isArray(r && r.data) ? r.data : []));
  return a.map((x) => (x && typeof x.data === 'object' && x.data !== null && !Array.isArray(x.data) ? x.data : x));
};

// Fee dollars from the fee plan name ("$89 Management Fee / ..."). "6% ..." is a percent of rent; "0..." is no fee.
export function feeFromPlanName(name, rent) {
  const s = String(name || '').trim();
  const dollar = s.match(/^\$\s*(\d+(?:\.\d+)?)/);
  if (dollar) return { fee: Number(dollar[1]), known: true };
  const pct = s.match(/^(\d+(?:\.\d+)?)\s*%\s*Management/i);
  if (pct) return { fee: Math.round(num(rent) * Number(pct[1])) / 100, known: true };
  if (/^0\b/.test(s)) return { fee: 0, known: true };
  return { fee: 0, known: false };
}

// Fetches every page of a report. Safety rails (a stuck loop crashed the first test server):
//  - stops when a page repeats the previous one (Rentvine ignoring `page` would otherwise loop forever)
//  - each record is trimmed to the fields we use as soon as it arrives, so memory stays small
//  - hard cap on pages
export async function allPages(rvFetch, route, report, { max = 25, fields = null, pageSize = 200 } = {}) {
  const out = [];
  let prevSig = null;
  for (let page = 1; page <= max; page++) {
    const r = await rvFetch('/reports/' + route, { exportTypeID: 1, json: JSON.stringify(report), page, pageSize });
    if (r && r.error) throw new Error(route + ': ' + r.error);
    let b = rows(r);
    if (!b.length) break;
    if (fields) b = b.map((x) => { const o = {}; for (const k of fields) if (x[k] !== undefined) o[k] = x[k]; return o; });
    const sig = b.length + '|' + JSON.stringify(b[0]) + '|' + JSON.stringify(b[b.length - 1]);
    if (sig === prevSig) break;
    prevSig = sig;
    out.push(...b);
    if (b.length < pageSize) break;
  }
  return out;
}

const PROP_COLS = ['propertyID', 'propertyAddress', 'propertyCity', 'portfolioID', 'portfolioName', 'portfolioOwnerIDs', 'managementFeeSettingID', 'managementFeeSettingName', 'isActive', 'property_text_61', 'property_text_62', 'property_text_63'];
const SETTLE_COLS = ['settlementDate', 'datePosted', 'propertyID', 'unitID', 'amount', 'contactID', 'payoutTypeID', 'bankAccountID'];
const LEASE_COLS = ['leaseID', 'propertyID', 'rentAmount', 'primaryLeaseStatusID', 'leaseStatusName', 'moveInDate', 'expectedMoveOutDate', 'noticeDate', 'isMovingOut'];
const BILL_COLS = ['transactionID', 'billID', 'propertyID', 'portfolioID', 'chargeAccountID', 'chargeAccountName', 'datePosted', 'dateDue', 'amount', 'amountUnpaid', 'isPaid', 'isVoided', 'isSuppressed', 'description', 'contactName'];
// Every unpaid bill (any date) plus everything posted in the window. Server-side filters are unreliable (isSuppressed is silently
// ignored), so only the two filters known to work are sent and everything else is filtered in code.
async function loadBills(rvFetch, from) {
  // one report at a time: keeps peak memory low (running them together is what crashed the first test server)
  const unpaid = await allPages(rvFetch, 'payables', { displayColumns: BILL_COLS, filters: [{ name: 'isPaid', comparator: 'booleanFalse' }, { name: 'isVoided', comparator: 'booleanFalse' }] }, { fields: BILL_COLS, max: 15 });
  const recent = await allPages(rvFetch, 'payables', { displayColumns: BILL_COLS, filters: [{ name: 'datePosted', comparator: 'betweenDate', startDate: from, endDate: today() }] }, { fields: BILL_COLS, max: 30 });
  const seen = new Set(), out = [];
  for (const b of [...unpaid, ...recent]) { const k = b.transactionID ?? (b.billID + ':' + b.propertyID + ':' + b.chargeAccountID + ':' + b.amount); if (!seen.has(k)) { seen.add(k); out.push(b); } }
  return out;
}

export const MGMT_FEE_ACCOUNT_ID = 93;
export const RECURRING_ACCOUNTS = { landscaping: 79, pest: 77, pool: 83 };
export const toISO = (v) => { if (!v) return ''; if (/^\d{4}-\d{2}-\d{2}/.test(String(v))) return String(v).slice(0, 10); const t = Date.parse(String(v).length === 10 ? v + 'T12:00:00Z' : v + ' 12:00 UTC'); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''; };
const truthy = (v) => v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
const daysAgo = (n) => { const d = new Date(Date.now() - n * 864e5); return d.toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' }); };

// Pull everything for the trust account and shape owners -> properties.
export async function loadPayoutData(rvFetch, { sinceDays = 45, typical = {}, reserve = 0 } = {}) {
  const from = daysAgo(sinceDays), to = today();
  const t0 = Date.now(), lap = (n) => console.log('payouts load', n, Date.now() - t0, 'ms', process.memoryUsage().rss >> 20, 'MB rss');
  const props = await allPages(rvFetch, 'property', { displayColumns: PROP_COLS, filters: [] }, { fields: PROP_COLS, max: 10 }); lap('properties ' + props.length);
  const settle = await allPages(rvFetch, 'settlement-detail', { displayColumns: SETTLE_COLS, filters: [{ name: 'settlementDate', comparator: 'betweenDate', startDate: from, endDate: to }] }, { fields: SETTLE_COLS, max: 30 }); lap('settlements ' + settle.length);
  const bills = await loadBills(rvFetch, from); lap('bills ' + bills.length);
  // active filter is done here, not in the report call (server-side filters are unreliable); a missing isActive field counts as active
  const active = props.filter((p) => p.isActive === undefined || p.isActive === '' || truthy(p.isActive));
  return { props: active, settle, bills, from, to, typical, reserve };
}

// Turn raw report rows into the owner list the math module expects. `rents` = { propertyID: monthlyRent }.
// Owners are grouped by PORTFOLIO. A portfolio can have several owner contacts; a payout to any of them counts as that portfolio's payout.
export function shapeOwners({ props, settle, bills, typical = {}, reserve = 0 }, rents = {}, expectedBill = new Set(), leaseInfo = {}, todayISO = today()) {
  const trust = settle.filter((r) => r.bankAccountID === undefined || num(r.bankAccountID) === TRUST_BANK_ACCOUNT_ID);
  const payoutsByContact = {};
  for (const r of trust) {
    if (num(r.payoutTypeID) === 4 && num(r.amount) < 0) {
      const k = String(r.contactID), d = toISO(r.settlementDate);
      if (!payoutsByContact[k] || d > payoutsByContact[k].date) payoutsByContact[k] = { date: d, amount: Math.abs(num(r.amount)) };
    }
  }
  const byPortfolio = new Map();
  for (const p of props) {
    const k = String(p.portfolioID);
    if (!byPortfolio.has(k)) byPortfolio.set(k, { id: k, name: p.portfolioName || 'Portfolio ' + k, ids: new Set(), props: [] });
    const o = byPortfolio.get(k);
    String(p.portfolioOwnerIDs || '').split(',').map((x) => x.trim()).filter(Boolean).forEach((x) => o.ids.add(x));
    o.props.push(p);
  }
  const billsBy = {};
  for (const b of bills) {
    if (truthy(b.isVoided) || truthy(b.isSuppressed)) continue;
    (billsBy[String(b.propertyID)] ||= []).push(b);
  }
  const owners = [];
  for (const o of byPortfolio.values()) {
    let lp = null;
    for (const id of o.ids) { const x = payoutsByContact[id]; if (x && (!lp || x.date > lp.date)) lp = x; }
    const since = lp ? lp.date : '0000-00-00';
    const properties = o.props.map((p) => {
      const id = String(p.propertyID);
      const rent = num(rents[id]);
      const plan = feeFromPlanName(p.managementFeeSettingName, rent);
      const inn = trust.filter((r) => String(r.propertyID) === id && num(r.amount) > 0 && num(r.payoutTypeID) !== 4 && toISO(r.settlementDate) > since).reduce((s, r) => s + num(r.amount), 0);
      // a bill counts if it is still unpaid, or was posted after this owner's last payout (paid bills already left the owner's balance)
      const counted = (billsBy[id] || []).filter((b) => !truthy(b.isPaid) || toISO(b.datePosted) > since);
      const feeBills = counted.filter((b) => num(b.chargeAccountID) === MGMT_FEE_ACCOUNT_ID);
      const postedFee = feeBills.reduce((s, b) => s + num(b.amount), 0);
      const fee = feeBills.length ? postedFee : (inn > 0 ? plan.fee : 0);
      const expense = counted.filter((b) => num(b.chargeAccountID) !== MGMT_FEE_ACCOUNT_ID).map((b) => ({
        amountUnpaid: truthy(b.isPaid) ? num(b.amount) : num(b.amountUnpaid || b.amount), isPaid: false, isVoided: false,
        desc: (b.description || b.chargeAccountName || 'Bill') + (truthy(b.isPaid) ? ' (paid ' + toISO(b.datePosted) + ')' : ' (unpaid)'), billID: b.billID, vendor: b.contactName,
      }));
      const lt = leaseTags(leaseInfo[id], lp ? lp.date : '', todayISO);
      const billHistory = markDuplicates((billsBy[id] || []).map((b) => ({
        billID: b.billID, date: toISO(b.datePosted), accountID: num(b.chargeAccountID), account: b.chargeAccountName || '', vendor: b.contactName || '', desc: b.description || '',
        amount: num(b.amount), unpaid: truthy(b.isPaid) ? 0 : num(b.amountUnpaid || b.amount), paid: truthy(b.isPaid), counted: counted.includes(b), dup: false,
      })).sort((x, y) => (y.date > x.date ? 1 : y.date < x.date ? -1 : 0)));
      return {
        tags: lt.tags, moveOutSoon: lt.moveOutSoon, lease: leaseInfo[id] || null, billHistory,
        propertyID: id, address: [p.propertyAddress, p.propertyCity].filter(Boolean).join(', '),
        rent, fee, feeKnown: feeBills.length ? true : plan.known, feePlan: (p.managementFeeSettingName || '') + (feeBills.length ? ' (posted)' : ' (expected)'),
        settledIn: inn, bills: expense,
        // an expected recurring bill is dropped once the real bill for it has already been posted in this window
        recurring: recurringExpected({ pool: p.property_text_61, pest: p.property_text_62, landscaping: p.property_text_63 }, typical).filter((r) => !counted.some((b) => num(b.chargeAccountID) === RECURRING_ACCOUNTS[r.key])),
        billExpected: expectedBill.has(id),
      };
    });
    owners.push({ ownerID: o.id, name: o.name, properties, lastPayout: lp ? lp.amount : null, lastPayoutDate: lp ? lp.date : null, reserve });
  }
  return owners;
}

// Rent and move-in / move-out dates per property from active leases (Lease report).
// info[propertyID] = { moveIn, moveOut, notice, status } as YYYY-MM-DD ("" when none). Move-out only counts when notice was given.
export async function defaultLeaseInfo(rvFetch) {
  const leases = await allPages(rvFetch, 'lease', { displayColumns: LEASE_COLS, filters: [{ name: 'primaryLeaseStatusID', comparator: 'equals', value: '2' }] }, { fields: LEASE_COLS, max: 15 });
  const rents = {}, info = {};
  for (const l of leases) {
    const id = String(l.propertyID);
    rents[id] = (rents[id] || 0) + num(l.rentAmount);
    const i = (info[id] ||= { moveIn: '', moveOut: '', notice: '', status: '' });
    const mi = toISO(l.moveInDate);
    if (mi && mi > i.moveIn) { i.moveIn = mi; i.status = l.leaseStatusName || i.status; }
    const leaving = truthy(l.isMovingOut) || /notice|vacat/i.test(String(l.leaseStatusName || '')) || !!toISO(l.noticeDate);
    const mo = toISO(l.expectedMoveOutDate);
    if (leaving && mo && (!i.moveOut || mo < i.moveOut)) { i.moveOut = mo; i.notice = toISO(l.noticeDate); }
  }
  return { rents, info };
}
export const defaultRents = async (rvFetch) => (await defaultLeaseInfo(rvFetch)).rents;

// Tags for the tenant side of a property: new move-in, moving out within 30 days / this month / next month.
const dayDiff = (a, b) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 864e5);
const md = (iso) => Number(iso.slice(5, 7)) + '/' + Number(iso.slice(8, 10));
const nextMonthKey = (iso) => { let y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)) + 1; if (m > 12) { m = 1; y++; } return y + '-' + String(m).padStart(2, '0'); };
export function leaseTags(info, since, todayISO) {
  const tags = []; let moveOutSoon = false;
  if (!info) return { tags, moveOutSoon };
  if (info.moveIn) {
    const age = dayDiff(todayISO, info.moveIn);
    if (age >= 0 && (age <= 45 || (since && since !== '0000-00-00' && info.moveIn > since))) tags.push({ key: 'new_move_in', text: 'New move-in ' + md(info.moveIn) });
  }
  if (info.moveOut) {
    const d = dayDiff(info.moveOut, todayISO);
    if (d <= 30 && d >= -30) { tags.push({ key: 'move_out_30', text: d < 0 ? 'Move-out date passed ' + md(info.moveOut) : 'Moving out ' + md(info.moveOut) + ' (' + d + (d === 1 ? ' day)' : ' days)') }); moveOutSoon = true; }
    if (info.moveOut.slice(0, 7) === todayISO.slice(0, 7)) tags.push({ key: 'move_out_month', text: 'Moving out this month ' + md(info.moveOut) });
    if (info.moveOut.slice(0, 7) === nextMonthKey(todayISO)) tags.push({ key: 'move_out_next', text: 'Moving out next month ' + md(info.moveOut) });
  }
  return { tags, moveOutSoon };
}

// Marks bills that look entered twice: same property, same account, same amount, same vendor or description, posted within 10 days.
export function markDuplicates(list) {
  const key = (b) => String(b.vendor || b.desc || '').trim().toLowerCase();
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (a.accountID === b.accountID && Math.abs(a.amount - b.amount) < 0.005 && key(a) === key(b) && a.date && b.date && Math.abs(dayDiff(a.date, b.date)) <= 10) { a.dup = true; b.dup = true; }
  }
  return list;
}

// Decisions (approve / hold / ask owner + note). Default store is in memory until you approve a real place to keep them.
export function makeMemoryDecisionStore() {
  const m = new Map();
  return { persistent: false, get: async () => Object.fromEntries(m), set: async (ownerID, d) => { m.set(String(ownerID), { ...d, at: new Date().toISOString() }); return m.get(String(ownerID)); } };
}

export function installPayouts(app, rvFetch, { decisions = makeMemoryDecisionStore(), getRents = null, getLeaseInfo = defaultLeaseInfo, getExpectedBills = async () => new Set(), typical = {}, reserve = 0, env = process.env } = {}) {
  if (typeof rvFetch !== 'function') throw new Error('installPayouts needs rvFetch');
  const guard = (req, res) => { if (!sessionOk(req, env)) { res.status(401).json({ error: 'Sign in required' }); return false; } return true; };
  let cache = { at: 0, v: null }, inflight = null;

  app.get('/payouts', (req, res) => res.sendFile(new URL('./public/payouts.html', import.meta.url).pathname));

  app.get('/api/payouts/list', async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const fresh = req.query.refresh === '1';
      if (!fresh && cache.v && Date.now() - cache.at < TTL) return res.json(cache.v);
      if (!inflight) inflight = (async () => {
      const raw = await loadPayoutData(rvFetch, { typical, reserve });
      const li = getRents ? { rents: await getRents(rvFetch), info: {} } : await getLeaseInfo(rvFetch);
      const rents = li.rents;
      const owners = shapeOwners(raw, rents, await getExpectedBills(rvFetch), li.info);
      const out = {
        asOf: new Date().toISOString(), scope: 'Rental Trust (bank account ' + TRUST_BANK_ACCOUNT_ID + ')', reserve,
        decisionsSaved: !!decisions.persistent, flagText: FLAG_TEXT,
        counts: { properties: raw.props.length, payments: raw.settle.length, bills: raw.bills.length, rents: Object.keys(rents).length },
        owners: portfolio(owners, {}), decisions: await decisions.get(),
      };
      cache = { at: Date.now(), v: out };
      return out;
      })().finally(() => { inflight = null; });
      const out = await inflight;
      res.json(out);
    } catch (e) { console.error('payouts list', e); res.status(502).json({ error: String(e.message || e) }); }
  });

  app.post('/api/payouts/decision', async (req, res) => {
    if (!guard(req, res)) return;
    const { ownerID, action, note } = req.body || {};
    if (!ownerID || !['approve', 'hold', 'ask_owner'].includes(action)) return res.status(400).json({ error: 'ownerID and action (approve|hold|ask_owner) required' });
    res.json(await decisions.set(ownerID, { action, note: String(note || '').slice(0, 500) }));
  });
}
