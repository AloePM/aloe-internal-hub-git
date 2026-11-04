// Rentvine's own Recurring Bills list (report "recurring-bills-detail"): the bills Aloe has already set up to post each month.
// Each row is one home's share of one recurring bill. Read-only.
const key = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const moneyN = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : 0; };

const ABBR = { e: 'east', w: 'west', n: 'north', s: 'south', dr: 'drive', ln: 'lane', st: 'street', ave: 'avenue', av: 'avenue', ct: 'court', pl: 'place', rd: 'road', blvd: 'boulevard', cir: 'circle', way: 'way', pkwy: 'parkway', ter: 'terrace', trl: 'trail' };
export function normAddr(s) {
  return String(s || '').toLowerCase().replace(/[.,#]/g, ' ').split(/\s+/).filter(Boolean).map((w) => ABBR[w] || w).join(' ');
}
// "4111 E Baylor Ln - 4111 East Baylor Lane, Gilbert, AZ 85296" -> candidate street strings
export function addressCandidates(payer) {
  return String(payer || '').split(' - ').map((part) => normAddr(part.split(',')[0])).filter(Boolean);
}
const looseKey = (a) => { const w = a.split(' '); const num = w[0]; const name = w.find((x, i) => i > 0 && !['north', 'south', 'east', 'west'].includes(x)); return num + '|' + (name || ''); };

// Pick the right columns whatever the report calls them (works for the on-screen labels and the API field names).
export function pickFields(row) {
  const ks = Object.keys(row || {}), by = {}; ks.forEach((k) => { by[key(k)] = k; });
  const find = (...names) => { for (const n of names) { const hit = ks.find((k) => key(k) === n); if (hit) return hit; } for (const n of names) { const hit = ks.find((k) => key(k).includes(n)); if (hit) return hit; } return null; };
  return {
    payee: find('payee', 'payeename', 'vendorname', 'contactname'),
    payerAmount: find('payeramount'),
    total: find('totalamount'),
    payer: find('payer', 'propertyaddress', 'unitname'),
    propertyID: find('propertyid'),
    memo: find('paymentmemo', 'memo'),
    reference: find('reference'),
    active: find('active', 'isactive'),
    nextDate: find('nextbilldate'),
    end: find('enddate'),
  };
}
export function categoryOf({ payee, memo, reference }) {
  const t = [payee, memo, reference].join(' ').toLowerCase();
  if (/hoa/.test(t)) return 'hoa';
  if (/bug|pest|exterminat/.test(t)) return 'pest';
  if (/landscap|lawn|yard/.test(t)) return 'landscaping';
  if (/pool/.test(t)) return 'pool';
  return 'extra';
}
// rawRows: report rows. props: [{propertyID, propertyAddress, propertyCity}]
export function parseSetup(rawRows, props) {
  const byAddr = {}, byLoose = {};
  for (const p of props || []) { const a = normAddr(p.propertyAddress); if (!a) continue; (byAddr[a] ||= []).push(String(p.propertyID)); (byLoose[looseKey(a)] ||= []).push(String(p.propertyID)); }
  const items = {}, unmatched = []; let used = 0, fields = null;
  for (const r of rawRows || []) {
    const f = (fields ||= pickFields(r)); const get = (n) => (f[n] ? r[f[n]] : '');
    const act = String(get('active')); if (f.active && /^(no|false|0)$/i.test(act.trim())) continue;
    if (/^totals?$/i.test(String(get('nextDate')))) continue;
    const payee = String(get('payee') || '').trim(); const amount = moneyN(get('payerAmount') || get('total'));
    if (!payee || !(amount > 0)) continue;
    let ids = [];
    if (f.propertyID && get('propertyID')) ids = [String(get('propertyID'))];
    else {
      for (const c of addressCandidates(get('payer'))) { if (byAddr[c] && byAddr[c].length === 1) { ids = byAddr[c]; break; } }
      if (!ids.length) for (const c of addressCandidates(get('payer'))) { const l = byLoose[looseKey(c)]; if (l && l.length === 1) { ids = l; break; } }
    }
    if (!ids.length) { unmatched.push({ payer: String(get('payer')), payee, amount }); continue; }
    const memo = String(get('memo') || '').trim(), reference = String(get('reference') || '').trim();
    (items[ids[0]] ||= []).push({ payee, amount, memo, reference, category: categoryOf({ payee, memo, reference }), source: 'rentvine' });
    used++;
  }
  return { byProperty: items, unmatched, used, fields };
}
// Merge Rentvine's recurring list into the history-based expected bills (expected = { propertyID: {pool, pest, landscaping, ownerAdmin, hoa} }).
// Rentvine's list wins for pool / pest / landscaping / HOA. Other bills go to .extra. Steady vendor-invoiced bills from history are added to .extra too (labelled "from invoices"), unless Rentvine already lists that vendor.
export function mergeSetup(expected, setup, historyRows) {
  const out = JSON.parse(JSON.stringify(expected || {}));
  for (const [id, list] of Object.entries(setup.byProperty || {})) {
    const e = (out[id] ||= {});
    for (const it of list) {
      if (['pool', 'pest', 'landscaping'].includes(it.category)) e[it.category] = it.amount;
      else if (it.category === 'hoa') e.hoa = { amount: it.amount, accountID: null, vendor: it.payee, label: 'HOA dues', source: 'rentvine' };
      else (e.extra ||= []).push({ key: 'rb:' + it.payee + ':' + (it.memo || it.reference) + ':' + it.amount, label: it.memo || it.reference || it.payee, vendor: it.payee, amount: it.amount, source: 'rentvine' });
    }
  }
  const SKIP = /pool|landscap|pest|owner\s*admin|hoa/i;
  for (const r of historyRows || []) {
    if (r.cadence !== 'every month' || !r.steady || SKIP.test(r.account || '')) continue;
    const id = String(r.propertyID), listed = (out[id] && out[id].extra) || [];
    if (listed.some((x) => (r.vendors || []).some((v) => String(v).toLowerCase() === String(x.vendor).toLowerCase()))) continue;
    const e = (out[id] ||= {}); (e.extra ||= []).push({ key: 'inv:' + r.account + ':' + (r.vendors || []).join('/'), label: r.account, vendor: (r.vendors || [])[0] || '', amount: r.typical, source: 'invoices', accountID: Number(r.accountID) });
  }
  return out;
}
