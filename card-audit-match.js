// card-audit-match.js — matches company card charges to Rentvine reimbursement bills.
// Pure functions only (no network), so it can be tested on its own.
//
// Colors:
//   green  = exact match, a group of bills that adds up exactly, or a bill on the same vendor
//            that is higher than the charge by up to MARKUP_MAX (markup or supplies + labor)
//   orange = likely match that needs a look (bill lower than charge, more than MARKUP_MAX higher,
//            matched on amount only, or billed more than LATE_DAYS after the charge)
//   red    = no bill found after GRACE_DAYS, or a possible double bill
//   grey   = pending, refunded, too new, or marked by a person

export const DEFAULTS = { MARKUP_MAX: 300, LATE_DAYS: 30, GRACE_DAYS: 7, WIN_BEFORE: 21, WIN_AFTER: 45, LONG_WIN: 150 };

const DAY = 86400000;
export function dayNum(s) {
  if (!s) return null;
  if (s instanceof Date) return Math.floor(s.getTime() / DAY);
  const t = String(s).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY);
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return Math.floor(Date.UTC(y, +m[1] - 1, +m[2]) / DAY); }
  const d = Date.parse(t);
  return isNaN(d) ? null : Math.floor(d / DAY);
}
export const isoDay = (n) => (n == null ? '' : new Date(n * DAY).toISOString().slice(0, 10));
export function money(v) {
  if (typeof v === 'number') return Math.round(v * 100);
  const s = String(v ?? '').replace(/[$,\s]/g, '');
  const neg = /^\(.*\)$/.test(s);
  const n = parseFloat(s.replace(/[()]/g, ''));
  return isNaN(n) ? 0 : Math.round((neg ? -n : n) * 100);
}

