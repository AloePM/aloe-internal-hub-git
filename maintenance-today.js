// Maintenance "Today" list - pure functions (no network, no writes). Used by maintenance-routes.js and the tests.
// Rules (Randi, Oct 27 2026): vendor must be scheduled within 2 days of assignment; at 3 days with no schedule, follow up with the vendor
// (the tenant may not have heard). Days are CALENDAR days in Phoenix time. Unit turns belong to Persia or Teri, everything else to Roberto.
import { daysBetween, todayPhoenix } from './maintenance-data.js';
import { mapComments, lastHumanNote, parseVendorConfirm } from './maintenance-comments.js';

const phxDate = (iso) => { const t = Date.parse(iso); return isFinite(t) ? new Date(t - 7 * 3600000).toISOString().slice(0, 10) : ''; };
const first = (...v) => { const x = v.find((y) => y != null && y !== ''); return x == null ? '' : x; };
const nested = (o, path) => path.split('.').reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), o);

// Aptly Work Orders board card -> the few fields Today needs. Key names are read tolerantly (uuid key, label, or nested path)
// because the board API's exact shape is confirmed on the preview, not here.
export function aptlyInfo(c) {
  if (!c || typeof c !== 'object') return null;
  const vend = Array.isArray(c.vendor) && c.vendor[0] ? c.vendor[0].name : c.vendorName || '';
  // The live board LIST has no comments (they are read per card, see withNotes). If a list ever carries them, use them.
  const hasList = Array.isArray(c.comments);
  const comments = hasList ? mapComments(c.comments) : [];
  const note = hasList ? lastHumanNote(comments) : null;
  // Live list: lastActivity = { direction: 'in' | 'out', publishedAt, type, content }. One date, with its direction.
  const la = c.lastActivity && typeof c.lastActivity === 'object' ? c.lastActivity : null;
  const laAt = la && la.publishedAt ? String(la.publishedAt) : '';
  const laIn = !!(la && /^in/i.test(String(la.direction || '')));
  const laOut = !!(la && /^out/i.test(String(la.direction || '')));
  const info = {
    cardId: String(first(c.cardId, c._id, '')).trim(), comments, lastNote: note, vconfirm: hasList ? parseVendorConfirm(comments) : null, commentCount: comments.length, notesKnown: hasList,
    number: String(first(c.workOrderNumber, c['Work Order Number'], '')).trim(),
    stage: String(first(c.stage, c.Stage, '')).trim(),
    vendor: String(vend || '').trim(),
    vendorAssignedAt: String(first(c.YAGZ5AXtxHjhAQNPX, c.vendorAssigned, c['Vendor Assigned'], '')),
    stageChangedAt: String(first(c.stageUpdatedAt, c['Stage Changed'], nested(c, 'metrics.stageUpdatedAt'), '')),
    lastInboundAt: String(first(laIn ? laAt : '', nested(c, 'metrics.activity.lastInboundAt'), c['metrics.activity.lastInboundAt'], c['Last Inbound At'], '')),
    lastOutboundAt: String(first(laOut ? laAt : '', nested(c, 'metrics.activity.lastOutboundAt'), c['metrics.activity.lastOutboundAt'], c['Last Outbound At'], '')),
    scheduledStart: String(first(c.scheduledStartDate, c['Scheduled Start Date'], '')).slice(0, 10),
  };
  return info.number ? info : null;
}
// Attach a card's comments (read separately) to its info. Returns a new object; the cached one is not changed.
export function withNotes(info, comments) {
  const list = Array.isArray(comments) ? comments : [];
  return { ...info, comments: list, lastNote: lastHumanNote(list), vconfirm: parseVendorConfirm(list), commentCount: list.length, notesKnown: true };
}
export function indexAptly(cards) {
  const map = new Map();
  for (const c of Array.isArray(cards) ? cards : []) { const i = aptlyInfo(c); if (i) map.set(i.number, i); }
  return map;
}
export function aptlyDiag(map) {
  const v = [...map.values()];
  return { cards: v.length, withStage: v.filter((x) => x.stage).length, withVendorAssigned: v.filter((x) => x.vendorAssignedAt).length,
    withStageChanged: v.filter((x) => x.stageChangedAt).length, withLastInbound: v.filter((x) => x.lastInboundAt).length, withLastOutbound: v.filter((x) => x.lastOutboundAt).length,
    withCardId: v.filter((x) => x.cardId).length, withComments: v.filter((x) => x.commentCount).length, withHumanNote: v.filter((x) => x.lastNote).length, withNotesLoaded: v.filter((x) => x.notesKnown).length,
    withLastActivity: v.filter((x) => x.lastInboundAt || x.lastOutboundAt).length };
}

