// ─────────────────────────────────────────────────────────────────────────────
// custom-field-update-route.js
// Aloe PM — Agent-driven Rentvine Custom Field Updater
//
// POST /api/rentvine/update-property-fields
//   Called by Ari, Kat, or Appliance Scanner agents with extracted data.
//   Looks up property by address, maps field names → IDs, posts Slack
//   confirmation, and writes to Rentvine on approval.
//
// POST /api/rentvine/field-update-approve (Slack interaction handler)
//   Called by Slack when user clicks Approve or Skip.
// ─────────────────────────────────────────────────────────────────────────────

// ── Channel map by agent ──────────────────────────────────────────────────────
const AGENT_CHANNELS = {
  'ari':              'C0BC64LCKV1',  // #maintenance-ari
  'maintenance-ari':  'C0BC64LCKV1',
  'kat':              'C0BCJFW2L5A',  // #hoa-kat
  'hoa-kat':          'C0BCJFW2L5A',
  'appliance':        'C0BJ7GPD7T5',  // #appliance-scanner
  'appliance-scanner':'C0BJ7GPD7T5',
  'default':          'C0BJ7GPD7T5',
};

// ── In-memory pending store (GCS for durability, memory for speed) ────────────
// Key: pendingId → { propertyId, address, updates, agentName, channel, createdAt }
const pendingUpdates = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

// Normalize field name for fuzzy matching
function normName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Load all custom field definitions for objectType 5 (property)
// Uses a known property ID to get all field defs — field structure is same across all properties
// Returns flat array of { customFieldID, customFieldCategoryID, name, normName }
let _fieldDefCache = null;
let _fieldDefCacheTime = 0;

async function loadPropertyFieldDefs(rvBase, rvAuth, rvAccount) {
  // Cache for 1 hour
  if (_fieldDefCache && Date.now() - _fieldDefCacheTime < 3600000) return _fieldDefCache;

  // Use property ID 1 to get all field definitions (same schema across all properties)
  const res = await fetch(`${rvBase}/custom-fields/values/5/1`, {
    headers: { Authorization: `Basic ${rvAuth}`, 'X-Rentvine-Account': rvAccount }
  });
  if (!res.ok) throw new Error(`Field defs fetch failed: ${res.status}`);
  const categories = await res.json();
  const fields = [];
  for (const cat of (Array.isArray(categories) ? categories : [])) {
    const catID = cat.customFieldCategoryID;
    for (const f of (cat.fields || [])) {
      fields.push({
        customFieldID:         String(f.customFieldID),
        customFieldCategoryID: String(f.customFieldCategoryID || catID),
        name:                  f.name,
        normName:              normName(f.name),
        fieldTypeID:           f.fieldTypeID,
      });
    }
  }
  _fieldDefCache = fields;
  _fieldDefCacheTime = Date.now();
  return fields;
}

// Get current values for a property
async function getPropertyFieldValues(rvBase, rvAuth, rvAccount, propertyId) {
  const res = await fetch(`${rvBase}/custom-fields/values/5/${propertyId}`, {
    headers: { Authorization: `Basic ${rvAuth}`, 'X-Rentvine-Account': rvAccount }
  });
  if (!res.ok) throw new Error(`Field values fetch failed: ${res.status}`);
  const cats = await res.json();
  const map = {};
  for (const cat of (Array.isArray(cats) ? cats : [])) {
    for (const f of (cat.fields || [])) {
      map[String(f.customFieldID)] = {
        value: f.value,
        name:  f.name,
        catID: f.customFieldCategoryID,
      };
    }
  }
  return map;
}

