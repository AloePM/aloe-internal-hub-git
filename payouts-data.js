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
  const rent = cents(p.rent), fee = cents(p.fee), settled = cents(p.settledIn);
  const bills = (p.bills || []).filter((b) => !b.isPaid && !b.isVoided);
  const billsC = bills.reduce((s, b) => s + cents(b.amountUnpaid), 0);
  const recC = (p.recurring || []).reduce((s, r) => s + cents(r.amount), 0);
  const expected = rent - fee;
  return {
    propertyID: p.propertyID, address: p.address,
    rent: dollars(rent), fee: dollars(fee), expected: dollars(expected),
    settledIn: dollars(settled),
    unpaidBills: dollars(billsC), bills,
    recurring: p.recurring || [], recurringTotal: dollars(recC),
    billExpected: !!p.billExpected,
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
  const amountToPay = sum('net') - reserve;
  const last = o.lastPayout == null ? null : cents(o.lastPayout);
  const flags = [];
  if (amountToPay < 0) flags.push('below_zero');
  else {
    if (expected > 0 && amountToPay < expected * cfg.lessThanUsualPct) flags.push('less_than_usual');
    if (last != null && last > 0 && amountToPay < last * cfg.lowerThanLastPct) flags.push('lower_than_last');
  }
  if (rows.some((r) => r.billExpected)) flags.push('bill_expected');
  if (rows.some((r) => (r.recurring || []).some((x) => !x.amount))) flags.push('recurring_unknown');
  const needsLook = flags.some((f) => f !== 'bill_expected' || true) && flags.length > 0;
  return {
    ownerID: o.ownerID, name: o.name, properties: rows,
    settledIn: dollars(sum('settledIn')), fees: dollars(sum('fee')),
    unpaidBills: dollars(sum('unpaidBills')), recurringTotal: dollars(sum('recurringTotal')),
    reserve: dollars(reserve), expected: dollars(expected), amountToPay: dollars(amountToPay),
    lastPayout: last == null ? null : dollars(last),
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
  recurring_unknown: 'Recurring bill has no typical amount yet',
};
