import express from 'express';
import scannerRoutes from './appliance-scanner-routes.js';
import { Storage } from '@google-cloud/storage';
const storage = new Storage();
const BUCKET = 'aloe-hub-data-496300';
import cors from 'cors';
import fetch from 'node-fetch';
import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'child_process';
import { execFile } from 'child_process';
import multer from 'multer';

import { initPlaidRoutes } from './plaid-integration.js';
import { initCustomFieldUpdateRoutes } from './custom-field-update-route.js';

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '50mb' }));
app.use('/api/chat', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/vacancy', (req, res) => {
    res.sendFile(new URL('./vacancy.html', import.meta.url).pathname);
});

app.get('/vacancy-risk', (req, res) => {
  res.sendFile(new URL('./vacancy.html', import.meta.url).pathname);
});
// Route to serve the HOA filler UI
app.get('/media-analyzer', (req, res) => res.sendFile(new URL('./media-analyzer.html', import.meta.url).pathname));

app.get('/hoa', (req, res) =>
  res.sendFile(new URL('./hoa-filler.html', import.meta.url).pathname));

app.post('/api/hoa/fill', async (req, res) => {
  const input = JSON.stringify(req.body);
  const py = spawn('python3', ['hoa_filler.py']);
  let out = '', err = '';
  py.stdin.write(input);
  py.stdin.end();
  py.stdout.on('data', d => out += d);
  py.stderr.on('data', d => err += d);
  py.on('close', code => {
    if (code !== 0) return res.status(500).json({ error: err });
    try { res.json(JSON.parse(out)); }
    catch(e) { res.status(500).json({ error: 'Parse error: ' + out.slice(0,200) }); }
  });
});

app.get('/api/hoa/leases', async (req, res) => {
  try {
    let allLeases = [];
    let page = 1;
    while (page <= 20) {
      const data = await rvFetch('/leases/export', { pageSize: 200, page });
      const batch = Array.isArray(data) ? data : [];
      if (batch.length === 0) break;
      allLeases = allLeases.concat(batch);
      if (batch.length < 200) break;
      page++;
    }
    const now = new Date();
    const mapped = allLeases
      .filter(d => {
        const end = d.lease?.endDate;
        return !end || new Date(end) >= now;
      })
      .map(d => ({
        leaseID: d.lease?.leaseID,
        tenant: d.lease?.tenants?.[0]?.name || '—',
        address: d.unit?.address || d.property?.address || '—',
        city: d.unit?.city || d.property?.city || '',
      }));
    const byAddress = {};
    mapped.forEach(l => {
      if (!byAddress[l.address] || l.leaseID > byAddress[l.address].leaseID) {
        byAddress[l.address] = l;
      }
    });
    const leases = Object.values(byAddress).sort((a,b) => (a.address||'').localeCompare(b.address||''));
    res.json({ leases });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/hoa/templates', async (req, res) => {
  const { default: fs } = await import('fs');
  const { default: path } = await import('path');
  const dir = path.join(process.cwd(), 'templates');
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'));
    res.json({ templates: files.map(f => ({ id: f.replace('.pdf',''), name: f.replace('.pdf','').replace(/_/g,' ') })) });
  } catch(e) {
    console.error('Templates dir error:', e.message, 'cwd:', process.cwd(), 'dir:', dir);
    res.json({ templates: [], debug: e.message });
  }
});
app.get('/vendors', (req, res) => {
     res.sendFile(new URL('./vendors-edit.html', import.meta.url).pathname);
});

app.get('/vendors/edit', (req, res) => {
  res.sendFile(new URL('./vendors-edit.html', import.meta.url).pathname);
});

// ── Vendor directory — persisted to GCS via fetch ──
const _vendorBucket = 'aloe-hub-data-496300';
const _vendorFile = 'vendors.json';
let _vendorCache = null;

async function getGCSToken() {
  const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
    headers: { 'Metadata-Flavor': 'Google' }
  });
  const d = await r.json();
  return d.access_token;
}

async function readVendors() {
  if (_vendorCache) return _vendorCache;
  try {
    const token = await getGCSToken();
    const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${_vendorBucket}/o/${_vendorFile}?alt=media`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!r.ok) throw new Error('GCS read ' + r.status);
    _vendorCache = await r.json();
    return _vendorCache;
  } catch(e) {
    console.error('GCS read failed, using local vendors.json:', e.message);
    const { default: fs } = await import('fs');
    const { default: path } = await import('path');
    const raw = fs.readFileSync(path.join(process.cwd(), 'vendors.json'), 'utf8');
    _vendorCache = JSON.parse(raw);
    return _vendorCache;
  }
}

async function writeVendors(data) {
  _vendorCache = data;
  const token = await getGCSToken();
  const body = JSON.stringify(data, null, 2);
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${_vendorBucket}/o?uploadType=media&name=${_vendorFile}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body
  });
  if (!r.ok) throw new Error('GCS write ' + r.status + ': ' + await r.text());
}

const _hoaLetterHashFile = 'hoa-letter-hashes.json';
let _hoaLetterHashCache = null;
async function readHOALetterHashes() {
  if (_hoaLetterHashCache) return _hoaLetterHashCache;
  try {
    const token = await getGCSToken();
    const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${_vendorBucket}/o/${_hoaLetterHashFile}?alt=media`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!r.ok) {
      if (r.status === 404) { _hoaLetterHashCache = {}; return _hoaLetterHashCache; }
      throw new Error('GCS read ' + r.status);
    }
    _hoaLetterHashCache = await r.json();
    return _hoaLetterHashCache;
  } catch(e) {
    console.error('HOA letter hash read failed:', e.message);
    return {};
  }
}
async function writeHOALetterHashes(data) {
  _hoaLetterHashCache = data;
  const token = await getGCSToken();
  const body = JSON.stringify(data, null, 2);
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${_vendorBucket}/o?uploadType=media&name=${_hoaLetterHashFile}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body
  });
  if (!r.ok) throw new Error('GCS write ' + r.status + ': ' + await r.text());
}

const _woSyncHistoryPrefix = 'wo-sync-history/';
async function writeWOSyncHistory(dateStr, data) {
  const token = await getGCSToken();
  const body = JSON.stringify(data, null, 2);
  const fileName = _woSyncHistoryPrefix + dateStr + '.json';
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${_vendorBucket}/o?uploadType=media&name=${encodeURIComponent(fileName)}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body
  });
  if (!r.ok) throw new Error('GCS write ' + r.status + ': ' + await r.text());
}

