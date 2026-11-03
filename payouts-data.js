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
    settledIn: dollars(settled), nonOwnerPaid: dollars(nonOwner),
    feePosted: p.feePosted === undefined ? fee > 0 : !!p.feePosted,
    unpaidBills: dollars(billsC), bills,
    recurring: p.recurring || [], recurringTotal: dollars(recC),
    billExpected: !!p.billExpected,
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
  const nonOwnerTotal = sum('nonOwnerPaid');
  const unpostedFee = rows.reduce((t, r) => t + (!r.feePosted && cents(r.fee) > 0 ? cents(r.fee) : 0), 0);
  const amountToPay = rvOK ? cents(o.rentvine.distributable) - nonOwnerTotal - unpostedFee : pageAmount;
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
  };
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
