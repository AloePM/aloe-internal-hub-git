const fs = require('fs');
const path = 'bo.js';
const content = fs.readFileSync(path, 'utf8');

const anchor1 = `const { BO_TOOLS, executeTool } = require('./bo-tools');

function buildSystemPrompt() {`;

const newBlock1 = `const { BO_TOOLS, executeTool } = require('./bo-tools');
const { execSync } = require('child_process');

const HUB_URL = process.env.HUB_URL || 'https://aloe-internal-hub-git-t7c5rx67tq-wn.a.run.app';
const DUP_LOG_PATH = 'gs://aloe-hub-data-496300/vendor-duplicates-log.json';
const BO_ACCOUNTING_CHANNEL = 'C0BCCV790VC';

function azToday() {
  const azNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Phoenix' }));
  return azNow.toISOString().slice(0, 10);
}

function loadDuplicateLog() {
  try {
    const raw = execSync(\`gsutil cat \${DUP_LOG_PATH}\`, { timeout: 15000 }).toString();
    return JSON.parse(raw);
  } catch (e) {
    console.log('[bo] No existing duplicate log found in GCS, starting fresh.');
    return {};
  }
}

function saveDuplicateLog(log) {
  const tmpPath = '/tmp/vendor-duplicates-log.json';
  fs.writeFileSync(tmpPath, JSON.stringify(log, null, 2));
  try {
    execSync(\`gsutil cp \${tmpPath} \${DUP_LOG_PATH}\`, { timeout: 15000 });
    console.log('[bo] Duplicate log saved to GCS.');
  } catch (e) {
    console.error('[bo] Failed to save duplicate log to GCS:', e.message);
  }
}

async function runDailyVendorDuplicateCheck() {
  console.log('[bo] Running daily vendor duplicate check...');
  try {
    const resp = await fetch(\`\${HUB_URL}/vendor-duplicate-check\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 90, window_days: 7 }),
      signal: AbortSignal.timeout(120000)
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(\`[bo] Daily duplicate check failed: Hub returned \${resp.status}: \${errText.slice(0, 300)}\`);
      return;
    }
    const data = await resp.json();
    const duplicates = (data.result && data.result.duplicates) || [];

    const log = loadDuplicateLog();
    const today = azToday();
    const newOnes = [];

    duplicates.forEach(dup => {
      const ids = [dup.bill_a.billID, dup.bill_b.billID].sort();
      const key = ids.join('-');
      if (!log[key]) {
        log[key] = {
          first_seen: today,
          vendor: dup.vendor,
          property: dup.property,
          amount: dup.amount,
          bill_a: dup.bill_a.billID,
          bill_b: dup.bill_b.billID,
          is_recurring_category: dup.is_recurring_category
        };
        newOnes.push(dup);
      }
    });

    if (newOnes.length > 0) {
      const lines = newOnes.map(d =>
        \`• *\${d.vendor}* — \${d.property || '(no property)'} — $\${d.amount} — bills #\${d.bill_a.billID} & #\${d.bill_b.billID}, \${d.days_apart} day(s) apart\${d.is_recurring_category ? ' _(recurring vendor — verify, not necessarily a duplicate)_' : ''}\`
      ).join('\\n');
      await app.client.chat.postMessage({
        channel: BO_ACCOUNTING_CHANNEL,
        text: \`🔍 *Daily vendor duplicate check — \${newOnes.length} new possible duplicate(s) found:*\\n\${lines}\`
      });
      console.log(\`[bo] Posted \${newOnes.length} new duplicate(s) to #bo-accounting.\`);
    } else {
      console.log('[bo] Daily duplicate check: nothing new.');
    }

    saveDuplicateLog(log);
  } catch (e) {
    console.error('[bo] Daily duplicate check error:', e.message);
  }
}

function scheduleDailyVendorDuplicateCheck() {
  const azNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Phoenix' }));
  const nextRun = new Date(azNow);
  nextRun.setHours(7, 0, 0, 0);
  if (nextRun <= azNow) nextRun.setDate(nextRun.getDate() + 1);
  const msUntil = nextRun.getTime() - azNow.getTime();
  console.log(\`[bo] Daily vendor duplicate check scheduled in \${Math.round(msUntil / 60000)} min.\`);
  setTimeout(() => {
    runDailyVendorDuplicateCheck();
    setInterval(runDailyVendorDuplicateCheck, 24 * 60 * 60 * 1000);
  }, msUntil);
}

function buildSystemPrompt() {`;

const count1 = content.split(anchor1).length - 1;
if (count1 !== 1) {
  console.error(`ABORT step 1: expected exactly 1 match for anchor1, found ${count1}. No changes made.`);
  process.exit(1);
}

const anchor2 = `  await app.start();
  console.log('⚡ Bo is online with live Rentvine access');
})();`;

const newBlock2 = `  await app.start();
  console.log('⚡ Bo is online with live Rentvine access');
  scheduleDailyVendorDuplicateCheck();
})();`;

const count2 = content.split(anchor2).length - 1;
if (count2 !== 1) {
  console.error(`ABORT step 2: expected exactly 1 match for anchor2, found ${count2}. No changes made.`);
  process.exit(1);
}

const backupPath = 'bo.js.bak-dailycheck-' + Date.now();
fs.writeFileSync(backupPath, content);
console.log('Backed up to: ' + backupPath);

let updated = content.replace(anchor1, newBlock1);
updated = updated.replace(anchor2, newBlock2);
fs.writeFileSync(path, updated);
console.log('Patched successfully.');
