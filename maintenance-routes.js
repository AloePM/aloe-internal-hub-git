// Maintenance area for the Internal Hub.
// Installs the /maintenance page and routes under /api/maintenance. Nothing here writes to Rentvine, Zinspector or Slack.
// The only writes are (1) follow-up notes/dates into the hub's own Supabase table and (2) one comment at a time on an Aptly Work Orders card,
// each only after the person reviews and confirms it. Write-back to Rentvine fields is a later step.
//
// Install (one line in server.js, after installMoveoutProperty):
//   const { installMaintenance } = await import('./maintenance-routes.js'); installMaintenance(app, rvFetch, fetchAllRVOpenWOs, findBillMatchedWOs, unitsFetch);
import { addrKey, extractServices, readProperty } from './moveouts-property.js';
import { groupOpenByProperty, readCategories, applianceRows, warrantyRows, findWarrantyExpires, findNotes, buildHints, whoPays, todayPhoenix, ownerVendors, homeWarrantyInfo, mapHistory, assignCards, buildWorkOrderRows, STAGE_ORDER } from './maintenance-data.js';
import { loadAriRows, ariForAddress } from './maintenance-ari.js';
import { indexAptly, aptlyDiag, buildToday, foldFollowups, withNotes } from './maintenance-today.js';
import { validateEntry, makeFollowupStore } from './maintenance-followups.js';
import { validateComment, followupComment, formatComment, makeAptlyCommenter, mapComments } from './maintenance-comments.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

const LIST_TTL = 2 * 60 * 1000, PROP_TTL = 5 * 60 * 1000, CLOSE_TTL = 15 * 60 * 1000;

