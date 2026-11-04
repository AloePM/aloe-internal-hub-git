// Occupancy and rent history from lease dates. Pure functions. No tenant names are read or kept.
import { iso, addMonths } from './statement.js';
const num = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
const BAD = /cancel|draft|void|denied|declin|reject/i, ACTIVE = /active|current|month.to.month|notice|renew|holdover|moving/i, ENDED = /closed|ended|expired|terminated|past|broken/i;

// [{start,end,rent,leaseID}] from lease rows. end '' = still going.
export function leaseIntervals(rows, todayISO) {
  const out = [];
  for (const r of rows || []) {
    const status = String(r.leaseStatusName || r.status || '');
    const start = iso(r.moveInDate || r.leaseStartDate || r.startDate), out1 = iso(r.moveOutDate), exp = iso(r.expectedMoveOutDate);
    if (!start || BAD.test(status)) continue;
    let end = out1 || '';
    if (!end && ENDED.test(status)) end = exp || start;          // ended but no move-out date: do not count it as open
    if (!end && exp && exp < todayISO && !ACTIVE.test(status)) end = exp;
    out.push({ leaseID: r.leaseID, start, end, rent: num(r.rentAmount), status });
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : 1));
}
const dayOf = (ym, d) => ym + '-' + String(d).padStart(2, '0');
export function monthOccupancy(intervals, ym, todayISO) {
  const dim = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
  const last = todayISO.slice(0, 7) === ym ? Number(todayISO.slice(8, 10)) : (ym > todayISO.slice(0, 7) ? 0 : dim);
  let occ = 0;
  for (let d = 1; d <= last; d++) { const day = dayOf(ym, d); if (intervals.some((l) => l.start <= day && (!l.end || day < l.end))) occ++; }
  return { days: last, occupied: occ, vacant: last - occ, pct: last ? Math.round((occ / last) * 1000) / 10 : null };
}
export function occupancySeries(intervals, ym, todayISO) {
  return Array.from({ length: 12 }, (_, i) => { const m = addMonths(ym, i - 11); return { month: m, ...monthOccupancy(intervals, m, todayISO) }; });
}

// Rent by lease, with the change from the previous lease, plus rent changes inside a lease when Rentvine records them.
// changes: [{leaseID, date, amount}] (rent charge periods: the amount that applies from date)
export function rentHistory(intervals, changes = []) {
  const byLease = {}; for (const c of changes) (byLease[String(c.leaseID)] ||= []).push(c);
  const out = []; let prev = null;
  for (const l of intervals) {
    const cs = (byLease[String(l.leaseID)] || []).filter((c) => c.date && c.amount > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
    const inc = []; let cur = cs.length ? cs[0].amount : l.rent;
    for (const c of cs.slice(1)) { if (Math.abs(c.amount - cur) > 0.005) { inc.push({ date: c.date, from: cur, to: c.amount, change: Math.round((c.amount - cur) * 100) / 100, pct: cur ? Math.round(((c.amount - cur) / cur) * 1000) / 10 : null }); cur = c.amount; } }
    const startRent = cs.length ? cs[0].amount : l.rent;
    const row = { leaseID: l.leaseID, start: l.start, end: l.end, startRent, endRent: cur, increases: inc, changeFromPrevious: prev == null || !prev ? null : Math.round((startRent - prev) * 100) / 100, pctFromPrevious: prev ? Math.round(((startRent - prev) / prev) * 1000) / 10 : null };
    out.push(row); prev = cur;
  }
  return out;
}
export function rentChangesFrom(rows) {
  // tolerant reader for the lease recurring charges report: pick the columns by name
  const out = [];
  for (const r of rows || []) {
    const ks = Object.keys(r || {}), f = (...n) => { for (const x of n) { const k = ks.find((k2) => k2.toLowerCase().replace(/[^a-z0-9]/g, '') === x); if (k) return r[k]; } return undefined; };
    const acct = String(f('chargeaccountname', 'accountname', 'chargeaccount') ?? ''), id = num(f('chargeaccountid', 'accountid'));
    if (!(id === 10 || /^rent\b|rent income/i.test(acct))) continue;
    out.push({ leaseID: f('leaseid'), date: iso(f('datestart', 'startdate', 'datefrom', 'datestarts', 'startsondate')), amount: num(f('amount', 'chargeamount')) });
  }
  return out;
}