// Words that tie a card merchant to the text Aloe staff put on bills.
const VENDOR_HINTS = [
  [/HOME ?DEPOT|HOMEDEPOT/, ['hd', 'home depot', 'sku', 'homedepot']],
  [/LOWE'?S/, ['lowes', "lowe's"]],
  [/AMAZON|AMZN/, ['amazon', 'sold by']],
  [/SPENCER/, ['spencer', /\bnt\d{3,}/, 'dishwasher', 'washer', 'dryer', 'range', 'frig', 'microwave']],
  [/J\s*&?\s*G APPLIANCE/, ['j&g', 'j & g', 'jg', 'j g']],
  [/FIVE TWO ZERO|520 APPL/, ['520', 'five two zero']],
  [/COOLTIMES|COOL TIMES/, ['cool times', 'cooltimes', 'cool time', 'service:mp', 'sales ']],
  [/GLISTENING/, ['glisten', 'pool']],
  [/TREVAS/, ['trevas', 'pool']],
  [/SLIDE ?RIGHT/, ['slide right', 'slideright', 'slider']],
  [/BUG GUYS/, ['az bug', 'bug guy', 'bug spray', 'pest']],
  [/T2 PEST|GREEN MACHINE|CITY WIDE PEST/, ['termite', 'tarf', 'pest', 'green machine', 'city wide']],
  [/JE ELITE|CLEANING|CARPET/, ['clean', 'carpet', 'residential']],
  [/HOME WARRANTY|HOME PROTECT|HOME W|FIRST AM|AHS|FIDELITY|CHOICE HOME|OLD REPUBLIC|SEARS HOME/, ['home warranty', 'trade fee', 'choice', 'chw', 'old republic', 'first am', 'fidelity', 'ahs', 'sears']],
  [/TRESTLE|CITY PROPERTY|ALTERRA|HOMEOWNERS|OGDEN|HOA|COMMUNITY/, ['hoa', 'registration', 'pool key']],
  [/ARIZONA PUBLIC SERVICE|\bAPS\b|ED-3|ELECTRIC DIST/, ['aps', 'ed 3', 'ed-3', 'electric']],
  [/CITY OF CHANDLER|GLOBAL WATER|WATER RES|EPCOR/, ['water', 'utility', 'sewer', 'city of chandler']],
  [/HULL HOLLIDAY|WOLNIK|LANDLORD SERV|JUST CRT|COURT/, ['legal', 'attorney', 'notice', 'hull', 'court', 'landlord']],
  [/AO SMITH|STATE WATER/, ['state water', 'a.o', 'ao smith', 'pilot', 'water heater']],
  [/PARKER LOC|LOCK/, ['parker', 'rekey', 'lock', 'deadbolt']],
  [/PLUMBING|ROOTER|RCS|JTB/, ['plumb', 'rcs', 'drain', 'faucet']],
  [/COOLING|HEATING|\bAIR\b|HVAC|GOOD AC/, ['hvac', 'ac ', 'cooling', 'air', 'trade fee']],
  [/ROOF/, ['roof']],
];
const STOP = new Set(['THE', 'LLC', 'INC', 'CORP', 'WEB', 'MKTPL', 'COMPANY', 'GROUP', 'SERVICE', 'SERVICES', 'ARIZONA', 'PAYPAL', 'AND', 'FOR']);

const GENERIC = new Set(['pest', 'pool', 'clean', 'residential', 'water', 'utility', 'sewer', 'electric', 'plumb', 'drain', 'faucet', 'hvac', 'ac ', 'cooling', 'air', 'trade fee', 'home warranty', 'lock', 'legal', 'notice', 'registration', 'hoa', 'sku', 'dishwasher', 'washer', 'dryer', 'range', 'frig', 'microwave', 'termite', 'pilot', 'water heater', 'sales ', 'service:mp', 'deadbolt', 'carpet', 'court', 'attorney', 'pool key', 'roof']);
export function hintsFor(merchant) {
  const m = String(merchant || '').toUpperCase().replace(/&AMP;/g, '&');
  const curated = [];
  for (const [re, words] of VENDOR_HINTS) if (re.test(m)) curated.push(...words);
  // Words from the merchant name only help pick between exact-amount bills; they never make a
  // non-exact match on their own (a word like "control" or "city" shows up in unrelated bills).
  const names = [];
  for (const w of m.replace(/^(IN|SQ|PY|PB|HDN|SP|TST)\s*\*+\s*/, '').split(/[^A-Z0-9]+/)) if (w.length >= 5 && !STOP.has(w) && !COMMON.has(w) && !/\d/.test(w)) names.push(new RegExp('\\b' + w.toLowerCase() + '\\b'));
  const out = [...curated, ...names];
  out.strong = curated.filter((h) => h instanceof RegExp || !GENERIC.has(h));
  out.names = names;
  return out;
}
const COMMON = new Set(['CONTROL', 'REPAIR', 'APPLIANCE', 'PLUMBING', 'HEATING', 'COOLING', 'ELECTRIC', 'ELECTRICAL', 'CLEANING', 'SUPPLY', 'DEPOT', 'STORE', 'MARKET', 'MKTPLACE', 'AMAZON', 'HOMEOWNERS', 'MANAGEMENT', 'SYSTEMS', 'DOORS', 'GLASS', 'WATER', 'HOME', 'PROTECT', 'WARRANTY', 'NATIONAL', 'CONSTRUCTION', 'LIGHTING', 'SLIDING', 'RESOURCES', 'PUBLIC', 'CHANDLER', 'MARICOPA', 'PHOENIX']);
const strongOf = (hints) => hints.strong || [];
const SAFE_GENERIC = new Set(['home warranty', 'trade fee', 'registration', 'hoa', 'pool key', 'electric', 'water', 'sewer', 'utility', 'legal', 'attorney', 'notice', 'court']);
function textHit(hints, text) {
  const t = ' ' + String(text || '').toLowerCase() + ' ';
  return hints.some((h) => (h instanceof RegExp ? h.test(t) : h.length <= 3 ? new RegExp('(^|[^a-z0-9&])' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])').test(t) : t.includes(h)));
}

const SUPPLY = /HOME ?DEPOT|HOMEDEPOT|LOWE'?S|AMAZON|AMZN|AO SMITH|FAN COMPAN|FAN MAN|HUNTER FAN|ACE HARDWARE|FERGUSON|SUPPLY|WALMART|TARGET|COSTCO/i;
const isCardPayment = (c) => c.amount < 0 && /PAYMENT|AUTOPAY|THANK YOU/i.test(c.description);

/**
 * charges: [{ id, date, description, amount (cents, + = charge, - = refund), pending, card }]
 * bills:   [{ billID, date, propertyID, address, amount (cents), description, reference, payee }]
 * marks:   { [chargeId]: { status, note, by, at } }   status: 'company' | 'reimbursed' | 'ignore'
 */
/**
 * homes (optional): { [propertyID]: { address, fields: { 'Pool provider': 'Glistening Pools 480…', … }, notes: '…' } }
 *   from Rentvine property custom fields. A field naming the charge's vendor tells us which homes that vendor serves.
 */
export function matchAll(chargesIn, billsIn, { today, marks = {}, opts = {}, homes = {} } = {}) {
  const O = { ...DEFAULTS, ...opts };
  const todayN = dayNum(today) ?? Math.floor(Date.now() / DAY);
  const homeList = Object.entries(homes || {});
  const charges = chargesIn.filter((c) => !isCardPayment(c)).map((c) => {
    const hints = hintsFor(c.description);
    const clue = [...strongOf(hints), ...(hints.names || [])];
    // Homes whose provider fields name this vendor (used to confirm or rule out a bill's home),
    // and homes whose maintenance notes mention it (used only as a suggestion).
    const fieldHomes = new Map(), noteHomes = new Map();
    if (clue.length) for (const [pid, h] of homeList) {
      for (const [label, val] of Object.entries(h.fields || {})) if (val && textHit(clue, val)) { fieldHomes.set(String(pid), { address: h.address, field: label }); break; }
      if (!fieldHomes.has(String(pid)) && h.notes && textHit(clue, h.notes)) noteHomes.set(String(pid), { address: h.address, field: 'Maintenance notes' });
    }
    return { ...c, d: dayNum(c.date), hints, clue, strong: strongOf(hints), supply: SUPPLY.test(c.description || ''),
      homes: fieldHomes.size <= 40 ? fieldHomes : new Map(), noteHomes: noteHomes.size <= 15 ? noteHomes : new Map(), bills: [], color: null, reasons: [] };
  });
  // A bill is on a home that Rentvine says a DIFFERENT company services for this vendor's kind of work.
  const wrongHome = (c, b) => c.homes.size > 0 && b.propertyID && !c.homes.has(String(b.propertyID));
  const all = billsIn.map((b) => ({ ...b, d: dayNum(b.date), text: `${b.description || ''} ${b.reference || ''} ${b.payee || ''}`, used: null }));
  const bills = all.filter((b) => !b.vendorBill);            // reimbursement / Aloe PM-Vendor bills
  const vendorBills = all.filter((b) => b.vendorBill);       // bills payable to the vendor itself
  const free = (b) => !b.used;
  const inWinNE = (c, b) => b.d != null && c.d != null && b.d - c.d >= -3 && b.d - c.d <= O.WIN_AFTER;
  const inWin = (c, b, long) => b.d != null && c.d != null && b.d - c.d >= -O.WIN_BEFORE && b.d - c.d <= (long ? O.LONG_WIN : O.WIN_AFTER);
  const assign = (c, list, color, reason) => { for (const b of list) b.used = c.id; c.bills = list; c.color = color; c.reasons.push(reason); };
  const lateNote = (c) => { const late = Math.max(...c.bills.map((b) => b.d - c.d)); if (late > O.LATE_DAYS) { c.color = 'orange'; c.reasons.push(`billed ${late} days after the charge`); } };

  // 0. Refunds cancel the matching sale (same merchant family, same amount, within 60 days).
  const sales = charges.filter((c) => c.amount > 0);
  for (const r of charges.filter((c) => c.amount < 0)) {
    const s = sales.filter((c) => !c.color && c.amount === -r.amount && Math.abs(c.d - r.d) <= 60 && (c.hints.some((h) => r.hints.includes(h))))
      .sort((a, b) => Math.abs(a.d - r.d) - Math.abs(b.d - r.d))[0];
    if (s) { s.color = r.color = 'grey'; s.reasons.push('refunded'); r.reasons.push('refund of an earlier charge'); s.pairedWith = r.id; r.pairedWith = s.id; }
    else { r.color = 'grey'; r.reasons.push('refund (no matching charge in this period)'); }
  }
  for (const c of charges) if (c.pending && !c.color) { c.color = 'grey'; c.reasons.push('pending at the bank'); }
  const open = () => charges.filter((c) => !c.color && c.amount > 0).sort((a, b) => b.amount - a.amount);
  const score = (c, b) => (textHit(c.clue, b.text) ? 100 : 0) + (c.homes.has(String(b.propertyID)) ? 100 : 0) - Math.abs(b.d - c.d);

  // 1. Exact amount, same vendor.  2. Exact amount, any vendor (orange).
  for (const pass of ['vendor', 'any', 'long']) {
    for (const c of open()) {
      const cands = bills.filter((b) => free(b) && b.amount === c.amount && inWin(c, b, pass === 'long') && !wrongHome(c, b) && (pass !== 'vendor' || textHit(c.clue, b.text) || c.homes.has(String(b.propertyID)) || textHit(c.hints.filter((h) => SAFE_GENERIC.has(h)), b.text) || (b.d - c.d >= -5 && b.d - c.d <= 10 && textHit(c.hints, b.text))));
      if (!cands.length) continue;
      const best = cands.sort((a, b) => score(c, b) - score(c, a))[0];
      // Is this the only open charge and the only free bill with this amount around this date?
      const rivals = open().filter((o) => o !== c && o.amount === c.amount && Math.abs(o.d - c.d) <= 14).length;
      const unique = cands.length === 1 && rivals === 0;
      if (pass === 'vendor') { assign(c, [best], 'green', 'exact match'); lateNote(c); }
      else if (pass === 'any' && unique && c.amount % 500 !== 0) { assign(c, [best], 'green', 'exact amount — the only bill with this amount around this date'); lateNote(c); }
      else if (pass === 'any') { if (!c.possible) c.possible = best; }
      else if (unique && textHit(c.clue, best.text)) { assign(c, [best], 'orange', `same amount, but billed ${best.d - c.d} days after the charge`); }
    }
  }

  // 2b. Owner pays it back in monthly installments ("payment 1 of 6").
  const plans = {};
  for (const b of bills) { const m = String(b.description).match(/payment\s+\d+\s+of\s+(\d+)/i); if (m) (plans[`${b.propertyID}|${b.reference}|${m[1]}`] ||= []).push(b); }
  for (const list of Object.values(plans)) {
    if (list.some((b) => b.used)) continue;
    const first = list.reduce((a, b) => (a.d <= b.d ? a : b));
    const total = list.reduce((s, b) => s + b.amount, 0);
    const c = open().find((c) => Math.abs(total - c.amount) <= 100 && inWin(c, first));
    if (c) { assign(c, list.sort((a, b) => a.d - b.d), 'green', `billed to the owner in ${list.length} monthly payments`); for (const b of list) b.plan = true; }
  }

  // 3. One charge covered by several bills of the same vendor (e.g. pool service for 8 homes).
  for (const c of open()) {
    const named = bills.filter((b) => free(b) && inWin(c, b) && textHit(c.strong, b.text));
    const key = (b) => String(b.description).trim().toLowerCase().slice(0, 28);
    const sameText = new Set(named.map(key).filter((t) => t.length > 8));
    const cands = bills.filter((b) => free(b) && b.amount > 0 && b.amount < c.amount && inWin(c, b) && !wrongHome(c, b) && (textHit(c.strong, b.text) || sameText.has(key(b)) || c.homes.has(String(b.propertyID)))).sort((a, b) => Math.abs(a.d - c.d) - Math.abs(b.d - c.d)).slice(0, 18);
    const pick = subsetSum(cands, c.amount, (b) => b.amount);
    if (pick) { assign(c, pick, 'green', `covered by ${pick.length} bills`); lateNote(c); }
  }

  // 4. Several charges billed as one bill (e.g. three Amazon orders on one bill).
  for (const b of bills.filter(free)) {
    const cands = open().filter((c) => c.amount < b.amount && inWin(c, b) && textHit(c.strong, b.text));
    const groups = {};
    for (const c of cands) (groups[c.hints[0] || c.description] ||= []).push(c);
    for (const g of Object.values(groups)) {
      if (g.length < 2) continue;
      const pick = subsetSum(g.slice(0, 15), b.amount, (c) => c.amount);
      if (pick) { for (const c of pick) { c.bills = [b]; c.color = 'green'; c.reasons.push(`billed together with ${pick.length - 1} other charge(s) on one bill`); } b.used = pick[0].id; break; }
    }
  }

  // 4b. The only bill is payable to the vendor itself, not to Reimbursements.
  for (const c of open()) {
    // Only bills whose PAYEE is this same vendor. A same-amount bill to another company is not this charge.
    const cands = vendorBills.filter((b) => free(b) && b.amount === c.amount && inWin(c, b) && b.payee && textHit(c.clue, b.payee));
    const pick = cands.length ? cands.sort((a, b) => score(c, b) - score(c, a))[0] : null;
    if (pick) { assign(c, [pick], 'orange', `bill is payable to the vendor${pick.payee ? ' (' + pick.payee + ')' : ''} instead of Reimbursements, so the card is not reimbursed and the vendor could be paid twice`); c.fixPayee = true; }
  }

  // 5. Bill higher than the charge (markup, or supplies billed with labor).
  for (const c of open().filter((c) => c.supply)) {
    const cands = bills.filter((b) => free(b) && b.amount > c.amount && b.amount <= c.amount * 3 + O.MARKUP_MAX * 100 && inWinNE(c, b) && !wrongHome(c, b) && textHit(c.strong, b.text)).sort((a, b) => (a.amount - b.amount) || (Math.abs(a.d - c.d) - Math.abs(b.d - c.d)));
    const b = cands[0];
    if (!b) continue;
    const gap = b.amount - c.amount;
    if (gap <= O.MARKUP_MAX * 100) { assign(c, [b], 'green', `bill is ${fmt(gap)} higher (markup or labor)`); lateNote(c); }
  }

  // 6. Bill lower than the charge (under-billed), then 6b. bill far higher than the charge.
  //    Pairs are chosen across all charges at once, closest date first, so one charge can't steal another's bill.
  const greedy = (ok, reason, win) => {
    const pairs = [];
    for (const c of open()) for (const b of bills) if (free(b) && win(c, b) && !wrongHome(c, b) && textHit(c.strong, b.text) && ok(c, b)) pairs.push([Math.abs(b.d - c.d) + Math.abs(b.amount - c.amount) / 10000, c, b]);
    pairs.sort((x, y) => x[0] - y[0]);
    for (const [, c, b] of pairs) if (!c.color && free(b)) assign(c, [b], 'orange', reason(c, b));
  };
  greedy((c, b) => b.amount < c.amount && b.amount >= c.amount * 0.75, (c, b) => `billed ${fmt(c.amount - b.amount)} less than the charge`, inWin);
  greedy((c, b) => c.supply && b.amount > c.amount + O.MARKUP_MAX * 100 && b.amount <= c.amount * 3 + O.MARKUP_MAX * 100, (c, b) => `bill is ${fmt(b.amount - c.amount)} higher than the charge — more than ${fmt(O.MARKUP_MAX * 100)}`, inWinNE);

  // 7. Nothing found.
  for (const c of open()) {
    const age = todayN - c.d;
    if (age > O.GRACE_DAYS) { c.color = 'red'; c.reasons.push(`no bill found (${age} days since the charge)`); }
    else { c.color = 'grey'; c.reasons.push(`new — waiting for a bill (${age} days old)`); }
  }

  // 8. Possible double bills: same property, and the same amount or the same reference, within 30 days.
  const billAlerts = [];
  const byProp = {};
  for (const b of bills) if (b.propertyID) (byProp[b.propertyID] ||= []).push(b);
  for (const list of Object.values(byProp)) {
    list.sort((a, b) => a.d - b.d);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.plan || b.plan || /payment\s+\d+\s+of/i.test(a.description + ' ' + b.description)) continue;
      if (b.d - a.d > 30) break;
      if (a.amount === b.amount && b.d - a.d > 14 && !(String(a.reference||'').trim() && a.reference === b.reference)) continue;
      const sameAmt = a.amount === b.amount;
      const ref = String(a.reference || '').trim();
      const sameRef = ref.length >= 3 && ref === String(b.reference || '').trim() && !/^(hd|lowes|amazon|hoa|j&g|aps|choice)$/i.test(ref) && !/registration|trade fee|monthly|service/i.test(ref);
      if (!(sameAmt || sameRef)) continue;
      const bothCharged = a.used && b.used && a.used !== b.used;
      if (bothCharged) continue;
      if (sameAmt && !sameRef && !(a.used || b.used)) continue;      // two unlinked same-amount bills: normal recurring service
      if (sameAmt && /monthly|pool service|pest control|hoa dues|surevestor|insurance/i.test(a.description + b.description)) continue;
      billAlerts.push({ a, b, why: sameRef ? `same reference "${ref}" on the same home` : 'same amount on the same home', amountDiff: Math.abs(a.amount - b.amount) });
    }
  }
  for (const al of billAlerts) for (const c of charges) if (c.bills.some((x) => x === al.a || x === al.b) && c.color === 'green') { c.color = 'red'; c.reasons.push(`possible double bill: ${al.why} (bills ${al.a.billID} and ${al.b.billID})`); }

  // Person marks override the colour but keep the reasons.
  for (const c of charges) { const m = marks[c.id]; if (m && m.status) { c.mark = m; c.autoColor = c.color; c.color = 'grey'; } }

  const likely = (c) => { const m = c.homes.size ? c.homes : c.noteHomes; return { count: m.size, homes: [...m.values()].slice(0, 5) }; };
  const strip = (b) => ({ billID: b.billID, date: isoDay(b.d), propertyID: b.propertyID, address: b.address, amount: b.amount, description: b.description, reference: b.reference, payee: b.payee, vendorBill: !!b.vendorBill });
  return {
    charges: charges.sort((a, b) => b.d - a.d).map((c) => ({ id: c.id, date: isoDay(c.d), description: c.description, card: c.card || '', amount: c.amount, pending: !!c.pending, color: c.color, autoColor: c.autoColor || c.color, reasons: c.reasons, fixPayee: !!c.fixPayee, likelyHomes: likely(c), possible: !c.bills.length && c.possible && !c.possible.used ? strip(c.possible) : null, mark: c.mark || null, pairedWith: c.pairedWith || null, bills: c.bills.map(strip), billedTotal: c.bills.reduce((s, b) => s + b.amount, 0) })),
    billAlerts: billAlerts.map((x) => ({ why: x.why, a: strip(x.a), b: strip(x.b) })),
  };
}

export function fmt(cents) { const n = Math.abs(cents) / 100; return (cents < 0 ? '-' : '') + '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// Small exact subset-sum on cents (bounded), returns the items or null. Needs at least 2 items.
function subsetSum(items, target, val) {
  if (items.length < 2 || target <= 0 || target > 5000000) return null;
  const reach = new Map([[0, []]]);
  for (let i = 0; i < items.length; i++) {
    const v = val(items[i]);
    for (const [s, path] of [...reach]) {
      const n = s + v;
      if (n > target || reach.has(n)) continue;
      const p = [...path, i];
      if (n === target && p.length >= 2) return p.map((k) => items[k]);
      reach.set(n, p);
      if (reach.size > 200000) return null;
    }
  }
  return null;
}