// Sign-in check for /api/maintenance. The hub's API lock only covers the prefixes listed in HUB_API_ENFORCE_PREFIXES,
// and /api/maintenance is not on that list, so these routes check the same session cookie themselves (fail closed).
// If the hub's sign-in is switched off (no password/secret set) this lets everything through, exactly like the rest of the hub.
export function sessionOk(req, env = process.env) {
  const secret = env.HUB_SESSION_SECRET;
  if (!(env.HUB_LOGIN_PASSWORD && secret && secret.length >= 16)) return true;
  let raw = '';
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === 'aloe_hub_session') { try { raw = decodeURIComponent(part.slice(i + 1).trim()); } catch { raw = ''; } }
  }
  const [exp, sig] = raw.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const want = createHmac('sha256', secret).update('v1.' + exp).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function installMaintenance(app, rvFetch, fetchOpenWOs, findBillMatched, aptlyFetch, store = makeFollowupStore(), commenter = makeAptlyCommenter()) {
  if (typeof rvFetch !== 'function' || typeof fetchOpenWOs !== 'function') throw new Error('installMaintenance needs rvFetch and fetchAllRVOpenWOs');
  let listCache = { at: 0, v: null }, listPending = null;
  const propCache = new Map();

  // Property id -> street address, read the same way Move-outs reads it (/properties/export). Open work orders from
  // Rentvine do not always carry an address, so this fills the gap. Cached 6 hours; a failed read is not cached.
  let addrMap = null, addrAt = 0, addrInflight = null;
  async function getAddresses() {
    if (addrMap && Date.now() - addrAt < 6 * 3600 * 1000) return addrMap;
    if (!addrInflight) addrInflight = (async () => {
      const map = new Map();
      for (let page = 1; page <= 10; page++) {
        const b = await rvFetch('/properties/export', { pageSize: 500, page });
        if (b && b.error) throw new Error(b.error);
        const items = Array.isArray(b) ? b : (b && (b.data || b.results)) || [];
        if (!items.length) break;
        for (const it of items) { const p = it.property || it; if (p && p.propertyID && p.address) map.set(String(p.propertyID), String(p.address).trim()); }
        if (items.length < 500) break;
      }
      addrMap = map; addrAt = Date.now(); return map;
    })().finally(() => { addrInflight = null; });
    return addrInflight;
  }
  const addressFor = async (pid) => { try { return (await getAddresses()).get(String(pid)) || ''; } catch (e) { console.error('[maintenance] addresses', e.message); return ''; } };

  app.use('/api/maintenance', (req, res, next) => {
    if (sessionOk(req)) return next();
    res.set('Cache-Control', 'no-store');
    return res.status(401).json({ error: 'Unauthorized' });
  });

  app.get('/maintenance', (req, res) => res.sendFile(new URL('./public/maintenance.html', import.meta.url).pathname));

  // Properties that have at least one open work order (same "open" rule as the Home page).
  app.get('/api/maintenance/properties', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!(listCache.v && Date.now() - listCache.at < LIST_TTL) || req.query.fresh === '1') {
        if (!listPending) listPending = fetchOpenWOs().then(async (wos) => {
          const properties = groupOpenByProperty(wos);
          if (properties.some((g) => !g.address)) { for (const g of properties) if (!g.address) g.address = await addressFor(g.propertyId); properties.sort((a, b) => (b.oldestDays ?? -1) - (a.oldestDays ?? -1) || a.address.localeCompare(b.address)); }
          listCache = { at: Date.now(), v: { properties, openTotal: wos.length, asOf: new Date().toISOString() } };
        }).finally(() => { listPending = null; });
        await listPending;
      }
      res.json(listCache.v);
    } catch (e) { console.error('[maintenance] list', e.message); res.status(502).json({ error: 'Could not read open work orders from Rentvine.' }); }
  });

  // One row per open work order (vendor, stage, issue type, emergency keyword flag). Read-only, cached 2 minutes, shared by the work order view and Today.
  let woCache = { at: 0, v: null }, woPending = null;
  async function getWORows(fresh) {
    if (!(woCache.v && Date.now() - woCache.at < LIST_TTL) || fresh) {
      if (!woPending) woPending = (async () => {
        let all = [];
        for (let page = 1; page <= 20; page++) {
          const b = await rvFetch('/maintenance/work-orders', { pageSize: 100, page });
          if (b && b.error) throw new Error(b.error);
          const items = Array.isArray(b) ? b : (b && b.data) || [];
          all = all.concat(items);
          if (items.length < 100) break;
        }
        const rows = buildWorkOrderRows(all, todayPhoenix());
        if (rows.some((r) => !r.address)) for (const r of rows) if (!r.address && r.propertyId) r.address = await addressFor(r.propertyId);
        woCache = { at: Date.now(), v: { rows, stages: STAGE_ORDER, asOf: new Date().toISOString() } };
      })().finally(() => { woPending = null; });
      await woPending;
    }
    return woCache.v;
  }
  app.get('/api/maintenance/workorders', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { const v = await getWORows(req.query.fresh === '1'); const m = await cardIdMap(); res.json({ ...v, rows: v.rows.map((r) => ({ ...r, cardId: cardOf(m, r.number) })) }); }
    catch (e) { console.error('[maintenance] workorders', e.message); res.status(502).json({ error: 'Could not read work orders from Rentvine.' }); }
  });

  // Aptly card id for a work order number (for the page's Aptly links). Uses the board read the hub already does; never fails the page.
  async function cardIdMap() { try { const a = await getAptly(false); return a.available ? a.map : new Map(); } catch { return new Map(); } }
  const cardOf = (m, n) => { const c = (m.get(String(n)) || {}).cardId || ''; return /^[A-Za-z0-9]{8,40}$/.test(c) ? c : ''; };
  async function withCards(v) { const m = await cardIdMap(); return { ...v, history: (v.history || []).map((w) => ({ ...w, cardId: cardOf(m, w.number) })) }; }
  // Aptly Work Orders board (stage, vendor-assigned date, last contact). Read-only GET through the hub's own Aptly reader, cached 5 minutes. Soft-fails.
  let aptCache = { at: 0, map: null }, aptPending = null;
  async function getAptly(fresh) {
    if (typeof aptlyFetch !== 'function') return { available: false, map: new Map() };
    if (!(aptCache.map && Date.now() - aptCache.at < PROP_TTL) || fresh) {
      if (!aptPending) aptPending = (async () => {
        let all = [];
        for (let page = 0; page <= 60; page++) {
          const d = await aptlyFetch('/api/board/workOrder', { page, pageSize: 100, includeArchived: false });
          if (d && d.error) throw new Error(d.error);
          const batch = Array.isArray(d) ? d : (d && d.data) || [];
          if (!batch.length) break;
          all = all.concat(batch);
          if (batch.length < 100) break;
        }
        aptCache = { at: Date.now(), map: indexAptly(all) };
      })().finally(() => { aptPending = null; });
      await aptPending;
    }
    return { available: true, map: aptCache.map };
  }

  // A card's comments. The board list does not carry them; Aptly has a per-card address: GET /api/board/workOrder/<cardId>/comments -> { data: [...] }.
  // Cached 5 minutes per card (dropped when this hub posts a comment). A failed read throws, so "could not read" is never shown as "no comments".
  const cmCache = new Map();
  async function getComments(cardId, fresh) {
    const hit = cmCache.get(cardId);
    if (hit && !fresh && Date.now() - hit.at < PROP_TTL) return hit.list;
    if (!/^[A-Za-z0-9]{8,40}$/.test(String(cardId || ''))) throw new Error('bad card id');
    const d = await aptlyFetch('/api/board/workOrder/' + cardId + '/comments');
    if (!d || d.error) throw new Error((d && d.error) || 'no answer');
    const list = mapComments(Array.isArray(d) ? d : d.data);
    cmCache.set(cardId, { at: Date.now(), list });
    return list;
  }
  // Read the comments for many cards, 6 at a time, within a time budget. Cards not read in time are left "unknown" (never shown as "no note").
  async function loadNotes(cardIds, budgetMs = 8000) {
    const out = new Map(), todo = [];
    for (const id of cardIds) { const hit = cmCache.get(id); if (hit && Date.now() - hit.at < PROP_TTL) out.set(id, hit.list); else todo.push(id); }
    const end = Date.now() + budgetMs; let i = 0;
    const worker = async () => { while (i < todo.length && Date.now() < end) { const id = todo[i++]; try { out.set(id, await getComments(id, true)); } catch (e) { console.error('[maintenance] comments read', e.message); } } };
    await Promise.race([Promise.all(Array.from({ length: 6 }, worker)), new Promise((r) => setTimeout(r, budgetMs + 1000))]);
    return out;
  }

  // Roberto's daily list: sections of work orders that need a touch today, with why.
  app.get('/api/maintenance/today', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const fresh = req.query.fresh === '1';
      const wo = await getWORows(fresh);
      let apt = { available: false, map: new Map() };
      try { apt = await getAptly(fresh); } catch (e) { console.error('[maintenance] aptly', e.message); }
      let notes = { requested: 0, loaded: 0 };
      if (apt.available) {
        // Add each open work order's comments (read per card). The cached board map is not changed.
        const ids = []; for (const r of wo.rows) { const a = apt.map.get(String(r.number)); if (a && a.cardId && !a.notesKnown) ids.push(a.cardId); }
        const got = await loadNotes([...new Set(ids)]);
        const map = new Map(apt.map);
        for (const [k, a] of apt.map) if (a.cardId && got.has(a.cardId)) map.set(k, withNotes(a, got.get(a.cardId)));
        apt = { ...apt, map }; notes = { requested: new Set(ids).size, loaded: got.size };
      }
      let fu = { available: false, reason: 'error', rows: [] };
      try { fu = await store.list(); } catch (e) { console.error('[maintenance] followups', e.message); }
      const t = buildToday(wo.rows, apt.map, foldFollowups(fu.rows), todayPhoenix());
      res.json({ ...t, openTotal: wo.rows.length, asOf: new Date().toISOString(),
        aptly: { available: apt.available, ...(apt.available ? aptlyDiag(apt.map) : {}), notes }, followups: { available: fu.available, reason: fu.reason || '' }, canComment: !!(commenter.configured && apt.available) });
    } catch (e) { console.error('[maintenance] today', e.message); res.status(502).json({ error: 'Could not build the Today list from Rentvine.' }); }
  });

  // Same-origin + custom-header check used by every write route, so another website cannot trigger a write.
  function writeGuard(req, res) {
    res.set('Cache-Control', 'no-store');
    if (req.headers['x-requested-with'] !== 'aloe-hub') { res.status(400).json({ error: 'Bad request.' }); return false; }
    const origin = req.headers.origin;
    if (origin) { try { if (new URL(origin).host !== req.headers.host) { res.status(403).json({ error: 'Not allowed.' }); return false; } } catch { res.status(403).json({ error: 'Not allowed.' }); return false; } }
    return true;
  }
  const NOT_POSTED = {
    not_configured: 'Posting to Aptly is not set up. Nothing was posted.', bad_card: 'The Aptly card could not be identified. Nothing was posted.',
  };
  const postReason = (r) => NOT_POSTED[r.reason] || 'Aptly did not accept the comment (' + String(r.reason || 'error').replace('aptly_', 'error ') + '). Nothing was posted.';

  // Comments on a work order's Aptly card, newest first. Read-only; "fresh=1" re-reads the board.
  app.get('/api/maintenance/comments', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const wo = String(req.query.wo || '');
    if (!/^\d{3,9}$/.test(wo)) return res.status(400).json({ error: 'Bad work order number.' });
    try {
      const apt = await getAptly(req.query.fresh === '1');
      const info = apt.map.get(wo);
      if (!apt.available) return res.json({ available: false, found: false, canPost: false, comments: [] });
      if (!info) return res.json({ available: true, found: false, canPost: false, comments: [] });
      const list = await getComments(info.cardId, req.query.fresh === '1');
      res.json({ available: true, found: true, canPost: !!(commenter.configured && info.cardId), asOf: new Date().toISOString(),
        comments: list.map((c) => ({ by: c.by, at: c.at, text: c.text, auto: c.auto, hub: c.hub })) });
    } catch (e) { console.error('[maintenance] comments', e.message); res.status(502).json({ error: 'Could not read the Aptly card comments.' }); }
  });

  // Post ONE comment on the work order's Aptly card. Needs sign-in, the custom header, same origin, a picked name, and 30 posts per 10 minutes.
  const cwrites = [];
  app.post('/api/maintenance/comments', async (req, res) => {
    if (!writeGuard(req, res)) return;
    const now = Date.now(); while (cwrites.length && now - cwrites[0] > 600000) cwrites.shift();
    if (cwrites.length >= 30) return res.status(429).json({ error: 'Too many comments. Wait a few minutes.' });
    const v = validateComment(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    try {
      const apt = await getAptly(true);
      const info = apt.available ? apt.map.get(v.woNumber) : null;
      if (!info || !info.cardId) return res.status(404).json({ error: 'No Aptly card was found for this work order. Nothing was posted.' });
      const r = await commenter.post(info.cardId, v.content);
      if (!r.ok) { console.error('[maintenance] comment refused wo=' + v.woNumber + ' reason=' + r.reason + ' ' + (r.detail || '')); return res.status(502).json({ error: postReason(r) }); }
      cwrites.push(now); aptCache.at = 0; cmCache.delete(info.cardId);
      console.log('[maintenance] comment posted wo=' + v.woNumber + ' by=' + v.authorName + ' chars=' + v.text.length);
      res.json({ ok: true, content: v.content });
    } catch (e) { console.error('[maintenance] comment write', e.message); res.status(502).json({ error: 'Could not post. Nothing was changed.' }); }
  });

  // Follow-up notes for one work order (history, newest first).
  app.get('/api/maintenance/followups', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const wo = String(req.query.wo || '');
    if (!/^\d{3,9}$/.test(wo)) return res.status(400).json({ error: 'Bad work order number.' });
    try {
      const fu = await store.list();
      const s = foldFollowups(fu.rows).byWo[wo] || { followUpOn: null, notes: [] };
      res.json({ available: fu.available, reason: fu.reason || '', followUpOn: s.followUpOn, notes: s.notes });
    } catch (e) { console.error('[maintenance] followups', e.message); res.status(502).json({ error: 'Could not read follow-up notes.' }); }
  });

  // Save a note / set or clear a follow-up date in the hub's own table, and (only if the person ticks the box) also one comment on the Aptly card. Needs the sign-in cookie (checked above), a custom
  // header, and a same-origin request, so another website cannot trigger it. 40 writes per 10 minutes.
  const writes = [];
  app.post('/api/maintenance/followups', async (req, res) => {
    if (!writeGuard(req, res)) return;
    const now = Date.now(); while (writes.length && now - writes[0] > 600000) writes.shift();
    if (writes.length >= 40) return res.status(429).json({ error: 'Too many saves. Wait a few minutes.' });
    const v = validateEntry(req.body, todayPhoenix());
    if (v.error) return res.status(400).json({ error: v.error });
    try {
      const r = await store.add(v.entry);
      if (!r.ok) return res.status(503).json({ error: r.reason === 'no_table' ? 'The follow-up table has not been created yet.' : 'Follow-up saving is not set up.', reason: r.reason });
      writes.push(now);
      const out = { ok: true };
      // Optional: also post the same follow-up on the Aptly card (the person ticked the box). The hub save above is already done either way.
      if (req.body && req.body.alsoComment === true) {
        const text = followupComment(v.entry);
        if (!text) out.commentError = 'Nothing to post on the Aptly card.';
        else {
          try {
            const apt = await getAptly(true); const info = apt.available ? apt.map.get(v.entry.wo_number) : null;
            if (!info || !info.cardId) out.commentError = 'Saved in the hub, but no Aptly card was found, so nothing was posted there.';
            else {
              const pr = await commenter.post(info.cardId, formatComment(v.entry.author_name, text));
              if (pr.ok) { aptCache.at = 0; cmCache.delete(info.cardId); out.commentPosted = true; console.log('[maintenance] comment posted wo=' + v.entry.wo_number + ' by=' + v.entry.author_name + ' (follow-up)'); }
              else { console.error('[maintenance] comment refused wo=' + v.entry.wo_number + ' reason=' + pr.reason + ' ' + (pr.detail || '')); out.commentError = 'Saved in the hub, but ' + postReason(pr).replace(' Nothing was posted.', ' It was not posted on the Aptly card.'); }
            }
          } catch (e) { console.error('[maintenance] follow-up comment', e.message); out.commentError = 'Saved in the hub, but posting on the Aptly card failed.'; }
        }
      }
      res.json(out);
    } catch (e) { console.error('[maintenance] followup write', e.message); res.status(502).json({ error: 'Could not save. Nothing was changed.' }); }
  });

  // Open work orders that already have an invoice (same matching the nightly Slack post uses). Read-only, cached 15 minutes.
  let closeCache = { at: 0, v: null }, closePending = null;
  app.get('/api/maintenance/closing-out', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (typeof findBillMatched !== 'function') return res.json({ available: false, items: [] });
    try {
      if (!(closeCache.v && Date.now() - closeCache.at < CLOSE_TTL) || req.query.fresh === '1') {
        if (!closePending) closePending = Promise.resolve(findBillMatched()).then((rows) => {
          const byNum = new Map();
          for (const g of (listCache.v && listCache.v.properties) || []) for (const it of g.items) byNum.set(String(it.number), g);
          const items = (Array.isArray(rows) ? rows : []).map((r) => {
            const g = byNum.get(String(r.woNumber));
            return { woNumber: String(r.woNumber || ''), address: String(r.address || (g && g.address) || '').trim(), propertyId: g ? g.propertyId : '', vendor: String(r.vendorName || ''),
              amount: r.billAmount === '' || r.billAmount == null ? '' : String(r.billAmount), billDate: String(r.billDate || '').slice(0, 10), match: String(r.matchType || '') };
          });
          closeCache = { at: Date.now(), v: { available: true, items, asOf: new Date().toISOString() } };
        }).finally(() => { closePending = null; });
        await closePending;
      }
      res.json(closeCache.v);
    } catch (e) { console.error('[maintenance] closing-out', e.message); res.json({ available: false, items: [], error: 'Could not check invoices right now.' }); }
  });

  // Everything for one property.
  app.get('/api/maintenance/property/:pid', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const pid = req.params.pid;
    if (!/^\d{1,9}$/.test(pid)) return res.status(400).json({ error: 'Bad property id.' });
    const hit = propCache.get(pid);
    if (hit && Date.now() - hit.at < PROP_TTL && req.query.fresh !== '1') return res.json(await withCards(hit.v));
    try {
      const { parts, via } = await readProperty(rvFetch, pid);
      const detail = parts[0] || {};
      const p = detail.property || detail;
      // Rentvine's property record shape varies, so fall back to the address the list already showed (display and Ari matching only).
      const address = String((await addressFor(pid)) || p.address || p.fullAddress || p.name || req.query.address || '').trim().slice(0, 200);
      const sv = extractServices(parts);
      const services = sv.services.map((s) => ({ ...s, ...(() => { const w = whoPays(s.raw); return { who: w.who, text: w.text, doNotCharge: w.who === 'owner' || w.who === 'hoa' }; })() }));

      // custom fields by category (appliance details, dates)
      let cats = [];
      const vals = await rvFetch('/custom-fields/values/5/' + pid, {});
      if (vals && !vals.error) cats = readCategories(vals);
      const appliances = applianceRows(cats);
      const warranty = warrantyRows(cats, findWarrantyExpires(detail));
      const homeWarranty = homeWarrantyInfo(cats, findWarrantyExpires(detail));
      const vendors = ownerVendors(cats);

      // work order history (24 months, same mapping Move-outs uses)
      let all = [];
      for (let page = 1; page <= 5; page++) {
        const b = await rvFetch('/maintenance/work-orders', { pageSize: 100, page, propertyID: pid });
        if (b && b.error) throw new Error(b.error);
        const items = Array.isArray(b) ? b : (b && b.data) || [];
        all = all.concat(items);
        if (items.length < 100) break;
      }
      const history = mapHistory(all);
      const openItems = history.filter((w) => !w.closed && !/^(Completed|Cancelled|Rejected|Completed Already Billed)$/.test(w.status));

      // Ari activity (soft-fail: the panel still works without it)
      let ari = { available: false, items: [] };
      try { const rows = await loadAriRows(); if (rows) ari = { available: true, items: ariForAddress(rows, address, addrKey) }; } catch (e) { console.error('[maintenance] ari', e.message); }

      const v = {
        propertyId: pid, address, status: String(p.status || p.statusName || ''), source: via,
        services, serviceWarnings: sv.warnings, notes: findNotes(detail),
        appliances, warranty, homeWarranty, ownerVendors: vendors, history, openCount: openItems.length,
        hints: buildHints({ history, openItems, warranty, appliances, services }, todayPhoenix()),
        cards: assignCards(openItems, { history, homeWarranty, ownerVendors: vendors, notes: findNotes(detail), appliances, services }, todayPhoenix()),
        ari, asOf: new Date().toISOString(),
      };
      propCache.set(pid, { at: Date.now(), v });
      if (propCache.size > 300) propCache.delete(propCache.keys().next().value);
      res.json(await withCards(v));
    } catch (e) { console.error('[maintenance] property', e.message); res.status(502).json({ error: 'Could not read this property from Rentvine.' }); }
  });
}
