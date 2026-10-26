// Comprehensive Inspection Yes/No for Move-Outs (POST /api/moveouts/comprehensive).
// The ONLY thing the hub writes to Aptly here: one single-select field on one Move-Outs card, plus one audit comment.
// Safety: Yes/No only; the card is read first (must exist on the Move-Outs board); the value is read back after saving
// and only reported as saved if it matches; the comment is posted only after a verified save; dryRun sends nothing.
import express from 'express';
const BOARD = 'YA3QWmPebvMwLwbB3';
const API = (process.env.APTLY_API_BASE || 'https://core-api.getaptly.com').replace(/\/+$/, '');
const FIELD_LABEL = 'Comprehensive Inspection';
const COMMENT_USER_ID = 'op8mkGcfjAoka2GJS'; // Aptly user shown as author of the audit comment (Randi). Change when hub logins are per person.
const token = () => process.env.APTLY_UNITS_TOKEN || process.env.APTLY_TOKEN || '';
const hdr = () => ({ 'x-token': token(), accept: 'application/json', 'content-type': 'application/json' });
const asText = (v) => { if (v == null) return ''; if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(', '); if (typeof v === 'object') return String(v.label || v.name || v.value || ''); return String(v); };

async function call(method, path, body) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(API + path, { method, headers: hdr(), body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ }
    return { ok: r.ok, status: r.status, json: j };
  } finally { clearTimeout(to); }
}

export function installMoveoutsComprehensive(app) {
  let fieldKey = null;
  async function getFieldKey() {
    if (fieldKey) return fieldKey;
    const r = await call('GET', '/api/schema/' + BOARD);
    const arr = Array.isArray(r.json) ? r.json : r.json && Array.isArray(r.json.data) ? r.json.data : [];
    const f = arr.find((x) => x && x.label === FIELD_LABEL);
    if (f && f.key) fieldKey = f.key;
    return fieldKey;
  }
  const readCard = async (id, key) => {
    const r = await call('GET', '/api/board/' + BOARD + '/' + encodeURIComponent(id));
    const c = r.ok && r.json ? (r.json.data || r.json) : null;
    return r.ok && c ? { ok: true, value: asText(c[key]), name: asText(c.name) } : { ok: false, status: r.status };
  };

  app.post('/api/moveouts/comprehensive', express.json({ limit: '10kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    // Custom header forces a browser preflight, so another website cannot trigger this from a logged-in browser.
    if (req.get('x-hub-write') !== '1') return res.status(400).json({ error: 'Missing request header.' });
    if (!token()) return res.status(503).json({ error: 'The Aptly connection is not set up on the hub.' });
    const b = req.body || {};
    const id = String(b.aptlyId || '');
    const value = b.value === 'Yes' || b.value === 'No' ? b.value : null;
    if (!/^[A-Za-z0-9]{10,40}$/.test(id) || !value) return res.status(400).json({ error: 'Need a card and a value of Yes or No.' });
    try {
      const key = await getFieldKey();
      if (!key) return res.status(502).json({ error: 'Could not find the Comprehensive Inspection field on the board.' });
      const before = await readCard(id, key);
      if (!before.ok) return res.status(404).json({ error: 'That card was not found on the Move-Outs board (Aptly answered ' + before.status + ').' });
      if (before.value === value) return res.json({ ok: true, unchanged: true, value, previous: before.value });
      if (b.dryRun) return res.json({ ok: true, dryRun: true, wouldSend: { _id: id, field: key, value }, previous: before.value });
      const w = await call('POST', '/api/board/' + BOARD, { _id: id, [key]: value });
      if (!w.ok) { console.error('[moveouts-comprehensive] write failed', w.status); return res.status(502).json({ error: 'Aptly refused the change (answered ' + w.status + '). Nothing was changed.' }); }
      const after = await readCard(id, key);
      if (!after.ok) return res.status(502).json({ error: 'Sent to Aptly but could not read it back. Please check the card in Aptly.', previous: before.value });
      if (after.value !== value) return res.status(502).json({ error: 'Aptly did not keep the change (card shows "' + (after.value || 'blank') + '"). Please check the card in Aptly.', previous: before.value });
      if (app.locals.moveoutsPipelineBust) app.locals.moveoutsPipelineBust();
      let commented = false;
      try {
        const text = 'Comprehensive Inspection changed from ' + (before.value || 'blank') + ' to ' + value + ' via Hub.';
        const cr = await call('POST', '/api/board/' + BOARD + '/' + encodeURIComponent(id) + '/comment', { userId: COMMENT_USER_ID, content: text });
        commented = cr.ok;
        if (!cr.ok) console.error('[moveouts-comprehensive] comment failed', cr.status);
      } catch (e) { console.error('[moveouts-comprehensive] comment error', e.message); }
      console.log('[moveouts-comprehensive] card', id, (before.value || 'blank') + ' -> ' + value, 'comment', commented);
      res.json({ ok: true, value, previous: before.value, commented });
    } catch (e) {
      console.error('[moveouts-comprehensive]', e.message);
      res.status(502).json({ error: 'Could not reach Aptly (' + e.message + '). Nothing was changed.' });
    }
  });
}
