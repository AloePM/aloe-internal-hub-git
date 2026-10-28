// Owner email drafts + "owner ending management" tags for Move-outs. Read-only: never writes to Aptly or Rentvine.
//  GET /api/moveouts/ending            -> homes on the Aptly "PM Agreement Update" board with End management checked or stage "Ending"
//  GET /api/moveouts/owner-notes/:id   -> the Tenant / Owner lists from one Move-Outs card's "Move-Out Notes" table, plus any Zinspector share link
const MOVEOUTS = 'YA3QWmPebvMwLwbB3';
const PMA = 'kfyX2CWx67FwYkKkB';
const API = (process.env.APTLY_API_BASE || 'https://core-api.getaptly.com').replace(/\/+$/, '');
const TTL_MS = 10 * 60 * 1000;
const token = () => process.env.APTLY_UNITS_TOKEN || process.env.APTLY_TOKEN || '';
async function call(path) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(API + path, { headers: { 'x-token': token(), accept: 'application/json' }, signal: ctl.signal });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ }
    return { ok: r.ok, status: r.status, json: j };
  } finally { clearTimeout(to); }
}
const rows = (j) => (Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : []);
const decode = (s) => String(s == null ? '' : s).replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const cellText = (h) => decode(String(h).replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]*>/g, '')).split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
// "Move-Out Notes" is a two-column table: TENANT | OWNER. The two columns are independent lists (rows do not pair up).
export function parseNotes(html) {
  const out = { tenant: [], owner: [] };
  const trs = String(html || '').match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trs) {
    const cells = (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(cellText);
    if (cells.length < 2) continue;
    if (/^tenant$/i.test(cells[0]) && /^owner$/i.test(cells[1])) continue;
    if (cells[0]) out.tenant.push(cells[0]);
    if (cells[1]) out.owner.push(cells[1]);
  }
  return out;
}
export function findPhotosLink(texts) {
  const re = /https:\/\/dashboard\.zinspector\.com\/report\/share\/[A-Za-z0-9_-]+/;
  let found = '';
  for (const t of texts || []) { const m = re.exec(String(t || '')); if (m) found = m[0]; } // last one wins (newest)
  return found;
}
const asText = (v) => { if (v == null) return ''; if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(', '); if (typeof v === 'object') return String(v.label || v.name || v.value || ''); return String(v); };
const isoDay = (v) => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d.toISOString().slice(0, 10) : null; };
export function endingFromCards(schema, cards, addrKey) {
  const key = {};
  for (const f of schema || []) if (f && f.label && f.key && !(f.label in key)) key[f.label] = f.key;
  const out = [];
  for (const c of cards || []) {
    const flag = key['End management'] ? c[key['End management']] : undefined;
    const ending = flag === true || flag === 'true' || /^ending$/i.test(String(c.stage || '').trim());
    if (!ending) continue;
    const bld = key['Buildings'] ? c[key['Buildings']] : null;
    const cand = [key['Street Address only'] && c[key['Street Address only']], key['Full Address'] && c[key['Full Address']], Array.isArray(bld) && bld[0] && bld[0].name, c.name];
    let ak = '';
    for (const x of cand) { ak = addrKey(asText(x)); if (ak) break; }
    if (!ak) continue;
    out.push({ addrKey: ak, endDate: isoDay(key['Management End Date'] ? c[key['Management End Date']] : null), stage: String(c.stage || '') });
  }
  return out;
}

export function installMoveoutsOwner(app, addrKey) {
  let cache = null, at = 0, inflight = null;
  async function build() {
    const s = await call('/api/schema/' + PMA);
    if (!s.ok) throw new Error('Aptly answered ' + s.status);
    const schema = rows(s.json);
    const cards = [];
    for (let page = 0; page < 20; page++) {
      const r = await call('/api/board/' + PMA + '?page=' + page + '&pageSize=100&includeArchived=false');
      if (!r.ok) throw new Error('Aptly answered ' + r.status);
      const rs = rows(r.json); cards.push(...rs);
      if (rs.length < 100 || (r.json && r.json.count != null && cards.length >= r.json.count)) break;
    }
    return { generatedAt: new Date().toISOString(), homes: endingFromCards(schema, cards.filter((c) => !c.archived), addrKey) };
  }
  app.get('/api/moveouts/ending', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!token()) return res.status(503).json({ error: 'The Aptly connection is not set up on the hub.' });
    if (cache && Date.now() - at < TTL_MS) return res.json(cache);
    try {
      if (!inflight) inflight = build().finally(() => { inflight = null; });
      cache = await inflight; at = Date.now();
      res.json(cache);
    } catch (e) {
      console.error('[moveouts-owner] ending list:', e.message);
      if (cache) return res.json({ ...cache, stale: true });
      res.status(502).json({ error: 'Could not read the PM Agreement Update board from Aptly.' });
    }
  });
  let notesKey = null;
  app.get('/api/moveouts/owner-notes/:id', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = String(req.params.id || '');
    if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return res.status(400).json({ error: 'Bad card id.' });
    if (!token()) return res.status(503).json({ error: 'The Aptly connection is not set up on the hub.' });
    try {
      if (!notesKey) {
        const s = await call('/api/schema/' + MOVEOUTS);
        const f = rows(s.json).find((x) => x && x.label === 'Move-Out Notes');
        notesKey = (f && f.key) || 'description';
      }
      const r = await call('/api/board/' + MOVEOUTS + '/' + encodeURIComponent(id));
      const c = r.ok && r.json ? (r.json.data || r.json) : null;
      if (!c) return res.status(r.status === 404 ? 404 : 502).json({ error: 'Could not read that card from Aptly (answered ' + r.status + ').' });
      const html = c[notesKey] != null ? c[notesKey] : c.description;
      const comments = Array.isArray(c.comments) ? c.comments.map((x) => x && x.content) : [];
      res.json({ ...parseNotes(html), photos: findPhotosLink([html, ...comments]) });
    } catch (e) {
      console.error('[moveouts-owner] notes:', e.message);
      res.status(502).json({ error: 'Could not reach Aptly (' + e.message + ').' });
    }
  });
}
