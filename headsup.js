// Owner heads-up emails - pure logic (no network, no writes). Used by payouts-routes.js and the tests.
// Two kinds of email, both explaining "rent minus bills" before the owner sees the deposit:
//   contribution - bills are bigger than the money available, so the owner is asked to send money
//   lower        - the owner is still paid, but less than usual because of bills
// Everything the owner reads comes from numbers already on the Payouts page. Anything unknown becomes a
// highlighted [placeholder] in the draft, never a guess.
import { DEFAULTS } from './payouts-data.js';

const cents = (n) => Math.round((Number(n) || 0) * 100);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthName = (iso) => MONTHS[Number(iso.slice(5, 7)) - 1] || '';
export const shortDate = (iso) => (iso ? MON[Number(iso.slice(5, 7)) - 1] + ' ' + Number(iso.slice(8, 10)) : '');
export const money = (n) => { const c = Math.round(Math.abs(Number(n) || 0) * 100); const s = '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return (Number(n) < 0 && c > 0 ? '−' : '') + s; };
const ph = (label) => '{{ph:' + label + '}}';
const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dow = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();

// "Alex and Taline Bessos" -> "Alex and Taline"; "Hai Hu - Michaels" -> "Hai"; companies keep their full name.
export function firstNames(name) {
  const n = String(name || '').replace(/\s+-\s+.*$/, '').trim();
  if (!n) return '';
  if (/\b(LLC|L\.L\.C|INC|CORP|LP|TRUST|PROPERT|RENTALS|HOLDINGS|INVEST|FAMILY|ET AL)/i.test(n)) return n;
  const parts = n.split(/\s+(?:and|&)\s+/i);
  return parts.map((p) => p.trim().split(/\s+/)[0]).filter(Boolean).join(' and ');
}
export const greetingFor = (recipients) => {
  const names = (recipients || []).map((r) => firstNames(r.name)).filter(Boolean);
  const uniq = [...new Set(names)];
  if (!uniq.length) return 'Hi ' + ph('Owner first name') + ',';
  return 'Hi ' + (uniq.length === 1 ? uniq[0] : uniq.slice(0, -1).join(', ') + ' and ' + uniq[uniq.length - 1]) + ',';
};

// Contacts on a portfolio that should receive the email: owners with an ownership or distribution share
// (portal login contacts have 0% / 0%).
export function pickRecipients(contacts = [], emailByContact = {}) {
  const out = [], seen = new Set();
  for (const c of contacts) {
    if (!(Number(c.percentOwned) > 0 || Number(c.percentDistributed) > 0)) continue;
    const email = String(emailByContact[String(c.contactID)] || '').trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push({ contactID: String(c.contactID), name: c.name || '', email });
  }
  return out;
}

const lcFirst = (t) => (/^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);
const cleanDesc = (d) => String(d || 'Bill').replace(/\s*\((unpaid|paid [^)]*)\)\s*$/i, '').replace(/\s+/g, ' ').trim().slice(0, 80);

// Owners never see vendor names or the work description. A bill is described by its type ("AC bill") or, when the
// description is not clearly one type of work, as "repair bill from a maintenance request".
export const GENERIC_FALLBACK = 'repair bill from a maintenance request';
const BILL_TYPES = [
  [/(^|[^a-z])(a\/c|ac|hvac)([^a-z]|$)|air ?cond|heat pump|furnace|refrigerant|freon/i, 'AC bill'],
  [/plumb|leak|drain|toilet|faucet|water heater|sewer|pipe/i, 'plumbing bill'],
  [/roof/i, 'roof bill'],
  [/electric|outlet|breaker|wiring/i, 'electrical bill'],
  [/dishwasher|refrigerator|fridge|washer|dryer|stove|oven|microwave|disposal|appliance/i, 'appliance bill'],
  [/pest|termite|rodent|scorpion/i, 'pest control bill'],
  [/pool/i, 'pool bill'],
  [/landscap|lawn|tree|irrigation|sprinkler/i, 'landscaping bill'],
  [/paint/i, 'paint bill'],
  [/floor|carpet|tile/i, 'flooring bill'],
  [/lock|garage door/i, 'lock and door bill'],
  [/clean|trash|haul/i, 'cleaning bill'],
];
export function genericBill(desc) {
  const d = String(desc || '').replace(/\s+/g, ' ').trim();
  if (!d || d.length > 60 || d.split(' ').length > 9) return GENERIC_FALLBACK;
  for (const [re, label] of BILL_TYPES) if (re.test(d)) return label;
  return GENERIC_FALLBACK;
}
const shortGeneric = (g) => (g === GENERIC_FALLBACK ? 'repair bill' : g);
const ARRANGEMENT = /partial|payment plan|arrangement|install?ment|remainder|remaining balance|(end of|with) (the )?(month|next month|november|december|rent)/i;

