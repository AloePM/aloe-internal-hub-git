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
  (p) => ['/custom-fields/values/5/' + p, {}],
  (p) => ['/custom-fields', { objectTypeID: 5, objectID: p }],
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
// Rentvine's own page reads property custom fields from /custom-fields/values/5/{propertyId} (object type 5 here).
// If the values come back without field names, join them to the field definitions by ID.
const idOf = (o) => {
  if (!o || typeof o !== 'object') return null;
  for (const k of ['customFieldID', 'fieldID', 'customFieldId']) if (o[k] != null) return String(o[k]);
  if (o.customField && typeof o.customField === 'object') { const x = idOf(o.customField); if (x) return x; }
  if (o.id != null) return String(o.id);
  return null;
};
const nameOf = (o) => {
  if (!o || typeof o !== 'object') return '';
  for (const k of LABEL_KEYS) if (typeof o[k] === 'string') return o[k];
  if (o.customField && typeof o.customField === 'object') return nameOf(o.customField);
  return '';
};
export function joinValues(vals, defs) {
  const names = new Map();
  (Array.isArray(defs) ? defs : []).forEach((d) => { const id = idOf(d), n = nameOf(d); if (id && n) names.set(id, n); });
  const out = [];
  (Array.isArray(vals) ? vals : []).forEach((v) => {
    const own = nameOf(v), id = idOf(v);
    const label = own || (id && names.get(id)) || '';
    const vk = VALUE_KEYS.find((k) => v && prim(v[k]));
    if (label && vk) out.push({ name: label, value: v[vk] });
  });
  return out;
}
let valuesOk = null; // remembers whether /custom-fields/values/5/{id} works
export async function readProperty(rv, pid) {
  const detail = await rv('/properties/' + pid);
  if (detail && detail.error) throw new Error(detail.error);
  const parts = [detail];
  if (hasServiceLabel(detail)) return { parts, via: 'property' };
  if (valuesOk !== false) {
    const vals = await rv('/custom-fields/values/5/' + pid, {});
    if (vals && !vals.error) {
      if (hasServiceLabel(vals)) { valuesOk = true; parts.push(vals); return { parts, via: '/custom-fields/values/5' }; }
      if (Array.isArray(vals) && vals.length) {
        const defs = await rv('/custom-fields', { objectTypeID: 5, objectID: pid });
        const joined = joinValues(vals, defs && !defs.error ? defs : []);
        if (hasServiceLabel(joined)) { valuesOk = true; parts.push(joined); return { parts, via: '/custom-fields/values/5+definitions' }; }
      }
      if (Array.isArray(vals) && !vals.length) return { parts, via: 'none' };
    } else if (valuesOk === null) valuesOk = false;
  }
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
// Is the property still managed? Rentvine marks a lost home Inactive and stamps a deactivated date.
// Returns false (no longer managed), true (active) or null (could not tell).
export function managedOf(detail) {
  const p = (detail && detail.property) || detail || {};
  const off = (v) => v === false || v === 0 || v === '0' || /^(false|no|n)$/i.test(String(v));
  const on = (v) => v === true || v === 1 || v === '1' || /^(true|yes|y)$/i.test(String(v));
  let saysActive = false;
  for (const [k, v] of Object.entries(p)) {
    if (!prim(v)) continue;
    if (/^(isActive|active)$/i.test(k)) { if (off(v)) return false; if (on(v)) saysActive = true; }
    else if (/^status(name)?$/i.test(k) && typeof v === 'string') { if (/inactive/i.test(v)) return false; if (/^active$/i.test(v.trim())) saysActive = true; }
    else if (/deactivat/i.test(k) && v !== '' && v !== 0 && v !== '0' && !/^0000/.test(String(v)) && !/^(false|no)$/i.test(String(v))) return false;
  }
  return saysActive ? true : null;
}
export function _resetDiscovery() { cfWinner = -1; cfMiss = 0; valuesOk = null; }

// ---------- Zinspector inspection reports (READ-ONLY) ----------
// Pre move-out ("Tenant Completed Pre Move Out Inspection") and annual ("Annual Inspection 2.0") reports.
// The hub only reads: it never writes to Zinspector, Aptly or Rentvine from here.
const ZI_BASE = 'https://portfolio.zinspector.com';
const htmlText = (h) => squash(String(h || '').replace(/<[^>]*>/g, ' ').replace(/&ZeroWidthSpace;|&#8203;|&#x200b;|\u200b/gi, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"'));
const firstByClass = (chunk, token) => {
  const m = new RegExp('<(td|th|div|span|b|p|a|i|h[1-6])\\b[^>]*class="[^"]*\\b' + token + '\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>', 'i').exec(chunk);
  return m ? m[2] : null;
};
const NO_COMMENT = /^(none|n\/a|[–—-])?$/i;
export function parseReport(html) {
  html = String(html || '');
  const marks = [];
  const hdr = /<([a-z0-9]+)\b[^>]*class="[^"]*\barea-header\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi; let m;
  while ((m = hdr.exec(html))) marks.push({ at: m.index, area: htmlText(m[2]).slice(0, 60) });
  const rows = [];
  const rowRe = /<(tr|tbody)\b[^>]*class="[^"]*\beditRow\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi;
  while ((m = rowRe.exec(html))) {
    const row = m[2]; let area = '';
    for (const k of marks) if (k.at < m.index) area = k.area;
    const item = htmlText(firstByClass(row, 'table-v3-design-detail-name') || '').slice(0, 80);
    const b = /<(?:span|div|b|i)\b[^>]*class="([^"]*\bcond-badge\b[^"]*)"[^>]*>([\s\S]*?)<\/(?:span|div|b|i)>/i.exec(row);
    const code = b ? htmlText(b[2]).slice(0, 12) : '';
    const cls = b ? (b[1].match(/\bcond-[a-z0-9_-]+/gi) || []).map((x) => x.slice(5).toLowerCase()).filter((x) => x !== 'badge') : [];
    const unknown = !b || cls.includes('unknown') || /^[–—-]?$/.test(code);
    const act = firstByClass(row, 'table-v3-design-action-cell');
    const action = !!act && /table-v3-design-action-icon|ph-wrench|ph-warning|ph-exclamation/i.test(act);
    const comment = htmlText(firstByClass(row, 'table-v3-design-comment') || '').slice(0, 400);
    const hasComment = !NO_COMMENT.test(comment);
    const photos = (row.match(/View Image/gi) || []).length;
    const reasons = [];
    if (action) reasons.push('action');
    if (!unknown) reasons.push('condition ' + code);
    if (hasComment) reasons.push('comment');
    rows.push({ area, item, condition: unknown ? '' : code, conditionClass: cls.join(' '), action, comment: hasComment ? comment : '', photos, flagged: reasons.length > 0, reasons });
  }
  return { total: rows.length, flagged: rows.filter((r) => r.flagged).length, rows };
}
export function skeleton(html) {
  html = String(html || '');
  const strip = (x) => x.replace(/\s(?:src|href|srcset|style|alt|title|data-[a-z-]+)="[^"]*"/gi, '').replace(/>([^<]+)</g, (mm, t) => (t.trim() ? '>…<' : mm));
  const h = /<([a-z0-9]+)\b[^>]*class="[^"]*\barea-header\b[^"]*"[^>]*>[\s\S]*?<\/\1>/i.exec(html);
  const r = /<(tr|tbody)\b[^>]*class="[^"]*\beditRow\b[^"]*"[^>]*>[\s\S]*?<\/\1>/i.exec(html);
  return { areaHeader: h ? strip(h[0]).slice(0, 700) : null, firstRow: r ? strip(r[0]).slice(0, 2500) : null };
}
// The hub holds two Zinspector keys (ZI_API_KEY and ZINSPECTOR_API_KEY) and Zinspector has accepted keys in more than one header style.
// Try each combination in order, stop at the first that is not refused, and remember it. Names only are ever reported, never values.
let ziWinner = null;
function ziVariants() {
  const out = []; const seen = new Set();
  const add = (label, val, mk) => { if (!val) return; const id = label.split(':')[0] + '|' + val; if (seen.has(id)) return; seen.add(id); out.push({ label, headers: mk(val) }); };
  const zi = process.env.ZI_API_KEY, zin = process.env.ZINSPECTOR_API_KEY;
  // New dedicated key for the hub's report reader; Zinspector says to send the Encoded API Key as the X-API-KEY header.
  add('x-api-key:ZI_REPORTS_API_KEY', process.env.ZI_REPORTS_API_KEY, (v) => ({ 'x-api-key': v }));
  add('x-api-key:ZI_API_KEY', zi, (v) => ({ 'x-api-key': v }));
  add('x-api-key:ZINSPECTOR_API_KEY', zin, (v) => ({ 'x-api-key': v }));
  add('basic:ZI_API_KEY', zi, (v) => ({ Authorization: 'Basic ' + v }));
  add('basic:ZINSPECTOR_API_KEY', zin, (v) => ({ Authorization: 'Basic ' + v }));
  add('bearer:ZI_API_KEY', zi, (v) => ({ Authorization: 'Bearer ' + v }));
  add('bearer:ZINSPECTOR_API_KEY', zin, (v) => ({ Authorization: 'Bearer ' + v }));
  return out;
}
export function _resetZi() { ziWinner = null; }
async function ziGet(path, params) {
  let vars = ziVariants();
  if (!vars.length) return { error: 'Neither ZI_REPORTS_API_KEY, ZI_API_KEY nor ZINSPECTOR_API_KEY is set on the server' };
  if (ziWinner) { const w = vars.find((v) => v.label === ziWinner); if (w) vars = [w, ...vars.filter((v) => v !== w)]; }
  const url = new URL(path, ZI_BASE);
  Object.entries(params || {}).forEach(([k, v]) => { if (v != null && v !== '') url.searchParams.set(k, String(v)); });
  const refused = [];
  for (const v of vars) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await fetch(url.toString(), { headers: { ...v.headers, Accept: 'application/json', Origin: 'https://hub.aloepm.com', Referer: 'https://hub.aloepm.com/' }, signal: ac.signal });
      const txt = await r.text();
      if (r.status === 401 || r.status === 403) { refused.push(v.label + ' ' + r.status); continue; }
      if (!r.ok) return { error: 'Zinspector ' + r.status + ': ' + txt.slice(0, 160), via: v.label };
      ziWinner = v.label;
      try { return { data: JSON.parse(txt), via: v.label }; } catch (e) { return { error: 'Zinspector returned something that is not JSON', via: v.label }; }
    } catch (e) { return { error: String(e.message || e).slice(0, 120) }; } finally { clearTimeout(t); }
  }
  return { error: 'Zinspector refused every key style tried: ' + refused.join('; ') };
}
async function readShare(token) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch('https://portfolio.zinspector.com/api/document/getShareReport/' + token, { signal: ac.signal });
    const raw = await r.text();
    if (!r.ok) return { error: 'Report link answered ' + r.status };
    let html = raw; try { const j = JSON.parse(raw); if (typeof j === 'string') html = j; } catch (e) {}
    return { html };
  } catch (e) { return { error: String(e.message || e).slice(0, 120) }; } finally { clearTimeout(t); }
}
const tokenOf = (u) => { const m = /([A-Za-z0-9]{20,64})\/?(?:\?.*)?$/.exec(String(u || '')); return m ? m[1] : ''; };
const KIND = [[/pre\s*move[\s-]*out/i, 'pre-move-out'], [/annual\s+inspection/i, 'annual']];
export async function findReports(address, zget = ziGet, readS = readShare) {
  const want = addrKey(address);
  if (!want) return { error: 'Address could not be read' };
  const term = String(address).split(',')[0].trim();
  const r = await zget('/api/documents/', { search: term, page_size: 50, ordering: '-Date' });
  if (r.error) return { error: r.error };
  const d = r.data; const list = Array.isArray(d) ? d : (d && (d.results || d.documents)) || [];
  // John's sheet writes "1825 West Ray Road Chandler, AZ" (no comma), Zinspector writes "1825 West Ray Road, Chandler, AZ": accept either as a whole-word prefix of the other.
  const same = (x, y) => !!x && !!y && (x === y || x.startsWith(y + ' ') || y.startsWith(x + ' '));
  const keyOf = (x) => addrKey(x.PropertyAddress || x.property_address || x.address || x.PropertyName || '');
  const exact = list.filter((x) => keyOf(x) === want);
  const mine = exact.length ? exact : list.filter((x) => same(keyOf(x), want));
  const best = {};
  for (const x of mine) {
    const title = String(x.Title || x.title || '');
    const k = (KIND.find(([re]) => re.test(title)) || [])[1]; if (!k) continue;
    const when = String(x.Date || x.date || '');
    if (!best[k] || when > best[k].when) best[k] = { x, title, when };
  }
  const reports = [];
  for (const [kind, b] of Object.entries(best)) {
    const x = b.x, tok = tokenOf(x.shareable_raw_html_url || x.shareable_report_url || '');
    const rep = { kind, title: b.title, date: b.when, id: x.id, reportUrl: x.shareable_report_url || x.HTML_URL || '' };
    if (!tok) { rep.error = 'No share link on this report'; reports.push(rep); continue; }
    const s = await readS(tok);
    if (s.error) { rep.error = s.error; reports.push(rep); continue; }
    const p = parseReport(s.html);
    rep.total = p.total; rep.flagged = p.flagged; rep.rows = p.rows.filter((q) => q.flagged);
    reports.push(rep);
  }
  return { address: term, authVia: r.via || null, searched: list.length, matchedAddress: mine.length, firstItemKeys: list[0] ? Object.keys(list[0]).slice(0, 30) : null, reports };
}


