// Quo (texts) for the Maintenance page. READ-ONLY: it only lists messages on the Main Office line for the phone numbers on a work order's lease.
// The key comes from the QUO_API_TOKEN setting (Secret Manager). Without it, everything reports "not set up" and nothing breaks.
const BASE = 'https://api.quo.com/v1';
const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
export const e164 = (s) => { const d = digits(s); if (d.length === 10) return '+1' + d; if (d.length === 11 && d[0] === '1') return '+' + d; return ''; };
export const maskPhone = (s) => { const d = digits(s).slice(-10); return d.length === 10 ? '(***) ***-' + d.slice(6) : ''; };
export const showPhone = (s) => { const d = digits(s).slice(-10); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : ''; };
const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export function makeQuoClient({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const token = String(env.QUO_API_TOKEN || '').trim();
  const phoneNumberId = String(env.QUO_PHONE_NUMBER_ID || 'PNRRARIpQO').trim();
  const cache = new Map(); const TTL = 3 * 60 * 1000;
  const gap = []; // simple rate limit: at most 8 calls per second
  async function slot() { for (;;) { const t = now(); while (gap.length && t - gap[0] > 1000) gap.shift(); if (gap.length < 8) { gap.push(t); return; } await new Promise((r) => setTimeout(r, 120)); } }
  async function messagesFor(phone, max = 10) {
    const p = e164(phone); if (!p) return { ok: false, reason: 'bad_phone' };
    const hit = cache.get(p); if (hit && now() - hit.at < TTL) return hit.v;
    await slot();
    const url = BASE + '/messages?phoneNumberId=' + encodeURIComponent(phoneNumberId) + '&participants=' + encodeURIComponent(p) + '&maxResults=' + max;
    let v;
    try {
      const r = await fetchImpl(url, { headers: { Authorization: token, Accept: 'application/json' } });
      if (r.status === 401 || r.status === 403) v = { ok: false, reason: 'quo_denied' };
      else if (r.status === 429) v = { ok: false, reason: 'quo_busy' };
      else if (!r.ok) v = { ok: false, reason: 'quo_error' };
      else { const b = await r.json(); v = { ok: true, items: (Array.isArray(b && b.data) ? b.data : []).map((m) => ({ at: String(m.createdAt || ''), dir: m.direction === 'incoming' ? 'in' : 'out', text: clip(m.text, 280), status: String(m.status || ''), media: Array.isArray(m.media) ? m.media.length : 0 })) }; }
    } catch (e) { v = { ok: false, reason: 'quo_error' }; }
    if (v.ok) cache.set(p, { at: now(), v }); if (cache.size > 500) cache.delete(cache.keys().next().value);
    return v;
  }
  const fromNumber = e164(env.QUO_FROM_NUMBER || '+16028549884'); // Main Office line, used only to pre-select the line in a Quo text link
  return { configured: !!token, phoneNumberId, fromNumber, messagesFor };
}

// Merge the messages from several numbers, newest first.
export function mergeThreads(perPhone, limit = 12) {
  const all = [];
  for (const { phone, name, res } of perPhone) if (res && res.ok) for (const m of res.items) all.push({ ...m, who: (name ? name + ' ' : '') + showPhone(phone) });
  all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return all.slice(0, limit);
}
