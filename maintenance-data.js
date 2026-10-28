// Maintenance area - pure data helpers (no network, no writes). Used by maintenance-routes.js and the tests.
// Everything here only reshapes data that Rentvine already returned.

const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const isDate = (s) => /^\d{4}-\d{2}-\d{2}/.test(String(s || ''));
const day = (s) => String(s || '').slice(0, 10);

export function daysBetween(a, b) {
  const x = Date.parse(day(a) + 'T12:00:00Z'), y = Date.parse(day(b) + 'T12:00:00Z');
  return isFinite(x) && isFinite(y) ? Math.round((y - x) / 86400000) : null;
}
export function todayPhoenix(now = new Date()) {
  return new Date(now.getTime() - 7 * 3600000).toISOString().slice(0, 10); // Phoenix is UTC-7 all year
}

// ---------- open work orders grouped by property ----------
// openWOs = the list fetchAllRVOpenWOs() returns (same "open" rule as the Home page).
export function groupOpenByProperty(openWOs, today = todayPhoenix()) {
  const map = new Map();
  for (const wo of openWOs || []) {
    const pid = String(wo.propertyID || wo.propertyId || '');
    if (!/^\d{1,9}$/.test(pid)) continue;
    let g = map.get(pid);
    if (!g) { g = { propertyId: pid, address: squash(wo._unitAddress || wo.unitAddress), openCount: 0, oldest: null, items: [] }; map.set(pid, g); }
    if (!g.address) g.address = squash(wo._unitAddress || wo.unitAddress);
    const created = day(wo.dateTimeCreated);
    g.openCount++;
    if (created && (!g.oldest || created < g.oldest)) g.oldest = created;
    g.items.push({ id: String(wo.workOrderID || ''), number: String(wo.workOrderNumber || ''), created, summary: squash(wo.agentSummary || wo.description).slice(0, 160) });
  }
  const rows = [...map.values()].map((g) => ({ ...g, oldestDays: g.oldest ? daysBetween(g.oldest, today) : null }));
  rows.sort((a, b) => (b.oldestDays ?? -1) - (a.oldestDays ?? -1) || a.address.localeCompare(b.address));
  return rows;
}

// ---------- who is responsible (Tenant / Owner / Landlord / HOA) ----------
// Rentvine has stray spaces ("Tenant  Responsibility"), so squash before reading.
export function whoPays(raw) {
  const t = squash(raw).toLowerCase();
  if (!t) return { who: 'unknown', text: 'Not recorded' };
  if (/\bhoa\b|association/.test(t)) return { who: 'hoa', text: 'HOA covers' };
  if (/owner|landlord/.test(t)) return { who: 'owner', text: 'Owner / landlord pays' };
  if (/tenant|resident/.test(t)) return { who: 'tenant', text: 'Tenant responsible' };
  return { who: 'other', text: squash(raw) };
}

// ---------- custom fields: categories -> fields ----------
// Rentvine returns /custom-fields/values/5/{pid} as [{ customFieldCategoryID, name?, fields:[{customFieldID,name,fieldTypeID,value}] }].
export function readCategories(cats) {
  const out = [];
  for (const c of Array.isArray(cats) ? cats : []) {
    const name = squash(c.name || c.categoryName || c.label || c.title || '');
    const fields = (Array.isArray(c.fields) ? c.fields : []).map((f) => ({
      id: String(f.customFieldID || f.id || ''), name: squash(f.name || f.label || ''), value: f.value == null ? '' : String(f.value),
    })).filter((f) => f.name);
    if (fields.length) out.push({ id: String(c.customFieldCategoryID || ''), name, fields });
  }
  return out;
}

const TOGGLE_ON = /^(1|true|yes)$/i;
const APPLIANCE_CATS = /dishwasher|refrigerator|range|stove|oven|washing|washer|dryer|microwave|garbage|disposal|water softener|water heater|hvac|a\/c|air condition|furnace|heater|irrigation|garage/i;

export function applianceRows(categories) {
  const rows = [];
  for (const c of categories) {
    if (!APPLIANCE_CATS.test(c.name)) continue;
    const row = { name: c.name, included: null, brand: '', model: '', serial: '', purchased: '', replaced: '', other: [] };
    for (const f of c.fields) {
      const n = f.name.toLowerCase(), v = squash(f.value);
      if (v === '') continue;
      if (/included\??$/.test(n)) row.included = TOGGLE_ON.test(v);
      else if (/brand/.test(n)) row.brand = v;
      else if (/model/.test(n)) row.model = v;
      else if (/serial/.test(n)) row.serial = v;
      else if (/purchas|install/.test(n) && isDate(v)) row.purchased = day(v);
      else if (/replace/.test(n) && isDate(v)) row.replaced = day(v);
      else if (c.name.toLowerCase() === f.name.toLowerCase()) row.other.push({ name: f.name, value: v });
      else row.other.push({ name: f.name, value: v });
    }
    const has = row.included !== null || row.brand || row.model || row.serial || row.purchased || row.replaced || row.other.length;
    if (has) rows.push(row);
  }
  return rows;
}

