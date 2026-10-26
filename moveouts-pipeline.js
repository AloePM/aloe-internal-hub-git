// Read-only Move-Outs pipeline feed for the hub (/api/moveouts/pipeline).
// Reads the Aptly Move-Outs board. Never writes to Aptly. Cached 5 minutes.
import { addrKey } from './moveouts-property.js';
import { installMoveoutsComprehensive } from './moveouts-comprehensive.js';
const BOARD = 'YA3QWmPebvMwLwbB3';
const API = (process.env.APTLY_API_BASE || 'https://core-api.getaptly.com').replace(/\/+$/, '');
const TTL_MS = 5 * 60 * 1000;
const MIN_FORCE_MS = 30 * 1000;
const TURN_STAGES = ['Disposition sent- Repairs still in progress', 'Complete Repairs and Bills'];
const STAGE_ORDER = ['Upcoming Move-Out', '14 Days Out', '5 Days Out', 'Move-Out Day', 'Walkthrough Scheduled/ Not Completed yet',
  'Complete Repairs and Bills', 'Disposition sent- Repairs still in progress', 'Process Move-Out + Security Deposit',
  'ON HOLD/ PENDING OWNER COMPLETION', 'Complete'];
const EARLY = new Set(['Upcoming Move-Out', '14 Days Out', '5 Days Out']);

const token = () => process.env.APTLY_UNITS_TOKEN || process.env.APTLY_TOKEN || '';
async function aptly(path) {
  const r = await fetch(API + path, { headers: { 'x-token': token(), accept: 'application/json' } });
  if (!r.ok) throw new Error('Aptly answered ' + r.status);
  return r.json();
}
const rows = (j) => (Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : []);

function toDate(v) {
  if (v == null || v === '') return null;
  if (Array.isArray(v)) return toDate(v[0]);
  if (typeof v === 'object') return toDate(v.value || v.date || v.label);
  const d = typeof v === 'number' ? new Date(v) : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? new Date(v + 'T12:00:00Z') : new Date(String(v));
  return isNaN(d) ? null : d;
}
const text = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(', ');
  if (typeof v === 'object') return String(v.label || v.name || v.value || '');
  return String(v);
};
const names = (v) => (Array.isArray(v) ? v.map((x) => (x && x.name) || '').filter(Boolean) : []);
const money = (v) => (v && typeof v === 'object' && typeof v.amount === 'number' ? v.amount : null);
const decode = (s) => String(s == null ? '' : s).replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16))).replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const day = (d) => (d ? d.toISOString().slice(0, 10) : null);
const daysBetween = (a, b) => Math.floor((b - a) / 86400000);

export function buildPipeline(schema, cards, now = new Date()) {
  const key = {};
  for (const f of schema || []) if (f && f.label && f.key && !(f.label in key)) key[f.label] = f.key;
  const get = (c, label) => (key[label] ? c[key[label]] : undefined);
  const out = cards.map((c) => {
    const stageAt = toDate(c.stageUpdatedAt);
    const daysInStage = stageAt ? Math.max(0, daysBetween(stageAt, now)) : null;
    const moveOut = toDate(get(c, 'Scheduled Move-Out')) || toDate(get(c, 'Mirror Expected Move-Out Date'));
    const daysToMoveOut = moveOut ? daysBetween(now, moveOut) + (now < moveOut ? 1 : 0) : null;
    const cl = Array.isArray(c.checklist) ? c.checklist : [];
    const open = cl.filter((x) => !x.checked).map((x) => x.title || '');
    const la = c.lastActivity && typeof c.lastActivity === 'object' ? c.lastActivity : null;
    const lastAt = la ? toDate(la.publishedAt) : null;
    const owners = names(get(c, 'Mirror Owners'));
    const stage = c.stage || '';
    const flags = [];
    if (TURN_STAGES[0] === stage && daysInStage != null && daysInStage >= 14) flags.push('Turn open ' + daysInStage + ' days');
    else if (stage !== 'Complete' && daysInStage != null && daysInStage >= 21) flags.push('In this stage ' + daysInStage + ' days');
    if (!moveOut) flags.push('No move-out date');
    else if (EARLY.has(stage) && daysToMoveOut != null && daysToMoveOut < 0) flags.push('Move-out date passed, still in ' + stage);
    if (!c.assignee) flags.push('Nobody assigned');
    if (!owners.length) flags.push('No owner on card');
    if (stage !== 'Complete' && open.length && daysInStage != null && daysInStage >= 7) flags.push(open.length + ' checklist item' + (open.length === 1 ? '' : 's') + ' open');
    return {
      id: c.cardId || c._id || '',
      aptlyId: c._id || '',
      name: c.name || '',
      address: names(c.unit)[0] || c.name || '',
      stage,
      stageSince: day(stageAt),
      daysInStage,
      moveOutDate: day(moveOut),
      daysToMoveOut,
      moveOutType: text(get(c, 'Move-Out Type')),
      leaseEnd: day(toDate(get(c, 'Lease End Date'))),
      owners,
      turnItems: text(get(c, 'Turn items needed?')),
      assigned: !!c.assignee,
      checklistDone: cl.length - open.length,
      checklistTotal: cl.length,
      checklistOpen: open,
      lastActivity: la ? { type: la.type || '', direction: la.direction || '', at: day(lastAt), daysAgo: lastAt ? Math.max(0, daysBetween(lastAt, now)) : null, text: decode(la.content).slice(0, 240) } : null,
      flags,
      isTurn: TURN_STAGES.includes(stage),
      addrKey: addrKey(names(c.unit)[0] || c.name || ''),
      comprehensive: text(get(c, 'Comprehensive Inspection')),
      tenants: [...new Set(names(get(c, 'Related Contacts')))],
      leaseName: text(get(c, 'Lease')),
      balance: money(get(c, 'Mirror Current Balance')),
      overdue: money(get(c, 'Mirror Overdue Charge Balance')),
      deposit: money(get(c, 'Mirror Current Deposit Balance')),
    };
  });
  const rank = (s) => { const i = STAGE_ORDER.indexOf(s); return i < 0 ? 99 : i; };
  out.sort((a, b) => rank(a.stage) - rank(b.stage) || (b.daysInStage || 0) - (a.daysInStage || 0));
  const by = {};
  for (const c of out) by[c.stage] = (by[c.stage] || 0) + 1;
  const missingLabels = ['Scheduled Move-Out', 'Mirror Owners', 'Move-Out Type'].filter((l) => !key[l]);
  return { generatedAt: now.toISOString(), count: out.length, stageOrder: STAGE_ORDER, stageCounts: by, turnStages: TURN_STAGES, missingLabels, commentsAvailable: false, cards: out };
}