app.post('/api/kat/check-letter-hash', async (req, res) => {
  if (req.headers['x-hub-token'] !== process.env.HUB_INTERNAL_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { hash } = req.body;
    if (!hash) return res.status(400).json({ error: 'hash required' });
    const registry = await readHOALetterHashes();
    const existing = registry[hash];
    if (existing) {
      return res.json({ isDuplicate: true, existing });
    }
    res.json({ isDuplicate: false });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/kat/record-letter-hash', async (req, res) => {
  if (req.headers['x-hub-token'] !== process.env.HUB_INTERNAL_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { hash, cardId, address } = req.body;
    if (!hash || !cardId) return res.status(400).json({ error: 'hash and cardId required' });
    const registry = await readHOALetterHashes();
    registry[hash] = { cardId, address: address || null, dateProcessed: new Date().toISOString() };
    await writeHOALetterHashes(registry);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/vendors', async (req, res) => {
  try {
    res.json(await readVendors());
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/vendors', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || !Array.isArray(payload.trades)) return res.status(400).json({ error: 'Invalid payload' });
    payload.lastUpdated = new Date().toISOString().slice(0, 10);
    await writeVendors(payload);
    res.json({ ok: true, lastUpdated: payload.lastUpdated });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/rv-vendors', async (req, res) => {
  try {
    let all = [], pg = 1;
    while (pg <= 10) {
      const batch = await rvFetch('/vendors', { pageSize: 200, page: pg });
      const rows = Array.isArray(batch) ? batch : [];
      if (!rows.length) break;
      all = all.concat(rows);
      if (rows.length < 200) break;
      pg++;
    }
    const vendors = all.map(r => {
      const c = r.contact || r;
      return {
        id: c.contactID,
        name: c.name || '',
        phone: c.phone || '',
        email: c.email || '',
        status: c.isActive === '1' ? 'active' : 'inactive',
        insuranceExpiration: c.liabilityInsuranceExpiresDate || null,
      };
    });
    res.json({ vendors });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/resources/vendors', (req, res) => {
  res.sendFile(new URL('./vendor-resources.html', import.meta.url).pathname);
});

app.get('/api/vendors', async (req, res) => {
  try {
    res.json({ vendors: [] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/renewals', (req, res) =>
  res.sendFile(new URL('./renewals.html', import.meta.url).pathname));
app.get('/api/pet-policy', async function(req, res) {
  const addr = (req.query.address || '').toLowerCase().trim();
  if (!addr) return res.json({ error: 'address param required' });
  try {
    const schema = await unitsFetch('/api/schema/unit');
    const schemaMap = {};
    if (Array.isArray(schema)) schema.forEach(function(f) { schemaMap[f.key] = f.label; });
    let allCards = [];
    let page = 0;
    while (page < 10) {
      const data = await unitsFetch('/api/board/unit', { page, pageSize: 100 });
      const batch = Array.isArray(data) ? data : (data && data.data) || [];
      if (batch.length === 0) break;
      allCards = allCards.concat(batch);
      if (batch.length < 100) break;
      page++;
    }
    const numMatch = addr.match(/\d+/) ? addr.match(/\d+/)[0] : null;
    const words = addr.replace(/\d+/g,'').replace(/\b(court|ct|drive|dr|street|st|avenue|ave|lane|ln|way|road|rd|place|pl|blvd|circle|cir|trail|trl)\b/gi,'').trim().split(/\s+/).filter(function(w){ return w.length > 2; });
    const match = allCards.find(function(c) {
      const s = (c.street || '').toLowerCase();
      const hasNum = numMatch && s.includes(numMatch);
      const hasWord = words.some(function(w){ return s.includes(w); });
      return hasNum && hasWord;
    });
    if (!match) {
      const partial = allCards.filter(function(c){ return numMatch && (c.street||'').toLowerCase().includes(numMatch); }).slice(0,5).map(function(c){ return c.street||'?'; });
      return res.json({ found: false, partial });
    }
    const restrictions = Array.isArray(match.petRestrictions) ? match.petRestrictions : [];
    const petsAllowed = match.petsAllowed;
    const noDogs = restrictions.some(function(r){ return /no dog/i.test(r); });
    const noCats = restrictions.some(function(r){ return /no cat/i.test(r); });
    const dogsOk = restrictions.some(function(r){ return /dog.*allow/i.test(r); });
    const catsOk = restrictions.some(function(r){ return /cat.*allow/i.test(r); });
    const noPets = petsAllowed === false || (noDogs && noCats);
    const fullyOk = (petsAllowed === true || dogsOk || catsOk) && !noDogs && !noCats;
    var verdict;
    if (noPets) verdict = '🚫 No pets allowed at this property.';
    else if (noDogs && !noCats) verdict = '⚠️ Cats allowed, but NO DOGS at this property.';
    else if (noCats && !noDogs) verdict = '⚠️ Dogs allowed, but NO CATS at this property.';
    else if (fullyOk) verdict = '✅ Pets allowed (dogs and cats).';
    else verdict = '⚠️ No specific restriction on file — standard Aloe policy applies.';
    const owners = Array.isArray(match.owners) ? match.owners.map(function(o){ return o.name||''; }).join(', ') : '';
    res.json({
      found: true,
      address: match.street || '?',
      stage: match.stage || '',
      beds: match.beds || '',
      baths: match.baths || '',
      rent: match.marketRent ? (match.marketRent.amount || '') : '',
      owner: owners,
      verdict,
      petRestrictions: restrictions,
      petsAllowed: petsAllowed,
      petDeposit: match.animalDeposit ? match.animalDeposit.amount : null,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/aptly/leads-rich', async function(req, res) {
  try {
    const token = process.env.APTLY_UNITS_TOKEN || process.env.APTLY_TOKEN || '';
    const schemaRes = await fetch('https://core-api.getaptly.com/api/schema/4EMDSYKirhQaNdQKz', { headers: { 'x-token': token } });
    const schema = await schemaRes.json();
    const schemaMap = {};
    if (Array.isArray(schema)) schema.forEach(function(f) { schemaMap[f.key] = f.label; });
    let allLeads = [], page = 0;
    while (page < 5) {
      const r = await fetch(`https://core-api.getaptly.com/api/board/4EMDSYKirhQaNdQKz?page=${page}&pageSize=100`, { headers: { 'x-token': token } });
      if (!r.ok) break;
      const data = await r.json();
      const batch = Array.isArray(data) ? data : (data && data.data) || [];
      if (batch.length === 0) break;
      allLeads = allLeads.concat(batch);
      if (batch.length < 100) break;
      page++;
    }
    const mapped = allLeads.map(function(c) {
      const m = { cardId: c.cardId, stage: c.stage, createdAt: c.createdAt };
      Object.keys(c).forEach(function(k) { if (schemaMap[k]) m[schemaMap[k]] = c[k]; });
      const pref = m['Preferred Rental'] || m['Unit'] || '';
      let prefStr = '';
      if (Array.isArray(pref)) prefStr = pref.map(p => p.name || '').filter(Boolean).join(', ');
      else if (typeof pref === 'object' && pref) prefStr = pref.name || pref.address || '';
      else prefStr = String(pref || '');

      const contactRaw = m['Primary Contact'] || c.name || '';
      let contactStr = '';
      if (Array.isArray(contactRaw)) contactStr = contactRaw.map(p => p.name || '').filter(Boolean).join(', ');
      else if (typeof contactRaw === 'object' && contactRaw) contactStr = contactRaw.name || '';
      else contactStr = String(contactRaw || '');

      return {
        cardId: c.cardId,
        stage: c.stage,
        createdAt: c.createdAt,
        contact: contactStr,
        preferredRental: prefStr,
        address: prefStr,
        source: m['Source'] || '',
        showingInfo: m['Requested Showing Information'] || '',
        moveDate: m['Move Date'] || '',
        income: m['Household Income'] || '',
        pets: m['Pets'] || '',
        comments: Array.isArray(c.comments) ? c.comments.map(function(cm) {
          return { by: cm.userName || 'Unknown', note: cm.content || '', date: (cm.createdAt || '').slice(0,10) };
        }) : [],
      };
    });
    res.json({ leads: mapped, total: mapped.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/aptly/units', async function(req, res) {
 try {
    const token = process.env.APTLY_UNITS_TOKEN || process.env.APTLY_TOKEN || '';
    let allCards = [];
    let page = 0;
    while (page < 10) {
      const url = new URL('https://core-api.getaptly.com/api/board/unit');
      url.searchParams.set('page', page);
      url.searchParams.set('pageSize', 100);
      const r = await fetch(url.toString(), { headers: { 'x-token': token, 'Accept': 'application/json' } });
      if (!r.ok) break;
      const data = await r.json();
      const batch = Array.isArray(data) ? data : (data && data.data) || [];
      if (batch.length === 0) break;
      allCards = allCards.concat(batch);
      if (batch.length < 100) break;
      page++;
    }
    const published = allCards.filter(function(u) {
      return u.publishedForRent === true || u.syndicate === true || u['Published For Rent'] === 'checked';
    });
    const strVal = function(v) {
      if (!v) return '';
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return v.map(function(i) { return typeof i === 'object' ? (i.name || '') : String(i); }).filter(Boolean).join(', ');
      if (typeof v === 'object') return v.name || v.label || v.address || '';
      return String(v);
    };
    const sanitized = published.map(function(u) {
      return {
        cardId: u.cardId || '',
        street: u.street || '',
        city: u.city || (u.address && typeof u.address === 'object' ? u.address.city : '') || '',
        beds: u.beds || 0,
        baths: u.baths || 0,
        totalArea: u.totalArea || 0,
        marketRent: u.marketRent || null,
        availableDate: u.availableDate || null,
        publishedForRent: u.publishedForRent || false,
        syndicate: u.syndicate || false,
        rentReady: u.rentReady || false,
        lockboxNumber: strVal(u.lockboxNumber),
        virtualTourUrl: strVal(u.virtualTourUrl),
        applicationUrl: strVal(u.applicationUrl),
        petsAllowed: u.petsAllowed || false,
        petRestrictions: Array.isArray(u.petRestrictions) ? u.petRestrictions : [],
        animalDeposit: u.animalDeposit || null,
        owners: Array.isArray(u.owners) ? u.owners.map(function(o) { return { name: strVal(o) }; }) : [],
        portfolio: Array.isArray(u.portfolio) ? u.portfolio.map(function(p) { return { name: strVal(p) }; }) : [],
        stage: u.stage || '',
        marketingName: strVal(u.marketingName),
      };
    });
    res.json({ units: sanitized, total: allCards.length, published: sanitized.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
// Proxy: vendor knowledge base docs

app.get('/api/aptly/leads', async (req, res) => {
    try {
          const r = await fetch('https://api.getaptly.com/v1/boards?page=0&size=200', {
                  headers: { 'x-token': process.env.APTLY_TOKEN }
          });
          const data = await r.json();
          const cards = data.content || data.cards || data || [];
          res.json({ leads: cards, count: cards.length });
    } catch(e) {
          res.status(500).json({ error: e.message });
    }
});

const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;
const RENTVINE_API_KEY    = process.env.RENTVINE_API_KEY;
const RENTVINE_API_SECRET = process.env.RENTVINE_API_SECRET;
const RENTVINE_ACCOUNT    = process.env.RENTVINE_ACCOUNT;
const APTLY_TOKEN         = process.env.APTLY_TOKEN;
const ZINSPECTOR_API_KEY  = process.env.ZINSPECTOR_API_KEY;
const SLACK_TOKEN         = process.env.SLACK_TOKEN;
const KB_URL              = process.env.KB_URL || 'https://kb.aloepm.com';
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const RENTVINE_BASE = `https://${RENTVINE_ACCOUNT}.rentvine.com/api/manager`;
const RENTVINE_AUTH = Buffer.from(`${RENTVINE_API_KEY}:${RENTVINE_API_SECRET}`).toString('base64');

const KB_TOPIC_CACHE = {};
const KB_CACHE_TTL_MS = 30 * 60 * 1000;

async function kbSearch(query, opts = {}) {
  const params = new URLSearchParams({ q: query, limit: String(opts.limit || 5) });
  if (opts.audience) params.set('audience', opts.audience);
  if (opts.department) params.set('department', opts.department);
  try {
    const r = await fetch(`${KB_URL}/search?${params.toString()}`);
    if (!r.ok) return { error: `KB ${r.status}`, results: [] };
    const data = await r.json();
    return { results: data.results || [] };
  } catch (e) {
    console.error('kbSearch error:', e.message);
    return { error: e.message, results: [] };
  }
}

async function getKbTopic(cacheKey, query, opts = {}) {
  const now = Date.now();
  const cached = KB_TOPIC_CACHE[cacheKey];
  if (cached && (now - cached.loadedAt) < KB_CACHE_TTL_MS) return cached.text;
  const { results } = await kbSearch(query, { limit: opts.limit || 3, audience: opts.audience, department: opts.department });
  if (!results || results.length === 0) return '';
  const byDoc = new Map();
  for (const r of results) {
    if (!byDoc.has(r.document_id) || r.content.length > byDoc.get(r.document_id).content.length) {
      byDoc.set(r.document_id, r);
    }
  }
  const text = Array.from(byDoc.values())
    .map(r => `=== ${r.document_title} ===\n${r.content}`)
    .join('\n\n');
  KB_TOPIC_CACHE[cacheKey] = { text, loadedAt: now };
  return text;
}

const KB_TOPIC_ROUTES = [
  { test: /water.*leak|leak.*water|leaking|flooded|burst.*pipe|pipe.*burst|water.*damage/, key: 'water_leaks', q: 'water leak troubleshooting shut off valve' },
  { test: /pest|scorpion|roach|termite|rodent|bee|ant.*infestat|bug.*infestat/, key: 'pest_sop', q: 'pest control SOP scorpions bees rodents owner tenant' },
  { test: /toilet|toilet.*leak|toilet.*clog|toilet.*flush/, key: 'toilet', q: 'toilet troubleshooting running toilet flush' },
  { test: /washer|dryer|washing machine|laundry/, key: 'washer_dryer', q: 'washer dryer troubleshooting' },
  { test: /kitchen sink|sink.*drain|drain.*clog|slow.*drain/, key: 'kitchen_sink', q: 'kitchen sink drain clog prevention' },
  { test: /garbage disposal|disposal/, key: 'disposal', q: 'garbage disposal jams troubleshooting' },
  { test: /mold|mildew/, key: 'mold', q: 'mold mildew prevention moisture' },
  { test: /dishwasher/, key: 'dishwasher', q: 'dishwasher troubleshooting not draining cleaning' },
  { test: /\bhvac\b|\bac\b|air.?condition|heat.*not.*work|ac.*not.*work|furnace/, key: 'hvac', q: 'HVAC AC heat troubleshooting filter' },
  { test: /water softener|softener/, key: 'water_softener', q: 'water softener salt operation maintenance' },
  { test: /water bill|high.*bill.*water|leak.*prevent/, key: 'high_water_bill', q: 'high water bill leak prevention conservation' },
  { test: /mailbox/, key: 'mailbox', q: 'mailbox issues lost key USPS' },
  { test: /lock.*out|locked.*out|lost.*key|\bkey\b|rekey/, key: 'keys_lockouts', q: 'keys lockouts tenant rekey lockbox' },
  { test: /cost|price|quote|charge|expensive|too much|fair price|good price|benchmark|should i approve|approve.*quote|how much.*should|is.*\$.*too|within range/, key: 'cost_benchmarks', q: 'maintenance cost benchmarks Phoenix repair pricing' },
];

async function getKbContext(msg) {
  const m = (msg || '').toLowerCase();
  for (const route of KB_TOPIC_ROUTES) {
    if (route.test.test(m)) {
      const text = await getKbTopic(route.key, route.q);
      if (text) return { key: route.key, text, label: route.key.replace(/_/g, ' ') };
      return null;
    }
  }
  return null;
}

const SYSTEM_PROMPT = `You are Aloe Assistant — the internal AI for Aloe Property Management, a full-service residential property management company serving the Phoenix metro area (Chandler, Scottsdale, Gilbert, Maricopa, San Tan Valley, and surrounding areas). You serve Randi (owner), Persia (assistant PM), Dhyana (leasing agent), and other staff.

You have access to these live data sources via tools:

APTLY — Source of truth for listings and availability:
- Units board (ID: unit) — ALL published listings with beds, baths, rent, available date, Published For Rent field. THIS IS THE ONLY SOURCE for "what units are available" questions. Never use Rentvine for availability.
- Renter leads pipeline (board ID: 4EMDSYKirhQaNdQKz)
- Move-Ins, Move-Outs, HOA Violations, Tenant Renewals boards
- Contact and lead details
- EMERGENCY DETECTION: When showing work orders, always scan descriptions for: water leak, gas leak, no heat, no AC in summer, flood, sewage backup, burst pipe. Flag them as EMERGENCY.

RENTVINE — Source of truth for tenant and accounting data.
ZINSPECTOR — Inspection platform synced with Rentvine.
ALOE KNOWLEDGE BASE — Single source of truth for ALL company policies, procedures, training materials, vendor information, cost benchmarks, troubleshooting guides, and SOPs.
SLACK — Team communications.

Rules:
- Always use tools to get live data — never guess or make up numbers
- Be concise. Lead with the answer, then details
- Never speculate on legal or fair housing matters
- Tone: professional, helpful, like the most knowledgeable senior colleague on the team`;

const ALL_TOOLS = [
  { name: 'rv_get_leases', description: 'Search leases from Rentvine with tenant info, balances, unpaid charges, and property details.', input_schema: { type: 'object', properties: { search: { type: 'string' }, status: { type: 'string' }, page: { type: 'number' } } } },
  { name: 'rv_get_ledger', description: 'Get the full accounting ledger for a lease.', input_schema: { type: 'object', properties: { leaseId: { type: 'number' } }, required: ['leaseId'] } },
  { name: 'rv_get_transactions', description: 'Get full transaction history for a lease.', input_schema: { type: 'object', properties: { leaseId: { type: 'number' } }, required: ['leaseId'] } },
  { name: 'rv_get_properties', description: 'Get properties in the portfolio.', input_schema: { type: 'object', properties: { search: { type: 'string' } } } },
  { name: 'rv_get_units', description: 'Get units with rent, deposit, beds, baths, availability.', input_schema: { type: 'object', properties: { search: { type: 'string' }, propertyId: { type: 'number' } } } },
  { name: 'rv_get_owners', description: 'Get owner/landlord contact info.', input_schema: { type: 'object', properties: { search: { type: 'string' } } } },
  { name: 'rv_get_work_orders', description: 'Get maintenance work orders.', input_schema: { type: 'object', properties: { status: { type: 'string' }, propertyId: { type: 'number' }, page: { type: 'number' } } } },
  { name: 'rv_get_property_work_order_history', description: 'Get ALL work orders for a specific property.', input_schema: { type: 'object', properties: { address: { type: 'string' }, propertyId: { type: 'number' } } } },
  { name: 'rv_get_work_order_detail', description: 'Get full details for a specific work order by ID.', input_schema: { type: 'object', properties: { workOrderId: { type: 'number' } }, required: ['workOrderId'] } },
  { name: 'rv_get_recurring_issues', description: 'Find properties with recurring work orders.', input_schema: { type: 'object', properties: { category: { type: 'string' }, daysBack: { type: 'number' }, minCount: { type: 'number' } } } },
  { name: 'rv_get_inspections', description: 'Get property inspections from Rentvine.', input_schema: { type: 'object', properties: { propertyId: { type: 'number' }, page: { type: 'number' } } } },
  { name: 'rv_get_inspection_detail', description: 'Get full details of a specific inspection by ID.', input_schema: { type: 'object', properties: { inspectionId: { type: 'number' } }, required: ['inspectionId'] } },
  { name: 'rv_get_tenants', description: 'Search for tenant contacts in Rentvine.', input_schema: { type: 'object', properties: { search: { type: 'string' } } } },
  { name: 'rv_get_vendors', description: 'Get vendor/contractor list from Rentvine.', input_schema: { type: 'object', properties: { search: { type: 'string' } } } },
  { name: 'aptly_get_board_cards', description: 'Get cards from an Aptly board.', input_schema: { type: 'object', properties: { boardId: { type: 'string' }, page: { type: 'number' } }, required: ['boardId'] } },
  { name: 'aptly_list_boards', description: 'List all available Aptly boards.', input_schema: { type: 'object', properties: {} } },
  { name: 'aptly_search_cards', description: 'Search for specific leads or cards in an Aptly board.', input_schema: { type: 'object', properties: { boardId: { type: 'string' }, query: { type: 'string' } }, required: ['boardId', 'query'] } },
  { name: 'aptly_get_applicant', description: 'Get full details and comments for a specific applicant.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'aptly_get_leads', description: 'Get renter leads from the Renter Leads board.', input_schema: { type: 'object', properties: { daysBack: { type: 'number' }, property: { type: 'string' }, stage: { type: 'string' }, includeArchived: { type: 'boolean' } } } },
  { name: 'aptly_get_work_orders', description: 'PRIMARY source for ALL work order questions.', input_schema: { type: 'object', properties: { status: { type: 'string' }, property: { type: 'string' }, includeArchived: { type: 'boolean' }, includeComments: { type: 'boolean' } } } },
  { name: 'rv_get_work_order_notes', description: 'Get notes/comments for work orders from Rentvine.', input_schema: { type: 'object', properties: { workOrderId: { type: 'string' } } } },
  { name: 'compare_work_orders', description: 'Compare work orders between Aptly and Rentvine.', input_schema: { type: 'object', properties: {} } },
  { name: 'kb_search', description: 'Search the Aloe Knowledge Base.', input_schema: { type: 'object', properties: { query: { type: 'string' }, audience: { type: 'string' }, department: { type: 'string' } }, required: ['query'] } },
  { name: 'slack_search', description: 'Search Slack for team messages.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'slack_get_channel_messages', description: 'Get recent messages from a specific Slack channel.', input_schema: { type: 'object', properties: { channelId: { type: 'string' }, limit: { type: 'number' } }, required: ['channelId'] } },
  { name: 'slack_list_channels', description: 'List all Slack channels.', input_schema: { type: 'object', properties: {} } },
];

function normalizeAddr(str) {
  return (str || '').toLowerCase()
    .replace(/\bnorth\b/g, 'n').replace(/\bsouth\b/g, 's')
    .replace(/\beast\b/g, 'e').replace(/\bwest\b/g, 'w')
    .replace(/\bstreet\b/g, 'st').replace(/\bdrive\b/g, 'dr')
    .replace(/\blane\b/g, 'ln').replace(/\bcourt\b/g, 'ct')
    .replace(/\bboulevard\b/g, 'blvd').replace(/\bavenue\b/g, 'ave')
    .replace(/\broad\b/g, 'rd').replace(/\bplace\b/g, 'pl')
    .replace(/[.,#]/g, '').replace(/\s+/g, ' ').trim();
}

function fuzzyMatch(query, target) {
  const q = normalizeAddr(query);
  const t = normalizeAddr(target);
  if (t.includes(q)) return true;
  const streetNum = query.match(/\d{3,6}/)?.[0];
  const words = q.split(' ').filter(w => w.length > 2 && !/^\d+$/.test(w));
  if (streetNum && t.includes(streetNum) && words.some(w => t.includes(w))) return true;
  if (words.length > 0 && words.filter(w => t.includes(w)).length / words.length >= 0.6) return true;
  return false;
}

async function rvFetch(path, params = {}, method = 'GET', body = null) {
  const url = new URL(`${RENTVINE_BASE}${path}`);
  if (method === 'GET') {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });
  }
  const opts = { method, headers: { Authorization: `Basic ${RENTVINE_AUTH}`, 'X-Rentvine-Account': 'aloepm', 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url.toString(), opts);
  if (!r.ok) {
    const txt = await r.text();
    console.error('Rentvine error', r.status, txt.slice(0, 200));
    return { error: 'Rentvine ' + r.status + ': ' + txt.slice(0, 100) };
  }
  return r.json();
}

async function aptlyFetch(path, params = {}) {
  const url = new URL('https://app.getaptly.com/api' + path);
  url.searchParams.set('x-token', APTLY_TOKEN);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined) url.searchParams.set(k, v); });
  const r = await fetch(url.toString());
  if (!r.ok) return { error: 'Aptly ' + r.status };
  return r.json();
}

let _unitsSchema = null;
async function unitsFetch(path, params = {}) {
  const url = new URL('https://core-api.getaptly.com' + path);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined) url.searchParams.set(k, v); });
  const unitsToken = process.env.APTLY_UNITS_TOKEN || process.env.APTLY_TOKEN || '';
  const r = await fetch(url.toString(), { headers: { 'x-token': unitsToken, 'Accept': 'application/json' } });
  if (!r.ok) return { error: 'Units API ' + r.status, body: await r.text() };
  return r.json();
}

async function getUnitsSchema() {
  if (_unitsSchema) return _unitsSchema;
  const schema = await unitsFetch('/api/schema/unit');
  if (Array.isArray(schema)) {
    _unitsSchema = {};
    schema.forEach(function(f) { _unitsSchema[f.key] = f.label; });
  }
  return _unitsSchema || {};
}

async function getUnitsCards() {
  const schema = await getUnitsSchema();
  let allCards = [];
  let page = 0;
  while (true) {
    const data = await unitsFetch('/api/board/unit', { page, pageSize: 100 });
    const batch = Array.isArray(data) ? data : (data && data.cards) ? data.cards : (data && data.data) ? data.data : [];
    if (batch.length === 0) break;
    allCards = allCards.concat(batch);
    if (batch.length < 100) break;
    page++;
  }
  return allCards.map(function(card) {
    const mapped = { _cardId: card.cardId };
    Object.keys(card).forEach(function(k) {
      const label = schema[k] || k;
      const val = card[k];
      mapped[label] = (val && typeof val === 'object' && 'amount' in val) ? '$' + val.amount : val;
    });
    return mapped;
  });
}

let _applicantsSchema = null;
async function getApplicantsSchema() {
  if (_applicantsSchema) return _applicantsSchema;
  const schema = await unitsFetch('/api/schema/MJxaStgENouWrNEKd');
  if (Array.isArray(schema)) {
    _applicantsSchema = {};
    schema.forEach(function(f) { _applicantsSchema[f.key] = f.label; });
  }
  return _applicantsSchema || {};
}

async function getApplicantsCards() {
  const schema = await getApplicantsSchema();
  let allCards = [];
  let page = 0;
  while (true) {
    const data = await unitsFetch('/api/board/MJxaStgENouWrNEKd', { page, pageSize: 50 });
    const batch = Array.isArray(data) ? data : (data && data.data) ? data.data : (data && data.cards) ? data.cards : [];
    if (batch.length === 0) break;
    allCards = allCards.concat(batch);
    if (batch.length < 50) break;
    page++;
  }
  return allCards.map(function(card) {
    const extractName = function(v) {
      if (!v) return '';
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return v.length > 0 ? (v[0].name || '') : '';
      if (typeof v === 'object') {
        if ('amount' in v) return '$' + v.amount;
        if ('name' in v) return v.name;
        if ('value' in v) return v.value;
      }
      return String(v);
    };
    const mapped = {
      _cardId: card.cardId,
      'Title': card.name || '',
      'Stage': card.stage || '',
      'Application Complete': card.appInputCompleted || card.readyToReview || '',
      'appApproved': card.appApproved || false,
      'Created At': card.createdAt || '',
      'Primary Applicant': extractName(card.appPrimaryApplicant),
      'Application Location': extractName(card.appLocation),
      'Household': card.appHousehold || '',
      'Move-In Date': card.appMoveInDate || '',
      'Total Household Mo. Income': card.appIncome ? '$' + card.appIncome.amount : '',
      'Avg. Household Credit': card.appCreditRating || '',
      'comments': Array.isArray(card.comments) ? card.comments.map(function(c) {
        return { by: c.userName || c.name || 'Unknown', note: c.content || c.text || '', date: (c.createdAt || '').slice(0, 10) };
      }) : [],
    };
    Object.keys(card).forEach(function(k) {
      if (schema[k] && !mapped[schema[k]]) mapped[schema[k]] = extractName(card[k]);
    });
    return mapped;
  });
}

async function ziFetch(path, params = {}) {
  if (!ZINSPECTOR_API_KEY) return { error: 'ZINSPECTOR_API_KEY not set' };
  const bases = ['https://app.zinspector.com/api/v1', 'https://api.zinspector.com/v1'];
  for (const base of bases) {
    try {
      const url = new URL(base + path);
      Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
      const r = await fetch(url.toString(), { headers: { 'Authorization': 'Bearer ' + ZINSPECTOR_API_KEY, 'x-api-key': ZINSPECTOR_API_KEY, 'Accept': 'application/json' } });
      if (r.ok) return { base, data: await r.json() };
    } catch(e) {}
  }
  return { error: 'zInspector API unreachable' };
}

async function slackFetch(path, params) {
  params = params || {};
  const url = new URL('https://slack.com/api' + path);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined) url.searchParams.set(k, v); });
  const r = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + SLACK_TOKEN } });
  return r.json();
}

async function executeTool(name, input) {
  console.log('Tool: ' + name, JSON.stringify(input).slice(0, 80));
  try {
    switch (name) {
      case 'kb_search': {
        const { results, error } = await kbSearch(input.query, { limit: 5, audience: input.audience, department: input.department });
        if (error) return JSON.stringify({ error, message: 'Knowledge base unreachable' });
        if (!results || results.length === 0) return JSON.stringify({ message: 'No matching documents for: ' + input.query });
        return JSON.stringify({ total: results.length, results: results.map(r => ({ title: r.document_title, content: (r.content || '').slice(0, 1500) })) });
      }
      case 'rv_get_leases': {
        const params = { pageSize: 200, page: input.page || 1 };
        if (input.status === 'inactive') params['primaryLeaseStatusIDs[]'] = 2;
        else if (input.status !== 'all') params['primaryLeaseStatusIDs[]'] = 1;
        const data = await rvFetch('/leases/export', params);
        if (input.search && Array.isArray(data)) {
          const q = input.search.toLowerCase();
          return JSON.stringify(data.filter(function(item) {
            const tenantMatch = item.lease && item.lease.tenants && item.lease.tenants.some(t => (t.name||'').toLowerCase().includes(q));
            if (tenantMatch) return true;
            return fuzzyMatch(q, (item.property&&item.property.address||'') + ' ' + (item.property&&item.property.city||''));
          }));
        }
        return JSON.stringify(data);
      }
      case 'rv_get_ledger': return JSON.stringify(await rvFetch('/accounting/ledgers', { leaseID: input.leaseId, pageSize: 50 }));
      case 'rv_get_transactions': return JSON.stringify(await rvFetch('/accounting/transactions', { leaseID: input.leaseId, pageSize: 50 }));
      case 'rv_get_properties': {
        let allData = [], pg = 1;
        while (true) {
          const batch = await rvFetch('/properties/export', { pageSize: 200, page: pg });
          if (!Array.isArray(batch) || batch.length === 0) break;
          allData = allData.concat(batch);
          if (batch.length < 200) break;
          pg++;
        }
        if (input.search) {
          return JSON.stringify(allData.filter(item => fuzzyMatch(input.search, (item.property&&item.property.address||'') + ' ' + (item.property&&item.property.city||''))).slice(0,10).map(item => ({ propertyID: item.property&&item.property.propertyID, address: item.property&&item.property.address, city: item.property&&item.property.city })));
        }
        return JSON.stringify({ total: allData.length, message: 'Pass a search term to find specific properties.' });
      }
      case 'rv_get_units': {
        if (!input.propertyId && !input.search) return JSON.stringify({ error: 'propertyId or search required' });
        if (input.propertyId) {
          const units = await rvFetch('/properties/' + input.propertyId + '/units');
          return JSON.stringify(units);
        }
        const leases = await rvFetch('/leases/export', { pageSize: 200 });
        if (Array.isArray(leases)) return JSON.stringify(leases.filter(item => fuzzyMatch(input.search, (item.unit&&item.unit.address||'') + ' ' + (item.property&&item.property.city||''))));
        return JSON.stringify(leases);
      }
      case 'rv_get_owners': {
        const data = await rvFetch('/contacts/owners', { pageSize: 100 });
        if (input.search && Array.isArray(data)) return JSON.stringify(data.filter(o => (o.name||'').toLowerCase().includes(input.search.toLowerCase())));
        return JSON.stringify(data);
      }
      case 'rv_get_work_orders': {
        const p = { pageSize: 100 };
        if (input.propertyId) p.propertyID = input.propertyId;
        let allWOs = [];
        for (let pg = 1; pg <= 10; pg++) {
          p.page = pg;
          const data = await rvFetch('/maintenance/work-orders', p);
          const rawBatch = Array.isArray(data) ? data : (data && data.data) || [];
          if (rawBatch.length === 0) break;
          const mapped = rawBatch.map(rec => rec.workOrder ? Object.assign({}, rec.workOrder, { unitAddress: (rec.unit&&(rec.unit.address||rec.unit.name))||'', vendorName: (rec.contact&&rec.contact.name)||'' }) : rec).filter(wo => wo.workOrderID);
          allWOs = allWOs.concat(mapped);
          if (rawBatch.length < 100) break;
        }
        const filtered = input.status === 'closed'
          ? allWOs.filter(wo => { const sid = parseInt(wo.primaryWorkOrderStatusID); return sid===4||sid===5||!!wo.closedDate||!!wo.dateClosed; })
          : allWOs.filter(wo => { const sid = parseInt(wo.primaryWorkOrderStatusID); return !(sid===4||sid===5||!!wo.closedDate||!!wo.dateClosed); });
        return JSON.stringify({ total: filtered.length, workOrders: filtered.slice(0, 50).map(wo => ({ num: wo.workOrderNumber, title: (wo.description||'?').slice(0,60), status: wo.primaryWorkOrderStatusID, prop: (wo.unitAddress||'').slice(0,40), vendor: (wo.vendorName||'').slice(0,30) })) });
      }
      case 'rv_get_property_work_order_history': {
        let propId = input.propertyId;
        if (!propId && input.address) {
          const props = await rvFetch('/properties/export', { pageSize: 200, page: 1 });
          const match = (Array.isArray(props)?props:[]).find(p => ((p.property&&p.property.address)||'').toLowerCase().includes(input.address.toLowerCase().split(' ').slice(0,3).join(' ')));
          if (match) propId = match.property && match.property.propertyID;
        }
        if (!propId) return JSON.stringify({ error: 'Property not found for: ' + input.address });
        const allPages = [];
        for (let pg = 1; pg <= 5; pg++) {
          const d = await rvFetch('/maintenance/work-orders', { pageSize: 100, page: pg, propertyID: propId });
          const batch = Array.isArray(d) ? d : (d&&d.data)||[];
          allPages.push(...batch);
          if (batch.length < 100) break;
        }
        return JSON.stringify({ total: allPages.length, workOrders: allPages.slice(0,50) });
      }
      case 'rv_get_recurring_issues': return JSON.stringify({ message: 'Use rv_get_work_orders and filter client-side' });
      case 'rv_get_work_order_detail': return JSON.stringify(await rvFetch('/maintenance/work-orders/' + input.workOrderId));
      case 'rv_get_work_order_notes': {
        if (input.workOrderId) return JSON.stringify(await rvFetch('/maintenance/work-orders/' + input.workOrderId + '/statuses'));
        return JSON.stringify({ message: 'Pass a workOrderId' });
      }
      case 'rv_get_inspections': {
        const params = { pageSize: 20, page: input.page || 1 };
        if (input.propertyId) params.propertyID = input.propertyId;
        return JSON.stringify(await rvFetch('/maintenance/inspections', params));
      }
      case 'rv_get_inspection_detail': return JSON.stringify(await rvFetch('/maintenance/inspections/' + input.inspectionId));
      case 'rv_get_tenants': {
        const data = await rvFetch('/contacts/tenants', { pageSize: 100 });
        if (input.search && Array.isArray(data)) return JSON.stringify(data.filter(t => (t.name||'').toLowerCase().includes(input.search.toLowerCase())));
        return JSON.stringify(data);
      }
      case 'rv_get_vendors': {
        const data = await rvFetch('/contacts/vendors', { pageSize: 100 });
        if (input.search && Array.isArray(data)) return JSON.stringify(data.filter(v => (v.name||'').toLowerCase().includes(input.search.toLowerCase())));
        return JSON.stringify(data);
      }
      case 'aptly_get_board_cards': {
        const boardId = input.boardId;
        const schemaData = await unitsFetch('/api/schema/' + boardId);
        const schemaMap = {};
        if (Array.isArray(schemaData)) schemaData.forEach(f => { schemaMap[f.key] = f.label; });
        let allCards = [], pg = 0;
        while (true) {
          const data = await unitsFetch('/api/board/' + boardId, { page: pg, pageSize: 50 });
          const batch = Array.isArray(data) ? data : (data&&data.data)||[];
          allCards = allCards.concat(batch);
          if (batch.length < 50) break;
          pg++;
          if (pg > 10) break;
        }
        return JSON.stringify({ cards: allCards.map(card => { const m = { _cardId: card.cardId, stage: card.stage }; Object.keys(card).forEach(k => { m[schemaMap[k]||k] = card[k]; }); return m; }), total: allCards.length });
      }
      case 'aptly_list_boards': return JSON.stringify([{ id: 'unit', name: 'Units/Listings' }, { id: '4EMDSYKirhQaNdQKz', name: 'Renter Leads' }, { id: 'MJxaStgENouWrNEKd', name: 'Applicants' }, { id: 'workOrder', name: 'Work Orders' }]);
      case 'aptly_search_cards': {
        const q = input.query || '';
        const data = await aptlyFetch('/aptlet/' + input.boardId, { page: 0, query: q });
        const cards = (data&&data.cards)||(Array.isArray(data)?data:[]);
        return JSON.stringify(q ? cards.filter(c => JSON.stringify(c).toLowerCase().includes(q.toLowerCase())) : cards);
      }
      case 'aptly_get_applicant': {
        const q = (input.query||'').toLowerCase();
        const allCards = await getApplicantsCards();
        const matched = allCards.filter(c => JSON.stringify(c).toLowerCase().includes(q));
        return JSON.stringify(matched.length === 0 ? { message: 'No applicant found matching: ' + input.query } : matched.slice(0,5));
      }
      case 'aptly_get_leads': {
        const data = await unitsFetch('/api/board/4EMDSYKirhQaNdQKz', { page: 0, pageSize: 100, includeArchived: input.includeArchived ? true : false });
        const allCards = Array.isArray(data) ? data : (data&&data.data)||[];
        let leads = allCards;
        if (input.daysBack) { const cutoff = Date.now() - input.daysBack*86400000; leads = leads.filter(c => { try { return new Date(c.createdAt).getTime() > cutoff; } catch(e) { return false; } }); }
        if (input.property) { const p = input.property.toLowerCase(); leads = leads.filter(c => JSON.stringify(c).toLowerCase().includes(p)); }
        return JSON.stringify({ total: leads.length, leads: leads.slice(0,50) });
      }
      case 'aptly_get_work_orders': {
        let allWOs = [];
        for (let page = 0; page <= 10; page++) {
          const data = await unitsFetch('/api/board/workOrder', { page, pageSize: 100, includeArchived: false });
          const batch = Array.isArray(data) ? data : (data&&data.data)||[];
          if (batch.length === 0) break;
          allWOs = allWOs.concat(batch);
          if (batch.length < 100) break;
        }
        const activeWOs = allWOs.filter(c => !c.archived && !/^(closed|cancelled|completed|rejected)/i.test(c.stage||''));
        let filtered = activeWOs;
        if (input.status) filtered = activeWOs.filter(c => (c.stage||'').toLowerCase().includes(input.status.toLowerCase()));
        if (input.property) { const p = input.property.toLowerCase(); filtered = filtered.filter(c => JSON.stringify(c).toLowerCase().includes(p)); }
        const now = Date.now();
        const slim = filtered.map(c => {
          const locArr = Array.isArray(c.location) ? c.location : (c.location ? [c.location] : []);
          const unitArr = Array.isArray(c.unit) ? c.unit : (c.unit ? [c.unit] : []);
          const address = normalizeAddr((locArr[0]&&locArr[0].name)||(unitArr[0]&&unitArr[0].name)||'');
          const vendorArr = Array.isArray(c.vendor) ? c.vendor : (c.vendor ? [c.vendor] : []);
          const vendor = (vendorArr[0]&&vendorArr[0].name)||'Unassigned';
          const created = c.createdAt ? new Date(c.createdAt).getTime() : null;
          return { address, num: c.workOrderNumber||'', issue: (c.description||c.name||'').replace(/<[^>]+>/g,' ').trim().slice(0,80), vendor, opened: (c.createdAt||'').slice(0,10), daysOpen: created ? Math.floor((now-created)/86400000) : null, status: c.stage||'' };
        });
        return JSON.stringify({ total: slim.length, workOrders: slim });
      }
      case 'compare_work_orders': return JSON.stringify({ message: 'Use rv_get_work_orders and aptly_get_work_orders separately' });
      case 'slack_search': {
        const data = await slackFetch('/search.messages', { query: input.query, count: 10 });
        if (data.messages&&data.messages.matches) return JSON.stringify(data.messages.matches.map(m => ({ channel: m.channel&&m.channel.name, user: m.username, text: m.text })));
        return JSON.stringify({ message: 'No results' });
      }
      case 'slack_get_channel_messages': {
        const data = await slackFetch('/conversations.history', { channel: input.channelId, limit: input.limit||20 });
        if (data.messages) return JSON.stringify(data.messages.map(m => ({ text: m.text })));
        return JSON.stringify({ error: data.error||'Could not fetch' });
      }
      case 'slack_list_channels': {
        const data = await slackFetch('/conversations.list', { limit: 100, exclude_archived: true });
        if (data.channels) return JSON.stringify(data.channels.map(c => ({ id: c.id, name: c.name })));
        return JSON.stringify({ error: data.error });
      }
      case 'zi_get_inspections': {
        const result = await ziFetch('/inspections', { limit: 10 });
        if (result.error) return JSON.stringify(await rvFetch('/maintenance/inspections', { pageSize: 50 }));
        return JSON.stringify(result);
      }
      default: return JSON.stringify({ error: 'Unknown tool: ' + name });
    }
  } catch (err) {
    console.error('Tool ' + name + ' error:', err.message);
    return JSON.stringify({ error: err.message });
  }
}

function getRelevantTools(msg) {
  msg = (msg || '').toLowerCase();
  const tools = new Set();
  if (msg.match(/tenant|owe|balance|ledger|payment|charge|rent|deposit|past.?due|unpaid|how much/)) ['rv_get_leases','rv_get_ledger','rv_get_transactions'].forEach(t => tools.add(t));
  if (msg.match(/availab|unit|vacant|propert|homes?|bed|bath|tour|showing/)) ['aptly_get_board_cards','aptly_search_cards'].forEach(t => tools.add(t));
  if (msg.match(/work.?order|maintenance|repair|fix|broken/)) tools.add('aptly_get_work_orders');
  if (msg.match(/inspect/)) ['rv_get_inspections','rv_get_inspection_detail'].forEach(t => tools.add(t));
  if (msg.match(/vendor|contractor/)) { tools.add('rv_get_vendors'); tools.add('kb_search'); }
  if (msg.match(/owner|landlord|portfolio/)) ['rv_get_owners','rv_get_properties'].forEach(t => tools.add(t));
  if (msg.match(/lead|pipeline|move.?in|move.?out|hoa|renewal|board|card|aptly/)) ['aptly_get_board_cards','aptly_list_boards','aptly_search_cards'].forEach(t => tools.add(t));
  if (msg.match(/applicant|application|applied|applying/)) { tools.add('aptly_get_applicant'); tools.add('aptly_search_cards'); }
  if (msg.match(/policy|procedure|sop|how do|lease.?break|fee|screen|criteria|cost|price|quote|benchmark/)) tools.add('kb_search');
  if (msg.match(/slack|team|announce/)) ['slack_search','slack_get_channel_messages','slack_list_channels'].forEach(t => tools.add(t));
  if (tools.size === 0) ['rv_get_leases','kb_search'].forEach(t => tools.add(t));
  return ALL_TOOLS.filter(t => Array.from(tools).includes(t.name));
}

app.post('/api/chat', async function(req, res) {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    const messages = req.body.messages;
    const lastMsg = messages.slice().reverse().find(m => m.role === 'user');
    const tools = getRelevantTools(lastMsg ? lastMsg.content : '');
    const lastContent = messages[messages.length-1]?.content;
    const lowerMsg = (typeof lastContent==='string' ? lastContent : (Array.isArray(lastContent) ? lastContent.map(b=>b.text||'').join(' ') : '')).toLowerCase();
    const userMsg = typeof lastContent==='string' ? lastContent : (Array.isArray(lastContent) ? lastContent.map(b=>b.text||'').join(' ') : '');

    const isVendorQ = lowerMsg.match(/vendor|who.*assign|who.*call|preferred.*vendor|vendor.*list/);
    if (isVendorQ) {
      try {
        const vendorContext = await getKbTopic('vendor_list', 'preferred vendor list service type phone HVAC plumbing electrical landscaping pest', { limit: 4, audience: 'staff' });
        if (vendorContext) {
          const resp = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1024, system: 'You are Aloe Assistant. Answer the vendor question using ONLY the vendor reference provided.', messages: [{ role: 'user', content: 'VENDOR REFERENCE:\n\n' + vendorContext + '\n\n---\nQuestion: ' + userMsg }] }) });
          const data = await resp.json();
          const answer = (data.content&&data.content[0]&&data.content[0].text)||'';
          if (answer) return res.json({ content: [{ type: 'text', text: answer }] });
        }
      } catch(e) { console.error('Vendor shortcut error:', e.message); }
    }

    const isAvailabilityQ = !lowerMsg.match(/work.?order|maintenance|repair|vendor/) && lowerMsg.match(/availab|for rent|vacant|what unit|what prop|homes.*rent|\d\s*bed/) && !lowerMsg.match(/[0-9]{5,6}/);
    if (isAvailabilityQ) {
      try {
        const cards = await getUnitsCards();
        const published = cards.filter(c => c['Published For Rent']==='checked' || c['Published For Rent']===true || c['Syndicate']==='checked');
        if (published.length > 0) {
          const fmt = c => {
            let addr = c.Street || c.Address || c['Marketing Name'] || '?';
            addr = addr.replace(/^\d{2}\/\d{2}\/\d{4}\s+/, '');
            const rentRaw = c['Market Rent'] || '';
            const rent = rentRaw && typeof rentRaw==='object' && rentRaw.amount ? '$' + Number(rentRaw.amount).toLocaleString() : rentRaw;
            const beds = c.Beds ? c.Beds + 'bd/' + (c.Baths||'?') + 'ba' : '';
            return addr + (beds ? ' — ' + beds : '') + (rent ? ', ' + rent : '');
          };
          return res.json({ content: [{ type: 'text', text: 'Homes published for rent (' + published.length + '):\n\n' + published.map(fmt).join('\n') }] });
        }
      } catch(e) { console.error('Units shortcut error:', e.message); }
    }

    const isApplicationQ = lowerMsg.match(/application|applicant|applied|applying/) && !lowerMsg.match(/[0-9]{5,6}/);
    if (isApplicationQ) {
      try {
        const cards = await getApplicantsCards();
        const active = cards.filter(c => !c.archived && c.Stage !== 'Application Closed' && c.Stage !== 'Archived');
        if (active.length > 0) {
          const fmt = c => (c['Application Location']||'(no address)') + ' — ' + (c['Primary Applicant']||'?') + (c.appApproved ? ' APPROVED' : '');
          return res.json({ content: [{ type: 'text', text: 'Active applications (' + active.length + '):\n\n' + active.slice(0,20).map(fmt).join('\n') }] });
        }
      } catch(e) { console.error('Applications shortcut error:', e.message); }
    }

    let current = messages.slice();
    for (let i = 0; i < 10; i++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 1024,
          system: await (async function() {
            let sys = SYSTEM_PROMPT;
            if (i === 0) {
              const ctx = await getKbContext(lowerMsg);
              if (ctx && ctx.text) sys += '\n\n---\nRELEVANT KB CONTENT (' + ctx.label + '):\n' + ctx.text.slice(0, 4000);
            }
            return sys;
          })(),
          messages: current,
          tools: tools,
        }),
      });
      const data = await r.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      if (data.stop_reason !== 'tool_use') return res.json(data);
      const tbs = data.content.filter(b => b.type === 'tool_use');
      const results = await Promise.all(tbs.map(async tb => {
        let result = await executeTool(tb.name, tb.input);
        if (typeof result === 'string' && result.length > 15000) result = result.slice(0, 15000) + '...[truncated]';
        return { type: 'tool_result', tool_use_id: tb.id, content: result };
      }));
      current = current.concat([{ role: 'assistant', content: data.content }, { role: 'user', content: results }]);
    }
    res.status(500).json({ error: 'Too many steps — try a more specific question' });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── HOA: Property lookup (must be BEFORE the catch-all rentvine proxy) ──────
app.get('/api/rentvine/property-lookup', hubAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase();
    let allProps = [];
    for (let page = 1; page <= 10; page++) {
      const url = `${RENTVINE_BASE}/properties/export?pageSize=500&page=${page}`;
      const r = await fetch(url, { headers: { Authorization: `Basic ${RENTVINE_AUTH}`, 'X-Rentvine-Account': RENTVINE_ACCOUNT } });
      const batch = await r.json();
      const items = Array.isArray(batch) ? batch : (batch.data || batch.results || []);
      if (!items.length) break;
      allProps = allProps.concat(items);
      if (items.length < 500) break;
    }
    console.log(`property-lookup: fetched ${allProps.length} total, filtering for "${q}"`);
    // Strip directional prefixes/suffixes for flexible matching
    const stripDirections = s => s.replace(/\b(north|south|east|west|n|s|e|w)\b\.?/gi, '').replace(/\s+/g, ' ').trim();
    const qClean = stripDirections(q);
    const filtered = q ? allProps.filter(item => {
      const p = item.property || item;
      const addr = stripDirections((p.address || '').toLowerCase());
      const street = stripDirections((p.streetName || '').toLowerCase());
      const num = String(p.streetNumber || '').toLowerCase();
      // Must match street number exactly if provided in query
      const queryParts = qClean.split(/\s+/);
      const queryNum = queryParts.find(p => /^\d+$/.test(p)) || '';
      const queryStreet = queryParts.filter(p => !/^\d+$/.test(p)).join(' ');
      const numMatch = !queryNum || num === queryNum;
      const streetMatch = !queryStreet || addr.includes(queryStreet) || street.includes(queryStreet);
      return numMatch && streetMatch;
    }) : allProps;
    // Enrich with unit leaseID (property export doesn't include it)
    const enriched = await Promise.all(filtered.slice(0, 10).map(async item => {
      const p = item.property || item;
      let leaseId = p.leaseID || null;
      if (!leaseId) {
        try {
          const units = await rvFetch('/properties/' + p.propertyID + '/units');
          const unitList = Array.isArray(units) ? units : (units.units || units.data || []);
          if (unitList.length > 0) {
            const u = unitList[0].unit || unitList[0];
            leaseId = u.leaseID || null;
          }
        } catch(e) { /* ignore */ }
      }
      return { propertyId: p.propertyID, leaseId, address: p.address, city: p.city, state: p.stateID, zip: p.postalCode };
    }));
    res.json({ properties: enriched });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── HOA routes (must be before catch-all proxy) ──────────────────────────
app.get('/api/rentvine/properties/:id', hubAuth, async (req, res) => {
  try {
    const r = await fetch(`${RENTVINE_BASE}/properties/${req.params.id}`, { headers: { Authorization: `Basic ${RENTVINE_AUTH}`, 'X-Rentvine-Account': RENTVINE_ACCOUNT } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rentvine/properties/:id/leases', hubAuth, async (req, res) => {
  try {
    const r = await fetch(`${RENTVINE_BASE}/leases/export?propertyID=${req.params.id}&statusID=2&pageSize=10`, { headers: { Authorization: `Basic ${RENTVINE_AUTH}`, 'X-Rentvine-Account': RENTVINE_ACCOUNT } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rentvine/leases/:id', hubAuth, async (req, res) => {
  try {
    const r = await fetch(`${RENTVINE_BASE}/leases/${req.params.id}`, { headers: { Authorization: `Basic ${RENTVINE_AUTH}`, 'X-Rentvine-Account': RENTVINE_ACCOUNT } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rentvine/leases/:id/charges', hubAuth, async (req, res) => {
  try {
    const r = await fetch(`${RENTVINE_BASE}/accounting/leases/${req.params.id}/charges`, { method: 'POST', headers: { Authorization: `Basic ${RENTVINE_AUTH}`, 'X-Rentvine-Account': RENTVINE_ACCOUNT, 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use('/api/rentvine', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  // Handle property-lookup internally instead of proxying to Rentvine
  if (req.path === '/property-lookup') {
    const tok = req.headers['x-hub-token'] || req.headers['x-agent-key'] || req.query.token;
    if (tok !== process.env.HUB_INTERNAL_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    const q = (req.query.q || '').toLowerCase();
    if (!q) return res.json({ properties: [] });
    let allProps = [];
    for (let page = 1; page <= 10; page++) {
      const url = `${RENTVINE_BASE}/properties/export?pageSize=500&page=${page}`;
      const r = await fetch(url, { headers: { Authorization: `Basic ${RENTVINE_AUTH}`, 'X-Rentvine-Account': RENTVINE_ACCOUNT } });
      const batch = await r.json();
      const items = Array.isArray(batch) ? batch : (batch.data || batch.results || []);
      if (!items.length) break;
      allProps = allProps.concat(items);
      if (items.length < 500) break;
    }
    const stripDir = s => s.replace(/\b(north|south|east|west|n|s|e|w)\b\.?/gi, '').replace(/\s+/g, ' ').trim();
    const qClean = stripDir(q);
    const filtered = allProps.filter(item => {
      const p = item.property || item;
      const addr = stripDir((p.address || '').toLowerCase());
      const num = String(p.streetNumber || '');
      const queryParts = qClean.split(/\s+/);
      const queryNum = queryParts.find(x => /^\d+$/.test(x)) || '';
      const queryStreet = queryParts.filter(x => !/^\d+$/.test(x)).join(' ');
      return (!queryNum || num === queryNum) && (!queryStreet || addr.includes(queryStreet));
    });
    const results = filtered.slice(0, 5).map(item => {
      const p = item.property || item;
      return { propertyId: p.propertyID, address: p.address, city: p.city, state: p.stateID, zip: p.postalCode, leaseId: null };
    });
    return res.json({ properties: results });
  }
  const rvPath = req.path;
  const query = new URLSearchParams(req.query).toString();
  const url = `${RENTVINE_BASE}${rvPath}${query ? '?' + query : ''}`;
  try {
    const opts = { headers: { Authorization: `Basic ${RENTVINE_AUTH}`, 'Content-Type': 'application/json', 'X-Rentvine-Account': RENTVINE_ACCOUNT } };
    if (req.method === 'POST') { opts.method = 'POST'; opts.body = JSON.stringify(req.body); }
    const r = await fetch(url, opts);
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ── WO Sync: Auto-close in Rentvine WOs that are closed/cancelled in Aptly ──
async function fetchAllAptlyClosedWOs() {
  const APTLY_TOK = process.env.APTLY_TOKEN || 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';
  const schemaResp = await fetch('https://core-api.getaptly.com/api/schema/workOrder', { headers: { 'x-token': APTLY_TOK } });
  const schema = await schemaResp.json();
  const schemaMap = {};
  if (Array.isArray(schema)) schema.forEach(f => { schemaMap[f.key] = f.label; });
  const woNumKey = Object.entries(schemaMap).find(([k,v]) => /work.?order.?num/i.test(v))?.[0] || null;
  const isClosedKey = Object.entries(schemaMap).find(([k,v]) => /^is.?closed$/i.test(v))?.[0] || null;
  const closedDateKey = Object.entries(schemaMap).find(([k,v]) => /^closed.?date$/i.test(v))?.[0] || null;
  console.log('WO Sync schema keys:', { woNumKey, isClosedKey, closedDateKey });

  let all = [];
  for (const archived of ['false', 'true']) {
    let page = 0;
    while (page < 50) {
      const resp = await fetch(
        'https://core-api.getaptly.com/api/board/workOrder?page=' + page + '&pageSize=100&includeArchived=' + archived,
        { headers: { 'x-token': APTLY_TOK } }
      );
      if (!resp.ok) break;
      const raw = await resp.json();
      const items = Array.isArray(raw) ? raw : (raw && raw.data) || (raw && raw.cards) || [];
      if (!items.length) break;
      const existingIds = new Set(all.map(c => c._id));
      items.forEach(c => { if (!existingIds.has(c._id)) all.push(c); });
      if (items.length < 100) break;
      page++;
    }
  }
  console.log('WO Sync: fetched ' + all.length + ' total Aptly WO cards');

  const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000); // 7 days
  return all.filter(c => {
    const woNum = c[woNumKey] || c.workOrderNumber;
    const stage = (c.stage || c.Stage || '').toLowerCase();
    const isClosedStage = /^(completed|cancelled|closed|done)/.test(stage) && !/^(scheduled|requested|open|pending|waiting|home warranty|unit turn|internal)/.test(stage);
    const hasClosedDate = !!(c.dateClosed || c['Closed Date'] || (closedDateKey && c[closedDateKey]));
    const hasWONumber = !!(woNum && String(woNum).trim());
    const isRecent = c.stageUpdatedAt ? new Date(c.stageUpdatedAt).getTime() > cutoff : (c.createdAt ? new Date(c.createdAt).getTime() > cutoff : true);
    // Only use closedDate signal if stage is also terminal — avoids flagging Scheduled WOs with a closed date
    const isTrulyDone = isClosedStage || (hasClosedDate && isClosedStage);
    return hasWONumber && isRecent && isTrulyDone;
  }).map(c => {
    const woNum = c[woNumKey] || c.workOrderNumber;
    return Object.assign({}, c, { _woNumber: String(woNum).trim() });
  });
}

async function fetchAllRVOpenWOs() {
  let all = [], pg = 1;
  while (pg <= 20) {
    const data = await rvFetch('/maintenance/work-orders', { pageSize: 100, page: pg });
    const rawBatch = Array.isArray(data) ? data : (data && data.data) || [];
    if (!rawBatch.length) break;
    rawBatch.forEach(rec => {
      const wo = rec.workOrder || rec;
      if (!wo.workOrderID) return;
      wo._unitAddress = (rec.unit && (rec.unit.address || rec.unit.name)) || (rec.property && rec.property.address) || wo.unitAddress || '';
      const sid = parseInt(wo.primaryWorkOrderStatusID || 0);
      // 3=Closed only — keep Pending(1), Open(2), OnHold(4) as "open"
      // primaryWorkOrderStatusID: 3=Closed, 5=Cancelled — both are terminal
      const isClosed = sid === 3 || sid === 5 || !!wo.closedDate || !!wo.dateClosed;
      if (!isClosed) all.push(wo);
    });
    if (rawBatch.length < 100) break;
    pg++;
  }
  return all;
}

async function closeRVWorkOrder(workOrderId, statusId) {
  const url = RENTVINE_BASE + '/maintenance/work-orders/' + workOrderId;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': 'Basic ' + RENTVINE_AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workOrderStatusID: statusId })
  });
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch(e) { json = { raw: text }; }
  if (!resp.ok) {
    const putResp = await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': 'Basic ' + RENTVINE_AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workOrderStatusID: statusId })
    });
    const putText = await putResp.text();
    let putJson; try { putJson = JSON.parse(putText); } catch(e) { putJson = { raw: putText }; }
    return { ok: putResp.ok, status: putResp.status, body: putJson };
  }
  return { ok: resp.ok, status: resp.status, body: json };
}

async function runWOSync(dryRun) {
  dryRun = dryRun === true;
  console.log('WO Sync: starting dryRun=' + dryRun);
  const [aptlyClosed, rvOpen] = await Promise.all([fetchAllAptlyClosedWOs(), fetchAllRVOpenWOs()]);
  const rvByNumber = {};
  rvOpen.forEach(wo => { const n = String(wo.workOrderNumber || '').trim(); if (n) rvByNumber[n] = wo; });
  const toClose = [];
 aptlyClosed.forEach(card => {
    const rvWO = rvByNumber[card._woNumber];
    if (rvWO) {
      const unitArr = Array.isArray(card.unit) ? card.unit : (card.unit ? [card.unit] : []);
      const locArr = Array.isArray(card.location) ? card.location : (card.location ? [card.location] : []);
      const aptlyAddr = (unitArr[0] && unitArr[0].name) || (locArr[0] && locArr[0].name) || card.name || '';
      const address = rvWO._unitAddress || aptlyAddr || '';
      toClose.push({
        woNumber: card._woNumber,
        rvWorkOrderId: rvWO.workOrderID,
        address: address.slice(0, 60),
        aptlyStage: card.stage || card.Stage || '',
        aptlyClosedDate: card.dateClosed || card['Closed Date'] || card['Stage Changed'] || ''
      });
    }
  });
  console.log('WO Sync: ' + aptlyClosed.length + ' closed in Aptly, ' + rvOpen.length + ' open in RV, ' + toClose.length + ' to close');
  if (dryRun) return { dryRun: true, aptlyClosedCount: aptlyClosed.length, rvOpenCount: rvOpen.length, wouldClose: toClose };

  const closeResults = [];
  for (const r of toClose) {
    const stageLower = (r.aptlyStage || '').toLowerCase();
    const rvStatusId = /^cancel/.test(stageLower) ? 3 : 2; // 3=Cancelled, 2=Completed
    try {
      const result = await closeRVWorkOrder(r.rvWorkOrderId, rvStatusId);
      closeResults.push(Object.assign({}, r, { rvStatusId, ok: result.ok, status: result.status }));
      console.log('WO Sync: closed RV WO #' + r.woNumber + ' (id ' + r.rvWorkOrderId + ') -> status ' + rvStatusId + ' | ok=' + result.ok);
    } catch (e) {
      closeResults.push(Object.assign({}, r, { rvStatusId, ok: false, error: e.message }));
      console.error('WO Sync: failed to close RV WO #' + r.woNumber + ':', e.message);
    }
  }
  console.log('WO Sync: auto-closed ' + closeResults.filter(r => r.ok).length + '/' + toClose.length + ' work orders');

  // Reverse check: Aptly open WOs missing from Rentvine entirely
  const APTLY_TOK = process.env.APTLY_TOKEN || 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';
  const schemaResp2 = await fetch('https://core-api.getaptly.com/api/schema/workOrder', { headers: { 'x-token': APTLY_TOK } });
  const schema2 = await schemaResp2.json();
  const schemaMap2 = {};
  if (Array.isArray(schema2)) schema2.forEach(f => { schemaMap2[f.key] = f.label; });
  const woNumKey2 = Object.entries(schemaMap2).find(([k,v]) => /work.?order.?num/i.test(v))?.[0] || 'workOrderNumber';

  let aptlyOpen = [], page2 = 0;
  while (page2 < 50) {
    const resp2 = await fetch('https://core-api.getaptly.com/api/board/workOrder?page=' + page2 + '&pageSize=100&includeArchived=false', { headers: { 'x-token': APTLY_TOK } });
    if (!resp2.ok) break;
    const raw2 = await resp2.json();
    const items2 = Array.isArray(raw2) ? raw2 : (raw2 && raw2.data) || [];
    if (!items2.length) break;
    aptlyOpen = aptlyOpen.concat(items2);
    if (items2.length < 100) break;
    page2++;
  }

  const rvNumbers = new Set(rvOpen.map(wo => String(wo.workOrderNumber || '').trim()));
  const missingInRV = aptlyOpen.filter(c => {
    const woNum = c[woNumKey2] || c.workOrderNumber;
    const stage = (c.stage || c.Stage || '').toLowerCase();
    const isActiveStage = !/^(completed|cancelled|closed|done)/.test(stage);
    return woNum && isActiveStage && !rvNumbers.has(String(woNum).trim());
  }).map(c => {
    const woNum = c[woNumKey2] || c.workOrderNumber;
    const unitArr = Array.isArray(c.unit) ? c.unit : (c.unit ? [c.unit] : []);
    const locArr = Array.isArray(c.location) ? c.location : (c.location ? [c.location] : []);
    const addr = (unitArr[0] && unitArr[0].name) || (locArr[0] && locArr[0].name) || c.name || '';
    return { woNumber: String(woNum).trim(), address: addr.slice(0, 60), aptlyStage: c.stage || c.Stage || '' };
  });

  if (SLACK_TOKEN && missingInRV.length > 0) {
    const lines2 = missingInRV.map(r =>
      '• WO #' + r.woNumber + ' — ' + (r.address || 'see Aptly') + ' — _' + r.aptlyStage + ' in Aptly_'
    ).join('\n');
    const slackText2 = '*⚠️ WO Sync — ' + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '*\n' +
      '*' + missingInRV.length + ' work order(s) open in Aptly but missing from Rentvine:*\n' + lines2 +
      '\n\n_These WOs may need to be created in Rentvine · Runs nightly 11pm AZ_';
    try {
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'C06BWVACZQF', text: slackText2 })
      });
      console.log('WO Sync: missing-in-RV alert sent for ' + missingInRV.length + ' WOs');
    } catch(e) { console.error('WO Sync missing-in-RV Slack error:', e.message); }
  }
const todayStr = new Date().toISOString().slice(0, 10);
  try {
    await writeWOSyncHistory(todayStr, {
      date: todayStr,
      ranAt: new Date().toISOString(),
      closed: closeResults.filter(r => r.ok).length,
      totalMatched: toClose.length,
      items: closeResults,
      missingInRentvine: missingInRV
    });
  } catch (e) {
    console.error('WO Sync: failed to write history to GCS:', e.message);
  }
  return { notified: toClose.length, items: toClose, missingInRentvine: missingInRV };
  }

app.get('/api/wo-sync/debug', async (req, res) => {
  try {
    const APTLY_TOK = process.env.APTLY_TOKEN || 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';
    const schemaResp = await fetch('https://core-api.getaptly.com/api/schema/workOrder', { headers: { 'x-token': APTLY_TOK } });
    const schema = await schemaResp.json();
    const schemaMap = {};
    if (Array.isArray(schema)) schema.forEach(f => { schemaMap[f.key] = f.label; });
    const woNumKey = Object.entries(schemaMap).find(([k,v]) => /work.?order.?num/i.test(v))?.[0] || null;
    const isClosedKey = Object.entries(schemaMap).find(([k,v]) => /^is.?closed$/i.test(v))?.[0] || null;
    const closedDateKey = Object.entries(schemaMap).find(([k,v]) => /^closed.?date$/i.test(v))?.[0] || null;
    const resp = await fetch('https://core-api.getaptly.com/api/board/workOrder?page=0&pageSize=10&includeArchived=true', { headers: { 'x-token': APTLY_TOK } });
    const raw = await resp.json();
    const items = Array.isArray(raw) ? raw : (raw && raw.data) || (raw && raw.cards) || [];
    const firstCardValues = items[0] ? Object.entries(items[0]).slice(0, 40).map(([k, v]) => ({
      key: k, label: schemaMap[k] || '(no label)',
      value: typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60)
    })) : [];
    const closed = await fetchAllAptlyClosedWOs();
    const rvOpen = await fetchAllRVOpenWOs();
    res.json({
      schemaFieldCount: Object.keys(schemaMap).length,
      woNumKey, isClosedKey, closedDateKey,
      firstCardValues,
      aptlyClosedCount: closed.length,
      aptlyClosedSample: closed.slice(0, 5).map(c => ({ woNumber: c._woNumber, stage: c.stage || c.Stage, isClosed: c['Is Closed'], closedDate: c['Closed Date'] })),
      rvOpenCount: rvOpen.length,
      rvSample: rvOpen.slice(0, 3).map(wo => ({ workOrderNumber: wo.workOrderNumber, statusID: wo.primaryWorkOrderStatusID, address: wo._unitAddress }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/wo-sync/dry-run', async (req, res) => {
  try { res.json(await runWOSync(true)); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/wo-sync/run', async (req, res) => {
  try { res.json(await runWOSync(false)); } catch(e) { res.status(500).json({ error: e.message }); }
});
// ── Late Payment Settlement Alert ──────────────────────────────────────────

const ALOE_FEE_ACCOUNT_IDS = new Set([
  93, 94, 40, 148, 58, 14, 51, 90, 136, 57, 12, 62, 56, 145, 19
]);

async function runLatePaymentSettlementAlert() {
  try {
    console.log('Settlement alert: starting run');

    // 1. Get yesterday's date range in AZ time
    const azNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Phoenix' }));
    const yesterday = new Date(azNow);
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().slice(0, 10);
    const currentMonthStart = `${azNow.getFullYear()}-${String(azNow.getMonth() + 1).padStart(2, '0')}-01`;

    // 2. Pull yesterday's settlements
    const settlementUrl = `${RENTVINE_BASE}/reports/settlement-detail?exportTypeID=1&json=${encodeURIComponent(JSON.stringify({
      displayColumns: ['settlementDate','datePosted','contactName','unit','amount','reference','paymentTypeID'],
      filters: [{ name: 'settlementDate', comparator: 'betweenDate', startDate: yStr, endDate: yStr }],
      orderBys: ['contactName']
    }))}`;

    const settlResp = await fetch(settlementUrl, {
      headers: { Authorization: `Basic ${RENTVINE_AUTH}` }
    });
    const settlData = await settlResp.json();
    const settlements = Array.isArray(settlData) ? settlData : (settlData.data || []);
    console.log(`Settlement alert: ${settlements.length} settlements on ${yStr}`);

    if (settlements.length === 0) {
      console.log('Settlement alert: no settlements yesterday, skipping');
      return;
    }

    // 3. Get all active leases to match contact names to leases/properties
    let allLeases = [];
    for (let pg = 1; pg <= 10; pg++) {
      const batch = await rvFetch('/leases/export', { pageSize: 200, page: pg, 'primaryLeaseStatusIDs[]': 2 });
      if (!Array.isArray(batch) || batch.length === 0) break;
      allLeases = allLeases.concat(batch);
      if (batch.length < 200) break;
    }

    // Build lookup: contactName → lease info
    const leaseByTenant = {};
    allLeases.forEach(item => {
      const l = item.lease || item;
      const tenants = Array.isArray(l.tenants) ? l.tenants : [];
      const address = (item.unit && item.unit.address) || (item.property && item.property.address) || '';
      const city = (item.unit && item.unit.city) || (item.property && item.property.city) || '';
      tenants.forEach(t => {
        if (t.name) {
          leaseByTenant[t.name.toLowerCase()] = {
            leaseID: l.leaseID,
            propertyID: (item.property && item.property.propertyID) || l.propertyID,
            address,
            city,
            moveInDate: l.moveInDate || l.startDate,
            moveOutDate: l.expectedMoveOutDate || l.moveOutDate,
            rent: parseFloat((item.unit && item.unit.rent) || l.rent || 0)
          };
        }
      });
    });

    // 4. Get all unpaid bills for this month grouped by propertyID
    const billsUrl = `${RENTVINE_BASE}/reports/payables?exportTypeID=1&json=${encodeURIComponent(JSON.stringify({
      displayColumns: ['propertyID','unitID','chargeAccountID','datePosted','dateDue','amount','amountUnpaid','isPaid','description','billID'],
      filters: [
        { name: 'isPaid', comparator: 'booleanFalse' },
        { name: 'isVoided', comparator: 'booleanFalse' }
      ]
    }))}`;

    const billsResp = await fetch(billsUrl, { headers: { Authorization: `Basic ${RENTVINE_AUTH}` } });
    const billsData = await billsResp.json();
    const allBills = Array.isArray(billsData) ? billsData : (billsData.data || []);

    // Group bills by propertyID, separate owner expenses from Aloe fees
    const ownerBillsByProp = {};
    const suppBillsByProp = {};
    allBills.forEach(b => {
      const propID = String(b.propertyID || '');
      if (!propID) return;
      const acctID = parseInt(b.chargeAccountID || 0);
      const unpaid = parseFloat(b.amountUnpaid || b.amount || 0);
      const desc = b.description || '';
      const isSuppressed = b.isSuppressed === true || b.isSuppressed === 1 || b.isSuppressed === '1';

      if (ALOE_FEE_ACCOUNT_IDS.has(acctID)) return; // skip Aloe fees

      const entry = { desc, amount: unpaid, billID: b.billID, acctID };

      if (isSuppressed) {
        if (!suppBillsByProp[propID]) suppBillsByProp[propID] = [];
        suppBillsByProp[propID].push(entry);
      } else {
        if (!ownerBillsByProp[propID]) ownerBillsByProp[propID] = [];
        ownerBillsByProp[propID].push(entry);
      }
    });

    // 5. Process each settlement
    const today = new Date(azNow);
    today.setHours(0,0,0,0);
    const currentMonth = azNow.getMonth();
    const currentYear = azNow.getFullYear();

    const readyToPay = [];
    const holdBills = [];
    const skippedPrepaid = [];

    for (const s of settlements) {
      const contactName = s.contactName || '';
      const amount = parseFloat(s.amount || 0);
      if (amount <= 0) continue;

      // Find lease for this tenant
      const leaseInfo = leaseByTenant[contactName.toLowerCase()];
      if (!leaseInfo) {
        // Can't find lease — skip but note
        skippedPrepaid.push(`${contactName} — $${amount.toFixed(2)} (lease not found)`);
        continue;
      }

      // Check lease charges to see if any are past due
      let hasPastDue = false;
      let pastDueDesc = '';
      try {
        const charges = await rvFetch('/leases/' + leaseInfo.leaseID + '/charges', { pageSize: 50, isPaid: false });
        const chargeArr = Array.isArray(charges) ? charges : (charges.data || []);
        const pastDueCharges = chargeArr.filter(c => {
          const dueDate = c.dateDue || c.dueDate || '';
          return dueDate && dueDate < currentMonthStart;
        });
        if (pastDueCharges.length > 0) {
          hasPastDue = true;
          pastDueDesc = pastDueCharges.map(c =>
            `${c.description || 'Charge'} due ${(c.dateDue||c.dueDate||'').slice(0,10)} ($${parseFloat(c.amount||0).toFixed(2)})`
          ).join(', ');
        }
      } catch(e) {
        console.error('Settlement alert: charge lookup error for lease', leaseInfo.leaseID, e.message);
      }

      if (!hasPastDue) {
        skippedPrepaid.push(`${contactName} — ${leaseInfo.address} — $${amount.toFixed(2)} (current/prepaid)`);
        continue;
      }

      // Calculate management fee
      let mgmtFee = 89;
      if (leaseInfo.moveInDate) {
        const moveIn = new Date(leaseInfo.moveInDate);
        if (moveIn.getMonth() === currentMonth && moveIn.getFullYear() === currentYear && moveIn.getDate() > 15) {
          mgmtFee = 44.50;
        }
      }
      if (leaseInfo.moveOutDate) {
        const moveOut = new Date(leaseInfo.moveOutDate);
        if (moveOut.getMonth() === currentMonth && moveOut.getFullYear() === currentYear && moveOut.getDate() < 15) {
          mgmtFee = 44.50;
        }
      }

      // Get unpaid owner bills for this property
      const propID = String(leaseInfo.propertyID);
      const ownerBills = ownerBillsByProp[propID] || [];
      const suppBills = suppBillsByProp[propID] || [];
      const ownerBillTotal = ownerBills.reduce((a, b) => a + b.amount, 0);
      const suppBillTotal = suppBills.reduce((a, b) => a + b.amount, 0);

      const ownerNet = amount - mgmtFee - ownerBillTotal;

      const entry = {
        contactName,
        address: leaseInfo.address,
        city: leaseInfo.city,
        settled: amount,
        mgmtFee,
        pastDueDesc,
        ownerBills,
        ownerBillTotal,
        suppBills,
        suppBillTotal,
        ownerNet
      };

      if (suppBills.length > 0 || ownerBillTotal > 0) {
        holdBills.push(entry);
      } else {
        readyToPay.push(entry);
      }
    }

    // 6. Build Slack message
    const fmt = (n) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const dateLabel = yesterday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    let msg = `*💰 Late Payment Settlements — ${dateLabel}*\n`;
    msg += `_Payments that settled yesterday for past-due charges_\n\n`;

    if (readyToPay.length > 0) {
      msg += `*✅ READY TO PAY OUT (${readyToPay.length})*\n`;
      msg += '─'.repeat(40) + '\n';
      readyToPay.forEach(e => {
        msg += `*${e.contactName}* — ${e.address}${e.city ? ', ' + e.city : ''}\n`;
        msg += `  Settled: ${fmt(e.settled)} | Applied to: ${e.pastDueDesc}\n`;
        msg += `  Management fee: −${fmt(e.mgmtFee)}\n`;
        msg += `  Unpaid owner bills: $0.00\n`;
        msg += `  *NET OWNER PAYOUT: ${fmt(e.ownerNet)}*\n\n`;
      });
    }

    if (holdBills.length > 0) {
      msg += `*⚠️ VERIFY BEFORE PAYING (${holdBills.length})*\n`;
      msg += '─'.repeat(40) + '\n';
      holdBills.forEach(e => {
        msg += `*${e.contactName}* — ${e.address}${e.city ? ', ' + e.city : ''}\n`;
        msg += `  Settled: ${fmt(e.settled)} | Applied to: ${e.pastDueDesc}\n`;
        msg += `  Management fee: −${fmt(e.mgmtFee)}\n`;
        if (e.ownerBills.length > 0) {
          msg += `  Unpaid owner bills: −${fmt(e.ownerBillTotal)}\n`;
          e.ownerBills.forEach(b => { msg += `    • ${b.desc || 'Bill #' + b.billID}: ${fmt(b.amount)}\n`; });
        }
        if (e.suppBills.length > 0) {
          msg += `  ⚠️ Suppressed bills not yet posted: ${fmt(e.suppBillTotal)}\n`;
          e.suppBills.forEach(b => { msg += `    • ${b.desc || 'Bill #' + b.billID}: ${fmt(b.amount)}\n`; });
        }
        msg += `  *NET OWNER PAYOUT (est): ${fmt(e.ownerNet)}* — confirm bills before paying\n\n`;
      });
    }

    if (skippedPrepaid.length > 0) {
      msg += `*⏭️ SKIPPED — CURRENT/PREPAID (${skippedPrepaid.length})*\n`;
      skippedPrepaid.forEach(s => { msg += `  • ${s}\n`; });
    }

    if (readyToPay.length === 0 && holdBills.length === 0) {
      msg += '_No past-due payments settled yesterday._\n';
    }

    // 7. Send DM to Randi
    if (SLACK_TOKEN) {
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'U066CCVN0HJ', text: msg })
      });
      console.log('Settlement alert: Slack DM sent');
    }

  } catch(e) {
    console.error('Settlement alert error:', e.message);
  }
}

function scheduleSettlementAlert() {
  function msUntilNext7am() {
    const now = new Date();
    const az = new Date(now.toLocaleString('en-US', { timeZone: 'America/Phoenix' }));
    const next = new Date(az);
    next.setHours(7, 0, 0, 0);
    if (az >= next) next.setDate(next.getDate() + 1);
    return next - az;
  }
  setTimeout(function tick() {
    runLatePaymentSettlementAlert().catch(e => console.error('Settlement alert nightly error:', e.message));
    setTimeout(tick, 24 * 60 * 60 * 1000);
  }, msUntilNext7am());
  console.log('Settlement alert: scheduled daily at 7am AZ time');
}
scheduleSettlementAlert();

// Add a manual trigger endpoint for testing
app.get('/api/settlement-alert/test', async (req, res) => {
  try {
    await runLatePaymentSettlementAlert();
    res.json({ ok: true, message: 'Settlement alert ran — check your Slack DM' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── End Late Payment Settlement Alert ──────────────────────────────────────
// ── Daily Bill Sync ────────────────────────────────────────────────────────────────────────────

async function runDailyBillSync(overrideStartDate) {
  try {
    console.log('Bill sync: starting daily run');
    const azNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Phoenix' }));
    const todayStr = azNow.toISOString().slice(0, 10);
    const yesterday = new Date(azNow);
    yesterday.setDate(yesterday.getDate() - 1);
    const startDate = overrideStartDate || yesterday.toISOString().slice(0, 10);
    const endDate = overrideStartDate ? todayStr : todayStr;

    if (!SHEET_ID) return;
    const sheets = getSheetsClient();
    await ensureSheetTab(sheets);

    // Get existing bill IDs from sheet (col M = index 12)
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "'" + SHEET_TAB + "'!M:M",
    });
    const existingIDs = new Set((existing.data.values || []).flat().filter(Boolean).map(String));
    console.log('Bill sync:', existingIDs.size, 'existing bill IDs in sheet');

    // Fetch payables report — returns all fields in one call
    const reportResp = await fetch(RENTVINE_BASE + '/reports/payables?exportTypeID=1', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + RENTVINE_AUTH,
        'X-Rentvine-Account': RENTVINE_ACCOUNT,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filters: [
          { name: 'payeeContactID', comparator: 'equals', value: String(CONTACT_REIMBURSEMENTS) },
          { name: 'dateTimeCreated', comparator: 'betweenDate', startDate: startDate, endDate: endDate }
        ]
      })
    });
    const reportData = await reportResp.json();
    const allRows = (reportData.rows || []).filter(r => r && r.data);
    // Filter client-side by dateTimeCreated since report date filters are unreliable
    const rows = allRows.filter(r => {
      const dtc = (r.data.dateTimeCreated || '').slice(0, 10);
      return dtc >= startDate;
    });
    console.log('Bill sync: payables report returned', allRows.length, 'total,', rows.length, 'after dateTimeCreated filter (>=', startDate + ')');

    const now = new Date().toISOString();
    const rowsToAdd = [];

    for (const row of rows) {
      const d = row.data;
      const billID = String(d.billID || '');
      if (!billID) continue;
      if (d.isVoided === '1' || d.isVoided === 1) continue;
      if (existingIDs.has(billID)) continue;

      const address = [d.propertyAddress, d.propertyCity, d.propertyStateID]
        .filter(Boolean).filter(v => v !== 'None').join(', ');
      const owner = (d.portfolioName && d.portfolioName !== 'None') ? d.portfolioName : '';
      const expenseType = (d.chargeAccountName && d.chargeAccountName !== 'None') ? d.chargeAccountName : '';
      const description = (d.description && d.description !== 'None') ? d.description : '';
      const reference = (d.reference && d.reference !== 'None') ? d.reference : '';
      const amount = Number(d.amount || 0).toFixed(2);
      const billDate = (d.datePosted || '').slice(0, 10);

      if (!amount || amount === '0.00') {
        console.warn('Bill sync: skipping bill', billID, '- amount is 0');
        continue;
      }

      rowsToAdd.push([
        now,               // A: Date Submitted
        billDate,          // B: Date Paid
        'Rentvine (auto)', // C: Paid By
        '',                // D: Payment Method
        address,           // E: Property Address
        owner,             // F: Owner / Portfolio
        expenseType,       // G: Expense Type
        description,       // H: Repair Type / Vendor Detail
        amount,            // I: Amount
        expenseType,       // J: GL Account
        reference,         // K: Reference / Memo
        '',                // L: Notes
        billID,            // M: Rentvine Bill ID
        '',                // N: Admin Bill ID
        now,               // O: Bill Created At
        'Auto-synced',     // P: Status
      ]);
      existingIDs.add(billID);
    }

    console.log('Bill sync:', rowsToAdd.length, 'rows to add');

    if (rowsToAdd.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: "'" + SHEET_TAB + "'!A1",
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: rowsToAdd },
      });
    }

    console.log('Bill sync: done. Added', rowsToAdd.length, 'rows');

    // Slack summary
    if (SLACK_WEBHOOK && rowsToAdd.length > 0) {
      const total = rowsToAdd.reduce(function(s, r) { return s + parseFloat(r[8] || 0); }, 0);
      const fmt = function(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 }); };
      const msg = '*Bills Synced — ' + todayStr + '*\n' + rowsToAdd.length + ' rows added to expense sheet. Total: ' + fmt(total);
      await fetch(SLACK_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: msg }),
      });
    }
  } catch(e) { console.error('Bill sync error:', e.message); }
}

function scheduleDailyBillSync() {
  function msUntilNext8am() {
    const now = new Date();
    const az = new Date(now.toLocaleString('en-US', { timeZone: 'America/Phoenix' }));
    const next = new Date(az);
    next.setHours(8, 0, 0, 0);
    if (az >= next) next.setDate(next.getDate() + 1);
    return next - az;
  }
  setTimeout(function tick() {
    runDailyBillSync().catch(e => console.error('Bill sync daily error:', e.message));
    setTimeout(tick, 24 * 60 * 60 * 1000);
  }, msUntilNext8am());
  console.log('Bill sync: scheduled daily at 8am AZ time');
}
scheduleDailyBillSync();

app.get('/api/bill-sync/full', async (req, res) => {
  try {
    await runDailyBillSync('2026-06-01');
    res.json({ ok: true, message: 'Full sync from June 1 ran — check sheet' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bill-sync/test', async (req, res) => {
  try {
    await runDailyBillSync();
    res.json({ ok: true, message: 'Bill sync ran — check sheet' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── End Daily Bill Sync ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function scheduleWOSync() {
  function msUntilNext11pm() {
    const now = new Date();
    const az = new Date(now.toLocaleString('en-US', { timeZone: 'America/Phoenix' }));
    const next = new Date(az); next.setHours(23, 0, 0, 0);
    if (az >= next) next.setDate(next.getDate() + 1);
    return next - az;
  }
  setTimeout(function tick() {
    runWOSync(false).catch(e => console.error('WO Sync nightly error:', e.message));
    runBillSync().catch(e => console.error('Bill sync nightly error:', e.message));
    setTimeout(tick, 24 * 60 * 60 * 1000);
  }, msUntilNext11pm());
  console.log('WO Sync: scheduled nightly at 11pm AZ time');
}
scheduleWOSync();
// ── End WO Sync ──
// ── End WO Sync ──
app.get('/api/test-slack', async (req, res) => {
  try {
    const r = await fetch('https://hooks.slack.com/services/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', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Test from Aloe server — webhook working!' })
    });
    const text = await r.text();
    res.json({ status: r.status, response: text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ── Bill-to-WO Matcher ──
async function findBillMatchedWOs() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let openWOs = [], wpg = 1;
  while (wpg <= 10) {
    const data = await rvFetch('/maintenance/work-orders', { pageSize: 100, page: wpg });
    const batch = Array.isArray(data) ? data : (data && data.data) || [];
    if (!batch.length) break;
    batch.forEach(rec => {
      const wo = rec.workOrder || rec;
      if (!wo.workOrderID) return;
      const sid = parseInt(wo.primaryWorkOrderStatusID || 0);
      const isClosed = sid === 3 || sid === 5 || !!wo.closedDate || !!wo.dateClosed;
      if (!isClosed) {
        wo._unitAddress = (rec.unit && (rec.unit.address || rec.unit.name)) || (rec.property && rec.property.address) || '';
        openWOs.push(wo);
      }
    });
    if (batch.length < 100) break;
    wpg++;
  }
  const uniqueVendorIDs = [...new Set(openWOs.map(wo => String(wo.vendorContactID || '')).filter(Boolean))];
  let allBills = [];
  for (const vendorID of uniqueVendorIDs) {
    let pg = 1;
    while (pg <= 3) {
      const data = await rvFetch('/accounting/bills', { pageSize: 100, page: pg, contactID: vendorID, startDate: cutoff });
      const batch = Array.isArray(data) ? data : (data && data.data) || [];
      if (!batch.length) break;
      allBills = allBills.concat(batch);
      if (batch.length < 100) break;
      pg++;
    }
  }
  // Build address lookup from units export
  const addrMap = {};
  try {
    let unitsData = [], upg = 1;
    while (upg <= 5) {
      const batch = await rvFetch('/properties/units/export', { pageSize: 200, page: upg });
      if (!Array.isArray(batch) || !batch.length) break;
      unitsData = unitsData.concat(batch);
      if (batch.length < 200) break;
      upg++;
    }
    if (unitsData.length) {
      unitsData.forEach(item => {
        const u = item.unit || item;
        const p = item.property || {};
        if (u.unitID) addrMap[String(u.unitID)] = u.address || p.address || '';
      });
    }
  } catch(e) { console.error('Bill sync addr lookup error:', e.message); }
  openWOs.forEach(wo => { if (wo.unitID && addrMap[String(wo.unitID)]) wo._unitAddress = addrMap[String(wo.unitID)]; });
  console.log('Bill sync: ' + openWOs.length + ' open WOs, ' + allBills.length + ' bills fetched, ' + Object.keys(addrMap).length + ' addresses loaded');

  const openWOMap = {};
  openWOs.forEach(wo => { openWOMap[String(wo.workOrderID)] = wo; });
  const openWOsByVendorProp = {};
  openWOs.forEach(wo => {
    const key = String(wo.vendorContactID || '') + '_' + String(wo.propertyID || '');
    if (key !== '_') { if (!openWOsByVendorProp[key]) openWOsByVendorProp[key] = []; openWOsByVendorProp[key].push(wo); }
  });

  const REIMBURSE_CONTACT_ID = '3229'; // Aloe Property Management - REIMBURSEMENTS
  const TRADE_KEYWORDS = {
    plumb: /plumb|toilet|faucet|pipe|drain|leak|water/i,
    hvac: /hvac|ac |a\/c|air.?cond|heat|furnace|cool/i,
    electric: /electric|outlet|breaker|wiring|panel/i,
    locksmith: /rekey|lock|key|deadbolt/i,
    appliance: /appliance|dishwash|washer|dryer|refriger|oven|stove/i,
    landscaping: /landscap|lawn|tree|yard|weed|grass/i,
    pest: /pest|scorpion|roach|termite|bee|ant/i,
    paint: /paint|drywall|patch|wall/i,
    clean: /clean|trash|junk|debris/i,
  };

  function descriptionCategory(text) {
    const t = (text || '').toLowerCase();
    for (const [cat, re] of Object.entries(TRADE_KEYWORDS)) { if (re.test(t)) return cat; }
    return null;
  }

  const matched = [];
  allBills.forEach(function(billRec) {
    const bill = billRec.bill || billRec;
    const billDate = (bill.billDate || bill.date || '').slice(0, 10);
    const vendorName = (billRec.contact && billRec.contact.name) || '';
    const charges = billRec.charges || [];
    const chargeDesc = charges.map(c => c.description || '').join(' ');

    // Tier 1: direct workOrderID match
    const woID = String(bill.workOrderID || '');
    if (woID && woID !== 'null' && woID !== '0') {
      const wo = openWOMap[woID];
      if (wo) {
        const amt = bill.totalAmount ? ('$' + parseFloat(bill.totalAmount).toFixed(2)) : '';
        matched.push({ woNumber: wo.workOrderNumber, rvWorkOrderId: wo.workOrderID, address: wo._unitAddress || '', vendorName, billAmount: amt, billDate, matchType: 'Direct WO link', billId: bill.billID });
        return;
      }
    }

    // Tier 2: fuzzy vendor + property match
    const vendorID = String(bill.payeeContactID || '');
    const propID = String(bill.propertyID || '');
    if (vendorID && propID && propID !== 'null') {
      const key = vendorID + '_' + propID;
      const candidates = openWOsByVendorProp[key] || [];
      candidates.forEach(wo => {
        matched.push({ woNumber: wo.workOrderNumber, rvWorkOrderId: wo.workOrderID, address: wo._unitAddress || '', vendorName, billAmount: '', billDate, matchType: 'Vendor + property match', billId: bill.billID, billUrl: 'https://aloepm.rentvine.com/accounting/payables/bills/' + bill.billID });
      });
      if (candidates.length > 0) return;
    }

    // Tier 3: reimbursement match by property + description keywords
    if (vendorID === REIMBURSE_CONTACT_ID && propID && propID !== 'null') {
      const billCat = descriptionCategory(chargeDesc + ' ' + (bill.description || ''));
      if (!billCat) return;
      const propWOs = openWOs.filter(wo => String(wo.propertyID || '') === propID);
      propWOs.forEach(wo => {
        const woCat = descriptionCategory(wo.description || '');
        if (woCat === billCat) {
          matched.push({ woNumber: wo.workOrderNumber, rvWorkOrderId: wo.workOrderID, address: wo._unitAddress || '', vendorName: 'Aloe Reimbursement', billAmount: '', billDate, matchType: 'Reimbursement (' + billCat + ')', billId: bill.billID, billUrl: 'https://aloepm.rentvine.com/accounting/payables/bills/' + bill.billID });
        }
      });
    }
  });

  const seen = new Set();
  return matched.filter(r => { if (seen.has(r.woNumber)) return false; seen.add(r.woNumber); return true; });
}

app.get('/api/bill-debug', async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const data = await rvFetch('/accounting/bills', { pageSize: 10, page: 1, startDate: cutoff });
    res.json({ cutoff, count: Array.isArray(data) ? data.length : 0, sample: Array.isArray(data) ? data.slice(0,3).map(b => ({ billID: b.bill&&b.bill.billID, workOrderID: b.bill&&b.bill.workOrderID, payeeContactID: b.bill&&b.bill.payeeContactID, propertyID: b.bill&&b.bill.propertyID, billDate: b.bill&&b.bill.billDate, totalAmount: b.bill&&b.bill.totalAmount })) : data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bill-matched-wos', async (req, res) => {
  try { res.json({ total: 0, items: await findBillMatchedWOs() }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

async function runBillSync() {
  try {
    const matched = await findBillMatchedWOs();
    if (!SLACK_TOKEN || matched.length === 0) return;
    const lines = matched.map(r => '• <https://aloepm.rentvine.com/maintenance/work-orders/' + r.rvWorkOrderId + '|WO #' + r.woNumber + '> — ' + r.address + ' — ' + r.vendorName + ' — Bill: ' + r.billAmount + ' (' + r.billDate + ')').join('\n');
    const slackText = '*🧾 Invoice → WO Match — ' + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '*\n*' + matched.length + ' open WO(s) have invoices — likely complete, please close:*\n' + lines + '\n\n_Matched by vendor + property · Runs nightly 11pm AZ_';
    await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'C06BWVACZQF', text: slackText }) });
    console.log('Bill sync: Slack alert sent for ' + matched.length + ' WOs');
    // Get unique vendor IDs from open WOs, then fetch only their bills
  const uniqueVendorIDs = [...new Set(openWOs.map(wo => String(wo.vendorContactID || '')).filter(Boolean))];
  console.log('Bill sync: fetching bills for ' + uniqueVendorIDs.length + ' vendors');

  let allBills = [];
  for (const vendorID of uniqueVendorIDs) {
    let pg = 1;
    while (pg <= 3) {
      const data = await rvFetch('/accounting/bills', { pageSize: 100, page: pg, contactID: vendorID, startDate: cutoff });
      const batch = Array.isArray(data) ? data : (data && data.data) || [];
      if (!batch.length) break;
      allBills = allBills.concat(batch);
      if (batch.length < 100) break;
      pg++;
    }
  }
  console.log('Bill sync: fetched ' + allBills.length + ' bills across ' + uniqueVendorIDs.length + ' vendors');
  } catch(e) { console.error('Bill sync error:', e.message); }
}
// ── End Bill-to-WO Matcher ──

// ── WO Analytics: 12-month trends ──
app.get('/api/wo-analytics', async (req, res) => {
  try {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 12);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    let allWOs = [], pg = 1;
    while (pg <= 40) {
      const data = await rvFetch('/maintenance/work-orders', { pageSize: 100, page: pg });
      const batch = Array.isArray(data) ? data : (data && data.data) || [];
      if (!batch.length) break;
      let hitCutoff = false;
      batch.forEach(rec => {
        const wo = rec.workOrder || rec;
        if (!wo.workOrderID) return;
        const created = (wo.dateTimeCreated || '').slice(0, 10);
        if (created >= cutoffStr) {
          wo._unitAddress = (rec.unit && (rec.unit.address || rec.unit.name)) || (rec.property && rec.property.address) || '';
          wo._description = wo.description || '';
          allWOs.push(wo);
        } else {
          hitCutoff = true;
        }
      });
      if (hitCutoff && batch.length < 100) break;
      if (batch.length < 100) break;
      pg++;
    }

    // Category guesser
    function guessCategory(text) {
      const t = (text || '').replace(/<[^>]+>/g, ' ').toLowerCase();
      if (/hvac|ac |air.?cond|heat|furnace|cooling/.test(t)) return 'HVAC';
      if (/plumb|leak|drain|toilet|faucet|pipe|water/.test(t)) return 'Plumbing';
      if (/electric|outlet|breaker|wiring|panel|light/.test(t)) return 'Electrical';
      if (/pest|scorpion|roach|termite|bee|ant/.test(t)) return 'Pest Control';
      if (/appliance|dishwash|washer|dryer|refriger|oven|stove/.test(t)) return 'Appliance';
      if (/paint|drywall|patch|wall/.test(t)) return 'Paint / Drywall';
      if (/lawn|landscap|tree|weed|yard|grass/.test(t)) return 'Landscaping';
      if (/clean|trash|junk|debris/.test(t)) return 'Cleaning';
      if (/lock|key|door|window|garage/.test(t)) return 'Lock / Door / Window';
      if (/roof|gutter|exterior|stucco/.test(t)) return 'Roof / Exterior';
      return 'Other';
    }

    function monthKey(dateStr) {
      if (!dateStr) return null;
      return dateStr.slice(0, 7);
    }
    function weekKey(dateStr) {
      if (!dateStr) return null;
      const d = new Date(dateStr);
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const mon = new Date(d.setDate(diff));
      return mon.toISOString().slice(0, 10);
    }

    // Build monthly and weekly buckets
    const openedByMonth = {}, closedByMonth = {};
    const openedByWeek = {}, closedByWeek = {};
    const categoryByMonth = {};
    const closeTimes = [];
    const categoryCloseTimes = {};

    allWOs.forEach(wo => {
      const created = (wo.dateTimeCreated || '').slice(0, 10);
      const closed = wo.dateClosed ? wo.dateClosed.slice(0, 10) : null;
      const mk = monthKey(created);
      const wk = weekKey(created);
      const cat = guessCategory(wo._description);

      if (mk) {
        openedByMonth[mk] = (openedByMonth[mk] || 0) + 1;
        if (!categoryByMonth[mk]) categoryByMonth[mk] = {};
        categoryByMonth[mk][cat] = (categoryByMonth[mk][cat] || 0) + 1;
      }
      if (wk) openedByWeek[wk] = (openedByWeek[wk] || 0) + 1;

      if (closed) {
        const cmk = monthKey(closed);
        const cwk = weekKey(closed);
        if (cmk) closedByMonth[cmk] = (closedByMonth[cmk] || 0) + 1;
        if (cwk) closedByWeek[cwk] = (closedByWeek[cwk] || 0) + 1;

        // Avg close time
        const openDate = new Date(created);
        const closeDate = new Date(closed);
        const days = Math.round((closeDate - openDate) / 86400000);
        if (days >= 0 && days < 365) {
          closeTimes.push({ days, cat });
          if (!categoryCloseTimes[cat]) categoryCloseTimes[cat] = [];
          categoryCloseTimes[cat].push(days);
        }
      }
    });

    // Build sorted month list for last 12 months
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      months.push(d.toISOString().slice(0, 7));
    }

    // Seasonal category breakdown (by month across all data)
    const allCategories = ['HVAC','Plumbing','Electrical','Pest Control','Appliance','Paint / Drywall','Landscaping','Cleaning','Lock / Door / Window','Roof / Exterior','Other'];
    const categoryTrends = {};
    allCategories.forEach(cat => {
      categoryTrends[cat] = months.map(m => (categoryByMonth[m] && categoryByMonth[m][cat]) || 0);
    });

    // Avg close times by category
    const avgCloseByCategory = {};
    Object.entries(categoryCloseTimes).forEach(([cat, times]) => {
      const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
      avgCloseByCategory[cat] = { avg, count: times.length };
    });

    // Overall avg close time
    const allTimes = closeTimes.map(x => x.days);
    const avgCloseTime = allTimes.length ? Math.round(allTimes.reduce((a, b) => a + b, 0) / allTimes.length) : null;

    // Weekly data for last 12 weeks
    const weeks = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - (i * 7));
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const mon = new Date(d.setDate(diff));
      weeks.push(mon.toISOString().slice(0, 10));
    }

    // AI suggestions based on trends
    const suggestions = [];
    const currentMonth = new Date().getMonth(); // 0-indexed
    // HVAC seasonal check
    const hvacThisMonth = months.map((m, i) => ({ m, v: (categoryByMonth[m] && categoryByMonth[m]['HVAC']) || 0 }));
    const hvacRecent = hvacThisMonth.slice(-2).reduce((a, b) => a + b.v, 0);
    const hvacPrevYear = hvacThisMonth.slice(0, 3).reduce((a, b) => a + b.v, 0);
    if (currentMonth >= 4 && currentMonth <= 8 && hvacRecent > 3) {
      suggestions.push({ type: 'warning', category: 'HVAC', message: 'HVAC work orders are elevated this month (' + hvacRecent + ' in last 2 months). Consider proactive AC filter checks and preventive maintenance before peak summer heat.' });
    }
    // Backlog check
    const recentOpened = months.slice(-3).reduce((a, m) => a + (openedByMonth[m] || 0), 0);
    const recentClosed = months.slice(-3).reduce((a, m) => a + (closedByMonth[m] || 0), 0);
    const backlogTrend = recentOpened - recentClosed;
    if (backlogTrend > 10) {
      suggestions.push({ type: 'warning', category: 'Backlog', message: 'Work order backlog is growing — ' + recentOpened + ' opened vs ' + recentClosed + ' closed in last 3 months (' + backlogTrend + ' net increase). Consider adding vendor capacity.' });
    } else if (backlogTrend < -5) {
      suggestions.push({ type: 'success', category: 'Backlog', message: 'Great progress — more WOs closed than opened in last 3 months (' + Math.abs(backlogTrend) + ' net decrease in backlog).' });
    }
    // Slow close time
    if (avgCloseTime && avgCloseTime > 14) {
      suggestions.push({ type: 'warning', category: 'Response Time', message: 'Average close time is ' + avgCloseTime + ' days. Target is under 14 days. Review vendor performance and follow-up processes.' });
    }
    // Category spike vs last year same month
    const prevYearMonth = months[0]; // 12 months ago
    const currMonth = months[11];
    if (categoryByMonth[prevYearMonth] && categoryByMonth[currMonth]) {
      allCategories.forEach(cat => {
        const prev = categoryByMonth[prevYearMonth][cat] || 0;
        const curr = categoryByMonth[currMonth][cat] || 0;
        if (prev > 0 && curr > prev * 1.5 && curr > 3) {
          suggestions.push({ type: 'info', category: cat, message: cat + ' WOs are up ' + Math.round(((curr - prev) / prev) * 100) + '% vs same month last year (' + curr + ' this month vs ' + prev + ' last year). Watch for recurring pattern.' });
        }
      });
    }

    // Daily closed for last 4 weeks (Mon-Sun)
    function getWeekStart(d) {
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const mon = new Date(d); mon.setDate(diff); mon.setHours(0,0,0,0);
      return mon;
    }
    const today = new Date();
    const weeklyDays = [];
    for (let w = 3; w >= 0; w--) {
      const weekStart = getWeekStart(new Date(today - w * 7 * 86400000));
      const days = [];
      for (let d = 0; d < 7; d++) {
        const day = new Date(weekStart); day.setDate(weekStart.getDate() + d);
        const dayStr = day.toISOString().slice(0, 10);
        days.push(dayStr);
      }
      weeklyDays.push(days);
    }
    const closedByDay = {};
    const openedByDay = {};
    allWOs.forEach(wo => {
      const closed = wo.dateClosed ? wo.dateClosed.slice(0, 10) : null;
      const created = (wo.dateTimeCreated || '').slice(0, 10);
      if (closed) closedByDay[closed] = (closedByDay[closed] || 0) + 1;
      if (created) openedByDay[created] = (openedByDay[created] || 0) + 1;
    });
    const weeklyStats = weeklyDays.map(function(days) {
      const weekStart = days[0];
      return {
        weekStart,
        days: days.map(function(d) {
          return { date: d, closed: closedByDay[d] || 0, opened: openedByDay[d] || 0 };
        }),
        totalClosed: days.reduce(function(a, d) { return a + (closedByDay[d] || 0); }, 0),
        totalOpened: days.reduce(function(a, d) { return a + (openedByDay[d] || 0); }, 0)
      };
    });

    res.json({
      totalWOs: allWOs.length,
      avgCloseTime,
      months,
      weeks,
      openedByMonth: months.map(m => openedByMonth[m] || 0),
      closedByMonth: months.map(m => closedByMonth[m] || 0),
      openedByWeek: weeks.map(w => openedByWeek[w] || 0),
      closedByWeek: weeks.map(w => closedByWeek[w] || 0),
      categoryTrends,
      avgCloseByCategory,
      suggestions,
      weeklyStats
    });
  } catch(e) {
    console.error('WO analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
// ── End WO Analytics ──



// ── RV Work Order Webhook → Files Tab + Aptly Photo Sync ──
const PHOTO_SYNC_UPLOADED = {};

// Build a multipart body buffer (helper used in multiple upload calls)
function buildMultipart(boundary, fieldName, fileName, mimeType, dataBuffer) {
  const header = Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="' + fieldName + '"; filename="' + fileName + '"\r\n' +
    'Content-Type: ' + mimeType + '\r\n\r\n'
  );
  const footer = Buffer.from('\r\n--' + boundary + '--\r\n');
  return Buffer.concat([header, dataBuffer, footer]);
}

// Upload a buffer to Rentvine Files tab for a given objectType + objectID
// POST /api/manager/files  (proven working — returns 200 + file record)
async function uploadToRVFiles(fileName, mimeType, imgBuffer, objectTypeID, objectID) {
  // Proven working: POST /api/manager/files with Basic auth (file-specific key/secret)
  // objectTypeID=16 (WorkOrder), objectID=workOrderID
  const RV_FILE_KEY    = process.env.RENTVINE_FILE_KEY    || '2586bdded08f499bb2057e373fd662f7';
  const RV_FILE_SECRET = process.env.RENTVINE_FILE_SECRET || '81f3aa4cb0434162aab8a27702f089b8';
  const RV_FILE_AUTH   = Buffer.from(RV_FILE_KEY + ':' + RV_FILE_SECRET).toString('base64');

  const boundary = '----AloePMFileBoundary' + Date.now();
  const body = buildMultipart(boundary, 'file', fileName, mimeType, imgBuffer);
  // Pass objectTypeID + objectID as query params (cleaner than form fields)
  const url = RENTVINE_BASE + '/files?objectTypeID=' + objectTypeID + '&objectID=' + objectID;

  const upResp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + RV_FILE_AUTH,
      'X-Rentvine-Account': RENTVINE_ACCOUNT,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': String(body.length)
    },
    body
  });
  return { ok: upResp.ok, status: upResp.status, text: (await upResp.text()).slice(0, 300) };
}
// ── EXPENSE LOG ───────────────────────────────────────────────────────────────

import { google } from 'googleapis';

const CONTACT_REIMBURSEMENTS  = 3229;
const CONTACT_MGMT_COMPANY    = 1;
const GL_OWNER_ADMIN_FEE      = 136;
const ADMIN_TRADE_FEE_AMOUNT  = 10.00;
const ADMIN_CHECK_FEE_AMOUNT   = 5.00;
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;
const SHEET_ID      = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const SHEET_TAB     = 'Expense Log';

const GL_MAP = {
  hoa_reg:     80,
  trade_fee:   86,
  hw_vendor:   86,
  vendor_call: 108,
  cleaning:    82,
  key_lock:    106,
  pest:        77,
  other:       108,
};

function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

const SHEET_HEADERS = [
  'Date Submitted', 'Date Paid', 'Paid By', 'Payment Method',
  'Property Address', 'Owner / Portfolio',
  'Expense Type', 'Repair Type / Vendor Detail',
  'Amount', 'GL Account', 'Reference / Memo',
  'Notes', 'Rentvine Bill ID', 'Admin Bill ID ($10)',
  'Bill Created At', 'Status',
];

async function ensureSheetTab(sheets) {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const tabs = meta.data.sheets.map(s => s.properties.title);
    if (!tabs.includes(SHEET_TAB)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        resource: { requests: [{ addSheet: { properties: { title: SHEET_TAB } } }] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `'${SHEET_TAB}'!A1`,
        valueInputOption: 'RAW',
        resource: { values: [SHEET_HEADERS] },
      });
    }
  } catch (e) {
    console.error('[expense-log] Sheet setup error:', e.message);
  }
}

async function appendSheetRow(sheets, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_TAB}'!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    resource: { values: [row] },
  });
}

async function getPropertyLedgerID(propertyID, address) {
  if (!address) return null;
  try {
    const street = address.split(',')[0].trim();
    const r = await fetch(
      `${RENTVINE_BASE}/accounting/ledgers?search=${encodeURIComponent(street)}&pageSize=5`,
      { headers: RV_HEADERS }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const ledgers = Array.isArray(data) ? data : (data?.data ?? data?.ledgers ?? []);
    const ledger = ledgers[0]?.ledger || ledgers[0];
    return ledger?.ledgerID || ledger?.id || null;
  } catch (e) {
    console.warn('[expense-log] Property ledger lookup failed:', e.message);
    return null;
  }
}

const RV_HEADERS = {
  Authorization: `Basic ${RENTVINE_AUTH}`,
  'X-Rentvine-Account': RENTVINE_ACCOUNT,
  'Content-Type': 'application/json',
};

function buildBillPayload({ contactID, payDate, reference, lineDescription, ledgerID, glAccountID, amount }) {
  return {
    payeeContactID:      String(contactID),
    billDate:            payDate,
    dateDue:             payDate,
    reference:           reference,
    paymentMemo:         reference,
    description:         lineDescription,
    charges: [{
      ...(ledgerID ? { ledgerID: String(ledgerID) } : {}),
      description:       lineDescription,
      chargeAccountID:   String(glAccountID),
      amount:            String(Number(amount).toFixed(2)),
      salesTaxAmount:    '0.00',
      leaseID:           null,
    }],
    leaseCharges:        [],
    overrideBankAccount: false,
  };
}

async function postBill(payload) {
  const r = await fetch(`${RENTVINE_BASE}/accounting/bills`, {
    method:  'POST',
    headers: RV_HEADERS,
    body:    JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.message || data?.error || `Rentvine API ${r.status}`);
  return data;
}

async function postSlack(msg) {
  if (!SLACK_WEBHOOK) return;
  await fetch(SLACK_WEBHOOK, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ text: msg }),
  }).catch(e => console.error('[expense-log] Slack error:', e.message));
}

function buildSlackMessage({ who, property, expType, repairType, vendorName, amount, payDate, reference, notes, billID, adminBillID }) {
  const fmt = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 });
  const isTradeFee = expType.type === 'trade_fee';
  const lines = [
    `💳 *New Expense Logged — Bill${isTradeFee ? 's' : ''} Created in Rentvine*`,
    `*Paid by:* ${who}  |  *Date:* ${payDate}  |  *Amount:* ${fmt(amount)}`,
    `*Type:* ${expType.label}${repairType ? ` — ${repairType}` : ''}${vendorName ? ` (${vendorName})` : ''}`,
    `*Property:* ${property.address}`,
    property.portfolioName ? `*Owner:* ${property.portfolioName}` : '',
    reference ? `*Reference:* ${reference}` : '',
    notes ? `*Notes:* ${notes}` : '',
    ``,
    `✅ *Bill 1 created:* ${fmt(amount)} → Aloe PM Reimbursements  |  Bill ID: ${billID}`,
  ];
  if (isTradeFee && adminBillID) {
    lines.push(`✅ *Bill 2 created:* ${fmt(ADMIN_TRADE_FEE_AMOUNT)} → Aloe PM (Owner Admin Fee)  |  Bill ID: ${adminBillID}`);
  }
  return lines.filter(Boolean).join('\n');
}

app.post('/api/expense-log', async (req, res) => {
  const { property, expType, amount, payDate, reference, notes, vendorName, repairType, who, payMethod } = req.body;
  if (!property || !expType || !amount || !who || !payDate) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const isTradeFee = expType.type === 'trade_fee';
  const glAccountID = GL_MAP[expType.type] || 108;
  const now = new Date().toISOString();
  const refString = isTradeFee && repairType ? `Home Warranty Trade Fee — ${repairType}` : (reference || expType.label);
  const lineDesc = [expType.label, vendorName ? `— ${vendorName}` : '', property.address, property.portfolioName ? `(${property.portfolioName})` : ''].filter(Boolean).join(' ');

  try {
    const ledgerID = await getPropertyLedgerID(property.propertyID, property.address);

    const bill1 = await postBill(buildBillPayload({
      contactID: CONTACT_REIMBURSEMENTS, payDate, reference: refString,
      lineDescription: lineDesc, ledgerID, glAccountID, amount,
    }));
    const billID = bill1?.bill?.billID || bill1?.billID || bill1?.id || '';

    let adminBillID = null;
    if (isTradeFee) {
      const bill2 = await postBill(buildBillPayload({
        contactID: CONTACT_MGMT_COMPANY, payDate,
        reference: `Home Warranty Trade Fee — ${repairType || 'Trade Fee'}`,
        lineDescription: ['Home Warranty Trade Fee', repairType ? `— ${repairType}` : '', property.address, property.portfolioName ? `(${property.portfolioName})` : ''].filter(Boolean).join(' '),
        ledgerID, glAccountID: GL_OWNER_ADMIN_FEE, amount: ADMIN_TRADE_FEE_AMOUNT,
      }));
      adminBillID = bill2?.bill?.billID || bill2?.billID || bill2?.id || '';
    }

    // $5 admin fee + Slack check notification for Check payments
    let checkFeeID = null;
    if (payMethod === "Check") {
      try {
        const billCheck = await postBill(buildBillPayload({
          contactID: CONTACT_MGMT_COMPANY, payDate,
          reference: 'Check Processing Fee - ' + expType.label,
          lineDescription: 'Check Processing Fee - ' + expType.label + ' ' + property.address + (property.portfolioName ? ' (' + property.portfolioName + ')' : ''),
          ledgerID, glAccountID: GL_OWNER_ADMIN_FEE, amount: ADMIN_CHECK_FEE_AMOUNT,
        }));
        checkFeeID = billCheck?.bill?.billID || billCheck?.billID || billCheck?.id || '';
        console.log('[expense-log] Check fee bill created:', checkFeeID);
      } catch(e) { console.error("[expense-log] Check fee bill error:", e.message); }
      // Post check instructions to Slack
      const checkMsg = [
        "@Rita please write a check from operating:",
        "*Amount:* $" + Number(amount).toFixed(2),
        "*Pay to:* " + (vendorName || expType.label),
        "*Property:* " + property.address + (property.portfolioName ? " (" + property.portfolioName + ")" : ""),
        refString ? "*Reference:* " + refString : null,
        notes ? "*Notes / Mail to:* " + notes : null,
        "*Logged by:* " + who,
      ].filter(Boolean).join("\n");
      await postSlack(checkMsg);
    }


    if (SHEET_ID) {
      try {
        const sheets = getSheetsClient();
        await ensureSheetTab(sheets);
        const glNames = {80:'HOA Dues',86:'Home Warranty Trade Fee',82:'Cleaning Reimbursement',106:'Key/Lock Replacement',77:'Pest Control',108:'Repairs - Other',136:'Owner Administrative Charge'};
        await appendSheetRow(sheets, [
          now, payDate, who, payMethod || '', property.address, property.portfolioName || '',
          expType.label, repairType || vendorName || '',
          Number(amount).toFixed(2), glNames[glAccountID] || String(glAccountID),
          refString, notes || '', String(billID), adminBillID ? String(adminBillID) : '',
          now, 'Created',
        ]);
      } catch (sheetErr) {
        console.error('[expense-log] Sheet write failed:', sheetErr.message);
      }
    }

    await postSlack(buildSlackMessage({ who, property, expType, repairType, vendorName, amount, payDate, reference: refString, notes, billID, adminBillID }));

    return res.json({ success: true, billID, adminBillID, message: isTradeFee ? 'Two bills created successfully' : 'Bill created successfully' });
  } catch (e) {
    console.error('[expense-log] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── End Expense Log ───────────────────────────────────────────────────────────

// ── EXPENSE LOG: Upload receipt to Rentvine bill ─────────────────────────────
// ── EXPENSE LOG: Backfill existing RV bills to Google Sheet ─────────────────
app.post('/api/expense-log/write-rows', async (req, res) => {
  if (!SHEET_ID) return res.status(400).json({ error: 'No sheet ID' });
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows provided' });
    const sheets = getSheetsClient();
    await ensureSheetTab(sheets);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "'" + SHEET_TAB + "'!A1",
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: rows },
    });
    res.json({ success: true, written: rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/expense-log/fix-header', async (req, res) => {
  if (!SHEET_ID) return res.status(400).json({ error: 'No sheet ID' });
  try {
    const sheets = getSheetsClient();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "'" + SHEET_TAB + "'!A1",
      valueInputOption: 'RAW',
      resource: { values: [SHEET_HEADERS] },
    });
    res.json({ success: true, headers: SHEET_HEADERS });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/expense-log/reset-sheet', async (req, res) => {
  if (!SHEET_ID) return res.status(400).json({ error: 'No sheet ID' });
  try {
    const sheets = getSheetsClient();
    await ensureSheetTab(sheets);
    // Keep only header row
    const data = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_TAB}'!A1:O1`,
    });
    const header = data.data.values || [];
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_TAB}'!A:O`,
    });
    if (header.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `'${SHEET_TAB}'!A1`,
        valueInputOption: 'RAW',
        resource: { values: header },
      });
    }
    res.json({ success: true, message: 'Sheet cleared — header preserved' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/expense-log/clean-sheet', async (req, res) => {
  if (!SHEET_ID) return res.status(400).json({ error: 'No sheet ID' });
  try {
    const sheets = getSheetsClient();
    const data = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_TAB}'!A:O`,
    });
    const rows = data.data.values || [];
    // Keep header row and rows where column L (index 11) is a pure number
    const kept = rows.filter((row, i) => {
      if (i === 0) return true; // keep header
      const colL = String(row[11] || '').trim();
      return /^\d+$/.test(colL); // keep only numeric bill IDs
    });
    // Clear and rewrite
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_TAB}'!A:O`,
    });
    if (kept.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `'${SHEET_TAB}'!A1`,
        valueInputOption: 'RAW',
        resource: { values: kept },
      });
    }
    res.json({ success: true, kept: kept.length - 1, removed: rows.length - kept.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/expense-log/backfill', async (req, res) => {
  if (!SHEET_ID) return res.status(400).json({ error: 'GOOGLE_SHEETS_SPREADSHEET_ID not set' });
  try {
    // Use the same dailyBillSync logic with a fixed start date
    await runDailyBillSync('2026-06-01');
    return res.json({ success: true, message: 'Backfill from 2026-06-01 complete — check sheet' });
  } catch (e) {
    console.error('[expense-log] Backfill error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/expense-log/backfill_DISABLED', async (req, res) => {
  if (!SHEET_ID) return res.status(400).json({ error: 'GOOGLE_SHEETS_SPREADSHEET_ID not set' });
  try {
    const sheets = getSheetsClient();
    await ensureSheetTab(sheets);
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_TAB}'!M:M`,
    });
    const existingIDs = new Set((existing.data.values || []).flat().filter(Boolean).map(String));
    console.log('[backfill] Existing bill IDs in sheet (col M):', existingIDs.size, 'sample:', [...existingIDs].slice(0,5));
    const START_DATE = '2026-06-01';
    const GL_NAMES = {80:'HOA Dues',86:'Home Warranty Trade Fee',82:'Cleaning Reimbursement',106:'Key/Lock Replacement',79:'Landscaping',77:'Pest Control',102:'Painting',103:'Plumbing',104:'Flooring',105:'HVAC',110:'Electrical',108:'Repairs - Other',81:'Cleaning and Maintenance - Other',78:'General Maintenance Labor',83:'Pool Services',144:'Inspection',143:'Irrigation',111:'Supplies',136:'Owner Administrative Charge'};
    let all = [], page = 1;
    while (page <= 20) {
      const rvResp = await fetch(`${RENTVINE_BASE}/accounting/bills?contactID=${CONTACT_REIMBURSEMENTS}&startDate=${START_DATE}&pageSize=200&page=${page}`, { headers: { Authorization: `Basic ${RENTVINE_AUTH}`, 'X-Rentvine-Account': RENTVINE_ACCOUNT, 'Content-Type': 'application/json' } });
      const data = await rvResp.json();
      const rows = Array.isArray(data) ? data : (data?.data ?? []);
      if (!rows.length) break;
      all = all.concat(rows);
      if (rows.length < 200) break;
      page++;
    }
    let added = 0, skipped = 0;
    const rowsToAdd = [];
    for (const row of all) {
      const b = row.bill || row;
      const billID = String(b.billID || b.id || '');
      if (!billID || existingIDs.has(billID)) { skipped++; continue; }
      if (b.isVoided === true || b.isVoided === 1 || String(b.isVoided) === '1') { skipped++; continue; }

      // Fetch full bill with charges for amount, GL, description
      let description = b.description || b.paymentMemo || '';
      let reference = b.reference || b.paymentMemo || '';
      let billDate = (b.billDate || '').slice(0, 10);
      let amount = '0.00';
      let glName = '';
      try {
        await new Promise(r => setTimeout(r, 150)); // avoid rate limiting
        const det = await fetch(RENTVINE_BASE + '/accounting/bills/' + billID + '?includes=charges', {
          headers: { Authorization: 'Basic ' + RENTVINE_AUTH, 'X-Rentvine-Account': RENTVINE_ACCOUNT }
        });
        const d = await det.json();
        const fb = d && d.bill ? d.bill : b;
        description = fb.description || fb.paymentMemo || description;
        reference = fb.reference || fb.paymentMemo || reference;
        billDate = (fb.billDate || billDate).slice(0, 10);
        const charges = (d && d.charges) ? d.charges : [];
        const total = charges.reduce(function(s, c) { return s + Number(c.amount || 0); }, 0);
        amount = total > 0 ? total.toFixed(2) : String(b.totalAmount || '0.00');
        const glID = charges[0] ? (charges[0].chargeAccountID || '') : '';
        glName = GL_NAMES[parseInt(glID)] || GL_NAMES[parseInt(b.glAccountID)] || '';
      } catch(e) {
        console.warn('[backfill] Detail fetch failed for bill', billID, e.message);
        amount = String(b.totalAmount || '0.00');
      }
      // Skip bills where amount is still 0 — flag for manual review
      if (!amount || amount === '0.00') {
        console.warn('[backfill] Skipping bill', billID, '- amount is 0, needs manual review');
        skipped++;
        continue;
      }

      const ownerMatch = description.match(/\(([^)]+)\)\s*$/);
      const owner = ownerMatch ? ownerMatch[1] : '';
      const withoutOwner = ownerMatch ? description.slice(0, ownerMatch.index).trim() : description;
      const addrMatch = withoutOwner.match(/\d+\s+.+/);
      const address = addrMatch ? addrMatch[0].trim() : withoutOwner;
      const now = new Date().toISOString();
      rowsToAdd.push([now, billDate, '', '', address, owner, glName, '', amount, glName, reference, '', billID, '', now, 'Auto-synced']);
      existingIDs.add(billID);
      added++;
    }
    if (rowsToAdd.length) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `'${SHEET_TAB}'!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: rowsToAdd },
      });
    }
    console.log('[expense-log] Backfill complete: added', added, 'skipped', skipped, 'existingIDs sample:', [...existingIDs].slice(0,5));
    console.log('[expense-log] First bill sample:', all[0] ? JSON.stringify(all[0]).slice(0,200) : 'none');
    const ids = all.map(r => String((r.bill||r).billID||'')); console.log('[expense-log] All bill IDs:', ids.join(','));
    res.json({ success: true, added, skipped, total: all.length });
  } catch (e) {
    console.error('[expense-log] Backfill error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/expense-log/upload', async (req, res) => {
  try {
    const billID = req.query.billID;
    if (!billID) return res.status(400).json({ error: 'billID required' });
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', resolve);
      req.on('error', reject);
    });
    const buffer = Buffer.concat(chunks);
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) return res.status(400).json({ error: 'No boundary' });
    const boundary = boundaryMatch[1];
    const headerSection = buffer.slice(0, Math.min(600, buffer.length)).toString('utf8');
    const nameMatch = headerSection.match(/filename="([^"]+)"/);
    const fileName = nameMatch ? nameMatch[1] : 'receipt.jpg';
    const ctMatch = headerSection.match(/Content-Type: ([^\r\n]+)/);
    const mimeType = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';
    const sep = Buffer.from('\r\n\r\n');
    let start = -1;
    for (let i = 0; i < buffer.length - sep.length; i++) {
      if (buffer.slice(i, i + sep.length).equals(sep)) { start = i + sep.length; break; }
    }
    if (start < 0) return res.status(400).json({ error: 'Could not parse file' });
    const endMarker = Buffer.from('\r\n--' + boundary);
    let end = buffer.length;
    for (let i = start; i < buffer.length - endMarker.length; i++) {
      if (buffer.slice(i, i + endMarker.length).equals(endMarker)) { end = i; break; }
    }
    const fileBuffer = buffer.slice(start, end);
    const result = await uploadToRVFiles(fileName, mimeType, fileBuffer, 5, billID);
    console.log('[expense-log] Receipt upload to bill', billID, ':', result.status);
    if (result.ok) {
      res.json({ success: true, message: 'Receipt uploaded to bill ' + billID });
    } else {
      res.status(500).json({ error: 'Upload failed: ' + result.text });
    }
  } catch (e) {
    console.error('[expense-log] Upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});



// ── Rentvine MCP helpers (list_attachments, download_file, upload_file via MCP) ──
// MCP SSE requires session handshake — use direct API calls instead.
// list_attachments: GET /api/manager/files with main auth (no account header) returns all files;
// we page through and match by objectID client-side.
// download: GET /api/manager/files/{id}/preview with main auth — confirmed working.

async function rvListAttachmentsForWO(workOrderID) {
  // Page through /files (returns newest first, no objectID filter works)
  // Match client-side by cross-referencing with known upload dates or use /fileattachments endpoint
  // Try /fileattachments which may support filtering
  const endpoints = [
    '/fileattachments?objectTypeID=16&objectID=' + workOrderID,
    '/files/list?objectTypeID=16&objectID=' + workOrderID,
    '/workorders/' + workOrderID + '/files',
  ];
  for (const ep of endpoints) {
    try {
      const url = new URL(RENTVINE_BASE + ep);
      const r = await fetch(url.toString(), { headers: { Authorization: 'Basic ' + RENTVINE_AUTH } });
      if (r.ok) {
        const data = await r.json();
        const arr = Array.isArray(data) ? data : (data.data || data.files || data.fileAttachments || []);
        if (arr.length > 0) {
          console.log('rvListAttachments: found', arr.length, 'files via', ep);
          return arr.map(f => {
            const file = f.file || f;
            return { fileID: file.fileID || file.id, fileName: file.title || file.fileName || (file.fileID + '.jpg') };
          }).filter(f => f.fileID && /\.(jpe?g|png|gif|webp)$/i.test(f.fileName));
        }
      }
    } catch(e) { /* try next */ }
  }
  // Last resort: page /files and match by objectID in fileAttachment
  const allFiles = [];
  for (let pg = 1; pg <= 5; pg++) {
    const url = new URL(RENTVINE_BASE + '/files');
    url.searchParams.set('page', pg); url.searchParams.set('pageSize', 100);
    const r = await fetch(url.toString(), { headers: { Authorization: 'Basic ' + RENTVINE_AUTH } });
    if (!r.ok) break;
    const data = await r.json();
    const arr = Array.isArray(data) ? data : [];
    if (!arr.length) break;
    const matched = arr.filter(f => String(f.fileAttachment?.objectID) === String(workOrderID) || String(f.objectID) === String(workOrderID));
    allFiles.push(...matched);
    if (arr.length < 100) break;
  }
  console.log('rvListAttachments fallback: found', allFiles.length, 'matched files for WO', workOrderID);
  return allFiles.map(f => ({
    fileID: f.file?.fileID || f.fileID,
    fileName: f.file?.title || f.title || f.fileName || 'photo.jpg'
  })).filter(f => f.fileID && /\.(jpe?g|png|gif|webp)$/i.test(f.fileName));
}

async function rvDownloadFile(fileId) {
  // Use file-upload credentials for download too (same creds that work for upload)
  const RV_FILE_KEY    = process.env.RENTVINE_FILE_KEY    || '2586bdded08f499bb2057e373fd662f7';
  const RV_FILE_SECRET = process.env.RENTVINE_FILE_SECRET || '81f3aa4cb0434162aab8a27702f089b8';
  const auth = Buffer.from(RV_FILE_KEY + ':' + RV_FILE_SECRET).toString('base64');
  // Try preview endpoint first, then direct download
  for (const path of ['/files/' + fileId + '/preview', '/files/' + fileId + '/download', '/files/' + fileId]) {
    const r = await fetch(RENTVINE_BASE + path, { headers: { Authorization: 'Basic ' + auth } });
    if (r.ok && r.headers.get('content-type')?.startsWith('image/')) {
      return Buffer.from(await r.arrayBuffer());
    }
    // Also try main auth
    const r2 = await fetch(RENTVINE_BASE + path, { headers: { Authorization: 'Basic ' + RENTVINE_AUTH } });
    if (r2.ok && r2.headers.get('content-type')?.startsWith('image/')) {
      return Buffer.from(await r2.arrayBuffer());
    }
  }
  throw new Error('Could not download file ' + fileId + ' from any endpoint');
}
// ── End file helpers ──

async function syncPhotosForWO(workOrderID, workOrderNumber) {
  const APTLY_TOK = process.env.APTLY_TOKEN || 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';
  const results = { rvUploaded: 0, aptlyUploaded: 0, skipped: 0, errors: 0 };
  try {
    // 1. Get Issue Photos for this WO from Rentvine
    // List photos for this WO
    let photos = [];
    try {
      photos = await rvListAttachmentsForWO(workOrderID);
      console.log('Photo sync WO#' + workOrderNumber + ': found', photos.length, 'photos');
    } catch(listErr) {
      console.error('Photo sync list error WO#' + workOrderNumber + ':', listErr.message);
    }
    if (!photos.length) {
      console.log('Photo sync WO#' + workOrderNumber + ': no photos found yet');
      return results;
    }
    console.log('Photo sync WO#' + workOrderNumber + ': found', photos.length, 'photos');

    // 2. Find matching Aptly card (for Aptly sync)
    let aptlyCardId = null;
    for (let pg = 0; pg < 10; pg++) {
      const resp = await fetch('https://core-api.getaptly.com/api/board/workOrder?page=' + pg + '&pageSize=100&includeArchived=true', { headers: { 'x-token': APTLY_TOK } });
      if (!resp.ok) break;
      const batch = await resp.json();
      const items = Array.isArray(batch) ? batch : (batch && batch.data) || [];
      if (!items.length) break;
      const match = items.find(c => String(c.workOrderNumber) === String(workOrderNumber));
      if (match) { aptlyCardId = match._id; break; }
      if (items.length < 100) break;
    }
    if (!aptlyCardId) console.log('Photo sync WO#' + workOrderNumber + ': no Aptly card found — will still upload to RV Files tab');

    // 3. Process each photo
    for (const fileRec of photos) {
      const fileID = fileRec.fileID;
      const fileName = fileRec.fileName || ('WO' + workOrderNumber + '_' + fileID + '.jpg');
      const ext = fileName.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
      const mimeType = 'image/' + ext;
      const rvLogKey = 'rv_f' + fileID + '_wo' + workOrderID;
      const aptlyLogKey = 'aptly_f' + fileID + '_c' + (aptlyCardId || 'none');

      // Download file
      let imgBuffer;
      try {
        imgBuffer = await rvDownloadFile(fileID);
      } catch(dlErr) {
        console.error('Photo sync: download failed for fileID', fileID, dlErr.message);
        results.errors++;
        continue;
      }

      // ── Upload to Rentvine Files tab (PRIMARY) ──
      if (!PHOTO_SYNC_UPLOADED[rvLogKey]) {
        const rvResult = await uploadToRVFiles(fileName, mimeType, imgBuffer, 16, workOrderID);
        if (rvResult.ok) {
          PHOTO_SYNC_UPLOADED[rvLogKey] = Date.now();
          results.rvUploaded++;
          console.log('Photo sync → RV Files: uploaded', fileName, 'to WO#' + workOrderNumber, '| status:', rvResult.status);
        } else {
          console.error('Photo sync → RV Files FAILED WO#' + workOrderNumber, 'status:', rvResult.status, rvResult.text);
          results.errors++;
        }
      } else {
        results.skipped++;
      }

      // ── Upload to Aptly card (SECONDARY, if card found) ──
      if (aptlyCardId && !PHOTO_SYNC_UPLOADED[aptlyLogKey]) {
        const boundary2 = '----AloePMAptlyBoundary' + Date.now();
        const aptlyBody = buildMultipart(boundary2, 'file', fileName, mimeType, imgBuffer);
        const aptlyResp = await fetch('https://core-api.getaptly.com/api/board/workOrder/' + aptlyCardId + '/file', {
          method: 'POST',
          headers: { 'x-token': APTLY_TOK, 'Content-Type': 'multipart/form-data; boundary=' + boundary2, 'Content-Length': String(aptlyBody.length) },
          body: aptlyBody
        });
        if (aptlyResp.ok) {
          PHOTO_SYNC_UPLOADED[aptlyLogKey] = Date.now();
          results.aptlyUploaded++;
          console.log('Photo sync → Aptly: uploaded', fileName, 'to card', aptlyCardId);
        } else {
          console.error('Photo sync → Aptly FAILED WO#' + workOrderNumber, (await aptlyResp.text()).slice(0, 100));
        }
      }
    }
  } catch(e) { console.error('Photo sync error WO#' + workOrderNumber + ':', e.message); results.errors++; }
  return results;
}

app.post('/api/webhook/rv-wo-created', async (req, res) => {
  res.sendStatus(200); return; // Disabled
  res.sendStatus(200); // Acknowledge immediately
  try {
    const payload = req.body;
    const wo = payload.data || payload.workOrder || payload;
    const workOrderID = wo.workOrderID || wo.id || payload.event?.objectID;
    const workOrderNumber = wo.workOrderNumber || wo.number;
    if (!workOrderID || !workOrderNumber) {
      console.log('RV webhook: missing WO ID/number in payload', JSON.stringify(payload).slice(0, 200));
      return;
    }
    console.log('RV webhook: WO#' + workOrderNumber + ' (ID:' + workOrderID + ') received');
  
    // Delay 5s then try to fetch + copy photos
    setTimeout(async () => {
      const result = await syncPhotosForWO(workOrderID, workOrderNumber);
      console.log('RV webhook photo sync complete WO#' + workOrderNumber + ':', result);
      if (SLACK_TOKEN && (result.rvUploaded > 0 || result.aptlyUploaded > 0)) {
        const msg = ':camera: *WO #' + workOrderNumber + '* — auto-copied ' + result.rvUploaded + ' photo(s) to Rentvine Files tab' +
          (result.aptlyUploaded > 0 ? ', ' + result.aptlyUploaded + ' to Aptly' : '') +
          (result.errors > 0 ? ' (' + result.errors + ' errors)' : '') +
          '\n<https://aloepm.rentvine.com/maintenance/work-orders/' + workOrderID + '|View in Rentvine>';
        fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: 'C06BWVACZQF', text: msg })
        }).catch(e => console.error('Slack notify error:', e.message));
      }
    }, 5000);
  } catch(e) { console.error('RV webhook error:', e.message); }
});

// Test: upload a photo from WO 7026 → its own Rentvine Files tab (to verify UI visibility)
app.get('/api/photo-sync/test-rv-upload', async (req, res) => {
  try {
    const testWOID = req.query.woID || '7026';
    const filesData = await rvFetch('/files/attachments', { objectTypeID: 16, objectID: testWOID });
    const files = Array.isArray(filesData) ? filesData : (filesData && filesData.data) || [];
    const photo = files.find(f => (f.file||f).isImage === '1' || (f.file||f).fileType?.match(/jpe?g|png/i));
    if (!photo) return res.json({ error: 'no photos found on WO ' + testWOID, filesData });
    const fileID = photo.file.fileID;
    const fileName = 'TEST_COPY_' + (photo.file.title || fileID + '.jpg');
    const dlResp = await fetch(RENTVINE_BASE + '/files/' + fileID + '/preview', { headers: { Authorization: 'Basic ' + RENTVINE_AUTH } });
    if (!dlResp.ok) return res.json({ error: 'download failed', status: dlResp.status });
    const imgBuffer = Buffer.from(await dlResp.arrayBuffer());
    const result = await uploadToRVFiles(fileName, 'image/jpeg', imgBuffer, 16, testWOID);
    res.json({ woID: testWOID, sourceFileID: fileID, fileName, imgBytes: imgBuffer.length, uploadStatus: result.status, uploadOk: result.ok, uploadResponse: result.text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Debug: raw MCP call for list_attachments
app.get('/api/photo-sync/debug-mcp', async (req, res) => {
  try {
    const woID = parseInt(req.query.woID || '7046');
    // Raw MCP call
    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'list_attachments', arguments: { object_id: woID, object_type_id: 16 } }
    });
    const resp = await fetch('https://mcp.production.rentvine.ai/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ODhkMjJjOGM5NmJlNDYyMWJjMGI3YWRlZGIzZWY3NmQ6MDUzMjFmOGNlMDkwNGVlNGFiNGQ3YzJhODMyYjZkMmU=',
        'X-Rentvine-Account': 'aloepm',
        'Accept': 'application/json, text/event-stream'
      },
      body
    });
    const statusCode = resp.status;
    const rawText = await resp.text();
    // Also try initialize first
    res.json({ statusCode, rawText: rawText.slice(0, 3000) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Debug: inspect all files + issue photos on a WO
app.get('/api/photo-sync/debug-wo', async (req, res) => {
  try {
    const woID = req.query.woID || '7026';

    // Test 1: /files/attachments (correct endpoint) vs /files (broken - ignores objectID)
    const filesRaw = await rvFetch('/files/attachments', { objectTypeID: 16, objectID: woID });
    const allFiles = Array.isArray(filesRaw) ? filesRaw : [];
    // Filter client-side to only files that actually match this WO
    const matchedFiles = allFiles.filter(f => String(f.fileAttachment?.objectID) === String(woID) || String(f.objectID) === String(woID));

    // Test 2: WO detail - does it embed photos?
    const woDetail = await rvFetch('/maintenance/work-orders/' + woID);

    // Test 3: issues sub-endpoint
    let issuesData = null;
    try { issuesData = await rvFetch('/maintenance/work-orders/' + woID + '/issues'); } catch(e) { issuesData = { error: e.message }; }

    // Test 4: media sub-endpoint
    let mediaData = null;
    try { mediaData = await rvFetch('/maintenance/work-orders/' + woID + '/media'); } catch(e) { mediaData = { error: e.message }; }

    // Test 5: photos sub-endpoint
    let photosData = null;
    try { photosData = await rvFetch('/maintenance/work-orders/' + woID + '/photos'); } catch(e) { photosData = { error: e.message }; }

    res.json({
      woID,
      // Show first 3 raw file records so we can see full structure
      rawFileSample: allFiles.slice(0, 3),
      allFilesCount: allFiles.length,
      matchedFilesCount: matchedFiles.length,
      matchedFiles: matchedFiles.map(f => ({
        fileID: f.file?.fileID || f.fileID,
        title: f.file?.title || f.title,
        isImage: f.file?.isImage || f.isImage,
        objectID: f.fileAttachment?.objectID || f.objectID,
        objectTypeID: f.fileAttachment?.objectTypeID || f.objectTypeID,
        category: f.file?.category,
        pathID: f.file?.pathID,
      })),
      // Show full WO detail to find nested photo fields
      woDetail: woDetail && !woDetail.error ? {
        topKeys: Object.keys(woDetail),
        workOrderKeys: woDetail.workOrder ? Object.keys(woDetail.workOrder) : null,
        issuesSample: woDetail.workOrder?.issues ? woDetail.workOrder.issues.slice(0,2) : null,
        photosSample: woDetail.workOrder?.photos ? woDetail.workOrder.photos.slice(0,2) : null,
        attachmentsSample: woDetail.workOrder?.attachments ? woDetail.workOrder.attachments.slice(0,2) : null,
        filesSample: woDetail.workOrder?.files ? woDetail.workOrder.files.slice(0,2) : null,
      } : woDetail,
      // Sub-endpoints
      issuesData,
      mediaData,
      photosData,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Manual trigger: POST { workOrderID, workOrderNumber }
app.post('/api/photo-sync/run', async (req, res) => {
  try {
    const { workOrderID, workOrderNumber } = req.body || {};
    if (workOrderID && workOrderNumber) {
      res.json(await syncPhotosForWO(workOrderID, workOrderNumber));
    } else {
      res.status(400).json({ error: 'workOrderID and workOrderNumber required' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ── End RV WO Webhook / Photo Sync ──

app.get('/reload-kb-cache', function(req, res) {
  Object.keys(KB_TOPIC_CACHE).forEach(k => delete KB_TOPIC_CACHE[k]);
  res.json({ cleared: true });
});
app.get('/chat', (req, res) => res.sendFile(new URL('chat.html', import.meta.url).pathname));
app.get('/sandbox', (req, res) => res.sendFile(new URL('sandbox.html', import.meta.url).pathname));
app.get('/recon-bills', (req, res) => res.sendFile(new URL('recon-bills.html', import.meta.url).pathname));
app.get('/recon', (req, res) => res.sendFile(new URL('./recon.html', import.meta.url).pathname));
app.get('/bank-setup', (req, res) => res.sendFile(new URL('plaid-setup.html', import.meta.url).pathname));
app.get('/logo.png', (req, res) => res.sendFile(new URL('AloePM-Logo_FullColor__2_.png', import.meta.url).pathname));
app.get('/rent-analysis', (req, res) => res.sendFile(new URL('./rent-analysis.html', import.meta.url).pathname));
app.get('/sale-analysis', (req, res) => res.sendFile(new URL('./sale-analysis.html', import.meta.url).pathname));
app.get('/owner-report', (req, res) => res.sendFile(new URL('./owner-report.html', import.meta.url).pathname));
app.get('/metrics', (req, res) => res.sendFile(new URL('./metrics.html', import.meta.url).pathname));
app.get('/expense-log', (req, res) => res.sendFile(new URL('./expense-log.html', import.meta.url).pathname));
app.get('/api/properties-search', async (req, res) => {
  try {
    let all = [], page = 1;
    while(page <= 20){
      const batch = await rvFetch('/properties/export', { pageSize: 200, page, isActive: true });
      const rows = Array.isArray(batch) ? batch : (batch?.data ?? []);
      if(!rows.length) break;
      all = all.concat(rows);
      if(rows.length < 200) break;
      page++;
    }
    res.json(all.filter(row => (row.property||row).isActive !== false).map(row => {
      const p = row.property || row;
      const port = row.portfolio || {};
      return { propertyID: p.propertyID||p.id, address: [p.address,p.city,p.stateID||'AZ'].filter(Boolean).join(', '), portfolioName: port.name||p.portfolioName||'', portfolioID: p.portfolioID||port.portfolioID };
    }).filter(p=>p.address).sort((a,b)=>a.address.localeCompare(b.address)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ── Metrics helpers ────────────────────────────────────────────────────────
function monthKey(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function buildMonthBuckets(n = 12) {
  const buckets = {};
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    buckets[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`] = 0;
  }
  return buckets;
}
function thisMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function daysAgo(dateStr, from = new Date()) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return Math.floor((from - d) / 86400000);
}

