import path from 'node:path';
import { HttpError } from '../store.js';
import { ROLES, CAPS, can, capsFor, roleLevel } from './accounts.js';
import { RateLimiter, sha256, encrypt, decrypt, verifyPassword } from './security.js';
import { ROOT } from '../config.js';

const SESSION_COOKIE = 'ci_session';
const OIDC_COOKIE = 'ci_oidc';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
export function registerAuth(app, { accounts, oidc, config, broadcast }) {
  const loginLimiter = new RateLimiter({ max: 10, windowMs: 15 * 60_000 });
  const basicCache = new Map(); // sha256(header) -> { userId, exp }

  const secureCookie = (req) => (config.cookieSecure === 'auto' ? req.protocol === 'https' : config.cookieSecure === 'true');
  const setSessionCookie = (req, reply, token) => reply.setCookie(SESSION_COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookie(req), maxAge: Math.floor(accounts.ttlMs / 1000),
  });
  const baseUrl = (req) => accounts.sso().publicUrl || `${req.protocol}://${req.headers.host}`;
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
      const cacheKey = sha256(header);
      const hit = basicCache.get(cacheKey);
      if (hit && hit.exp > Date.now()) {
        const u = accounts.get(hit.userId);
        if (u && !u.disabled) return userAuth(u, 'basic');
      }
      if (loginLimiter.blocked('ip:' + ip)) throw new HttpError(429, 'Too many failed sign-in attempts. Try again later.');
      const raw = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
      const i = raw.indexOf(':');
      const u = i > 0 ? await accounts.verifyLogin(raw.slice(0, i), raw.slice(i + 1)) : null;
      if (!u) { loginLimiter.fail('ip:' + ip); throw Object.assign(new HttpError(401, 'Invalid username or password'), { basic: true }); }
      if (basicCache.size > 1000) basicCache.clear();
      basicCache.set(cacheKey, { userId: u.id, exp: Date.now() + 5 * 60_000 });
      return userAuth(u, 'basic');
    }
    // 3. API key
    const key = req.headers['x-api-key']
      || (/^bearer /i.test(header) ? header.slice(7).trim() : '')
      || req.query?.api_key || req.query?.apikey;
    if (key) {
      if (!accounts.checkApiKey(key)) throw new HttpError(401, 'Invalid API key');
      return { kind: 'apikey', role: 'user', name: 'API key', userId: null };
    }
    return { kind: 'anon', role: null, name: 'anonymous', userId: null };
  }

  // Resolve identity for every API / auth request.
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url;
    if (!url.startsWith('/api/') && !url.startsWith('/auth/') && url !== '/' && !url.startsWith('/?')) return;
    try {
      req.auth = await resolve(req);
    } catch (e) {
      if (e.basic) reply.header('WWW-Authenticate', 'Basic realm="check-in", charset="UTF-8"');
      return reply.code(e.statusCode || 401).send({ ok: false, error: e.message });
    }
  });

  // Enforce capability + CSRF.
  app.addHook('preHandler', async (req, reply) => {
    const cap = req.routeOptions?.config?.cap;
    if (!cap) return;
    const a = req.auth || { kind: 'anon', role: null };
    if (a.kind === 'session' && !SAFE_METHODS.has(req.method) && req.headers['x-csrf-token'] !== a.csrf) {
      return reply.code(403).send({ ok: false, error: 'Missing or invalid CSRF token. Reload the page and try again.' });
    }
    if (cap === 'public') return;
    // Check-ins are open when no API key has been configured (backwards compatible).
    if (cap === 'checkin' && a.kind === 'anon' && !accounts.apiKeyInfo().set) return;
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
  app.get('/login', (req, reply) => {
    const t = req.cookies?.[SESSION_COOKIE];
    if (t && accounts.getSession(t) && !req.query.error) return reply.redirect('/');
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

  app.post('/api/auth/setup', { config: { cap: 'public' } }, async (req, reply) => {
    if (accounts.count() > 0) throw new HttpError(409, 'Setup has already been completed');
    const { username, password, name } = req.body || {};
    if (!password) throw new HttpError(400, 'Password is required');
    const u = await accounts.create({ username, password, name, role: 'admin' });
    const { token } = accounts.createSession(u.id, 'password');
    setSessionCookie(req, reply, token);
    return { ok: true };
  });

  app.post('/api/auth/login', { config: { cap: 'public' } }, async (req, reply) => {
    const { username, password } = req.body || {};
    const key = 'login:' + req.ip + ':' + String(username || '').toLowerCase();
    if (loginLimiter.blocked(key) || loginLimiter.blocked('ip:' + req.ip)) {
      throw new HttpError(429, 'Too many failed sign-in attempts. Wait a few minutes and try again.');
    }
    const u = await accounts.verifyLogin(username, password);
    if (!u) {
      loginLimiter.fail(key);
      loginLimiter.fail('ip:' + req.ip);
      throw new HttpError(401, 'Incorrect username or password');
    }
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
      const returnTo = typeof req.query.returnTo === 'string' && req.query.returnTo.startsWith('/') && !req.query.returnTo.startsWith('//') ? req.query.returnTo : '/';
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
    return reply.redirect(tx.returnTo || '/');
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
      accounts.setSetting('passwordLogin', body.passwordLogin);
    }
    const s = { staleMinutes: accounts.staleMinutes, passwordLogin: accounts.passwordLogin };
    broadcast('settings', s);
    return s;
  });

  // ---------------------------------------------------------------- admin: users
  app.get('/api/admin/users', { config: { cap: 'users' } }, async () => ({ users: accounts.list(), roles: ROLES }));
  app.post('/api/admin/users', { config: { cap: 'users' } }, async (req, reply) => {
    const u = await accounts.create(req.body || {});
    return reply.code(201).send({ ok: true, user: u });
  });
  app.patch('/api/admin/users/:id', { config: { cap: 'users' } }, async (req) => {
    const u = await accounts.update(Number(req.params.id), req.body || {}, req.auth.userId);
    basicCache.clear();
    return { ok: true, user: u };
  });
  app.delete('/api/admin/users/:id', { config: { cap: 'users' } }, async (req) => {
    accounts.remove(Number(req.params.id), req.auth.userId);
    basicCache.clear();
    return { ok: true };
  });

  // ---------------------------------------------------------------- admin: SSO
  const ssoBody = (req) => ({ ...accounts.publicSso(), redirectUri: redirectUri(req), ready: accounts.ssoReady() });
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
  app.get('/api/admin/apikey', { config: { cap: 'apiKey' } }, async () => accounts.apiKeyInfo());
  app.post('/api/admin/apikey', { config: { cap: 'apiKey' } }, async (req) => {
    const { action, key } = req.body || {};
    const by = req.auth.user?.username || req.auth.name;
    if (action === 'generate') { const k = accounts.generateApiKey(by); return { ...accounts.apiKeyInfo(), key: k }; }
    if (action === 'set') return accounts.setApiKey(String(key || ''), by);
    if (action === 'disable') return accounts.setApiKey('', by);
    throw new HttpError(400, 'action must be generate, set or disable');
  });

  return { CAPS, roleLevel };
}
