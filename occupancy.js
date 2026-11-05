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
  for (let d = 1; d <= last; d++) { const day = dayOf(ym, d); if (intervals.some((l) => l.start <= day && (!l.end || day <= l.end))) occ++; }
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

// Plain-language explanation of a rent change that affects the statement month (proration in the month of the change, full new rent after it).
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const money2 = (n) => '$' + (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const mdLabel = (d) => MONTHS[Number(d.slice(5, 7)) - 1].slice(0, 3) + ' ' + Number(d.slice(8, 10));
export function rentEvents(history) {
  const ev = [];
  (history || []).forEach((l, i) => {
    const prev = i > 0 ? history[i - 1] : null;
    if (prev && l.start && Math.abs(l.startRent - prev.endRent) > 0.005) ev.push({ date: l.start, from: prev.endRent, to: l.startRent });
    for (const x of l.increases || []) ev.push({ date: x.date, from: x.from, to: x.to });
  });
  return ev.filter((e) => e.date).sort((a, b) => (a.date < b.date ? -1 : 1));
}
export function rentChangeExplain(history, ym) { return explainEvents(rentEvents(history), ym); }
export function explainEvents(ev, ym) {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  const prevYm = m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0');
  const mn = MONTHS[m - 1], pn = MONTHS[(m + 10) % 12], dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const inMonth = ev.filter((e) => e.date.slice(0, 7) === ym), inPrev = ev.filter((e) => e.date.slice(0, 7) === prevYm);
  const parts = [];
  for (const e of inMonth) {
    const d = Number(e.date.slice(8, 10)), up = e.to > e.from, diff = Math.round(Math.abs(e.to - e.from) * 100) / 100;
    const head = 'The rent ' + (up ? 'increased' : 'decreased') + ' from ' + money2(e.from) + ' to ' + money2(e.to) + ' on ' + mdLabel(e.date) + ' (' + money2(diff) + ' ' + (up ? 'more' : 'less') + ' per month).';
    if (d <= 1) { parts.push(head + ' ' + mn + ' is the first month at the new rent.'); continue; }
    const dOld = d - 1, dNew = dim - dOld, a = Math.round(e.from * dOld / dim * 100) / 100, b = Math.round(e.to * dNew / dim * 100) / 100;
    parts.push(head + ' So ' + mn + ' rent is prorated: ' + dOld + ' days at ' + money2(e.from) + ' (' + money2(a) + ') plus ' + dNew + ' days at ' + money2(e.to) + ' (' + money2(b) + ') = ' + money2(a + b) + '.');
  }
  for (const e of inPrev) {
    const d = Number(e.date.slice(8, 10)), up = e.to > e.from, diff = Math.round(Math.abs(e.to - e.from) * 100) / 100;
    parts.push((d > 1 ? pn + ' rent was prorated because the rent ' + (up ? 'increased' : 'decreased') + ' on ' + mdLabel(e.date) + ' (from ' + money2(e.from) + ' to ' + money2(e.to) + '). ' : '') + mn + ' is the first full month at ' + money2(e.to) + ', which is ' + money2(diff) + ' ' + (up ? 'more' : 'less') + ' per month than before (' + money2(diff * 12) + ' a year).');
  }
  return parts.length ? { text: parts.join(' '), events: [...inMonth, ...inPrev] } : null;
}

// Rent levels from the rent actually CHARGED each month (works for every tenant, however Rentvine stores a renewal).
// rows: [{propertyID, datePosted (ISO), amount}] for the rent account only. A month with one rent charge is a "steady" month at that rent;
// a month with several (or an odd one right before a change) is a prorated month, and the change day is solved from the prorated total.
export function rentLevels(rows, propertyID, opts = {}) {
  const by = {};
  for (const r of rows || []) { if (String(r.propertyID) !== String(propertyID) || !r.datePosted || !(r.amount > 0)) continue; (by[r.datePosted.slice(0, 7)] ||= []).push(r.amount); }
  const months = Object.keys(by).sort();
  const dimOf = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
  // a lease starting after the 1st, or ending before the last day, makes that month a prorated month, not a rent level
  const startIn = (m) => (opts.starts || []).find((d) => d && d.slice(0, 7) === m && Number(d.slice(8, 10)) > 1) || '';
  const endIn = (m) => (opts.ends || []).some((d) => d && d.slice(0, 7) === m && Number(d.slice(8, 10)) < dimOf(m));
  const levels = []; let cur = null, pending = null;
  const nextYm = (m) => { const y = Number(m.slice(0, 4)), k = Number(m.slice(5, 7)); return k === 12 ? (y + 1) + '-01' : y + '-' + String(k + 1).padStart(2, '0'); };
  for (const m of months) {
    const a = by[m], sum = Math.round(a.reduce((x, y) => x + y, 0) * 100) / 100, st = startIn(m);
    if (a.length !== 1 || st || endIn(m)) { pending = { m, sum, start: st }; continue; }
    const amt = a[0];
    if (!cur) {
      const from = pending && pending.start && nextYm(pending.m) === m ? pending.start : m + '-01';
      cur = { from, rent: amt, prorated: pending && pending.start && nextYm(pending.m) === m ? { month: pending.m, total: pending.sum } : null }; levels.push(cur); pending = null; continue;
    }
    if (Math.abs(amt - cur.rent) > 0.005) {
      let date = m + '-01', prorated = null;
      if (pending && nextYm(pending.m) === m) {
        if (pending.start) { date = pending.start; prorated = { month: pending.m, total: pending.sum }; }
        else {
          const dim = dimOf(pending.m), d = Math.round(dim * (amt - pending.sum) / (amt - cur.rent));
          if (d >= 1 && d < dim) date = pending.m + '-' + String(d + 1).padStart(2, '0');
          prorated = { month: pending.m, total: pending.sum };
        }
      }
      const nl = { from: date, rent: amt, prorated }; levels.push(nl); cur = nl;
    }
    pending = null;
  }
  // a rent that lasts about one month and then returns to the earlier rent is a concession or credit, not a rent change
  for (let again = true; again;) { again = false; for (let i = 1; i < levels.length - 1; i++) { if (Math.abs(levels[i + 1].rent - levels[i - 1].rent) < 0.005 && (Date.parse(levels[i + 1].from) - Date.parse(levels[i].from)) / 864e5 <= 35) { levels.splice(i, 2); again = true; break; } } }
  return levels.map((l, i) => {
    const prev = i ? levels[i - 1] : null, next = levels[i + 1];
    const d = next ? new Date(Date.parse(next.from + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10) : null;
    return { from: l.from, to: d, rent: l.rent, change: prev ? Math.round((l.rent - prev.rent) * 100) / 100 : null, pct: prev && prev.rent ? Math.round(((l.rent - prev.rent) / prev.rent) * 1000) / 10 : null, prorated: l.prorated };
  });
}
// the rent level in effect on a date (null before the first charge)
export const rentAt = (levels, d) => { let r = null; for (const l of levels || []) if (l.from <= d && (!l.to || l.to >= d)) r = l; return r; };
// every lease (closed ones included) with the rent charged during it, the change from the previous lease, and increases inside the lease
export function leaseRentRows(intervals, levels) {
  const out = []; let prevEnd = null;
  for (const l of intervals || []) {
    const lv = rentAt(levels, l.start) || (levels || []).find((x) => x.from >= l.start && (!l.end || x.from <= l.end)) || null;
    const startRent = lv ? lv.rent : (l.rent || null); if (startRent == null) continue;
    const inc = (levels || []).filter((x) => x.change != null && x.from > l.start && (!l.end || x.from <= l.end)).map((x) => ({ date: x.from, from: x.rent - x.change, to: x.rent, pct: x.pct }));
    const endRent = inc.length ? inc[inc.length - 1].to : startRent;
    out.push({ start: l.start, end: l.end || '', startRent, endRent, increases: inc, changeFromPrevious: prevEnd == null ? null : Math.round((startRent - prevEnd) * 100) / 100, pctFromPrevious: prevEnd ? Math.round(((startRent - prevEnd) / prevEnd) * 1000) / 10 : null });
    prevEnd = endRent;
  }
  return out;
}
// asset-manager view: rent today vs 1, 2 and 3 years ago, and rent charged in the last 12 months vs the 12 before
export function rentGrowth(levels, rows, propertyID, ym) {
  const dim = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
  const now = rentAt(levels, ym + '-' + String(dim).padStart(2, '0')); if (!now) return null;
  const ago = [1, 2, 3].map((y) => { const r = rentAt(levels, addMonths(ym, -12 * y) + '-' + String(dim).padStart(2, '0')); return r ? { years: y, rent: r.rent, change: Math.round((now.rent - r.rent) * 100) / 100, pct: r.rent ? Math.round(((now.rent - r.rent) / r.rent) * 1000) / 10 : null } : null; }).filter(Boolean);
  const sumWin = (a, b) => { let t = 0, any = false; for (const r of rows || []) { if (String(r.propertyID) !== String(propertyID) || !r.datePosted) continue; const m = r.datePosted.slice(0, 7); if (m >= a && m <= b) { t += r.amount; any = true; } } return any ? Math.round(t * 100) / 100 : null; };
  const last12 = sumWin(addMonths(ym, -11), ym), prev12 = sumWin(addMonths(ym, -23), addMonths(ym, -12));
  return { now: now.rent, ago, charged: { last12, prev12, change: last12 != null && prev12 != null ? Math.round((last12 - prev12) * 100) / 100 : null } };
}
export const levelEvents = (levels) => levels.filter((l) => l.change != null).map((l, i) => { const k = levels.indexOf(l); return { date: l.from, from: levels[k - 1].rent, to: l.rent }; });
