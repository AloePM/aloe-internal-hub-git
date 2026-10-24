// auth-gate.js - Phase 1 sign-in for the Aloe Internal Hub.
// Web pages require sign-in. API routes are only LOGGED unless enforcement is switched on (see enforced()).
// Needs two env vars: HUB_LOGIN_PASSWORD and HUB_SESSION_SECRET. If either is missing the gate stays OFF.
import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';

const COOKIE = 'aloe_hub_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAILS = 20;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_LANDING = '/agents';

// Always open, no sign-in needed.
const EXEMPT_EXACT = new Set([
  '/login', '/logout', '/logo.png', '/favicon.ico',
  '/api/agents/heartbeat', '/api/webhook/rv-wo-created',
  '/api/vendor-apply', '/resources/vendors',
]);
const EXEMPT_PREFIX = ['/webhook/'];

const fails = [];
const auditSeen = new Map();

const enabled = () =>
  !!(process.env.HUB_LOGIN_PASSWORD && process.env.HUB_SESSION_SECRET && process.env.HUB_SESSION_SECRET.length >= 16);

const sign = (exp) =>
  createHmac('sha256', process.env.HUB_SESSION_SECRET).update('v1.' + exp).digest('hex');

function same(a, b) {
  const k = process.env.HUB_SESSION_SECRET || 'k';
  const x = createHmac('sha256', k).update(String(a)).digest();
  const y = createHmac('sha256', k).update(String(b)).digest();
  return timingSafeEqual(x, y);
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; }
    }
  }
  return '';
}