let _metricsCache = null;
let _metricsCacheTime = 0;
const METRICS_CACHE_TTL = 15 * 60 * 1000;

app.get('/api/metrics', async (req, res) => {
  try {
    if (_metricsCache) return res.json(_metricsCache);
    const data = await buildMetricsData();
    _metricsCache = data;
    _metricsCacheTime = Date.now();
    res.json(data);
  } catch(e) {
    console.error('Metrics API error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/moveout-charges', async (req, res) => {
  try {
    // Fetch properties to build propertyID->streetNum map
    const props = [];
    for (let pg = 1; pg <= 5; pg++) {
      const r = await fetch(RENTVINE_BASE + '/properties/export?pageSize=200&page=' + pg, { headers: { Authorization: 'Basic ' + RENTVINE_AUTH } });
      if (!r.ok) break;
      const d = await r.json();
      const batch = Array.isArray(d) ? d : (d.data || []);
      batch.forEach(function(i){ props.push(i.property || i); });
      if (batch.length < 200) break;
    }
    const data = await fetchMoveOutChargeRecon(props);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/moveins-placement', async (req, res) => {
  try {
    // Build propertyID -> streetNum map from properties export
    const propIdToStreet = {};
    for (let pg = 1; pg <= 5; pg++) {
      const pr = await fetch(RENTVINE_BASE + '/properties/export?pageSize=200&page=' + pg, { headers: { Authorization: 'Basic ' + RENTVINE_AUTH } });
      if (!pr.ok) break;
      const pd = await pr.json();
      const batch = Array.isArray(pd) ? pd : (pd.data || []);
      batch.forEach(function(item) {
        const p = item.property || item;
        const pid = String(p.propertyID || p.id || '');
        const addr = (p.address || '').toLowerCase();
        const numMatch = addr.match(/^(\d+)/);
        if (pid && numMatch) propIdToStreet[pid] = numMatch[1];
      });
      if (batch.length < 200) break;
    }
    console.log('Placement fees: propertyID map has', Object.keys(propIdToStreet).length, 'entries');

    // Fetch bill charge transactions (type 7) last 30 days, filter for lease fee
    const cutoff = new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
    const result = {};
    const LEASE_FEE_PAT = /lease.?fee|placement.?fee|commission/i;
    for (let pg = 1; pg <= 10; pg++) {
      const tr = await fetch(RENTVINE_BASE + '/accounting/transactions?pageSize=200&page=' + pg + '&transactionTypeID=7&startDate=' + cutoff, { headers: { Authorization: 'Basic ' + RENTVINE_AUTH } });
      if (!tr.ok) break;
      const td = await tr.json();
      const txns = Array.isArray(td) ? td : (td.data || []);
      if (!txns.length) break;
      txns.forEach(function(t) {
        const txn = t.transaction || t;
        const desc = txn.description || txn.memo || '';
        if (!LEASE_FEE_PAT.test(desc)) return;
        const pid = String(txn.propertyID || '');
        const key = propIdToStreet[pid] || '';
        if (!key) return;
        const amt = parseFloat(txn.amount || 0);
        if (amt <= 0) return;
        if (!result[key]) result[key] = [];
        result[key].push({ date: txn.datePosted || '', amount: amt, description: desc.slice(0,80) });
      });
      if (txns.length < 200) break;
    }
    console.log('Placement fees: found', Object.keys(result).length, 'properties');
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/metrics/refresh', (req, res) => {
  _metricsCache = null; _metricsCacheTime = 0;
  res.json({ cleared: true });
});


function categorizeMoveOutReason(text) {
  if (!text) return 'Not Specified';
  const t = text.toLowerCase();
  if (/buy|purchas|home|house/.test(t)) return 'Buying a Home';
  if (/work|job|employ|relocat|transfer|state/.test(t)) return 'Job / Relocation';
  if (/sell|owner sell/.test(t)) return 'Owner Selling';
  if (/afford|financial|money|rent too|price/.test(t)) return 'Financial';
  if (/family|personal|divorce|marriage|child/.test(t)) return 'Personal / Family';
  if (/evict|violation|non.?pay/.test(t)) return 'Eviction / Non-Payment';
  if (/downsize|upsize|bigger|smaller|bedroom/.test(t)) return 'Different Size Needed';
  return 'Other';
}

async function fetchMoveOutReasons() {
  const reasons = {};
  try {
    const reportBody = {
      displayColumns: ['moveOutTenantReason', 'moveOutReason', 'leaseMoveInDate', 'moveOutDate'],
      filters: [
        { name: 'moveOutDate', comparator: 'previous12Months' },
        { name: 'isTenantPrimary', comparator: 'booleanTrue' }
      ]
    };
    const url = RENTVINE_BASE + '/reports/lease-tenants?exportTypeID=1&json=' + encodeURIComponent(JSON.stringify(reportBody));
    const r = await fetch(url, { headers: { Authorization: 'Basic ' + RENTVINE_AUTH } });
    if (!r.ok) { console.error('Move-out reasons report error:', r.status); return reasons; }
    const data = await r.json();
    const rows = data.rows || [];
    const tenancyDays = {}, tenancyCounts = {};
    rows.forEach(row => {
      const d = row.data || {};
      const text = (d.moveOutTenantReason || d.moveOutReason || '').trim();
      if (!text) return;
      const cat = categorizeMoveOutReason(text);
      reasons[cat] = (reasons[cat] || 0) + 1;
      if (d.leaseMoveInDate && d.moveOutDate) {
        const days = Math.floor((new Date(d.moveOutDate) - new Date(d.leaseMoveInDate)) / 86400000);
        if (days > 0 && days < 3650) {
          tenancyDays[cat] = (tenancyDays[cat] || 0) + days;
          tenancyCounts[cat] = (tenancyCounts[cat] || 0) + 1;
        }
      }
    });
    Object.keys(reasons).forEach(cat => {
      const avgDays = tenancyCounts[cat] ? Math.round(tenancyDays[cat] / tenancyCounts[cat]) : null;
      reasons[cat] = { count: reasons[cat], avgTenancyMonths: avgDays ? Math.round(avgDays / 30) : null };
    });
    console.log('Move-out reasons fetched:', Object.keys(reasons).length, 'categories from', rows.length, 'rows');
  } catch(e) { console.error('fetchMoveOutReasons error:', e.message); }
  return reasons;
}

async function fetchAllPropertyContracts() {
  function parseRVDate(val) {
    if (!val) return null;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }
  const reportBody = {
    displayColumns: ['propertyID', 'propertyAddress', 'dateContractBegins', 'dateContractEnds', 'isActive'],
    filters: []
  };
  const all = [];
  let page = 1;
  while (page <= 10) {
    const url = RENTVINE_BASE + '/reports/property?exportTypeID=1&json=' + encodeURIComponent(JSON.stringify(reportBody)) + '&page=' + page + '&pageSize=200';
    const r = await fetch(url, { headers: { Authorization: 'Basic ' + RENTVINE_AUTH } });
    if (!r.ok) break;
    const d = await r.json();
    const rows = d.rows || [];
    if (!rows.length) break;
    rows.forEach(function(row) {
      const p = row.data || {};
      all.push({
        propertyID: p.propertyID,
        address: p.propertyAddress || '',
        isActive: p.isActive === 1 || p.isActive === '1' || p.isActive === true,
        dateContractBegins: parseRVDate(p.dateContractBegins),
        dateContractEnds: parseRVDate(p.dateContractEnds)
      });
    });
    if (rows.length < 200) break;
    page++;
  }
  console.log('fetchAllPropertyContracts: fetched', all.length, 'properties');
  return all;
}

async function buildMetricsData() {
  const fetchStart = Date.now();
  const TMK = thisMonthKey();
  const now = new Date();

  async function fetchAllPages(path, params = {}, maxPages = 10) {
    let all = [], pg = 1;
    while (pg <= maxPages) {
      const batch = await rvFetch(path, { ...params, pageSize: 200, page: pg });
      if (!Array.isArray(batch) || batch.length === 0) break;
      all = all.concat(batch);
      if (batch.length < 200) break;
      pg++;
    }
    return all;
  }

  const [allProps, allUnits, activeLeasesRaw, closedLeasesRaw, allPropsList] = await Promise.all([
    fetchAllPages('/properties/export', { isActive: true }, 5),
    fetchAllPages('/properties/units/export', { isActive: true }, 5),
    fetchAllPages('/leases/export', { 'primaryLeaseStatusIDs[]': 2 }, 5),
    fetchAllPages('/leases/export', { 'primaryLeaseStatusIDs[]': 3 }, 8),
fetchAllPages('/properties/export', { isActive: true }, 5),
  ]);

  const propContractDatesMap = {};
  allPropsList.forEach(p => { if (p.propertyID && p.dateContractBegins) propContractDatesMap[String(p.propertyID)] = p.dateContractBegins; });

  const unwrap = items => items.map(item => {
    const l = item.lease || item;
    l._unit = item.unit || {}; l._property = item.property || {};
    l._balances = item.balances || {}; l._unpaidCharges = item.unpaidCharges || {};
    return l;
  });

  const activeLeases = unwrap(activeLeasesRaw);
  const closedLeases = unwrap(closedLeasesRaw);
  const allLeases = [...activeLeases, ...closedLeases];

  const isUnitActive = u => u.isActive === true || u.isActive === 1 || u.isActive === '1';
  const isUnitVacant = u => u.isVacant === true || u.isVacant === 1 || u.isVacant === '1';
  const activeUnits = allUnits.filter(item => isUnitActive(item.unit || item));
  const totalUnits = activeUnits.length;
  const vacantUnits = activeUnits.filter(item => isUnitVacant(item.unit || item)).length;
  const occupiedUnits = totalUnits - vacantUnits;
  const occupancyRate = totalUnits > 0 ? +((occupiedUnits / totalUnits) * 100).toFixed(1) : 0;
  const activeUnitIDs = new Set(activeUnits.map(item => String((item.unit||item).unitID)).filter(Boolean));

  const allUnitRents = activeUnits.map(item => parseFloat((item.unit||item).rent||0)).filter(r => r > 0);
  const occupiedUnitRents = activeUnits.filter(item => !isUnitVacant(item.unit||item)).map(item => parseFloat((item.unit||item).rent||0)).filter(r => r > 0);
  const avgRent = allUnitRents.length ? Math.round(allUnitRents.reduce((a,b)=>a+b,0)/allUnitRents.length) : 0;
  const totalRentExpected = Math.round(occupiedUnitRents.reduce((a,b)=>a+b,0));
  const vacancyLoss = vacantUnits * 85;

  const propGainedByMonth = buildMonthBuckets(24);
  let propGainedMTD = 0;
  allProps.forEach(item => {
    const p = item.property || item;
    const contractBegins = propContractDatesMap[String(p.propertyID)] || p.dateContractBegins;
    const dateAdded = contractBegins || p.dateTimeCreated;
    const k = monthKey(dateAdded);
    if (k && propGainedByMonth[k] !== undefined) { propGainedByMonth[k]++; if (k === TMK) propGainedMTD++; }
  });

  const moveInsByMonth = buildMonthBuckets(24);
  const moveOutsByMonth = buildMonthBuckets(24);
  let moveInsMTD = 0, moveOutsMTD = 0;
  const pastDueTenants = [];
  let totalPastDue = 0;
const moveOutReasons = {};
const moveOutReasonRaw = [];


  allLeases.forEach(l => {
    const mk = monthKey(l.moveInDate || l.startDate);
    if (mk && moveInsByMonth[mk] !== undefined) moveInsByMonth[mk]++;
    if (mk === TMK) moveInsMTD++;

   if (parseInt(l.primaryLeaseStatusID||0) === 3) {
  const unitStillActive = activeUnitIDs.has(String(l.unitID));
  const moveOutDate = l.expectedMoveOutDate || (l.moveOutDate && unitStillActive ? l.moveOutDate : null);
  const mok = monthKey(moveOutDate);
  if (moveOutDate && mok) {
    if (moveOutsByMonth[mok] !== undefined) moveOutsByMonth[mok]++;
    if (mok === TMK) moveOutsMTD++;
  }
  // Capture move-out reasons (tenant-written field)
  const reason = (l.moveOutTenantReason || '').trim();
  if (reason) {
    const cat = categorizeMoveOutReason(reason);
    moveOutReasons[cat] = (moveOutReasons[cat] || 0) + 1;
    moveOutReasonRaw.push({ reason, category: cat, address: l._unit?.address || l._property?.address || '', moveOutDate: moveOutDate || '' });
  }
}
    if (parseInt(l.primaryLeaseStatusID||0) === 2 && l._balances) {
      const pastDueRent = parseFloat(l._balances.pastDueRentAmount || 0);
      if (pastDueRent > 0 && parseInt(l.leaseStatusID||0) !== 10) {
        const tenantName = Array.isArray(l.tenants) ? l.tenants.filter(t=>t.isActive).map(t=>t.name).join(', ') || '--' : (l.tenants||'--');
        pastDueTenants.push({ leaseID: l.leaseID, tenant: tenantName, address: l._unit.address||l._property.address||'', city: l._unit.city||l._property.city||'', pastDueRent });
        totalPastDue += pastDueRent;
      }
    }
  });

  // Aptly data
  const APTLY_BASE2 = 'https://core-api.getaptly.com';
  const APTLY_TOK = 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';

  async function fetchAptlyBoard(boardId, opts = {}) {
    let all = [], pg = 0;
    const max = opts.maxPages || 5;
    const extraParams = opts.params || {};
    while (pg < max) {
      const params = new URLSearchParams({ page: pg, pageSize: 100, ...extraParams });
      const resp = await fetch(APTLY_BASE2 + '/api/board/' + boardId + '?' + params.toString(), { headers: { 'x-token': APTLY_TOK } });
      if (!resp.ok) break;
      const batch = await resp.json();
      const items = Array.isArray(batch) ? batch : (batch&&batch.data)||[];
      if (items.length === 0) break;
      all = all.concat(items);
      if (items.length < 100) break;
      pg++;
    }
    return all;
  }

  async function fetchAptlySchema2(boardId) {
    try {
      const resp = await fetch(APTLY_BASE2 + '/api/schema/' + boardId, { headers: { 'x-token': APTLY_TOK } });
      if (!resp.ok) return {};
      const fields = await resp.json();
      const map = {};
      if (Array.isArray(fields)) fields.forEach(f => { map[f.key] = f.label; });
      return map;
    } catch(e) { return {}; }
  }

  const [offboardSchema, pmaSchema, renewalSchema, moveOutSchema, moveInSchema] = await Promise.all([
    fetchAptlySchema2('BaMiriNFDZBtWd5rR'),
    fetchAptlySchema2('QySZ8yRWJ5KeYFcZt'),
    fetchAptlySchema2('86YrLPbwdkxtdyZoj'),
    fetchAptlySchema2('YA3QWmPebvMwLwbB3'),
    fetchAptlySchema2('K9mMGGjKgQPqDykaa'),
  ]);

  const resolveFields = (card, schemaMap) => {
    const resolved = Object.assign({}, card);
    Object.keys(schemaMap).forEach(uuid => { if (uuid in card) resolved[schemaMap[uuid]] = card[uuid]; });
    return resolved;
  };

  const [allApps, unitsCards, allLeadsRaw, allPMARaw, allOffboardRaw, allMoveOuts, allWOsRaw, allRenewalsRaw, allMoveIns, fetchedMoveOutReasons] = await Promise.all([
    fetchAptlyBoard('MJxaStgENouWrNEKd', { maxPages: 10, params: { includeArchived: true } }),
    getUnitsCards(),
    fetchAptlyBoard('4EMDSYKirhQaNdQKz', { maxPages: 2, params: { includeArchived: false } }),
    fetchAptlyBoard('QySZ8yRWJ5KeYFcZt', { maxPages: 15, params: { includeArchived: true } }),
    fetchAptlyBoard('BaMiriNFDZBtWd5rR', { maxPages: 2, params: { includeArchived: true } }),
    fetchAptlyBoard('YA3QWmPebvMwLwbB3', { maxPages: 5, params: { includeArchived: true } }),
    fetchAptlyBoard('workOrder', { maxPages: 2, params: { includeArchived: false } }),
    fetchAptlyBoard('86YrLPbwdkxtdyZoj', { maxPages: 5, params: { includeArchived: true } }),
    (async () => { const mi2=[]; for(let p2=0;p2<5;p2++){try{const r2=await fetch('https://core-api.getaptly.com/api/board/K9mMGGjKgQPqDykaa?page='+p2+'&pageSize=100&includeArchived=false',{headers:{'x-token':'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso='}});const b2=await r2.json();const it2=Array.isArray(b2)?b2:(b2&&b2.data||[]);if(!it2.length)break;mi2.push(...it2);if(it2.length<100)break;}catch(e){break;}}console.log('MoveIns:',mi2.length);return mi2;})(),
    fetchMoveOutReasons(),
  ]);

  const allPMA = allPMARaw.map(c => resolveFields(c, pmaSchema));
  const allOffboard = allOffboardRaw.map(c => resolveFields(c, offboardSchema));
  const allRenewals = allRenewalsRaw.map(c => resolveFields(c, renewalSchema));
  const allWOs = allWOsRaw.filter(c => !c.archived && !/closed|cancelled|complete/i.test(c.stage||''));

  const publishedListings = unitsCards.filter(c => c['Published For Rent']==='checked'||c['Published For Rent']===true||c['Syndicate']==='checked');
  const nowMs = Date.now();

  // Expirations from Tenant Renewals board
  const expirationsByMonth = buildMonthBuckets(24);
  let upcomingExpirations = 0;
  const in90 = new Date(); in90.setDate(in90.getDate() + 90);
  const renewalCardDetails = [];
  allRenewals.forEach(card => {
    let endDate = card['Mirror End Date'];
    if (!endDate && card.Title) { const m = card.Title.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) endDate = m[3]+'-'+m[1]+'-'+m[2]; }
    if (!endDate) return;
    const ek = monthKey(endDate);
    if (ek && expirationsByMonth[ek] !== undefined) expirationsByMonth[ek]++;
    if (new Date(endDate) >= now && new Date(endDate) <= in90 && !card['Is Won']) upcomingExpirations++;
    if (ek) renewalCardDetails.push({ address: card['Mirror Address']?card['Mirror Address'].address:'', endDate, monthKey: ek, stage: card.Stage||'', isWon: card['Is Won']||false });
  });

  // Applications
  const appsByMonth = buildMonthBuckets(24);
  const appsApprovedByMonth = buildMonthBuckets(24);
  let appsMTD = 0, appsApprovedMTD = 0;
  const appStatusCounts = {};
  let appRevenueMTD = 0;
  const appRevenueByMonth = buildMonthBuckets(24);

  allApps.forEach(card => {
    const createdDate = card.appCreated || card.createdAt;
    const k = monthKey(createdDate);
    if (k && appsByMonth[k] !== undefined) appsByMonth[k]++;
    if (k === TMK) appsMTD++;
    const statusObj = card.appStatus || card.Status || {};
    const statusLabel = statusObj.status || '';
    if (statusLabel) appStatusCounts[statusLabel] = (appStatusCounts[statusLabel]||0) + 1;
    const isApproved = (statusObj.uuid||'').includes('approved') || card.appStatusIsApproved === true;
    if (isApproved) { if (k && appsApprovedByMonth[k] !== undefined) appsApprovedByMonth[k]++; if (k===TMK) appsApprovedMTD++; }
    const payments = card.appPayments || [];
    if (Array.isArray(payments)) payments.forEach(p => { const amt = p.amount ? parseFloat(p.amount.amount||0)/100 : 0; if (amt>0&&k) { if (appRevenueByMonth[k]!==undefined) appRevenueByMonth[k]+=amt; if (k===TMK) appRevenueMTD+=amt; } });
  });

  // Owner pipeline
  const newLeadsByMonth = buildMonthBuckets(24);
  let newLeadsMTD = 0;
  allPMA.forEach(card => { const k = monthKey(card.createdAt); if (k && newLeadsByMonth[k] !== undefined) newLeadsByMonth[k]++; if (k===TMK) newLeadsMTD++; });

  const pmaSignedByMonth = buildMonthBuckets(24);
  let pmaSignedMTD = 0;
  allPMA.filter(c => (c.stage||'') === 'PMA Signed').forEach(card => {
    const sk = monthKey(card.stageUpdatedAt || card.createdAt);
    if (sk && pmaSignedByMonth[sk] !== undefined) pmaSignedByMonth[sk]++;
    if (sk === TMK) pmaSignedMTD++;
  });

  const lostByMonth = buildMonthBuckets(48);
  const lostReasons = {};
  let lostMTD = 0;
  allPMA.filter(c => (c.stage||'') === 'Lost').forEach(card => {
    const k = monthKey(card.stageUpdatedAt || card.createdAt);
    if (k && lostByMonth[k] !== undefined) lostByMonth[k]++;
    if (k === TMK) lostMTD++;
    const reason = card['Lost Reason'] || card.lostReason || '';
    if (reason) lostReasons[reason] = (lostReasons[reason]||0) + 1;
  });

  // End management
  const endMgmtByMonth = buildMonthBuckets(24);
  const endMgmtReasons = {};
  let endMgmtMTD = 0;
  const seenEndMgmt = new Set();
  allOffboard.forEach(card => {
    const contractEnd = card['Mirror Date Contract Ends'];
    if (!contractEnd) return;
    const ek = monthKey(contractEnd);
    const title = (card.Title||card.name||'').trim();
    const streetNum = title.match(/^(\d+)/)?.[1] || title;
    const dedupKey = streetNum + '|' + ek;
    if (seenEndMgmt.has(dedupKey)) return;
    seenEndMgmt.add(dedupKey);
    if (ek && endMgmtByMonth[ek] !== undefined) endMgmtByMonth[ek]++;
    if (ek === TMK) endMgmtMTD++;
    const reason = card['Reason'] || '';
    if (reason) endMgmtReasons[reason] = (endMgmtReasons[reason]||0) + 1;
  });

  // Work orders
  const woByStage = {};
  allWOs.forEach(c => { const s = c.stage||'Unknown'; woByStage[s] = (woByStage[s]||0)+1; });
  const unassignedWOs = allWOs.filter(c => (Array.isArray(c.vendor)?c.vendor:(c.vendor?[c.vendor]:[])).length===0).length;

  // Comprehensive inspections
  let comprehensiveInspYes = 0, comprehensiveInspNo = 0;
  allMoveOuts.forEach(card => {
    const val = String(card['Comprehensive Inspection']||'').trim().toLowerCase();
    if (val==='yes') comprehensiveInspYes++; else if (val==='no') comprehensiveInspNo++;
  });

  const formatTrend = obj => Object.entries(obj).sort().map(([month, value]) => ({ month, value }));

  const propTrend = Object.keys(propGainedByMonth).sort().map(k => ({ month: k, gained: propGainedByMonth[k]||0, total: 0 }));
  let running = allProps.length;
  for (let i = propTrend.length-1; i >= 0; i--) { propTrend[i].total = running; running -= propTrend[i].gained; if (running < 0) running = 0; }

  // needsUpdatedAgreement and preTenancyCancellations
  const allPropertyContracts = await fetchAllPropertyContracts();
  const nowDate = new Date(); nowDate.setHours(0,0,0,0);
  const needsUpdatedAgreement = allPropertyContracts.filter(function(p) {
    return p.isActive && p.dateContractEnds && p.dateContractEnds < nowDate;
  }).map(function(p) {
    return { address: p.address, city: '', dateContractEnds: p.dateContractEnds.toISOString().slice(0,10) };
  });
  const propIDsWithLeases = new Set();
  activeLeases.concat(closedLeases).forEach(function(l) {
    const pid = l.propertyID || (l._property && l._property.propertyID);
    if (pid) propIDsWithLeases.add(String(pid));
  });
  const preTenancyCancellations = [];
  let preTenancyMTD = 0;
  allPropertyContracts.forEach(function(p) {
    if (p.isActive) return;
    if (!p.dateContractEnds || p.dateContractEnds > nowDate) return;
    if (!p.dateContractBegins) return;
    if (propIDsWithLeases.has(String(p.propertyID))) return;
    const ek = p.dateContractEnds.getFullYear() + '-' + String(p.dateContractEnds.getMonth()+1).padStart(2,'0');
    preTenancyCancellations.push({ address: p.address, city: '', dateContractBegins: p.dateContractBegins.toISOString().slice(0,10), dateContractEnds: p.dateContractEnds.toISOString().slice(0,10) });
    if (ek === TMK) preTenancyMTD++;
  });
  console.log('needsUpdatedAgreement:', needsUpdatedAgreement.length, '| preTenancyCancellations:', preTenancyCancellations.length);

  const vacantUnitsList = activeUnits.filter(item => isUnitVacant(item.unit||item)).map(item => { const u = item.unit||item; const p2 = item.property||{}; return { address: u.address||p2.address||'—', city: u.city||p2.city||'', beds: u.bedrooms||u.beds||'', baths: u.bathrooms||u.baths||'', rent: parseFloat(u.marketRent||u.rent||0) }; }).sort((a,b) => (a.address||'').localeCompare(b.address||''));

  console.log('Metrics: fetched in', Math.round((Date.now()-fetchStart)/1000), 's');
  return {
    generatedAt: new Date().toISOString(),
    thisMonth: TMK,
    portfolio: {
      activeProperties: allProps.filter(i => { const p=i.property||i; return p.isActive===true||p.isActive===1||p.isActive==='1'; }).length,
      totalUnits, occupiedUnits, vacantUnits, occupancyRate, avgRent, vacancyLoss, totalRentExpected,
      pastDueTenants: pastDueTenants.sort((a,b)=>b.pastDueRent-a.pastDueRent),
      totalPastDue: Math.round(totalPastDue*100)/100,
      pastDueCount: pastDueTenants.length,
      gainedMTD: propGainedMTD,
      activeListings: publishedListings.length,
      propGainedTrend: formatTrend(propGainedByMonth),
      propTrend, vacantUnitsList, preTenancyCancellations, preTenancyMTD,
    },
    leases: {
  active: activeLeases.length, moveInsMTD, moveOutsMTD, upcomingExpirations,
  moveInsByMonth: formatTrend(moveInsByMonth),
  moveOutsByMonth: formatTrend(moveOutsByMonth),
  expirationsByMonth: formatTrend(expirationsByMonth),
  renewalsDetail: renewalCardDetails.sort((a,b)=>(a.endDate||'').localeCompare(b.endDate||'')),
  moveOutReasons: Object.entries(fetchedMoveOutReasons||{}).sort((a,b)=>(b[1].count||b[1])-(a[1].count||a[1])).map(([reason,val])=>({reason, count: val.count||val, avgTenancyMonths: val.avgTenancyMonths||null})),
  moveOutReasonRaw: moveOutReasonRaw.sort((a,b)=>(b.moveOutDate||'').localeCompare(a.moveOutDate||'')),
  moveOutsDetail: allMoveOuts.map(c => resolveFields(c, moveOutSchema || {})).filter(c => {
    const d = c['Mirror Expected Move-Out Date'] || c['Mirror Move-Out Date'] || c.moveOutDate || '';
    if (!d) return false;
    const dt = new Date(d);
    return dt >= new Date(Date.now() - 90*24*60*60*1000) && dt <= new Date(Date.now() + 90*24*60*60*1000);
  }).sort((a,b) => ((a['Mirror Expected Move-Out Date']||a['Mirror Move-Out Date']||'')).localeCompare((b['Mirror Expected Move-Out Date']||b['Mirror Move-Out Date']||''))).map(c => {
    const addr = c['Mirror Address'];
    const unit = Array.isArray(c.unit) ? c.unit[0] : null;
    const addrStr = (addr ? (addr.address || addr.name || '') : '') ||
      (unit ? unit.name || '' : '') ||
      (c.name ? c.name.replace(/^\d{2}\/\d{2}\/\d{4}\s+/, '') : '');
    return {
      address: addrStr.replace(/^\d{2}\/\d{2}\/\d{4}\s+/, ''),
      owners: '',
      moveOutDate: c['Mirror Expected Move-Out Date'] || c['Mirror Move-Out Date'] || c['qzxyfAG7v7W9ECSAT'] || '',
      stage: c.Stage || c.stage || '',
      moveOutType: c['Move-Out Type'] || 'Standard',
      depositAmount: c['Mirror Deposit Balance'] && c['Mirror Deposit Balance'].amount ? parseFloat(c['Mirror Deposit Balance'].amount) : 0,
      tenantBalance: c['Mirror Current Balance'] && c['Mirror Current Balance'].amount ? parseFloat(c['Mirror Current Balance'].amount) : 0,
      comprehensiveInspection: c['bvrv4hKYmrXYiLpz6'] || null,
      forwardingAddress: c['ifRegTvMnfuYrpxYi'] || null,
      inspectionReceived: c['sFEaFREB74qPN8pgM'] || false,
      owners: Array.isArray(c['ACRj6PevEsB3e56bk']) ? c['ACRj6PevEsB3e56bk'].map(function(o){return o.name||'';}).filter(Boolean).join(', ') : '',
      tenant: Array.isArray(c.relatedContacts) ? c.relatedContacts.map(function(t){return t.name||'';}).filter(Boolean).join(', ') : '',
    };
  }),
},
    applications: {
      totalMTD: appsMTD, approvedMTD: appsApprovedMTD,
      revenueMTD: Math.round(appRevenueMTD*100)/100,
      totalAllTime: allApps.length,
      statusCounts: appStatusCounts,
      byMonth: formatTrend(appsByMonth),
      approvedByMonth: formatTrend(appsApprovedByMonth),
      revenueByMonth: formatTrend(appRevenueByMonth),
    },
    pipeline: {
      signedMTD: pmaSignedMTD, newLeadsMTD, lostMTD,
      signedByMonth: formatTrend(pmaSignedByMonth),
      newLeadsByMonth: formatTrend(newLeadsByMonth),
      lostByMonth: formatTrend(lostByMonth),
      lostReasons: Object.entries(lostReasons).sort((a,b)=>b[1]-a[1]).map(([reason,count])=>({reason,count})),
    },
    endManagement: {
      totalMTD: endMgmtMTD,
      byMonth: formatTrend(endMgmtByMonth),
      reasons: Object.entries(endMgmtReasons).sort((a,b)=>b[1]-a[1]).map(([reason,count])=>({reason,count})),
      needsUpdatedAgreement,
    },
    comprehensiveInspections: { yes: comprehensiveInspYes, no: comprehensiveInspNo, total: comprehensiveInspYes+comprehensiveInspNo },
    moveIns: {
      detail: (allMoveIns || []).map(c => {
        const addr = c['RAvYxpMZhecrfhHix'];
        const addrStr = addr ? (addr.address || addr.formattedAddress || '') : '';
        const residents = Array.isArray(c['7WazLLghdLMuB7ZbH']) ? c['7WazLLghdLMuB7ZbH'].map(r=>r.name).join(', ') : '';
        const rent = c['ywKZ6NWs4prtxMdFg'] ? parseFloat(c['ywKZ6NWs4prtxMdFg'].amount||0) : 0;
        const deposit = c['ZKHT9oAr2yKrjdzTn'] ? parseFloat(c['ZKHT9oAr2yKrjdzTn'].amount||0) : 0;
        const tasks = Array.isArray(c.checklist) ? c.checklist : [];
        const owners = Array.isArray(c['NhjeRjuM9c7kBX3mr']) ? c['NhjeRjuM9c7kBX3mr'].map(p=>p.name).join(', ') : '';
        const miDate = c['c6jX35soCHuxpuE7w'] || '';
        return {
          address: addrStr,
          city: addr ? addr.city : '',
          moveInDate: miDate,
          leaseEndDate: c['5hwxgTSsW8j9WZ8HJ'] || '',
          stage: c.stage || '',
          residents: residents,
          rent: rent,
          deposit: deposit,
          depositPaid: c['4XNqffNAGTT3AfTdz'] || false,
          leaseSigned: c['atJaeXPXKTg38EgEx'] || false,
          insuranceCompany: c['b5WBGadm45xMK3kxR'] || '',
          insuranceExpDate: c['Sn8WvCo9WiXYdNMf9'] || '',
          electricConfirmed: c['neRBuyDSMBQnkNKRR'] || false,
          waterConfirmed: c['9JZkLsAkzjbdZZwje'] || false,
          trashConfirmed: c['YokyGKYwSdi39dAco'] || false,
          gasStatus: c['jyFfk3FSqEBRy2yTv'] || '',
          keys: c['xQS4Wqc4fCHrGYjCx'] || '',
          pets: c['aBLz2M8vReHoceSCX'] || 'No pets',
          pool: c['Jw5gRfbcJNk7PdmAu'] || 'No',
          tasksTotal: tasks.length,
          tasksDone: tasks.filter(t=>t.checked).length,
          owners: owners,
          mgmtFeeType: miDate ? (new Date(miDate).getDate() <= 14 ? 'Full Month' : 'Prorated') : 'Unknown',
        };
      }).sort((a,b) => (a.moveInDate||'').localeCompare(b.moveInDate||'')),
    },
    workOrders: {
      openTotal: allWOs.length, unassigned: unassignedWOs,
      byStage: Object.entries(woByStage).sort((a,b)=>b[1]-a[1]).map(([stage,count])=>({stage,count})),
    },
  };
}


// ---- Walkthrough Schedule ----
let _walkCache = null, _walkCacheTime = 0;
app.get('/api/walkthrough-schedule', async (req, res) => {
  try {
    const now = Date.now();
    if (_walkCache && (now - _walkCacheTime) < 15*60*1000) return res.json(_walkCache);
    const r = await fetch('https://docs.google.com/spreadsheets/d/1b5qlwlEo8avsSRbm2id1ocN0Eh5KmvvKPHsiEoDWngk/export?format=csv&gid=0');
    const csv = await r.text();
    const walks = [];
    csv.split('\n').slice(1).forEach(line => {
      if (!line.trim()) return;
      const cols = line.split(',').map(c => c.replace(/^"|"$/g,'').trim());
      const addr = cols[0]||'', walkDate = cols[2]||'', walkType = cols[5]||'';
      const m = addr.match(/^(\d+)/);
      if (m && walkDate) walks.push({ address: addr, streetNum: m[1], walkDate, walkType, isMoveOut: /move.?out|comprehensive|vacating/i.test(walkType) });
    });
    _walkCache = { walks, updatedAt: new Date().toISOString() };
    _walkCacheTime = now;
    res.json(_walkCache);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ---- Move-Out Charge Recon ----
async function fetchMoveOutChargeRecon() {
  try {
    const windowStart = new Date(Date.now() - 90*86400000).toISOString().slice(0,10);
    const windowEnd = new Date().toISOString().slice(0,10);
    const glWindowStart = new Date(Date.now() - 120*86400000).toISOString().slice(0,10);

    // 1. Real move-outs in the last 90 days - anchored on closedDate, not moveOutDate.
    //    moveOutDate is often left blank even on fully closed leases; closedDate is reliable.
    const leaseReport = {
      displayColumns: ['leaseID', 'propertyID', 'unitID', 'unitAddress', 'portfolioID', 'primaryTenantName', 'moveInDate', 'moveOutDate', 'expectedMoveOutDate', 'closedDate'],
      filters: [
        { name: 'closedDate', comparator: 'betweenDate', startDate: windowStart, endDate: windowEnd }
      ]
    };
    const lUrl = RENTVINE_BASE + '/reports/lease?exportTypeID=1&json=' + encodeURIComponent(JSON.stringify(leaseReport));
    const lRes = await fetch(lUrl, { headers: { Authorization: 'Basic ' + RENTVINE_AUTH } });
    const moveOuts = [];
    const leaseIDs = [];
    const propertyIDs = [];
    const portfolioIDs = [];
    if (lRes.ok) {
      const ld = await lRes.json();
      const rows = ld.rows || [];
      console.log('ChargeRecon: lease report returned', rows.length, 'closed leases in the last 90 days');
      rows.forEach(function(row) {
        const d = row.data || {};
        if (!d.leaseID || !d.propertyID) return;
        const pid = d.portfolioID || '';
        moveOuts.push({
          leaseID: d.leaseID,
          propertyID: d.propertyID,
          unitID: d.unitID || '',
          addr: d.unitAddress || '',
          portfolioID: pid,
          portfolio: '',
          tenant: d.primaryTenantName || '',
          moveIn: d.moveInDate || '',
          moveOut: d.moveOutDate || d.expectedMoveOutDate || d.closedDate || '',
          closedDate: d.closedDate || ''
        });
        leaseIDs.push(d.leaseID);
        propertyIDs.push(d.propertyID);
        if (pid) portfolioIDs.push(pid);
      });
    } else {
      console.error('ChargeRecon: lease report error', lRes.status);
    }

    if (!moveOuts.length) return { moveOuts: [] };

    // 1b. Resolve portfolio names in bulk (mirrors the existing properties/export pagination pattern).
    const portfolioNames = {};
    try {
      for (let pg = 1; pg <= 5; pg++) {
        const pfRes = await fetch(RENTVINE_BASE + '/portfolios/export?pageSize=200&page=' + pg, { headers: { Authorization: 'Basic ' + RENTVINE_AUTH } });
        console.log('ChargeRecon: portfolio fetch page', pg, 'status', pfRes.status);
        if (!pfRes.ok) break;
        const pfData = await pfRes.json();
        console.log('ChargeRecon: portfolio raw response sample', JSON.stringify(pfData).slice(0, 500));
        const batch = Array.isArray(pfData) ? pfData : (pfData.data || []);
        batch.forEach(function(item) {
          const p = item.portfolio || item;
          const pid = String(p.portfolioID || p.id || '');
          if (pid) portfolioNames[pid] = p.name || p.portfolioName || '';
        });
        if (batch.length < 200) break;
      }
      console.log('ChargeRecon: portfolio map has', Object.keys(portfolioNames).length, 'entries');
    } catch (pfErr) {
      console.error('ChargeRecon: portfolio lookup failed, continuing without names', pfErr.message);
    }
    moveOuts.forEach(function(m) {
      m.portfolio = portfolioNames[String(m.portfolioID)] || '';
    });

    // 2. Tenant charges - exact account 135 (6000), exact lease IDs. No keyword guessing.
    const chargeReport = {
      displayColumns: ['leaseID', 'datePosted', 'amount', 'description'],
      filters: [
        { name: 'leaseID', comparator: 'in', values: leaseIDs },
        { name: 'chargeAccountID', comparator: 'equals', value: 135 }
      ]
    };
    const cUrl = RENTVINE_BASE + '/reports/lease-charges?exportTypeID=1&json=' + encodeURIComponent(JSON.stringify(chargeReport));
    const cRes = await fetch(cUrl, { headers: { Authorization: 'Basic ' + RENTVINE_AUTH } });
    const chargesByLease = {};
    if (cRes.ok) {
      const cd = await cRes.json();
      const rows = cd.rows || [];
      console.log('ChargeRecon: lease-charges (6000) returned', rows.length, 'rows');
      rows.forEach(function(row) {
        const d = row.data || {};
        const lid = d.leaseID;
        if (!lid) return;
        const amt = parseFloat(d.amount || 0);
        if (amt <= 0) return;
        if (!chargesByLease[lid]) chargesByLease[lid] = [];
        chargesByLease[lid].push({ date: d.datePosted || '', amount: amt, description: (d.description || '').slice(0,80) });
      });
    } else {
      console.error('ChargeRecon: lease-charges error', cRes.status);
    }

    // 3. Property bills - exact property IDs, exact accounts 74/75, accrual basis so unpaid bills are included.
    const glReport = {
      displayColumns: ['propertyID', 'datePosted', 'debit', 'description', 'accountName'],
      filters: [
        { name: 'property', comparator: 'in', values: propertyIDs },
        { name: 'account', comparator: 'in', values: [74, 75] },
        { name: 'datePosted', comparator: 'betweenDate', startDate: glWindowStart, endDate: windowEnd },
        { name: 'accountingBasis', comparator: 'basisAccrual' }
      ]
    };
    const gUrl = RENTVINE_BASE + '/reports/general-ledger?exportTypeID=1&json=' + encodeURIComponent(JSON.stringify(glReport));
    const gRes = await fetch(gUrl, { headers: { Authorization: 'Basic ' + RENTVINE_AUTH } });
    const billsByProperty = {};
    if (gRes.ok) {
      const gd = await gRes.json();
      const rows = gd.rows || [];
      console.log('ChargeRecon: general-ledger (6070-1/2) returned', rows.length, 'rows');
      rows.forEach(function(row) {
        const d = row.data || {};
        const pid = d.propertyID;
        if (!pid) return;
        const amt = parseFloat(d.debit || 0);
        if (amt <= 0) return;
        const acctName = (d.accountName || '').indexOf('Cleaning') >= 0 ? '6070-1 Tenant Cleaning' : '6070-2 Tenant Repair Charges';
        if (!billsByProperty[pid]) billsByProperty[pid] = [];
        billsByProperty[pid].push({ date: d.datePosted || '', amount: amt, description: (d.description || '').slice(0,80), account: acctName });
      });
    } else {
      console.error('ChargeRecon: general-ledger error', gRes.status);
    }

    // 4. Assemble one record per move-out, itemized charges and bills attached directly
    moveOuts.forEach(function(m) {
      m.charges = chargesByLease[m.leaseID] || [];
      m.bills = billsByProperty[m.propertyID] || [];
    });

    console.log('ChargeRecon: assembled', moveOuts.length, 'move-out records for the last 90 days');
    return { moveOuts: moveOuts };
  } catch(e) {
    console.error('fetchMoveOutChargeRecon error:', e.message);
    return { moveOuts: [] };
  }
}

app.get('/suppressed-fees', (req, res) => res.sendFile(new URL('./suppressed-fees.html', import.meta.url).pathname));

// ── Property Map ──────────────────────────────────────────────────────────


app.get('/api/map-units-debug', async (req, res) => {
  try {
    const data = await rvFetch('/properties/units/export', { pageSize: 5, page: 1 });
    const rows = Array.isArray(data) ? data : (data.data || []);
    res.json({ count: rows.length, sample: rows.slice(0,3).map(r => ({ isVacant: (r.unit||r).isVacant, unitID: (r.unit||r).unitID, address: (r.unit||r).address })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/map-debug', async (req, res) => {
  try {
    const data = await rvFetch('/properties/export', { pageSize: 5, page: 1 });
    const rows = Array.isArray(data) ? data : (data.data || []);
    res.json({ count: rows.length, sample: rows.slice(0,2) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/map', (req, res) => res.sendFile(new URL('./map.html', import.meta.url).pathname));

const _geocodeCache = {};
async function geocodeAddress(address, city) {
  const key = `${address}|${city}`.toLowerCase();
  if (_geocodeCache[key]) return _geocodeCache[key];
  const q = encodeURIComponent(`${address}, ${city}, Arizona, USA`);
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`, {
      headers: { 'User-Agent': 'AloePropertyMap/1.0 (hub.aloepm.com)' }
    });
    const d = await r.json();
    if (d.length) {
      const coords = { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) };
      _geocodeCache[key] = coords;
      return coords;
    }
  } catch (e) { console.error('Geocode error:', e.message); }
  return null;
}

let _mapPropertiesCache = null;
let _mapPropertiesCacheTime = 0;
const MAP_CACHE_TTL = 4 * 60 * 60 * 1000;

app.get('/api/map-properties', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    const now = Date.now();
    if (!forceRefresh && _mapPropertiesCache && (now - _mapPropertiesCacheTime) < MAP_CACHE_TTL) {
      return res.json({ properties: _mapPropertiesCache, cached: true, count: _mapPropertiesCache.length });
    }
    console.log('[map] Fetching active properties...');
    let allProps = [], page = 1;
    while (true) {
      const data = await rvFetch('/properties/export', { pageSize: 200, page });
      const rows = Array.isArray(data) ? data : (data.data || []);
      allProps = allProps.concat(rows);
      if (rows.length < 200) break;
      page++;
    }
    allProps = allProps.filter(r => { const p = r.property || r; return p.isActive === true || p.isActive === 1 || p.isActive === "1"; });
    console.log(`[map] ${allProps.length} active properties`);
    let allUnits = []; page = 1;
    while (true) {
      const data = await rvFetch('/properties/units/export', { pageSize: 200, page });
      const rows = Array.isArray(data) ? data : (data.data || []);
      allUnits = allUnits.concat(rows);
      if (rows.length < 200) break;
      page++;
    }
    const unitsByProp = {};
    allUnits.forEach(r => {
      const u = r.unit || r; const p = r.property || {};
      const propId = u.propertyID || p.propertyID;
      if (!propId) return;
      if (!unitsByProp[propId]) unitsByProp[propId] = [];
      unitsByProp[propId].push(u);
    });
    const properties = allProps.map(r => {
      const p = r.property || r;
      const units = unitsByProp[p.propertyID] || [];
      const isVacant = units.length === 0 ? false : units.every(u => u.isVacant === true || u.isVacant === 1 || u.isVacant === "1");
      const u = units[0] || {};
      const lat = parseFloat(p.latitude || 0);
      const lng = parseFloat(p.longitude || 0);
      return {
        propertyID: p.propertyID,
        address: (p.address || p.streetAddress || '').trim(),
        city: p.city || '',
        beds: u.bedrooms || u.beds || null,
        baths: u.bathrooms || u.baths || null,
        rent: u.marketRent || u.rent || null,
        isVacant, unitCount: units.length,
        lat: lat || null,
        lng: lng || null
      };
    }).filter(p => p.address);
    const geocoded = properties.filter(p => p.lat && p.lng).length;
    console.log(`[map] Using Rentvine coordinates: ${geocoded}/${properties.length} have lat/lng`);
    _mapPropertiesCache = properties;
    _mapPropertiesCacheTime = Date.now();
    res.json({ properties, cached: false, count: properties.length, geocoded });
  } catch (e) {
    console.error('[map] Error:', e);
    res.status(500).json({ error: e.message });
  }
});


// ── zInspector Proxy ──
app.use('/api/zinspector', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  const ziKey = process.env.ZINSPECTOR_API_KEY;
  if (!ziKey) return res.status(500).json({ error: 'ZINSPECTOR_API_KEY not set on server' });
  const ziPath = req.path;
  const query = new URLSearchParams(req.query).toString();
  const url = `https://portfolio.zinspector.com${ziPath}${query ? '?' + query : ''}`;
  try {
    const r = await fetch(url, {
      headers: {
        'x-api-key': ziKey,
        'Accept': 'application/json',
        'Origin': 'https://aloe-internal-hub-1089452383500.us-west4.run.app',
        'Referer': 'https://aloe-internal-hub-1089452383500.us-west4.run.app/'
      }
    });
    res.status(r.status).json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ── End zInspector Proxy ──

// ── Aptly Proxy Routes ─────────────────────────────────────────────────────
const APTLY_API_TOKEN = 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';
const APTLY_API_BASE = 'https://core-api.getaptly.com';
const HUB_SECRET = process.env.HUB_INTERNAL_SECRET;

async function aptlyCall(method, path, body = null) {
  const opts = {
    method,
    headers: { 'x-token': APTLY_API_TOKEN, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${APTLY_API_BASE}${path}`, opts);
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch(e) { return { status: res.status, data: text }; }
}

function hubAuth(req, res, next) {
  if (req.headers['x-hub-token'] !== HUB_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

initCustomFieldUpdateRoutes(app, { RENTVINE_BASE, RENTVINE_AUTH, RENTVINE_ACCOUNT, SLACK_TOKEN: process.env.SLACK_TOKEN, hubAuth });

app.get('/api/aptly/cards/search', hubAuth, async (req, res) => {
  try {
    const { query = '', stage = '', limit = '10' } = req.query;
    const q = query.toLowerCase();
    const stageFilter = stage.toLowerCase();
    let allCards = [];
    for (let page = 0; page <= 100; page++) {
      const data = await unitsFetch('/api/board/workOrder', { page, pageSize: 100, includeArchived: false });
      const batch = Array.isArray(data) ? data : ((data && data.data) || []);
      if (!batch.length) break;
      allCards = allCards.concat(batch);
      if (batch.length < 100) break;
    }
    let filtered = allCards;
    if (q) filtered = filtered.filter(c => JSON.stringify(c).toLowerCase().includes(q));
    if (stageFilter) filtered = filtered.filter(c => (c.stage || '').toLowerCase().includes(stageFilter));
    const maxItems = Math.min(parseInt(limit) || 10, 50);
    res.json({ items: filtered.slice(0, maxItems).map(c => {
      const unitAddr = Array.isArray(c.unit) && c.unit[0] ? c.unit[0].name : '';
      const locAddr = Array.isArray(c.location) && c.location[0] ? c.location[0].name : '';
      const city = c['x8524dtbdHzHhdsYR'] || '';
      const streetAddress = unitAddr || locAddr || c.address || '';
      const address = streetAddress + (city ? ', ' + city + ', AZ' : '');
      const vendorName = Array.isArray(c.vendor) && c.vendor[0] ? c.vendor[0].name : c.vendorName || '';
      return { id: c.cardId, title: c.name, stage: c.stage, priority: c.priority, address, vendor: vendorName, woNumber: c.workOrderNumber };
    }), total: filtered.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/aptly/cards/:id', hubAuth, async (req, res) => {
  try {
    const data = await unitsFetch('/api/board/workOrder/' + req.params.id);
    const c = (data && data.data) || data;
    res.json({ 
    id: c.cardId, title: c.name, stage: c.stage, priority: c.priority, 
    description: c.description, address: c.address, 
    vendor: c.vendor ? c.vendor.map(v => v.name).join(', ') : '',
    woNumber: c.workOrderNumber,
    maintenanceCategory: c.maintenanceCategory, 
    maintenanceNotes: c['F26dyKdxBuz56YTPA'] || c.maintenanceNotes || '',
    maintenanceLimit: c['vL9npBewrXTyxrn8c'] ? c['vL9npBewrXTyxrn8c'].amount : null,
    homeWarranty: c['3PvcEJoFBQLnjHnd6'] || c.homeWarranty || '',
    issueType: c['nfEujqs3ujMNgMFom'] || '',
    pestControl: c.pestControl || '',
    landscaping: c.landscaping || '',
    ownerApproved: c.isOwnerApproved,
    vacant: c.isVacant,
  });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/aptly/cards', hubAuth, async (req, res) => {
  try {
    const data = await unitsFetch('/api/board/workOrder', {}, 'POST', req.body);
    res.json((data && data.data) || data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/aptly/cards/:id', hubAuth, async (req, res) => {
  try {
    const unitsToken = process.env.APTLY_UNITS_TOKEN || process.env.APTLY_TOKEN || '';
    // Aptly update: POST /api/board/workOrder with cardId in body
    const body = { _id: req.params.id, ...req.body };
    const r = await fetch('https://core-api.getaptly.com/api/board/workOrder', {
      method: 'POST',
      headers: { 'x-token': unitsToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/aptly/cards/:id/comment', hubAuth, async (req, res) => {
  try {
    const unitsToken = process.env.APTLY_UNITS_TOKEN || process.env.APTLY_TOKEN || '';
    const r = await fetch('https://core-api.getaptly.com/api/board/workOrder/' + req.params.id + '/comment', {
      method: 'POST',
      headers: { 'x-token': unitsToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/aptly/cards/:id/comments', hubAuth, async (req, res) => {
  try {
    const cardId = req.params.id;
    // Search the board and find the full card with comments
    let foundCard = null;
    for (let page = 0; page <= 100; page++) {
      const data = await unitsFetch('/api/board/workOrder', { page, pageSize: 100, includeArchived: false });
      const batch = Array.isArray(data) ? data : ((data && data.data) || []);
      if (!batch.length) break;
      foundCard = batch.find(c => c.cardId === cardId);
      if (foundCard) break;
      if (batch.length < 100) break;
    }
    if (!foundCard) return res.status(404).json({ error: 'Card not found' });
    const comments = (foundCard.comments) || [];
    res.json({ comments: comments.map(cm => ({ user: cm.userName || cm.userId, content: cm.content, date: cm.createdAt })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rentvine/work-orders/:id/notes', hubAuth, async (req, res) => {
  try {
    const idOrNum = req.params.id;
    const results = await rvFetch('/maintenance/work-orders', { pageSize: 50, page: 1, search: idOrNum });
    const found = (Array.isArray(results) ? results : []).find(r => String(r.workOrder.workOrderNumber) === String(idOrNum) || String(r.workOrder.workOrderID) === String(idOrNum));
    if (!found) return res.status(404).json({ error: 'WO not found', idOrNum });
    const internalId = found.workOrder.workOrderID;
    const notes = await rvFetch('/notes', { objectTypeID: 16, objectID: internalId, pageSize: 50 });
    res.json({ workOrder: { id: internalId, number: found.workOrder.workOrderNumber, description: (found.workOrder.description||'').slice(0,200) }, notes: Array.isArray(notes) ? notes.map(n => ({ author: n.createdByName||n.author, content: n.note||n.content, date: n.datePosted||n.createdAt })) : [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});;;

app.get('/api/debug/rv-wo-search', hubAuth, async (req, res) => {
  try {
    const { q } = req.query;
    const data = await rvFetch('/maintenance/work-orders', { pageSize: 10, page: 1, search: q });
    res.json({ type: Array.isArray(data) ? 'array' : typeof data, length: Array.isArray(data) ? data.length : null, keys: Array.isArray(data) && data[0] ? Object.keys(data[0]).slice(0,10) : (typeof data === 'object' ? Object.keys(data).slice(0,10) : null), sample: Array.isArray(data) ? data[0] : data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug/rv-notes/:id', hubAuth, async (req, res) => {
  try {
    const data = await rvFetch('/notes', { objectTypeID: 16, objectID: req.params.id, pageSize: 10 });
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Rentvine Webhook Proxy ──
app.use('/api/scanner', scannerRoutes);
app.get('/appliance-scanner', (req, res) => res.sendFile(new URL('./appliance-scanner.html', import.meta.url).pathname));

app.post('/webhook/rentvine', express.json(), async (req, res) => {
  try {
    const payload = req.body;
    console.log('RV webhook forwarding:', JSON.stringify(payload).slice(0, 200));
    // Forward to Ari on the server
    const response = await fetch('http://34.16.157.83:3001/webhook/rentvine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    res.json(result);
  } catch(e) {
    console.error('Webhook proxy error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
// ── Quo Webhook Handler ──
app.post('/webhook/quo', express.json(), async (req, res) => {
  try {
    const payload = req.body;
    console.log('Quo webhook:', JSON.stringify(payload).slice(0, 300));

    const event = payload.event || payload.type || '';
    if (!event.includes('message')) return res.json({ ok: true, skipped: true });

    const msg = (payload.data && payload.data.object) || payload.message || payload;
    const direction = msg.direction || '';
    const from = msg.from || msg.participant || '';
    const body = msg.body || msg.content || msg.text || '';
    const mediaUrls = msg.mediaUrls || msg.attachments || msg.media || [];
    const hasAttachment = mediaUrls.length > 0;
    const inboxNumber = msg.to || msg.inboxNumber || '';

    // Only care about inbound messages with attachments OR invoice/quote keywords
    const isInbound = direction === 'incoming' || direction === 'inbound' || direction === 'in';
    const lowerBody = body.toLowerCase();
    const isInvoice = lowerBody.includes('invoice') || lowerBody.includes('total') || lowerBody.includes('amount due') || lowerBody.includes('payment');
    const isQuote = lowerBody.includes('quote') || lowerBody.includes('estimate') || lowerBody.includes('proposal');

    if (!isInbound || (!hasAttachment && !isInvoice && !isQuote)) {
      return res.json({ ok: true, skipped: true });
    }

    // Look up vendor in Rentvine by phone
    let vendorName = null;
    try {
      const rvLookup = await fetch(`https://hub.aloepm.com/api/rentvine/vendor-by-phone?phone=${encodeURIComponent(from)}`, {
        headers: { 'x-hub-token': HUB_SECRET }
      });
      const rvData = await rvLookup.json();
      if (rvData.found) vendorName = rvData.vendor.name;
    } catch(e) { console.log('Vendor lookup error:', e.message); }

    // Forward to Ari
    const ariPayload = {
      type: 'quo_message',
      from,
      inboxNumber,
      body,
      hasAttachment,
      mediaUrls,
      isInvoice,
      isQuote,
      vendorName,
    };

    await fetch('http://34.16.157.83:3001/webhook/quo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ariPayload),
    });

    res.json({ ok: true });
  } catch(e) {
    console.error('Quo webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
// ── End Quo Webhook Handler ──

// ── End Rentvine Webhook Proxy ──

app.get('/api/rentvine/unit/:id', hubAuth, async (req, res) => {
  try {
    const data = await rvFetch('/properties/units/export', { pageSize: 200, page: 1 });
    const units = Array.isArray(data) ? data : [];
    const found = units.find(r => String((r.unit && r.unit.unitID) || r.unitID) === String(req.params.id));
    if (!found) return res.status(404).json({ error: 'Unit not found', id: req.params.id });
    const unit = found.unit || found;
    const property = found.property || {};
    const streetAddress = unit.address || unit.streetAddress || property.address || '';
    const city = unit.city || property.city || '';
    const state = unit.stateID || property.stateID || 'AZ';
    const zip = unit.postalCode || property.postalCode || '';
    const address = [streetAddress, city, state, zip].filter(Boolean).join(', ');
    res.json({ address, streetAddress, city, state, zip });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/aptly/schema', hubAuth, async (req, res) => {
  try {
    const unitsToken = process.env.APTLY_UNITS_TOKEN || process.env.APTLY_TOKEN || '';
    const r = await fetch('https://core-api.getaptly.com/api/schema/workOrder', {
      headers: { 'x-token': unitsToken }
    });
    const data = await r.json();
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/aptly/vendors', hubAuth, async (req, res) => {
  try {
    const vendors = {};
    for (let page = 0; page <= 20; page++) {
      const data = await unitsFetch('/api/board/workOrder', { page, pageSize: 100, includeArchived: false });
      const batch = Array.isArray(data) ? data : ((data && data.data) || []);
      if (!batch.length) break;
      for (const card of batch) {
        const vendorList = card.vendor || [];
        for (const v of vendorList) {
          if (v._id && v.name) vendors[v.name] = v._id;
        }
      }
      if (batch.length < 100) break;
    }
    res.json({ vendors, count: Object.keys(vendors).length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/aptly/vendor-search', hubAuth, async (req, res) => {
  try {
    const { name = '', phone = '' } = req.query;
    const unitsToken = process.env.APTLY_UNITS_TOKEN || process.env.APTLY_TOKEN || '';
    
    // Search contacts by phone or name
    const params = new URLSearchParams({ page: 0, pageSize: 20 });
    if (phone) params.set('phone', phone);
    if (name) params.set('query', name);
    
    const r = await fetch(`https://core-api.getaptly.com/api/contacts?${params}`, {
      headers: { 'x-token': unitsToken }
    });
    const data = await r.json();
    const contacts = (data.data || []).filter(c => 
      c.contactType === 'Vendor' || 
      c.typeId === 'vendor' ||
      (c.fullname && name && c.fullname.toLowerCase().includes(name.toLowerCase()))
    );
    res.json({ contacts: contacts.map(c => ({ _id: c._id, name: c.fullname, type: c.contactType })) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/aptly/cards/:id/dispatch', hubAuth, async (req, res) => {
  try {
    const { vendorPhone, vendorId, homeWarranty = 'No' } = req.body;
    const unitsToken = process.env.APTLY_UNITS_TOKEN || process.env.APTLY_TOKEN || '';
    
    let resolvedVendorId = vendorId;
    
    // Look up vendor by phone if no ID provided
    if (!resolvedVendorId && vendorPhone) {
      const r = await fetch(`https://core-api.getaptly.com/api/contacts?phone=${encodeURIComponent(vendorPhone)}&pageSize=5`, {
        headers: { 'x-token': unitsToken }
      });
      const data = await r.json();
      const vendor = (data.data || []).find(c => c.contactType === 'Vendor');
      if (!vendor) return res.status(404).json({ error: 'Vendor not found for phone: ' + vendorPhone });
      resolvedVendorId = vendor._id;
    }
    
    if (!resolvedVendorId) return res.status(400).json({ error: 'vendorPhone or vendorId required' });
    
    // Update card: set vendor + home warranty + reassign flag if needed
    const body = {
      _id: req.params.id,
      vendor: [{ _id: resolvedVendorId }],
      '3PvcEJoFBQLnjHnd6': homeWarranty,
    };
    if (req.body.isReassign) {
      body['39gNjdkmpFpoPLzth'] = true;
    }
    
    const r = await fetch('https://core-api.getaptly.com/api/board/workOrder', {
      method: 'POST',
      headers: { 'x-token': unitsToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    res.status(r.status).json({ success: r.ok, vendorId: resolvedVendorId, homeWarranty, result: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rentvine/vendor-by-phone', hubAuth, async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'phone required' });
    // Normalize phone - strip non-digits for comparison
    const normalized = phone.replace(/\D/g, '').slice(-10);
    const data = await rvFetch('/vendors', { pageSize: 200, page: 1 });
    const records = Array.isArray(data) ? data : (data.results || data.data || []);
    const match = records.find(r => {
      const v = r.contact || r;
      const vPhone = (v.phone || '').replace(/\D/g, '').slice(-10);
      return vPhone === normalized;
    });
    if (!match) return res.json({ found: false, normalized });
    const v = match.contact || match;
    res.json({ found: true, vendor: { id: v.contactID, name: v.name, phone: v.phone } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/debug/rv-vendors', hubAuth, async (req, res) => {
  try {
    const data = await rvFetch('/contacts/vendors', { pageSize: 5, page: 1 });
    res.json({ type: typeof data, isArray: Array.isArray(data), keys: typeof data === 'object' ? Object.keys(data).slice(0,5) : null, sample: Array.isArray(data) ? data[0] : data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rentvine/property-lookup', hubAuth, async (req, res) => {
  try {
    const { q } = req.query;
    const q_lower = (q || '').toLowerCase();
    // Use pageSize=5000 to get all properties in one shot (Rentvine default for accounts endpoint)
    let allProps = [];
    for (let page = 1; page <= 10; page++) {
      const data = await rvFetch('/properties/export', { pageSize: 500, page });
      const batch = Array.isArray(data) ? data : (data.results || data.data || []);
      if (!batch.length) break;
      allProps = allProps.concat(batch);
      if (batch.length < 500) break; // last page
    }
    console.log(`properties/search: fetched ${allProps.length} total, filtering for "${q_lower}"`);
    const filtered = q_lower ? allProps.filter(r => {
      const p = r.property || r;
      const addr = (p.address || p.name || '').toLowerCase();
      const street = (p.streetName || '').toLowerCase();
      const num = String(p.streetNumber || '').toLowerCase();
      const city = (p.city || '').toLowerCase();
      const full = [addr, street, num, city].join(' ');
      const words = q_lower.split(/\s+/).filter(Boolean);
      return words.every(w => full.includes(w));
    }) : allProps;
    res.json({ properties: filtered.slice(0, 10).map(r => {
      const p = r.property || r;
      return {
        propertyId: p.propertyID || p.id,
        address: p.address || p.streetAddress,
        city: p.city, state: p.stateID, zip: p.postalCode,
        name: p.name, unitCount: p.unitCount
      };
    })});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rentvine/properties/:id/units', hubAuth, async (req, res) => {
  try {
    const data = await rvFetch('/properties/' + req.params.id + '/units');
    const units = Array.isArray(data) ? data : (data.units || data.data || []);
    res.json({ units: units.map(u => ({
      unitId: u.unitID || u.id,
      address: u.address || u.streetAddress,
      name: u.name, beds: u.bedrooms, baths: u.bathrooms
    }))});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/rentvine/work-orders', hubAuth, async (req, res) => {
  try {
    const { propertyID, unitID, leaseID, description, priorityID = 2, isSharedWithTenant = true, isSharedWithOwner = false, sourceTypeID = 2 } = req.body;
    if (!propertyID || !description) return res.status(400).json({ error: 'propertyID and description required' });
    const body = { propertyID, description, priorityID, isSharedWithTenant, isSharedWithOwner, sourceTypeID };
    if (unitID) body.unitID = unitID;
    if (leaseID) body.leaseID = leaseID;
    const data = await rvFetch('/maintenance/work-orders', {}, 'POST', body);
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Quo SMS ──────────────────────────────────────────────────────────────
app.post('/api/quo/send-sms', hubAuth, async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'to and message required' });
    const QUO_TOKEN = process.env.QUO_API_TOKEN || 'dc4e31adbc86b3983202a9e8f39349e4e7ad1d4f53285dae230af23844b1988d';
    const FROM_NUMBER = '+16028549884';
    const r = await fetch('https://api.quo.com/v1/messages', {
      method: 'POST',
      headers: { 'Authorization': QUO_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message, from: FROM_NUMBER, to: Array.isArray(to) ? to : [to], phoneNumberId: 'PNRRARIpQO' }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data });
    res.json({ success: true, messageId: data.id || data.messageId, to, message });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Aptly → Rentvine cancel/complete sync ────────────────────────────────
app.post('/api/sync/aptly-wo-status', hubAuth, async (req, res) => {
  try {
    const dryRun = req.body && req.body.dryRun;
    const APTLY_TOK = process.env.APTLY_TOKEN || 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';
    
    // 1. Fetch Aptly cards that are Cancelled or Completed
    let aptlyDone = [];
    for (let page = 0; page <= 50; page++) {
      const r = await fetch(`https://core-api.getaptly.com/api/board/workOrder?page=${page}&pageSize=100&includeArchived=false`, {
        headers: { 'x-token': APTLY_TOK }
      });
      if (!r.ok) break;
      const raw = await r.json();
      const items = Array.isArray(raw) ? raw : (raw && raw.data) || [];
      if (!items.length) break;
      const done = items.filter(c => {
        const stage = (c.stage || '').toLowerCase();
        return stage === 'cancelled' || stage === 'completed' || stage === 'completed already billed';
      });
      aptlyDone = aptlyDone.concat(done);
      if (items.length < 100) break;
    }
    
    console.log(`Aptly sync: found ${aptlyDone.length} cancelled/completed cards`);
    
    // 2. For each, find the matching Rentvine WO by workOrderNumber and update if still open
    const results = { updated: [], skipped: [], errors: [] };
    
    for (const card of aptlyDone) {
      const woNum = card.workOrderNumber || card['Work Order Number'];
      const rvId = card.rentvineId || card['Rentvine ID'];
      if (!woNum && !rvId) { results.skipped.push({ reason: 'no WO number', card: card._id }); continue; }
      
      const stage = (card.stage || '').toLowerCase();
      // Rentvine status: 2=Completed, 3=Cancelled
      const newStatusId = stage === 'cancelled' ? 3 : 2;
      
      try {
        // Search Rentvine for the WO
        const searchData = await rvFetch('/maintenance/work-orders', { 
          pageSize: 5, 
          page: 1,
          ...(rvId ? { workOrderID: rvId } : { workOrderNumber: woNum })
        });
        const wos = Array.isArray(searchData) ? searchData : (searchData && searchData.data) || [];
        const match = wos.find(r => {
          const wo = r.workOrder || r;
          return String(wo.workOrderNumber) === String(woNum) || String(wo.workOrderID) === String(rvId);
        });
        
        if (!match) { results.skipped.push({ reason: 'not found in RV', woNum }); continue; }
        
        const wo = match.workOrder || match;
        const currentStatus = parseInt(wo.workOrderStatusID || wo.primaryWorkOrderStatusID || 0);
        
        // Skip if already closed in Rentvine (status 2=Completed, 3=Cancelled, 7=Rejected, 18=Completed Already Billed)
        if ([2, 3, 7, 18].includes(currentStatus)) {
          results.skipped.push({ reason: 'already closed in RV', woNum, currentStatus });
          continue;
        }
        
        if (dryRun) {
          results.updated.push({ woNum, newStatusId, dryRun: true });
          continue;
        }
        
        // Update Rentvine WO status
        const updateData = await rvFetch(`/maintenance/work-orders/${wo.workOrderID}`, {}, 'PATCH', {
          workOrderStatusID: newStatusId,
          primaryWorkOrderStatusID: newStatusId,
        });
        
        results.updated.push({ woNum, newStatusId, rvId: wo.workOrderID });
        console.log(`Synced WO #${woNum}: status → ${newStatusId}`);
      } catch(e) {
        results.errors.push({ woNum, error: e.message });
      }
    }
    
    const summary = `Aptly→RV sync: ${results.updated.length} updated, ${results.skipped.length} skipped, ${results.errors.length} errors`;
    console.log(summary);
    
    // Post summary to Slack if any updates
    if (results.updated.length > 0 && !dryRun) {
      const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN || '';
      if (SLACK_TOKEN) {
        const lines = results.updated.map(u => `• WO #${u.woNum} → ${u.newStatusId === 3 ? 'Cancelled' : 'Completed'}`).join('\n');
        await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: 'C0BC64LCKV1', text: `✅ *Aptly→Rentvine Sync*\n${lines}` })
        });
      }
    }
    
    res.json({ summary, results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Aptly → Rentvine cancel/complete sync ────────────────────────────────
app.post('/api/sync/aptly-wo-status', hubAuth, async (req, res) => {
  try {
    const dryRun = req.body && req.body.dryRun;
    const APTLY_TOK = process.env.APTLY_TOKEN || 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';
    let aptlyDone = [];
    for (let page = 0; page <= 50; page++) {
      const r = await fetch(`https://core-api.getaptly.com/api/board/workOrder?page=${page}&pageSize=100&includeArchived=false`, {
        headers: { 'x-token': APTLY_TOK }
      });
      if (!r.ok) break;
      const raw = await r.json();
      const items = Array.isArray(raw) ? raw : (raw && raw.data) || [];
      if (!items.length) break;
      aptlyDone = aptlyDone.concat(items.filter(c => {
        const stage = (c.stage || '').toLowerCase();
        return stage === 'cancelled' || stage === 'completed' || stage === 'completed already billed';
      }));
      if (items.length < 100) break;
    }
    console.log(`Aptly sync: found ${aptlyDone.length} cancelled/completed cards`);
    const results = { updated: [], skipped: [], errors: [] };
    for (const card of aptlyDone) {
      const woNum = card.workOrderNumber;
      const rvId = card.rentvineId;
      if (!woNum && !rvId) { results.skipped.push({ reason: 'no WO number', card: card._id }); continue; }
      const stage = (card.stage || '').toLowerCase();
      const newStatusId = stage === 'cancelled' ? 3 : 2;
      try {
        const searchData = await rvFetch('/maintenance/work-orders', { pageSize: 5, page: 1, ...(woNum ? { workOrderNumber: woNum } : {}) });
        const wos = Array.isArray(searchData) ? searchData : (searchData && searchData.data) || [];
        const match = wos.find(r => { const wo = r.workOrder || r; return String(wo.workOrderNumber) === String(woNum) || String(wo.workOrderID) === String(rvId); });
        if (!match) { results.skipped.push({ reason: 'not found in RV', woNum }); continue; }
        const wo = match.workOrder || match;
        const currentStatus = parseInt(wo.workOrderStatusID || wo.primaryWorkOrderStatusID || 0);
        if ([2, 3, 7, 18].includes(currentStatus)) { results.skipped.push({ reason: 'already closed', woNum }); continue; }
        if (dryRun) { results.updated.push({ woNum, newStatusId, dryRun: true }); continue; }
        await rvFetch(`/maintenance/work-orders/${wo.workOrderID}`, {}, 'PATCH', { workOrderStatusID: newStatusId });
        results.updated.push({ woNum, newStatusId });
        console.log(`Synced WO #${woNum} → status ${newStatusId}`);
      } catch(e) { results.errors.push({ woNum, error: e.message }); }
    }
    const summary = `Aptly→RV sync: ${results.updated.length} updated, ${results.skipped.length} skipped, ${results.errors.length} errors`;
    console.log(summary);
    res.json({ summary, results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Ari: Maintenance Work Order Creation ─────────────────────────────────
app.post('/api/ari/create-work-order', hubAuth, async (req, res) => {
  try {
    const APTLY_TOK = process.env.APTLY_UNITS_TOKEN || process.env.APTLY_TOKEN || '';
    const body = req.body;
    const cardBody = {
      description: body.description || '',
      stage: body.stage || 'Internal Work Order Request',
      priority: body.priority || 'Med',
      source: 'Staff',
      isSharedWithTenant: body.isSharedWithTenant || false,
      isSharedWithOwner: body.isSharedWithOwner || false,
    };
    if (body.unitId) cardBody['unit'] = [{ _id: body.unitId, name: body.unitName || '', duogram: body.unitDuogram || '' }];
    if (body.locationId) {
      cardBody['location'] = [{ _id: body.locationId, name: body.locationName || '', duogram: body.locationDuogram || '' }];
      cardBody['Buildings'] = [{ _id: body.locationId, name: body.locationName || '', duogram: body.locationDuogram || '' }];
    }
    if (body.portfolioId) cardBody['portfolio'] = [{ _id: body.portfolioId, name: body.portfolioName || '', duogram: body.portfolioDuogram || '' }];
    if (body.ownerContacts && body.ownerContacts.length) cardBody['ownerContacts'] = body.ownerContacts;
    // Set Rentvine Status to match Aptly stage
    const stageToRVStatus = {
      'Open': 'Open',
      'Internal Work Order Request': 'Internal Work Order Request',
      'Unit Turn': 'Unit Turn',
      'Estimating': 'Estimating',
      'Requested': 'Requested',
      'Scheduled': 'Scheduled',
      'Home Warranty': 'Home Warranty',
      'Waiting for Parts': 'Waiting for Parts',
      'Dispatch Work Order': 'Open',
      'Completed': 'Completed',
      'Cancelled': 'Cancelled',
    };
    const rvStatus = stageToRVStatus[body.stage] || 'Open';
    cardBody['rentvineStatus'] = rvStatus;
    console.log('Ari WO create:', JSON.stringify(cardBody).slice(0, 300));
    const r = await fetch('https://core-api.getaptly.com/api/board/workOrder', {
      method: 'POST',
      headers: { 'x-token': APTLY_TOK, 'Content-Type': 'application/json' },
      body: JSON.stringify(cardBody),
    });
    const result = await r.json();
    if (!r.ok) return res.status(500).json({ error: 'Aptly ' + r.status, detail: result });
    const cardId = result.data?._id || result._id;
    console.log('Ari WO created:', cardId);
    res.json({ _id: cardId, cardId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Kat: Building lookup by address ─────────────────────────────────────
app.get('/api/kat/building-lookup', hubAuth, async (req, res) => {
  try {
    const APTLY_TOK = process.env.APTLY_TOKEN || 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q param required' });
    const houseNum = q.split(' ')[0];
    let result = { unit_aptly_id: null, unit_aptly_name: null, unit_aptly_duogram: null, building_aptly_id: null, building_aptly_name: null, building_aptly_duogram: null };
    for (let pg = 0; pg < 10 && !result.building_aptly_id; pg++) {
      const r = await fetch(`https://core-api.getaptly.com/api/board/location?page=${pg}&pageSize=100&search=${encodeURIComponent(houseNum)}`, {
        headers: { 'x-token': APTLY_TOK }
      });
      const data = await r.json();
      const bldgs = Array.isArray(data) ? data : (data.data || []);
      if (!bldgs.length) break;
      for (const b of bldgs) {
        const bAddr = (b.address?.address || b.address?.formattedAddress || b.name || '').toLowerCase();
        if (bAddr.includes(houseNum.toLowerCase())) {
          result.building_aptly_id = b._id;
          result.building_aptly_name = b.address?.formattedAddress || b.name || '';
          result.building_aptly_duogram = b.duogram || '';
          if (b.units?.[0]) {
            result.unit_aptly_id = b.units[0]._id;
            result.unit_aptly_name = b.units[0].name || '';
            result.unit_aptly_duogram = b.units[0].duogram || '';
          }
          break;
        }
      }
      if (bldgs.length < 100) break;
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Kat: Building lookup by address ─────────────────────────────────────
app.get('/api/kat/building-lookup', hubAuth, async (req, res) => {
  try {
    const APTLY_TOK = process.env.APTLY_TOKEN || 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q param required' });
    const houseNum = q.split(' ')[0];
    let result = { unit_aptly_id: null, unit_aptly_name: null, unit_aptly_duogram: null, building_aptly_id: null, building_aptly_name: null, building_aptly_duogram: null };
    for (let pg = 0; pg < 10 && !result.building_aptly_id; pg++) {
      const r = await fetch(`https://core-api.getaptly.com/api/board/location?page=${pg}&pageSize=100&search=${encodeURIComponent(houseNum)}`, {
        headers: { 'x-token': APTLY_TOK }
      });
      const data = await r.json();
      const bldgs = Array.isArray(data) ? data : (data.data || []);
      if (!bldgs.length) break;
      for (const b of bldgs) {
        const bAddr = (b.address?.address || b.address?.formattedAddress || b.name || '').toLowerCase();
        if (bAddr.includes(houseNum.toLowerCase())) {
          result.building_aptly_id = b._id;
          result.building_aptly_name = b.address?.formattedAddress || b.name || '';
          result.building_aptly_duogram = b.duogram || '';
          if (b.units?.[0]) {
            result.unit_aptly_id = b.units[0]._id;
            result.unit_aptly_name = b.units[0].name || '';
            result.unit_aptly_duogram = b.units[0].duogram || '';
          }
          break;
        }
      }
      if (bldgs.length < 100) break;
    }
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── End Aptly Proxy ──
// Agent Hub - receive heartbeat from agent-monitor
let agentStatus = { procs: [], pushedAt: null };



// ── SOP Library ─────────────────────────────────────────────────────────────
let sopRuns = [];

app.get('/api/agents/sops', async (req, res) => {
  try {
    const [files] = await storage.bucket(BUCKET).getFiles({ prefix: 'sops/' });
    const sops = [];
    for (const file of files) {
      if (!file.name.endsWith('.json')) continue;
      const [data] = await file.download();
      try { sops.push(JSON.parse(data.toString())); } catch(e) {}
    }
    sops.sort((a,b) => (a.name||'').localeCompare(b.name||''));
    res.json(sops);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/agents/sops/:id', async (req, res) => {
  try {
    const file = storage.bucket(BUCKET).file('sops/' + req.params.id + '.json');
    const [exists] = await file.exists();
    if (!exists) return res.status(404).json({ error: 'SOP not found' });
    const [data] = await file.download();
    res.json(JSON.parse(data.toString()));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agents/sops', async (req, res) => {
  try {
    const sop = req.body;
    if (!sop.id) return res.status(400).json({ error: 'id required' });
    sop.updatedAt = new Date().toISOString();
    await storage.bucket(BUCKET).file('sops/' + sop.id + '.json').save(JSON.stringify(sop), { contentType: 'application/json' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/agents/sops/:id', async (req, res) => {
  try {
    await storage.bucket(BUCKET).file('sops/' + req.params.id + '.json').delete();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/agents/runs', (req, res) => {
  const sopId = req.query.sop;
  let results = sopRuns;
  if (sopId) results = results.filter(function(r){ return r.sopId === sopId; });
  res.json(results.slice(0, 100));
});

app.post('/api/agents/runs', (req, res) => {
  const run = Object.assign({}, req.body, { timestamp: new Date().toISOString(), id: Date.now().toString() });
  sopRuns.unshift(run);
  if (sopRuns.length > 500) sopRuns = sopRuns.slice(0, 500);
  res.json({ ok: true, id: run.id });
});

app.get('/agents/sops', (req, res) => res.sendFile('/app/public/sops.html'));
app.get('/agents/jobs', (req, res) => res.sendFile('/app/public/jobs.html'));

// ── Agent Hub API Routes ────────────────────────────────────────────────────

// Playbook routes
app.get('/api/agents/playbook/:agentId', async (req, res) => {
  try {
    const file = storage.bucket(BUCKET).file('playbooks/' + req.params.agentId + '.md');
    const [exists] = await file.exists();
    if (!exists) return res.json({ content: '', exists: false });
    const [data] = await file.download();
    res.json({ content: data.toString(), exists: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agents/playbook-save', async (req, res) => {
  try {
    const { agentId, content } = req.body;
    const file = storage.bucket(BUCKET).file('playbooks/' + agentId + '.md');
    await file.save(content, { contentType: 'text/markdown' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Training routes (read-only vs GCS + Anthropic, no tool calls, no writes to Rentvine/Aptly/Quo)
app.get('/api/agents/train/context/:agentId', async (req, res) => {
  try {
    const file = storage.bucket(BUCKET).file('playbooks/' + req.params.agentId + '.md');
    const [exists] = await file.exists();
    if (!exists) return res.status(404).json({ error: 'Playbook not found' });
    const [data] = await file.download();
    res.json({ agentId: req.params.agentId, playbook: data.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/agents/train', async (req, res) => {
  try {
    const { agentId, counterparty, messages } = req.body;
    if (!agentId || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'agentId and messages[] are required' });
    }
    const file = storage.bucket(BUCKET).file('playbooks/' + agentId + '.md');
    const [exists] = await file.exists();
    if (!exists) return res.status(404).json({ error: 'Playbook not found for agent: ' + agentId });
    const [data] = await file.download();
    const playbook = data.toString();
    const displayName = agentId.charAt(0).toUpperCase() + agentId.slice(1);
const systemPrompt = 'You are ' + displayName + ', an AI agent for Aloe Property Management. This is a TRAINING SESSION used to test and refine your playbook — you are being roleplayed against, not handling a live case, and no real messages, emails, texts, work orders, or charges will be sent or created no matter what you decide to do. You do NOT have live tool access in this session — you cannot look up real properties, leases, or tenants. Never output tool-call syntax, XML tags, or pretend to search a system. Instead, respond exactly as you would in a real conversation: reason through what your playbook tells you to do, and if you would normally need to look something up, say so naturally in plain language (e.g. "let me pull up your account") without simulating the lookup mechanics. In real use you communicate with tenants/owners/vendors and with internal staff through completely separate channels (SMS/email vs. Slack) — the other party never sees both. In this training session you are ONLY talking to the counterparty (tenant/owner/vendor), never staff, so respond with ONLY what you would actually send to that person. Never include internal triage notes, Slack-style staff updates, issue-type classifications, vendor lookup steps, or "recommended action" summaries in your reply — that content is for a different audience and channel entirely, and would never be visible to the person you are texting. Follow every rule in your playbook below. Do not mention that this is a training session or break character.\n\nThe person messaging you is playing the role of a ' + (counterparty || 'tenant') + '.\n\n--- PLAYBOOK ---\n' + playbook;  
const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages
    });
    const reply = resp.content.map(b => b.type === 'text' ? b.text : '').join('');
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/agents/training', (req, res) => {
  res.sendFile('/app/public/training.html');
});
// Knowledge routes
app.get('/api/agents/knowledge/:scope', async (req, res) => {
  try {
    const file = storage.bucket(BUCKET).file('knowledge/' + req.params.scope + '.md');
    const [exists] = await file.exists();
    if (!exists) return res.json({ content: '', exists: false });
    const [data] = await file.download();
    res.json({ content: data.toString(), exists: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agents/knowledge', async (req, res) => {
  try {
    const { scope, title, content } = req.body;
    const scopes = scope === 'all' ? ['shared'] : [scope];
    for (const s of scopes) {
      const file = storage.bucket(BUCKET).file('knowledge/' + s + '.md');
      const [exists] = await file.exists();
      let existing = '';
      if (exists) {
        const [data] = await file.download();
        existing = data.toString();
      }
      const entry = '\n\n---\n## ' + title + '\n*Added: ' + new Date().toISOString().slice(0,10) + '*\n\n' + content;
      await file.save(existing + entry, { contentType: 'text/markdown' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/agents/knowledge/:scope', async (req, res) => {
  try {
    await storage.bucket(BUCKET).file('knowledge/' + req.params.scope + '.md').save('', { contentType: 'text/markdown' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Activity log
let agentActivity = [];

app.post('/api/agents/log', (req, res) => {
  const key = req.headers['x-agent-key'];
  if (key !== 'aloe-internal') return res.status(401).json({ error: 'unauthorized' });
  const entry = { ...req.body, timestamp: new Date().toISOString() };
  agentActivity.unshift(entry);
  if (agentActivity.length > 500) agentActivity = agentActivity.slice(0, 500);
  res.json({ ok: true });
});

app.get('/api/agents/activity', (req, res) => {
  const agent = req.query.agent;
  const limit = parseInt(req.query.limit) || 50;
  let results = agentActivity;
  if (agent) results = results.filter(e => e.agentId === agent);
  res.json(results.slice(0, limit));
});

app.post('/api/agents/heartbeat', (req, res) => {
  const key = req.headers['x-agent-key'];
  if (key !== 'aloe-internal') return res.status(401).json({ error: 'unauthorized' });
  agentStatus = req.body;
  res.json({ ok: true });
});

app.get('/api/agents/status', (req, res) => {
  res.json(agentStatus);
});



app.get('/agents', (req, res) => {
  res.sendFile('/app/public/agents.html');
});
app.get('/agents/activity', (req, res) => {
  res.sendFile('/app/public/activity.html');
});
app.get('/agents/playbooks', (req, res) => {
  res.sendFile('/app/public/playbooks.html');
});
app.get('/agents/knowledge', (req, res) => {
  res.sendFile('/app/public/knowledge.html');
});
app.get('/agents/tools', (req, res) => {
  res.sendFile('/app/public/tools.html');
});
app.get('/api/agents/tools', (req, res) => {
  res.json(agentStatus.tools || {});
});
// ── Aptlet lookup — find Aptly unit/building IDs by house number ──────────
// Searches work orders board (which covers all properties) to find aptlet IDs
app.get('/api/aptly/aptlet-lookup', hubAuth, async (req, res) => {
  try {
    const APTLY_TOK = process.env.APTLY_TOKEN || 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';
    const houseNum = (req.query.q || '').trim().split(' ')[0];
    if (!houseNum) return res.status(400).json({ error: 'q param required' });

    let found = null;
    for (let page = 0; page < 15 && !found; page++) {
      const r = await fetch(`https://core-api.getaptly.com/api/board/workOrder?page=${page}&pageSize=100&includeArchived=true`, {
        headers: { 'x-token': APTLY_TOK }
      });
      const data = await r.json();
      const cards = Array.isArray(data) ? data : (data.data || []);
      if (!cards.length) break;
      for (const c of cards) {
        const name = c.name || '';
        if (name.includes(houseNum) && c.unit?.[0]?._id && c.location?.[0]?._id) {
          const buildingId = c.location[0]._id;
          let portfolioId = null, portfolioName = null, portfolioDuogram = null;
          try {
            const bldgResp = await fetch(`https://core-api.getaptly.com/api/board/location/${buildingId}`, {
              headers: { 'x-token': APTLY_TOK }
            });
            const bldgData = await bldgResp.json();
            const bldg = bldgData.data || bldgData;
            portfolioId = bldg.portfolio?.[0]?._id || null;
            portfolioName = bldg.portfolio?.[0]?.name || null;
            portfolioDuogram = bldg.portfolio?.[0]?.duogram || null;
          } catch(e) { console.error('Building lookup error:', e.message); }
          // Get owners from building record
          let bldgOwners = [];
          try {
            const bldgResp2 = await fetch(`https://core-api.getaptly.com/api/board/location/${buildingId}`, {
              headers: { 'x-token': APTLY_TOK }
            });
            const bldgData2 = await bldgResp2.json();
            const bldg2 = bldgData2.data || bldgData2;
            bldgOwners = bldg2.owners || [];
          } catch(e) { console.error('Building owners error:', e.message); }
          found = {
            unit_aptly_id: c.unit[0]._id,
            unit_aptly_name: c.unit[0].name || null,
            unit_aptly_duogram: c.unit[0].duogram || null,
            building_aptly_id: buildingId,
            building_aptly_name: c.location[0].name || null,
            building_aptly_duogram: c.location[0].duogram || null,
            portfolio_aptly_id: portfolioId,
            portfolio_aptly_name: portfolioName,
            portfolio_aptly_duogram: portfolioDuogram,
            owners: bldgOwners,
          };
          break;
        }
      }
    }
    if (!found) return res.json({ unit_aptly_id: null, building_aptly_id: null });
    res.json(found);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/vendor-apply', async (req, res) => {
  try {
    const { business, name, phone, email, trade, license, area, insurance, about, why, hourlyRate, employees, hasVehicle, hasTools, social, refs, additional } = req.body;
    const slackText = `New Vendor Application\nBusiness: ${business}\nContact: ${name} - ${phone} - ${email}\nTrade: ${trade}\nInsurance: ${insurance}`;
    let slackOk = false;
    if (process.env.SLACK_TOKEN) {
      try {
        const slackResp = await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.SLACK_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'C07CY9SSF7D', text: slackText }) });
        const slackData = await slackResp.json();
        slackOk = slackData.ok;
      } catch(e) { console.error('Slack vendor error:', e.message); }
    }
    if (slackOk) return res.json({ ok: true });
    res.status(500).json({ error: 'Failed to deliver application' });
  } catch (err) {
    console.error('Vendor apply error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// Plaid
initPlaidRoutes(app);

const PORT = process.env.PORT || 3000;

// ── HOA: Property lookup by address ──────────────────────────────────────
// duplicate properties/search route removed

// ── HOA: Get property (includes custom HOA fields) ────────────────────────




app.post('/api/aptly/hoa-cards', hubAuth, async (req, res) => {
  try {
    const APTLY_TOK = process.env.APTLY_TOKEN || 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';
    const body = req.body;

    // Field KEYS from schema (not display names)
    const cardBody = {
      name:                body.title || '',
      description:         body.violation_exact_wording || '',
      stage:               'HOA Violation/Notice received',
      createdAt:           new Date().toISOString(),
      stageUpdatedAt:      new Date().toISOString(),
      'Sz5KNfAAMDuThngyG': body.violation_issue || '',
      'cPZmmmjQwYJriT53Y': body.warning_or_fine || '',
      'iyZj4A2TfKiHRtF7i': body.owner_tenant_responsible || '',
      'dueAt':             body.due_date || null,
      'nMmfRWZyAFDFNW4mo': body.tenant_phone_1 || '',
      'iSifhPDzhrNrMAZXx': body.tenant_phone_2 || '',
      'BvfLpebk484dEsd4Y': body.mirror_hoa_name || '',
      'T3tGDpxosQnR7u3NA': body.mirror_hoa_number || '',
      '2u8QFWLBDrf6tC9P9': body.mirror_hoa_email || '',
      'dMNaxpq2zPTY9rhaJ': body.mirror_hoa_website || '',
    };
    if (body.fine_amount) cardBody['RevYLWzf8Yv2QtwK9'] = Number(body.fine_amount);
    if (body.unit_aptly_id) cardBody['unit'] = [{ _id: body.unit_aptly_id, name: body.unit_aptly_name || '', duogram: (body.unit_aptly_name || '').replace(/[^A-Z0-9]/g,'').slice(0,2) }];
    if (body.building_aptly_id) cardBody['location'] = [{ _id: body.building_aptly_id, name: body.building_aptly_name || '', duogram: (body.building_aptly_name || '').replace(/[^A-Z0-9]/g,'').slice(0,2) }];

    const r = await fetch('https://core-api.getaptly.com/api/board/8bazEHshdZNuMKCFE', {
      method: 'POST',
      headers: { 'x-token': APTLY_TOK, 'Content-Type': 'application/json' },
      body: JSON.stringify(cardBody)
    });
    const result = await r.json();
    if (!r.ok) return res.status(500).json({ error: 'Aptly ' + r.status, detail: result });
    const cardId = result.data?._id || result.cardId || result._id;
    console.log('HOA card created:', cardId);
    res.json({ _id: cardId, cardId });
  } catch (e) { console.error('HOA card error:', e); res.status(500).json({ error: e.message }); }
});



// ── Property lookup via Aptly HOA registration board ─────────────────────
// Searches the HOA registration board which stores Mirror Rentvine ID,
// tenant name, lease dates, owner info, and HOA details
app.get('/api/aptly/property-search', hubAuth, async (req, res) => {
  try {
    const q = req.query.q || '';
    // Extract house number and street name for flexible matching
    const houseNum = q.trim().split(' ')[0];
    const streetName = q.replace(/^\d+\s+/, '').replace(/^[NSEW]\.?\s+/i, '').split(' ')[0];
    const APTLY_TOK = process.env.APTLY_TOKEN || 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';
    // Search HOA Violations board by street name then house number
    const HOA_BOARD = '8bazEHshdZNuMKCFE';
    let items = [];
    for (const query of [streetName, houseNum]) {
      if (!query) continue;
      const r = await fetch(`https://core-api.getaptly.com/api/board/${HOA_BOARD}?page=0&pageSize=20&search=${encodeURIComponent(query)}`, {
        headers: { 'x-token': APTLY_TOK }
      });
      const data = await r.json();
      items = Array.isArray(data) ? data : (data.data || []);
      if (items.length) break;
    }
    // Extract unit and building IDs from results
    const mapped = await Promise.all(items.map(async c => {
      let unit_aptly_id = c.unit?.[0]?._id || null;
      let unit_aptly_name = c.unit?.[0]?.name || null;
      let unit_aptly_duogram = c.unit?.[0]?.duogram || null;
      let building_aptly_id = c.location?.[0]?._id || c.Buildings?.[0]?._id || null;
      let building_aptly_name = c.location?.[0]?.name || c.Buildings?.[0]?.name || null;
      let building_aptly_duogram = c.location?.[0]?.duogram || c.Buildings?.[0]?.duogram || null;
      // Fallback to aptlet-lookup if IDs are missing
      if (!unit_aptly_id && q) {
        try {
          const lookupR = await fetch(`https://hub.aloepm.com/api/aptly/aptlet-lookup?q=${encodeURIComponent(q)}`, {
            headers: { 'x-hub-token': process.env.HUB_INTERNAL_SECRET }
          });
          const lookup = await lookupR.json();
          if (lookup.unit_aptly_id) {
            unit_aptly_id = lookup.unit_aptly_id;
            unit_aptly_name = lookup.unit_aptly_name;
            unit_aptly_duogram = lookup.unit_aptly_duogram;
            building_aptly_id = lookup.building_aptly_id;
            building_aptly_name = lookup.building_aptly_name;
            building_aptly_duogram = lookup.building_aptly_duogram;
          }
        } catch(e) { console.error('aptlet-lookup fallback error:', e.message); }
      }
      return {
        id: c._id,
        title: c.name || c.title || '',
        unit_aptly_id, unit_aptly_name, unit_aptly_duogram,
        building_aptly_id, building_aptly_name, building_aptly_duogram,
      };
    }));
    res.json({ items: mapped });
  } catch(e) { res.status(500).json({ error: e.message }); }
});



// Inspection Media → Structured Findings
const uploadMedia = multer({ dest: '/tmp/inspection-uploads/' });

app.post('/inspection-media', uploadMedia.array('files'), async (req, res) => {
  try {
    const type = req.body.type || 'inspection';
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

    const isVideo = files[0].mimetype.startsWith('video/');
    const args = ['inspection_media.py', 'analyze', '--type', type, '--report'];

    if (isVideo) {
      args.push('--video', files[0].path);
    } else {
      args.push('--photos', ...files.map(f => f.path));
    }

    execFile('python3', args, {
      cwd: '/app',
      env: { ...process.env, PATH: '/opt/venv/bin:' + process.env.PATH },
      maxBuffer: 1024 * 1024 * 10
    }, (err, stdout, stderr) => {
      // Clean up uploaded files
      files.forEach(f => { import('fs').then(fs => fs.unlink(f.path, () => {})); });

      if (err) {
        console.error('Inspection media error:', stderr);
        return res.status(500).json({ error: 'Pipeline failed', detail: stderr });
      }

      try {
        const findings = JSON.parse(stdout);
        res.json({ ok: true, findings });
      } catch {
        // Return raw output if not JSON
        res.json({ ok: true, report: stdout });
      }
    });
  } catch (err) {
    console.error('Inspection media route error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// Bank Reconciliation (Plaid -> ledger match -> discrepancies)
import { execFile as execFileRecon } from 'child_process';
const reconHandler = (req, res) => {
  const { account_token, start_date, end_date, ledger, demo } = req.body;
  const args = ['bank_recon.py', 'reconcile'];
  if (demo) {
    args.push('--demo', '--report');
  } else {
    if (!account_token || !start_date || !end_date || !ledger) {
      return res.status(400).json({ error: 'Missing required fields: account_token, start_date, end_date, ledger' });
    }
    const fs = require('fs');
    const tmpLedger = `/tmp/ledger-${Date.now()}.json`;
    fs.writeFileSync(tmpLedger, JSON.stringify(ledger));
    args.push('--plaid-token', account_token, '--start', start_date, '--end', end_date, '--ledger', tmpLedger, '--report');
  }
  execFileRecon('python3', args, {
    cwd: '/app',
    env: { ...process.env, PATH: '/opt/venv/bin:' + process.env.PATH },
    maxBuffer: 1024 * 1024 * 5
  }, (err, stdout, stderr) => {
    if (err) {
      console.error('Bank recon error:', stderr);
      return res.status(500).json({ error: 'Reconciliation failed', detail: stderr });
    }
    try {
      res.json({ ok: true, result: JSON.parse(stdout) });
    } catch {
      res.json({ ok: true, report: stdout });
    }
  });
};
app.post('/bank-recon', express.json(), reconHandler);

app.get('/dashboard', (req, res) => {
  res.sendFile('/app/public/dashboard.html');
});

app.get('*', function(req, res) {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Aloe PM — Internal Hub</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    :root{--teal:#3CC3E1;--teal-dark:#4BB4D2;--teal-dim:rgba(60,195,225,0.12);--silver:#B4C3C3;--silver-dim:rgba(180,195,195,0.15);--bg:#F8FAFC;--bg2:#ffffff;--bg3:#f1f5f5;--border:rgba(180,195,195,0.3);--border2:rgba(60,195,225,0.25);--text:#1a2b2b;--text2:#4a6060;--text3:#8aa0a0;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
    .topbar{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 32px;height:60px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
    .logo-wrap{display:flex;align-items:center;gap:12px}
    .logo-text{font-size:15px;font-weight:600;color:var(--text)}
    .logo-sub{font-size:11px;color:var(--text3);margin-top:1px}
    .pill{font-size:11px;padding:3px 10px;border-radius:20px;background:var(--teal-dim);color:var(--teal-dark);border:1px solid var(--border2);font-weight:500}
    .hero{padding:48px 32px 32px;max-width:900px;margin:0 auto}
    .hero-title{font-size:30px;font-weight:700;color:var(--text);margin-bottom:8px}
    .hero-title span{color:var(--teal)}
    .hero-sub{font-size:14px;color:var(--text2)}
    .search-wrap{max-width:900px;margin:0 auto;padding:0 32px 32px}
    .search-box{display:flex;align-items:center;gap:10px;background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:10px 16px}
    .search-box:focus-within{border-color:var(--teal)}
    .search-box input{flex:1;border:none;outline:none;font-size:14px;color:var(--text);background:transparent;font-family:inherit}
    .search-box input::placeholder{color:var(--text3)}
    .section{max-width:900px;margin:0 auto;padding:0 32px 40px}
    .section-label{font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:14px;display:flex;align-items:center;gap:8px}
    .section-label::after{content:'';flex:1;height:1px;background:var(--border)}
    .tool-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
    .tool-card{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:18px;cursor:pointer;transition:all 0.18s;text-decoration:none;color:inherit;display:block;position:relative;overflow:hidden}
    .tool-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:14px 14px 0 0;opacity:0;transition:opacity 0.18s}
    .tool-card:hover{border-color:var(--teal);transform:translateY(-2px);box-shadow:0 6px 20px rgba(60,195,225,0.1)}
    .tool-card:hover::before{opacity:1}
    .tool-card.primary::before{background:var(--teal)}
    .tool-card.purple-top::before{background:#a78bfa}
    .tool-card.silver-top::before{background:var(--silver)}
    .tool-icon{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;margin-bottom:12px;font-size:18px;background:var(--teal-dim);border:1px solid var(--border2)}
    .tool-icon.silver{background:var(--silver-dim);border-color:var(--border)}
    .tool-icon.purple{background:rgba(167,139,250,0.1);border-color:rgba(167,139,250,0.25)}
    .tool-icon.green{background:rgba(74,222,128,0.1);border-color:rgba(74,222,128,0.25)}
    .tool-name{font-size:13px;font-weight:600;color:var(--text);margin-bottom:3px}
    .tool-desc{font-size:11px;color:var(--text3);line-height:1.5}
    .badge{position:absolute;top:14px;right:14px;font-size:9px;font-weight:600;padding:2px 7px;border-radius:20px}
    .badge-live{background:rgba(74,222,128,0.12);color:#16a34a;border:1px solid rgba(74,222,128,0.25)}
    .badge-new{background:var(--teal-dim);color:var(--teal-dark);border:1px solid var(--border2)}
    .badge-soon{background:var(--silver-dim);color:var(--text3);border:1px solid var(--border)}
    .footer{max-width:900px;margin:0 auto;padding:0 32px 40px}
    .footer-inner{border-top:1px solid var(--border);padding-top:20px;display:flex;align-items:center;justify-content:space-between}
    .footer-left{font-size:11px;color:var(--text3)}
    .source-pill{font-size:10px;padding:2px 8px;border-radius:20px;background:var(--bg3);color:var(--text3);border:1px solid var(--border);margin-left:4px}
    @media(max-width:640px){.tool-grid{grid-template-columns:1fr 1fr}.hero,.section,.search-wrap{padding-left:20px;padding-right:20px}}
  </style>
</head>
<body>
<div class="topbar">
  <div class="logo-wrap">
    <div>
      <div class="logo-text">Aloe PM Internal Hub</div>
      <div class="logo-sub">Phoenix Metro · All systems live</div>
    </div>
  </div>
  <div style="display:flex;gap:8px">
    <span class="pill">AI-Powered</span>
    <span class="pill" style="background:var(--silver-dim);color:var(--text2);border-color:var(--border)">Internal Only</span>
  </div>
</div>

<div class="hero">
  <div class="hero-title">Welcome back to <span>Aloe PM</span></div>
  <div class="hero-sub">Your internal command center for property management, AI agents, and team operations.</div>
</div>

<div class="search-wrap">
  <div class="search-box">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity=".4"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
    <input type="text" placeholder="Search tools…" oninput="filterTools(this.value)"/>
  </div>
</div>

<div class="section">
  <div class="section-label">AI & Automation</div>
  <div class="tool-grid">
    <a href="/chat" class="tool-card primary" data-name="aloe assistant ai chat">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🤖</div>
      <div class="tool-name">Aloe Assistant</div>
      <div class="tool-desc">AI chat — Rentvine, Aptly, Knowledge Base, Slack all connected</div>
    </a>
    <a href="/agents" class="tool-card primary" data-name="agent hub management">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🤖</div>
      <div class="tool-name">Agent Hub</div>
      <div class="tool-desc">Monitor, train, and manage all AI agents — playbooks, knowledge, SOPs, activity feed</div>
    </a>
    <a href="/sms-queue" class="tool-card primary" data-name="sms queue drafts tenant messages">
      <span class="badge badge-new">NEW</span>
      <div class="tool-icon green">💬</div>
      <div class="tool-name">SMS Draft Queue</div>
      <div class="tool-desc">Review and approve AI-drafted responses before sending</div>
    </a>
  </div>
</div>

<div class="section">
  <div class="section-label">Accounting</div>
  <div class="tool-grid">
  <a href="/recon-bills" class="tool-card primary" data-name="recon bills invoices accounting reconcile">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🧾</div>
      <div class="tool-name">Recon — Bills</div>
      <div class="tool-desc">Reconcile vendor invoices against approved work orders</div>
    </a>
    <a href="/expense-log" class="tool-card primary" data-name="expense log payment reimbursement hoa trade fee">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">💳</div>
      <div class="tool-name">Log a Payment</div>
      <div class="tool-desc">Log owner expenses — bill created in Rentvine automatically</div>
    </a>
  </div>
</div>

<div class="section">
  <div class="section-label">Operations</div>
  <div class="tool-grid">
  <a href="https://kb.aloepm.com" target="_blank" class="tool-card primary" data-name="knowledge base sops policies training">
<span class="badge badge-live">LIVE</span>
      <div class="tool-icon">📚</div>
      <div class="tool-name">Knowledge Base</div>
      <div class="tool-desc">SOPs, policies, training, vendor list, cost benchmarks</div>
    </a>
    <a href="https://vendor.aloepm.com" class="tool-card primary" data-name="vendor resources partner apply public">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon silver">🔨</div>
      <div class="tool-name">Vendor Resources</div>
      <div class="tool-desc">Public vendor page — standards, requirements, vendor application</div>
    </a>
    <a href="https://resident.aloepm.com" class="tool-card primary" data-name="tenant resident resources portal help">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🏠</div>
      <div class="tool-name">Tenant Resources</div>
      <div class="tool-desc">Public tenant help portal — policies, maintenance, payments, move-out info</div>
    </a>
    <a href="https://owner.aloepm.com" class="tool-card primary" data-name="owner resources portal landlord help">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon silver">💼</div>
      <div class="tool-name">Owner Resources</div>
      <div class="tool-desc">Public owner portal — fees, disbursements, leasing, guarantees, FAQs</div>
    </a>
    <a href="/renewals" class="tool-card primary" data-name="lease renewals persia renewal dashboard">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🔄</div>
      <div class="tool-name">Lease Renewals</div>
      <div class="tool-desc">Renewal pipeline, offers, calculator — Persia's dashboard</div>
    </a>
    <a href="/vendors/edit" class="tool-card primary" data-name="vendor directory contractor list trade edit">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon silver">🔨</div>
      <div class="tool-name">Vendor Directory</div>
      <div class="tool-desc">Preferred vendor list by trade — add, edit, assign priorities and zones</div>
    </a>
    <a href="/hoa" class="tool-card primary" data-name="hoa form filler registration juan">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">📋</div>
      <div class="tool-name">HOA Form Filler</div>
      <div class="tool-desc">Auto-fill HOA registration PDFs with Rentvine tenant data</div>
    </a>
    <a href="/media-analyzer" class="tool-card primary" data-name="media analyzer video photo inspection transcribe">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🎥</div>
      <div class="tool-name">Property Media Analyzer</div>
      <div class="tool-desc">Upload video or photos — AI transcription, inspection report, vendor list</div>
    </a>
  </div>
</div>

<div class="section">
  <div class="section-label">Reports</div>
  <div class="tool-grid">
    <a href="/map" class="tool-card primary" data-name="property map portfolio map occupied vacant region distance">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🗺️</div>
      <div class="tool-name">Portfolio Map</div>
      <div class="tool-desc">Interactive map — occupied vs vacant, region zones, distance tool</div>
    </a>
    <a href="/metrics" class="tool-card primary" data-name="metrics kpi dashboard portfolio occupancy">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">📊</div>
      <div class="tool-name">KPI Metrics</div>
      <div class="tool-desc">Portfolio changes, occupancy rate, move-ins, lease activity</div>
    </a>
    <a href="/vacancy" class="tool-card primary" data-name="vacancy risk market intelligence">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🏠</div>
      <div class="tool-name">Vacancy Risk</div>
      <div class="tool-desc">Risk scores, market comps, owner reports — all vacant units</div>
    </a>
    <a href="/owner-report" class="tool-card primary" data-name="owner report email generator vacancy">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">📬</div>
      <div class="tool-name">Owner Report Generator</div>
      <div class="tool-desc">AI-drafted vacancy update email per property — one click</div>
    </a>
    <a href="/rent-analysis" class="tool-card primary" data-name="rent analysis market comps zillow">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🏘️</div>
      <div class="tool-name">Rent Analysis</div>
      <div class="tool-desc">Live comps from Zillow, Redfin &amp; Realtor.com · STR/Airbnb</div>
    </a>
    <a href="/sale-analysis" class="tool-card purple-top" data-name="sale analysis comps zestimate owner equity">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon purple">🏡</div>
      <div class="tool-name">Sale Analysis</div>
      <div class="tool-desc">Zestimate + Redfin Estimate + sale comps · owner equity calculator</div>
    </a>
  </div>
</div>

<div class="section">
  <div class="section-label">Integrations</div>
  <div class="tool-grid">
    <a href="https://aloepm.rentvine.com" target="_blank" class="tool-card primary" data-name="rentvine property management tenants leases">
      <div class="tool-icon silver">🤝</div>
      <div class="tool-name">Rentvine</div>
      <div class="tool-desc">Tenant data, leases, work orders, accounting</div>
    </a>
    <a href="https://app.getaptly.com" target="_blank" class="tool-card primary" data-name="aptly crm workflow boards leads">
      <div class="tool-icon">📌</div>
      <div class="tool-name">Aptly</div>
      <div class="tool-desc">CRM, workflow boards, leads, move-ins, HOA</div>
    </a>
    <a href="https://my.quo.com/inbox/PNRRARIpQO" target="_blank" class="tool-card primary" data-name="quo openphone sms messaging calls">
      <div class="tool-icon silver">📱</div>
      <div class="tool-name">Quo / OpenPhone</div>
      <div class="tool-desc">SMS inbox, tenant messaging, call logs</div>
    </a>
<a href="https://kb.aloepm.com" target="_blank" class="tool-card primary" data-name="knowledge base sops policies training">
<span class="badge badge-live">LIVE</span>
      <div class="tool-icon">📚</div>
      <div class="tool-name">Knowledge Base</div>
      <div class="tool-desc">SOPs, policies, training, vendor list, cost benchmarks</div>
    </a>
    <a href="https://drive.google.com" target="_blank" class="tool-card primary" data-name="google drive files documents leases">
      <div class="tool-icon silver">📁</div>
      <div class="tool-name">Google Drive</div>
      <div class="tool-desc">Signed leases, inspection reports, owner docs</div>
    </a>
    <a href="https://slack.com" target="_blank" class="tool-card primary" data-name="slack team communications alerts">
      <div class="tool-icon silver">💼</div>
      <div class="tool-name">Slack</div>
      <div class="tool-desc">Team communications and escalation alerts</div>
    </a>
    <a href="https://zinspector.com/" target="_blank" class="tool-card primary" data-name="zinspector inspections property condition">
      <div class="tool-icon">🔎</div>
      <div class="tool-name">Zinspector</div>
      <div class="tool-desc">Property inspections and condition reports</div>
    </a>
  </div>
</div>

<div class="footer">
  <div class="footer-inner">
    <div class="footer-left">Aloe Property Management · Phoenix Metro · Internal use only</div>
    <div>
      <span class="source-pill">Rentvine</span>
      <span class="source-pill">Aptly</span>
      <span class="source-pill">Quo</span>
      <span class="source-pill">Knowledge Base</span>
      <span class="source-pill">Slack</span>
    </div>
  </div>
</div>

<script>
function filterTools(q) {
  q = q.toLowerCase().trim();
  document.querySelectorAll('.tool-card').forEach(function(card) {
    var name = (card.dataset.name||'') + ' ' + card.querySelector('.tool-name').textContent + ' ' + card.querySelector('.tool-desc').textContent;
    card.style.display = (!q || name.toLowerCase().includes(q)) ? 'block' : 'none';
  });
}
</script>
</body>
</html>`);
});
// Vendor application form submission
app.listen(PORT, () => console.log('Aloe Assistant running on port ' + PORT));

// Vendor Duplicate Bill Check
app.post('/vendor-duplicate-check', express.json(), async (req, res) => {
  try {
    const days = req.body.days || 90;
    const window = req.body.window_days || 7;
    execFile('python3', ['vendor_duplicate_check.py', String(days), String(window)], {
      cwd: '/app',
      env: { ...process.env, PATH: '/opt/venv/bin:' + process.env.PATH },
      maxBuffer: 1024 * 1024 * 10,
      timeout: 120000
    }, (err, stdout, stderr) => {
      if (err) {
        console.error('Vendor duplicate check error:', stderr);
        return res.status(500).json({ error: 'Check failed', detail: stderr });
      }
      try {
        res.json({ ok: true, result: JSON.parse(stdout) });
      } catch {
        res.json({ ok: true, report: stdout });
      }
    });
  } catch (err) {
    console.error('Vendor duplicate check route error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});


