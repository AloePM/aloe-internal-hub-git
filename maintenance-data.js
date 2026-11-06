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
    if (!g) { g = { propertyId: pid, address: squash(wo._unitAddress || wo.unitAddress), openCount: 0, moveOutCount: 0, oldest: null, items: [] }; map.set(pid, g); }
    if (!g.address) g.address = squash(wo._unitAddress || wo.unitAddress);
    const created = day(wo.dateTimeCreated);
    const statusId = Number(wo.workOrderStatusID || 0);
    g.openCount++;
    if (statusId === 23) g.moveOutCount = (g.moveOutCount || 0) + 1;
    if (created && (!g.oldest || created < g.oldest)) g.oldest = created;
    g.items.push({ id: String(wo.workOrderID || ''), number: String(wo.workOrderNumber || ''), created, summary: (stripHtml(wo.agentSummary) || stripHtml(wo.description)).slice(0, 160), statusId, moveOut: statusId === 23 });
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
    const row = { name: c.name, included: null, brand: '', model: '', serial: '', purchased: '', replaced: '', warrantyExpires: '', other: [] };
    for (const f of c.fields) {
      const n = f.name.toLowerCase(), v = squash(f.value);
      if (v === '') continue;
      if (/included\??$/.test(n)) row.included = TOGGLE_ON.test(v);
      else if (/brand/.test(n)) row.brand = v;
      else if (/model/.test(n)) row.model = v;
      else if (/serial/.test(n)) row.serial = v;
      else if (/warrant|expires/.test(n) && isDate(v)) row.warrantyExpires = day(v);
      else if (/purchas|install/.test(n) && isDate(v)) row.purchased = day(v);
      else if (/replace/.test(n) && isDate(v)) row.replaced = day(v);
      else if (c.name.toLowerCase() === f.name.toLowerCase()) row.other.push({ name: f.name, value: v });
      else row.other.push({ name: f.name, value: v });
    }
    const has = row.included !== null || row.brand || row.model || row.serial || row.purchased || row.replaced || row.warrantyExpires || row.other.length;
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

// Owner preferred vendor / warranty-vendor fields (HVAC, Roof, Builder warranty, Landscaper for trees or irrigation).
export function ownerVendors(categories) {
  const out = [];
  for (const c of categories) {
    if (!/owner preferred vendor/i.test(c.name)) continue;
    for (const f of c.fields) { const v = squash(f.value); if (v) out.push({ name: f.name, value: v }); }
  }
  return out;
}

// Home warranty card: on/off, company, expiry (custom field first, then the property's Warranty Expires), policy, whether a login is on file.
export function homeWarrantyInfo(categories, propertyWarrantyExpires, today = todayPhoenix()) {
  const flat = categories.flatMap((c) => c.fields.map((f) => ({ ...f, cat: c.name })));
  const get = (re) => { const f = flat.find((x) => re.test(x.name)); return f ? squash(f.value) : ''; };
  const toggle = flat.find((f) => /^home warranty$/i.test(f.name));
  const company = get(/home warranty company/i), policy = get(/home warranty policy/i), login = get(/home warranty login/i);
  const exp = [get(/home warranty expiration/i), propertyWarrantyExpires].find((d) => isDate(d)) || '';
  return {
    on: toggle ? TOGGLE_ON.test(squash(toggle.value)) : null, company, policy, loginOnFile: !!login, login,
    expires: exp ? day(exp) : '', expiresInDays: exp ? daysBetween(today, day(exp)) : null,
  };
}