// Which list a work order belongs to. Aptly's stage or Rentvine's status can each say Unit Turn / Move Out (they do not always match),
// so either one counts. 'turn' = Unit Turn (Persia / Teri), 'moveout' = Move Out, otherwise 'maint' (Roberto's maintenance list).
export function workKind(aptlyStage, rvStage, rvStatusId) {
  const a = String(aptlyStage || ''), r = String(rvStage || ''), sid = Number(rvStatusId || 0);
  if (a === 'Unit Turn' || r === 'Unit Turn' || sid === 25) return 'turn';
  if (a === 'Move Out' || r === 'Move Out' || sid === 23) return 'moveout';
  return 'maint';
}
export function countKinds(kinds) {
  const c = { all: 0, maint: 0, turns: 0, moveouts: 0 };
  for (const k of kinds || []) { c.all++; if (k === 'turn') c.turns++; else if (k === 'moveout') c.moveouts++; else c.maint++; }
  return c;
}

// Business time: Mon-Fri 9am-6pm Phoenix (no daylight saving, UTC-7). Emergencies are measured in clock time instead (Randi, Nov 5 2026).
const PHX_MS = 7 * 3600000;
export function bizHoursBetween(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  const a = startMs - PHX_MS, b = endMs - PHX_MS, DAY = 86400000;
  let hours = 0;
  for (let d = Math.floor(a / DAY) * DAY; d <= b && d - a < 400 * DAY; d += DAY) {
    const dow = new Date(d).getUTCDay(); if (dow === 0 || dow === 6) continue;
    const lo = Math.max(a, d + 9 * 3600000), hi = Math.min(b, d + 18 * 3600000);
    if (hi > lo) hours += (hi - lo) / 3600000;
  }
  return hours;
}
// Weekdays after date a up to and including date b (YYYY-MM-DD).
export function bizDays(a, b) {
  if (!a || !b || b <= a) return 0;
  let n = 0; const t = new Date(a + 'T12:00:00Z');
  for (let i = 0; i < 400; i++) { t.setUTCDate(t.getUTCDate() + 1); const d = t.toISOString().slice(0, 10); if (d > b) break; const w = t.getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}
const hrs = (h) => (h < 1 ? 'under 1 hour' : Math.round(h) === 1 ? '1 hour' : Math.round(h) + ' hours');

const PARKED = new Set(['On Hold', 'Waiting for parts', 'Owner Maintained']);
const NO_VENDOR_TIMER = new Set([...PARKED, 'Home Warranty', 'Troubleshooting Steps Sent', 'Internal Work Order Request', 'Unit Turn', 'Scheduled', 'Open', 'Dispatch Work Order']);
export const SECTION_DEFS = [
  { key: 'followups', title: 'Your follow-ups due', hint: 'You set these. Today or earlier.' },
  { key: 'dispatch', title: 'Dispatch now', hint: 'Open or Dispatch Work Order, no vendor yet' },
  { key: 'vendor', title: 'Vendor assigned, waiting on a date', hint: 'Assigned, no scheduled date yet. Amber at 2 days, red at 3 days: call or text the vendor, then update the tenant. When the vendor answers, click Vendor confirmed' },
  { key: 'warranty', title: 'Home warranty: follow up', hint: 'The home warranty company has the job. Follow up if nobody has contacted them or written a note in 2 business days' },
  { key: 'confirmed', title: 'Vendor confirmed, put the date on the card', hint: 'The vendor gave a date or said they will come. Red the day after that date passes. Put the date on the Aptly card (Scheduled stage)' },
  { key: 'nodate', title: 'Marked Scheduled, no date on the card', hint: 'The stage says Scheduled but no date is on the card. Put the date on the card, or fix the stage' },
  { key: 'passed', title: 'Scheduled date passed, still open', hint: 'Confirm the work happened' },
  { key: 'tenant', title: 'Waiting on tenant', hint: 'Troubleshooting steps sent 2+ days ago' },
  { key: 'internal', title: 'Internal work order requests', hint: 'Handled in house' },
  { key: 'parked', title: 'Parked: on hold, waiting on parts or the owner', hint: 'These are off the daily list until they go quiet. Red when nobody has contacted anyone or written a note in 7 days. Check in at least weekly' },
  { key: 'quiet', title: 'No contact or note in 3+ business days', hint: 'Nobody has texted, emailed or written a note on the card in 3 business days (Mon-Fri). Make contact, or write the reason on the card' },
  { key: 'turns', title: 'Unit turns and move-outs', hint: 'Persia or Teri. Kept apart from Roberto\'s list and numbers. Amber when nobody has made contact or written a note in 5 days; red when a follow-up you set is due', muted: true },
];

// rows = buildWorkOrderRows output; aptly = Map(number -> aptlyInfo); fu = foldFollowups output ({byWo}); today = 'YYYY-MM-DD' (Phoenix)
export function buildToday(rows, aptly = new Map(), fu = { byWo: {} }, today = todayPhoenix(), nowMs = null) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.parse(today + 'T19:00:00Z');
  const sections = Object.fromEntries(SECTION_DEFS.map((s) => [s.key, []]));
  let parked = 0, noAssignedDate = 0;
  const open = [];
  for (const r of rows || []) {
    const a = aptly.get(String(r.number)) || null;
    const stage = (a && a.stage) || r.stage;
    const vendor = r.vendor || (a && a.vendor) || '';
    const assignedDate = a && a.vendorAssignedAt ? phxDate(a.vendorAssignedAt) : (a && stage === 'Requested' && a.stageChangedAt ? phxDate(a.stageChangedAt) : '');
    const assignedDays = assignedDate ? daysBetween(assignedDate, today) : null;
    const stageDate = a && a.stageChangedAt ? phxDate(a.stageChangedAt) : '';
    const daysInStage = stageDate ? daysBetween(stageDate, today) : r.ageDays;
    const sched = (a && a.scheduledStart) || r.scheduled || '';
    const scheduled = stage === 'Scheduled' || !!sched;
    const inD = a && a.lastInboundAt ? daysBetween(phxDate(a.lastInboundAt), today) : null;
    const outD = a && a.lastOutboundAt ? daysBetween(phxDate(a.lastOutboundAt), today) : null;
    const notesKnown = !!(a && a.notesKnown);
    const noteD = notesKnown && a.lastNote && a.lastNote.at ? daysBetween(phxDate(a.lastNote.at), today) : null;
    // A person's note counts as a touch (Aptly's own Last Touch ignores comments).
    const touches = [inD, outD, noteD].filter((x) => x != null);
    const lastTouchDays = touches.length ? Math.min(...touches) : null;
    const dts = [a && a.lastInboundAt ? phxDate(a.lastInboundAt) : '', a && a.lastOutboundAt ? phxDate(a.lastOutboundAt) : '', notesKnown && a.lastNote && a.lastNote.at ? phxDate(a.lastNote.at) : ''].filter(Boolean);
    const touchBiz = dts.length ? Math.min(...dts.map((d) => bizDays(d, today))) : null;
    const stageMs = a && a.stageChangedAt ? Date.parse(a.stageChangedAt) : NaN;
    const emgNow = !!r.emergency;
    const hoursInStage = Number.isFinite(stageMs) ? (emgNow ? Math.max(0, (now - stageMs) / 3600000) : bizHoursBetween(stageMs, now)) : null;
    const noteWhy = !notesKnown ? '' : noteD == null ? ' No note on the card yet.' : ' Last note ' + (noteD === 0 ? 'today' : noteD + (noteD === 1 ? ' day' : ' days') + ' ago') + '.';
    // Red only when it is overdue: no note for 3+ days, or no note at all on a work order that is 2+ days old (a brand-new one is not late yet).
    const staleNote = notesKnown && (noteD == null ? (r.ageDays == null || r.ageDays >= 2) : noteD >= 3);
    const f = (fu.byWo || {})[String(r.number)] || null;
    const base = { id: r.id, number: r.number, propertyId: r.propertyId, address: r.address, summary: r.summary, stage, vendor, moveOut: stage === 'Move Out' || r.moveOut || workKind(a && a.stage, r.stage, r.statusId) === 'moveout',
      emergency: r.emergency, cardId: a && a.cardId ? a.cardId : '', daysInStage, hoursInStage, touchBiz, assignedDays, lastInDays: inD, lastOutDays: outD, scheduled: sched || null,
      followUpOn: f ? f.followUpOn : null, lastNote: f && f.notes[0] ? f.notes[0] : null, noteCount: f ? f.notes.length : 0, matched: !!a,
      notesKnown, commentCount: notesKnown ? a.commentCount : 0, aptNote: a && a.lastNote ? { by: a.lastNote.by, at: a.lastNote.at, days: noteD, text: a.lastNote.text } : null, staleNote };
    const put = (key, level, why) => sections[key].push({ ...base, level, why });

    if (workKind(a && a.stage, r.stage, r.statusId) !== 'maint') {
      const idle = lastTouchDays != null ? lastTouchDays : (notesKnown ? daysInStage : null);
      if (base.followUpOn && base.followUpOn <= today) put('turns', 'red', 'Follow-up set for ' + base.followUpOn);
      else if (idle != null && idle >= 5) put('turns', 'amber', 'No contact or note in ' + idle + ' days. Persia / Teri.');
      else put('turns', 'grey', 'Persia / Teri');
      continue;
    }
    open.push({ id: r.id, number: r.number, propertyId: r.propertyId, address: r.address, summary: r.summary, stage, vendor, emergency: r.emergency, cardId: base.cardId, scheduled: base.scheduled,
      touchDays: lastTouchDays, touchBiz, daysInStage, hoursInStage, matched: !!a, parked: PARKED.has(stage) });
    if (PARKED.has(stage)) {
      parked++;
      if (base.followUpOn && base.followUpOn <= today) { put('followups', 'red', 'Follow-up set for ' + base.followUpOn); continue; }
      const idleP = lastTouchDays != null ? lastTouchDays : (notesKnown ? daysInStage : null);
      put('parked', idleP != null && idleP >= 7 ? 'red' : idleP != null && idleP >= 5 ? 'amber' : 'grey', stage + (idleP != null && idleP >= 5 ? '. No contact or note in ' + idleP + ' days.' : '. Check in at least weekly.') + (base.followUpOn ? ' Follow-up set for ' + base.followUpOn + '.' : ''));
      continue;
    }
    if (base.followUpOn && base.followUpOn <= today) { put('followups', 'red', 'Follow-up set for ' + base.followUpOn); continue; }
    if (stage === 'Home Warranty') {
      if (touchBiz == null || touchBiz >= 2) put('warranty', 'red', 'Follow up with the home warranty company. ' + (touchBiz == null ? 'No contact or note on the card yet.' : 'No contact or note in ' + touchBiz + ' business days.'));
      else put('warranty', 'grey', 'Home warranty has the job. Last contact or note ' + (touchBiz === 0 ? 'today' : touchBiz + ' business day' + (touchBiz === 1 ? '' : 's') + ' ago') + '.');
      continue;
    }
    if (!vendor && (stage === 'Open' || stage === 'Dispatch Work Order')) { put('dispatch', 'red', 'Assign a vendor now' + (hoursInStage == null ? '' : '. ' + hrs(hoursInStage) + (emgNow ? ' (clock time, emergency)' : ' of business time') + ' without a vendor.')); continue; }
    // A "Vendor confirmed" comment written after the vendor was assigned (a reassignment makes an older one stale).
    const vc = notesKnown && a.vconfirm && (!assignedDate || phxDate(a.vconfirm.at) >= assignedDate) ? a.vconfirm : null;
    base.vendorConfirm = vc ? { by: vc.by, at: vc.at, date: vc.date || null } : null;
    if (vendor && !scheduled && vc && !NO_VENDOR_TIMER.has(stage)) {
      const cd = daysBetween(phxDate(vc.at), today);
      if (vc.date) {
        const over = daysBetween(vc.date, today);
        if (over >= 1) { put('confirmed', 'red', 'Vendor said ' + vc.date + ', ' + over + (over === 1 ? ' day' : ' days') + ' ago. Update the card or follow up. Confirmed by ' + vc.by + '.'); continue; }
        put('confirmed', 'grey', 'Vendor said ' + vc.date + '. Confirmed by ' + vc.by + '. Put the date on the Aptly card.'); continue;
      }
      if (cd >= 3) put('confirmed', 'red', 'Vendor confirmed with no date ' + cd + ' days ago (' + vc.by + '). Get a date.');
      else if (cd >= 2) put('confirmed', 'amber', 'Vendor confirmed with no date ' + cd + ' days ago (' + vc.by + '). Get a date.');
      else put('confirmed', 'grey', 'Vendor confirmed ' + (cd === 0 ? 'today' : 'yesterday') + ', date not given (' + vc.by + ').');
      continue;
    }
    if (vendor && !scheduled && !NO_VENDOR_TIMER.has(stage)) {
      if (assignedDays == null) noAssignedDate++;
      else if (assignedDays >= 3) { put('vendor', 'red', 'Follow up with vendor: ' + assignedDays + ' days since assigned. The tenant may not have heard.'); continue; }
      else if (assignedDays >= 2) { put('vendor', 'amber', 'Not scheduled: ' + assignedDays + ' days since assigned'); continue; }
    }
    if (stage === 'Scheduled' && !sched) { put('nodate', staleNote ? 'red' : 'amber', 'No scheduled date on the card.' + noteWhy); continue; }
    if (sched && sched < today && stage !== 'Completed') { put('passed', staleNote ? 'red' : 'amber', 'Scheduled ' + sched + ' (' + daysBetween(sched, today) + ' days ago).' + noteWhy); continue; }
    if (stage === 'Troubleshooting Steps Sent') {
      const late = hoursInStage != null ? hoursInStage >= (emgNow ? 24 : 9) : (daysInStage || 0) >= 1;
      if (late) { put('tenant', 'red', 'Troubleshooting sent ' + (hoursInStage != null ? hrs(hoursInStage) + (emgNow ? ' ago' : ' of business time ago') : daysInStage + ' days ago') + '. Past 1 business day: move to Dispatch Work Order or call the tenant.'); continue; }
    }
    if (stage === 'Internal Work Order Request') { put('internal', (daysInStage || 0) >= 3 ? 'amber' : 'grey', 'Internal request, ' + (daysInStage == null ? '?' : daysInStage) + ' days in stage'); continue; }
    if (touchBiz != null && touchBiz >= 3) put('quiet', 'red', 'No contact or note in ' + touchBiz + ' business days. Make contact or write the reason on the card.');
  }
  const sev = { red: 0, amber: 1, grey: 2 };
  for (const k of Object.keys(sections)) sections[k].sort((x, y) => sev[x.level] - sev[y.level] || (y.emergency ? 1 : 0) - (x.emergency ? 1 : 0) || (y.assignedDays ?? y.daysInStage ?? 0) - (x.assignedDays ?? x.daysInStage ?? 0));
  return { sections: SECTION_DEFS.map((d) => ({ ...d, items: sections[d.key] })), parked, noAssignedDate, today, overview: buildOverview(open, sections, today) };
}

