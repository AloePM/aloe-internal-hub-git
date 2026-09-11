async function main() {
  const HUB = 'https://hub.aloepm.com';

  const getRes = await fetch(`${HUB}/api/jobs`);
  if (!getRes.ok) throw new Error(`GET /api/jobs failed: ${getRes.status}`);
  const data = await getRes.json();
  const jobs = data.jobs || [];

  const jobId = 'bo-vendor-duplicate-check';
  if (jobs.some(j => j.id === jobId)) {
    console.log('Job already exists in jobs.json — not adding a duplicate. Nothing changed.');
    return;
  }

  jobs.push({
    id: jobId,
    name: 'Bo - Vendor Duplicate Check',
    agent: 'Bo',
    type: 'ai_agent',
    what: 'Scans recent vendor bills (excluding Aloe internal accounts) for possible duplicates, flags new ones to #bo-accounting',
    schedule: 'Daily (internal timer)',
    mechanism: 'PM2 internal timer',
    livesAt: "aloe-agents/bo.js on aloe-agent-server (VM, PM2 process 'bo')",
    status: 'live',
    notifies: '#bo-accounting',
    live: {}
  });

  const postRes = await fetch(`${HUB}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobs })
  });
  const result = await postRes.json();
  console.log('POST result:', JSON.stringify(result));
  console.log(`Total jobs now: ${jobs.length}`);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
