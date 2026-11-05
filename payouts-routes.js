// Owner Payouts area for the Internal Hub. READ-ONLY against Rentvine (reports only). Nothing here writes to Rentvine.
// Scope: Rental Trust account only (bank account 129). Security-deposit account (130) is left off.
//
// Install (one line in server.js, right after the Maintenance install line):
//   const { installPayouts } = await import('./payouts-routes.js'); installPayouts(app, rvFetch);
import { portfolio, recurringExpected, FLAG_TEXT } from './payouts-data.js';
import { buildPreview, runBatch } from './headsup.js';
import { findRecurring, recurringWindow, expectedFromHistory } from './recurring.js';
import { parseSetup, mergeSetup } from './recurring-setup.js';
import { buildStatement, addMonths, LOOKBACK_MONTHS } from './statement.js';
import { leaseIntervals, monthOccupancy, occupancySeries, rentHistory, rentChangesFrom, rentChangeExplain, rentLevels, levelEvents, explainEvents, leaseRentRows, rentGrowth } from './occupancy.js';
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

const PROP_COLS = ['propertyID', 'propertyAddress', 'propertyCity', 'portfolioID', 'portfolioName', 'portfolioOwnerIDs', 'managementFeeSettingID', 'managementFeeSettingName', 'isActive', 'dateContractBegins', 'dateTimeCreated', 'property_text_61', 'property_text_62', 'property_text_63'];
const CHECK_COLS = ['datePosted', 'contactID', 'contactName', 'payoutTypeID', 'memo', 'payoutAmount', 'isVoided', 'isPayoutReturned', 'bankAccountID'];
const OWNERPAY_COLS = ['datePosted', 'portfolioID', 'portfolioName', 'contactName', 'offsetAccountName', 'amount', 'isVoided', 'isReturned', 'description'];
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
export const OWNER_CONTRIBUTION_ACCOUNT_ID = 7;   // 3150 - Owner Contribution
export const RECURRING_ACCOUNTS = { landscaping: 79, pest: 77, pool: 83 };
export const toISO = (v) => { if (!v) return ''; if (/^\d{4}-\d{2}-\d{2}/.test(String(v))) return String(v).slice(0, 10); const t = Date.parse(String(v).length === 10 ? v + 'T12:00:00Z' : v + ' 12:00 UTC'); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''; };
const truthy = (v) => v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
const daysAgo = (n) => { const d = new Date(Date.now() - n * 864e5); return d.toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' }); };

// Pull everything for the trust account and shape owners -> properties.
export const PAYOUT_DAYS = 92, BILL_DAYS = 45, CONTRIB_DAYS = 30, NEW_DAYS = 60;
export async function loadPayoutData(rvFetch, { sinceDays = BILL_DAYS, payoutDays = PAYOUT_DAYS, typical = {}, reserve = 0 } = {}) {
  const from = daysAgo(sinceDays), to = today(), payFrom = daysAgo(payoutDays);
  const t0 = Date.now(), lap = (n) => console.log('payouts load', n, Date.now() - t0, 'ms', process.memoryUsage().rss >> 20, 'MB rss');
  const props = await allPages(rvFetch, 'property', { displayColumns: PROP_COLS, filters: [] }, { fields: PROP_COLS, max: 10 }); lap('properties ' + props.length);
  const settle = await allPages(rvFetch, 'settlement-detail', { displayColumns: SETTLE_COLS, filters: [{ name: 'settlementDate', comparator: 'betweenDate', startDate: payFrom, endDate: to }] }, { fields: SETTLE_COLS, max: 40 }); lap('settlements ' + settle.length);
  const bills = await loadBills(rvFetch, from); lap('bills ' + bills.length);
  // owner distributions (Check Register - covers ACH and checks, including ones that have not settled yet)
  const checks = await allPages(rvFetch, 'check-register', { displayColumns: CHECK_COLS, filters: [{ name: 'datePosted', comparator: 'betweenDate', startDate: payFrom, endDate: to }] }, { fields: CHECK_COLS, max: 30 }); lap('checks ' + checks.length);
  // vacant homes (Vacancy report) and owner contributions (Owner Payments report, offset account 3150) - both small
  const vacancy = await allPages(rvFetch, 'vacancy', { displayColumns: ['propertyID', 'propertyAddress', 'daysVacant'], filters: [] }, { fields: ['propertyID', 'propertyAddress', 'daysVacant'], max: 10 }); lap('vacancy ' + vacancy.length);
  const contribRows = await allPages(rvFetch, 'owner-payments', { displayColumns: OWNERPAY_COLS, filters: [{ name: 'datePosted', comparator: 'betweenDate', startDate: daysAgo(CONTRIB_DAYS), endDate: to }] }, { fields: OWNERPAY_COLS, max: 10 }); lap('contributions ' + contribRows.length);
  const late = await loadLateRent(rvFetch, to); lap('late rent ' + late.rows.length);
  const tcharges = await loadTenantCharges(rvFetch, to); lap('tenant charges ' + tcharges.rows.length);
  const fee = await loadFeeData(rvFetch, to); lap('fee check ' + fee.moves.length + ' move-ins, ' + fee.feeBills.length + ' fee bills');
  // active filter is done here, not in the report call (server-side filters are unreliable); a missing isActive field counts as active
  const active = props.filter((p) => p.isActive === undefined || p.isActive === '' || truthy(p.isActive));
  return { props: active, settle, checks, bills, vacancy, contribRows, fee, late, tcharges, from, to, typical, reserve };
}


// ---- Placement fee check (new move-ins must be billed a Commissions/Placement Fees bill, account 94) ----
export const PLACEMENT_FEE_ACCOUNT_ID = 94;
export const LEASE_BREAK_ACCOUNT_ID = 62;
export const FEE_LOOKBACK_DAYS = 260;
export const PREPAID_DAYS = 90;
const MOVE_COLS = ['leaseID', 'propertyID', 'moveInDate', 'leaseStatusName', 'managementFeeSettingName', 'rentAmount'];
const FEEBILL_COLS = ['propertyID', 'chargeAccountID', 'datePosted', 'amount', 'isVoided', 'description'];
const GL_COLS = ['leaseID', 'propertyID', 'accountID', 'datePosted', 'isVoided', 'description'];
const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const monthStart = (iso) => iso.slice(0, 7) + '-01';
const prevMonthStart = (iso) => { let y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)) - 1; if (m < 1) { m = 12; y--; } return y + '-' + String(m).padStart(2, '0') + '-01'; };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Small reports, loaded one at a time. A failure here never stops the page: the fee check just says it could not run.
export async function loadFeeData(rvFetch, todayISO = today()) {
  const out = { moves: [], feeBills: [], breakRows: [], brokenLeases: [], error: '' };
  try {
    out.moves = await allPages(rvFetch, 'lease', { displayColumns: MOVE_COLS, filters: [{ name: 'moveInDate', comparator: 'betweenDate', startDate: prevMonthStart(todayISO), endDate: addDays(todayISO, 45) }] }, { fields: MOVE_COLS, max: 8 });
    out.feeBills = (await allPages(rvFetch, 'payables', { displayColumns: FEEBILL_COLS, filters: [{ name: 'datePosted', comparator: 'betweenDate', startDate: daysAgo(FEE_LOOKBACK_DAYS), endDate: todayISO }, { name: 'chargeAccountID', comparator: 'equals', value: String(PLACEMENT_FEE_ACCOUNT_ID) }] }, { fields: FEEBILL_COLS, max: 12 }))
      .filter((b) => num(b.chargeAccountID) === PLACEMENT_FEE_ACCOUNT_ID);
    out.breakRows = (await allPages(rvFetch, 'general-ledger', { displayColumns: GL_COLS, filters: [{ name: 'datePosted', comparator: 'betweenDate', startDate: daysAgo(FEE_LOOKBACK_DAYS), endDate: todayISO }, { name: 'account', comparator: 'equals', value: String(LEASE_BREAK_ACCOUNT_ID) }] }, { fields: GL_COLS, max: 8 }))
      .filter((r) => num(r.accountID) === LEASE_BREAK_ACCOUNT_ID && r.leaseID !== undefined && r.leaseID !== '' && !truthy(r.isVoided));
    out.brokenLeases = await allPages(rvFetch, 'lease', { displayColumns: ['leaseID', 'propertyID', 'leaseStatusName', 'moveOutDate'], filters: [{ name: 'leaseStatusID', comparator: 'equals', value: '9' }] }, { fields: ['leaseID', 'propertyID', 'leaseStatusName', 'moveOutDate'], max: 4 });
  } catch (e) { console.error('fee check load', e); out.error = String(e.message || e); }
  return out;
}