// Flatten an owner's bills into the list the email talks about. Only UNPAID or PARTLY paid bills count (the unpaid part);
// a paid bill never reduces a payout. Tenant-charged (suppressed) and voided bills are already dropped upstream.
function collectBills(owner) {
  const out = [];
  for (const p of owner.properties || []) {
    for (const b of p.bills || []) {
      if (b.paid || !(cents(b.amountUnpaid) > 0)) continue;
      const what = cleanDesc(b.desc), g = genericBill(what);
      out.push({ addr: p.address, what, generic: shortGeneric(g), longGeneric: g, vendor: b.vendor || '', amount: Number(b.amountUnpaid) || 0, due: b.due || '', billed: b.date || '', paid: false, expected: false, propertyID: p.propertyID, arrangement: ARRANGEMENT.test(what) });
    }
  }
  return out;
}

// 2 calendar days before the earliest unpaid bill due date, never on a weekend, never before tomorrow.
// (Only used for the "send by" column - the email itself says "within 3 days".)
export function sendByDate(bills, todayISO) {
  const dues = bills.filter((b) => !b.paid && !b.expected && b.due).map((b) => b.due).sort();
  if (!dues.length) return { date: '', late: false };
  let d = addDays(dues[0], -2);
  while (dow(d) === 0 || dow(d) === 6) d = addDays(d, -1);
  const tomorrow = addDays(todayISO, 1);
  if (d < tomorrow) { let n = tomorrow; while (dow(n) === 0 || dow(n) === 6) n = addDays(n, 1); return { date: n, late: true, due: dues[0] }; }
  return { date: d, late: false, due: dues[0] };
}

const WARN_FLAGS = {
  new_owner: 'New owner - check onboarding fees before sending',
  vacant: 'A home is vacant - rent may not be coming in',
  fee_prorate: 'Management fee needs a look (prorate rule)',
  placement_fee: 'Placement fee needs a look',
  owner_contribution: 'Owner already contributed money in the last 30 days - check before asking again',
  move_out_soon: 'Tenant moving out within 30 days',
};

