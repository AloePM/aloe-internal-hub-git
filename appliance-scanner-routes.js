import { slackRawBody, slackSigCheck } from './auth-gate.js';
// ─────────────────────────────────────────────────────────────────────────────
// appliance-scanner-routes.js
// Aloe PM — Appliance & Property Data Scanner (Phase 1)
// Mounts on: /api/scanner/*
//
// Flow:
//   1. Pull zInspector properties (cursor paginated)
//   2. For each property, fetch most recent inspection photos via /api/media/
//   3. Run Claude vision on each photo — extract appliance data + detect pool/softener
//   4. Address-normalize match to Rentvine property
//   5. Post pending results to GCS for human review
//   6. Slack message per property with Approve/Skip buttons
//   7. On approval → PATCH Rentvine property custom fields
//   8. Dedup: never overwrite a field that already has data unless user approves
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import fetch from 'node-fetch';
import { Storage } from '@google-cloud/storage';

const router = express.Router();
const storage = new Storage();
const BUCKET = 'aloe-hub-data-496300';

// ── Env / config ─────────────────────────────────────────────────────────────
const ZI_KEY          = process.env.ZI_API_KEY;           // Base64 KeyID:Secret
const ZI_BASE         = 'https://portfolio.zinspector.com';
const ANT_KEY         = process.env.ANTHROPIC_API_KEY;
const RV_BASE         = process.env.RENTVINE_BASE || 'https://api.rentvine.com/v2';
const RV_AUTH         = process.env.RENTVINE_AUTH;
const RV_ACCOUNT      = process.env.RENTVINE_ACCOUNT || 'aloepm';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL   = process.env.SCANNER_SLACK_CHANNEL || 'C06BWVACZQF'; // #maintenance or set a dedicated channel
const ANT_MODEL       = 'claude-opus-4-5';

// ── GCS helpers ──────────────────────────────────────────────────────────────
async function gcsRead(key) {
  try {
    const [buf] = await storage.bucket(BUCKET).file(key).download();
    return JSON.parse(buf.toString());
  } catch { return null; }
}

async function gcsWrite(key, data) {
  await storage.bucket(BUCKET).file(key).save(JSON.stringify(data, null, 2), {
    contentType: 'application/json',
  });
}

// ── zInspector helpers ───────────────────────────────────────────────────────
async function ziFetch(path, params = {}) {
  const url = new URL(path, ZI_BASE);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== '') url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString(), { headers: { 'x-api-key': ZI_KEY } });
  if (!res.ok) throw new Error(`zInspector ${res.status}: ${await res.text()}`);
  return res.json();
}

async function ziAllPages(path, params = {}) {
  let results = [], cursor = null;
  do {
    const p = { ...params, page_size: 100 };
    if (cursor) p.cursor = cursor;
    const data = await ziFetch(path, p);
    const items = data.results || (Array.isArray(data) ? data : []);
    results = results.concat(items);
    cursor = data.next ? new URL(data.next).searchParams.get('cursor') : null;
  } while (cursor);
  return results;
}

// Get all photos for a property, most-recent-inspection-first
// Returns flat array of { url, area, detail, docId, docDate }
async function getPropertyPhotos(ziPropertyId, limit = 60) {
  // Fetch most recent completed document for this property
  const docsData = await ziFetch('/api/timeline/', {
    Property: ziPropertyId,
    completed: true,
    ordering: '-date',
    page_size: 5,
  });
  const docs = docsData.results || [];
  if (!docs.length) return [];

  const photos = [];
  for (const doc of docs) {
    if (photos.length >= limit) break;
    // Fetch media for this property (all areas — visual scan)
    const mediaData = await ziFetch('/api/media/', {
      Property: ziPropertyId,
      mediaType: 'IMAGE',
      page_size: 100,
    });
    const items = mediaData.results || [];
    items.forEach(m => {
      (m.actions || []).forEach(note => {
        const url = note.publicUrl || note.URL;
        if (url && !photos.find(p => p.url === url)) {
          photos.push({
            url,
            area:    note.AreaName || 'Unknown',
            detail:  note.Detail || '',
            docId:   doc.id,
            docDate: doc.Date,
          });
        }
      });
    });
    if (photos.length >= limit) break;
  }
  return photos.slice(0, limit);
}

