// Owner / property statements. Pure functions: rows in, statement out. No tenant names anywhere (addresses only).
const num = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
const truthy = (v) => v === true || /^(true|yes|1)$/i.test(String(v ?? ''));
const cents = (n) => Math.round(n * 100) / 100;
export const iso = (d) => {
  const s = String(d ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0') : '';
};
export const ymOf = (d) => iso(d).slice(0, 7);
export const addMonths = (ym, n) => { let y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + n; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12; return y + '-' + String(m + 1).padStart(2, '0'); };
export const monthRange = (ym) => ({ start: ym + '-01', end: addMonths(ym, 1) + '-01' });   // end is exclusive
const FEE_ACCOUNT = 93, TRUST = 129;
const median = (a) => { const s = a.slice().sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
const vendorKey = (b) => String(b.contactName || b.chargeAccountName || 'Other').trim();

// How many months back the data must reach: the 12-month trend plus 3 months for the "normal" test
export const LOOKBACK_MONTHS = 14;

// Group one property's bills by month and vendor
function indexBills(bills) {
  const idx = {};   // ym -> vendor -> { items:[], total }
  for (const b of bills) {
    if (truthy(b.isVoided)) continue;
    const ym = ymOf(b.datePosted); if (!ym) continue;
    const v = (idx[ym] ||= {})[vendorKey(b)] ||= { items: [], total: 0, tenantCharged: truthy(b.isSuppressed) };
    v.items.push({ date: iso(b.datePosted), account: b.chargeAccountName || '', desc: b.description || '', amount: cents(num(b.amount)), paid: truthy(b.isPaid), fee: num(b.chargeAccountID) === FEE_ACCOUNT, tenantCharged: truthy(b.isSuppressed) });
    v.total = cents(v.total + num(b.amount));
  }
  return idx;
}
const monthsAround = (ym) => Array.from({ length: 12 }, (_, i) => addMonths(ym, i - 11));

export function buildPropertyStatement({ propertyID, address }, bills, settle, ym, compareYm) {
  const mine = bills.filter((b) => String(b.propertyID) === String(propertyID));
  const mset = settle.filter((s) => String(s.propertyID) === String(propertyID) && (s.bankAccountID === undefined || s.bankAccountID === '' || num(s.bankAccountID) === TRUST));
  const idx = indexBills(mine);
  const received = {}, paidOut = {};
  for (const s of mset) { const m = ymOf(s.settlementDate || s.datePosted); if (!m) continue; const a = num(s.amount); if (a > 0) received[m] = cents((received[m] || 0) + a); else if (a < 0) paidOut[m] = cents((paidOut[m] || 0) + -a); }
  // first month with any activity in the loaded data (so a new home is not judged against months it did not exist)
  const active = [...new Set([...Object.keys(idx), ...Object.keys(received)])].sort();
  const first = active[0] || ym;
  const split = (m) => {
    const out = { fee: 0, expenses: 0, tenantCharged: 0, owner: [] };
    for (const [vendor, v] of Object.entries(idx[m] || {})) {
      const items = v.items.filter((i) => !i.fee && !i.tenantCharged), fee = v.items.filter((i) => i.fee);
      out.fee = cents(out.fee + fee.reduce((s, i) => s + i.amount, 0));
      out.tenantCharged = cents(out.tenantCharged + v.items.filter((i) => i.tenantCharged && !i.fee).reduce((s, i) => s + i.amount, 0));
      if (items.length) out.owner.push({ vendor, items, total: cents(items.reduce((s, i) => s + i.amount, 0)) });
    }
    out.expenses = cents(out.owner.reduce((s, g) => s + g.total, 0));
    return out;
  };
  const cur = split(ym), cmp = split(compareYm);
  // "normal" = the same vendor billed this home in each of the last 3 full months (fewer when the home is newer)
  const prior = [1, 2, 3].map((n) => addMonths(ym, -n)).filter((m) => m >= first);
  const vendorTotals = (vendor, m) => { const g = split(m).owner.find((x) => x.vendor === vendor); return g ? g.total : 0; };
  const splitCache = {}; const splitC = (m) => (splitCache[m] ||= split(m));
  const has = (vendor, m) => !!splitC(m).owner.find((x) => x.vendor === vendor);
  const tot = (vendor, m) => { const g = splitC(m).owner.find((x) => x.vendor === vendor); return g ? g.total : 0; };
  const flagFor = (vendor, total) => {
    if (!prior.length) return { flag: 'new', note: 'New home - not enough history to call this normal' };
    const normal = prior.every((m) => has(vendor, m));
    if (!normal) return { flag: 'extra', note: 'Not billed every month' };
    const typ = median(prior.map((m) => tot(vendor, m)));
    if (total > 0 && typ > 0 && Math.abs(total - typ) > 10 && Math.abs(total - typ) / typ > 0.25) return { flag: 'jump', note: 'Usually about $' + typ.toFixed(2) };
    return { flag: 'normal', note: '' };
  };
  const groups = cur.owner.map((g) => ({ ...g, compare: cmp.owner.find((x) => x.vendor === g.vendor)?.total || 0, ...flagFor(g.vendor, g.total) }));
  // vendors that bill this home every month but have not billed yet this month
  if (prior.length) {
    const pv = new Set(); prior.forEach((m) => splitC(m).owner.forEach((g) => pv.add(g.vendor)));
    for (const v of pv) if (!groups.some((g) => g.vendor === v) && prior.every((m) => has(v, m))) groups.push({ vendor: v, items: [], total: 0, compare: cmp.owner.find((x) => x.vendor === v)?.total || 0, flag: 'missing', note: 'Billed every month, not billed yet this month' });
  }
  groups.sort((a, b) => b.total - a.total || a.vendor.localeCompare(b.vendor));
  const rec = received[ym] || 0, cr = received[compareYm] || 0;
  const net = (r, s) => cents(r - s.expenses - s.fee);
  const series = monthsAround(ym).map((m) => { const s = splitC(m); return { month: m, received: received[m] || 0, expenses: s.expenses, fee: s.fee, net: net(received[m] || 0, s), paidOut: paidOut[m] || 0 }; });
  return {
    propertyID, address, month: ym, compareMonth: compareYm, newHome: !prior.length,
    received: rec, expenses: cur.expenses, fee: cur.fee, tenantCharged: cur.tenantCharged, net: net(rec, cur), paidOut: paidOut[ym] || 0,
    compare: { received: cr, expenses: cmp.expenses, fee: cmp.fee, net: net(cr, cmp), paidOut: paidOut[compareYm] || 0 },
    groups, series,
  };
}

export function resolveCompare(ym, compare) {
  if (/^\d{4}-\d{2}$/.test(String(compare))) return compare;
  return compare === 'year' ? addMonths(ym, -12) : addMonths(ym, -1);
}
export function buildStatement({ ownerName, properties, bills, settle, month, compare = 'prev' }) {
  const cm = resolveCompare(month, compare);
  const props = properties.map((p) => buildPropertyStatement(p, bills, settle, month, cm));
  const sum = (k) => cents(props.reduce((s, p) => s + p[k], 0));
  const csum = (k) => cents(props.reduce((s, p) => s + p.compare[k], 0));
  const series = monthsAround(month).map((m, i) => ({ month: m, received: cents(props.reduce((s, p) => s + p.series[i].received, 0)), expenses: cents(props.reduce((s, p) => s + p.series[i].expenses, 0)), fee: cents(props.reduce((s, p) => s + p.series[i].fee, 0)), net: cents(props.reduce((s, p) => s + p.series[i].net, 0)), paidOut: cents(props.reduce((s, p) => s + p.series[i].paidOut, 0)) }));
  return { ownerName, month, compareMonth: cm, properties: props, totals: { received: sum('received'), expenses: sum('expenses'), fee: sum('fee'), net: sum('net'), paidOut: sum('paidOut'), tenantCharged: sum('tenantCharged'), compare: { received: csum('received'), expenses: csum('expenses'), fee: csum('fee'), net: cents(props.reduce((s, p) => s + p.compare.net, 0)), paidOut: csum('paidOut') } }, series };
}
