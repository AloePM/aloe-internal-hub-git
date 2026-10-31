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

// Flatten an owner's bills (and expected recurring bills) into the list the email talks about.
function collectBills(owner) {
  const out = [];
  for (const p of owner.properties || []) {
    for (const b of p.bills || []) {
      if (!(cents(b.amountUnpaid) > 0)) continue;
      out.push({ addr: p.address, what: cleanDesc(b.desc), vendor: b.vendor || '', amount: Number(b.amountUnpaid) || 0, due: b.due || '', billed: b.date || '', paid: !!b.paid, expected: false, propertyID: p.propertyID });
    }
    for (const r of p.recurring || []) {
      if (!(cents(r.amount) > 0)) continue;
      out.push({ addr: p.address, what: r.label, vendor: '', amount: Number(r.amount) || 0, due: '', billed: '', paid: false, expected: true, propertyID: p.propertyID });
    }
  }
  return out;
}

// 2 calendar days before the earliest unpaid bill due date, never on a weekend, never before tomorrow.
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
  recurring_unknown: 'A recurring bill has no typical amount yet, so the math may be missing it',
  owner_contribution: 'Owner already contributed money in the last 30 days - check before asking again',
  move_out_soon: 'Tenant moving out within 30 days',
};

// Decide whether this owner gets an email, and what kind.
// ctx: { reserve (dollars, defaults to the owner's), balance: {distributable, hold} | null, cfg }
export function classify(owner, ctx = {}) {
  const cfg = { ...DEFAULTS, ...(ctx.cfg || {}) };
  const props = owner.properties || [];
  const reserve = cents(ctx.reserve ?? owner.reserve ?? 0);
  const net = props.reduce((s, p) => s + cents(p.net), 0);
  const amount = net - reserve;
  const bills = collectBills(owner);
  const billsC = bills.reduce((s, b) => s + cents(b.amount), 0);
  const expected = cents(owner.expected);
  const last = owner.lastPayout == null ? null : cents(owner.lastPayout);
  let kind = null, why = '';
  if (billsC <= 0) { if (amount < 0) why = 'Below $0 but no bills explain it - check rent not received yet, fees, or a vacancy'; }
  else if (amount < 0) kind = 'contribution';
  else if ((expected > 0 && amount < expected * cfg.lessThanUsualPct) || (last != null && last > 0 && amount < last * cfg.lowerThanLastPct)) kind = 'lower';
  return { kind, why, amount: amount / 100, net: net / 100, reserve: reserve / 100, bills, billsTotal: billsC / 100 };
}

const warnLine = (level, text) => ({ level, text });

