// router-classifier.js
// ES module -- server.js uses "type": "module" / import syntax throughout,
// confirmed 2026-08-28. This file follows suit.
//
// STATUS: SHADOW MODE ONLY.
// This file does not send any replies, does not forward any messages to any
// agent, and does not touch the existing Quo -> Ari forwarding path in any
// way. It only classifies each inbound Quo message and posts the result to
// Slack (#router-shadow, channel C0BTCF1CYE7) for Randi to review. Nothing
// here writes to Rentvine or Aptly, and nothing here holds any agent's
// tools -- this file does exactly one job (classify + log) on purpose, so
// it can never become a shared-dependency risk the way hub-client.js was.
//
// CONFIRMED 2026-08-28: `fetch` is not global anywhere in this process
// (grep for global.fetch/globalThis.fetch in server.js came back empty).
// server.js's `import fetch from 'node-fetch'` only binds `fetch` locally
// to server.js itself -- this file needs its own import, done below.
//
// REWRITE 2026-09-25 (Phase 1, step 1 -- still shadow mode only):
//   - Sticky per-phone-number category caching REMOVED. It was reusing a
//     phone number's FIRST classification for every later message (about
//     79% of a sample review), including cases where the topic had clearly
//     changed (e.g. a leasing prospect's later maintenance question stayed
//     labeled from their first "General-Other" tag). Continuity is now the
//     model's job: it is given the same thread-history context as before
//     and told to keep the prior topic unless the new message clearly
//     introduces something else.
//   - Escalation hard-stops (legal language, health-symptom claims, ADA/
//     accommodation, vendor-caused damage/injury, fair housing) and true
//     life-safety emergencies are now real classifier outputs, not just a
//     plan-doc mention. Source: ~/aloe-pm-agent-v2/.claude/skills/
//     escalation/SKILL.md (2026-09-25 read). These always route to a human,
//     never to an agent, regardless of any per-agent enable flag below.
//   - Urgent/unhappy detection added (source: aloe-inbox-analyzer skill's
//     existing High Priority list) -- always routes to a human (Alexes)
//     IN ADDITION TO the topic's normal human, never to an agent.
//   - Category list replaced to match Randi's Sept 2026 topic list, and a
//     ROUTING table added mapping each category to an agent (with a
//     per-agent enabled/disabled switch, ALL FALSE for now) and a human.
//   - Photos: up to 2 media URLs per message are now sent to Claude with
//     the thread context, and the model is asked what each photo shows and
//     what it is likely for (e.g. "tree photo -- fulfilling Ari's tree-trim
//     request" or "yard photo -- likely HOA violation resolution proof").
//     Quo's media URLs are unauthenticated and directly fetchable
//     (confirmed 2026-09-25), so no download/re-upload step is needed --
//     the URL is passed straight to the Anthropic API as an image source.
//   - Slack shadow posts reformatted for easy review: one message per
//     text, ending with "React (thumbsup)/(thumbsdown) -- reply with the
//     correction" so Randi can correct the router without any new tooling.
//     Corrections are read back later (read-only) to propose classifier
//     changes for approval -- nothing here applies a correction
//     automatically.

import fetch from 'node-fetch';

// -- Categories -------------------------------------------------------------
// Every message is classified into exactly one of these. "Spam-Optout" and
// "Unclear" are deliberately not real topics -- they are fallback buckets.
const CATEGORIES = [
  'Leasing-Application',
  'Move-in',
  'Move-out',
  'Renewal',
  'Owner',
  'Accounting',
  'Delinquency-Collections',
  'HOA',
  'Maintenance',
  'Vendor',
  'Tenant-FAQ',
  'Spam-Optout',
  'Unclear'
];