// Dates that matter for warranties: anything with a date value in a maintenance-type field, plus the property's Warranty Expires.
export function warrantyRows(categories, warrantyExpires, today = todayPhoenix()) {
  const rows = [];
  for (const c of categories) {
    for (const f of c.fields) {
      if (!isDate(f.value)) continue;
      if (!/warrant|replac|install|purchas|paint|repair|service/i.test(f.name + ' ' + c.name)) continue;
      const d = day(f.value);
      rows.push({ label: f.name, category: c.name, date: d, ageDays: daysBetween(d, today) });
    }
  }
  rows.sort((a, b) => b.date.localeCompare(a.date));
  const hw = categories.flatMap((c) => c.fields).find((f) => /home warranty$/i.test(f.name));
  const out = { dates: rows, homeWarrantyOn: hw ? TOGGLE_ON.test(squash(hw.value)) : null, homeWarrantyExpires: null, expiresInDays: null };
  if (isDate(warrantyExpires)) { out.homeWarrantyExpires = day(warrantyExpires); out.expiresInDays = daysBetween(today, day(warrantyExpires)); }
  return out;
}

// Pull a "Warranty Expires" style date out of whatever the property record looks like.
export function findWarrantyExpires(detail, depth = 0) {
  if (!detail || typeof detail !== 'object' || depth > 4) return '';
  for (const [k, v] of Object.entries(detail)) {
    if (/warranty.?expir/i.test(k) && isDate(v)) return day(v);
    if (v && typeof v === 'object') { const f = findWarrantyExpires(v, depth + 1); if (f) return f; }
  }
  return '';
}
export function findNotes(detail, depth = 0) {
  if (!detail || typeof detail !== 'object' || depth > 4) return '';
  for (const [k, v] of Object.entries(detail)) {
    if (/^maintenance.?notes$/i.test(k) && typeof v === 'string') return v;
    if (v && typeof v === 'object') { const f = findNotes(v, depth + 1); if (f) return f; }
  }
  return '';
}

// ---------- hints: rule-based "what to look at" (plain data, no AI) ----------
const TOPICS = [
  ['HVAC / A/C', /\ba\/?c\b|hvac|air condition|cooling|furnace|heat pump|thermostat/i],
  ['Plumbing', /plumb|leak|toilet|faucet|drain|clog|water heater|sewer|pipe/i],
  ['Irrigation / yard', /irrigat|sprinkler|landscap|yard|tree|lawn/i],
  ['Appliance', /dishwasher|refrigerator|fridge|washer|dryer|oven|stove|range|microwave|disposal/i],
  ['Electrical', /electric|outlet|breaker|light|fan/i],
  ['Roof', /roof/i],
  ['Pest', /pest|termite|roach|scorpion|ant\b/i],
];
export function topicOf(text) { const t = String(text || ''); const hit = TOPICS.find(([, re]) => re.test(t)); return hit ? hit[0] : 'Other'; }

export function buildHints({ history, openItems, warranty, appliances, services }, today = todayPhoenix()) {
  const hints = [];
  const recent = (history || []).filter((w) => w.created && daysBetween(w.created, today) <= 365);
  const byTopic = {};
  for (const w of recent) { const tp = topicOf(w.summary); if (tp !== 'Other') (byTopic[tp] = byTopic[tp] || []).push(w); }
  for (const [tp, list] of Object.entries(byTopic)) {
    if (list.length >= 3) hints.push({ level: 'watch', text: `${tp}: ${list.length} work orders in the last 12 months. Check whether a repeat problem needs a bigger fix.` });
  }
  if (warranty && warranty.expiresInDays != null) {
    if (warranty.expiresInDays < 0) hints.push({ level: 'info', text: `Home warranty expired ${day(warranty.homeWarrantyExpires)}.` });
    else if (warranty.expiresInDays <= 90) hints.push({ level: 'watch', text: `Home warranty expires ${day(warranty.homeWarrantyExpires)} (${warranty.expiresInDays} days). Use it before then if a claim is possible.` });
  }
  for (const o of openItems || []) {
    const hit =(appliances || []).find((a) => (a.purchased || a.replaced) && new RegExp(a.name.split(/[ /]/)[0], 'i').test(o.summary));
    if (hit) {
      const d = hit.replaced || hit.purchased, age = daysBetween(d, today);
      if (age != null && age >= 0 && age < 365 * 2) hints.push({ level: 'watch', text: `Open WO ${o.number || o.id} mentions the ${hit.name.toLowerCase()}, recorded as ${hit.replaced ? 'replaced' : 'purchased'} ${d}. It may still be under warranty.` });
    }
  }
  for (const s of services || []) {
    if (s.who === 'unknown') hints.push({ level: 'info', text: `${s.label}: who is responsible is not recorded in Rentvine.` });
  }
  return hints;
}
