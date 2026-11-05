// Tenant-paid fees (admin, late, NSF, RBP ...) that staff post to the property as a bill AFTER the tenant's money has settled.
// Rentvine does not say which payment paid which fee, so this matches by lease: a paid fee is on HOLD while the lease has any payment that
// is applied to charges but not yet settled. Wrong in the safe direction only (it may hold a fee a little long, never release it early).
export const FEE_ACCOUNTS = {
  40: '4405 RBP', 148: '4405-2 SN-RBP', 58: '4473 Administrative Fee', 51: '4445 MGMT Pet Fee Not Refundable', 14: '4500 Late Fee',
  57: '4472 Five Day Notice', 90: '6101 Legal', 12: '4410 Dishonored Funds Charge', 62: '4476 Lease Break Fee', 56: '4471 Transaction Fee',
};
export const FEE_ACCOUNT_IDS = Object.keys(FEE_ACCOUNTS).map(Number);
const n = (v) => { if (v === null || v === undefined || v === '') return 0; const x = Number(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(x) ? x : 0; };
const t = (v) => v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true';
const iso = (v) => (v ? String(v).slice(0, 10) : '');
const cents = (v) => Math.round(v * 100) / 100;
const addDays = (d, k) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };

export function buildFeeHold({ charges = [], payments = [], bills = [], today, showDays = 60 } = {}) {
  const cutoff = addDays(today, -showDays);
  const fees = charges.filter((c) => !t(c.isVoided) && FEE_ACCOUNT_IDS.includes(n(c.chargeAccountID)));
  // payments applied to charges but not settled yet (returned/voided ones are not "pending", they are alerts)
  const pendingByLease = {}, returnedByLease = {};
  for (const p of payments) {
    if (t(p.isVoided) || p.leaseID === undefined || p.leaseID === '') continue;
    const lid = String(p.leaseID);
    const applied = p.amountAllocated === undefined || p.amountAllocated === '' ? n(p.amount) : n(p.amountAllocated);
    if (t(p.isReturned)) { (returnedByLease[lid] = returnedByLease[lid] || []).push({ date: iso(p.datePosted), amount: cents(n(p.amount)) }); continue; }
    if (t(p.isDepositedSettled) || !(applied > 0)) continue;
    (pendingByLease[lid] = pendingByLease[lid] || []).push({ date: iso(p.datePosted), amount: cents(n(p.amount)), applied: cents(applied), deposit: p.depositNumber ? String(p.depositNumber) : '' });
  }
  // fee bills already posted on the property (same account): used to hide fees staff already handled
  const billed = {};
  for (const b of bills) { if (t(b.isVoided)) continue; const k = b.propertyID + '|' + n(b.chargeAccountID); billed[k] = cents((billed[k] || 0) + n(b.amount)); }
  const keyOf = (c) => c.propertyID + '|' + n(c.chargeAccountID);
  const paidTotal = {};
  for (const c of fees) paidTotal[keyOf(c)] = cents((paidTotal[keyOf(c)] || 0) + n(c.amountPaid));
  const remaining = { ...billed };
  const rows = [];
  for (const c of fees.filter((x) => n(x.amountPaid) > 0).sort((a, b) => (iso(a.datePosted) < iso(b.datePosted) ? -1 : 1))) {
    const acct = n(c.chargeAccountID), paid = cents(n(c.amountPaid)), k = keyOf(c), lid = String(c.leaseID);
    const pend = pendingByLease[lid] || [];
    let state;
    if ((remaining[k] || 0) + 0.005 >= paid) { remaining[k] = cents(remaining[k] - paid); state = 'posted'; }
    else state = pend.length ? 'hold' : 'ok';
    const posted = iso(c.datePosted);
    if (state === 'ok' && posted < cutoff) continue; // old and settled: not interesting
    rows.push({
      state, early: state === 'posted' && pend.length > 0, leaseID: lid, propertyID: String(c.propertyID), portfolio: c.portfolioName || '', tenant: c.primaryTenantName || c.tenants || '',
      address: c.unitAddress || c.propertyAddress || '', accountID: acct, account: c.accountNumber ? (c.accountNumber + ' ' + (c.accountName || '')).trim() : FEE_ACCOUNTS[acct],
      feeDate: posted, amount: cents(n(c.amount)), paid, pending: pend, pendingTotal: cents(pend.reduce((s, p) => s + p.applied, 0)),
      returned: (returnedByLease[lid] || []).filter((r) => r.date >= cutoff),
    });
  }
  // Stage 2 preview: bill posted for more than the tenant has actually paid on that fee (payment reversed / not applied) -> reverse the bill
  const alerts = [];
  for (const k of Object.keys(billed)) {
    const [pid, acct] = k.split('|'); const diff = cents(billed[k] - (paidTotal[k] || 0));
    if (diff > 0.005) {
      const ref = fees.find((c) => keyOf(c) === k) || {};
      alerts.push({ propertyID: pid, portfolio: ref.portfolioName || '', tenant: ref.primaryTenantName || '', address: ref.unitAddress || '', account: FEE_ACCOUNTS[Number(acct)] || acct, billed: billed[k], tenantPaid: paidTotal[k] || 0, reverse: diff });
    }
  }
  const sum = (s) => cents(rows.filter((r) => r.state === s).reduce((a, r) => a + r.paid, 0));
  const count = (s) => rows.filter((r) => r.state === s).length;
  return {
    rows, alerts,
    totals: { hold: count('hold'), holdAmount: sum('hold'), ok: count('ok'), okAmount: sum('ok'), posted: count('posted'), postedAmount: sum('posted'), early: rows.filter((r) => r.early).length, alerts: alerts.length },
  };
}
