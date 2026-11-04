// Owner Payouts - pure math (no network, no writes). Used by payouts-routes.js and the tests.
// Rule: owner gets collected rent minus the management fee. Expenses (unpaid bills, expected recurring
// service bills) come off. Only money that has SETTLED (Settlement Detail "Money In") counts as available.

const cents = (n) => Math.round((Number(n) || 0) * 100);
const dollars = (c) => c / 100;

export const DEFAULTS = { reserve: 0, lessThanUsualPct: 0.9, lowerThanLastPct: 0.9 };

// Recurring services that are the owner's responsibility ("Landlord Responsibility") are expected every month.
export function recurringExpected(services = {}, typical = {}) {
  const out = [];
  for (const [k, label] of [['pool', 'Pool service'], ['pest', 'Pest control'], ['landscaping', 'Landscaping']]) {
    if (String(services[k] || '').toLowerCase().startsWith('landlord')) {
      const amt = Number(typical[k]) || 0;
      out.push({ key: k, label, amount: amt, known: amt > 0 });
    }
  }
  return out;
}

// One property. Inputs:
//  rent, fee (dollars), settledIn (dollars settled since last payout), bills [{amountUnpaid, isPaid, isVoided, desc}],
//  recurring [{label, amount}], billExpected (open work order, bool)
export function propertyRow(p) {
  const rent = cents(p.rent), fee = cents(p.fee);
  // money a tenant paid toward charges that are not owner money (Resident Benefit Package, admin fees...) is part of the deposit but not the owner's
  const nonOwner = Math.min(Math.max(0, cents(p.nonOwnerPaid)), Math.max(0, cents(p.settledIn)));
  const settled = cents(p.settledIn) - nonOwner;
  const bills = (p.bills || []).filter((b) => !b.isPaid && !b.isVoided);
  const billsC = bills.reduce((s, b) => s + cents(b.amountUnpaid), 0);
  const recC = (p.recurring || []).reduce((s, r) => s + cents(r.amount), 0);
  const expected = rent - fee;
  return {
    propertyID: p.propertyID, address: p.address,
    rent: dollars(rent), fee: dollars(fee), planFee: dollars(cents(p.planFee)), expected: dollars(expected),
    settledIn: dollars(settled), nonOwnerPaid: dollars(nonOwner), nonOwnerRaw: dollars(Math.max(0, cents(p.nonOwnerPaid))),
    feePosted: p.feePosted === undefined ? fee > 0 : !!p.feePosted,
    unpaidBills: dollars(billsC), bills,
    recurring: p.recurring || [], recurringTotal: dollars(recC),
    billExpected: !!p.billExpected, recurringVendors: p.recurringVendors || [], recurringAmounts: p.recurringAmounts || {},
    billHistory: p.billHistory || [], feeChecks: p.feeChecks || [], lateRent: p.lateRent || null, lease: p.lease || null, tags: p.tags || [], moveOutSoon: !!p.moveOutSoon, vacant: !!p.vacant, vacantDays: p.vacantDays ?? null,
    // settled money less the fee and the expenses for this property
    net: dollars(settled - fee - billsC - recC),
  };
}

