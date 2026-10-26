// Walk-date comment for Move-Outs (POST /api/moveouts/walk-comment).
// Adds ONE comment to ONE Move-Outs card saying a walk date from John's sheet. Nothing else on the card is changed.
// Safety: reads the card's comments first (also proves the card exists on the Move-Outs board), skips if the same
// date is already there, asks for confirmation (409) if a different date was posted before, verifies after posting.
import express from 'express';
const BOARD = 'YA3QWmPebvMwLwbB3';
const API = (process.env.APTLY_API_BASE || 'https://core-api.getaptly.com').replace(/\/+$/, '');
const COMMENT_USER_ID = 'op8mkGcfjAoka2GJS'; // Aptly user shown as author (Randi). Change when hub logins are per person.
const token = () => process.env.APTLY_UNITS_TOKEN || process.env.APTLY_TOKEN || '';
const KINDS = { pre: 'Pre move-out', out: 'Move-out' };
const mdy = (iso) => { const p = iso.split('-'); return +p[1] + '/' + +p[2] + '/' + p[0]; };
const toIso = (m, d, y) => y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
const RE = /^(Pre move-out|Move-out) walk (?:scheduled|date changed to) (\d{1,2})\/(\d{1,2})\/(\d{4})/;

async function call(method, path, body) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(API + path, { method, headers: { 'x-token': token(), accept: 'application/json', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ }
    return { ok: r.ok, status: r.status, json: j };
  } finally { clearTimeout(to); }
}
export function latestHubWalk(comments, kindLabel) {
  let found = null;
  for (const c of comments) { const m = RE.exec(String((c && c.content) || '').trim()); if (m && m[1] === kindLabel) found = toIso(m[2], m[3], m[4]); }
  return found;
}
export function installMoveoutsWalkComment(app) {
  const list = async (id) => {
    const r = await call('GET', '/api/board/' + BOARD + '/' + encodeURIComponent(id) + '/comments');
    const arr = r.json && Array.isArray(r.json.data) ? r.json.data : Array.isArray(r.json) ? r.json : null;
    return r.ok && arr ? { ok: true, arr } : { ok: false, status: r.status };
  };
  app.post('/api/moveouts/walk-comment', express.json({ limit: '10kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.get('x-hub-write') !== '1') return res.status(400).json({ error: 'Missing request header.' });
    if (!token()) return res.status(503).json({ error: 'The Aptly connection is not set up on the hub.' });
    const b = req.body || {};
    const id = String(b.aptlyId || ''), kind = KINDS[b.kind], date = String(b.date || '');
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!/^[A-Za-z0-9]{10,40}$/.test(id) || !kind || !dm || +dm[2] < 1 || +dm[2] > 12 || +dm[3] < 1 || +dm[3] > 31 || +dm[1] < 2020 || +dm[1] > 2100)
      return res.status(400).json({ error: 'Need a card, a walk type (pre or out) and a date.' });
    try {
      const before = await list(id);
      if (!before.ok) return res.status(404).json({ error: 'Could not read that card on the Move-Outs board (Aptly answered ' + before.status + '). Nothing was added.' });
      const prev = latestHubWalk(before.arr, kind);
      if (prev === date) return res.json({ ok: true, unchanged: true });
      if (prev && !b.force) return res.status(409).json({ differs: true, cardDate: prev, error: 'The card already has a ' + kind.toLowerCase() + ' walk comment for ' + mdy(prev) + '.' });
      const text = prev
        ? kind + ' walk date changed to ' + mdy(date) + ' (was ' + mdy(prev) + ', from John’s walk sheet) via Hub.'
        : kind + ' walk scheduled ' + mdy(date) + ' (from John’s walk sheet) via Hub.';
      if (b.dryRun) return res.json({ ok: true, dryRun: true, wouldPost: text });
      const w = await call('POST', '/api/board/' + BOARD + '/' + encodeURIComponent(id) + '/comment', { userId: COMMENT_USER_ID, content: text });
      if (!w.ok) { console.error('[moveouts-walkcomment] post failed', w.status); return res.status(502).json({ error: 'Aptly refused the comment (answered ' + w.status + '). Nothing was added.' }); }
      const after = await list(id);
      if (!after.ok || latestHubWalk(after.arr, kind) !== date) return res.status(502).json({ error: 'Sent to Aptly but could not confirm it. Please check the card in Aptly before trying again.' });
      console.log('[moveouts-walkcomment] card', id, kind, date, prev ? 'update' : 'new');
      res.json({ ok: true, posted: text });
    } catch (e) {
      console.error('[moveouts-walkcomment]', e.message);
      res.status(502).json({ error: 'Could not reach Aptly (' + e.message + '). Nothing was added.' });
    }
  });
}
