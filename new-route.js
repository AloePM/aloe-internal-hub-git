async function checkVendorDuplicates(days, windowDays) {
  const RENTVINE_BASE = `https://${process.env.RENTVINE_ACCOUNT}.rentvine.com/api/manager`;
  const RENTVINE_AUTH = Buffer.from(`${process.env.RENTVINE_API_KEY}:${process.env.RENTVINE_API_SECRET}`).toString('base64');
  const RECURRING_CHARGE_ACCOUNT_IDS = new Set([79, 83, 77]); // Landscaping, Pool Services, Pest Control

  const dateMin = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let allRows = [];
  for (let page = 1; page <= 20; page++) {
    const url = new URL(`${RENTVINE_BASE}/accounting/payables/search`);
    url.searchParams.set('page', page);
    url.searchParams.set('pageSize', 200);
    url.searchParams.set('datePostedMin', dateMin);
    url.searchParams.set('isVoided', 'false');
    const r = await fetch(url.toString(), {
      headers: { Authorization: `Basic ${RENTVINE_AUTH}`, 'X-Rentvine-Account': process.env.RENTVINE_ACCOUNT }
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Rentvine ${r.status}: ${txt.slice(0, 200)}`);
    }
    const data = await r.json();
    const rows = Array.isArray(data) ? data : (data.data || []);
    if (!rows.length) break;
    allRows = allRows.concat(rows);
    if (rows.length < 200) break;
  }

  const bills = allRows.map(row => {
    const bill = row.bill || {};
    const txn = row.transaction || {};
    const contact = row.contact || {};
    const prop = row.property || {};
    let amount = parseFloat(txn.amount || 0);
    if (isNaN(amount)) amount = 0;
    return {
      billID: bill.billID,
      vendor_id: contact.contactID,
      vendor_name: contact.name || '',
      property_id: prop.propertyID,
      property_address: prop.address || '',
      amount: Math.round(amount * 100) / 100,
      date_posted: txn.datePosted || '',
      chargeAccountID: txn.chargeAccountID,
      voided: (bill.isVoided === 1 || bill.isVoided === '1' || bill.isVoided === true) ? '1' : '0',
      reference: bill.reference || ''
    };
  });

  const groups = {};
  bills.forEach(b => {
    const key = `${b.vendor_id}|${b.property_id}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(b);
  });

  const duplicates = [];
  Object.values(groups).forEach(groupBills => {
    groupBills.sort((a, b) => (a.date_posted || '').localeCompare(b.date_posted || ''));
    for (let i = 0; i < groupBills.length; i++) {
      for (let j = i + 1; j < groupBills.length; j++) {
        const a = groupBills[i], b = groupBills[j];
        if (a.billID === b.billID) continue;
        if (a.amount !== b.amount || a.amount === 0) continue;
        const dateA = new Date(a.date_posted.slice(0, 10));
        const dateB = new Date(b.date_posted.slice(0, 10));
        if (isNaN(dateA) || isNaN(dateB)) continue;
        const daysApart = Math.abs((dateB - dateA) / (1000 * 60 * 60 * 24));
        if (daysApart > windowDays) continue;
        const isRecurring = RECURRING_CHARGE_ACCOUNT_IDS.has(parseInt(a.chargeAccountID));
        duplicates.push({
          bill_a: a, bill_b: b, vendor: a.vendor_name, property: a.property_address,
          amount: a.amount, days_apart: daysApart, is_recurring_category: isRecurring
        });
      }
    }
  });

  return {
    period_days: days, window_days: windowDays,
    total_bills_scanned: bills.length,
    duplicate_pairs_found: duplicates.length,
    duplicates
  };
}

app.post('/vendor-duplicate-check', express.json(), async (req, res) => {
  try {
    const days = req.body.days || 90;
    const windowDays = req.body.window_days || 7;
    const result = await checkVendorDuplicates(days, windowDays);
    res.json({ ok: true, result });
  } catch (err) {
    console.error('Vendor duplicate check error:', err.message);
    res.status(500).json({ error: 'Check failed', detail: err.message });
  }
});