// The lease fee a plan calls for: "$750 Lease Fee", "$750 Leasing Fee", "$500 Comm", "4% Lease Fee". none:true = the plan has no lease fee / commission.
export function leaseFeeFromPlan(name, rent) {
  const s = String(name || '');
  if (/\b0\s*(comm|lease|leasing)\b/i.test(s) || /\bno\s+(lease|leasing|comm\w*)\s*fee/i.test(s)) return { known: true, none: true, fee: 0 };
  const d = s.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:lease|leasing|comm|placement)/i);
  if (d) return { known: true, none: false, fee: Number(d[1].replace(/,/g, '')) };
  const pc = s.match(/(\d+(?:\.\d+)?)\s*%\s*(?:lease|leasing|comm|placement)/i);
  if (pc) return { known: true, none: false, fee: Math.round(num(rent) * Number(pc[1])) / 100 };
  return { known: false, none: false, fee: 0 };
}

// One move-in -> what the placement fee check says. Never removes a billed fee: everything billed is listed in `billed`.
export function feeCheck(move, { feeBills = [], breakRows = [], brokenLeases = [], startISO = '' } = {}, todayISO = today()) {
  const moveIn = toISO(move.moveInDate), pid = String(move.propertyID), lid = num(move.leaseID);
  const plan = leaseFeeFromPlan(move.managementFeeSettingName, move.rentAmount);
  // fees billed for this move-in: the move-in month (or 14 days before it) counts in full.
  // Earlier startup fees count too (an owner may have prepaid part of the fee, e.g. $150 of $750): bills in the 90 days before that,
  // but only a bill smaller than the full fee (a full-size earlier bill belongs to the previous tenant, not this move-in).
  let since = addDays(moveIn, -14); if (monthStart(moveIn) < since) since = monthStart(moveIn);
  const mine = feeBills.filter((b) => String(b.propertyID) === pid && !truthy(b.isVoided)).map((b) => ({ date: toISO(b.datePosted), amount: num(b.amount), desc: b.description || '' }));
  const inMonth = mine.filter((b) => b.date >= since);
  const early = plan.known && !plan.none ? mine.filter((b) => b.date < since && b.date >= addDays(moveIn, -PREPAID_DAYS) && b.amount < plan.fee - 0.005) : [];
  const billed = [...early, ...inMonth].sort((a, b) => (a.date < b.date ? -1 : 1));
  const total = Math.round(billed.reduce((s, b) => s + b.amount, 0) * 100) / 100;
  const sinceStart = early.length > 0;
  const horizon = addDays(moveIn, -FEE_LOOKBACK_DAYS);
  const brokeBy = breakRows.find((r) => String(r.propertyID) === pid && num(r.leaseID) !== lid && num(r.leaseID) < lid && toISO(r.datePosted) >= horizon)
    ? 'a lease break fee was charged to the previous tenant'
    : (brokenLeases.some((l) => String(l.propertyID) === pid && num(l.leaseID) < lid && toISO(l.moveOutDate) >= horizon) ? 'the previous lease is Closed - Lease Broken' : '');
  const base = { leaseID: move.leaseID, moveIn, plan: move.managementFeeSettingName || '', expected: plan.known && !plan.none ? plan.fee : null, billed, billedTotal: total, startupCredit: sinceStart };
  const mon = MONTHS[Number(moveIn.slice(5, 7)) - 1], md2 = Number(moveIn.slice(5, 7)) + '/' + Number(moveIn.slice(8, 10));
  const money = (n) => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0 });
  if (brokeBy) {
    if (total > 0) return { ...base, status: 'check', key: 'fee_check', text: 'Placement fee billed (' + money(total) + ') but ' + brokeBy + ' - check, may not be due' };
    return { ...base, status: 'skip', key: 'fee_skip', text: 'DO NOT CHARGE placement fee: ' + brokeBy };
  }
  if (plan.none) return { ...base, status: 'none', key: '', text: '' };
  if (!plan.known) {
    if (total > 0) return { ...base, status: 'ok', key: 'fee_ok', text: 'Placement fee billed ' + money(total) + ' (plan amount not readable)' };
    return { ...base, status: 'check', key: 'fee_check', text: 'Placement fee: plan "' + (move.managementFeeSettingName || 'none') + '" not readable and nothing billed - check' };
  }
  if (total >= plan.fee - 0.005 && total > 0) return { ...base, status: 'ok', key: 'fee_ok', text: 'Placement fee billed ' + money(total) };
  if (total > 0) return { ...base, status: 'check', key: 'fee_check', text: 'Placement fee: ' + money(total) + ' of ' + money(plan.fee) + ' billed - a person should look' };
  if (moveIn > todayISO) return { ...base, status: 'due', key: 'fee_due', text: 'Placement fee ' + money(plan.fee) + ' to bill in ' + mon + ' (move-in ' + md2 + ')' };
  return { ...base, status: 'missing', key: 'fee_missing', text: 'PLACEMENT FEE NOT BILLED: expect ' + money(plan.fee) + ' (move-in ' + md2 + ')' };
}


// ---- Prorated management fee ----
// A move-in on or after the 15th gets half the monthly fee; a move-out on or after the 20th gets half; otherwise the full fee.
// Compares what should be billed for that month with the management fee bill (account 93) actually posted for it.
export const PRORATE_MOVE_IN_DAY = 15, PRORATE_MOVE_OUT_DAY = 20;
const mkey = (iso) => String(iso).slice(0, 7);
const mlabel = (k) => Number(k.slice(5, 7)) + '/' + k.slice(0, 4);
const prevMonthKey = (iso) => { let y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)) - 1; if (m < 1) { m = 12; y--; } return y + '-' + String(m).padStart(2, '0'); };
const nextMonthK = (iso) => { let y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)) + 1; if (m > 12) { m = 1; y++; } return y + '-' + String(m).padStart(2, '0'); };
const mdd = (iso) => Number(iso.slice(5, 7)) + '/' + Number(iso.slice(8, 10));
const usd = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// feeBills: [{ date, amount, desc }] management fee bills (account 93), not voided. A bill belongs to the month in its description ("for 10/2026"), else its posted month.
export function prorateFeeCheck({ planFee = 0, planKnown = false, moveIns = [], moveOuts = [], feeBills = [] } = {}, todayISO = today()) {
  const out = [];
  if (!planKnown || !(planFee > 0)) return out;
  const half = Math.round(planFee * 50) / 100;
  const ev = {};
  for (const d of moveIns) if (d) (ev[mkey(d)] ||= {}).in = d;
  for (const d of moveOuts) if (d) (ev[mkey(d)] ||= {}).out = d;
  const lo = prevMonthKey(todayISO), cur = mkey(todayISO), hi = nextMonthK(todayISO);
  const billedFor = (k) => {
    let n = 0, sum = 0;
    for (const b of feeBills) {
      const m = String(b.desc || '').match(/(\d{1,2})\/(\d{4})/);
      const bk = m ? m[2] + '-' + String(m[1]).padStart(2, '0') : mkey(toISO(b.date) || '0000-00');
      if (bk === k) { n++; sum += num(b.amount); }
    }
    return { n, sum: Math.round(sum * 100) / 100 };
  };
  for (const k of Object.keys(ev).sort()) {
    if (k < lo || k > hi) continue;
    const e = ev[k], why = [];
    if (e.in) why.push('move-in ' + mdd(e.in));
    if (e.out) why.push('move-out ' + mdd(e.out));
    if (e.in && e.out) { out.push({ key: 'fee_prorate', month: k, text: 'Move-in and move-out in the same month ' + mlabel(k) + ' (' + why.join(', ') + ') - check the management fee by hand' }); continue; }
    const isHalf = e.in ? Number(e.in.slice(8, 10)) >= PRORATE_MOVE_IN_DAY : Number(e.out.slice(8, 10)) >= PRORATE_MOVE_OUT_DAY;
    const expected = isHalf ? half : planFee;
    const rule = e.in ? (isHalf ? 'on or after the ' + PRORATE_MOVE_IN_DAY + 'th' : 'before the ' + PRORATE_MOVE_IN_DAY + 'th') : (isHalf ? 'on or after the ' + PRORATE_MOVE_OUT_DAY + 'th' : 'before the ' + PRORATE_MOVE_OUT_DAY + 'th');
    const b = billedFor(k);
    if (b.n) {
      if (Math.abs(b.sum - expected) > 0.5) out.push({ key: 'fee_prorate', month: k, expected, billed: b.sum, text: 'Management fee for ' + mlabel(k) + ' should be ' + (isHalf ? 'HALF ' : 'the full ') + usd(expected) + ' (' + why.join(', ') + ', ' + rule + ') - ' + usd(b.sum) + ' billed' });
    } else if (isHalf) {
      out.push({ key: k <= cur ? 'fee_prorate' : 'fee_prorate_due', month: k, expected, billed: 0, text: 'Half management fee ' + usd(expected) + ' expected for ' + mlabel(k) + ' (' + why.join(', ') + ', ' + rule + ')' + (k <= cur ? ' - no fee billed yet, bill it at half' : ' - bill it at half') });
    }
  }
  return out;
}