// ---------- 36-month work order history (own mapper; Move-outs code is not touched) ----------
const STATUS = { 1: 'Open', 6: 'Estimating', 21: 'Troubleshooting Steps Sent', 28: 'HVAC Tune Ups', 4: 'Requested', 24: 'Internal Work Order Request', 25: 'Unit Turn', 26: 'Home Warranty', 22: 'Renewal Walk Through', 23: 'Move Out', 14: 'Scheduled', 5: 'On Hold', 2: 'Completed', 7: 'Rejected', 18: 'Completed Already Billed', 3: 'Cancelled', 27: 'Waiting for parts', 31: 'Owner Maintained' };
const stripHtml = (s) => squash(String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
export function mapHistory(raw, now = new Date(), months = 36) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.data) ? raw.data : [];
  const cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - months);
  const out = [];
  for (const it of list) {
    const w = (it && it.workOrder) || it || {}; const c = (it && it.contact) || {};
    const created = day(w.dateTimeCreated);
    if (!created || new Date(created + 'T12:00:00Z') < cutoff) continue;
    const sid = Number(w.workOrderStatusID);
    const summary = stripHtml(w.agentSummary) || stripHtml(w.description);
    const est = parseFloat(w.estimatedAmount);
    out.push({
      id: String(w.workOrderID || ''), number: String(w.workOrderNumber || ''), created, closed: day(w.dateClosed) || null,
      scheduled: day(w.scheduledStartDate) || null, statusId: sid || 0, status: STATUS[sid] || (sid ? 'Status ' + sid : ''), vendor: squash(c.name),
      summary: summary.length > 280 ? summary.slice(0, 280) + '...' : summary, estimated: isFinite(est) && est > 0 ? est : null,
    });
  }
  out.sort((a, b) => b.created.localeCompare(a.created));
  return out;
}

// ---------- "Before you assign" card ----------
const ITEMS = [
  ['garbage disposal', /disposal/i], ['dishwasher', /dishwasher/i], ['refrigerator', /fridge|refrigerator|freezer|ice ?maker/i],
  ['washer', /washer|washing machine/i], ['dryer', /dryer/i], ['water heater', /water heater/i], ['A/C', /\ba\/?c\b|air condition|cooling|hvac/i],
  ['heating', /\bheat(ing)?\b|furnace/i], ['toilet', /toilet/i], ['irrigation / sprinklers', /irrigat|sprinkler/i], ['garage door', /garage door/i],
  ['smoke detector', /smoke|carbon monoxide/i], ['oven / stove', /\boven\b|stove|\brange\b/i], ['microwave', /microwave/i], ['roof', /roof/i],
  ['pest', /pest|termite|roach|scorpion|\bbees?\b|\bants?\b/i], ['plumbing leak', /leak/i], ['drain / clog', /drain|clog/i],
];
export function itemOf(text) { const t = String(text || ''); const hit = ITEMS.find(([, re]) => re.test(t)); return hit ? hit[0] : ''; }

export function repeatsFor(open, history, months = 36) {
  const item = itemOf(open.summary);
  if (!item) return null;
  const prior = (history || []).filter((w) => w.id !== open.id && w.statusId !== 3 && itemOf(w.summary) === item);
  if (!prior.length) return null;
  const withVendor = prior.find((w) => w.vendor);
  return { item, total: prior.length + 1, months, lastVendor: withVendor ? withVendor.vendor : '', lastVendorWO: withVendor ? withVendor.number : '', lastVendorDate: withVendor ? withVendor.created : '',
    prior: prior.slice(0, 5).map((w) => ({ number: w.number, created: w.created, status: w.status, vendor: w.vendor, summary: w.summary.slice(0, 120) })) };
}
const ORD = ['', '', 'second', 'third', 'fourth', 'fifth'];
const VENDOR_FIELD = [[/^(A\/C|heating)$/, /hvac/i], [/^roof$/, /roof/i], [/^irrigation/, /landscap|irrigation/i]];
const SERVICE_FOR = [[/^pest$/, /pest/i], [/^irrigation/, /landscap/i]];

