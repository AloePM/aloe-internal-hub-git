// Maintenance follow-up notes and next-contact dates, kept by the hub in its own Supabase table (maintenance_followups).
// Append-only: rows are added, never edited or deleted, so there is always a history of what was set and when. Nothing here touches
// Rentvine, Aptly or Slack. Until individual logins exist, the author is "shared login" plus an optional self-reported name.
const TABLE = 'maintenance_followups';

export function validateEntry(b, today) {
  b = b || {};
  const woNumber = String(b.woNumber || '').trim();
  if (!/^\d{3,9}$/.test(woNumber)) return { error: 'Bad work order number.' };
  const propertyId = String(b.propertyId || '').trim();
  if (propertyId && !/^\d{1,9}$/.test(propertyId)) return { error: 'Bad property id.' };
  const action = String(b.action || '');
  if (!['note', 'set_followup', 'clear_followup'].includes(action)) return { error: 'Bad action.' };
  const note = String(b.note == null ? '' : b.note).replace(/\s+/g, ' ').trim().slice(0, 1000);
  let followUpOn = null;
  if (action === 'set_followup') {
    const d = String(b.followUpOn || '');
    const ok = /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d + 'T12:00:00Z').toISOString().slice(0, 10) === d;
    if (!ok) return { error: 'Pick a follow-up date.' };
    if (d < today) return { error: 'The follow-up date is in the past.' };
    if (d > new Date(Date.parse(today + 'T12:00:00Z') + 366 * 86400000).toISOString().slice(0, 10)) return { error: 'The follow-up date is more than a year away.' };
    followUpOn = d;
  }
  if (action === 'note' && !note) return { error: 'Write a note first.' };
  const authorName = String(b.authorName || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 60);
  return { entry: { wo_number: woNumber, property_id: propertyId || null, action, note: note || null, follow_up_on: followUpOn, author: 'shared login', author_name: authorName || null } };
}

export function makeFollowupStore(env = process.env, fetchImpl = fetch) {
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  const hdr = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const configured = !!(url && key);
  return {
    configured,
    async list(days = 120) {
      if (!configured) return { available: false, reason: 'not_configured', rows: [] };
      const p = new URLSearchParams({ order: 'created_at.desc', limit: '2000', created_at: 'gte.' + new Date(Date.now() - days * 86400000).toISOString() });
      const r = await fetchImpl(`${url}/rest/v1/${TABLE}?${p}`, { headers: hdr });
      if (r.status === 404) return { available: false, reason: 'no_table', rows: [] };
      if (!r.ok) throw new Error('followups ' + r.status);
      return { available: true, rows: await r.json() };
    },
    async add(entry) {
      if (!configured) return { ok: false, reason: 'not_configured' };
      const r = await fetchImpl(`${url}/rest/v1/${TABLE}`, { method: 'POST', headers: { ...hdr, Prefer: 'return=minimal' }, body: JSON.stringify(entry) });
      if (r.status === 404) return { ok: false, reason: 'no_table' };
      if (!r.ok) throw new Error('followups write ' + r.status);
      return { ok: true };
    },
  };
}
