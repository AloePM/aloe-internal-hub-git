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
    v.items.push({ billID: b.billID ?? '', date: iso(b.datePosted), account: b.chargeAccountName || '', desc: b.description || '', amount: cents(num(b.amount)), paid: truthy(b.isPaid), fee: num(b.chargeAccountID) === FEE_ACCOUNT, tenantCharged: truthy(b.isSuppressed) });
    v.total = cents(v.total + num(b.amount));
  }
  return idx;
}
const monthsAround = (ym) => Array.from({ length: 12 }, (_, i) => addMonths(ym, i - 11));

export function buildPropertyStatement({ propertyID, address }, bills, settle, ym, compareYm, otherRows = [], paidRows = [], paidBefore = '') {
  const mine = bills.filter((b) => String(b.propertyID) === String(propertyID));
  const mset = settle.filter((s) => String(s.propertyID) === String(propertyID) && (s.bankAccountID === undefined || s.bankAccountID === '' || num(s.bankAccountID) === TRUST));
  const idx = indexBills(mine);
  const received = {}, paidOut = {};
  for (const s of mset) { const m = ymOf(s.settlementDate || s.datePosted); if (!m) continue; const a = num(s.amount); if (a > 0) received[m] = cents((received[m] || 0) + a); else if (a < 0) paidOut[m] = cents((paidOut[m] || 0) + -a); }
  // tenant payments toward charges that are not owner money (admin fees, resident benefit package, ...): settled with the rent but not the owner's
  const other = {};
  for (const r of otherRows) { if (String(r.propertyID) !== String(propertyID)) continue; const m = ymOf(r.datePosted); if (m) other[m] = cents((other[m] || 0) + num(r.amount)); }
  for (const m of Object.keys(received)) { const o = Math.min(other[m] || 0, received[m]); other[m] = o; received[m] = cents(received[m] - o); }
  // A past month where Rentvine's settlement report shows nothing (for example a previous tenant's closed lease) but the tenant did pay rent:
  // use the rent paid on the rent charges for that month, so earlier tenants' rent is not shown as $0.
  const paidM = {}, fromPayments = [];
  for (const r of paidRows) { if (String(r.propertyID) !== String(propertyID)) continue; const m = ymOf(r.datePosted); if (m) paidM[m] = cents((paidM[m] || 0) + num(r.amount)); }
  for (const m of Object.keys(paidM).sort()) if (paidM[m] > 0 && !received[m] && (!paidBefore || m < paidBefore)) { received[m] = paidM[m]; fromPayments.push(m); }
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
  const series = monthsAround(ym).map((m) => { const s = splitC(m); return { month: m, received: received[m] || 0, other: other[m] || 0, expenses: s.expenses, fee: s.fee, net: net(received[m] || 0, s), paidOut: paidOut[m] || 0 }; });
  return {
    propertyID, address, month: ym, compareMonth: compareYm, newHome: !prior.length,
    received: rec, other: other[ym] || 0, expenses: cur.expenses, fee: cur.fee, tenantCharged: cur.tenantCharged, net: net(rec, cur), paidOut: paidOut[ym] || 0,
    compare: { received: cr, other: other[compareYm] || 0, expenses: cmp.expenses, fee: cmp.fee, net: net(cr, cmp), paidOut: paidOut[compareYm] || 0 },
    groups, series, receivedFromPayments: fromPayments,
  };
}

export function resolveCompare(ym, compare) {
  if (/^\d{4}-\d{2}$/.test(String(compare))) return compare;
  return compare === 'year' ? addMonths(ym, -12) : addMonths(ym, -1);
}
export function buildStatement({ ownerName, properties, bills, settle, month, compare = 'prev', otherRows = [], paidRows = [], paidBefore = '' }) {
  const cm = resolveCompare(month, compare);
  const props = properties.map((p) => buildPropertyStatement(p, bills, settle, month, cm, otherRows, paidRows, paidBefore));
  const sum = (k) => cents(props.reduce((s, p) => s + p[k], 0));
  const csum = (k) => cents(props.reduce((s, p) => s + p.compare[k], 0));
  const series = monthsAround(month).map((m, i) => ({ month: m, received: cents(props.reduce((s, p) => s + p.series[i].received, 0)), expenses: cents(props.reduce((s, p) => s + p.series[i].expenses, 0)), fee: cents(props.reduce((s, p) => s + p.series[i].fee, 0)), net: cents(props.reduce((s, p) => s + p.series[i].net, 0)), paidOut: cents(props.reduce((s, p) => s + p.series[i].paidOut, 0)) }));
  const out = { ownerName, month, compareMonth: cm, properties: props, totals: { received: sum('received'), other: sum('other'), expenses: sum('expenses'), fee: sum('fee'), net: sum('net'), paidOut: sum('paidOut'), tenantCharged: sum('tenantCharged'), compare: { received: csum('received'), other: csum('other'), expenses: csum('expenses'), fee: csum('fee'), net: cents(props.reduce((s, p) => s + p.compare.net, 0)), paidOut: csum('paidOut') } }, series };
  return { ...out, ...explain(out) };
}

