// Maintenance comments on Aptly Work Orders cards (Package 3).
// READ: the board list the hub already reads carries each card's comments. WRITE: one comment at a time on one card, through the same Aptly
// comment endpoint the hub already has (POST /api/board/workOrder/<cardId>/comment) with the hub's existing Aptly token. Nothing here touches
// Rentvine, Slack or any other board. The card id always comes from the hub's own board read, never from the browser.
// Until individual logins exist the person picks their name from a fixed list and the text is posted as "[Hub · Name] ...".
import { NAMES } from './maintenance-followups.js';

const MAX = 1000;
export const AUTO_PREFIX = '[Automated]';

// Aptly stores some comments as small pieces of HTML (@mentions, line breaks). Turn them into plain text; the page shows text only.
export function cleanText(s) {
  return String(s == null ? '' : s).replace(/\r/g, '').replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
// Aptly comment array -> newest first, trimmed. auto = anything not written by a person: Ari's [Automated] lines, Aptly's own notices
// (author "Aptly", e.g. "Tenant marked the issue as unresolved") and comments with no author name. Comments posted from the hub carry "[Hub ...".
export function mapComments(raw, limit = 60) {
  const list = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    if (!c || typeof c !== 'object') continue;
    const text = cleanText(c.content).slice(0, 2000);
    if (!text) continue;
    const t = Date.parse(c.createdAt), by = String(c.userName || '').trim(), hub = text.startsWith('[Hub ');
    list.push({ id: String(c.id || c._id || ''), by, at: Number.isFinite(t) ? new Date(t).toISOString() : '', text,
      auto: text.startsWith(AUTO_PREFIX) || by === 'Aptly' || (!by && !hub), hub });
  }
  list.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  return list.slice(0, limit);
}

// Newest comment written by a person (not Ari's automated ones). Hub comments count: they carry the picked name.
export function lastHumanNote(list) {
  const c = (list || []).find((x) => !x.auto);
  if (!c) return null;
  const hubName = c.hub ? (/^\[Hub\s*[·.-]\s*([^\]]{1,40})\]/.exec(c.text.trimStart()) || [])[1] : '';
  return { at: c.at, by: (hubName || c.by || 'unknown').trim(), text: c.text.replace(/^\[Hub\s*[·.-]\s*[^\]]{1,40}\]\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 160) };
}

// "Vendor confirmed" comments (written by the hub button, or typed the same way): "Vendor confirmed: <vendor>. Vendor date: 2026-10-30." or "Vendor date: not given."
// Returns the NEWEST one: { at, by, date ('YYYY-MM-DD' or ''), text }. list = mapComments output (newest first).
export function parseVendorConfirm(list) {
  for (const c of list || []) {
    if (c.auto) continue;
    const m = /^\[Hub\s*[·.-]\s*([^\]]{1,40})\]\s*Vendor confirmed\b[\s\S]*?Vendor date:\s*(\d{4}-\d{2}-\d{2}|not given)/i.exec(c.text.trimStart());
    if (m) return { at: c.at, by: m[1].trim(), date: /^\d/.test(m[2]) ? m[2] : '' };
  }
  return null;
}
export const vendorConfirmText = (vendor, date, note) => 'Vendor confirmed: ' + (vendor || 'vendor') + '. Vendor date: ' + (date || 'not given') + '.' + (note ? ' ' + note : '');

export function validateComment(b) {
  b = b || {};
  const woNumber = String(b.woNumber || '').trim();
  if (!/^\d{3,9}$/.test(woNumber)) return { error: 'Bad work order number.' };
  const authorName = String(b.authorName || '');
  if (!NAMES.includes(authorName)) return { error: 'Pick your name first.' };
  const text = String(b.text == null ? '' : b.text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return { error: 'Write a comment first.' };
  if (text.length > MAX) return { error: 'The comment is longer than ' + MAX + ' characters.' };
  return { woNumber, authorName, text, content: formatComment(authorName, text) };
}
export const formatComment = (name, text) => '[Hub · ' + name + '] ' + text;

// Text for the comment that mirrors a saved follow-up (only when the person ticks the box).
export function followupComment(entry) {
  const date = entry.follow_up_on ? entry.follow_up_on.slice(5, 7) + '/' + entry.follow_up_on.slice(8, 10) + '/' + entry.follow_up_on.slice(0, 4) : '';
  const head = entry.action === 'set_followup' ? 'Follow-up set for ' + date + '.' : entry.action === 'clear_followup' ? 'Follow-up date cleared.' : '';
  return [head, entry.note || ''].filter(Boolean).join(' ');
}

export function makeAptlyCommenter(env = process.env, fetchImpl = fetch) {
  const token = env.APTLY_UNITS_TOKEN || env.APTLY_TOKEN || '';
  return {
    configured: !!token,
    async post(cardId, content) {
      if (!token) return { ok: false, reason: 'not_configured' };
      if (!/^[A-Za-z0-9]{8,40}$/.test(String(cardId || ''))) return { ok: false, reason: 'bad_card' };
      const r = await fetchImpl('https://core-api.getaptly.com/api/board/workOrder/' + cardId + '/comment', {
        method: 'POST', headers: { 'x-token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ content }), signal: AbortSignal.timeout(15000) });
      if (!r.ok) { let body = ''; try { body = (await r.text()).slice(0, 200); } catch {} return { ok: false, reason: 'aptly_' + r.status, detail: body }; }
      return { ok: true };
    },
  };
}