// ---- Tenant contacts for the Upcoming tab (read-only). Names, phones and emails come from Rentvine.
const digits = (s) => String(s || '').replace(/\D/g, '');
export function pickContacts(o) {
  const phones = new Map(), emails = new Map();
  (function walk(v, key, depth) {
    if (v == null || depth > 5) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, key, depth + 1)); return; }
    if (typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k], (key ? key.split('.').pop() + '.' : '') + k, depth + 1); return; }
    const s = String(v).trim();
    if (!s) return;
    if (/e-?mail/i.test(key) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) emails.set(s.toLowerCase(), s);
    else if (/phone|mobile|cell/i.test(key) && !/(type|id|label|extension|verified)/i.test(key)) {
      const d = digits(s); if (d.length >= 10 && d.length <= 11) phones.set(d.slice(-10), d.slice(-10));
    }
  })(o, '', 0);
  const fmt = (d) => '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  return { phones: [...phones.values()].map(fmt), emails: [...emails.values()] };
}
export function tenantName(t) {
  if (!t || typeof t !== 'object') return '';
  const n = squash(t.name || t.fullName || [t.firstName, t.lastName].filter(Boolean).join(' '));
  return n;
}
const tokens = (s) => squash(s).toLowerCase().split(/[^a-z]+/).filter((x) => x.length >= 3);
// Choose the Rentvine lease that matches the card: same address, preferring one whose tenants share a name with the card.
export function chooseLease(cands, cardNames) {
  if (!cands.length) return { lease: null, ambiguous: false };
  const want = new Set((cardNames || []).flatMap(tokens));
  const score = (c) => c.tenants.reduce((n, t) => n + tokens(t.name).filter((x) => want.has(x)).length, 0);
  const ranked = cands.map((c) => ({ c, s: score(c) })).sort((a, b) => b.s - a.s);
  const top = ranked[0];
  const ties = ranked.filter((r) => r.s === top.s).length;
  return { lease: top.c, ambiguous: cands.length > 1 && (top.s === 0 || ties > 1) };
}

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
    const v = extractServices(parts); v.managed = managedOf(parts[0]); svcCache.set(pid, { at: Date.now(), v }); return v;
  }
  async function pool(items, n, fn) {
    const res = new Array(items.length); let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k]); } }));
    return res;
  }


  // ---- tenant phones / emails (read-only) ----
  const LEASE_TTL = 15 * 60 * 1000, CONTACT_TTL = 30 * 60 * 1000;
  let leaseIdx = null, leaseIdxAt = 0, leaseInflight = null;
  async function getLeaseIndex() {
    if (leaseIdx && Date.now() - leaseIdxAt < LEASE_TTL) return leaseIdx;
    if (leaseInflight) return leaseInflight;
    leaseInflight = (async () => {
      const map = new Map();
      for (const status of [1, 3]) {
        for (let page = 1; page <= 15; page++) {
          const b = await rvFetch('/leases/export', { pageSize: 200, page, 'primaryLeaseStatusIDs[]': status });
          if (b && b.error) throw new Error(b.error);
          const items = Array.isArray(b) ? b : (b && b.data) || [];
          for (const it of items) {
            const key = addrKey(it && it.property && it.property.address);
            const ts = (it && it.lease && Array.isArray(it.lease.tenants)) ? it.lease.tenants : [];
            if (!key || !ts.length) continue;
            const tenants = ts.map((t) => ({ name: tenantName(t), contactId: String(t.contactID || t.contactId || t.tenantContactID || t.id || ''), raw: t }));
            if (!map.has(key)) map.set(key, []);
            map.get(key).push({ leaseId: String((it.lease && (it.lease.leaseID || it.lease.id)) || ''), tenants });
          }
          if (items.length < 200) break;
        }
      }
      leaseIdx = map; leaseIdxAt = Date.now(); return map;
    })().finally(() => { leaseInflight = null; });
    return leaseInflight;
  }
  const contactCache = new Map();
  async function contactFor(t) {
    let found = pickContacts(t.raw);
    if (found.phones.length || found.emails.length || !/^\d{1,9}$/.test(t.contactId)) return found;
    const hit = contactCache.get(t.contactId); if (hit && Date.now() - hit.at < CONTACT_TTL) return hit.v;
    try {
      const b = await rvFetch('/contacts/tenants/' + t.contactId);
      if (b && !b.error) found = pickContacts(b);
    } catch (e) { /* leave empty */ }
    contactCache.set(t.contactId, { at: Date.now(), v: found });
    return found;
  }
  const sameKey = (x, y) => !!x && !!y && (x === y || x.startsWith(y + ' ') || y.startsWith(x + ' '));
  app.post('/api/moveouts/tenants', express.json({ limit: '200kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const items = Array.isArray(req.body && req.body.cards) ? req.body.cards.slice(0, 80) : null;
    if (!items) return res.status(400).json({ error: 'Send {"cards":[{"key":"...","names":[...]}]}.' });
    try {
      const idx = await getLeaseIndex();
      const results = {};
      await pool(items, 4, async (c) => {
        const key = String((c && c.key) || ''); if (!key) return;
        const cands = []; for (const [k, v] of idx) if (sameKey(k, key)) cands.push(...v);
        const pick = chooseLease(cands, Array.isArray(c.names) ? c.names.map(String) : []);
        if (!pick.lease) return (results[key] = { matched: false });
        const people = await pool(pick.lease.tenants, 3, async (t) => ({ name: t.name, ...(await contactFor(t)) }));
        results[key] = { matched: true, ambiguous: !!pick.ambiguous, tenants: people };
      });
      res.json({ results });
    } catch (e) { console.error('[moveouts-tenants]', e.message); res.status(502).json({ error: 'Could not read tenants from Rentvine.' }); }
  });
  // Diagnostic (read-only): which status filters return the lease at an address. Counts and status numbers only.
  app.get('/api/moveouts/lease-probe', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const key = addrKey(String(req.query.address || '')); if (!key) return res.status(400).json({ error: 'Pass ?address=' });
    const variants = [['none', {}], ['primary 1', { 'primaryLeaseStatusIDs[]': 1 }], ['primary 2', { 'primaryLeaseStatusIDs[]': 2 }], ['primary 3', { 'primaryLeaseStatusIDs[]': 3 }], ['primary 4', { 'primaryLeaseStatusIDs[]': 4 }], ['lease status 3', { 'leaseStatusIDs[]': 3 }], ['lease status 10', { 'leaseStatusIDs[]': 10 }]];
    const out = [];
    try {
      for (const [label, extra] of variants) {
        let scanned = 0, pages = 0, hits = [];
        for (let page = 1; page <= 15; page++) {
          const b = await rvFetch('/leases/export', { pageSize: 200, page, ...extra });
          if (b && b.error) { out.push({ filter: label, error: String(b.error).slice(0, 80) }); break; }
          const items = Array.isArray(b) ? b : (b && b.data) || [];
          pages++; scanned += items.length;
          for (const it of items) {
            if (!sameKey(addrKey(it && it.property && it.property.address), key)) continue;
            const L = (it && it.lease) || {};
            const st = {}; for (const k of Object.keys(L)) if (/status|end|move|term/i.test(k) && (L[k] == null || typeof L[k] !== 'object')) st[k] = L[k];
            hits.push({ tenantsCount: Array.isArray(L.tenants) ? L.tenants.length : null, leaseKeys: Object.keys(L).slice(0, 30), status: st });
          }
          if (items.length < 200) break;
        }
        if (!out.find((o) => o.filter === label)) out.push({ filter: label, pages, scanned, matches: hits.length, hits: hits.slice(0, 3) });
      }
      res.json({ key, results: out });
    } catch (e) { res.status(502).json({ error: e.message, partial: out }); }
  });
  // Diagnostic (read-only): field NAMES only, never values.
  app.get('/api/moveouts/tenant-shape', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const key = addrKey(String(req.query.address || '')); if (!key) return res.status(400).json({ error: 'Pass ?address=' });
      const idx = await getLeaseIndex(); const cands = []; for (const [k, v] of idx) if (sameKey(k, key)) cands.push(...v);
      const names = (o, d = 0) => (o && typeof o === 'object' && d < 4) ? Object.fromEntries(Object.entries(o).slice(0, 40).map(([k, v]) => [k, Array.isArray(v) ? ['array', v[0] ? names(v[0], d + 1) : null] : (v && typeof v === 'object') ? names(v, d + 1) : typeof v])) : typeof o;
      const t = cands[0] && cands[0].tenants[0];
      let contact = null; if (t && /^\d{1,9}$/.test(t.contactId)) { try { contact = names(await rvFetch('/contacts/tenants/' + t.contactId)); } catch (e) { contact = 'error: ' + e.message; } }
      res.json({ leasesFound: cands.length, tenantFields: t ? names(t.raw) : null, contactFields: contact });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

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
  // READ-ONLY diagnostic for the Upcoming tab plan. Writes nothing anywhere. Reports names/shapes only, never secret values.
  const SHEET_ID = '1b5qlwlEo8avsSRbm2id1ocN0Eh5KmvvKPHsiEoDWngk';
  const timed = async (url, ms = 15000) => {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
    try { return await fetch(url, { signal: ac.signal, redirect: 'follow' }); } finally { clearTimeout(t); }
  };
  // READ-ONLY routes (login required, under /api/moveouts). They write nothing anywhere.
  const inspCache = new Map();
  app.get('/api/moveouts/inspection', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const address = String(req.query.address || '').slice(0, 200);
    if (!address) return res.status(400).json({ error: 'Send ?address=' });
    const hit = inspCache.get(address); if (hit && Date.now() - hit.at < 10 * 60 * 1000) return res.json(hit.v);
    const v = await findReports(address);
    if (!v.error) inspCache.set(address, { at: Date.now(), v });
    res.status(v.error ? 502 : 200).json(v);
  });
  // READ-ONLY auth check: which Zinspector key styles are accepted by which lists. Reports status codes and key SHAPE only (never values).
  app.get('/api/moveouts/zi-auth-check', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const keys = { ZI_REPORTS_API_KEY: process.env.ZI_REPORTS_API_KEY || '', ZI_API_KEY: process.env.ZI_API_KEY || '', ZINSPECTOR_API_KEY: process.env.ZINSPECTOR_API_KEY || '' };
    const shape = {};
    for (const [n, v] of Object.entries(keys)) {
      let decoded = ''; try { decoded = Buffer.from(v, 'base64').toString('utf8'); } catch (e) {}
      shape[n] = { set: !!v, length: v.length, hasWhitespace: /\s/.test(v), startsOrEndsWithQuote: /^["']|["']$/.test(v), base64WithColonInside: /^[^:\s]+:[^:\s]+$/.test(decoded) };
    }
    const styles = [];
    for (const [n, v] of Object.entries(keys)) {
      if (!v) continue;
      styles.push([n + ' x-api-key', { 'x-api-key': v }], [n + ' Basic', { Authorization: 'Basic ' + v }], [n + ' Bearer', { Authorization: 'Bearer ' + v }],
        [n + ' Api-Key', { Authorization: 'Api-Key ' + v }], [n + ' Token', { Authorization: 'Token ' + v }], [n + ' X-Api-Key+Accept', { 'X-Api-Key': v, Accept: 'application/json' }]);
    }
    const paths = ['/api/propertiesCursor/?page_size=1', '/api/documents/?page_size=1', '/api/media/?page_size=1'];
    const matrix = [];
    for (const [label, headers] of styles) {
      const row = { style: label };
      for (const pth of paths) {
        const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
        try { const r = await fetch(ZI_BASE + pth, { headers, signal: ac.signal }); row[pth.split('?')[0]] = r.status; }
        catch (e) { row[pth.split('?')[0]] = 'error'; } finally { clearTimeout(t); }
      }
      matrix.push(row);
    }
    res.json({ shape, matrix });
  });

  app.get('/api/moveouts/inspection-parse', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = String(req.query.token || '');
    if (!/^[A-Za-z0-9]{20,64}$/.test(token)) return res.status(400).json({ error: 'Send ?token= (the end of a report share link)' });
    const s = await readShare(token);
    if (s.error) return res.status(502).json({ error: s.error });
    const p = parseReport(s.html);
    const out = { total: p.total, flagged: p.flagged, rows: p.rows };
    if (req.query.skeleton) out.skeleton = skeleton(s.html);
    res.json(out);
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
