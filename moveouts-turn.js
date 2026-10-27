// Ready by dates for Move-outs. Stored in hub storage (GCS), one JSON file per move-out. Never writes to Aptly or Rentvine.
// Also reads upcoming move-ins (Rentvine leases in Pending status) so the page can warn when Ready by is after Move-in.
// Routes live under /api/moveouts so the API lock covers them.
import express from 'express';

const BUCKET = 'aloe-hub-data-496300';
const SETTINGS = { showFromDays: 3, readyDays: 14 }; // Show from = move-out + 3 days. Ready by estimate = move-out + 14 days.
const ID_RE = /^[a-z0-9_-]{3,70}$/;
const TTL_MS = 10 * 60 * 1000;
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

export function isoOf(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(s);
  if (!m || !MONTHS[m[1].toLowerCase()]) return '';
  return m[3] + '-' + String(MONTHS[m[1].toLowerCase()]).padStart(2, '0') + '-' + String(+m[2]).padStart(2, '0');
}
export function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T12:00:00Z');
  if (isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) return false;
  const y = +s.slice(0, 4);
  return y >= 2024 && y <= 2035;
}
// Pending leases -> { addrKey: [{ leaseID, moveIn }] } sorted by move-in date. No tenant names are kept.
export function groupMoveins(rows, addrKey) {
  const out = {};
  for (const r of rows || []) {
    const d = (r && r.data) || r || {};
    const k = addrKey(d.unitAddress || '');
    const mi = isoOf(d.moveInDate);
    if (!k || !mi || d.leaseID == null) continue;
    (out[k] = out[k] || []).push({ leaseID: String(d.leaseID), moveIn: mi });
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.moveIn.localeCompare(b.moveIn));
  return out;
}

export function installMoveoutTurn(app, rvFetch, addrKey, storageArg) {
  let storage = storageArg || null;
  const bucket = async () => {
    if (!storage) { const { Storage } = await import('@google-cloud/storage'); storage = new Storage(); }
    return storage.bucket(BUCKET);
  };
  const path = (id) => 'moveout-turn/' + id + '.json';
  async function read(id) {
    const file = (await bucket()).file(path(id));
    try {
      const [buf] = await file.download();
      const [meta] = await file.getMetadata();
      return { rec: JSON.parse(buf.toString('utf8')), gen: Number(meta.generation) };
    } catch (e) {
      if (e && (e.code === 404 || e.code === '404')) return { rec: null, gen: 0 };
      throw e;
    }
  }
  const fail = (res, e, what) => { console.error('[moveouts-turn]', what, e && e.message); res.status(500).json({ error: 'Could not ' + what + '.' }); };

  let miCache = null, miAt = 0, miInflight = null;
  async function buildMoveins() {
    const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const json = JSON.stringify({
      displayColumns: ['leaseID', 'unitAddress', 'moveInDate', 'leaseStatusID'],
      filters: [{ name: 'leaseStatusID', comparator: 'equals', value: '1' }, { name: 'moveInDate', comparator: 'onOrAfterDateRange', startDate: day(60) }],
    });
    const b = await rvFetch('/reports/lease', { exportTypeID: 1, json });
    if (b && b.error) throw new Error(String(b.error).slice(0, 80));
    const rows = (b && b.rows) || (Array.isArray(b) ? b : (b && b.data) || []);
    if (!Array.isArray(rows)) throw new Error('Unexpected report shape');
    return groupMoveins(rows, addrKey);
  }
  async function getMoveins() {
    if (miCache && Date.now() - miAt < TTL_MS) return { moveins: miCache, ok: true };
    try {
      if (!miInflight) miInflight = buildMoveins().finally(() => { miInflight = null; });
      miCache = await miInflight; miAt = Date.now();
      return { moveins: miCache, ok: true };
    } catch (e) {
      console.error('[moveouts-turn] move-ins unavailable:', e.message);
      return { moveins: miCache || {}, ok: false };
    }
  }

  app.get('/api/moveouts/turn', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const ready = {};
      const [files] = await (await bucket()).getFiles({ prefix: 'moveout-turn/', maxResults: 1000 });
      await Promise.all(files.filter((f) => f.name.endsWith('.json')).map(async (f) => {
        try {
          const id = f.name.slice('moveout-turn/'.length, -5);
          const [buf] = await f.download(); const r = JSON.parse(buf.toString('utf8'));
          ready[id] = { readyBy: r.readyBy || null, reason: r.reason || '', by: r.updatedBy || '', at: r.updatedAt || '', rev: r.rev || 0 };
        } catch (e) { /* skip an unreadable file */ }
      }));
      const mi = await getMoveins();
      res.json({ settings: SETTINGS, ready, moveins: mi.moveins, moveinsChecked: mi.ok });
    } catch (e) { fail(res, e, 'read the Ready by dates'); }
  });

  app.get('/api/moveouts/turn/:id', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Bad id.' });
    try {
      const { rec } = await read(req.params.id);
      res.json(rec || { id: req.params.id, rev: 0, readyBy: null, reason: '', updatedAt: null, updatedBy: null, log: [] });
    } catch (e) { fail(res, e, 'read the Ready by history'); }
  });

  app.put('/api/moveouts/turn/:id', express.json({ limit: '10kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = req.params.id;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'Bad id.' });
    const b = req.body || {};
    const by = str(b.editor, 40);
    if (!by) return res.status(400).json({ error: 'Enter your name before saving.' });
    const reason = str(b.reason, 200);
    if (reason.length < 3) return res.status(400).json({ error: 'Add a short reason so the history makes sense.' });
    const readyBy = b.readyBy === '' || b.readyBy == null ? null : String(b.readyBy);
    if (readyBy !== null && !validDate(readyBy)) return res.status(400).json({ error: 'Pick a valid Ready by date.' });
    try {
      const { rec, gen } = await read(id);
      const rev = rec ? rec.rev : 0;
      if (Number(b.baseRev) !== rev) return res.status(409).json({ error: 'Someone else changed this Ready by date. Reload to see it, then try again.', rev });
      const now = new Date().toISOString();
      const log = ((rec && rec.log) || []).slice(-49).concat([{ rev: rev + 1, at: now, by, readyBy, reason }]);
      const next = { id, rev: rev + 1, readyBy, reason, updatedAt: now, updatedBy: by, log };
      try {
        await (await bucket()).file(path(id)).save(JSON.stringify(next), { contentType: 'application/json', preconditionOpts: { ifGenerationMatch: gen } });
      } catch (e) {
        if (e && (e.code === 412 || e.code === '412')) return res.status(409).json({ error: 'Someone else saved at the same moment. Reload and try again.', rev });
        throw e;
      }
      res.json(next);
    } catch (e) { fail(res, e, 'save the Ready by date'); }
  });
}
