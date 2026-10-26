// Read-only dummy-bill check for Move-outs (/api/moveouts/bills). Uses the same Rentvine payables report and the same
// matching rules as Matt's watcher (vendor 3338 dummies vs real bills on accounts 6070-1/6070-2, tolerance $50).
// It never voids or edits anything. Reduce / "bills exceed funds" are NOT shown here: they need Matt's saved original
// dummy amounts, so those stay in Matt's Slack posts.
const DUMMY_VENDOR_ID = '3338';
const REAL_ACCOUNTS = ['74', '75'];
const TOL = 50, STALE_DAYS = 30, TTL_MS = 10 * 60 * 1000;
// Real bills already reviewed by Persia (same list as Matt). Keep in step with matt-bill-watch.js.
const IGNORE_REAL_BILLS = new Set(['32810', '34256', '34255', '33404', '33742', '33703', '31984', '32068']);
const num = (v) => parseFloat(v || 0) || 0;
const sum = (a) => a.reduce((s, x) => s + x, 0);
const day = (d) => String(d || '').slice(0, 10);
const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / 86400000);

export function analyze(rows, keyFn, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const dummies = {}, others = {}, held = {};
  for (const x of rows || []) {
    const d = x && x.data; if (!d) continue;
    const acct = String(d.chargeAccountID);
    if (String(d.payeeContactID) === DUMMY_VENDOR_ID) {
      if (num(d.amountUnpaid) <= 0) continue;
      { const h = held[d.billID] = held[d.billID] || { billID: String(d.billID), prop: String(d.propertyID), address: d.propertyAddress || '', date: day(d.datePosted), desc: d.description || '', amount: 0 }; h.amount += num(d.amountUnpaid); }
      if (!REAL_ACCOUNTS.includes(acct)) continue;
      const b = dummies[d.billID] = dummies[d.billID] || { billID: String(d.billID), prop: String(d.propertyID), address: d.propertyAddress || '', owner: d.portfolioName || '', date: day(d.datePosted), desc: d.description || '', amount: 0, accts: new Set() };
      b.amount += num(d.amountUnpaid); b.accts.add(acct);
    } else {
      if (IGNORE_REAL_BILLS.has(String(d.billID))) continue;
      const b = others[d.billID] = others[d.billID] || { billID: String(d.billID), prop: String(d.propertyID), payee: d.contactName || '', date: day(d.datePosted), lines: [] };
      b.lines.push({ acct, amount: num(d.amount) });
    }
  }
  const watch = {};
  Object.values(dummies).forEach((d) => { (watch[d.prop] = watch[d.prop] || new Set()).add(d.billID); });
  const reals = [];
  for (const b of Object.values(others)) {
    if (!watch[b.prop]) continue;
    const use = b.lines.filter((l) => REAL_ACCOUNTS.includes(l.acct));
    if (!use.length) continue;
    reals.push({ billID: b.billID, prop: b.prop, payee: b.payee, date: b.date, amount: sum(use.map((l) => l.amount)) });
  }
  const byProp = {};
  Object.values(dummies).forEach((d) => (byProp[d.prop] = byProp[d.prop] || []).push(d));
  const findings = [];
  for (const [prop, ds] of Object.entries(byProp)) {
    const earliest = ds.map((d) => d.date).sort()[0];
    const minId = Math.min(...ds.map((d) => Number(d.billID)));
    const rb = reals.filter((b) => b.prop === prop && b.date >= earliest && Number(b.billID) > minId);
    if (!rb.length) continue;
    const R = sum(rb.map((b) => b.amount));
    const base = { key: keyFn(ds[0].address), prop, address: ds[0].address, owner: ds[0].owner, R,
      dummies: ds.map((d) => ({ id: d.billID, amount: d.amount, desc: d.desc })), reals: rb.map((b) => ({ id: b.billID, amount: b.amount, payee: b.payee, date: b.date })) };
    if (ds.length > 1) { findings.push({ ...base, type: 'multi' }); continue; }
    let best = null; const n = Math.min(ds.length, 8);
    for (let mask = 1; mask < (1 << n); mask++) {
      const sub = ds.slice(0, n).filter((_, i) => mask & (1 << i));
      if (sub.length > 4) continue;
      const diff = Math.abs(sum(sub.map((d) => d.amount)) - R);
      if (!best || diff < best.diff - 0.001 || (Math.abs(diff - best.diff) < 0.001 && sub.length < best.sub.length)) best = { sub, diff };
    }
    if (best && best.diff <= TOL) findings.push({ ...base, type: 'void', diff: best.diff, matched: best.sub.map((d) => d.billID) });
  }
  const flagged = new Set(findings.map((f) => f.prop));
  const sp = {};
  Object.values(held).filter((h) => h.date && daysBetween(h.date, today) > STALE_DAYS && !flagged.has(h.prop)).forEach((h) => (sp[h.prop] = sp[h.prop] || []).push(h));
  const stale = Object.values(sp).map((ds) => ({ key: keyFn(ds[0].address), address: ds[0].address, days: Math.max(...ds.map((d) => daysBetween(d.date, today))), dummies: ds.map((d) => ({ id: d.billID, amount: d.amount, desc: d.desc })) })).sort((a, b) => b.days - a.days);
  const rank = { void: 0, multi: 1 };
  findings.sort((a, b) => rank[a.type] - rank[b.type] || a.address.localeCompare(b.address));
  return { findings, stale };
}

const COLS = ['billID', 'propertyID', 'chargeAccountID', 'amount', 'amountUnpaid', 'description', 'contactName', 'datePosted'];
export function installMoveoutsBills(app, rvFetch, keyFn) {
  let cache = null, at = 0, inflight = null;
  async function build() {
    const json = JSON.stringify({ displayColumns: COLS, filters: [{ name: 'isVoided', comparator: 'booleanFalse' }], orderBys: [] });
    const b = await rvFetch('/reports/payables', { exportTypeID: 1, json });
    if (b && b.error) throw new Error(String(b.error).slice(0, 80));
    const rows = (b && b.rows) || (Array.isArray(b) ? b : (b && b.data) || []);
    if (!Array.isArray(rows)) throw new Error('Unexpected report shape');
    return { generatedAt: new Date().toISOString(), rowCount: rows.length, ...analyze(rows, keyFn) };
  }
  app.get('/api/moveouts/bills', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (cache && Date.now() - at < TTL_MS) return res.json(cache);
    try {
      if (!inflight) inflight = build().finally(() => { inflight = null; });
      cache = await inflight; at = Date.now(); res.json(cache);
    } catch (e) {
      console.error('[moveouts-bills]', e.message);
      if (cache) return res.json({ ...cache, stale: true });
      res.status(502).json({ error: 'Could not read bills from Rentvine.' });
    }
  });
}
