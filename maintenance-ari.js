// Maintenance area - what Ari did in Slack, per address. READ-ONLY.
// Ari's agent posts each action to the hub, which stores it in the Supabase table agent_activity.
// This file only reads that table (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come from the environment; never printed).

const TTL = 5 * 60 * 1000;
let cache = { at: 0, rows: null };

export async function loadAriRows(fetchImpl = fetch, env = process.env) {
  if (cache.rows && Date.now() - cache.at < TTL) return cache.rows;
  const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const params = new URLSearchParams({ order: 'created_at.desc', limit: '400', agent_id: 'ilike.*ari*' });
  const r = await fetchImpl(`${url}/rest/v1/agent_activity?${params}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error('agent_activity ' + r.status);
  const rows = await r.json();
  cache = { at: Date.now(), rows: Array.isArray(rows) ? rows : [] };
  return cache.rows;
}
export function _resetAriCache() { cache = { at: 0, rows: null }; }

// Rows whose "property" text is the same street address (matched with the same addrKey Move-outs uses).
export function ariForAddress(rows, address, addrKey, limit = 25) {
  const key = addrKey(address);
  if (!key || !Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    const k = addrKey(String(r.property || ''));
    if (!k || k !== key) continue;
    out.push({
      at: String(r.created_at || '').slice(0, 16).replace('T', ' '),
      category: String(r.category || ''), type: String(r.type || ''), outcome: String(r.outcome || ''),
      summary: String(r.summary || '').slice(0, 300),
    });
    if (out.length >= limit) break;
  }
  return out;
}
