// Maintenance "Today" list - pure functions (no network, no writes). Used by maintenance-routes.js and the tests.
// Rules (Randi, Oct 27 2026): vendor must be scheduled within 2 days of assignment; at 3 days with no schedule, follow up with the vendor
// (the tenant may not have heard). Days are CALENDAR days in Phoenix time. Unit turns belong to Persia or Teri, everything else to Roberto.
import { daysBetween, todayPhoenix } from './maintenance-data.js';
import { mapComments, lastHumanNote } from './maintenance-comments.js';

const phxDate = (iso) => { const t = Date.parse(iso); return isFinite(t) ? new Date(t - 7 * 3600000).toISOString().slice(0, 10) : ''; };
const first = (...v) => { const x = v.find((y) => y != null && y !== ''); return x == null ? '' : x; };
const nested = (o, path) => path.split('.').reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), o);

// Aptly Work Orders board card -> the few fields Today needs. Key names are read tolerantly (uuid key, label, or nested path)
// because the board API's exact shape is confirmed on the preview, not here.
export function aptlyInfo(c) {
  if (!c || typeof c !== 'object') return null;
  const vend = Array.isArray(c.vendor) && c.vendor[0] ? c.vendor[0].name : c.vendorName || '';
  const comments = mapComments(c.comments);
  const note = lastHumanNote(comments);
  const info = {
    cardId: String(first(c.cardId, c._id, '')).trim(), comments, lastNote: note, commentCount: comments.length,
    number: String(first(c.workOrderNumber, c['Work Order Number'], '')).trim(),
    stage: String(first(c.stage, c.Stage, '')).trim(),
    vendor: String(vend || '').trim(),
    vendorAssignedAt: String(first(c.YAGZ5AXtxHjhAQNPX, c.vendorAssigned, c['Vendor Assigned'], '')),
    stageChangedAt: String(first(c.stageUpdatedAt, c['Stage Changed'], nested(c, 'metrics.stageUpdatedAt'), '')),
    lastInboundAt: String(first(nested(c, 'metrics.activity.lastInboundAt'), c['metrics.activity.lastInboundAt'], c['Last Inbound At'], '')),
    lastOutboundAt: String(first(nested(c, 'metrics.activity.lastOutboundAt'), c['metrics.activity.lastOutboundAt'], c['Last Outbound At'], '')),
    scheduledStart: String(first(c.scheduledStartDate, c['Scheduled Start Date'], '')).slice(0, 10),
  };
  return info.number ? info : null;
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
    withCardId: v.filter((x) => x.cardId).length, withComments: v.filter((x) => x.commentCount).length, withHumanNote: v.filter((x) => x.lastNote).length };
}

const PARKED = new Set(['On Hold', 'Waiting for parts', 'Owner Maintained']);
const NO_VENDOR_TIMER = new Set([...PARKED, 'Home Warranty', 'Troubleshooting Steps Sent', 'Internal Work Order Request', 'Unit Turn', 'Scheduled', 'Open', 'Dispatch Work Order']);
export const SECTION_DEFS = [
  { key: 'followups', title: 'Your follow-ups due', hint: 'You set these. Today or earlier.' },
  { key: 'dispatch', title: 'Dispatch now', hint: 'Open or Dispatch Work Order, no vendor yet' },
  { key: 'vendor', title: 'Vendor not scheduled', hint: 'Assigned, no scheduled date. Amber at 2 days, red at 3 days: call or text the vendor, then update the tenant' },
  { key: 'nodate', title: 'Marked Scheduled, no date on the card', hint: 'The stage says Scheduled but no date is on the card. Put the date on the card, or fix the stage' },
  { key: 'passed', title: 'Scheduled date passed, still open', hint: 'Confirm the work happened' },
  { key: 'tenant', title: 'Waiting on tenant', hint: 'Troubleshooting steps sent 2+ days ago' },
  { key: 'internal', title: 'Internal work order requests', hint: 'Handled in house' },
  { key: 'quiet', title: 'No contact or note in 5+ days', hint: 'Nobody has texted, emailed or written a note on the card in 5 days' },
  { key: 'turns', title: 'Unit turns', hint: 'Persia or Teri, not on Roberto\'s list', muted: true },
];