async function fetchAll() {
  const schema = rows(await aptly('/api/schema/' + BOARD));
  const cards = [];
  for (let page = 0; page < 20; page++) {
    const j = await aptly('/api/board/' + BOARD + '?page=' + page + '&pageSize=100&includeArchived=false');
    const r = rows(j);
    cards.push(...r);
    if (r.length < 100 || (j && j.count != null && cards.length >= j.count)) break;
  }
  return buildPipeline(schema, cards.filter((c) => !c.archived));
}


// ---- John's walk sheet (read-only). Pre move-out and move-out walks only; renewals / move-in / new-property rows are ignored.
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1b5qlwlEo8avsSRbm2id1ocN0Eh5KmvvKPHsiEoDWngk/export?format=csv';
export function parseCsv(t) {
  const rowsOut = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n') { row.push(f); rowsOut.push(row); row = []; f = ''; }
    else if (ch !== '\r') f += ch;
  }
  if (f !== '' || row.length) { row.push(f); rowsOut.push(row); }
  return rowsOut;
}
export function walkDate(s) {
  const m = /^\s*(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\s*$/.exec(String(s || ''));
  if (!m) return null;
  const mo = +m[1], d = +m[2];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return m[3] + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
export function walkKind(t) {
  const s = String(t || '').trim().toLowerCase();
  if (!s || /^move[\s-]*in\b/.test(s)) return null;
  if (/pre[\s-]*move[\s-]*out/.test(s)) return 'pre';
  if (/move[\s-]*out|comprehensive/.test(s)) return 'out';
  return null;
}
export function parseWalks(csv) {
  const out = []; let seenHeader = false;
  for (const r of parseCsv(csv)) {
    if (!seenHeader) { if (/date walk/i.test(r[2] || '')) seenHeader = true; continue; }
    const date = walkDate(r[2]); const kind = walkKind(r[4]);
    const key = addrKey(r[0] || '');
    if (!date || !kind || !key) continue;
    out.push({ key, date, kind });
  }
  return out;
}

export function installMoveoutsPipeline(app) {
  let cache = null, cachedAt = 0, inflight = null, lastForce = 0;
  let walkCache = null, walkAt = 0;
  app.locals.moveoutsPipelineBust = () => { cachedAt = 0; };
  installMoveoutsComprehensive(app);
  app.get('/api/moveouts/walks', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (walkCache && Date.now() - walkAt < TTL_MS) return res.json(walkCache);
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 15000);
      let r; try { r = await fetch(SHEET_URL, { signal: ctl.signal, redirect: 'follow' }); } finally { clearTimeout(to); }
      if (!r.ok) throw new Error('Google answered ' + r.status);
      const text = await r.text();
      if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('Google asked for sign-in (sheet is not shared by link)');
      const walks = parseWalks(text);
      walkCache = { generatedAt: new Date().toISOString(), count: walks.length, walks }; walkAt = Date.now();
      res.json(walkCache);
    } catch (e) {
      console.error('[moveouts-walks]', e.message);
      if (walkCache) return res.json({ ...walkCache, stale: true });
      res.status(502).json({ error: 'Could not read John’s walk sheet (' + e.message + ').' });
    }
  });

  app.get('/api/moveouts/pipeline', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!token()) return res.status(503).json({ error: 'The Aptly connection is not set up on the hub.' });
    const now = Date.now();
    const force = req.query.refresh === '1' && now - lastForce > MIN_FORCE_MS;
    if (force) lastForce = now;
    if (cache && !force && now - cachedAt < TTL_MS) return res.json(cache);
    try {
      if (!inflight) inflight = fetchAll().finally(() => { inflight = null; });
      cache = await inflight; cachedAt = Date.now();
      res.json(cache);
    } catch (e) {
      console.error('[moveouts-pipeline]', e.message);
      if (cache) return res.json({ ...cache, stale: true });
      res.status(502).json({ error: 'Could not read the Aptly Move-Outs board (' + e.message + ').' });
    }
  });
}
