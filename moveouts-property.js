// Read-only property info for Move-outs: who is responsible for landscaping / pest control / pool service
// (from the Rentvine property page) and the property's past work orders. Never writes anywhere.
// Routes live under /api/moveouts so the API lock covers them.
import express from 'express';

const SERVICE_TTL = 6 * 3600 * 1000, INDEX_TTL = 6 * 3600 * 1000, WO_TTL = 10 * 60 * 1000;
const MONTHS_BACK = 24;
const STATUS = { 1: 'Open', 6: 'Estimating', 21: 'Troubleshooting Steps Sent', 28: 'HVAC Tune Ups', 4: 'Requested', 24: 'Internal Work Order Request', 25: 'Unit Turn', 26: 'Home Warranty', 22: 'Renewal Walk Through', 23: 'Move Out', 14: 'Scheduled', 5: 'On Hold', 2: 'Completed', 7: 'Rejected', 18: 'Completed Already Billed', 3: 'Cancelled', 27: 'Waiting for parts', 31: 'Owner Maintained' };

const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
export const stripHtml = (s) => squash(String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));

// ---------- address matching ----------
const DIRS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west']);
const SUFFIX = { avenue: 'ave', av: 'ave', drive: 'dr', street: 'st', road: 'rd', lane: 'ln', court: 'ct', place: 'pl', boulevard: 'blvd', circle: 'cir', trail: 'trl', terrace: 'ter', parkway: 'pkwy', way: 'way', loop: 'loop', highway: 'hwy' };
export function addrKey(raw) {
  let s = String(raw || '').toLowerCase().split(',')[0];
  s = s.replace(/\b(apt|unit|suite|ste|bldg|building)\b.*$/, '').replace(/#.*$/, '').replace(/[.\-]/g, ' ').replace(/[^a-z0-9 ]/g, ' ');
  const parts = squash(s).split(' ').filter(Boolean);
  if (!parts.length || !/^\d+$/.test(parts[0])) return '';
  const num = parts[0];
  const rest = parts.slice(1).filter((w) => !DIRS.has(w)).map((w) => SUFFIX[w] || w);
  return rest.length ? num + ' ' + rest.join(' ') : '';
}

// ---------- reading custom fields out of whatever shape Rentvine returns ----------
const LABEL_KEYS = ['name', 'label', 'fieldName', 'customFieldName', 'title', 'key'];
const VALUE_KEYS = ['value', 'fieldValue', 'displayValue', 'selectedValue', 'text'];
const prim = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
export function collectPairs(node, out = [], depth = 0) {
  if (depth > 8 || node == null) return out;
  if (Array.isArray(node)) { node.forEach((x) => collectPairs(x, out, depth + 1)); return out; }
  if (typeof node !== 'object') return out;
  const lk = LABEL_KEYS.find((k) => typeof node[k] === 'string');
  const vk = VALUE_KEYS.find((k) => prim(node[k]));
  if (lk && vk) out.push({ label: squash(node[lk]), value: String(node[vk]) });
  for (const [k, v] of Object.entries(node)) {
    if (prim(v)) { if (!(k === lk || k === vk)) out.push({ label: squash(k), value: String(v) }); }
    else collectPairs(v, out, depth + 1);
  }
  return out;
}
const norm = (s) => squash(s).toLowerCase();
const pick = (pairs, label) => { const p = pairs.find((x) => norm(x.label) === label && squash(x.value) !== ''); return p ? squash(p.value) : ''; };
function who(raw) {
  const v = norm(raw);
  if (!v) return 'unknown';
  if (/landlord|owner/.test(v)) return 'owner';
  if (/\bhoa\b/.test(v)) return 'hoa';
  if (/tenant|resident/.test(v)) return 'tenant';
  return 'other';
}
const WHO_TEXT = { owner: 'Owner pays', hoa: 'HOA covers', tenant: 'Tenant responsible', unknown: 'Not recorded', other: '' };
export function extractServices(detail) {
  const pairs = collectPairs(detail);
  const rows = [];
  const mk = (key, label, raw, provider) => { const w = who(raw); rows.push({ key, label, who: w, raw: raw || '', text: w === 'other' ? raw : WHO_TEXT[w], provider: provider || '', doNotCharge: w === 'owner' || w === 'hoa' }); };
  mk('landscaping', 'Landscaping', pick(pairs, 'landscaping'), pick(pairs, 'landscaping service provider and day'));
  mk('pest', 'Pest control', pick(pairs, 'pest control'), pick(pairs, 'pest control provider'));
  const poolFlag = pick(pairs, 'pool present?');
  const hasPool = /^(1|true|yes)$/i.test(poolFlag);
  const poolRaw = pick(pairs, 'pool service');
  if (hasPool || poolRaw) mk('pool', 'Pool service', poolRaw, pick(pairs, 'pool service provider'));
  const notes = pick(pairs, 'maintenance notes');
  const warnings = [];
  const rules = { landscaping: /landscap|yard|lawn|irrigation/i, pest: /pest|termite|bug|roach|scorpion/i, pool: /pool/i };
  for (const r of rows) {
    if (r.who === 'tenant' || r.who === 'unknown') {
      const m = notes && notes.match(rules[r.key]);
      if (m) { const i = Math.max(0, m.index - 50); warnings.push({ key: r.key, label: r.label, snippet: notes.slice(i, i + 170) }); }
    }
  }
  if (notes && /included in rent|covered by hoa/i.test(notes) && !warnings.length) {
    const m = notes.match(/included in rent|covered by hoa/i); const i = Math.max(0, m.index - 50);
    warnings.push({ key: 'general', label: 'Maintenance notes', snippet: notes.slice(i, i + 170) });
  }
  return { hasPool, services: rows, warnings, found: rows.some((r) => r.who !== 'unknown') };
}

export function mapWorkOrders(raw, now = new Date()) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.data) ? raw.data : [];
  const cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - MONTHS_BACK);
  const out = [];
  for (const it of list) {
    const w = (it && it.workOrder) || it || {}; const c = (it && it.contact) || {};
    const created = String(w.dateTimeCreated || '').slice(0, 10);
    if (!created || new Date(created + 'T12:00:00Z') < cutoff) continue;
    const sid = Number(w.workOrderStatusID);
    const summary = squash(w.agentSummary) || stripHtml(w.description);
    const est = parseFloat(w.estimatedAmount);
    out.push({
      id: String(w.workOrderID || ''), number: String(w.workOrderNumber || ''), created,
      closed: String(w.dateClosed || '').slice(0, 10) || null,
      scheduled: String(w.scheduledStartDate || '').slice(0, 10) || null,
      status: STATUS[sid] || (sid ? 'Status ' + sid : ''), vendor: squash(c.name),
      summary: summary.length > 280 ? summary.slice(0, 280) + '…' : summary,
      estimated: isFinite(est) && est > 0 ? est : null,
      tenantFinancial: String(w.isTenantFinanciallyResponsible) === '1',
      vacant: String(w.isVacant) === '1',
    });
  }
  out.sort((a, b) => b.created.localeCompare(a.created));
  return out;
}