// One owner. Inputs: { ownerID, name, properties: [...], lastPayout (dollars|null), reserve }
export function ownerRow(o, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const reserve = cents(o.reserve ?? cfg.reserve);
  const rows = (o.properties || []).map(propertyRow);
  const sum = (f) => rows.reduce((s, r) => s + cents(r[f]), 0);
  const expected = sum('expected') - sum('recurringTotal');
  const pageAmount = sum('net') - reserve;   // our own cumulative math (kept as the fallback and the cross-check)
  const rvOK = !!(o.rentvine && Number.isFinite(o.rentvine.distributable));
  // Rentvine's Distributable Amount is the cash truth (reserve, unpaid bills, unsettled and undeposited receipts already taken out), but it still holds
  // tenant money that is not the owner's (Resident Benefit Package...) and does not yet have this month's management fee when that has not been posted
  // Rentvine already counts the deposit even when the page's own settled-money list does not show it yet, so for the Rentvine amount the whole tenant payment comes off (no cap)
  const nonOwnerTotal = sum('nonOwnerRaw');
  const unpostedFee = rows.reduce((t, r) => t + (!r.feePosted && cents(r.fee) > 0 ? cents(r.fee) : 0), 0);
  const recurringC = sum('recurringTotal');   // expected recurring bills (pool, landscaping, owner admin charge, HOA...) not posted yet - Rentvine cannot know about them
  const amountToPay = rvOK ? cents(o.rentvine.distributable) - nonOwnerTotal - unpostedFee - recurringC : pageAmount;
  // what the owner should normally get each month: rent minus the management fee (the posted fee, else the plan fee), homes with a tenant only
  const live = rows.filter((r) => !r.vacant && cents(r.rent) > 0);
  const monthlyRent = live.reduce((t, r) => t + cents(r.rent), 0);
  const monthlyFee = live.reduce((t, r) => t + (cents(r.fee) > 0 ? cents(r.fee) : cents(r.planFee)), 0);
  const last = o.lastPayout == null ? null : cents(o.lastPayout);
  const flags = [];
  if (amountToPay < 0) flags.push('below_zero');
  else {
    if (expected > 0 && amountToPay < expected * cfg.lessThanUsualPct) flags.push('less_than_usual');
    if (last != null && last > 0 && amountToPay < last * cfg.lowerThanLastPct) flags.push('lower_than_last');
  }
  if (rows.some((r) => r.billExpected)) flags.push('bill_expected');
  if (rows.some((r) => r.moveOutSoon)) flags.push('move_out_soon');
  if (rows.some((r) => r.vacant)) flags.push('vacant');
  if (o.newOwner) flags.push('new_owner');
  if ((o.contributions || []).length) flags.push('owner_contribution');
  if (rows.some((r) => (r.tags || []).some((t) => t.key === 'late_cleared'))) flags.push('late_rent_ready');
  if (rows.some((r) => (r.tags || []).some((t) => t.key === 'fee_missing' || t.key === 'fee_check'))) flags.push('placement_fee');
  if (rows.some((r) => (r.tags || []).some((t) => t.key === 'fee_prorate'))) flags.push('fee_prorate');
  if (rows.some((r) => (r.recurring || []).some((x) => !x.amount))) flags.push('recurring_unknown');
  const needsLook = flags.some((f) => f !== 'bill_expected' || true) && flags.length > 0;
  return {
    ownerID: o.ownerID, portfolioID: o.portfolioID ?? o.ownerID, contactIDs: o.contactIDs || [], name: o.name, properties: rows,
    settledIn: dollars(sum('settledIn')), fees: dollars(sum('fee')),
    unpaidBills: dollars(sum('unpaidBills')), recurringTotal: dollars(sum('recurringTotal')),
    reserve: dollars(reserve), expected: dollars(expected), amountToPay: dollars(amountToPay),
    amountSource: rvOK ? 'rentvine' : 'page', pageAmount: dollars(pageAmount), nonOwnerPaid: dollars(nonOwnerTotal), unpostedFee: dollars(unpostedFee), rentvineRaw: rvOK ? dollars(cents(o.rentvine.distributable)) : null, rentvine: rvOK ? o.rentvine : null,
    expectedMonthly: dollars(monthlyRent - monthlyFee), monthlyRent: dollars(monthlyRent), monthlyFee: dollars(monthlyFee),
    lastPayout: last == null ? null : dollars(last), lastPayoutDate: o.lastPayoutDate || null, neverPaid: last == null, newOwner: !!o.newOwner, contributions: o.contributions || [], contribTotal: dollars((o.contributions || []).reduce((t, c) => t + cents(c.amount), 0)),
    tagCounts: Object.fromEntries(['new_move_in', 'move_out_30', 'move_out_month', 'move_out_next', 'vacant', 'no_fee', 'new_property', 'fee_missing', 'fee_check', 'fee_ok', 'fee_due', 'fee_skip', 'late_cleared', 'late_pending', 'movein_cleared', 'movein_pending', 'fee_prorate', 'fee_prorate_due'].map((k) => [k, rows.filter((r) => (r.tags || []).some((t) => t.key === k)).length])),
    flags, status: flags.length ? 'Needs a look' : 'Looks fine', needsLook,
    ...(({ queue, reason }) => ({ queue, queueReason: reason }))(classifyQueue({ rows, flags, amountC: amountToPay, expectedC: monthlyRent - monthlyFee, recurringC })),
  };
}

