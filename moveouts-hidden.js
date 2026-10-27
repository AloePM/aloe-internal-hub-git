// Closed leases that are not real move-outs (/api/moveouts/hidden). Read-only. Lets the To close out list skip leases where
// the tenant never moved in. Rule: no move-out date AND no expected move-out date, OR move-in date after the closed date.
// The hub otherwise falls back to the closed date as the move-out date, which wrongly lists these.
const TTL_MS = 10 * 60 * 1000;
const COLS = ['leaseID', 'unitAddress', 'moveInDate', 'moveOutDate', 'expectedMoveOutDate', 'closedDate'];
const t = (v) => (v == null ? '' : String(v).trim());
const ms = (v) => { const x = Date.parse(t(v)); return isNaN(x) ? null : x; };
export function classify(rows) {
  const out = [];
  for (const r of rows || []) {
    const d = (r && r.data) || r || {};
    if (!d.leaseID) continue;
    let reason = '';
    if (!t(d.moveOutDate) && !t(d.expectedMoveOutDate)) reason = 'no move-out date';
    else { const mi = ms(d.moveInDate), cl = ms(d.closedDate); if (mi != null && cl != null && mi > cl) reason = 'closed before move-in'; }
    if (reason) out.push({ leaseID: String(d.leaseID), address: t(d.unitAddress), reason });
  }
  return out;
}
export function installMoveoutsHidden(app, rvFetch) {
  let cache = null, at = 0, inflight = null;
  async function build() {
    const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const json = JSON.stringify({ displayColumns: COLS, filters: [{ name: 'closedDate', comparator: 'betweenDate', startDate: day(130), endDate: day(-1) }] });
    const b = await rvFetch('/reports/lease', { exportTypeID: 1, json });
    if (b && b.error) throw new Error(String(b.error).slice(0, 80));
    const rows = (b && b.rows) || (Array.isArray(b) ? b : (b && b.data) || []);
    if (!Array.isArray(rows)) throw new Error('Unexpected report shape');
    return { generatedAt: new Date().toISOString(), leases: classify(rows) };
  }
  app.get('/api/moveouts/hidden', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (cache && Date.now() - at < TTL_MS) return res.json(cache);
    try {
      if (!inflight) inflight = build().finally(() => { inflight = null; });
      cache = await inflight; at = Date.now();
      res.json(cache);
    } catch (e) {
      console.error('[moveouts-hidden]', e.message);
      if (cache) return res.json({ ...cache, stale: true });
      res.status(502).json({ error: 'Could not read leases from Rentvine.' });
    }
  });
}