// ---- Late rent (rent applied to a due balance after the LATE_AFTER_DAY of the month) ----
export const LATE_AFTER_DAY = 12;
// Only money paid toward these charges counts: Rent Income (10), Section 8 Rent (32), Pet Rent (39), HOA Violation Fine (150).
// Admin fees, Resident Benefit Package, renters insurance, maintenance charges etc. do not.
export const LATE_RENT_ACCOUNTS = [10, 32, 39, 150];
// Money tenants paid toward charges that are NOT owner money (Resident Benefit Package, admin fees, renters insurance...). Rentvine's deposits and
// Distributable Amount include it, but it is not part of the owner's payout. Owner money = LATE_RENT_ACCOUNTS (rent, Section 8 rent, pet rent, HOA fine).
const TCHARGE_COLS = ['leaseID', 'propertyID', 'chargeAccountID', 'amountPaid', 'isVoided', 'datePosted'];
export const TCHARGE_DAYS = 40;
export async function loadTenantCharges(rvFetch, todayISO = today()) {
  const out = { rows: [], error: '' };
  const filters = [{ name: 'datePosted', comparator: 'betweenDate', startDate: daysAgo(TCHARGE_DAYS), endDate: todayISO }];
  try {
    const all = await allPages(rvFetch, 'lease-charges', { displayColumns: TCHARGE_COLS, filters }, { fields: TCHARGE_COLS, max: 25 });
    for (const c of all) {
      if (truthy(c.isVoided) || LATE_RENT_ACCOUNTS.includes(num(c.chargeAccountID)) || !(num(c.amountPaid) > 0)) continue;
      if (c.propertyID === undefined || c.propertyID === '') { out.error = 'the charges report did not say which property a charge belongs to'; continue; }
      out.rows.push({ propertyID: String(c.propertyID), datePosted: toISO(c.datePosted), amount: num(c.amountPaid), accountID: num(c.chargeAccountID) });
    }
  } catch (e) { console.error('tenant charges load', e); out.error = String(e.message || e); out.rows = []; }
  return out;
}

const LATE_COLS = ['datePosted', 'propertyID', 'leaseID', 'amount', 'amountAllocated', 'isDepositedSettled', 'settlementDate', 'isVoided', 'isReturned'];
const LCHARGE_COLS = ['leaseID', 'chargeAccountID', 'amountPaid', 'isVoided'];
// Charges posted after the 12th (admin fees, late fees...) can only be paid by money that came in after the 12th, so that money pays them first.
const LCHARGE_NEW_COLS = ['leaseID', 'chargeAccountID', 'amountPaid', 'isVoided', 'datePosted'];
// Tenant Receipts report (payments posted from the 13th of this month) plus this month's rent/fine charges, to see what each payment paid.
// Small reports, loaded after the others. A failure never stops the page.
export async function loadLateRent(rvFetch, todayISO = today()) {
  const out = { rows: [], paidByLease: {}, feesAfterByLease: {}, error: '' };
  const from = todayISO.slice(0, 7) + '-' + String(LATE_AFTER_DAY + 1).padStart(2, '0');
  if (todayISO < from) return out;
  try {
    out.rows = await allPages(rvFetch, 'lease-payments', { displayColumns: LATE_COLS, filters: [{ name: 'datePosted', comparator: 'betweenDate', startDate: from, endDate: todayISO }] }, { fields: LATE_COLS, max: 10 });
    const charges = await allPages(rvFetch, 'lease-charges', { displayColumns: LCHARGE_COLS, filters: [{ name: 'datePosted', comparator: 'betweenDate', startDate: todayISO.slice(0, 7) + '-01', endDate: todayISO }, { name: 'chargeAccountID', comparator: 'in', values: LATE_RENT_ACCOUNTS.map(String) }] }, { fields: LCHARGE_COLS, max: 12 });
    for (const c of charges) {
      if (truthy(c.isVoided) || !LATE_RENT_ACCOUNTS.includes(num(c.chargeAccountID)) || c.leaseID === undefined || c.leaseID === '') continue;
      out.paidByLease[String(c.leaseID)] = (out.paidByLease[String(c.leaseID)] || 0) + num(c.amountPaid);
    }
    const newCharges = await allPages(rvFetch, 'lease-charges', { displayColumns: LCHARGE_NEW_COLS, filters: [{ name: 'datePosted', comparator: 'betweenDate', startDate: from, endDate: todayISO }] }, { fields: LCHARGE_NEW_COLS, max: 12 });
    for (const c of newCharges) {
      if (truthy(c.isVoided) || LATE_RENT_ACCOUNTS.includes(num(c.chargeAccountID)) || c.leaseID === undefined || c.leaseID === '') continue;
      const d = toISO(c.datePosted); if (d && d < from) continue;
      out.feesAfterByLease[String(c.leaseID)] = (out.feesAfterByLease[String(c.leaseID)] || 0) + num(c.amountPaid);
    }
  } catch (e) { console.error('late rent load', e); out.error = String(e.message || e); out.rows = []; }
  return out;
}

// Late rent for one property. A payment counts only for the part that paid rent / a fine (paidByLease caps it per lease), voided and returned
// payments are ignored. Payments from a lease that is moving in (paid up to 7 days after move-in) are move-in funds, not late rent.
// cleared = settled after the owner's last payout; pending = received but not cleared yet.
export function lateRentFor(propertyID, rowsIn, since, todayISO = today(), { paidByLease = null, moveInByLease = {}, feesAfterByLease = null } = {}) {
  const out = { cleared: 0, pending: 0, moveinCleared: 0, moveinPending: 0, clearedRows: [], pendingRows: [], moveinClearedRows: [], moveinPendingRows: [] };
  const remaining = {}; const absorb = {};
  const mine = (rowsIn || []).filter((r) => String(r.propertyID) === String(propertyID) && !truthy(r.isVoided) && !truthy(r.isReturned)).map((r) => ({ r, posted: toISO(r.datePosted) })).filter((x) => x.posted).sort((a, b) => (a.posted < b.posted ? -1 : 1));
  for (const { r, posted } of mine) {
    const moveIn = moveInByLease[String(r.leaseID)];
    const isMoveIn = !!moveIn && posted <= addDays(moveIn, 7);
    if (!isMoveIn && posted.slice(0, 7) === todayISO.slice(0, 7) && posted.slice(8, 10) <= String(LATE_AFTER_DAY).padStart(2, '0')) continue;
    let amt = num(r.amountAllocated); if (amt <= 0) continue;
    if (feesAfterByLease) {
      const k = String(r.leaseID); if (absorb[k] === undefined) absorb[k] = num(feesAfterByLease[k]);
      const take = Math.min(amt, absorb[k]); amt -= take; absorb[k] -= take; if (amt <= 0.004) continue;
    }
    if (paidByLease) {
      const k = String(r.leaseID); if (remaining[k] === undefined) remaining[k] = num(paidByLease[k]);
      amt = Math.min(amt, remaining[k]); if (amt <= 0) continue; remaining[k] -= amt;
    }
    const settledFlag = truthy(r.isDepositedSettled);
    const settled = settledFlag ? (toISO(r.settlementDate) || posted) : '';
    if (settledFlag && settled <= since) continue;
    const kind = isMoveIn ? 'movein' : '';
    if (settledFlag) { out[kind ? 'moveinCleared' : 'cleared'] += amt; out[kind ? 'moveinClearedRows' : 'clearedRows'].push({ posted, settled, amount: amt }); }
    else { out[kind ? 'moveinPending' : 'pending'] += amt; out[kind ? 'moveinPendingRows' : 'pendingRows'].push({ posted, amount: amt }); }
  }
  for (const k of ['cleared', 'pending', 'moveinCleared', 'moveinPending']) out[k] = Math.round(out[k] * 100) / 100;
  return out;
}