// Payout queue: which bucket an owner belongs in, and a one-line reason.
//   ready            amount equals expected rent minus fee, only the management fee bill
//   normal_recurring only normal recurring bills (pool, landscaping, pest, owner admin charge, HOA, set-up recurring bills)
//   extra            other bills (the reason lists them)
//   moves            moving out soon, vacant, new owner or a new move-in
//   needs_look       something to check first (below $0, open work order, fee problem, amount not explained...)
const SERVICE_ACCTS = [83, 79, 77];
const BLOCKING = ['below_zero', 'bill_expected', 'owner_contribution', 'placement_fee', 'fee_prorate', 'recurring_unknown'];
const nv = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const m2 = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function classifyQueue({ rows, flags, amountC, expectedC, recurringC }) {
  const counted = [];
  for (const r of rows) for (const b of r.billHistory || []) if (b.counted && b.accountID !== 93) counted.push({ b, r });
  // a pool / landscaping / pest bill is normal only when it matches the amount that home is normally billed (a one-off like a $135 bucket of chlorine on the pool account is an extra)
  const SVC = { 83: 'pool', 79: 'landscaping', 77: 'pest' };
  const svcOK = ({ b, r }) => { const known = Number((r.recurringAmounts || {})[SVC[Number(b.accountID)]]) || 0; return !known || Math.abs((Number(b.amount) || 0) - known) <= 0.5; };
  const isNormal = (x) => { const { b, r } = x; return (SERVICE_ACCTS.includes(Number(b.accountID)) ? svcOK(x) : false) || /owner\s*admin|hoa/i.test(b.account || '') || (r.recurringVendors || []).some((v) => nv(v) && nv(v) === nv(b.vendor)); };
  const normal = counted.filter(isNormal), extra = counted.filter((x) => !isNormal(x));
  const label = ({ b }) => (b.account || b.vendor || 'Bill') + ' ' + m2(Math.round((Number(b.amount) || 0) * 100));
  const list = (arr) => arr.slice(0, 3).map(label).join(', ') + (arr.length > 3 ? ' +' + (arr.length - 3) + ' more' : '');
  const normalC = normal.reduce((t, x) => t + Math.round((Number(x.b.amount) || 0) * 100), 0) + recurringC;
  const moves = rows.some((r) => r.moveOutSoon || r.vacant) || flags.includes('new_owner') || rows.some((r) => (r.tags || []).some((t) => t.key === 'new_move_in'));
  const blockers = flags.filter((f) => BLOCKING.includes(f));
  const T = { below_zero: 'Below $0', bill_expected: 'Open work order, bill expected', owner_contribution: 'Owner added money recently', placement_fee: 'Placement fee to check', fee_prorate: 'Management fee should be prorated', recurring_unknown: 'A recurring bill has no amount' };
  if (blockers.length || amountC < 0) { const t = (amountC < 0 && !blockers.includes('below_zero') ? ['Below $0'] : blockers.map((f) => T[f])); return { queue: 'needs_look', reason: t.slice(0, 2).join(' · ') + (t.length > 2 ? ' +' + (t.length - 2) + ' more' : '') }; }
  if (moves) {
    const parts = []; if (rows.some((r) => r.moveOutSoon)) parts.push('Moving out soon'); if (rows.some((r) => r.vacant)) parts.push('Vacant home'); if (flags.includes('new_owner')) parts.push('New owner'); if (rows.some((r) => (r.tags || []).some((t) => t.key === 'new_move_in'))) parts.push('New move-in');
    return { queue: 'moves', reason: parts.join(' · ') };
  }
  if (extra.length) return { queue: 'extra', reason: list(extra) };
  const diff = amountC - (expectedC - normalC);
  if (Math.abs(diff) > 100) return { queue: 'needs_look', reason: 'Amount ' + m2(amountC) + ', expected ' + m2(expectedC - normalC) + ' - not explained by bills' };
  if (normalC > 0) return { queue: 'normal_recurring', reason: normal.length ? list(normal) + (recurringC > 0 ? ' + expected ' + m2(recurringC) : '') : 'Expected recurring ' + m2(recurringC) };
  return { queue: 'ready', reason: 'Equals expected rent minus fee' };
}

export function portfolio(owners, opts) {
  const rows = owners.map((o) => ownerRow(o, opts));
  rows.sort((a, b) => (b.flags.length > 0) - (a.flags.length > 0) || a.name.localeCompare(b.name));
  return rows;
}

export const FLAG_TEXT = {
  below_zero: 'Below zero - expenses are more than cleared money',
  less_than_usual: 'Less than usual - under expected rent minus fee',
  lower_than_last: 'Lower than last payout',
  bill_expected: 'Open work order, bill expected',
  move_out_soon: 'Tenant moving out within 30 days - consider holding funds',
  new_owner: 'New owner (all homes started in the last 60 days) - check onboarding fees and contributions before paying',
  vacant: 'A home is vacant - no rent is coming in, check before paying out',
  placement_fee: 'A new move-in has no placement fee billed, or the amount needs a person to look - check Commissions/Placement Fees',
  fee_prorate: 'Management fee does not match the prorated rule (half fee for a move-in on or after the 15th or a move-out on or after the 20th) - check the fee bill',
  late_rent_ready: 'Late rent has cleared since the last payout - this owner can be paid now',
  owner_contribution: 'Owner contributed money in the last 30 days - make sure it is not sent back',
  recurring_unknown: 'Recurring bill has no typical amount yet',
};