// Decide whether this owner gets an email, and what kind. The cash truth is Rentvine's Distributable Amount (D): it already has
// the reserve, unpaid bills (accounts payable) and unsettled / undeposited receipts taken out. Only unpaid or partly paid bills matter.
//   a bill already due (or with no due date) and D < 0           -> contribution now, for the shortage (-D), without waiting for rent
//   nothing due yet, but D + rent still to come - fee not yet billed < 0 -> contribution, for that shortage
//   otherwise unpaid bills that pull the expected distribution (rent minus fee) below usual -> "lower" heads-up
// ctx: { todayISO, balance: {distributable, hold} | null, cfg }
export function classify(owner, ctx = {}) {
  const cfg = { ...DEFAULTS, ...(ctx.cfg || {}) };
  const props = owner.properties || [];
  const today = ctx.todayISO || '';
  const bills = collectBills(owner);
  const U = bills.reduce((s, b) => s + cents(b.amount), 0);
  const bal = ctx.balance;
  // Rentvine's distributable still holds tenant money that is not the owner's (Resident Benefit Package...), so that comes off first
  const nonOwner = props.reduce((s, p) => s + cents(p.nonOwnerRaw !== undefined ? p.nonOwnerRaw : p.nonOwnerPaid), 0);
  const D = bal && Number.isFinite(bal.distributable) ? cents(bal.distributable) - nonOwner : null;
  const live = props.filter((p) => !p.vacant && cents(p.rent) > 0);
  const feeFor = (p) => (cents(p.fee) > 0 ? cents(p.fee) : cents(p.planFee));
  const monthlyRent = live.reduce((s, p) => s + cents(p.rent), 0);
  const monthlyFee = live.reduce((s, p) => s + feeFor(p), 0);
  const feeKnown = live.length > 0 && live.every((p) => feeFor(p) > 0);
  const E = monthlyRent - monthlyFee;                                           // what the owner normally gets each month
  const still = live.reduce((s, p) => s + Math.max(0, cents(p.rent) - cents(p.settledIn)), 0);   // rent not yet settled
  const unposted = live.reduce((s, p) => s + ((p.feePosted === undefined ? cents(p.fee) > 0 : p.feePosted) ? 0 : feeFor(p)), 0);      // management fee not billed yet
  const P = D == null ? null : D + still - unposted;                            // projected balance after the rest of this month's rent
  const dueNow = bills.some((b) => !b.due || b.due <= today);
  const last = owner.lastPayout == null ? null : cents(owner.lastPayout);
  const contributedRecently = (owner.flags || []).includes('owner_contribution');
  let kind = null, why = '', basis = '', amount = 0;
  if (U <= 0) { if (D != null && D < 0) why = 'Rentvine distributable is ' + money(D / 100) + ' but there is no unpaid bill to explain it - check by hand'; }
  else if (D == null) why = 'Rentvine has no balance for this owner - check by hand';
  else if (dueNow && D < 0) { kind = 'contribution'; basis = 'now'; amount = D; }
  else if (!dueNow && P < 0) { kind = 'contribution'; basis = 'rent'; amount = P; }
  else if (E > 0) {
    const est = E - U;
    if (est < E * cfg.lessThanUsualPct || (last != null && last > 0 && est < last * cfg.lowerThanLastPct)) { kind = 'lower'; amount = est; }
  }
  if (kind === 'contribution' && contributedRecently) { kind = null; basis = ''; why = 'Needs a contribution but the owner already contributed in the last 30 days - check before asking again'; }
  return { kind, why, basis, amount: amount / 100, D: D == null ? null : D / 100, P: P == null ? null : P / 100, E: E / 100, U: U / 100, still: still / 100, unposted: unposted / 100, monthlyRent: monthlyRent / 100, monthlyFee: monthlyFee / 100, feeKnown, bills, billsTotal: U / 100, dueNow };
}

const warnLine = (level, text) => ({ level, text });
const plural = (n, one, many) => (n === 1 ? one : many);
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