// ── Rentvine helpers ──────────────────────────────────────────────────────────
async function rvFetch(path, options = {}) {
  const url = `${RV_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Basic ${RV_AUTH}`,
      'X-Rentvine-Account': RV_ACCOUNT,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Rentvine ${res.status}: ${await res.text()}`);
  return res.json();
}

// Load ALL Rentvine properties with addresses (cached in GCS 24h)
async function getRvProperties() {
  const cacheKey = 'scanner/rv-property-cache.json';
  const cached = await gcsRead(cacheKey);
  if (cached && cached._ts && Date.now() - cached._ts < 86400000) return cached.properties;

  let all = [], page = 1;
  while (true) {
    const data = await rvFetch(`/properties/export?page=${page}&pageSize=100&isActive=true`);
    const items = Array.isArray(data) ? data : (data.data || []);
    if (!items.length) break;
    const unwrapped = items.map(r => r.property || r);
    all = all.concat(unwrapped);
    if (items.length < 100) break;
    page++;
  }

  await gcsWrite(cacheKey, { _ts: Date.now(), properties: all });
  return all;
}

// Normalize address for matching
function normAddr(addr) {
  if (!addr) return '';
  return addr.toLowerCase()
    .replace(/\bstreet\b/g, 'st').replace(/\bdrive\b/g, 'dr')
    .replace(/\bavenue\b/g, 'ave').replace(/\bboulevard\b/g, 'blvd')
    .replace(/\blane\b/g, 'ln').replace(/\broad\b/g, 'rd')
    .replace(/\bcourt\b/g, 'ct').replace(/\bplace\b/g, 'pl')
    .replace(/\beast\b/g, 'e').replace(/\bwest\b/g, 'w')
    .replace(/\bnorth\b/g, 'n').replace(/\bsouth\b/g, 's')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function matchRvProperty(ziAddress, rvProperties) {
  const ziNorm = normAddr(ziAddress);
  // Extract street number + name prefix for fast filtering
  const ziNum = ziNorm.match(/^\d+/)?.[0] || '';

  let best = null, bestScore = 0;
  for (const p of rvProperties) {
    const rvAddr = normAddr(p.address || p.Address || '');
    if (ziNum && !rvAddr.startsWith(ziNum)) continue; // skip if street number differs

    const maxLen = Math.max(ziNorm.length, rvAddr.length);
    if (maxLen === 0) continue;
    const dist = levenshtein(ziNorm, rvAddr);
    const score = 1 - dist / maxLen;
    if (score > bestScore) { bestScore = score; best = p; }
  }

  return best && bestScore >= 0.80
    ? { property: best, confidence: bestScore }
    : null;
}

// Get current custom field values for a Rentvine property
async function getRvCustomFields(propertyId) {
  try {
    const data = await rvFetch(`/custom-fields/values/5/${propertyId}`);
    // Returns array of categories with fields — flatten to {fieldID: value} map
    const map = {};
    if (Array.isArray(data)) {
      data.forEach(cat => {
        (cat.fields || []).forEach(f => {
          map[f.customFieldID] = { value: f.value, name: f.name, catID: f.customFieldCategoryID };
        });
      });
    }
    return map;
  } catch { return {}; }
}

// PATCH custom fields on a Rentvine property
async function patchRvCustomFields(propertyId, fields) {
  // fields = { customFieldID: value, ... } grouped by categoryID
  // API requires one POST per category
  const byCat = {};
  Object.entries(fields).forEach(([fieldId, val]) => {
    const catId = val.catID;
    if (!byCat[catId]) byCat[catId] = { customFieldCategoryID: String(catId) };
    byCat[catId][String(fieldId)] = val.value !== undefined ? val.value : val;
  });
  const results = [];
  for (const payload of Object.values(byCat)) {
    const r = await rvFetch(`/custom-fields/values/5/${propertyId}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    results.push(r);
  }
  return results;
}