// Write fields to Rentvine — one POST per category
async function writeFields(rvBase, rvAuth, rvAccount, propertyId, updates) {
  // Group by catID
  const byCat = {};
  for (const u of updates) {
    const catId = String(u.catID);
    if (!byCat[catId]) byCat[catId] = { customFieldCategoryID: catId };
    byCat[catId][String(u.fieldId)] = u.newValue;
  }
  for (const payload of Object.values(byCat)) {
    const res = await fetch(`${rvBase}/custom-fields/values/5/${propertyId}`, {
      method:  'POST',
      headers: {
        Authorization:      `Basic ${rvAuth}`,
        'X-Rentvine-Account': rvAccount,
        'Content-Type':     'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Write failed (cat ${payload.customFieldCategoryID}): ${res.status} ${await res.text()}`);
  }
}

// Find property ID by address
async function findPropertyByAddress(rvBase, rvAuth, rvAccount, address) {
  const norm = s => (s || '').toLowerCase().replace(/\b(north|south|east|west)\b/g, m => m[0]).replace(/[^a-z0-9]/g, '');
  const nAddr = norm(address);
  let page = 1;
  while (page <= 10) {
    const res = await fetch(`${rvBase}/properties/export?pageSize=200&page=${page}`, {
      headers: { Authorization: `Basic ${rvAuth}`, 'X-Rentvine-Account': rvAccount }
    });
    if (!res.ok) break;
    const batch = await res.json();
    const items = Array.isArray(batch) ? batch : (batch.data || []);
    if (!items.length) break;
    for (const item of items) {
      const p = item.property || item;
      if (norm(p.address).includes(nAddr.slice(0, 12)) || nAddr.includes(norm(p.address).slice(0, 12))) {
        return { propertyId: p.propertyID, address: p.address };
      }
    }
    if (items.length < 200) break;
    page++;
  }
  return null;
}

// Post Slack confirmation message
async function postSlackConfirmation(slackToken, channelId, pendingId, address, agentName, updates) {
  const fieldLines = updates.map(u => {
    const oldVal = u.existingValue ? `~~${u.existingValue}~~  →  ` : '';
    const overwriteFlag = u.wouldOverwrite ? ' ⚠️' : '';
    return `• *${u.fieldName}*: ${oldVal}\`${u.newValue}\`${overwriteFlag}`;
  }).join('\n');

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🏠 Property Field Update — Review Required*\n*Property:* ${address}\n*Source:* ${agentName}`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: fieldLines || '_No fields to update_' },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Approve & Write to Rentvine' },
          style: 'primary',
          action_id: `field_update_approve_${agentName.toLowerCase().replace(/[^a-z]/g,'')}`,
          value: pendingId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '⏭ Skip' },
          style: 'danger',
          action_id: `field_update_skip_${agentName.toLowerCase().replace(/[^a-z]/g,'')}`,
          value: pendingId,
        },
      ],
    },
    { type: 'divider' },
  ];

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: channelId, text: `Field update for ${address}`, blocks }),
  });
  return res.json();
}

// ── Route factory — call this with (app, env) from server.js ─────────────────
export function initCustomFieldUpdateRoutes(app, {
  RENTVINE_BASE, RENTVINE_AUTH, RENTVINE_ACCOUNT,
  SLACK_TOKEN, hubAuth,
}) {

  // ── POST /api/rentvine/update-property-fields ────────────────────────────
  // Called by agents with: { address, agent, fields: [{name, value}], source? }
  app.post('/api/rentvine/update-property-fields', hubAuth, async (req, res) => {
    const { address, agent = 'default', fields = [], source = '' } = req.body;

    if (!address) return res.status(400).json({ error: 'address required' });
    if (!fields.length) return res.status(400).json({ error: 'fields array required' });

    try {
      // 1. Find property
      const match = await findPropertyByAddress(RENTVINE_BASE, RENTVINE_AUTH, RENTVINE_ACCOUNT, address);
      if (!match) return res.status(404).json({ error: `No Rentvine property found for address: ${address}` });

      // 2. Load field definitions
      const fieldDefs = await loadPropertyFieldDefs(RENTVINE_BASE, RENTVINE_AUTH, RENTVINE_ACCOUNT);

      // 3. Map field names → IDs
      const updates = [];
      const unmatched = [];
      for (const { name, value } of fields) {
        if (!name || value === undefined || value === null || value === '') continue;
        const nName = normName(name);
        // Exact match first, then startsWith, then includes
        let def = fieldDefs.find(f => f.normName === nName)
                || fieldDefs.find(f => f.normName.startsWith(nName.slice(0, 8)))
                || fieldDefs.find(f => f.normName.includes(nName.slice(0, 6)));
        if (!def) { unmatched.push(name); continue; }
        updates.push({
          fieldId:   String(def.customFieldID),
          catID:     String(def.customFieldCategoryID),
          fieldName: def.name,
          newValue:  String(value),
        });
      }

      if (!updates.length) {
        return res.status(400).json({
          error: 'No fields could be matched',
          unmatched,
          hint: 'Use exact field names from Rentvine custom fields (e.g. "Dishwasher serial number")',
        });
      }

      // 4. Get current values for dedup display
      const currentValues = await getPropertyFieldValues(RENTVINE_BASE, RENTVINE_AUTH, RENTVINE_ACCOUNT, match.propertyId);
      for (const u of updates) {
        const existing = currentValues[u.fieldId];
        u.existingValue  = existing?.value || null;
        u.wouldOverwrite = !!existing?.value && existing.value !== u.newValue;
      }

      // 5. Store pending
      const pendingId = `pfu_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      pendingUpdates.set(pendingId, {
        pendingId,
        propertyId:  match.propertyId,
        address:     match.address,
        agentName:   agent,
        updates,
        source,
        createdAt:   new Date().toISOString(),
        status:      'pending',
      });

      // Clean up old pending entries (>24h)
      const cutoff = Date.now() - 86400000;
      for (const [k, v] of pendingUpdates) {
        if (new Date(v.createdAt).getTime() < cutoff) pendingUpdates.delete(k);
      }

      // 6. Post to Slack
      const channelId = AGENT_CHANNELS[agent.toLowerCase()] || AGENT_CHANNELS.default;
      await postSlackConfirmation(SLACK_TOKEN, channelId, pendingId, match.address, agent, updates);

      return res.json({
        ok: true,
        pendingId,
        propertyId:  match.propertyId,
        address:     match.address,
        fieldsQueued: updates.length,
        unmatched,
        message: `${updates.length} field(s) queued for approval in Slack${unmatched.length ? `. Could not match: ${unmatched.join(', ')}` : ''}`,
      });

    } catch(e) {
      console.error('update-property-fields error:', e);
      return res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/rentvine/field-update-slack-actions (Slack button handler) ──
  app.post('/api/rentvine/field-update-slack-actions',
    require('express').urlencoded({ extended: true }),
    async (req, res) => {
      res.sendStatus(200); // ACK immediately

      let payload;
      try { payload = JSON.parse(req.body.payload); } catch { return; }

      const action   = payload.actions?.[0];
      const pendingId = action?.value;
      if (!pendingId || !action) return;

      const record = pendingUpdates.get(pendingId);
      if (!record) {
        await updateSlackMsg(payload.response_url, '⚠️ This update has already been processed or expired.');
        return;
      }

      if (action.action_id === 'field_update_approve') {
        try {
          await writeFields(RENTVINE_BASE, RENTVINE_AUTH, RENTVINE_ACCOUNT, record.propertyId, record.updates);
          record.status = 'approved';
          pendingUpdates.delete(pendingId);

          const fieldList = record.updates.map(u => `• ${u.fieldName}: \`${u.newValue}\``).join('\n');
          await updateSlackMsg(payload.response_url,
            `✅ *Written to Rentvine*\n*${record.address}*\n${fieldList}`);
        } catch(e) {
          await updateSlackMsg(payload.response_url, `❌ Write failed: ${e.message}`);
        }

      } else if (action.action_id === 'field_update_skip') {
        record.status = 'skipped';
        pendingUpdates.delete(pendingId);
        await updateSlackMsg(payload.response_url, `⏭ Skipped — *${record.address}*`);
      }
  });

  // ── GET /api/rentvine/field-lookup (helper for agents) ───────────────────
  // Returns all field names + IDs so agents can reference them
  app.get('/api/rentvine/field-lookup', hubAuth, async (req, res) => {
    try {
      const defs = await loadPropertyFieldDefs(RENTVINE_BASE, RENTVINE_AUTH, RENTVINE_ACCOUNT);
      res.json(defs.map(f => ({
        name:     f.name,
        fieldId:  f.customFieldID,
        catID:    f.customFieldCategoryID,
      })));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
}

async function updateSlackMsg(responseUrl, text) {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ replace_original: true, text }),
  });
}