// Everything the draft needs. ctx: { todayISO, recipients, balance, cfg }
export function buildHeadsUp(owner, ctx = {}) {
  const todayISO = ctx.todayISO;
  const cfg = { ...DEFAULTS, ...(ctx.cfg || {}) };
  const c = classify(owner, ctx);
  if (!c.kind) return { ownerID: owner.ownerID, name: owner.name, kind: null, why: c.why, amount: c.D == null ? 0 : c.D };
  const month = monthName(todayISO);
  const props = (owner.properties || []);
  const recipients = ctx.recipients || [];
  const bills = c.bills;
  const one = bills.length === 1 ? bills[0] : null;
  const homes = props.filter((p) => !p.vacant && cents(p.rent) > 0);
  const multiHome = homes.length > 1;
  const sb = sendByDate(bills, todayISO);
  const distributedThisMonth = !!(owner.lastPayoutDate && String(owner.lastPayoutDate).slice(0, 7) === todayISO.slice(0, 7));
  const warnings = [];
  if (!recipients.length) warnings.push(warnLine('red', 'No usable owner email in Rentvine - cannot create a draft'));
  if (recipients.length > 1) warnings.push(warnLine('amber', 'Addressed to ' + recipients.length + ' co-owners'));
  const bal = ctx.balance;
  if (bal && bal.hold) warnings.push(warnLine('amber', 'Rentvine has distributions on hold for this owner'));
  for (const f of owner.flags || []) if (WARN_FLAGS[f]) warnings.push(warnLine('amber', WARN_FLAGS[f]));
  if (bills.some((b) => b.arrangement)) warnings.push(warnLine('red', 'A bill description mentions a partial payment or arrangement - review it before asking for money'));
  const pendingLate = props.reduce((s, p) => s + (((p.lateRent || {}).pending) || 0), 0);
  if (pendingLate > 0) warnings.push(warnLine('amber', 'Late rent of ' + money(pendingLate) + ' is received but not cleared - the amount may change'));
  if (c.kind === 'contribution') {
    if (bills.some((b) => !b.due)) warnings.push(warnLine('amber', 'No due date on a bill - treated as due now'));
    else if (sb.late) warnings.push(warnLine('amber', 'A bill is due ' + shortDate(sb.due) + ' - already due or very soon'));
  }
  if (c.kind === 'lower' && c.reserve > 0) warnings.push(warnLine('amber', 'Owner has a reserve - check whether the distribution should also restore it'));

  // ---- carry offer: only when the amount asked for is bigger than one month's rent after the management fee
  const ask = c.kind === 'contribution' ? -c.amount : 0;
  const carryPct = Number.isFinite(cfg.carryPct) ? cfg.carryPct : 0.05;
  const carry = { offered: c.kind === 'contribution' && cfg.carryOffer !== false && c.E > 0 && ask > c.E, rentAfterFee: c.E, pct: carryPct, fee: Math.round(ask * carryPct * 100) / 100 };
  if (c.kind === 'contribution' && cfg.carryOffer !== false && !(c.E > 0)) warnings.push(warnLine('amber', 'No rent to carry against (vacant or no rent found) - carry offer left out'));

  // ---- the math, as lines: { sign: '', '-', '+', '=', label, amount, bold }
  const L = (sign, label, amount, bold) => ({ sign, label, amount, bold: !!bold });
  const billLabel = (b) => cap(b.generic) + ' (' + (b.due ? 'due ' + shortDate(b.due) : b.billed ? 'billed ' + shortDate(b.billed) : 'unpaid') + ')';
  const lines = [];
  if (c.kind === 'contribution') {
    lines.push(L('', 'Funds available in your account', c.D + c.U));
    if (c.basis === 'rent') { if (c.still > 0) lines.push(L('+', month + ' rent still expected', c.still)); if (c.unposted > 0) lines.push(L('-', 'Management fee not yet billed', c.unposted)); }
    for (const b of bills) lines.push(L('-', billLabel(b), b.amount));
    lines.push(L('=', 'Balance after paying the bills', c.basis === 'now' ? c.D : c.P, true));
    lines.push(L('=', 'Contribution needed', ask, true));
  } else {
    lines.push(L('', month + ' rent' + (multiHome ? ' (all homes)' : ''), c.monthlyRent), L('-', 'Management fee', c.monthlyFee));
    for (const b of bills) lines.push(L('-', billLabel(b), b.amount));
    lines.push(L('=', 'Your distribution', c.amount, true));
  }
  // rent minus management fee, shown after the main math so owners can see where their usual amount comes from
  const rentBreakdown = c.kind === 'contribution' && c.basis === 'now' && c.feeKnown ? [L('', month + ' rent', c.monthlyRent), L('-', 'Management fee', c.monthlyFee), L('=', 'Rent after management fee', c.E, true)] : null;
  if (c.kind === 'contribution' && c.basis === 'now' && !rentBreakdown && c.monthlyRent > 0) warnings.push(warnLine('amber', 'Management fee not known for a home - the rent-minus-fee breakdown was left out of the email'));

  // ---- paragraphs
  const vendors = new Set(bills.map((b) => b.vendor || b.propertyID));
  const vendorPhrase = vendors.size > 1 ? 'the vendors' : 'the vendor';
  const homesWord = multiHome ? 'homes' : 'home';
  const paras = [];
  paras.push({ t: 'p', text: greetingFor(recipients) });
  const billListItems = bills.map((b) => (multiHome ? b.addr + ' - ' : '') + billLabel(b) + ': ' + money(b.amount));
  let subject = '';
  if (c.kind === 'contribution') {
    subject = (multiHome || !one ? 'Your properties' : one.addr) + ' – ' + (one ? one.generic : 'bills') + ' – owner contribution needed within 3 days';
    if (one) paras.push({ t: 'p', text: 'I wanted to reach out about the ' + one.longGeneric + ' for ' + one.addr + ': ' + money(one.amount) + (one.due ? ', due ' + shortDate(one.due) + '.' : '.') });
    else { paras.push({ t: 'p', text: 'I wanted to reach out about the following bills for your ' + homesWord + ':' }); paras.push({ t: 'ul', items: billListItems }); }
    const it = one ? 'this bill' : 'these bills';
    if (c.basis === 'now') {
      paras.push({ t: 'p', text: distributedThisMonth
        ? 'Since your owner distribution for this month has already been processed, there are no longer enough funds in your account to cover ' + it + '. Rather than waiting for next month’s rent, we’re asking for a contribution so we can pay ' + vendorPhrase + ' promptly.'
        : 'There aren’t enough funds in your account to cover ' + it + ' right now, and we’d rather not keep ' + vendorPhrase + ' waiting until next month’s rent. We’re asking for a contribution so we can get ' + (one ? 'it' : 'them') + ' paid promptly.' });
    } else {
      paras.push({ t: 'p', text: 'Even after the ' + month + ' rent we expect and the management fee, there still isn’t enough in your account to cover ' + it + ', so there won’t be an owner distribution in ' + month + '. We’ll need a contribution from you so we can pay ' + vendorPhrase + ' on time.' });
    }
    paras.push({ t: 'p', text: 'Here’s the math:' });
    paras.push({ t: 'math', title: '', lines });
    if (rentBreakdown) { paras.push({ t: 'p', text: 'For reference, here’s what your ' + month + ' rent looks like after the management fee:' }); paras.push({ t: 'math', title: '', lines: rentBreakdown }); }
    if (c.basis === 'rent' && c.still > 0.99) paras.push({ t: 'p', text: 'This assumes the remaining ' + money(c.still) + ' of ' + month + ' rent is received in full and on time.' });
    paras.push({ t: 'p', text: 'I know unexpected expenses are never fun, and I really appreciate your help with this.' });
    paras.push({ t: 'p', text: 'Could you send ' + money(ask) + ' within 3 days? That gives the funds time to clear. You can pay by ' + ph('payment instructions') + '.' });
    if (carry.offered) paras.push({ t: 'p', text: 'If you’d prefer, we can carry this balance against your upcoming rent instead. The fee is ' + Math.round(carryPct * 100) + '% of the balance we’re carrying, charged for each month it stays open. For the ' + money(ask) + ' above, that’s ' + money(carry.fee) + ' per month. Just let me know and I’ll set it up.' });
    paras.push({ t: 'p', text: 'You can see the bill details in your owner portal under Bills. I’m also happy to walk through the numbers on a call.' });
  } else {
    subject = 'Heads-up: your ' + month + ' distribution will be lower than usual';
    paras.push({ t: 'p', text: 'I wanted to let you know that your ' + month + ' owner distribution will be lower than usual.' });
    if (one) paras.push({ t: 'p', text: 'The ' + one.longGeneric + ' for ' + one.addr + ' (' + money(one.amount) + (one.due ? ', due ' + shortDate(one.due) : '') + ') will come out of ' + month + ' rent, so your distribution will be ' + money(c.billsTotal) + ' less than expected.' });
    else { paras.push({ t: 'p', text: 'The following bills for your ' + homesWord + ' will come out of ' + month + ' rent, so your distribution will be ' + money(c.billsTotal) + ' less than expected:' }); paras.push({ t: 'ul', items: billListItems }); }
    paras.push({ t: 'p', text: 'You can see the ' + plural(bills.length, 'bill', 'bills') + ' in your owner portal under Bills.' });
    paras.push({ t: 'p', text: 'Here’s the math:' });
    paras.push({ t: 'math', title: '', lines });
    paras.push({ t: 'p', text: 'Please let me know if you have any questions. I’m always happy to help.' });
  }
  // no signature block: Aptly adds the sender's own signature to the draft
  paras.push({ t: 'p', text: 'Thank you,' });

  return {
    ownerID: owner.ownerID, name: owner.name, kind: c.kind, basis: c.basis, amount: c.amount, contribution: c.kind === 'contribution' ? ask : 0,
    expected: c.E, lastPayout: owner.lastPayout, reserve: Number(owner.reserve) || 0, billsTotal: c.billsTotal, distributable: c.D, projected: c.P, carry,
    sendBy: sb.date, recipients, subject, paras, warnings, stillToCome: c.still,
    text: renderText(paras), html: renderHtml(paras),
  };
}