// ── Claude Vision ─────────────────────────────────────────────────────────────
const VISION_PROMPT = `You are analyzing a property inspection photo for a property management company.

Please examine this photo carefully and extract ALL of the following that are visible:

1. APPLIANCES — For each appliance visible (refrigerator, stove/range, oven, dishwasher, microwave, washer, dryer, water heater, water softener, AC unit, garbage disposal, cooktop):
   - Type of appliance
   - Brand name (from label/sticker)
   - Model number (from label/sticker — usually starts with letters+numbers)
   - Serial number (from label/sticker — usually longer than model number)
   - Color
   - Approximate condition (Good/Fair/Poor)

2. POOL — Is there a swimming pool or spa/hot tub visible? (yes/no)

3. WATER SOFTENER — Is there a water softener system visible? (yes/no) — look for cylindrical tank(s) in utility/garage areas

4. LABELS — Look very carefully at any stickers, data plates, or labels on appliances. These are usually on:
   - Inside the door frame (fridges, dishwashers)
   - Back of the unit
   - On a panel on the side or front

Respond ONLY with valid JSON, no other text:
{
  "appliances": [
    {
      "type": "refrigerator|stove|oven|dishwasher|microwave|washer|dryer|water_heater|water_softener|ac_unit|garbage_disposal|cooktop",
      "brand": "string or null",
      "model": "string or null",
      "serial": "string or null",
      "color": "string or null",
      "condition": "Good|Fair|Poor|null",
      "confidence": "high|medium|low",
      "labelVisible": true/false,
      "notes": "any relevant notes"
    }
  ],
  "poolDetected": true/false,
  "spaDetected": true/false,
  "waterSoftenerDetected": true/false,
  "photoQuality": "good|poor|unusable",
  "photoDescription": "one sentence describing what's in the photo"
}`;

async function analyzePhoto(imageUrl) {
  // Fetch and convert to base64
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);
  const buf = await imgRes.buffer();
  const b64 = buf.toString('base64');
  const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANT_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANT_MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: b64 } },
          { type: 'text', text: VISION_PROMPT },
        ],
      }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content?.find(c => c.type === 'text')?.text || '{}';
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return { appliances: [], poolDetected: false, waterSoftenerDetected: false, photoQuality: 'unusable', raw: text };
  }
}

// ── Map vision results → Rentvine custom field names ─────────────────────────
// Based on the custom fields document provided
// Maps appliance type → { fieldName: customFieldID, catID: categoryID }
// Field IDs verified from Rentvine custom-fields/values/5/1
const APPLIANCE_FIELD_MAP = {
  refrigerator: {
    catID: 191,
    brand:  175,
    model:  177,
    serial: 178,
    color:  176,
  },
  stove: {
    catID: 192,
    brand:  185,
    model:  187,
    serial: 186,
    color:  184,
  },
  oven: {
    catID: 193,
    brand:  193,
    model:  194,
    serial: 195,
    color:  196,
  },
  dishwasher: {
    catID: 190,
    brand:  167,
    model:  169,
    serial: 170,
    color:  168,
  },
  microwave: {
    catID: 189,
    brand:  159,
    model:  160,
    serial: 161,
    color:  162,
  },
  washer: {
    catID: 195,
    brand:  210,
    model:  211,
    serial: 212,
  },
  dryer: {
    catID: 196,
    brand:  220,
    model:  221,
    serial: 222,
  },
  water_heater: {
    catID: 198,
    brand:  280,
    model:  281,
    serial: 282,
  },
  ac_unit: {
    catID: 197,
    brand:  228,
    model:  229,
    serial: 230,
  },
  cooktop: {
    catID: 194,
    brand:  203,
    model:  201,
    serial: 204,
    color:  202,
  },
};