// Custom field values may not be part of the property record. Try the property first, then the likely custom-field
// endpoints (object type 6 = property), keep the one that works, and report what happened.
const CF_TRIES = [
  (p) => ['/custom-fields/values', { objectTypeID: 6, objectID: p }],
  (p) => ['/custom-fields/values/6/' + p, {}],
  (p) => ['/custom-fields', { objectTypeID: 6, objectID: p }],
  (p) => ['/custom-fields/object-values', { objectTypeID: 6, objectID: p }],
  (p) => ['/properties/' + p + '/custom-fields', {}],
  (p) => ['/properties/' + p + '/customFields', {}],
  (p) => ['/customfields/values', { objectTypeID: 6, objectID: p }],
];
const SERVICE_LABEL = /landscaping|pest control|pool service/i;
const hasServiceLabel = (x) => collectPairs(x).some((p) => SERVICE_LABEL.test(p.label));
let cfWinner = -1, cfMiss = 0;
export async function readProperty(rv, pid) {
  const detail = await rv('/properties/' + pid);
  if (detail && detail.error) throw new Error(detail.error);
  const parts = [detail];
  if (hasServiceLabel(detail)) return { parts, via: 'property' };
  const order = cfWinner >= 0 ? [cfWinner] : cfMiss >= 5 ? [] : CF_TRIES.map((_, i) => i);
  for (const i of order) {
    const [path, params] = CF_TRIES[i](pid);
    const r = await rv(path, params);
    if (r && r.error) continue;
    if (hasServiceLabel(r)) { cfWinner = i; parts.push(r); return { parts, via: path }; }
  }
  if (cfWinner < 0) cfMiss++;
  return { parts, via: 'none' };
}
export function _resetDiscovery() { cfWinner = -1; cfMiss = 0; }