// ---- rendering
const lineText = (l) => (l.sign ? l.sign.replace('-', '−') + ' ' : '') + l.label + ': ' + money(l.amount);
const phText = (s) => String(s).replace(/\{\{ph:(.*?)\}\}/g, '[$1]');
export function renderText(paras) {
  const out = [];
  for (const p of paras) {
    if (p.t === 'p') out.push(phText(p.text));
    else if (p.t === 'ul') { const li = p.items.map((i) => '• ' + phText(i)).join('\n'); if (out.length) out[out.length - 1] += '\n' + li; else out.push(li); }
    else if (p.t === 'math') out.push((p.title ? p.title + '\n' : '') + p.lines.map(lineText).join('\n'));
    else if (p.t === 'sig') out.push(p.lines.map(phText).join('\n'));
  }
  return out.join('\n\n');
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const phHtml = (s) => esc(s).replace(/\{\{ph:(.*?)\}\}/g, '<span style="background:#fff3a3">[$1]</span>');
export function renderHtml(paras) {
  const wrap = 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1b2b34';
  const body = paras.map((p) => {
    if (p.t === 'p') return '<p style="margin:0 0 14px">' + phHtml(p.text) + '</p>';
    if (p.t === 'ul') return '<ul style="margin:0 0 14px;padding-left:20px">' + p.items.map((i) => '<li>' + phHtml(i) + '</li>').join('') + '</ul>';
    if (p.t === 'math') return '<p style="margin:0 0 14px;line-height:1.7">' + (p.title ? '<b>' + esc(p.title) + '</b><br>' : '') + p.lines.map((l) => (l.bold ? '<b>' : '') + esc(lineText(l)) + (l.bold ? '</b>' : '')).join('<br>') + '</p>';
    if (p.t === 'sig') return '<p style="margin:0 0 14px">' + p.lines.map(phHtml).join('<br>') + '</p>';
    return '';
  }).join('\n');
  return '<div style="' + wrap + '">' + body + '</div>';
}

// Whole-list helper used by the route: build every flagged owner, plus the owners that need a person.
export function buildAll(owners, ctxFor, todayISO) {
  const drafts = [], needsPerson = [];
  for (const o of owners) {
    const r = buildHeadsUp(o, { ...ctxFor(o), todayISO });
    if (r.kind) drafts.push(r);
    else if (r.why) needsPerson.push({ ownerID: o.ownerID, name: o.name, amount: r.amount, why: r.why });
  }
  drafts.sort((a, b) => (a.kind === b.kind ? a.amount - b.amount : a.kind === 'contribution' ? -1 : 1));
  return { drafts, needsPerson };
}

// ---- preview for the whole page (pure): owners come from the Payouts list, contacts/balances from Rentvine reports.
//  contacts: { emailByContact, holdByContact }   balances: { [portfolioID]: { reserve, operating, distributable, hold, contacts: [...] } }
//  drafted: { 'headsup:<ownerID>:<YYYY-MM>': { at } }  (what was already drafted this month)
export function buildPreview({ owners, contacts = {}, balances = {}, todayISO, sign, drafted = {} }) {
  const ownerByID = new Map(owners.map((o) => [String(o.ownerID), o]));
  const balFor = (o) => balances[String(o.portfolioID ?? o.ownerID)] || null;
  const { drafts, needsPerson } = buildAll(owners, (o) => {
    const bal = balFor(o);
    // normally the owner contacts (with their ownership shares) come from Rentvine's balances report; if that report is unavailable
    // fall back to the owner ids on the property record, so the preview still shows who the email would go to
    const fallbackContacts = (o.contactIDs || []).map((id) => ({ contactID: id, percentOwned: '100', percentDistributed: '100', name: (contacts.nameByContact || {})[String(id)] || '' }));
    const recipients = pickRecipients(bal ? bal.contacts : fallbackContacts, contacts.emailByContact || {});
    const hold = !!(bal && bal.hold) || recipients.some((r) => (contacts.holdByContact || {})[r.contactID]);
    return { recipients, balance: bal ? { distributable: bal.distributable, hold } : (hold ? { distributable: NaN, hold } : null), reserve: bal ? bal.reserve : undefined, sign };
  }, todayISO);
  const month = todayISO.slice(0, 7);
  for (const d of drafts) {
    const o = ownerByID.get(String(d.ownerID)), bal = balFor(o);
    if (!bal && d.recipients.length) d.warnings.push(warnLine('amber', 'Recipients come from the owners on the property record, not Rentvine\u2019s balances report - confirm who it goes to (portal logins may be included)'));
    d.key = 'headsup:' + d.ownerID + ':' + month;
    d.alreadyDrafted = (drafted[d.key] && drafted[d.key].at) || '';
    if (d.alreadyDrafted) d.warnings.unshift(warnLine('amber', 'A draft was already created for this owner this month (' + String(d.alreadyDrafted).slice(0, 10) + ')'));
  }
  const noEmail = drafts.filter((d) => !d.recipients.length).length;
  return { todayISO, drafts, needsPerson, counts: { contribution: drafts.filter((d) => d.kind === 'contribution').length, lower: drafts.filter((d) => d.kind === 'lower').length, needsPerson: needsPerson.length, noEmail, alreadyDrafted: drafts.filter((d) => d.alreadyDrafted).length } };
}

// ---- create the drafts. Nothing is written unless create === true. Dependencies are injected so tests never touch Aptly.
export const MAX_BATCH = 40;
export const isCompanyEmail = (e) => /^[^@\s]+@aloepm\.com$/i.test(String(e || '').trim());
export async function runBatch({ preview, ownerIDs, create = false, testTo = '', createDraft, markDrafted = async () => {}, notify = null, channelId = '' }) {
  const res = { dryRun: create !== true, test: !!testTo, drafted: [], skipped: [], failed: [], notified: false };
  if (!Array.isArray(ownerIDs) || !ownerIDs.length) throw new Error('ownerIDs required');
  if (ownerIDs.length > MAX_BATCH) throw new Error('Too many owners at once (max ' + MAX_BATCH + ')');
  if (testTo && !isCompanyEmail(testTo)) throw new Error('Test drafts can only go to an @aloepm.com address');
  const live = create === true;
  for (const id of ownerIDs) {
    const d = preview.drafts.find((x) => String(x.ownerID) === String(id));
    if (!d) { res.skipped.push({ ownerID: id, reason: 'not flagged right now' }); continue; }
    if (!testTo && !d.recipients.length) { res.skipped.push({ ownerID: id, name: d.name, reason: 'no usable owner email' }); continue; }
    if (!testTo && d.alreadyDrafted) { res.skipped.push({ ownerID: id, name: d.name, reason: 'already drafted this month' }); continue; }
    const to = testTo ? [{ value: testTo, label: 'TEST' }] : d.recipients.map((r) => ({ value: r.email, label: r.name }));
    const subject = (testTo ? '[TEST - not sent to owner] ' : '') + d.subject;
    const body = (testTo ? '<p style="background:#fde8e6;padding:8px;font-family:Arial,sans-serif;font-size:13px">TEST DRAFT. The real recipients would be: ' + esc(d.recipients.map((r) => r.email).join(', ') || 'none') + '</p>' : '') + d.html;
    if (!live) { res.drafted.push({ ownerID: d.ownerID, name: d.name, to: to.map((x) => x.value), subject, wouldCreate: true }); continue; }
    try {
      const r = await createDraft({ channelId, to, subject, body });
      let recorded = true;
      if (!testTo) { try { await markDrafted(d.key, { kind: d.kind, amount: d.amount, subject }); } catch { recorded = false; } }   // the draft exists either way - never call it a failure
      res.drafted.push({ ownerID: d.ownerID, name: d.name, to: to.map((x) => x.value), subject, streamId: r && r.streamId, draftUuid: r && r.draftUuid, recorded });
    } catch (e) { res.failed.push({ ownerID: d.ownerID, name: d.name, error: String(e.message || e).slice(0, 300) }); }
  }
  if (live && !testTo && notify) {
    let text = ':email: *Owner heads-up drafts* — ' + res.drafted.length + ' drafted, ' + res.skipped.length + ' skipped, ' + res.failed.length + ' failed. Review them in the info@ inbox drafts before sending.';
    if (res.failed.length) text += '\n:warning: Failed: ' + res.failed.map((f) => f.name + ' (' + f.error + ')').join(', ');
    try { await notify(text); res.notified = true; } catch { res.notified = false; }
  }
  return res;
}
