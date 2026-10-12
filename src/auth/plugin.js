import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from '../store.js';
import { ROLES, CAPS, can, capsFor, roleLevel } from './accounts.js';
import { RateLimiter, sha256, encrypt, decrypt, verifyPassword, passwordProblem, safeReturnTo, safeProto } from './security.js';
import { ROOT } from '../config.js';
import { LOADTEST_TOKEN } from '../loadtest.js';

const SESSION_COOKIE = 'ci_session';
const OIDC_COOKIE = 'ci_oidc';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// A Host header we are willing to build absolute URLs from: a DNS name, IPv4 or [IPv6], optional port.
const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;
/** Failed sign-ins allowed per address + username, and per address in total (an office behind one NAT). */
export const LOGIN_LIMITS = { perUser: 10, perIp: 50 };

/**
 * Authentication & authorisation.
 *
 * Every /api request is resolved to one of:
 *   session  – browser login (cookie + CSRF token on writes)
 *   basic    – HTTP Basic with a local username/password
 *   apikey   – the shared API key (acts with the "user" role)
 *   anon     – nothing supplied
 *
 * Routes declare the capability they need with `config: { cap: '...' }`.
 */
export function registerAuth(app, { accounts, oidc, config, broadcast, views }) {
  const loginLimiter = new RateLimiter({ max: LOGIN_LIMITS.perUser, limits: { 'ip:': LOGIN_LIMITS.perIp }, windowMs: 15 * 60_000 });
  const loginKeys = (ip, username) => ['login:' + ip + ':' + String(username || '').trim().toLowerCase(), 'ip:' + ip];

  // An empty body sent as application/json (e.g. a bodyless DELETE from fetch with a JSON header)
  // means "no fields", not a 400 that would come before the sign-in / role check.
  const jsonParser = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '' || /^\s*$/.test(body)) return done(null, {});
    return jsonParser(req, body, done);
  });
  const basicCache = new Map(); // sha256(header) -> { userId, exp }

  const secureCookie = (req) => (config.cookieSecure === 'auto' ? safeProto(req) === 'https' : config.cookieSecure === 'true');
  const setSessionCookie = (req, reply, token) => reply.setCookie(SESSION_COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookie(req), maxAge: Math.floor(accounts.ttlMs / 1000),
  });
  const baseUrl = (req) => {
    const pub = accounts.sso().publicUrl;
    if (pub) return pub;
    const host = String(req.headers.host || '');
    if (!HOST_RE.test(host)) throw new HttpError(400, 'Could not work out this server\'s address from the request. Set the Public URL in Admin → Single sign-on.');
    return `${safeProto(req)}://${host}`;
  };
  const redirectUri = (req) => `${baseUrl(req)}/auth/oidc/callback`;

  function userAuth(u, kind, extra = {}) {
    return { kind, user: u, userId: u.id, role: u.role, name: u.name || u.username, ...extra };
  }

  async function resolve(req) {
    // 1. Browser session
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      const s = accounts.getSession(token);
      if (s) return userAuth(s, 'session', { csrf: s.csrf, sid: s.sid, method: s.method });
    }
    const header = req.headers.authorization || '';
    // 2. HTTP Basic (local accounts)
    if (/^basic /i.test(header)) {
      const ip = req.ip;
      const raw = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
      const i = raw.indexOf(':');
      // Cache on the decoded credentials, not the header text, so "basic" vs "Basic", spacing
      // or padding variations can't force a fresh (slow) password check every time.
      const cacheKey = sha256(i > 0 ? raw.slice(0, i).toLowerCase() + '\0' + raw.slice(i + 1) : raw);
      const hit = basicCache.get(cacheKey);
      // "Password sign-in: admins only" applies to HTTP Basic too (it's a password sign-in).
      const passwordAllowed = (u) => accounts.passwordLogin !== 'admins' || u.role === 'admin';
      if (hit && hit.exp > Date.now()) {
        const u = accounts.get(hit.userId);
        if (u && !u.disabled && passwordAllowed(u)) return userAuth(u, 'basic', { pwHash: u.password_hash });
      }
      // Checks in progress count against the limit, so parallel guesses can't all get in first.
      const keys = loginKeys(ip, i > 0 ? raw.slice(0, i) : '');
      const g = await loginLimiter.guard(keys, () => (i > 0 ? accounts.verifyLogin(raw.slice(0, i), raw.slice(i + 1)) : null));
      if (g.blocked) throw new HttpError(429, 'Too many failed sign-in attempts. Try again later.');
      const u = g.result;
      if (!u) throw Object.assign(new HttpError(401, 'Invalid username or password'), { basic: true });
      loginLimiter.clear(keys[0]);
      if (!passwordAllowed(u)) throw new HttpError(403, 'Password sign-in is limited to admins on this server. Use single sign-on.');
      if (basicCache.size > 1000) basicCache.clear();
      basicCache.set(cacheKey, { userId: u.id, exp: Date.now() + 5 * 60_000 });
      return userAuth(u, 'basic', { pwHash: u.password_hash });
    }
    // The load test's own simulated check-ins (app.inject only: a random per-process token).
    const lt = req.headers['x-loadtest-token'];
    if (lt && typeof lt === 'string' && lt.length === LOADTEST_TOKEN.length && req.ip === '127.0.0.1'
      && crypto.timingSafeEqual(Buffer.from(lt), Buffer.from(LOADTEST_TOKEN))) {
      return { kind: 'apikey', role: 'user', name: 'Load test', userId: null, loadTest: true };
    }
    // 3. API key
    const key = req.headers['x-api-key']
      || (/^bearer /i.test(header) ? header.slice(7).trim() : '')
      || req.query?.api_key || req.query?.apikey;
    if (key) {
      if (!accounts.checkApiKey(key)) throw new HttpError(401, 'Invalid API key');
      return { kind: 'apikey', role: 'user', name: 'API key', userId: null, apiKey: key };
    }
    return { kind: 'anon', role: null, name: 'anonymous', userId: null };
  }

  // Resolve identity for every API / auth request.
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url;
    if (!url.startsWith('/api/') && !url.startsWith('/auth/') && url !== '/' && !url.startsWith('/?') && url !== '/issues' && !url.startsWith('/issues?') && url !== '/loadtest' && !url.startsWith('/loadtest?')) return;
    try {
      req.auth = await resolve(req);
    } catch (e) {
      if (e.basic) reply.header('WWW-Authenticate', 'Basic realm="check-in", charset="UTF-8"');
      return reply.code(e.statusCode || 401).send({ ok: false, error: e.message });
    }
  });

  // Enforce capability + CSRF. Runs before the body is parsed, so callers without the right to
  // use a route get 401/403 rather than a complaint about what they sent.
  app.addHook('preParsing', async (req, reply) => {
    const cap = req.routeOptions?.config?.cap;
    if (!cap) return;
    const a = req.auth || { kind: 'anon', role: null };
    if (a.kind === 'session' && !SAFE_METHODS.has(req.method) && req.headers['x-csrf-token'] !== a.csrf) {
      return reply.code(403).send({ ok: false, error: 'Missing or invalid CSRF token. Reload the page and try again.' });
    }
    if (cap === 'public') return;
    // Check-ins are open when no API key has been configured (backwards compatible).
    // Check-ins need the API key (or a signed-in user) unless an admin turned that requirement off.
    if (cap === 'checkin' && a.kind === 'anon' && !accounts.apiKeyRequired) return;
    if (a.kind === 'anon') return reply.code(401).send({ ok: false, error: 'Sign in or supply an API key' });
    if (!can(a.role, cap)) {
      return reply.code(403).send({ ok: false, error: `Your role (${ROLES[a.role]?.label || a.role}) is not allowed to do this` });
    }
  });

  // ---------------------------------------------------------------- pages
  app.get('/', (req, reply) => {
    if (accounts.count() === 0 || req.auth?.kind !== 'session') return reply.redirect('/login');
    return reply.sendFile('index.html');
  });
  app.get('/loadtest', (req, reply) => {
    if (accounts.count() === 0 || req.auth?.kind !== 'session') return reply.redirect('/login?returnTo=' + encodeURIComponent(req.url));
    if (!can(req.auth.role, 'loadTest')) return reply.redirect('/');
    return reply.sendFile('loadtest.html');
  });
  app.get('/issues', (req, reply) => {
    if (accounts.count() === 0 || req.auth?.kind !== 'session') return reply.redirect('/login?returnTo=' + encodeURIComponent(req.url));
    return reply.sendFile('issues.html');
  });
  app.get('/login', (req, reply) => {
    const t = req.cookies?.[SESSION_COOKIE];
    if (t && accounts.getSession(t) && !req.query.error) return reply.redirect(safeReturnTo(req.query.returnTo));
    return reply.sendFile('login.html', path.join(ROOT, 'public'));
  });

  // ---------------------------------------------------------------- auth API
  const meBody = (a) => ({
    ok: true,
    user: a.user ? accounts.publicUser(a.user) : { username: a.name, name: a.name, role: a.role },
    role: a.role,
    roleLabel: ROLES[a.role]?.label,
    caps: capsFor(a.role),
    kind: a.kind,
    method: a.method,
    csrf: a.csrf || null,
  });

  app.get('/api/auth/status', { config: { cap: 'public' } }, async (req) => {
    const sso = accounts.sso();
    return {
      setupRequired: accounts.count() === 0,
      passwordLogin: accounts.passwordLogin,
      sso: { enabled: accounts.ssoReady(), label: sso.buttonLabel || 'Sign in with Microsoft' },
      signedIn: req.auth?.kind === 'session',
    };
  });

  // Sign-in and setup only take JSON: a form on another site can't send that, so it can't sign a
  // visitor into someone else's account or claim a fresh install (login CSRF).
  const requireJson = (req) => {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') throw new HttpError(415, 'Send JSON (Content-Type: application/json)');
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, 'Body must be a JSON object');
  };

  // One setup at a time: password hashing is slow, so without this, parallel requests could all
  // pass the "no users yet" check and each create an admin.
  let setupBusy = false;
  app.post('/api/auth/setup', { config: { cap: 'public' } }, async (req, reply) => {
    requireJson(req);
    if (accounts.count() > 0) throw new HttpError(409, 'Setup has already been completed');
    if (setupBusy) throw new HttpError(409, 'Setup is already in progress');
    const { username, password, name } = req.body;
    if (!password) throw new HttpError(400, 'Password is required');
    setupBusy = true;
    let u;
    try {
      if (accounts.count() > 0) throw new HttpError(409, 'Setup has already been completed');
      u = await accounts.create({ username, password, name, role: 'admin' });
    } finally {
      setupBusy = false;
    }
    const { token } = accounts.createSession(u.id, 'password');
    setSessionCookie(req, reply, token);
    return { ok: true };
  });

  app.post('/api/auth/login', { config: { cap: 'public' } }, async (req, reply) => {
    requireJson(req);
    const { username, password } = req.body;
    const [key, ipKey] = loginKeys(req.ip, username);
    // Checks in progress count against the limit, so parallel guesses can't all get in first.
    const g = await loginLimiter.guard([key, ipKey], () => accounts.verifyLogin(username, password));
    if (g.blocked) throw new HttpError(429, 'Too many failed sign-in attempts. Wait a few minutes and try again.');
    const u = g.result;
    if (!u) throw new HttpError(401, 'Incorrect username or password');
    if (accounts.passwordLogin === 'admins' && u.role !== 'admin') {
      throw new HttpError(403, 'Password sign-in is turned off. Use single sign-on.');
    }
    loginLimiter.clear(key);
    const { token } = accounts.createSession(u.id, 'password');
    setSessionCookie(req, reply, token);
    return { ok: true };
  });

  app.post('/api/auth/logout', { config: { cap: 'public' } }, async (req, reply) => {
    accounts.destroySession(req.cookies?.[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', { config: { cap: 'view' } }, async (req) => meBody(req.auth));

  app.post('/api/auth/password', { config: { cap: 'view' } }, async (req) => {
    const a = req.auth;
    if (!a.user) throw new HttpError(400, 'Only signed-in users can change their password');
    const { current, next } = req.body || {};
    const problem = passwordProblem(next);
    if (problem) throw new HttpError(400, next ? problem : 'Enter a new password');
    if (a.user.password_hash && !(await verifyPassword(current || '', a.user.password_hash))) {
      throw new HttpError(400, 'Current password is incorrect');
    }
    await accounts.update(a.userId, { password: next, keepSession: a.sid }, a.userId);
    basicCache.clear();
    return { ok: true };
  });

  // ---------------------------------------------------------------- Entra OIDC
  app.get('/auth/oidc/login', async (req, reply) => {
    if (!accounts.ssoReady()) return reply.redirect('/login?error=' + encodeURIComponent('Single sign-on is not configured'));
    try {
      const { url, tx } = await oidc.authorizationUrl(redirectUri(req));
      const returnTo = safeReturnTo(req.query.returnTo);
      reply.setCookie(OIDC_COOKIE, encrypt(accounts.secret, JSON.stringify({ ...tx, returnTo, exp: Date.now() + 10 * 60_000 })), {
        path: '/auth/oidc', httpOnly: true, sameSite: 'lax', secure: secureCookie(req), maxAge: 600,
      });
      return reply.redirect(url);
    } catch (e) {
      req.log.error(e);
      return reply.redirect('/login?error=' + encodeURIComponent('Could not reach the identity provider: ' + e.message));
    }
  });

  app.get('/auth/oidc/callback', async (req, reply) => {
    const fail = (msg) => {
      reply.clearCookie(OIDC_COOKIE, { path: '/auth/oidc' });
      return reply.redirect('/login?error=' + encodeURIComponent(msg));
    };
    const raw = req.cookies?.[OIDC_COOKIE];
    const tx = raw ? JSON.parse(decrypt(accounts.secret, raw) || 'null') : null;
    if (!tx || tx.exp < Date.now()) return fail('Your sign-in session expired. Please try again.');
    if (req.query.error) return fail(String(req.query.error_description || req.query.error).split('\n')[0].slice(0, 300));
    let claims;
    try {
      const qs = req.url.slice(req.url.indexOf('?'));
      claims = await oidc.callback(new URL(redirectUri(req) + qs), tx);
    } catch (e) {
      req.log.error(e);
      return fail('Single sign-on failed: ' + (e.error_description || e.message));
    }
    let u;
    try { u = accounts.ssoLogin(claims); } catch (e) { return fail(e.message); }
    const { token } = accounts.createSession(u.id, 'sso');
    reply.clearCookie(OIDC_COOKIE, { path: '/auth/oidc' });
    setSessionCookie(req, reply, token);
    return reply.redirect(safeReturnTo(tx.returnTo));
  });

  // ---------------------------------------------------------------- check-in pause
  // Public so devices and monitors can ask "are you accepting check-ins?" without credentials.
  const ingestStatus = (a) => {
    const s = accounts.ingest();
    const body = { accepting: !s.paused, paused: s.paused, since: s.since };
    if (a && a.kind !== 'anon') body.by = s.by;
    return body;
  };
  app.get('/api/status', { config: { cap: 'public' } }, async (req) => ingestStatus(req.auth));

  app.put('/api/status', { config: { cap: 'pause' } }, async (req) => {
    const { paused } = req.body || {};
    if (typeof paused !== 'boolean') throw new HttpError(400, 'Body must be { "paused": true } or { "paused": false }');
    accounts.setIngestPaused(paused, req.auth.user?.username || req.auth.name);
    const s = ingestStatus(req.auth);
    broadcast('ingest', s);
    return s;
  });

  // ---------------------------------------------------------------- settings (shared)
  app.get('/api/settings', { config: { cap: 'view' } }, async () => ({
    staleMinutes: accounts.staleMinutes,
    passwordLogin: accounts.passwordLogin,
  }));

  app.put('/api/settings', { config: { cap: 'view' } }, async (req) => {
    const body = req.body || {};
    const role = req.auth.role;
    if ('staleMinutes' in body) {
      if (!can(role, 'threshold')) throw new HttpError(403, 'Changing the fresh threshold requires the Power user role');
      const m = Number(body.staleMinutes);
      if (!Number.isFinite(m) || m < 1 || m > 100000) throw new HttpError(400, 'Threshold must be between 1 and 100000 minutes');
      accounts.setSetting('staleMinutes', Math.round(m));
    }
    if ('passwordLogin' in body) {
      if (!can(role, 'sso')) throw new HttpError(403, 'Only admins can change sign-in options');
      if (![true, 'admins'].includes(body.passwordLogin)) throw new HttpError(400, 'passwordLogin must be true or "admins"');
      if (body.passwordLogin === 'admins' && accounts.passwordLogin !== 'admins' && !accounts.ssoReady()) {
        throw new HttpError(400, 'Set up and turn on single sign-on before limiting password sign-in to admins, or nobody else could sign in.');
      }
      accounts.setSetting('passwordLogin', body.passwordLogin);
    }
    const s = { staleMinutes: accounts.staleMinutes, passwordLogin: accounts.passwordLogin };
    broadcast('settings', s);
    return s;
  });

  // ---------------------------------------------------------------- admin: users
  app.get('/api/admin/users', { config: { cap: 'users' } }, async () => ({ users: accounts.list(), roles: ROLES, ssoReady: accounts.ssoReady() }));
  app.post('/api/admin/users', { config: { cap: 'users' } }, async (req, reply) => {
    const u = await accounts.create(req.body || {});
    return reply.code(201).send({ ok: true, user: u });
  });
  app.patch('/api/admin/users/:id', { config: { cap: 'users' } }, async (req) => {
    const id = Number(req.params.id);
    const { keepSession, ...patch } = req.body || {};
    // Changing your own password here keeps you signed in on this browser (other sessions end).
    if (id === req.auth.userId && req.auth.sid) patch.keepSession = req.auth.sid;
    const u = await accounts.update(id, patch, req.auth.userId);
    basicCache.clear();
    return { ok: true, user: u };
  });
  app.delete('/api/admin/users/:id', { config: { cap: 'users' } }, async (req) => {
    accounts.remove(Number(req.params.id), req.auth.userId);
    views?.removeOwner(Number(req.params.id));
    basicCache.clear();
    return { ok: true };
  });

  // ---------------------------------------------------------------- admin: SSO
  const ssoBody = (req) => {
    let uri = '';
    try { uri = redirectUri(req); } catch { /* shown as empty: set the Public URL */ }
    return { ...accounts.publicSso(), redirectUri: uri, ready: accounts.ssoReady() };
  };
  app.get('/api/admin/sso', { config: { cap: 'sso' } }, async (req) => ssoBody(req));
  app.put('/api/admin/sso', { config: { cap: 'sso' } }, async (req) => {
    const body = req.body || {};
    if (body.tenantId && !GUID_RE.test(String(body.tenantId).trim()) && !config.oidcIssuerOverride) {
      throw new HttpError(400, 'Tenant ID must be the Directory (tenant) ID GUID from the Entra app registration');
    }
    if (body.clientId && !GUID_RE.test(String(body.clientId).trim()) && !config.oidcIssuerOverride) {
      throw new HttpError(400, 'Client ID must be the Application (client) ID GUID');
    }
    accounts.updateSso(body);
    oidc.cache = null;
    return ssoBody(req);
  });
  app.post('/api/admin/sso/test', { config: { cap: 'sso' } }, async () => {
    const s = accounts.sso();
    if (!s.tenantId || !s.clientId) throw new HttpError(400, 'Save a tenant ID and client ID first');
    try {
      return { ok: true, ...(await oidc.test()) };
    } catch (e) {
      throw new HttpError(400, 'Discovery failed: ' + e.message);
    }
  });

  // ---------------------------------------------------------------- admin: API key
  // Power users and admins can see and regenerate the key; only admins can supply their own
  // key or stop requiring one.
  app.get('/api/admin/apikey', { config: { cap: 'apiKey' } }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return { ...accounts.apiKeyInfo(), key: accounts.revealApiKey() };
  });
  app.post('/api/admin/apikey', { config: { cap: 'apiKey' } }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const { action, key, required } = req.body || {};
    const by = req.auth.user?.username || req.auth.name;
    const adminOnly = () => {
      if (!can(req.auth.role, 'apiKeyPolicy')) throw new HttpError(403, 'Only admins can do this');
    };
    if (action === 'generate') { const k = accounts.generateApiKey(by); return { ...accounts.apiKeyInfo(), key: k }; }
    if (action === 'set') { adminOnly(); accounts.setApiKey(String(key || ''), by); return { ...accounts.apiKeyInfo(), key: accounts.revealApiKey() }; }
    if (action === 'require') { adminOnly(); accounts.setApiKeyRequired(required !== false); return { ...accounts.apiKeyInfo(), key: accounts.revealApiKey() }; }
    throw new HttpError(400, 'action must be generate, set or require');
  });

  return { CAPS, roleLevel };
}