// Owner contributions: credits to account 3150 in the last 30 days, not voided. Owner is found from the portfolio id or the ledger / portfolio name.
const normName = (v) => String(v && typeof v === 'object' ? (v.name || v.label || '') : (v ?? '')).toLowerCase().replace(/[^a-z0-9]/g, '');
export function parseContributions(rowsIn, todayISO = today()) {
  const out = [];
  for (const r of rowsIn || []) {
    if (truthy(r.isVoided) || truthy(r.isReturned)) continue;
    if (r.offsetAccountName && !/contribution/i.test(String(r.offsetAccountName))) continue;
    const amount = Math.round((r.amount !== undefined ? num(r.amount) : num(r.credit) - num(r.debit)) * 100) / 100;
    if (amount <= 0) continue;
    const date = toISO(r.datePosted);
    if (date && dayDiff(todayISO, date) > CONTRIB_DAYS) continue;
    out.push({ date, amount, desc: String(r.description || ''), type: 'Owner contribution', portfolioID: r.portfolioID ? String(r.portfolioID) : '', names: [r.portfolioName, r.contactName].map(normName).filter(Boolean) });
  }
  return out.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
}

// Turn raw report rows into the owner list the math module expects. `rents` = { propertyID: monthlyRent }.
// Owners are grouped by PORTFOLIO. A portfolio can have several owner contacts; a payout to any of them counts as that portfolio's payout.
export function shapeOwners({ props, settle, checks = [], bills, vacancy = [], contribRows = [], fee: feeData = {}, late: lateData = {}, tcharges: tcData = {}, typical = {}, reserve = 0, recExp = {} }, rents = {}, expectedBill = new Set(), leaseInfo = {}, todayISO = today()) {
  const trust = settle.filter((r) => r.bankAccountID === undefined || num(r.bankAccountID) === TRUST_BANK_ACCOUNT_ID);
  const payoutsByContact = {};
  for (const r of trust) {
    if (num(r.payoutTypeID) === 4 && num(r.amount) < 0) {
      const k = String(r.contactID), d = toISO(r.settlementDate);
      if (!payoutsByContact[k] || d > payoutsByContact[k].date) payoutsByContact[k] = { date: d, amount: Math.abs(num(r.amount)) };
    }
  }
  // owner distributions from the Check Register win ties with Money Out rows (same payout seen twice)
  for (const r of checks) {
    if (num(r.payoutTypeID) !== 4 || truthy(r.isVoided) || truthy(r.isPayoutReturned)) continue;
    if (r.bankAccountID !== undefined && r.bankAccountID !== '' && num(r.bankAccountID) !== TRUST_BANK_ACCOUNT_ID) continue;
    const k = String(r.contactID), d = toISO(r.datePosted), amt = Math.abs(num(r.payoutAmount));
    if (!payoutsByContact[k] || d >= payoutsByContact[k].date) payoutsByContact[k] = { date: d, amount: amt };
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
  const vacantDays = {};
  for (const v of vacancy) if (v.propertyID !== undefined && v.propertyID !== '') vacantDays[String(v.propertyID)] = num(v.daysVacant);
  const contribs = parseContributions(contribRows, todayISO), matchedC = new Set();
  const moveInByLease = {};
  for (const m of feeData.moves || []) if (m.leaseID !== undefined && toISO(m.moveInDate)) moveInByLease[String(m.leaseID)] = toISO(m.moveInDate);
  const owners = [];
  for (const o of byPortfolio.values()) {
    const myNames = new Set([normName(o.name)].filter(Boolean));
    const mine = contribs.filter((c) => { const hit = (c.portfolioID && c.portfolioID === o.id) || c.names.some((n) => myNames.has(n)); if (hit) matchedC.add(c); return hit; });
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
      const nonOwnerPaid = (tcData.rows || []).filter((r) => r.propertyID === id && r.datePosted && r.datePosted > since).reduce((s, r) => s + r.amount, 0);   // tenant payments toward non-owner charges since the last payout
      const expense = counted.filter((b) => num(b.chargeAccountID) !== MGMT_FEE_ACCOUNT_ID).map((b) => ({
        amountUnpaid: truthy(b.isPaid) ? num(b.amount) : num(b.amountUnpaid || b.amount), isPaid: false, isVoided: false,
        desc: (b.description || b.chargeAccountName || 'Bill') + (truthy(b.isPaid) ? ' (paid ' + toISO(b.datePosted) + ')' : ' (unpaid)'), billID: b.billID, vendor: b.contactName, due: toISO(b.dateDue), date: toISO(b.datePosted), paid: truthy(b.isPaid),
      }));
      const lt = leaseTags(leaseInfo[id], lp ? lp.date : '', todayISO);
      const startISO = toISO(p.dateContractBegins) || toISO(p.dateTimeCreated);
      const isNewProperty = !!startISO && dayDiff(todayISO, startISO) >= 0 && dayDiff(todayISO, startISO) <= NEW_DAYS;
      if (isNewProperty) lt.tags.push({ key: 'new_property', text: 'New property ' + md(startISO) });
      const feeChecks = (feeData.moves || []).filter((m) => String(m.propertyID) === id && !/^closed/i.test(String(m.leaseStatusName || '')) && toISO(m.moveInDate))
        .map((m) => feeCheck(m, { feeBills: feeData.feeBills || [], breakRows: feeData.breakRows || [], brokenLeases: feeData.brokenLeases || [], startISO }, todayISO)).filter((f) => f.key);
      for (const f of feeChecks) lt.tags.push({ key: f.key, text: f.text });
      const pro = prorateFeeCheck({ planFee: plan.fee, planKnown: plan.known, moveIns: (feeData.moves || []).filter((m) => String(m.propertyID) === id && !/^closed/i.test(String(m.leaseStatusName || ''))).map((m) => toISO(m.moveInDate)), moveOuts: leaseInfo[id] && leaseInfo[id].moveOut ? [leaseInfo[id].moveOut] : [],
        feeBills: (billsBy[id] || []).filter((b) => num(b.chargeAccountID) === MGMT_FEE_ACCOUNT_ID).map((b) => ({ date: toISO(b.datePosted), amount: num(b.amount), desc: b.description || '' })) }, todayISO);
      for (const f of pro) lt.tags.push({ key: f.key, text: f.text });
      const lateRent = lateRentFor(id, lateData.rows || [], since, todayISO, { paidByLease: lateData.rows && lateData.paidByLease ? lateData.paidByLease : null, feesAfterByLease: lateData.rows && lateData.feesAfterByLease ? lateData.feesAfterByLease : null, moveInByLease });
      const md3 = (iso) => Number(iso.slice(5, 7)) + '/' + Number(iso.slice(8, 10));
      const mny = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
      const lastOf = (a, k) => a.map((x) => x[k]).sort().pop();
      if (lateRent.cleared > 0) lt.tags.push({ key: 'late_cleared', text: 'Late rent CLEARED ' + mny(lateRent.cleared) + ' (settled ' + md3(lastOf(lateRent.clearedRows, 'settled')) + ') - ready to pay' });
      if (lateRent.pending > 0) lt.tags.push({ key: 'late_pending', text: 'Late rent pending ' + mny(lateRent.pending) + ' (paid ' + md3(lastOf(lateRent.pendingRows, 'posted')) + ', not cleared yet)' });
      if (lateRent.moveinCleared > 0) lt.tags.push({ key: 'movein_cleared', text: 'Move-in funds cleared ' + mny(lateRent.moveinCleared) + ' (settled ' + md3(lastOf(lateRent.moveinClearedRows, 'settled')) + ')' });
      if (lateRent.moveinPending > 0) lt.tags.push({ key: 'movein_pending', text: 'Move-in funds pending ' + mny(lateRent.moveinPending) + ' (paid ' + md3(lastOf(lateRent.moveinPendingRows, 'posted')) + ', not cleared yet)' });
      const li = leaseInfo[id];
      const vacated = !!(li && /vacat/i.test(String(li.status || '')));
      const inVacancy = Object.prototype.hasOwnProperty.call(vacantDays, id) && (!li || vacated || !rents[id]);
      const vacant = vacated || inVacancy;
      if (vacant) lt.tags.push({ key: 'vacant', text: vacated && !inVacancy ? 'Tenant vacated' : 'Vacant' + (vacantDays[id] ? ' ' + vacantDays[id] + ' days' : '') });
      if (plan.known && plan.fee === 0 && /^\s*0\b/.test(String(p.managementFeeSettingName || ''))) lt.tags.push({ key: 'no_fee', text: 'No management fee' });
      const billHistory = markDuplicates((billsBy[id] || []).map((b) => ({
        billID: b.billID, date: toISO(b.datePosted), accountID: num(b.chargeAccountID), account: b.chargeAccountName || '', vendor: b.contactName || '', desc: b.description || '',
        amount: num(b.amount), unpaid: truthy(b.isPaid) ? 0 : num(b.amountUnpaid || b.amount), paid: truthy(b.isPaid), counted: counted.includes(b), dup: false,
      })).sort((x, y) => (y.date > x.date ? 1 : y.date < x.date ? -1 : 0)));
      return {
        tags: lt.tags, feeChecks, lateRent, isNewProperty, moveOutSoon: lt.moveOutSoon, vacant, vacantDays: vacantDays[id] ?? null, lease: leaseInfo[id] || null, billHistory,
        propertyID: id, address: [p.propertyAddress, p.propertyCity].filter(Boolean).join(', '),
        rent, fee, feeKnown: feeBills.length ? true : plan.known, feePlan: (p.managementFeeSettingName || '') + (feeBills.length ? ' (posted)' : ' (expected)'),
        settledIn: inn, nonOwnerPaid, feePosted: feeBills.length > 0, bills: expense,
        // an expected recurring bill is dropped once the real bill for it has already been posted in this window
        planFee: plan.fee, planFeeKnown: plan.known,
        // expected recurring bills (not posted yet): the owner-responsible services use the amount that home was really billed; Owner Administrative Charge and the one HOA Aloe pays are added too
        recurring: (() => {
          const h = recExp[id] || {}, posted = (acct) => counted.some((b) => num(b.chargeAccountID) === acct);
          const list = recurringExpected({ pool: p.property_text_61, pest: p.property_text_62, landscaping: p.property_text_63 }, { ...typical, ...Object.fromEntries(['pool', 'pest', 'landscaping'].filter((k) => h[k] > 0).map((k) => [k, h[k]])) }).filter((r) => !posted(RECURRING_ACCOUNTS[r.key]));
          const postedHoa = () => counted.some((b) => /hoa/i.test(String(b.chargeAccountName || '')) || /hoa/i.test(String(b.description || '')));
          for (const [k, label] of [['ownerAdmin', 'Owner administrative charge'], ['hoa', 'HOA dues']]) if (h[k] && h[k].amount > 0 && !(h[k].accountID ? posted(h[k].accountID) : postedHoa())) list.push({ key: k, label, amount: h[k].amount, known: true });
          // other recurring bills: set up in Rentvine, or the same vendor every month by invoice. Dropped once that vendor's bill (about that amount) is already posted.
          const nv = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          for (const x of h.extra || []) {
            const done = counted.some((b) => (x.accountID && num(b.chargeAccountID) === x.accountID) || (x.vendor && nv(b.contactName) === nv(x.vendor) && Math.abs(num(b.amount) - x.amount) < 0.51));
            if (!done && x.amount > 0) list.push({ key: x.key, label: x.label + (x.source === 'invoices' ? ' (from invoices)' : ''), amount: x.amount, known: true });
          }
          return list;
        })(),
        billExpected: expectedBill.has(id),
        recurringVendors: ((recExp[id] || {}).extra || []).map((x) => x.vendor).filter(Boolean),
        recurringAmounts: { pool: (recExp[id] || {}).pool || 0, landscaping: (recExp[id] || {}).landscaping || 0, pest: (recExp[id] || {}).pest || 0 },
      };
    });
    owners.push({ ownerID: o.id, portfolioID: o.id, contactIDs: [...o.ids], name: o.name, newOwner: properties.length > 0 && properties.every((x) => x.isNewProperty), properties, lastPayout: lp ? lp.amount : null, lastPayoutDate: lp ? lp.date : null, reserve, contributions: mine.map(({ date, amount, desc, type }) => ({ date, amount, desc, type })) });
  }
  owners.unmatchedContributions = contribs.filter((c) => !matchedC.has(c)).map(({ date, amount, desc, type }) => ({ date, amount, desc, type }));
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
  // Aloe's own bills (reimbursements, admin charges) are often several different items for the same amount, so those only match on the description too.
  const norm = (v) => String(v || '').trim().toLowerCase();
  const key = (b) => (/aloe property management/.test(norm(b.vendor)) ? norm(b.vendor) + '|' + norm(b.desc) : norm(b.vendor || b.desc));
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (a.billID !== undefined && a.billID !== '' && String(a.billID) === String(b.billID)) continue; // two lines on the same bill are not a duplicate
    if (a.accountID === b.accountID && Math.abs(a.amount - b.amount) < 0.005 && key(a) === key(b) && a.date && b.date && Math.abs(dayDiff(a.date, b.date)) <= 10) { a.dup = true; b.dup = true; }
  }
  return list;
}

