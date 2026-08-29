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

import fetch from 'node-fetch';

const CATEGORIES = [
  'Maintenance',
  'HOA',
  'Renewal',
  'Move-in',
  'Move-out',
  'Accounting-Payment',
  'Owner',
  'Vendor',
  'General-Other'
];

const CLASSIFIER_SYSTEM_PROMPT = `You are a message router for a property management company's shared SMS inbox. Read the inbound text message (and any recent thread context provided) and classify it into exactly one of these categories:

- Maintenance: repair requests, work order status questions, anything broken/not working at the property
- HOA: HOA violation notices, warnings, fines, HOA registration questions, follow-up on whether a violation was resolved
- Renewal: lease renewal questions, renewal offers, renewal terms
- Move-in: questions from a tenant who is about to move in or just moved in
- Move-out: notice to vacate, move-out logistics, move-out inspection questions
- Accounting-Payment: rent balance, payment status, payment plans, late fees, eviction-hold requests, "did my payment go through"
- Owner: messages from a property owner (not a tenant) about their property
- Vendor: messages from a vendor/contractor about a job, invoice, or scheduling
- General-Other: anything that doesn't clearly fit above, or is ambiguous

Respond with ONLY a JSON object, no other text, no markdown formatting:
{"category": "<one of the categories above>", "confidence": "High" | "Medium" | "Low", "reasoning": "<one short sentence>"}

Classify based only on the current message's actual content -- thread-stickiness (keeping a whole thread with the agent who already owns it) is handled by the caller, not by you.`;

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

export function createShadowClassifier({ anthropic, SLACK_TOKEN, ROUTER_SHADOW_CHANNEL_ID }) {
  async function classifyMessage(messageText, threadContext) {
    const userContent = threadContext
      ? `Recent thread context:\n${threadContext}\n\nNew inbound message:\n${messageText}`
      : `Inbound message:\n${messageText}`;

    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 300,
      system: CLASSIFIER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }]
    });

    let rawText = (resp.content || []).map(block => block.text || '').join('').trim();
    // Claude sometimes wraps JSON in a markdown code fence despite being told not to --
    // strip it defensively rather than relying solely on the model following instructions.
    rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      throw new Error(`Could not parse classifier JSON output: ${rawText}`);
    }

    if (!CATEGORIES.includes(parsed.category)) {
      throw new Error(`Classifier returned unrecognized category: ${parsed.category}`);
    }

    return parsed;
  }

  async function postToShadowSlack({ from, messageText, threadId, category, confidence, reasoning, error }) {
    if (!SLACK_TOKEN || !ROUTER_SHADOW_CHANNEL_ID) {
      console.error('[router-classifier] Missing SLACK_TOKEN or ROUTER_SHADOW_CHANNEL_ID -- cannot post shadow log');
      return;
    }

    const text = error
      ? `\u26A0\uFE0F *Router shadow -- classification FAILED*\nFrom: ${from || 'unknown'}\nThread: ${threadId || 'unknown'}\nMessage: "${truncate(messageText, 300)}"\nError: ${error}`
      : `\uD83D\uDD00 *Router shadow* -- would route to: *${category}* (confidence: ${confidence})\nFrom: ${from || 'unknown'}\nThread: ${threadId || 'unknown'}\nMessage: "${truncate(messageText, 300)}"\nReasoning: ${reasoning}`;

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

  return async function shadowClassify({ from, messageText, threadId, threadContext }) {
    try {
      const { category, confidence, reasoning } = await classifyMessage(messageText, threadContext);
      await postToShadowSlack({ from, messageText, threadId, category, confidence, reasoning });
    } catch (err) {
      console.error('[router-classifier] shadowClassify error:', err.message);
      await postToShadowSlack({ from, messageText, threadId, error: err.message }).catch(() => {});
    }
  };
}

export { CATEGORIES };
