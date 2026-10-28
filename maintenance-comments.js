// Maintenance comments on Aptly Work Orders cards (Package 3).
// READ: the board list the hub already reads carries each card's comments. WRITE: one comment at a time on one card, through the same Aptly
// comment endpoint the hub already has (POST /api/board/workOrder/<cardId>/comment) with the hub's existing Aptly token. Nothing here touches
// Rentvine, Slack or any other board. The card id always comes from the hub's own board read, never from the browser.
// Until individual logins exist the person picks their name from a fixed list and the text is posted as "[Hub · Name] ...".
import { NAMES } from './maintenance-followups.js';

const MAX = 1000;
export const AUTO_PREFIX = '[Automated]';

// Aptly comment array -> newest first, trimmed. auto = Ari's automated comments (not a person's follow-up).
export function mapComments(raw, limit = 60) {
  const list = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    if (!c || typeof c !== 'object') continue;
    const text = String(c.content == null ? '' : c.content).replace(/\r/g, '').slice(0, 2000);
    if (!text.trim()) continue;
    const t = Date.parse(c.createdAt);
    list.push({ id: String(c.id || c._id || ''), by: String(c.userName || '').trim(), at: Number.isFinite(t) ? new Date(t).toISOString() : '', text,
      auto: text.trimStart().startsWith(AUTO_PREFIX), hub: text.trimStart().startsWith('[Hub ') });
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