// rows = buildWorkOrderRows output; aptly = Map(number -> aptlyInfo); fu = foldFollowups output ({byWo}); today = 'YYYY-MM-DD' (Phoenix)
export function buildToday(rows, aptly = new Map(), fu = { byWo: {} }, today = todayPhoenix()) {
  const sections = Object.fromEntries(SECTION_DEFS.map((s) => [s.key, []]));
  let parked = 0, noAssignedDate = 0;
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
    const noteD = a && a.lastNote && a.lastNote.at ? daysBetween(phxDate(a.lastNote.at), today) : null;
    // A person's note counts as a touch (Aptly's own Last Touch ignores comments).
    const touches = [inD, outD, noteD].filter((x) => x != null);
    const lastTouchDays = touches.length ? Math.min(...touches) : null;
    const noteWhy = !a ? '' : noteD == null ? ' No note on the card yet.' : ' Last note ' + (noteD === 0 ? 'today' : noteD + (noteD === 1 ? ' day' : ' days') + ' ago') + '.';
    const staleNote = !!a && (noteD == null || noteD >= 3);
    const f = (fu.byWo || {})[String(r.number)] || null;
    const base = { id: r.id, number: r.number, propertyId: r.propertyId, address: r.address, summary: r.summary, stage, vendor, moveOut: stage === 'Move Out' || r.moveOut,
      emergency: r.emergency, daysInStage, assignedDays, lastInDays: inD, lastOutDays: outD, scheduled: sched || null,
      followUpOn: f ? f.followUpOn : null, lastNote: f && f.notes[0] ? f.notes[0] : null, noteCount: f ? f.notes.length : 0, matched: !!a,
      commentCount: a ? a.commentCount : 0, aptNote: a && a.lastNote ? { by: a.lastNote.by, at: a.lastNote.at, days: noteD, text: a.lastNote.text } : null, staleNote };
    const put = (key, level, why) => sections[key].push({ ...base, level, why });

    if (stage === 'Unit Turn') { put('turns', 'grey', 'Persia / Teri'); continue; }
    if (PARKED.has(stage)) { parked++; if (base.followUpOn && base.followUpOn <= today) put('followups', 'red', 'Follow-up set for ' + base.followUpOn); continue; }
    if (base.followUpOn && base.followUpOn <= today) { put('followups', 'red', 'Follow-up set for ' + base.followUpOn); continue; }
    if (!vendor && (stage === 'Open' || stage === 'Dispatch Work Order')) { put('dispatch', (daysInStage || 0) >= 1 ? 'red' : 'amber', 'Needs a vendor assigned'); continue; }
    if (vendor && !scheduled && !NO_VENDOR_TIMER.has(stage)) {
      if (assignedDays == null) noAssignedDate++;
      else if (assignedDays >= 3) { put('vendor', 'red', 'Follow up with vendor: ' + assignedDays + ' days since assigned. The tenant may not have heard.'); continue; }
      else if (assignedDays >= 2) { put('vendor', 'amber', 'Not scheduled: ' + assignedDays + ' days since assigned'); continue; }
    }
    if (stage === 'Scheduled' && !sched) { put('nodate', staleNote ? 'red' : 'amber', 'No scheduled date on the card.' + noteWhy); continue; }
    if (sched && sched < today && stage !== 'Completed') { put('passed', staleNote ? 'red' : 'amber', 'Scheduled ' + sched + ' (' + daysBetween(sched, today) + ' days ago).' + noteWhy); continue; }
    if (stage === 'Troubleshooting Steps Sent' && (daysInStage || 0) >= 2) { put('tenant', 'amber', 'Troubleshooting sent ' + daysInStage + ' days ago'); continue; }
    if (stage === 'Internal Work Order Request') { put('internal', (daysInStage || 0) >= 3 ? 'amber' : 'grey', 'Internal request, ' + (daysInStage == null ? '?' : daysInStage) + ' days in stage'); continue; }
    if (lastTouchDays != null && lastTouchDays >= 5) put('quiet', 'amber', 'No contact or note in ' + lastTouchDays + ' days');
  }
  const sev = { red: 0, amber: 1, grey: 2 };
  for (const k of Object.keys(sections)) sections[k].sort((x, y) => sev[x.level] - sev[y.level] || (y.assignedDays ?? y.daysInStage ?? 0) - (x.assignedDays ?? x.daysInStage ?? 0));
  return { sections: SECTION_DEFS.map((d) => ({ ...d, items: sections[d.key] })), parked, noAssignedDate, today };
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