function buildFieldUpdates(visionResult, existingFields) {
  const updates = [];

  // Appliances
  for (const appliance of (visionResult.appliances || [])) {
    if (appliance.confidence === 'low') continue;
    const fieldMap = APPLIANCE_FIELD_MAP[appliance.type];
    if (!fieldMap) continue;
    const catID = fieldMap.catID;

    for (const [key, fieldId] of Object.entries(fieldMap)) {
      if (key === 'catID') continue;
      const newVal = appliance[key];
      if (!newVal) continue;
      const existing = existingFields[String(fieldId)];
      const existingVal = existing?.value || null;
      const existingName = existing?.name || String(fieldId);
      updates.push({
        fieldId:      String(fieldId),
        catID:        String(catID),
        fieldName:    existingName,
        newValue:     newVal,
        existingValue: existingVal,
        wouldOverwrite: !!existingVal && existingVal !== newVal,
        applianceType: appliance.type,
        confidence:   appliance.confidence,
      });
    }
  }

  // Pool — fieldID 260, catID 205
  if (visionResult.poolDetected) {
    const existing = existingFields['260'];
    updates.push({
      fieldId: '260', catID: '205',
      fieldName: 'Pool present?',
      newValue: '1',
      existingValue: existing?.value || null,
      wouldOverwrite: false,
      applianceType: 'pool',
      confidence: 'high',
    });
  }

  // Spa — fieldID 261, catID 205
  if (visionResult.spaDetected) {
    updates.push({
      fieldId: '261', catID: '205',
      fieldName: 'Spa / hot tub present?',
      newValue: '1',
      existingValue: existingFields['261']?.value || null,
      wouldOverwrite: false,
      applianceType: 'spa',
      confidence: 'high',
    });
  }

  // Water softener — fieldID 105, catID 31
  if (visionResult.waterSoftenerDetected) {
    updates.push({
      fieldId: '105', catID: '31',
      fieldName: 'Water Softener',
      newValue: 'Yes',
      existingValue: existingFields['105']?.value || null,
      wouldOverwrite: false,
      applianceType: 'water_softener',
      confidence: 'high',
    });
  }

  return updates;
}

// ── Slack helpers ─────────────────────────────────────────────────────────────
async function postToSlack(blocks, text = '') {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text, blocks }),
  });
  return res.json();
}

function buildSlackReviewMessage(scanId, propertyAddr, rvPropertyId, updates, photoUrl, photoDesc) {
  const overwriteUpdates = updates.filter(u => u.wouldOverwrite);
  const newUpdates       = updates.filter(u => !u.wouldOverwrite);

  const fieldLines = [
    ...newUpdates.map(u => `• *${u.fieldName}*: \`${u.newValue}\` _(${u.confidence} confidence)_`),
    ...overwriteUpdates.map(u => `• ⚠️ *${u.fieldName}*: \`${u.newValue}\` _(replaces: ${u.existingValue})_`),
  ].join('\n');

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🔍 Appliance Scan — Review Required*\n*Property:* ${propertyAddr}\n*Photo:* ${photoDesc || 'See image'}`,
      },
      accessory: photoUrl ? {
        type: 'image',
        image_url: photoUrl,
        alt_text: 'Inspection photo',
      } : undefined,
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: fieldLines || '_No extractable fields found_' },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Approve All' },
          style: 'primary',
          action_id: 'scanner_approve',
          value: scanId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '✏️ Review in Hub' },
          action_id: 'scanner_hub_review',
          value: `${scanId}`,
          url: `https://hub.aloepm.com/appliance-scanner?review=${scanId}`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '⏭ Skip' },
          style: 'danger',
          action_id: 'scanner_skip',
          value: scanId,
        },
      ],
    },
    { type: 'divider' },
  ];
}

