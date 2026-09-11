const fs = require('fs');
const path = 'server.js';
const content = fs.readFileSync(path, 'utf8');

const oldStr = `  const RECURRING_CHARGE_ACCOUNT_IDS = new Set([79, 83, 77]); // Landscaping, Pool Services, Pest Control`;
const newStr = `  const RECURRING_CHARGE_ACCOUNT_IDS = new Set([79, 83, 77]); // Landscaping, Pool Services, Pest Control
  const ALOE_INTERNAL_VENDOR_IDS = new Set(['1', '3229', '3380']); // Aloe Property Management, Reimbursements, Aloe PM-Vendor — excluded, this check is vendor-only`;

const count1 = content.split(oldStr).length - 1;
if (count1 !== 1) { console.error(`ABORT step 1: expected 1 match, found ${count1}.`); process.exit(1); }

const oldStr2 = `  const groups = {};
  bills.forEach(b => {
    const key = \`\${b.vendor_id}|\${b.property_id}\`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(b);
  });`;
const newStr2 = `  const filteredBills = bills.filter(b => !ALOE_INTERNAL_VENDOR_IDS.has(String(b.vendor_id)));

  const groups = {};
  const needsManualMatch = [];
  filteredBills.forEach(b => {
    if (!b.property_id) { needsManualMatch.push(b); return; }
    const key = \`\${b.vendor_id}|\${b.property_id}\`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(b);
  });`;

const count2 = content.split(oldStr2).length - 1;
if (count2 !== 1) { console.error(`ABORT step 2: expected 1 match, found ${count2}.`); process.exit(1); }

const oldStr3 = `  return {
    period_days: days, window_days: windowDays,
    total_bills_scanned: bills.length,
    duplicate_pairs_found: duplicates.length,
    duplicates
  };
}`;
const newStr3 = `  return {
    period_days: days, window_days: windowDays,
    total_bills_scanned: filteredBills.length,
    duplicate_pairs_found: duplicates.length,
    duplicates,
    needs_manual_match: needsManualMatch
  };
}`;

const count3 = content.split(oldStr3).length - 1;
if (count3 !== 1) { console.error(`ABORT step 3: expected 1 match, found ${count3}.`); process.exit(1); }

const backupPath = 'server.js.bak-duplocope-' + Date.now();
fs.writeFileSync(backupPath, content);
console.log('Backed up to: ' + backupPath);

let updated = content.replace(oldStr, newStr);
updated = updated.replace(oldStr2, newStr2);
updated = updated.replace(oldStr3, newStr3);
fs.writeFileSync(path, updated);
console.log('Patched successfully.');