// "Do now" guidance for the person assigning the vendor: a priority label and the first steps, like Ari's Slack triage. Fixed rules, no guessing beyond
// the keywords already used for the emergency flag and the issue type. Wording is plain text for staff; the owner of the hub can edit it here.
const FLAG_RULES = {
  'Active leak': { p: 'Emergency', tenant: 'Text the tenant now: shut off the valve behind the fixture, or the main water shutoff if there is no local valve. Ask for a photo.', trade: 'plumber' },
  'Water damage': { p: 'Emergency', tenant: 'Text the tenant now: shut off the main water if the source is unknown, move belongings away from the wet area, and send photos.', trade: 'plumber or water mitigation vendor' },
  'Sewage': { p: 'Emergency', tenant: 'Text the tenant now: stop using the affected sinks, toilets and showers until the vendor arrives.', trade: 'plumber' },
  'No A/C': { p: 'Emergency', tenant: 'Text the tenant: check that the thermostat is set to Cool and the breaker has not tripped. Ask if anyone in the home is elderly, an infant or medically vulnerable.', trade: 'HVAC vendor' },
  'No heat': { p: 'Emergency', tenant: 'Text the tenant: check that the thermostat is set to Heat and the breaker has not tripped. Ask if anyone in the home is elderly, an infant or medically vulnerable.', trade: 'HVAC vendor' },
  'No hot water': { p: 'Urgent', tenant: 'Text the tenant: check the water heater breaker or pilot light and tell us what you see.', trade: 'plumber' },
  'No power': { p: 'Urgent', tenant: 'Text the tenant now: stay away from any sparking or hot outlet, switch that breaker off if it is safe, and leave and call 911 if there is smoke or a burning smell.', trade: 'electrician' },
  'Gas smell': { p: 'Emergency', tenant: 'Text the tenant now: leave the home, use no flames or switches, and call the gas company and 911 from outside.', trade: '', after: 'Dispatch a vendor only after the gas company says it is safe.' },
  'Fire / smoke': { p: 'Emergency', tenant: 'Confirm everyone is safe and that 911 was called.', trade: 'restoration vendor' },
  'Lockout / security': { p: 'Urgent', tenant: 'Confirm the tenant is safe and where they are.', trade: 'locksmith or board-up vendor' },
};
const ITEM_TIPS = [
  [/^garbage disposal$/, 'Ask the tenant to press the reset button on the bottom of the unit first. They should never put a hand inside.'],
  [/^(dishwasher|washer|dryer|refrigerator|microwave|oven \/ stove)$/, 'Confirm the appliance came with the home (move-in) and was not installed by the tenant before assigning a vendor.'],
  [/^(toilet|drain \/ clog)$/, 'Ask the tenant whether a plunger was tried. If it is a clog, check who pays before assigning.'],
  [/^smoke detector$/, 'Ask the tenant to try a new battery. If it is hardwired and still chirping, assign an electrician.'],
  [/^garage door$/, 'Ask the tenant to check the remote battery and the sensors near the floor, and to send a short video.'],
  [/^roof$/, 'Ask for photos of the ceiling and where the water comes in. Check the roof warranty below.'],
  [/^water heater$/, 'Ask the tenant to check the breaker or pilot light. If it is leaking, they should shut off the cold water valve on top of the heater.'],
  [/^(A\/C|heating)$/, 'Ask the tenant to check the filter and send a photo of the thermostat.'],
];
export function doNowFor({ o, item, flag, homeWarranty = {}, pref = [], rep = null }) {
  if (o.statusId === 23 || o.statusId === 25) return null;
  const rule = FLAG_RULES[flag] || null;
  let priority = rule ? rule.p : 'Routine';
  const steps = [];
  if (rule) {
    steps.push(rule.tenant);
    if (rule.after) steps.push(rule.after);
    else if (!o.vendor) steps.push('Dispatch a ' + rule.trade + ' right away.');
    else steps.push('Confirm ' + o.vendor + ' has the tenant contact and a time for today.');
  } else {
    const tip = ITEM_TIPS.find(([re]) => re.test(item));
    if (tip) { steps.push(tip[1]); if (/^water heater$/.test(item)) priority = 'Urgent'; }
  }
  const hwOn = (homeWarranty.on === true || homeWarranty.company) && !(homeWarranty.expiresInDays != null && homeWarranty.expiresInDays < 0);
  if (hwOn && !o.vendor) steps.push('Home warranty is on file: open the claim before assigning a vendor.');
  if (pref.length && !o.vendor) steps.push('The owner has a preferred vendor or warranty for this (see below). Use them.');
  if (rep && rep.total >= 3) steps.push('This is a repeat issue. Ask the owner about a bigger fix or a different vendor.');
  if (!o.vendor && steps.length) steps.push('Tell the tenant who is coming and when, within 24 business hours.');
  if (!steps.length) return o.vendor ? null : { priority, steps: ['Assign a vendor, then update the tenant within 24 business hours.'] };
  return { priority, steps };
}