// -- Routing table ------------------------------------------------------------
// agentEnabled is FALSE for every category right now (Phase 1, step 1).
// Flipping one to true is a one-line change for a future phase, once an
// agent's live-reply flow exists and has been reviewed -- this table does
// not by itself cause any text to be sent.
// humanBackup is a second name to notify alongside human when the primary
// person hasn't confirmed handling something within a reasonable window --
// NOT YET IMPLEMENTED (no time-based logic reads this field yet); listed
// here so the mapping is documented in one place as backups get confirmed.
const ROUTING = {
  'Leasing-Application':    { agent: 'Ivy',  agentEnabled: false, human: 'Dhyana',  humanBackup: null },
  'Move-in':                { agent: 'Mary', agentEnabled: false, human: 'Dhyana',  humanBackup: null },
  'Move-out':                { agent: 'Matt', agentEnabled: false, human: 'Persia',  humanBackup: null, note: 'Matt not yet built as of 2026-09-25' },
  'Renewal':                 { agent: 'Remy', agentEnabled: false, human: 'Alexes',  humanBackup: null },
  'Owner':                   { agent: 'Lea',  agentEnabled: false, human: 'Alexes',  humanBackup: null, note: 'Lea not yet built as of 2026-09-25' },
  'Accounting':              { agent: 'Bo',   agentEnabled: false, human: 'Randi',   humanBackup: null },
  'Delinquency-Collections': { agent: 'Rex',  agentEnabled: false, human: 'Norman',  humanBackup: null, note: 'Norman acts on behalf of Rita' },
  'HOA':                     { agent: 'Kat',  agentEnabled: false, human: 'Norman',  humanBackup: null },
  'Maintenance':             { agent: 'Ari',  agentEnabled: false, human: 'Roberto', humanBackup: null },
  'Vendor':                  { agent: 'Ari',  agentEnabled: false, human: 'Roberto', humanBackup: null },
  'Tenant-FAQ':              { agent: 'Rex',  agentEnabled: false, human: null,      humanBackup: null, note: 'Human backup not yet assigned as of 2026-09-25 -- flag to Randi' },
  'Spam-Optout':             { agent: null,   agentEnabled: false, human: null,      humanBackup: null, note: 'No action -- do not text this number again' },
  'Unclear':                 { agent: null,   agentEnabled: false, human: null,      humanBackup: null, note: 'Needs manual triage' }
};

const URGENT_HUMAN = 'Alexes';
const EMERGENCY_HUMAN = 'Roberto';
const EMERGENCY_HUMAN_BACKUP = 'Alexes';

const CLASSIFIER_SYSTEM_PROMPT = 'You are a message router for a property management company (Aloe Property Management) shared SMS inbox.\n\n' +
'Read the inbound text message, any recent thread context provided, and any photos attached, then respond with ONLY a JSON object (no markdown fencing, no other text) with these fields:\n\n' +
'{\n' +
'  "category": one of ' + JSON.stringify(CATEGORIES) + ',\n' +
'  "confidence": "High" | "Medium" | "Low",\n' +
'  "reasoning": "<one short sentence>",\n' +
'  "escalate": true | false,\n' +
'  "escalateReason": "<empty string if escalate is false>",\n' +
'  "emergency": true | false,\n' +
'  "emergencyReason": "<empty string if emergency is false>",\n' +
'  "urgent": true | false,\n' +
'  "urgentReason": "<empty string if urgent is false>",\n' +
'  "photoSummary": "<empty string if no photos; otherwise, for each photo, briefly say what it shows and what it is likely for, using the thread context -- e.g. a photo of a tree right after a tree-trim photo was requested is a maintenance photo reply, a photo of a yard/trash-cans/vehicle right after an HOA text is likely violation-resolution proof, a photo of a printed invoice or receipt is a vendor billing document, a photo of an ID or paystub is a leasing document>"\n' +
'}\n\n' +
'CATEGORIES:\n' +
'- Leasing-Application: prospective tenants -- showings, applications, ID/paystub submission, "is this still available", deposit questions\n' +
'- Move-in: a tenant who is about to move in or just moved in\n' +
'- Move-out: notice to vacate, move-out logistics, move-out inspection\n' +
'- Renewal: lease renewal questions, renewal offers or terms\n' +
'- Owner: a property owner (not a tenant) asking about their property\n' +
'- Accounting: rent balance, payment status, "did my payment go through", payment plans\n' +
'- Delinquency-Collections: late rent, past-due notices, collections conversations\n' +
'- HOA: HOA violation notices, warnings, fines, resolution follow-up\n' +
'- Maintenance: repair requests, work order status, anything broken\n' +
'- Vendor: a vendor/contractor about a job, invoice, quote, or scheduling\n' +
'- Tenant-FAQ: a current tenant asking something routine that is not maintenance/accounting/HOA (gate codes, trash day, general how-do-I questions)\n' +
'- Spam-Optout: spam, wrong numbers, "STOP"/unsubscribe confirmations\n' +
'- Unclear: does not fit clearly into any of the above\n\n' +
'CONTINUITY: If recent thread context is provided, and this new message is clearly a continuation of the same subject (a bare reply like "Yes", "Done", "Ok", or a photo with no new topic), classify it the SAME as the established subject of that thread rather than as Unclear or General. Only classify it as a different category if the new message clearly raises something new (e.g. the thread was about an HOA violation and the tenant now also mentions a leak).\n\n' +
'ESCALATE (set escalate=true) for any of these, regardless of category -- the exact word or pattern is the trigger, do not evaluate whether the underlying claim is valid:\n' +
'- Legal language: "lawyer", "attorney", "habitability", "code violation", "health department", "housing authority", "sue", "lawsuit", or "ADA"/"accommodation" in a maintenance or lease context\n' +
'- A physical health symptom attributed to a property condition (e.g. "headaches from the smell", "kids coughing because of the mold")\n' +
'- A disability or accommodation request tied to housing, a lease term, or a maintenance request\n' +
'- A vendor reporting damage they caused, or a tenant reporting injury or property damage during a vendor visit\n' +
'- A fair-housing concern in a leasing conversation (e.g. a question about the racial makeup of a neighborhood, an apparent discriminatory instruction)\n\n' +
'EMERGENCY (set emergency=true) for genuine life-safety situations: fire, gas smell, active flooding, structural collapse, an active threat to someone\'s safety. This is separate from and more urgent than escalate -- set emergency=true (and also escalate=true) for these.\n\n' +
'URGENT (set urgent=true) for signals of an unhappy or frustrated tenant/owner, or a situation needing prompt attention, even if not a hard-stop or emergency: expressed frustration or anger, an active unresolved complaint, a missed showing, a fraud/impersonation report, a time-sensitive move-in access issue, or someone who has clearly already reached out before about the same unresolved issue.\n\n' +
'Classify based on the actual content of the message and thread. Do not answer the tenant, do not draft a reply -- your only job is to label the message for a human dispatcher.';

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