// Overview tab numbers (pure). open = Roberto's open maintenance work orders (unit turns and move-outs are left out); sections = buildToday sections.
// Calendar = Monday..Sunday of the week that holds today, plus the following week's jobs. A job is on a day when the card's Scheduled Start Date is that day.
export function buildOverview(open, sections, today) {
  const list = Array.isArray(open) ? open : [];
  const d0 = new Date(today + 'T12:00:00Z'); const dow = (d0.getUTCDay() + 6) % 7;
  const add = (n) => { const t = new Date(d0.getTime()); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const weekStart = add(-dow);
  const days = Array.from({ length: 14 }, (_, i) => add(i - dow));
  const jobs = list.filter((x) => x.scheduled && days.includes(String(x.scheduled).slice(0, 10)))
    .map((x) => ({ ...x, date: String(x.scheduled).slice(0, 10) })).sort((p, q) => p.date.localeCompare(q.date) || String(p.address).localeCompare(String(q.address)));
  const week = days.slice(0, 7).map((date, i) => ({ date, dow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i], count: jobs.filter((j) => j.date === date).length, isToday: date === today }));
  const nextWeek = jobs.filter((j) => j.date > days[6]).length;
  const byStage = {}; for (const x of list) byStage[x.stage || 'Unknown'] = (byStage[x.stage || 'Unknown'] || 0) + 1;
  const stages = Object.entries(byStage).map(([stage, count]) => ({ stage, count })).sort((a, b) => b.count - a.count || a.stage.localeCompare(b.stage));
  const touch = { recent: 0, ok: 0, quiet: 0, cold: 0, unknown: 0 };
  for (const x of list) { const t = x.touchDays; if (t == null) touch.unknown++; else if (t <= 1) touch.recent++; else if (t <= 4) touch.ok++; else if (t <= 7) touch.quiet++; else touch.cold++; }
  const nudges = list.filter((x) => x.touchBiz != null && x.touchBiz >= 3).sort((a, b) => b.touchDays - a.touchDays).slice(0, 8);
  const sec = (k) => ((sections && sections[k]) || []);
  const mine = Object.keys(sections || {}).filter((k) => k !== 'turns').flatMap((k) => sections[k]);
  const tiles = { doNow: mine.filter((x) => x.level === 'red').length, followups: sec('followups').length, today: list.filter((x) => String(x.scheduled || '').slice(0, 10) === today).length,
    quiet: sec('quiet').length + sec('parked').filter((x) => x.level !== 'grey').length };
  return { tiles, weekStart, week, nextWeek, jobs, stages, touch, nudges, total: list.length };
}

// Fold append-only follow-up rows (newest first) into per-work-order state.
export function foldFollowups(rows) {
  const byWo = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const k = String(r.wo_number || '');
    if (!k) continue;
    const s = (byWo[k] = byWo[k] || { followUpOn: null, decided: false, notes: [] });
    if (!s.decided && (r.action === 'set_followup' || r.action === 'clear_followup')) { s.decided = true; s.followUpOn = r.action === 'set_followup' ? String(r.follow_up_on || '').slice(0, 10) || null : null; }
    if (String(r.note || '').trim() && s.notes.length < 20) s.notes.push({ at: (Number.isFinite(Date.parse(r.created_at)) ? new Date(Date.parse(r.created_at) - 7 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : ''), by: r.author_name ? r.author_name + ' (shared login)' : 'shared login', text: String(r.note), action: r.action, followUpOn: r.follow_up_on ? String(r.follow_up_on).slice(0, 10) : null });
  }
  return { byWo };
}