export function installMoveoutProperty(app, rvFetch) {
  let index = null, indexAt = 0, indexInflight = null;
  async function getIndex() {
    if (index && Date.now() - indexAt < INDEX_TTL) return index;
    if (!indexInflight) indexInflight = (async () => {
      const map = new Map();
      for (let page = 1; page <= 10; page++) {
        const b = await rvFetch('/properties/export', { pageSize: 500, page });
        if (b && b.error) throw new Error(b.error);
        const items = Array.isArray(b) ? b : (b && (b.data || b.results)) || [];
        if (!items.length) break;
        for (const it of items) {
          const p = it.property || it;
          const key = addrKey(p.address || ((p.streetNumber || '') + ' ' + (p.streetName || '')));
          if (!key || !p.propertyID) continue;
          if (map.has(key) && map.get(key) !== String(p.propertyID)) map.set(key, null); else map.set(key, String(p.propertyID));
        }
        if (items.length < 500) break;
      }
      index = map; indexAt = Date.now(); return map;
    })().finally(() => { indexInflight = null; });
    return indexInflight;
  }
  const svcCache = new Map(), woCache = new Map();
  async function services(pid) {
    const hit = svcCache.get(pid); if (hit && Date.now() - hit.at < SERVICE_TTL) return hit.v;
    const { parts } = await readProperty(rvFetch, pid);
    const v = extractServices(parts); svcCache.set(pid, { at: Date.now(), v }); return v;
  }
  async function pool(items, n, fn) {
    const res = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k]); } }));
    return res;
  }

  app.post('/api/moveouts/services', express.json({ limit: '100kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const addrs = Array.isArray(req.body && req.body.addresses) ? [...new Set(req.body.addresses.map((a) => String(a || '').slice(0, 200)).filter(Boolean))].slice(0, 80) : null;
    if (!addrs) return res.status(400).json({ error: 'Send {"addresses":[...]}.' });
    try {
      const idx = await getIndex();
      const results = {};
      await pool(addrs, 4, async (a) => {
        const key = addrKey(a); const pid = key ? idx.get(key) : null;
        if (!key) return (results[a] = { matched: false, reason: 'Address could not be read' });
        if (pid == null) return (results[a] = { matched: false, reason: idx.has(key) ? 'More than one property has this address' : 'No Rentvine property with this address' });
        try { results[a] = { matched: true, propertyId: pid, ...(await services(pid)) }; }
        catch (e) { results[a] = { matched: true, propertyId: pid, error: 'Could not read the property page' }; }
      });
      res.json({ results });
    } catch (e) { console.error('[moveouts-property]', e.message); res.status(502).json({ error: 'Could not read properties from Rentvine.' }); }
  });

  app.get('/api/moveouts/workorders/:pid', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const pid = req.params.pid;
    if (!/^\d{1,9}$/.test(pid)) return res.status(400).json({ error: 'Bad property id.' });
    const hit = woCache.get(pid); if (hit && Date.now() - hit.at < WO_TTL) return res.json(hit.v);
    try {
      let all = [];
      for (let page = 1; page <= 5; page++) {
        const b = await rvFetch('/maintenance/work-orders', { pageSize: 100, page, propertyID: pid });
        if (b && b.error) throw new Error(b.error);
        const items = Array.isArray(b) ? b : (b && b.data) || [];
        all = all.concat(items);
        if (items.length < 100) break;
      }
      const v = { propertyId: pid, months: MONTHS_BACK, workOrders: mapWorkOrders(all) };
      woCache.set(pid, { at: Date.now(), v }); res.json(v);
    } catch (e) { console.error('[moveouts-property] wo', e.message); res.status(502).json({ error: 'Could not read work orders from Rentvine.' }); }
  });

  // Diagnostics (read-only): which fields were found, and which source supplied them. Names and short values only.
  app.get('/api/moveouts/property-shape/:pid', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!/^\d{1,9}$/.test(req.params.pid)) return res.status(400).json({ error: 'Bad property id.' });
    try {
      const { parts, via } = await readProperty(rvFetch, req.params.pid);
      const pairs = collectPairs(parts).filter((p) => /landscap|pest|pool|spa|service|maintenance ?notes/i.test(p.label)).map((p) => ({ label: p.label, value: p.value.slice(0, 80) }));
      res.json({ source: via, topLevelKeys: Object.keys(parts[0] || {}).slice(0, 40), matchingFields: pairs.slice(0, 40), parsed: extractServices(parts) });
    } catch (e) { res.status(502).json({ error: 'Could not read the property.' }); }
  });
  app.get('/api/moveouts/property-probe/:pid', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!/^\d{1,9}$/.test(req.params.pid)) return res.status(400).json({ error: 'Bad property id.' });
    const out = [];
    for (const f of CF_TRIES) {
      const [path, params] = f(req.params.pid);
      const r = await rvFetch(path, params);
      if (r && r.error) { out.push({ path, params, ok: false, error: String(r.error).slice(0, 90) }); continue; }
      const first = Array.isArray(r) ? r[0] : (r && Array.isArray(r.data) ? r.data[0] : null);
      out.push({ path, params, ok: true, topLevelKeys: Array.isArray(r) ? ['(list of ' + r.length + ')'] : Object.keys(r || {}).slice(0, 20), firstItemKeys: first && typeof first === 'object' ? Object.keys(first).slice(0, 20) : null, serviceLabels: collectPairs(r).filter((p) => SERVICE_LABEL.test(p.label)).map((p) => p.label + '=' + p.value.slice(0, 40)).slice(0, 8) });
    }
    res.json({ propertyId: req.params.pid, tries: out });
  });
}
