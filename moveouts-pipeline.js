// Read-only Move-Outs pipeline feed for the hub (/api/moveouts/pipeline).
// Reads the Aptly Move-Outs board. Never writes to Aptly. Cached 5 minutes.
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
      lastActivity: la ? { type: la.type || '', direction: la.direction || '', at: day(lastAt), daysAgo: lastAt ? Math.max(0, daysBetween(lastAt, now)) : null, text: String(la.content || '').slice(0, 240) } : null,
      flags,
      isTurn: TURN_STAGES.includes(stage),
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

export function installMoveoutsPipeline(app) {
  let cache = null, cachedAt = 0, inflight = null, lastForce = 0;
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