// Decisions (approve / hold / ask owner + note). Default store is in memory until you approve a real place to keep them.
export function makeMemoryDecisionStore() {
  const m = new Map();
  return { persistent: false, get: async () => Object.fromEntries(m), set: async (ownerID, d) => { m.set(String(ownerID), { ...d, at: new Date().toISOString() }); return m.get(String(ownerID)); } };
}

// ---- Owner heads-up emails: read-only loaders ----
// Owner Contact report: ONLY these four columns are requested (never the tax / bank columns the report also has).
const OWNER_COLS = ['contactID', 'name', 'email', 'holdPayments'];
export async function loadOwnerContacts(rvFetch) {
  const r = await allPages(rvFetch, 'owner', { displayColumns: OWNER_COLS, filters: [] }, { fields: OWNER_COLS, max: 15 });
  const emailByContact = {}, holdByContact = {}, nameByContact = {};
  for (const x of r) { const id = String(x.contactID); const e = String(x.email || '').trim(); if (e) emailByContact[id] = e; if (x.name) nameByContact[id] = String(x.name); if (truthy(x.holdPayments)) holdByContact[id] = true; }
  return { emailByContact, holdByContact, nameByContact, count: r.length };
}
// Portfolio Balances report: Rentvine's own reserve, operating balance and "distributable" amount per portfolio, plus the owner contacts.
const BAL_COLS = ['portfolio', 'contacts', 'totalReserveAmount', 'operatingBalance', 'distributableAmount', 'holdDistributions', 'isActive'];
const BAL_FIELDS = ['portfolioID', 'portfolioName', ...BAL_COLS];
export const parseContactsJson = (v) => { if (Array.isArray(v)) return v; try { const a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a : []; } catch { return []; } };
export async function loadPortfolioBalances(rvFetch) {
  let r = null, lastErr = null;
  for (const size of [100, 25]) {   // the report computes balances for every portfolio, so a big page can time out (Rentvine 500)
    try { r = await allPages(rvFetch, 'portfolio-balances', { displayColumns: BAL_COLS, filters: [] }, { fields: BAL_FIELDS, max: Math.ceil(900 / size), pageSize: size }); break; } catch (e) { lastErr = e; }
  }
  if (!r) throw lastErr;
  const out = {};
  for (const x of r) out[String(x.portfolioID)] = { reserve: num(x.totalReserveAmount), operating: num(x.operatingBalance), distributable: num(x.distributableAmount), hold: truthy(x.holdDistributions), contacts: parseContactsJson(x.contacts) };
  return out;
}
// Default Aptly draft writer (same call the weekly vacancy drafts use). It only ever creates a DRAFT; nothing is sent.
export const APTLY_INFO_CHANNEL_ID = '6c8783b9-3fb4-5911-9468-a7c6b91ee25e';
export function makeAptlyDraftWriter(env = process.env, fetchImpl = (...a) => fetch(...a)) {
  return async ({ channelId, to, subject, body }) => {
    const token = env.APTLY_TOKEN;
    if (!token) throw new Error('APTLY_TOKEN is not set on this service');
    const res = await fetchImpl('https://core-api.getaptly.com/api/email/create-draft', { method: 'POST', headers: { 'x-token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: env.APTLY_DRAFT_USER_ID || 'op8mkGcfjAoka2GJS', channelId, to, subject, body }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Aptly draft creation failed: ' + res.status + ' ' + JSON.stringify(data).slice(0, 300));
    return data;
  };
}
export function makeSlackNotifier(env = process.env, fetchImpl = (...a) => fetch(...a)) {
  return async (text) => {
    if (!env.SLACK_TOKEN) throw new Error('SLACK_TOKEN is not set');
    const r = await fetchImpl('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { Authorization: 'Bearer ' + env.SLACK_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: env.PAYOUTS_SLACK_CHANNEL || 'C06CQ5NUKK3', text }) });
    const d = await r.json().catch(() => ({})); if (!d.ok) throw new Error('Slack: ' + (d.error || r.status));
  };
}
// Bills posted in the last six full months, in a small column set, for the recurring-bill finder
const RBILL_COLS = ['propertyID', 'chargeAccountID', 'chargeAccountName', 'datePosted', 'amount', 'isVoided', 'isSuppressed', 'description', 'contactName'];
// Bills and payments for one owner's homes, 14 months back, for the statements. Read-only. Tries to let Rentvine filter by portfolio / property;
// if a filter is refused it falls back to the next one and finally to a date-only read filtered here.
export async function loadStatementData(rvFetch, propertyIDs, portfolioID, ym) {
  const from = addMonths(ym, -(LOOKBACK_MONTHS - 1)) + '-01', to = new Date(Date.parse(addMonths(ym, 1) + '-01T12:00:00Z') - 864e5).toISOString().slice(0, 10);
  const ids = new Set(propertyIDs.map(String)), warnings = [];
  const dateF = (name) => ({ name, comparator: 'betweenDate', startDate: from, endDate: to });
  let bills = null;
  for (const f of [{ name: 'portfolioID', comparator: 'equals', value: String(portfolioID) }, { name: 'propertyID', comparator: 'in', values: [...ids] }, null]) {
    try { bills = await allPages(rvFetch, 'payables', { displayColumns: BILL_COLS, filters: [dateF('datePosted'), ...(f ? [f] : [])] }, { fields: BILL_COLS, max: f ? 40 : 80 }); if (!f) bills = bills.filter((b) => ids.has(String(b.propertyID))); break; }
    catch (e) { warnings.push('bills filter ' + (f ? f.name : 'date only') + ': ' + String(e.message || e).slice(0, 120)); }
  }
  let settle = null;
  for (const f of [{ name: 'propertyID', comparator: 'in', values: [...ids] }, null]) {
    try { settle = await allPages(rvFetch, 'settlement-detail', { displayColumns: SETTLE_COLS, filters: [dateF('settlementDate'), ...(f ? [f] : [])] }, { fields: SETTLE_COLS, max: f ? 40 : 80 }); if (!f) settle = settle.filter((x) => ids.has(String(x.propertyID))); break; }
    catch (e) { warnings.push('payments filter ' + (f ? f.name : 'date only') + ': ' + String(e.message || e).slice(0, 120)); }
  }
  if (!bills || !settle) throw new Error('Rentvine could not be read for this statement (' + warnings.join('; ') + ')');
  // tenant payments toward non-owner charges (admin fees etc.), so they are not counted as owner money; optional
  let other = [];
  const OCOLS = ['leaseID', 'propertyID', 'chargeAccountID', 'amountPaid', 'isVoided', 'datePosted'];
  for (const f of [{ name: 'propertyID', comparator: 'in', values: [...ids] }, null]) {
    try {
      let rows = await allPages(rvFetch, 'lease-charges', { displayColumns: OCOLS, filters: [dateF('datePosted'), ...(f ? [f] : [])] }, { fields: OCOLS, max: f ? 40 : 80 });
      if (!f) rows = rows.filter((x) => ids.has(String(x.propertyID)));
      other = rows.filter((c) => !truthy(c.isVoided) && !LATE_RENT_ACCOUNTS.includes(num(c.chargeAccountID)) && num(c.amountPaid) > 0 && c.propertyID !== undefined && c.propertyID !== '').map((c) => ({ propertyID: String(c.propertyID), datePosted: toISO(c.datePosted), amount: num(c.amountPaid) }));
      break;
    } catch (e) { if (!f) warnings.push('tenant fee split unavailable (admin and other fees may be counted as rent): ' + String(e.message || e).slice(0, 100)); }
  }
  // rent actually charged each month (rent account 10) over the last 3 years: gives every home its rent history and rent increases
  let rentRows = [];
  const RCOLS = ['leaseID', 'propertyID', 'chargeAccountID', 'amount', 'amountPaid', 'isVoided', 'datePosted'], RFROM = addMonths(ym, -35) + '-01', RTO = addMonths(ym, 2) + '-01';
  for (const cols of [RCOLS, RCOLS.filter((c) => c !== 'amount')]) {
    try {
      const rows = await allPages(rvFetch, 'lease-charges', { displayColumns: cols, filters: [{ name: 'datePosted', comparator: 'betweenDate', startDate: RFROM, endDate: RTO }, { name: 'chargeAccountID', comparator: 'in', values: ['10'] }, { name: 'propertyID', comparator: 'in', values: [...ids] }] }, { fields: cols, max: 40 });
      rentRows = rows.filter((c) => !truthy(c.isVoided) && num(c.chargeAccountID) === 10 && ids.has(String(c.propertyID))).map((c) => ({ propertyID: String(c.propertyID), datePosted: toISO(c.datePosted), amount: num(c.amount !== undefined ? c.amount : c.amountPaid), paid: num(c.amountPaid) }));
      break;
    } catch (e) { if (cols !== RCOLS) warnings.push('rent charges unavailable (rent history falls back to lease records): ' + String(e.message || e).slice(0, 100)); }
  }
  return { bills, settle, other, rentRows, warnings };
}

// Lease history and rent changes for the statements (occupancy, rent by lease, increases). Each read is optional: a failure only removes that part of the statement.
const LEASE_HIST_COLS = ['leaseID', 'propertyID', 'rentAmount', 'leaseStatusName', 'moveInDate', 'moveOutDate', 'expectedMoveOutDate'];
export async function loadStatementLeases(rvFetch, propertyIDs) {
  const ids = new Set(propertyIDs.map(String)), warnings = [];
  for (const f of [{ name: 'propertyID', comparator: 'in', values: [...ids] }, null]) {
    try { let rows = await allPages(rvFetch, 'lease', { displayColumns: LEASE_HIST_COLS, filters: f ? [f] : [] }, { fields: LEASE_HIST_COLS, max: f ? 10 : 30 }); if (!f) rows = rows.filter((r) => ids.has(String(r.propertyID))); return { leases: rows, changes: await loadRentChanges(rvFetch, ids, warnings), warnings }; }
    catch (e) { warnings.push('lease history ' + (f ? 'filter' : 'all') + ': ' + String(e.message || e).slice(0, 100)); }
  }
  return { leases: [], changes: [], warnings };
}
async function loadRentChanges(rvFetch, ids, warnings) {
  try {
    const rows = await allPages(rvFetch, 'lease-recurring-charges', { filters: [{ name: 'propertyID', comparator: 'in', values: [...ids] }] }, { max: 10 });
    const byLeaseProp = rows.filter((r) => r.propertyID === undefined || ids.has(String(r.propertyID)));
    return rentChangesFrom(byLeaseProp);
  } catch (e) { warnings.push('rent changes: ' + String(e.message || e).slice(0, 100)); return []; }
}

// Rentvine's own Recurring Bills list (bills already set up to post monthly). Failure-tolerant: the caller falls back to billing history.
export async function loadRecurringSetup(rvFetch) {
  return allPages(rvFetch, 'recurring-bills-detail', { filters: [] }, { max: 10 });
}

export async function loadRecurringBills(rvFetch, todayISO = today()) {
  const { from } = recurringWindow(todayISO, 6);
  return allPages(rvFetch, 'payables', { displayColumns: RBILL_COLS, filters: [{ name: 'datePosted', comparator: 'betweenDate', startDate: from, endDate: todayISO }] }, { fields: RBILL_COLS, max: 60 });
}
export const MIN_PROPERTIES_FOR_DRAFTS = 300;   // same idea as the vacancy job's "500 leads" check: refuse to draft from a half-loaded list

export function installPayouts(app, rvFetch, { decisions = makeMemoryDecisionStore(), getRents = null, getLeaseInfo = defaultLeaseInfo, getExpectedBills = async () => new Set(), typical = {}, reserve = 0, env = process.env, createDraft = null, notify = null } = {}) {
  if (typeof rvFetch !== 'function') throw new Error('installPayouts needs rvFetch');
  const guard = (req, res) => { if (!sessionOk(req, env)) { res.status(401).json({ error: 'Sign in required' }); return false; } return true; };
  let cache = { at: 0, v: null }, inflight = null;
  let balCache = { at: 0, v: null, err: '' }, balInflight = null;
  // Rentvine Portfolio Balances (distributable amount per portfolio). Shared by the main list and the heads-up emails; a failure never breaks the page.
  async function getBalances(fresh) {
    if (!fresh && balCache.v && Date.now() - balCache.at < TTL) return balCache;
    if (!balInflight) balInflight = (async () => {
      try { balCache = { at: Date.now(), v: await loadPortfolioBalances(rvFetch), err: '' }; }
      catch (e) { console.error('payouts balances', e); balCache = { at: Date.now(), v: {}, err: String(e.message || e) }; }
      return balCache;
    })().finally(() => { balInflight = null; });
    return balInflight;
  }

  // Six months of bills -> recurring bills per home. Slow (about a minute), so it is cached for 6 hours and shared by the Recurring bills panel and the expected-bill amounts.
  // Property addresses/owners come from the property list (props) so this never waits for the main list.
  let recCache = { at: 0, v: null }, recInflight = null;
  const REC_TTL = 6 * 60 * 60 * 1000;
  async function getRecurring(fresh) {
    if (!fresh && recCache.v && Date.now() - recCache.at < REC_TTL) return recCache.v;
    if (!recInflight) recInflight = (async () => {
      const t = today();
      const [bills, props] = await Promise.all([loadRecurringBills(rvFetch, t), allPages(rvFetch, 'property', { displayColumns: ['propertyID', 'propertyAddress', 'propertyCity', 'portfolioName'], filters: [] }, { fields: ['propertyID', 'propertyAddress', 'propertyCity', 'portfolioName'], max: 10 })]);
      const info = {}; for (const p of props) info[String(p.propertyID)] = { address: [p.propertyAddress, p.propertyCity].filter(Boolean).join(', '), owner: p.portfolioName || '' };
      const found = findRecurring(bills, info, { todayISO: t, skipAccounts: [MGMT_FEE_ACCOUNT_ID] });
      let expected = expectedFromHistory(found.rows), setupInfo = { used: 0, unmatched: [], error: '' };
      try {
        const sraw = await loadRecurringSetup(rvFetch);
        const setup = parseSetup(sraw, props);
        expected = mergeSetup(expected, setup, found.rows);
        setupInfo = { used: setup.used, unmatched: setup.unmatched, error: setup.used ? '' : (sraw.length ? 'Rentvine recurring list was read (' + sraw.length + ' rows) but no home could be matched' : 'Rentvine recurring list came back empty'), fields: setup.fields || null, rowsRead: sraw.length };
      } catch (e) { setupInfo = { used: 0, unmatched: [], error: String(e.message || e) }; expected = mergeSetup(expected, { byProperty: {} }, found.rows); }
      recCache = { at: Date.now(), v: { asOf: new Date().toISOString(), billsRead: bills.length, ...found, expected, setup: setupInfo } };
      return recCache.v;
    })().finally(() => { recInflight = null; });
    return recInflight;
  }

  app.get('/payouts', (req, res) => res.sendFile(new URL('./public/payouts.html', import.meta.url).pathname));

  async function getList(fresh) {
    if (!fresh && cache.v && Date.now() - cache.at < TTL) return cache.v;
    if (!inflight) inflight = (async () => {
      const raw = await loadPayoutData(rvFetch, { typical, reserve });
      // expected recurring amounts come from what each home was really billed; if that is slow or fails the page still loads (amounts then show as unknown)
      let recErr = '';
      try { const rc = await Promise.race([getRecurring(false), new Promise((_, rej) => setTimeout(() => rej(new Error('still loading - refresh in a minute')), 90000))]); raw.recExp = rc.expected || {}; if (rc.setup && rc.setup.error) recErr = 'Rentvine recurring bills list: ' + rc.setup.error + ' (using billing history instead)'; }
      catch (e) { recErr = String(e.message || e); raw.recExp = {}; }
      raw.recErr = recErr;
      const li = getRents ? { rents: await getRents(rvFetch), info: {} } : await getLeaseInfo(rvFetch);
      const rents = li.rents;
      const owners = shapeOwners(raw, rents, await getExpectedBills(rvFetch), li.info);
      const bals = await getBalances(fresh);
      for (const o of owners) { const b = (bals.v || {})[String(o.portfolioID)]; if (b) o.rentvine = { distributable: b.distributable, operating: b.operating, reserve: b.reserve, hold: b.hold }; }
      const out = {
        asOf: new Date().toISOString(), scope: 'Rental Trust (bank account ' + TRUST_BANK_ACCOUNT_ID + ')', reserve,
        decisionsSaved: !!decisions.persistent, flagText: FLAG_TEXT,
        counts: { properties: raw.props.length, payments: raw.settle.length, payouts: raw.checks.length, bills: raw.bills.length, rents: Object.keys(rents).length, vacant: raw.vacancy.length, contributions: raw.contribRows.length, moveIns: (raw.fee.moves || []).length, feeBills: (raw.fee.feeBills || []).length, latePayments: (raw.late.rows || []).length },
        feeCheckError: raw.fee.error || '', lateRentError: raw.late.error || '', tenantChargesError: (raw.tcharges && raw.tcharges.error) || '', recurringError: raw.recErr || '', balancesError: bals.err || '', balancesLoaded: Object.keys(bals.v || {}).length,
        windows: { payoutDays: PAYOUT_DAYS, billDays: BILL_DAYS, contributionDays: CONTRIB_DAYS },
        unmatchedContributions: owners.unmatchedContributions || [],
        owners: portfolio(owners, {}), decisions: await decisions.get(),
      };
      cache = { at: Date.now(), v: out };
      return out;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  app.get('/api/payouts/list', async (req, res) => {
    if (!guard(req, res)) return;
    try { res.json(await getList(req.query.refresh === '1')); }
    catch (e) { console.error('payouts list', e); res.status(502).json({ error: String(e.message || e) }); }
  });

  // ---- Owner heads-up emails. The preview is read-only. Drafts are only created by the POST below, and only with create:true.
  const sign = { name: env.HEADSUP_SIGN_NAME || '', phone: env.HEADSUP_SIGN_PHONE || '' };
  let huCache = { at: 0, list: null, v: null };
  async function getHeadsUp(fresh) {
    const list = await getList(fresh);
    if (!fresh && huCache.v && huCache.list === list && Date.now() - huCache.at < TTL) return huCache.v;
    const errors = [];
    const contacts = await loadOwnerContacts(rvFetch).catch((e) => { errors.push('Owner emails could not be read: ' + (e.message || e)); return { emailByContact: {}, holdByContact: {} }; });
    const bc = await getBalances(fresh); const balances = bc.v || {};
    if (bc.err) errors.push('Rentvine balances could not be read: ' + bc.err);
    const drafted = await decisions.get();
    const pv = buildPreview({ owners: list.owners, contacts, balances, todayISO: today(), sign, drafted });
    const v = { recordsPersistent: !!decisions.persistent, asOf: new Date().toISOString(), listAsOf: list.asOf, properties: list.counts.properties, errors, ownerEmails: Object.keys(contacts.emailByContact || {}).length, balances: Object.keys(balances).length, ...pv };
    huCache = { at: Date.now(), list, v };
    return v;
  }
  // Recurring bills: homes that get the same type of bill month after month (same vendor or not). Loaded only when asked for; cached 30 minutes.
  // Statement for one home or one owner's homes, one month, compared with another month. Read-only, cached 10 minutes.
  const stCache = new Map();
  app.get('/api/payouts/statement', async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const month = String(req.query.month || today().slice(0, 7)), compare = String(req.query.compare || 'prev');
      if (!/^\d{4}-\d{2}$/.test(month) || month > today().slice(0, 7)) return res.status(400).json({ error: 'Pick a month that is not in the future (YYYY-MM).' });
      if (!['prev', 'year'].includes(compare) && !/^\d{4}-\d{2}$/.test(compare)) return res.status(400).json({ error: 'Bad compare month.' });
      const list = await getList(false);
      const o = list.owners.find((x) => String(x.ownerID) === String(req.query.ownerID));
      if (!o) return res.status(404).json({ error: 'Owner not found in the current list.' });
      const only = req.query.propertyID ? String(req.query.propertyID) : '';
      const props = o.properties.filter((p) => !only || String(p.propertyID) === only).map((p) => ({ propertyID: p.propertyID, address: p.address }));
      if (!props.length) return res.status(404).json({ error: 'Property not found for this owner.' });
      const key = o.ownerID + '|' + month;
      let data = stCache.get(key);
      if (!data || Date.now() - data.at > 10 * 60 * 1000) { const ids = o.properties.map((p) => p.propertyID); const [sd, lh] = await Promise.all([loadStatementData(rvFetch, ids, o.portfolioID || o.ownerID, month), loadStatementLeases(rvFetch, ids).catch((e) => ({ leases: [], changes: [], warnings: ['lease history: ' + String(e.message || e).slice(0, 100)] }))]); data = { at: Date.now(), v: { ...sd, leases: lh.leases, changes: lh.changes, warnings: [...sd.warnings, ...lh.warnings] } }; stCache.set(key, data); if (stCache.size > 40) stCache.delete(stCache.keys().next().value); }
      const st = buildStatement({ ownerName: o.name, properties: props, bills: data.v.bills, settle: data.v.settle, month, compare, otherRows: data.v.other || [], paidRows: (data.v.rentRows || []).map((r) => ({ propertyID: r.propertyID, datePosted: r.datePosted, amount: r.paid || 0 })), paidBefore: today().slice(0, 7) });
      // occupancy and rent history per home (only when the lease read worked)
      const todayISO = today(); let agg = null, allGrowth = null;
      if ((data.v.leases || []).length) {
        agg = { days: 0, occupied: 0, series: Array.from({ length: 12 }, (_, i) => ({ month: addMonths(month, i - 11), days: 0, occupied: 0 })) };
        for (const p of st.properties) {
          const mine = data.v.leases.filter((l) => String(l.propertyID) === String(p.propertyID));
          const iv = leaseIntervals(mine, todayISO), cur = monthOccupancy(iv, month, todayISO), ser = occupancySeries(iv, month, todayISO);
          p.occupancy = { month: cur, series: ser };
          p.rentHistory = rentHistory(iv, data.v.changes.filter((c) => mine.some((l) => String(l.leaseID) === String(c.leaseID))));
          p.rentLevels = rentLevels(data.v.rentRows || [], p.propertyID, { starts: iv.map((l) => l.start), ends: iv.map((l) => l.end).filter(Boolean) });
          p.leaseRent = leaseRentRows(iv, p.rentLevels); p.rentGrowth = rentGrowth(p.rentLevels, data.v.rentRows || [], p.propertyID, month);
          p.rentChange = p.rentLevels.length > 1 ? explainEvents(levelEvents(p.rentLevels), month) : rentChangeExplain(p.rentHistory, month);
          agg.days += cur.days; agg.occupied += cur.occupied; ser.forEach((x, i) => { agg.series[i].days += x.days; agg.series[i].occupied += x.occupied; });
        }
        // all homes together: only homes that have a rent on both dates are compared
        const gh = st.properties.map((p) => p.rentGrowth).filter(Boolean);
        if (gh.length) {
          const ago = [1, 2, 3].map((y) => { const hs = st.properties.filter((p) => p.rentGrowth && p.rentGrowth.ago.some((x) => x.years === y)); if (!hs.length) return null; const now = hs.reduce((s, p) => s + p.rentGrowth.now, 0), then = hs.reduce((s, p) => s + p.rentGrowth.ago.find((x) => x.years === y).rent, 0); return { years: y, rent: Math.round(then * 100) / 100, change: Math.round((now - then) * 100) / 100, pct: then ? Math.round(((now - then) / then) * 1000) / 10 : null, homes: hs.length }; }).filter(Boolean);
          const cb = gh.filter((g) => g.charged.last12 != null && g.charged.prev12 != null), l12 = cb.reduce((s, g) => s + g.charged.last12, 0), p12 = cb.reduce((s, g) => s + g.charged.prev12, 0);
          allGrowth = { now: Math.round(gh.reduce((s, g) => s + g.now, 0) * 100) / 100, homes: gh.length, ago, charged: cb.length ? { last12: Math.round(l12 * 100) / 100, prev12: Math.round(p12 * 100) / 100, change: Math.round((l12 - p12) * 100) / 100 } : null };
        }
        const pc = (o2) => ({ ...o2, vacant: o2.days - o2.occupied, pct: o2.days ? Math.round((o2.occupied / o2.days) * 1000) / 10 : null });
        agg = { month: pc(agg), series: agg.series.map(pc) };
      }
      res.json({ ...st, occupancy: agg, rentGrowth: allGrowth, reserve: o.reserve ?? 0, asOf: new Date(data.at).toISOString(), warnings: data.v.warnings, singleHome: !!only });
    } catch (e) { console.error('payouts statement', e); res.status(502).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // Read-only look at the SHAPE of a Rentvine response (field names only, never values), to find out how bills expose their invoice files.
  // Staff-only, read-only diagnostic: shows the FIELD NAMES a Rentvine report or bill returns (never values), and Rentvine's error text if it refuses.
  // /api/payouts/probe?path=/reports/lease-payments[&dateField=datePosted]   or   ?path=/reports/lease-payments/meta   or   ?path=/accounting/bills/<id>
  app.get('/api/payouts/probe', async (req, res) => {
    if (!guard(req, res)) return;
    const path = String(req.query.path || '');
    if (!/^\/(accounting\/bills\/\d+|bills\/\d+|reports\/[a-z-]+(\/meta)?)$/.test(path)) return res.status(400).json({ error: 'Only /accounting/bills/<id>, /bills/<id>, /reports/<name> or /reports/<name>/meta can be probed.' });
    const dateField = /^[A-Za-z]{3,40}$/.test(String(req.query.dateField || '')) ? String(req.query.dateField) : 'datePosted';
    const shape = (v, d = 0) => Array.isArray(v) ? { array: v.length, item: v.length && d < 3 ? shape(v[0], d + 1) : null } : (v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).slice(0, 80).map((k) => [k, d < 3 ? shape(v[k], d + 1) : typeof v[k]])) : (v === null ? 'null' : typeof v));
    try {
      const isReport = /^\/reports\/[a-z-]+$/.test(path);
      const filters = isReport ? [{ name: dateField, comparator: 'betweenDate', startDate: daysAgo(30), endDate: today() }] : [];
      const r = await rvFetch(path, isReport ? { exportTypeID: 1, json: JSON.stringify({ filters }), page: 1, pageSize: 1 } : {});
      const out = { path, dateField: isReport ? dateField : undefined, shape: shape(r) };
      if (r && typeof r === 'object' && typeof r.error === 'string') out.rentvineError = r.error.slice(0, 300);
      if (r && typeof r === 'object' && typeof r.message === 'string') out.rentvineMessage = r.message.slice(0, 300);
      res.json(out);
    } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.get('/api/payouts/recurring', async (req, res) => {
    if (!guard(req, res)) return;
    try { res.json(await getRecurring(req.query.refresh === '1')); }
    catch (e) { console.error('payouts recurring', e); res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.get('/api/payouts/heads-up', async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const v = await getHeadsUp(req.query.refresh === '1');
      // the page shows the text, not the html (the html is rebuilt on the server when a draft is created)
      res.json({ ...v, drafts: v.drafts.map(({ html, paras, ...d }) => d) });
    } catch (e) { console.error('payouts heads-up', e); res.status(502).json({ error: String(e.message || e) }); }
  });
  app.post('/api/payouts/heads-up/draft', async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const { ownerIDs, create, testTo } = req.body || {};
      const v = await getHeadsUp(false);
      if (create === true && v.properties < MIN_PROPERTIES_FOR_DRAFTS) return res.status(503).json({ error: 'Only ' + v.properties + ' properties loaded (expected 300+). No drafts created - refresh and try again.' });
      if (create === true && v.errors.length) return res.status(503).json({ error: 'Not creating drafts: ' + v.errors.join(' | ') });
      const writer = createDraft || makeAptlyDraftWriter(env);
      const slack = notify || makeSlackNotifier(env);
      const out = await runBatch({ preview: v, ownerIDs, create: create === true, testTo: String(testTo || '').trim(), createDraft: writer, notify: slack, channelId: env.APTLY_INFO_CHANNEL_ID || APTLY_INFO_CHANNEL_ID, markDrafted: (k, d) => decisions.set(k, { action: 'headsup_drafted', ...d }) });
      if (create === true && !testTo) huCache = { at: 0, list: null, v: null };
      res.json(out);
    } catch (e) { console.error('payouts heads-up draft', e); res.status(400).json({ error: String(e.message || e) }); }
  });

  app.post('/api/payouts/decision', async (req, res) => {
    if (!guard(req, res)) return;
    const { ownerID, action, note } = req.body || {};
    if (!ownerID || !['approve', 'hold', 'ask_owner'].includes(action)) return res.status(400).json({ error: 'ownerID and action (approve|hold|ask_owner) required' });
    res.json(await decisions.set(ownerID, { action, note: String(note || '').slice(0, 500) }));
  });
}