const MAIN_OFFICE_NUMBER = '+16028549884';
const MAIN_OFFICE_PHONE_NUMBER_ID = 'PNRRARIpQO';

export function createShadowClassifier({ anthropic, SLACK_TOKEN, ROUTER_SHADOW_CHANNEL_ID, QUO_API_TOKEN }) {
  // Fetches up to the last 6 messages (both directions) from the last 48
  // hours on this thread via Quo's /v1/messages, so a bare reply like "Yes
  // that works" can be classified using what it's actually replying to.
  // Fails safe: any error, missing token, or non-Main-Office inbox just
  // returns null and classification proceeds message-only.
  async function fetchThreadContext(fromNumber, inboxNumber) {
    if (inboxNumber !== MAIN_OFFICE_NUMBER) return null;
    if (!QUO_API_TOKEN) return null;

    try {
      const createdAfter = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const url = 'https://api.quo.com/v1/messages?phoneNumberId=' + MAIN_OFFICE_PHONE_NUMBER_ID + '&participants=' + encodeURIComponent(fromNumber) + '&createdAfter=' + encodeURIComponent(createdAfter) + '&maxResults=20';
      const r = await fetch(url, { headers: { 'Authorization': QUO_API_TOKEN } });
      if (!r.ok) return null;
      const data = await r.json();
      const messages = (data.data || [])
        .slice()
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .slice(-6);

      if (messages.length === 0) return null;

      return messages
        .map(m => '[' + m.direction + '] ' + truncate(m.text || '(no text)', 200))
        .join('\n');
    } catch (err) {
      console.error('[router-classifier] fetchThreadContext error:', err.message);
      return null;
    }
  }

  async function classifyMessage(messageText, threadContext, mediaUrls) {
    const userText = threadContext
      ? 'Recent thread context:\n' + threadContext + '\n\nNew inbound message:\n' + (messageText || '(no text -- see attached photo(s), if any)')
      : 'Inbound message:\n' + (messageText || '(no text -- see attached photo(s), if any)');

    const contentBlocks = [];
    const imagesToSend = (mediaUrls || []).slice(0, 2);
    for (const mediaUrl of imagesToSend) {
      if (typeof mediaUrl === 'string' && mediaUrl.length > 0) {
        contentBlocks.push({ type: 'image', source: { type: 'url', url: mediaUrl } });
      }
    }
    contentBlocks.push({ type: 'text', text: userText });

    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 400,
      system: CLASSIFIER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: contentBlocks }]
    });

    let rawText = (resp.content || []).map(block => block.text || '').join('').trim();
    // Claude sometimes wraps JSON in a markdown code fence despite being told not to --
    // strip it defensively rather than relying solely on the model following instructions.
    rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      throw new Error('Could not parse classifier JSON output: ' + rawText);
    }

    if (!CATEGORIES.includes(parsed.category)) {
      throw new Error('Classifier returned unrecognized category: ' + parsed.category);
    }

    return parsed;
  }

  function decideRoute(parsed) {
    if (parsed.emergency) {
      return { kind: 'human', names: [EMERGENCY_HUMAN, EMERGENCY_HUMAN_BACKUP], label: 'EMERGENCY', reason: parsed.emergencyReason || parsed.reasoning };
    }
    if (parsed.escalate) {
      const routing = ROUTING[parsed.category] || {};
      const names = [routing.human, URGENT_HUMAN].filter((n, i, arr) => n && arr.indexOf(n) === i);
      return { kind: 'human', names: names.length ? names : [URGENT_HUMAN], label: 'ESCALATE', reason: parsed.escalateReason || parsed.reasoning };
    }
    if (parsed.category === 'Spam-Optout') {
      return { kind: 'none', names: [], label: 'SPAM/OPT-OUT', reason: parsed.reasoning };
    }
    if (parsed.urgent) {
      const routing = ROUTING[parsed.category] || {};
      const names = [routing.human, URGENT_HUMAN].filter((n, i, arr) => n && arr.indexOf(n) === i);
      return { kind: 'human', names: names.length ? names : [URGENT_HUMAN], label: 'URGENT', reason: parsed.urgentReason || parsed.reasoning };
    }
    const routing = ROUTING[parsed.category];
    if (routing && routing.agentEnabled && routing.agent) {
      return { kind: 'agent', names: [routing.agent], label: 'AGENT', reason: parsed.reasoning };
    }
    if (routing && routing.human) {
      return { kind: 'human', names: [routing.human], label: 'TOPIC', reason: parsed.reasoning };
    }
    return { kind: 'human', names: ['Unassigned -- needs review'], label: routing && routing.note ? routing.note : 'UNASSIGNED', reason: parsed.reasoning };
  }

  async function postToShadowSlack({ from, messageText, threadId, parsed, route, error }) {
    if (!SLACK_TOKEN || !ROUTER_SHADOW_CHANNEL_ID) {
      console.error('[router-classifier] Missing SLACK_TOKEN or ROUTER_SHADOW_CHANNEL_ID -- cannot post shadow log');
      return;
    }

    let text;
    if (error) {
      text = '\u26A0\uFE0F *Router shadow -- classification FAILED*\n' +
        'From: ' + (from || 'unknown') + '\n' +
        'Thread: ' + (threadId || 'unknown') + '\n' +
        'Message: "' + truncate(messageText, 300) + '"\n' +
        'Error: ' + error;
    } else {
      const routeLine = route.kind === 'agent'
        ? '*Would route to AGENT:* ' + route.names.join(', ') + ' _(disabled -- shadow only)_'
        : route.kind === 'none'
        ? '*No action* -- ' + route.label
        : '*Would tag HUMAN' + (route.label && route.label !== 'TOPIC' ? ' (' + route.label + ')' : '') + ':* ' + route.names.join(' + ');

      const flagBits = [];
      if (parsed.emergency) flagBits.push('\uD83D\uDEA8 EMERGENCY');
      if (parsed.escalate) flagBits.push('\u26A0\uFE0F ESCALATE');
      if (parsed.urgent) flagBits.push('\uD83D\uDD34 URGENT/UNHAPPY');
      const flagLine = flagBits.length ? flagBits.join('  ') + '\n' : '';

      text = '\uD83D\uDD00 *Router shadow*\n' +
        'From: ' + (from || 'unknown') + '\n' +
        'Thread: ' + (threadId || 'unknown') + '\n' +
        'Message: "' + truncate(messageText, 300) + '"\n' +
        (parsed.photoSummary ? 'Photo: ' + truncate(parsed.photoSummary, 300) + '\n' : '') +
        'Category: *' + parsed.category + '* (confidence: ' + parsed.confidence + ')\n' +
        flagLine +
        routeLine + '\n' +
        'Reasoning: ' + parsed.reasoning + '\n\n' +
        '_React :thumbsup:/:thumbsdown: -- reply in thread with the correction if wrong._';
    }

    const r = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: ROUTER_SHADOW_CHANNEL_ID, text })
    });

    const result = await r.json();
    if (!result.ok) {
      console.error('[router-classifier] Slack post failed:', result.error);
    }
  }

  return async function shadowClassify({ from, messageText, threadId, inboxNumber, mediaUrls }) {
    try {
      const threadContext = await fetchThreadContext(from, inboxNumber);
      const parsed = await classifyMessage(messageText, threadContext, mediaUrls);
      const route = decideRoute(parsed);
      await postToShadowSlack({ from, messageText, threadId, parsed, route });
    } catch (err) {
      console.error('[router-classifier] shadowClassify error:', err.message);
      await postToShadowSlack({ from, messageText, threadId, error: err.message }).catch(() => {});
    }
  };
}

export { CATEGORIES, ROUTING };
