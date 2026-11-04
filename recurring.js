// Recurring bills finder (pure logic, no network). Looks at the last few full months of owner bills and lists, per home and charge account,
// the ones that show up month after month - whether or not the same vendor sent them - so they can be added as "expected" bills.
const cents = (n) => Math.round((Number(n) || 0) * 100);
const truthy = (v) => v === true || v === 1 || v === '1' || /^(true|yes)$/i.test(String(v));
const iso = (v) => { const s = String(v || ''); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[0] : ''; };
export const EXCLUDED_ACCOUNTS = [94, 62];            // placement fees, lease break - one-off, never recurring. (The management fee account is excluded by the caller)
const monthsBack = (todayISO, n) => { let y = Number(todayISO.slice(0, 4)), m = Number(todayISO.slice(5, 7)); const out = []; for (let i = 1; i <= n; i++) { m -= 1; if (m < 1) { m = 12; y -= 1; } out.push(y + '-' + String(m).padStart(2, '0')); } return out.reverse(); };
export const recurringWindow = (todayISO, n = 6) => { const ms = monthsBack(todayISO, n); return { months: ms, from: ms[0] + '-01', to: todayISO }; };
const median = (a) => { const s = a.slice().sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : Math.round((s[k - 1] + s[k]) / 2); };
const monthIndex = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7));

// bills: payables rows { propertyID, chargeAccountID, chargeAccountName, datePosted, amount, isVoided, isSuppressed, contactName, description }
// info: { [propertyID]: { address, owner } }   opts: { todayISO, months (default 6), minMonths (default 3), skipAccounts: [ids] }
export function findRecurring(bills, info = {}, { todayISO, months = 6, minMonths = 3, skipAccounts = [] } = {}) {
  const win = recurringWindow(todayISO, months), inWin = new Set(win.months), cur = todayISO.slice(0, 7);
  const skip = new Set([...EXCLUDED_ACCOUNTS, ...skipAccounts].map(Number));
  const g = new Map();
  for (const b of bills || []) {
    if (truthy(b.isVoided) || truthy(b.isSuppressed)) continue;           // tenant-charged (suppressed) and voided bills never reach the owner
    const amt = cents(b.amount); if (!(amt > 0)) continue;
    const acct = Number(b.chargeAccountID); if (skip.has(acct)) continue;
    const d = iso(b.datePosted); if (!d) continue;
    const ym = d.slice(0, 7); if (!inWin.has(ym) && ym !== cur) continue;
    const key = String(b.propertyID) + '|' + acct;
    const r = g.get(key) || { propertyID: String(b.propertyID), accountID: acct, account: b.chargeAccountName || ('Account ' + acct), byMonth: {}, vendors: {}, last: '', lastAmount: 0, sample: '' };
    r.byMonth[ym] = (r.byMonth[ym] || 0) + amt;
    const v = String(b.contactName || '').trim() || '(no vendor)'; r.vendors[v] = (r.vendors[v] || 0) + 1;
    if (d >= r.last) { r.last = d; r.lastAmount = amt; r.sample = String(b.description || '').replace(/\s+/g, ' ').slice(0, 90); }
    g.set(key, r);
  }
  const rows = [];
  for (const r of g.values()) {
    const seen = win.months.filter((m) => r.byMonth[m] !== undefined);
    if (seen.length < minMonths) continue;
    const amts = seen.map((m) => r.byMonth[m]);
    const typical = median(amts), lo = Math.min(...amts), hi = Math.max(...amts);
    const gaps = seen.slice(1).map((m, i) => monthIndex(m) - monthIndex(seen[i]));
    const cadence = seen.length >= months - 1 ? 'every month' : gaps.length && gaps.every((x) => x === gaps[0]) && gaps[0] === 2 ? 'every 2 months' : gaps.length && gaps.every((x) => x === gaps[0]) && gaps[0] === 3 ? 'every 3 months' : 'some months';
    const vendors = Object.entries(r.vendors).sort((a, b) => b[1] - a[1]).map(([n]) => n);
    const i = info[r.propertyID] || {};
    rows.push({ propertyID: r.propertyID, address: i.address || ('Property ' + r.propertyID), owner: i.owner || '', accountID: r.accountID, account: r.account,
      vendors, sameVendor: vendors.length === 1, monthsSeen: seen.length, monthsOf: months, months: seen, cadence,
      typical: typical / 100, low: lo / 100, high: hi / 100, steady: hi - lo <= Math.max(500, typical * 0.15), last: r.last, lastAmount: r.lastAmount / 100, thisMonth: r.byMonth[cur] !== undefined, sample: r.sample });
  }
  rows.sort((a, b) => a.account.localeCompare(b.account) || a.address.localeCompare(b.address));
  return { window: win, rows, summary: summarize(rows) };
}
function summarize(rows) {
  const by = {};
  for (const r of rows) { const s = (by[r.account] ||= { account: r.account, homes: new Set(), vendors: new Set(), steady: 0, total: 0 }); s.homes.add(r.propertyID); r.vendors.forEach((v) => s.vendors.add(v)); s.total++; if (r.steady) s.steady++; }
  return Object.values(by).map((s) => ({ account: s.account, homes: s.homes.size, vendors: s.vendors.size, steady: s.steady, lines: s.total })).sort((a, b) => b.homes - a.homes);
}
const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
export function recurringCsv(rows) {
  const head = ['Owner', 'Property', 'Charge account', 'Vendor(s)', 'Months seen', 'Cadence', 'Typical amount', 'Low', 'High', 'Same amount each time', 'Last posted', 'Last amount', 'Posted this month', 'Example description'];
  return [head.map(q).join(',')].concat(rows.map((r) => [r.owner, r.address, r.account, r.vendors.join('; '), r.monthsSeen + ' of ' + r.monthsOf, r.cadence, r.typical.toFixed(2), r.low.toFixed(2), r.high.toFixed(2), r.steady ? 'yes' : 'no', r.last, r.lastAmount.toFixed(2), r.thisMonth ? 'yes' : 'no', r.sample].map(q).join(','))).join('\n');
}

// Expected recurring bills per home, built from the finder rows. Only bills that came EVERY month are expected.
//   pool / landscaping / pest : the owner-responsible services (typical amount); the page only adds them where the property says Landlord Responsibility
//   ownerAdmin                : Owner Administrative Charge, wherever it recurs
//   hoa                       : HOA dues, but ONLY for homes whose address matches hoaAddress (4111 E Baylor Ln is the only one Aloe pays)
export const SERVICE_ACCOUNTS = { pool: 83, landscaping: 79, pest: 77 };
export function expectedFromHistory(rows, { hoaAddress = /\b4111\b.*\bbaylor/i } = {}) {
  const out = {};
  for (const r of rows || []) {
    if (r.cadence !== 'every month') continue;
    const e = (out[r.propertyID] ||= {});
    const id = Number(r.accountID);
    const svc = Object.keys(SERVICE_ACCOUNTS).find((k) => SERVICE_ACCOUNTS[k] === id);
    if (svc) e[svc] = r.typical;
    else if (/owner\s*admin/i.test(r.account)) e.ownerAdmin = { amount: r.typical, accountID: id, label: r.account };
    else if (/hoa/i.test(r.account) && hoaAddress.test(r.address || '')) e.hoa = { amount: r.lastAmount, accountID: id, label: r.account };   // HOA dues are the same amount every time
  }
  for (const k of Object.keys(out)) if (!Object.keys(out[k]).length) delete out[k];
  return out;
}