// Everything the draft needs. ctx: { todayISO, recipients, balance, reserve, sign }
export function buildHeadsUp(owner, ctx = {}) {
  const todayISO = ctx.todayISO;
  const c = classify(owner, ctx);
  if (!c.kind) return { ownerID: owner.ownerID, name: owner.name, kind: null, why: c.why, amount: c.amount };
  const month = monthName(todayISO);
  const props = (owner.properties || []);
  const recipients = ctx.recipients || [];
  const bills = c.bills;
  const one = bills.length === 1 ? bills[0] : null;
  const homes = props.filter((p) => cents(p.settledIn) !== 0 || (p.bills || []).length || (p.recurring || []).length || cents(p.fee) !== 0);
  const multiHome = homes.length > 1;
  const sb = sendByDate(bills, todayISO);
  const warnings = [];
  if (!recipients.length) warnings.push(warnLine('red', 'No usable owner email in Rentvine - cannot create a draft'));
  if (recipients.length > 1) warnings.push(warnLine('amber', 'Addressed to ' + recipients.length + ' co-owners'));
  const bal = ctx.balance;
  if (bal && Number.isFinite(bal.distributable) && Math.abs(bal.distributable - c.amount) > 1) warnings.push(warnLine('amber', 'Rentvine shows ' + money(bal.distributable) + ' distributable, this page shows ' + money(c.amount) + ' - check before sending'));
  if (bal && bal.hold) warnings.push(warnLine('amber', 'Rentvine has distributions on hold for this owner'));
  for (const f of owner.flags || []) if (WARN_FLAGS[f]) warnings.push(warnLine('amber', WARN_FLAGS[f]));
  if (bills.some((b) => b.expected)) warnings.push(warnLine('amber', 'Includes an expected recurring bill that is not billed yet (' + bills.filter((b) => b.expected).map((b) => b.what).join(', ') + ')'));
  const pendingLate = props.reduce((s, p) => s + (((p.lateRent || {}).pending) || 0), 0);
  if (pendingLate > 0) warnings.push(warnLine('amber', 'Late rent of ' + money(pendingLate) + ' is received but not cleared - the amount may change'));
  const stillToCome = props.reduce((s, p) => (p.vacant ? s : s + Math.max(0, cents(p.rent) - cents(p.settledIn))), 0) / 100;
  if (c.kind === 'contribution') {
    if (!sb.date) warnings.push(warnLine('amber', 'No due date on the bills - fill in the send-by date'));
    else if (sb.late) warnings.push(warnLine('red', 'A bill is due ' + shortDate(sb.due) + ' - there is less than 2 days to collect, confirm the date'));
  }

  // ---- the math, as lines: { sign: '', '-', '+', '=', label, amount, bold }
  const L = (sign, label, amount, bold) => ({ sign, label, amount, bold: !!bold });
  const billLabel = (b) => b.what + ' (' + (b.expected ? 'expected, not billed yet' : (b.vendor ? b.vendor + ', ' : '') + (b.paid ? 'paid' : b.due ? 'due ' + shortDate(b.due) : b.billed ? 'billed ' + shortDate(b.billed) : 'unpaid')) + ')';
  const blocks = [];
  for (const p of (multiHome ? homes : [homes[0] || props[0]])) {
    if (!p) continue;
    const lines = [L('', month + ' rent received', p.settledIn), L('-', 'Management fee', p.fee)];
    for (const b of bills.filter((x) => x.propertyID === p.propertyID)) lines.push(L('-', billLabel(b), b.amount));
    lines.push(L('=', multiHome ? 'Net for this home' : (c.kind === 'contribution' ? 'Balance after paying the bills' : (c.reserve > 0 ? 'Balance after bills' : 'Your distribution')), p.net, true));
    blocks.push({ title: multiHome ? p.address : '', lines });
  }
  const tail = [];
  if (multiHome) tail.push(L('', 'Net of all homes', c.net, true));
  if (c.reserve > 0) tail.push(c.kind === 'contribution' ? L('+', 'Restore reserve', c.reserve) : L('-', 'Reserve held', c.reserve));
  if (c.kind === 'contribution') tail.push(L('=', 'Contribution needed', -c.amount, true));
  else if (multiHome || c.reserve > 0) tail.push(L('=', 'Your distribution', c.amount, true));
  if (multiHome) blocks.push({ title: 'Your total', lines: tail });
  else blocks[blocks.length - 1].lines.push(...tail);

  // ---- paragraphs
  const vendors = [...new Set(bills.filter((b) => !b.expected && b.vendor).map((b) => b.vendor))];
  const vendorPhrase = vendors.length === 1 ? vendors[0] : vendors.length ? 'the vendors' : 'the vendor';
  const homesWord = multiHome ? 'homes' : 'home';
  const paras = [];
  paras.push({ t: 'p', text: greetingFor(recipients) });
  const billListItems = bills.map((b) => (multiHome ? b.addr + ' - ' : '') + billLabel(b) + ': ' + money(b.amount));
  let subject = '';
  if (c.kind === 'contribution') {
    const shortWhat = one ? one.what : 'bills';
    subject = (multiHome || !one ? 'Your properties' : one.addr) + ' – ' + (one ? lcFirst(shortWhat) + ' and owner contribution' : 'owner contribution') + ' needed by ' + (sb.date ? shortDate(sb.date) : '[send-by date]');
    if (one) paras.push({ t: 'p', text: 'I’m writing about the ' + one.what + ' at ' + one.addr + '. ' + (one.vendor || 'The vendor') + ' billed ' + money(one.amount) + (one.paid ? ', which has already been paid from your account.' : one.due ? ', and the bill is due ' + shortDate(one.due) + '.' : '.') });
    else { paras.push({ t: 'p', text: 'I’m writing about the following bills for your ' + homesWord + ':' }); paras.push({ t: 'ul', items: billListItems }); }
    const shortfallOnlyReserve = c.net >= 0;
    paras.push({ t: 'p', text: shortfallOnlyReserve
      ? 'After ' + month + ' rent and ' + (one ? 'this bill' : 'these bills') + ', your account would be below the ' + money(c.reserve) + ' reserve we keep, so there won’t be an owner distribution in ' + month + '. We’ll need a small contribution from you to restore it.'
      : 'Because ' + (one ? 'this bill is' : 'these bills are') + ' larger than what your ' + homesWord + ' brought in after ' + month + ' rent and the management fee, there won’t be an owner distribution in ' + month + '. We’ll also need a contribution from you so we can pay ' + vendorPhrase + ' on time' + (c.reserve > 0 ? ' and keep your ' + money(c.reserve) + ' reserve in place' : '') + '.' });
  } else {
    subject = 'Your ' + month + ' distribution: ' + money(c.amount) + ', lower than usual because of ' + (one ? lcFirst(one.what) : 'bills');
    paras.push({ t: 'p', text: 'Your ' + month + ' owner distribution of ' + money(c.amount) + ' will go out on ' + (ctx.payoutDate ? shortDate(ctx.payoutDate) : ph('payout date')) + '. It’s lower than usual because of ' + (one ? 'the ' + lcFirst(one.what) + ' at ' + one.addr + ' (' + (one.vendor ? one.vendor + ', ' : '') + money(one.amount) + ').' : 'the following bills for your ' + homesWord + ':') });
    if (!one) paras.push({ t: 'ul', items: billListItems });
  }
  paras.push({ t: 'p', text: 'Here’s the math:' });
  for (const b of blocks) paras.push({ t: 'math', title: b.title, lines: b.lines });
  if (c.kind === 'contribution' && stillToCome > 0.99) paras.push({ t: 'p', text: 'This assumes the remaining ' + money(stillToCome) + ' of ' + month + ' rent is received in full and on time.' });
  if (c.kind === 'contribution') {
    paras.push({ t: 'p', text: 'Could you send ' + money(-c.amount) + ' by ' + (sb.date ? shortDate(sb.date) : ph('send-by date')) + '? That gives the funds time to clear' + (sb.due ? ' before the bill is due' : '') + '. You can pay by ' + ph('payment instructions') + '.' });
    paras.push({ t: 'p', text: 'If paying the full amount at once is difficult, please let me know as soon as possible and I’ll ask ' + vendorPhrase + ' whether they would accept a payment arrangement.' });
  } else {
    if (owner.lastPayout != null) paras.push({ t: 'p', text: 'For comparison, your last distribution was ' + money(owner.lastPayout) + '.' });
    paras.push({ t: 'p', text: 'Nothing is needed from you. I wanted you to see exactly where the money went before you saw the deposit.' });
  }
  paras.push({ t: 'p', text: 'I’m happy to send the ' + (bills.filter((b) => !b.expected).length > 1 ? 'invoices' : 'invoice') + ' or walk through the numbers on a call.' });
  const sign = ctx.sign || {};
  paras.push({ t: 'sig', lines: ['Thank you,', sign.name || ph('Your name'), 'Aloe Property Management', sign.phone || ph('Phone')] });

  return {
    ownerID: owner.ownerID, name: owner.name, kind: c.kind, amount: c.amount, contribution: c.kind === 'contribution' ? -c.amount : 0,
    expected: owner.expected, lastPayout: owner.lastPayout, reserve: c.reserve, billsTotal: c.billsTotal,
    sendBy: sb.date, recipients, subject, paras, warnings, stillToCome,
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
    const recipients = pickRecipients(bal ? bal.contacts : [], contacts.emailByContact || {});
    const hold = !!(bal && bal.hold) || recipients.some((r) => (contacts.holdByContact || {})[r.contactID]);
    return { recipients, balance: bal ? { distributable: bal.distributable, hold } : (hold ? { distributable: NaN, hold } : null), reserve: bal ? bal.reserve : undefined, sign };
  }, todayISO);
  const month = todayISO.slice(0, 7);
  for (const d of drafts) {
    const o = ownerByID.get(String(d.ownerID)), bal = balFor(o);
    if (bal && Math.abs(bal.reserve - (Number(o.reserve) || 0)) > 0.005) d.warnings.push(warnLine('amber', 'Rentvine holds a ' + money(bal.reserve) + ' reserve for this owner but the page uses ' + money(o.reserve || 0) + ', so this amount differs from the Amount to pay column'));
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