function validSession(req) {
  const [exp, sig] = getCookie(req, COOKIE).split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const want = sign(exp);
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validHubToken(req) {
  const s = process.env.HUB_INTERNAL_SECRET;
  if (!s) return false;
  const t = req.headers['x-hub-token'] || req.headers['x-agent-key'];
  if (t && same(t, s)) return true;
  // Temporary: property-lookup also accepts ?token= until its callers send a header.
  return req.path.toLowerCase() === '/api/rentvine/property-lookup' && !!req.query.token && same(req.query.token, s);
}

// Still only logged, even when enforcing, until their callers are fixed.
const ENFORCE_EXEMPT = new Set(['/api/scanner/slack/actions', '/api/rentvine/vendor-by-phone']);

// HUB_API_ENFORCE=all blocks every unauthenticated API call.
// HUB_API_ENFORCE_PREFIXES="/api/rentvine,/api/zinspector" blocks just those areas.
function enforced(p) {
  const lp = p.toLowerCase();
  if (ENFORCE_EXEMPT.has(lp)) return false;
  if ((process.env.HUB_API_ENFORCE || '').toLowerCase() === 'all') return true;
  return (process.env.HUB_API_ENFORCE_PREFIXES || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
    .some((x) => lp === x || lp.startsWith(x + '/'));
}

function locked() {
  const cut = Date.now() - FAIL_WINDOW_MS;
  while (fails.length && fails[0] < cut) fails.shift();
  return fails.length >= MAX_FAILS;
}

function safeNext(v) {
  v = String(v || '');
  if (!v.startsWith('/') || v.startsWith('//') || /[\\\r\n]/.test(v)) return DEFAULT_LANDING;
  if (v === '/' || v.startsWith('/login') || v.startsWith('/logout')) return DEFAULT_LANDING;
  return v;
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const who = (req) =>
  `ip=${String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').slice(0, 100)} ua=${String(req.headers['user-agent'] || '').slice(0, 60)}`;

function audit(req, label = 'would-block') {
  const key = `${label} ${req.method} ${req.path} ${req.headers['user-agent'] || ''}`;
  const now = Date.now();
  if (now - (auditSeen.get(key) || 0) < 10 * 60 * 1000) return;
  if (auditSeen.size > 2000) auditSeen.clear();
  auditSeen.set(key, now);
  const cred = req.headers['x-agent-key'] ? ' agentkey=yes' : '';
  console.log(`[AUTH-AUDIT] ${label} ${req.method} ${req.path}${cred} ${who(req)}`);
}

function loginPage(error, next) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Aloe Hub - Sign in</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#0A5468}
.card{background:#fff;border:1px solid #E2E8F0;border-radius:14px;padding:32px 28px;width:100%;max-width:360px;margin:16px;box-shadow:0 4px 18px rgba(10,84,104,.07)}
img{display:block;max-width:180px;margin:0 auto 20px}h1{font-size:18px;margin:0 0 6px;text-align:center}p{margin:0 0 18px;text-align:center;font-size:13px;color:#5B7C86}
label{font-size:12px;font-weight:600;display:block;margin-bottom:6px}input[type=password]{width:100%;padding:11px 12px;border:1px solid #B4C3C3;border-radius:8px;font-size:15px}
input[type=password]:focus{outline:2px solid #3CC3E1;border-color:#3CC3E1}button{width:100%;margin-top:14px;padding:11px;border:0;border-radius:8px;background:#3CC3E1;color:#04323F;font-size:15px;font-weight:700;cursor:pointer}
button:hover{background:#2A8FA6;color:#fff}.err{background:#FEF2F2;color:#B91C1C;border:1px solid #FECACA;border-radius:8px;padding:9px 11px;font-size:13px;margin-bottom:14px}
</style></head><body><form class="card" method="post" action="/login">
<img src="/logo.png" alt="Aloe Property Management">
<h1>Team sign in</h1><p>Enter the team password to continue.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<label for="pw">Password</label>
<input id="pw" type="password" name="password" autocomplete="current-password" autofocus required>
<input type="hidden" name="next" value="${esc(next)}">
<button type="submit">Sign in</button>
</form></body></html>`;
}

export function installAuthGate(app) {
  console.log(`[AUTH] gate is ${enabled() ? 'ON' : 'OFF (set HUB_LOGIN_PASSWORD and HUB_SESSION_SECRET to turn on)'}`);

  app.get('/login', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const next = safeNext(req.query.next);
    if (!enabled() || validSession(req)) return res.redirect(302, next);
    res.status(200).send(loginPage('', next));
  });

  app.post('/login', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const next = safeNext(req.body && req.body.next);
    if (!enabled()) return res.redirect(302, next);
    if (locked()) {
      console.log(`[AUTH] login refused (locked) ${who(req)}`);
      return res.status(429).send(loginPage('Too many wrong attempts. Please wait 10 minutes and try again.', next));
    }
    const ok = same((req.body && req.body.password) || '', process.env.HUB_LOGIN_PASSWORD);
    if (!ok) {
      fails.push(Date.now());
      console.log(`[AUTH] login failed ${who(req)}`);
      await new Promise((r) => setTimeout(r, 800));
      return res.status(401).send(loginPage('That password was not right.', next));
    }
    const exp = Date.now() + SESSION_MS;
    res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; Max-Age=${SESSION_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`);
    console.log(`[AUTH] login ok ${who(req)}`);
    res.redirect(302, next);
  });

  app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, '/login');
  });

  app.use((req, res, next) => {
    if (!enabled()) return next();
    const p = req.path;
    if (EXEMPT_EXACT.has(p) || EXEMPT_PREFIX.some((x) => p.startsWith(x))) return next();
    if (validSession(req)) return next();
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    const apiLike = p.toLowerCase().startsWith('/api/') || !isRead;
    if (!apiLike) {
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl));
    }
    if (validHubToken(req)) return next();
    if (req.method !== 'OPTIONS' && enforced(p)) {
      audit(req, 'BLOCKED');
      if (isRead && String(req.headers.accept || '').includes('text/html')) {
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl));
      }
      return res.status(401).json({ error: 'Unauthorized' });
    }
    audit(req); // not enforced: log only
    next();
  });
}

// ---- Slack request signature check (used by the scanner's Slack buttons) ----
// Off until SLACK_SIGNING_SECRET is set. SLACK_SIG_LOG_ONLY=1 logs bad signatures without blocking.
export function slackRawBody(req, res, buf) {
  req.rawBody = buf;
}

export function slackSigCheck(req, res, next) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) {
    console.log('[SLACK-SIG] SLACK_SIGNING_SECRET not set - request NOT verified');
    return next();
  }
  const ts = String(req.headers['x-slack-request-timestamp'] || '');
  const sig = String(req.headers['x-slack-signature'] || '');
  let ok = false;
  if (/^\d+$/.test(ts) && Math.abs(Date.now() / 1000 - Number(ts)) < 300 && sig.startsWith('v0=') && req.rawBody) {
    const want = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:`).update(req.rawBody).digest('hex');
    const a = Buffer.from(sig);
    const b = Buffer.from(want);
    ok = a.length === b.length && timingSafeEqual(a, b);
  }
  if (ok) {
    console.log('[SLACK-SIG] valid');
    return next();
  }
  const logOnly = process.env.SLACK_SIG_LOG_ONLY === '1';
  console.log(`[SLACK-SIG] INVALID signature ${who(req)}${logOnly ? ' (log-only: allowed)' : ' (blocked)'}`);
  if (logOnly) return next();
  return res.status(401).send('invalid signature');
}