// ── Scan a single property ────────────────────────────────────────────────────
async function scanProperty(ziProp, rvProperties) {
  const ziId   = ziProp.id;
  const ziAddr = ziProp.Address || ziProp.Name || '';

  // Match to Rentvine
  const match = matchRvProperty(ziAddr, rvProperties);
  if (!match) {
    return {
      status:    'no_rv_match',
      ziAddress: ziAddr,
      ziId,
    };
  }

  const rvPropId   = match.property.propertyID || match.property.id;
  const matchScore = match.confidence;

  // Fetch photos
  const photos = await getPropertyPhotos(ziId, 60);
  if (!photos.length) {
    return { status: 'no_photos', ziAddress: ziAddr, ziId, rvPropertyId: rvPropId };
  }

  // Get current Rentvine custom fields (for dedup)
  const existingFields = await getRvCustomFields(rvPropId);

  // Analyze each photo — stop once we have good coverage
  const scanResults = [];
  let poolFound = false, softenerFound = false;
  const foundAppliances = new Set();

  for (const photo of photos) {
    // Skip if we already found everything interesting
    if (poolFound && softenerFound && foundAppliances.size >= 8) break;

    let vision;
    try {
      vision = await analyzePhoto(photo.url);
    } catch (e) {
      scanResults.push({ photo, error: e.message });
      continue;
    }

    if (vision.photoQuality === 'unusable') continue;

    const updates = buildFieldUpdates(vision, existingFields);
    if (!updates.length && !vision.poolDetected && !vision.waterSoftenerDetected) continue;

    if (vision.poolDetected)            poolFound    = true;
    if (vision.waterSoftenerDetected)   softenerFound = true;
    vision.appliances?.forEach(a => { if (a.confidence !== 'low') foundAppliances.add(a.type); });

    // Save pending result to GCS
    const scanId = `scan_${ziId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const pendingRecord = {
      scanId,
      status:      'pending',
      ziPropertyId: ziId,
      ziAddress:   ziAddr,
      rvPropertyId: rvPropId,
      matchScore,
      photo,
      visionResult: vision,
      updates,
      createdAt:   new Date().toISOString(),
    };
    await gcsWrite(`scanner/pending/${scanId}.json`, pendingRecord);

    // Post to Slack for review
    if (updates.length > 0) {
      const blocks = buildSlackReviewMessage(
        scanId, ziAddr, rvPropId, updates, photo.url, vision.photoDescription
      );
      await postToSlack(blocks, `Appliance scan — ${ziAddr}`);
    }

    scanResults.push({ scanId, updatesCount: updates.length, photo: photo.url });

    // Rate limit — be kind to both APIs
    await new Promise(r => setTimeout(r, 1500));
  }

  return {
    status:      'scanned',
    ziAddress:   ziAddr,
    ziId,
    rvPropertyId: rvPropId,
    matchScore,
    photosChecked: photos.length,
    scansPosted:  scanResults.filter(r => r.scanId).length,
  };
}

// ── Slack interaction handler (approve / skip) ────────────────────────────────
router.post('/slack/actions', express.urlencoded({ extended: true, verify: slackRawBody }), slackSigCheck, async (req, res) => {
  res.sendStatus(200); // Always ACK immediately

  let payload;
  try { payload = JSON.parse(req.body.payload); } catch { return; }

  const action  = payload.actions?.[0];
  const scanId  = action?.value;
  if (!scanId || !action) return;

  const record = await gcsRead(`scanner/pending/${scanId}.json`);
  if (!record) {
    // Already processed
    await updateSlackMessage(payload.response_url, `⚠️ Scan record not found — may have already been processed.`);
    return;
  }

  if (action.action_id === 'scanner_approve') {
    try {
      // Build the fields to write — skip fields that would overwrite without explicit approval
      const safeUpdates = record.updates.filter(u => !u.wouldOverwrite);
      const fieldPatch  = {};
      safeUpdates.forEach(u => { if (u.newValue) fieldPatch[u.fieldId] = { value: u.newValue, catID: u.catID }; });

      if (Object.keys(fieldPatch).length > 0) {
        await patchRvCustomFields(record.rvPropertyId, fieldPatch);
      }

      // Mark as approved in GCS
      record.status     = 'approved';
      record.approvedAt = new Date().toISOString();
      record.fieldsWritten = fieldPatch;
      await gcsWrite(`scanner/approved/${scanId}.json`, record);
      await storage.bucket(BUCKET).file(`scanner/pending/${scanId}.json`).delete().catch(() => {});

      const fieldList = Object.entries(fieldPatch).map(([k,v]) => `• ${k}: ${v}`).join('\n');
      await updateSlackMessage(payload.response_url,
        `✅ *Approved & written to Rentvine*\n*${record.ziAddress}*\n${fieldList || '(no new fields to write)'}`
      );
    } catch(e) {
      await updateSlackMessage(payload.response_url, `❌ Error writing to Rentvine: ${e.message}`);
    }

  } else if (action.action_id === 'scanner_skip') {
    record.status    = 'skipped';
    record.skippedAt = new Date().toISOString();
    await gcsWrite(`scanner/skipped/${scanId}.json`, record);
    await storage.bucket(BUCKET).file(`scanner/pending/${scanId}.json`).delete().catch(() => {});
    await updateSlackMessage(payload.response_url, `⏭ Skipped — *${record.ziAddress}*`);
  }
});

async function updateSlackMessage(responseUrl, text) {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ replace_original: true, text }),
  });
}

// ── API Routes ────────────────────────────────────────────────────────────────

// GET /api/scanner/status — queue counts
router.get('/status', async (req, res) => {
  try {
    const [pending, approved, skipped] = await Promise.all([
      storage.bucket(BUCKET).getFiles({ prefix: 'scanner/pending/' }),
      storage.bucket(BUCKET).getFiles({ prefix: 'scanner/approved/' }),
      storage.bucket(BUCKET).getFiles({ prefix: 'scanner/skipped/' }),
    ]);
    res.json({
      pending:  (pending[0] || []).filter(f => f.name.endsWith('.json')).length,
      approved: (approved[0] || []).filter(f => f.name.endsWith('.json')).length,
      skipped:  (skipped[0] || []).filter(f => f.name.endsWith('.json')).length,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/scanner/pending — list pending review items
router.get('/pending', async (req, res) => {
  try {
    const [files] = await storage.bucket(BUCKET).getFiles({ prefix: 'scanner/pending/' });
    const jsonFiles = files.filter(f => f.name.endsWith('.json')).slice(0, 50);
    const records = await Promise.all(jsonFiles.map(f =>
      f.download().then(([b]) => JSON.parse(b.toString())).catch(() => null)
    ));
    res.json(records.filter(Boolean).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/scanner/review/:scanId — single pending record
router.get('/review/:scanId', async (req, res) => {
  try {
    const record = await gcsRead(`scanner/pending/${req.params.scanId}.json`);
    if (!record) return res.status(404).json({ error: 'Not found' });
    res.json(record);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/scanner/approve/:scanId — approve from Hub UI
router.post('/approve/:scanId', async (req, res) => {
  const { scanId } = req.params;
  const { overrides } = req.body; // optional field overrides from UI
  try {
    const record = await gcsRead(`scanner/pending/${scanId}.json`);
    if (!record) return res.status(404).json({ error: 'Not found' });

    const fieldPatch = {};
    const updatesToApply = overrides ? record.updates.map(u => ({
      ...u, newValue: overrides[u.fieldName] ?? u.newValue
    })) : record.updates;

    updatesToApply.forEach(u => { if (u.newValue) fieldPatch[u.fieldId] = { value: u.newValue, catID: u.catID }; });

    if (Object.keys(fieldPatch).length > 0) {
      await patchRvCustomFields(record.rvPropertyId, fieldPatch);
    }

    record.status        = 'approved';
    record.approvedAt    = new Date().toISOString();
    record.fieldsWritten = fieldPatch;
    await gcsWrite(`scanner/approved/${scanId}.json`, record);
    await storage.bucket(BUCKET).file(`scanner/pending/${scanId}.json`).delete().catch(() => {});

    res.json({ ok: true, fieldsWritten: fieldPatch });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/scanner/skip/:scanId
router.post('/skip/:scanId', async (req, res) => {
  const { scanId } = req.params;
  try {
    const record = await gcsRead(`scanner/pending/${scanId}.json`);
    if (!record) return res.status(404).json({ error: 'Not found' });
    record.status    = 'skipped';
    record.skippedAt = new Date().toISOString();
    await gcsWrite(`scanner/skipped/${scanId}.json`, record);
    await storage.bucket(BUCKET).file(`scanner/pending/${scanId}.json`).delete().catch(() => {});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/scanner/scan-property — scan a single zInspector property by ID
router.post('/scan-property', async (req, res) => {
  const { ziPropertyId } = req.body;
  if (!ziPropertyId) return res.status(400).json({ error: 'ziPropertyId required' });
  try {
    const rvProperties = await getRvProperties();
    const ziProp = await ziFetch(`/api/propertiesCursor/${ziPropertyId}/`);
    const result = await scanProperty(ziProp, rvProperties);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/scanner/scan-all — kick off full portfolio scan (async, streams progress via SSE or just returns job id)
router.post('/scan-all', async (req, res) => {
  const jobId = `job_${Date.now()}`;
  res.json({ jobId, message: 'Scan started. Results will appear in Slack and the Hub review queue.' });

  // Run async — do not await
  (async () => {
    try {
      const [ziProps, rvProperties] = await Promise.all([
        ziAllPages('/api/propertiesCursor/', { is_archived: false }),
        getRvProperties(),
      ]);

      await gcsWrite(`scanner/jobs/${jobId}.json`, {
        jobId, status: 'running', total: ziProps.length, done: 0,
        startedAt: new Date().toISOString(),
      });

      const summary = { scanned: 0, noMatch: 0, noPhotos: 0, errors: 0, reviewsSent: 0 };

      for (let i = 0; i < ziProps.length; i++) {
        const prop = ziProps[i];
        try {
          const result = await scanProperty(prop, rvProperties);
          if (result.status === 'no_rv_match')  summary.noMatch++;
          else if (result.status === 'no_photos') summary.noPhotos++;
          else { summary.scanned++; summary.reviewsSent += result.scansPosted || 0; }
        } catch { summary.errors++; }

        // Update job progress every 10 properties
        if (i % 10 === 0) {
          await gcsWrite(`scanner/jobs/${jobId}.json`, {
            jobId, status: 'running', total: ziProps.length, done: i + 1,
            summary, startedAt: new Date().toISOString(),
          });
        }

        // Rate limiting pause between properties
        await new Promise(r => setTimeout(r, 2000));
      }

      await gcsWrite(`scanner/jobs/${jobId}.json`, {
        jobId, status: 'complete', total: ziProps.length, done: ziProps.length,
        summary, completedAt: new Date().toISOString(),
      });

      // Post Slack summary
      await postToSlack([{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*📊 Portfolio Scan Complete*\n• ✅ Scanned: ${summary.scanned}\n• 🔍 Reviews sent to Slack: ${summary.reviewsSent}\n• ❌ No Rentvine match: ${summary.noMatch}\n• 📷 No photos: ${summary.noPhotos}\n• ⚠️ Errors: ${summary.errors}\n\n<https://hub.aloepm.com/appliance-scanner|View Review Queue →>`,
        },
      }], 'Portfolio scan complete');

    } catch(e) {
      await gcsWrite(`scanner/jobs/${jobId}.json`, {
        jobId, status: 'error', error: e.message,
      });
    }
  })();
});

// GET /api/scanner/job/:jobId — poll job progress
router.get('/job/:jobId', async (req, res) => {
  try {
    const job = await gcsRead(`scanner/jobs/${req.params.jobId}.json`);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/scanner/zi-properties — search zInspector properties for the UI
router.get('/zi-properties', async (req, res) => {
  try {
    const { search } = req.query;
    const data = await ziFetch('/api/propertiesCursor/', {
      search: search || '',
      page_size: 50,
      is_archived: false,
    });
    res.json(data.results || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

export default router;