// ---- plain-language explanation, written from the numbers (no AI, so nothing is invented) ----
const MN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (ym) => MN[Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(0, 4);
const $ = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const upDown = (d) => (d >= 0 ? $(d) + ' higher' : $(-d) + ' lower');
export function explain(st) {
  const t = st.totals, c = t.compare, M = monthName(st.month), C = monthName(st.compareMonth);
  const scope = st.properties.length > 1 ? 'across your ' + st.properties.length + ' homes' : 'for this home';
  // vendors across homes
  const byV = {};
  for (const p of st.properties) for (const g of p.groups) { const v = (byV[g.vendor] ||= { vendor: g.vendor, total: 0, compare: 0, flags: new Set() }); v.total = cents(v.total + g.total); v.compare = cents(v.compare + g.compare); v.flags.add(g.flag); }
  const vendors = Object.values(byV);
  const oneTime = vendors.filter((v) => v.total > 0 && v.flags.has('extra') && !v.flags.has('jump') && !v.flags.has('normal'));
  const changed = vendors.filter((v) => v.flags.has('jump'));
  const missing = vendors.filter((v) => v.total === 0 && v.flags.has('missing'));
  const nothingYet = t.received === 0 && t.expenses === 0 && t.fee === 0;
  let text = nothingYet ? 'Nothing has been posted yet for ' + M + ' ' + scope + '.' : 'In ' + M + ' ' + scope + ', ' + (t.received > 0 ? $(t.received) + ' of rent was received' : 'no money has settled yet') + ', with ' + $(t.expenses) + ' in expenses and ' + $(t.fee) + ' in management fee, for a net of ' + $(t.net) + '.';
  if (!nothingYet) text += ' That is ' + upDown(cents(t.net - c.net)) + ' than ' + C + '.';
  const lst = (a) => a.slice(0, 3).map((v) => v.vendor + ' ' + $(v.total)).join(', ') + (a.length > 3 ? ' and ' + (a.length - 3) + ' more' : '');
  if (oneTime.length) text += ' One-time bills this month: ' + lst(oneTime) + '.';
  if (changed.length) text += ' Regular bills that changed amount: ' + changed.slice(0, 3).map((v) => v.vendor + ' (' + $(v.total) + ', was ' + $(v.compare) + ')').join(', ') + '.';
  if (missing.length) text += ' Regular bills not posted yet: ' + missing.slice(0, 3).map((v) => v.vendor).join(', ') + '.';
  // question answers
  const dR = cents(t.received - c.received), dE = cents(t.expenses - c.expenses), dF = cents(t.fee - c.fee);
  const parts = [];
  if (dR !== 0) parts.push('money received is ' + upDown(dR) + ' (' + $(t.received) + ' vs ' + $(c.received) + ')');
  if (dE !== 0) { const big = vendors.map((v) => ({ v, d: cents(v.total - v.compare) })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0]; parts.push('expenses are ' + upDown(dE) + (big && big.d !== 0 ? ', mostly ' + big.v.vendor + ' (' + (big.d > 0 ? '+' : '-') + $(Math.abs(big.d)) + ')' : '')); }
  if (dF !== 0) parts.push('the management fee is ' + upDown(dF));
  const dN = cents(t.net - c.net);
  const why = dN === 0 && !parts.length ? 'The net is the same as ' + C + '.' : 'The net is ' + upDown(dN) + ' than ' + C + ' because ' + (parts.length ? parts.join('; ') : 'of timing') + '.' + (t.received === 0 ? ' No rent has settled yet this month, which usually explains a low net early in the month.' : '');
  const unusual = [oneTime.length ? 'One-time bills: ' + lst(oneTime) + '.' : '', changed.length ? 'Amount changed: ' + changed.slice(0, 3).map((v) => v.vendor + ' ' + $(v.total) + ' (usually about ' + $(v.compare) + ')').join(', ') + '.' : '', missing.length ? 'Regular bills not posted yet: ' + missing.slice(0, 3).map((v) => v.vendor).join(', ') + '.' : ''].filter(Boolean).join(' ') || 'Nothing unusual. Every bill this month is from a vendor that bills this home regularly.';
  const top = vendors.filter((v) => v.total > 0).sort((a, b) => b.total - a.total)[0];
  const biggest = top ? 'The biggest expense was ' + top.vendor + ' at ' + $(top.total) + (top.compare ? ' (' + $(top.compare) + ' in ' + C + ')' : ' (nothing from them in ' + C + ')') + '.' : 'There are no expenses this month.';
  return { explained: text, qa: [{ q: 'Why is the net different from ' + C + '?', a: why }, { q: 'Is anything unusual this month?', a: unusual }, { q: 'What was the biggest expense?', a: biggest }] };
}