// One card per open work order: everything Ari flags in Slack, in front of the person who assigns the vendor.
export function assignCards(openItems, ctx, today = todayPhoenix()) {
  const { history = [], homeWarranty = {}, ownerVendors: ov = [], notes = '', appliances = [], services = [] } = ctx || {};
  return (openItems || []).map((o) => {
    const items = [];
    const add = (level, text) => items.push({ level, text });
    if (o.statusId === 23) add('info', 'Move-out work order. It also shows on the Move-outs page.');
    if (o.statusId === 25) add('info', 'Unit turn. Persia or Teri handle this stage, not Roberto.');
    if (homeWarranty.on === true || homeWarranty.company) {
      if (homeWarranty.expiresInDays != null && homeWarranty.expiresInDays < 0) add('info', `Home warranty on file but expired ${homeWarranty.expires}${homeWarranty.company ? ' (' + homeWarranty.company + ')' : ''}.`);
      else add('stop', `Home warranty on file${homeWarranty.company ? ': ' + homeWarranty.company : ''}${homeWarranty.expires ? ', expires ' + homeWarranty.expires : ''}. Check whether it covers this before assigning a vendor.`);
    }
    const item = itemOf(o.summary);
    const vf = VENDOR_FIELD.find(([re]) => re.test(item));
    const pref = ov.filter((x) => (vf && vf[1].test(x.name)) || /builder warranty/i.test(x.name));
    for (const x of pref) add('stop', `Owner preferred vendor / warranty (${x.name}): ${x.value}`);
    if (!pref.length && ov.length) add('info', 'Owner has other preferred vendors on file (see the property panel).');
    const rep = repeatsFor(o, history);
    if (rep) {
      const nth = ORD[rep.total] || rep.total + 'th';
      add(rep.total >= 3 ? 'stop' : 'watch', `This is the ${nth} ${rep.item} work order in ${rep.months} months.${rep.lastVendor ? ` Last handled by ${rep.lastVendor} (#${rep.lastVendorWO}, ${rep.lastVendorDate}).` : ''}`);
    }
    const key = item.split(/[ /]/)[0];
    const ap = key ? appliances.find((a) => new RegExp(key, 'i').test(a.name)) : null;
    if (ap) {
      const d = ap.replaced || ap.purchased, age = d ? daysBetween(d, today) : null;
      if (ap.warrantyExpires && daysBetween(today, ap.warrantyExpires) >= 0) add('stop', `${ap.name}: warranty runs until ${ap.warrantyExpires}.`);
      if (age != null && age >= 0 && age < 730) add('watch', `${ap.name} was ${ap.replaced ? 'replaced' : 'purchased'} ${d}. It may still be under warranty.`);
      else if (age != null && age >= 365 * 10) add('watch', `${ap.name} is about ${Math.floor(age / 365)} years old. A repair may not be worth it.`);
      if (ap.serial) add('info', `${ap.name} serial on file: ${ap.serial}.`);
    }
    const sv = SERVICE_FOR.find(([re]) => re.test(item));
    const svc = sv ? services.find((s) => sv[1].test(s.label)) : null;
    if (svc && (svc.who === 'owner' || svc.who === 'hoa')) add('stop', `${svc.label}: ${svc.text}. Do not charge the tenant.`);
    else if (svc && svc.who === 'tenant') add('info', `${svc.label}: tenant is responsible.`);
    if (squash(notes)) add('watch', 'Maintenance notes are on file for this home. Read them below before assigning.');
    if (!items.length) add('ok', 'Nothing flagged from what is recorded in Rentvine.');
    const doNow = doNowFor({ o, item, flag: emergencyFlag(o.summary), homeWarranty, pref, rep });
    return { id: o.id, number: o.number, summary: o.summary, status: o.status, statusId: o.statusId, created: o.created, vendor: o.vendor, doNow, items };
  });
}

// ---------- per-work-order rows for the "By work order" view ----------
// Possible emergency: keyword guess on the description (tenant-chosen priority is not used).
const EMERGENCY = [
  ['Active leak', /\b(active|ongoing|running|spraying|gushing|burst|bursting|flooding|flooded|flood)\b[^.]{0,40}\b(leak|water|pipe)|\bleak(s|ing|ed)?\b/i],
  ['Water damage', /water damage|flood|burst pipe|pipe burst|ceiling.{0,15}(collaps|dripping)/i],
  ['No A/C', /no (a\/?c|ac\b|air ?conditioning|cooling)|(a\/?c|ac|air ?conditioner|air conditioning)[^.]{0,25}(not (working|cooling|blowing)|isn'?t (working|cooling)|(is )?(out|down|broken))|not cooling|won'?t cool/i],
  ['No heat', /no heat\b|(heat|heater|furnace|heating)[^.]{0,25}(not working|isn'?t working|out|broken|won'?t)/i],
  ['No power', /no (power|electricity)|power (is )?out|sparking|sparks|burning smell/i],
  ['Gas smell', /gas (smell|leak)|smell(s)? (of )?gas/i],
  ['Sewage', /sewage|sewer (back|smell)|backing up|backed up/i],
  ['No hot water', /no hot water/i],
  ['Fire / smoke', /\bfire\b|smoke damage/i],
  ['Lockout / security', /locked out|lockout|break.?in|broken (door|window)|can'?t lock/i],
];
export function emergencyFlag(text) {
  const t = squash(text);
  if (!t) return '';
  const yard = /irrigat|sprinkler|\byard\b|hose bib|lawn/i.test(t) && !/\b(house|inside|ceiling|wall|kitchen|bath|sink|toilet|water heater)\b/i.test(t);
  for (const [label, re] of EMERGENCY) { if (label === 'Active leak' && yard) continue; if (re.test(t)) return label; }
  return '';
}

// Work order "stage" names (same names Aptly's Work Orders board uses for these Rentvine statuses) and the order sections are shown in.
export const STAGE_ORDER = ['Open', 'Estimating', 'Troubleshooting Steps Sent', 'Internal Work Order Request', 'Home Warranty', 'Requested', 'Scheduled', 'Waiting for parts', 'On Hold', 'Owner Maintained', 'HVAC Tune Ups', 'Move Out', 'Unit Turn', 'Renewal Walk Through'];
// records = rows from Rentvine /maintenance/work-orders ({workOrder, contact, unit, property}). Open rule matches the hub Home page.
export function buildWorkOrderRows(records, today = todayPhoenix()) {
  const out = [];
  for (const rec of Array.isArray(records) ? records : []) {
    const wo = (rec && rec.workOrder) || rec || {};
    if (!wo.workOrderID) continue;
    const primary = parseInt(wo.primaryWorkOrderStatusID || 0);
    if (primary === 3 || primary === 5 || wo.closedDate || wo.dateClosed) continue;
    const pid = String(wo.propertyID || (rec.property && rec.property.propertyID) || '');
    const sid = Number(wo.workOrderStatusID || 0);
    const summary = stripHtml(wo.agentSummary) || stripHtml(wo.description);
    const created = day(wo.dateTimeCreated);
    const c = (rec && rec.contact) || {};
    out.push({
      id: String(wo.workOrderID), number: String(wo.workOrderNumber || ''), propertyId: /^\d{1,9}$/.test(pid) ? pid : '',
      address: squash((rec.unit && (rec.unit.address || rec.unit.name)) || (rec.property && rec.property.address) || wo.unitAddress || ''),
      created, ageDays: created ? daysBetween(created, today) : null, statusId: sid, stage: STATUS[sid] || (sid ? 'Status ' + sid : 'Unknown'),
      vendor: squash(c.name), summary: summary.length > 200 ? summary.slice(0, 200) + '...' : summary,
      issue: itemOf(summary) || 'Other', emergency: emergencyFlag(summary), moveOut: sid === 23,
      team: sid === 25 ? 'Persia / Teri' : 'Roberto', scheduled: day(wo.scheduledStartDate) || null,
    });
  }
  return out;
}
