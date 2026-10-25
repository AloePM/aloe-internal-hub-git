// Repair-items tracker for Move-outs. Stored in hub storage (GCS), one JSON file per Aptly card.
// Never writes to Aptly or Rentvine. Routes live under /api/moveouts so the API lock covers them.
import express from 'express';

const PAYERS = ['tbd', 'tenant', 'owner', 'aloe'];
const SOURCES = ['none', 'vendor', 'price-list', 'ai'];
const STATUSES = ['needed', 'asked', 'received', 'shared-tenant', 'shared-owner', 'done'];
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_ITEMS = 100;
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

export function cleanItems(raw) {
  if (!Array.isArray(raw)) throw new Error('items must be a list');
  if (raw.length > MAX_ITEMS) throw new Error('Too many items (max ' + MAX_ITEMS + ')');
  return raw.map((it, i) => {
    const o = it && typeof it === 'object' ? it : {};
    const description = str(o.description, 300);
    if (!description) throw new Error('Item ' + (i + 1) + ' needs a description');
    const payer = PAYERS.includes(o.payer) ? o.payer : 'tbd';
    const source = SOURCES.includes(o.source) ? o.source : 'none';
    const status = STATUSES.includes(o.status) ? o.status : 'needed';
    let amount = null;
    if (o.amount !== null && o.amount !== undefined && o.amount !== '') {
      amount = Number(o.amount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1000000) throw new Error('Item ' + (i + 1) + ' has an invalid amount');
      amount = Math.round(amount * 100) / 100;
    }
    return { description, area: str(o.area, 60), payer, source, vendor: str(o.vendor, 80), amount, status, note: str(o.note, 500) };
  });
}
export function totals(items) {
  const t = { tenant: 0, owner: 0, aloe: 0, tbd: 0, noAmount: 0, all: 0 };
  for (const it of items) { if (it.amount == null) { t.noAmount++; continue; } t[it.payer] += it.amount; t.all += it.amount; }
  for (const k of ['tenant', 'owner', 'aloe', 'tbd', 'all']) t[k] = Math.round(t[k] * 100) / 100;
  return t;
}

export function installMoveoutRepairs(app, storage, bucketName) {
  const bucket = () => storage.bucket(bucketName);
  const path = (id) => 'moveout-repairs/' + id + '.json';
  async function read(id) {
    const file = bucket().file(path(id));
    try {
      const [buf] = await file.download();
      const [meta] = await file.getMetadata();
      return { rec: JSON.parse(buf.toString('utf8')), gen: Number(meta.generation) };
    } catch (e) {
      if (e && (e.code === 404 || e.code === '404')) return { rec: null, gen: 0 };
      throw e;
    }
  }
  const fail = (res, e, what) => { console.error('[moveouts-repairs]', what, e && e.message); res.status(500).json({ error: 'Could not ' + what + '.' }); };

  app.get('/api/moveouts/repairs', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const [files] = await bucket().getFiles({ prefix: 'moveout-repairs/', maxResults: 500 });
      const out = {};
      await Promise.all(files.filter((f) => f.name.endsWith('.json')).map(async (f) => {
        try {
          const id = f.name.slice('moveout-repairs/'.length, -5);
          const [buf] = await f.download(); const r = JSON.parse(buf.toString('utf8'));
          out[id] = { count: (r.items || []).length, totals: totals(r.items || []), updatedAt: r.updatedAt, updatedBy: r.updatedBy };
        } catch (e) { /* skip an unreadable file */ }
      }));
      res.json({ summaries: out });
    } catch (e) { fail(res, e, 'read the repair summaries'); }
  });

  app.get('/api/moveouts/repairs/:id', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'Bad card id.' });
    try {
      const { rec } = await read(req.params.id);
      res.json(rec || { cardId: req.params.id, rev: 0, items: [], updatedAt: null, updatedBy: null, log: [] });
    } catch (e) { fail(res, e, 'read the repair items'); }
  });

  app.put('/api/moveouts/repairs/:id', express.json({ limit: '200kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = req.params.id;
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'Bad card id.' });
    const b = req.body || {};
    const by = str(b.editor, 40);
    if (!by) return res.status(400).json({ error: 'Enter your name in "Edited by" before saving.' });
    let items;
    try { items = cleanItems(b.items); } catch (e) { return res.status(400).json({ error: e.message }); }
    try {
      const { rec, gen } = await read(id);
      const rev = rec ? rec.rev : 0;
      if (Number(b.baseRev) !== rev) return res.status(409).json({ error: 'Someone else saved changes to this move-out. Reload to see them, then re-apply your edit.', rev });
      const now = new Date().toISOString();
      const log = ((rec && rec.log) || []).slice(-29).concat([{ rev: rev + 1, at: now, by, items: items.length, total: totals(items).all }]);
      const next = { cardId: id, rev: rev + 1, items, updatedAt: now, updatedBy: by, log };
      try {
        await bucket().file(path(id)).save(JSON.stringify(next), { contentType: 'application/json', preconditionOpts: { ifGenerationMatch: gen } });
      } catch (e) {
        if (e && (e.code === 412 || e.code === '412')) return res.status(409).json({ error: 'Someone else saved changes at the same moment. Reload and try again.', rev });
        throw e;
      }
      res.json(next);
    } catch (e) { fail(res, e, 'save the repair items'); }
  });
}
