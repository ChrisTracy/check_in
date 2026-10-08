import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Accounts } from '../src/auth/accounts.js';
import { EntraOidc } from '../src/auth/oidc.js';
import { buildApp } from '../src/app.js';

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

async function setup(overrides = {}, { apiKey = true } = {}) {
  const config = { historyLimit: 3, maxBatch: 5000, maxFieldsPerRecord: 500, bodyLimitMb: 10, importLimitMb: 50,
    logLevel: 'silent', corsOrigin: '', cookieSecure: 'auto', trustProxy: false, oidcIssuerOverride: '',
    host: '127.0.0.1', httpsPort: 0, tlsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ci-tls-')), tlsDisable: false, tlsPollMs: 0, ...overrides };
  const db = openDb(':memory:');
  const store = new Store(db, { historyLimit: config.historyLimit, maxBatch: config.maxBatch });
  const accounts = new Accounts(db, { secret: crypto.randomBytes(32), sessionTtlHours: 1 });
  const oidc = new EntraOidc(accounts, {});
  const app = buildApp({ config, store, accounts, oidc });
  await accounts.create({ username: 'admin', password: 'adminpass123', role: 'admin' });
  const key = apiKey ? accounts.generateApiKey('test') : null;
  const call = (opts) => app.inject({ ...opts, headers: { ...(key ? { 'x-api-key': key } : {}), ...(opts.headers || {}) } });
  const as = (user, pass) => (opts) => app.inject({ ...opts, headers: { authorization: basic(user, pass), ...(opts.headers || {}) } });
  return { app, store, accounts, key, call, admin: as('admin', 'adminpass123'), as };
}

test('creates then updates a record with dynamic fields', async () => {
  const { call } = await setup();
  let r = await call({ method: 'POST', url: '/api/checkin?id=a&fred=red' });
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().record.fred, 'red');
  const created = r.json().record.created;
  r = await call({ method: 'POST', url: '/api/checkin', payload: 'ID=a&color=blue', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.statusCode, 200);
  const rec = r.json().record;
  assert.equal(rec.fred, 'red');
  assert.equal(rec.color, 'blue');
  assert.equal(rec.created, created);
});

test('id is required; created/modified cannot be overridden; api_key is not stored as a field', async () => {
  const { call, key } = await setup();
  assert.equal((await call({ method: 'POST', url: '/api/checkin', payload: { fred: 'red' } })).statusCode, 400);
  const r = await call({ method: 'POST', url: '/api/checkin', payload: { id: 'x', created: '1999', modified: '1999' } });
  assert.notEqual(r.json().record.created, '1999');
  const r2 = await call({ method: 'POST', url: `/api/checkin?id=y&api_key=${key}`, headers: { 'x-api-key': '' } });
  assert.equal(r2.statusCode, 201);
  assert.equal(r2.json().record.api_key, undefined);
});

test('null removes a field; history is capped by HISTORY_LIMIT', async () => {
  const { call } = await setup({ historyLimit: 3 });
  for (let i = 0; i < 6; i++) await call({ method: 'POST', url: '/api/checkin', payload: { id: 'h', n: i, tmp: 1 } });
  await call({ method: 'POST', url: '/api/checkin', payload: { id: 'h', tmp: null } });
  const { record, history } = (await call({ url: '/api/records/h/history' })).json();
  assert.equal(record.tmp, undefined);
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((h) => h.version), [7, 6, 5]);
  assert.deepEqual(history[0].changes, { tmp: [1, null] });
});

test('concurrent check-ins are all committed', async () => {
  const { call, store } = await setup({ historyLimit: 1000 });
  await Promise.all(Array.from({ length: 2000 }, (_, i) =>
    call({ method: 'POST', url: '/api/checkin', payload: { id: 'd' + (i % 100), i } })));
  assert.equal(store.summary().records, 100);
  assert.equal(store.summary().history, 2000);
});

test('bulk check-in, CSV import/export, bulk delete and clear all', async () => {
  const { call, admin } = await setup();
  let r = await call({ method: 'POST', url: '/api/checkin', payload: [{ id: 'a', x: 1 }, { id: 'b', y: 'hi, "there"' }, { nope: 1 }] });
  assert.equal(r.json().created, 2);
  assert.equal(r.json().errors.length, 1);
  r = await call({ method: 'POST', url: '/api/import', payload: 'id,x,z\na,2,\nc,,new\nd,1,\n', headers: { 'content-type': 'text/csv' } });
  assert.deepEqual([r.json().created, r.json().updated], [2, 1]);
  r = await call({ url: '/api/export.csv' });
  assert.equal(r.body.trim().split('\r\n').length, 5);
  assert.ok(r.body.includes('"hi, ""there"""'));
  r = await call({ method: 'POST', url: '/api/records/delete', payload: { ids: ['c', 'd', 'missing'] } });
  assert.deepEqual([r.json().requested, r.json().deleted], [3, 2]);
  // API key acts as a User: it cannot clear all.
  assert.equal((await call({ method: 'DELETE', url: '/api/records?confirm=true' })).statusCode, 403);
  assert.equal((await admin({ method: 'DELETE', url: '/api/records' })).statusCode, 400);
  r = await admin({ method: 'DELETE', url: '/api/records?confirm=true' });
  assert.equal(r.json().deleted.records, 2);
  assert.equal((await admin({ url: '/api/stats' })).json().history, 0);
});

test('role permissions are enforced', async () => {
  const { accounts, as, app } = await setup();
  for (const role of ['reader', 'user', 'power']) await accounts.create({ username: role, password: 'password1234', role });
  const reader = as('reader', 'password1234');
  const user = as('user', 'password1234');
  const power = as('power', 'password1234');
  await user({ method: 'POST', url: '/api/checkin?id=r1' });

  assert.equal((await app.inject({ url: '/api/records' })).statusCode, 401); // anonymous
  assert.equal((await reader({ url: '/api/records' })).statusCode, 200);
  assert.equal((await reader({ url: '/api/export.csv' })).statusCode, 403);
  assert.equal((await reader({ method: 'DELETE', url: '/api/records/r1' })).statusCode, 403);
  assert.equal((await reader({ method: 'POST', url: '/api/checkin?id=r2' })).statusCode, 403);

  assert.equal((await user({ url: '/api/export.csv' })).statusCode, 200);
  assert.equal((await user({ method: 'PUT', url: '/api/settings', payload: { staleMinutes: 5 } })).statusCode, 403);
  assert.equal((await user({ method: 'DELETE', url: '/api/records?confirm=true' })).statusCode, 403);
  assert.equal((await user({ method: 'DELETE', url: '/api/records/r1' })).statusCode, 200);

  assert.equal((await power({ method: 'PUT', url: '/api/settings', payload: { staleMinutes: 5 } })).json().staleMinutes, 5);
  assert.equal((await power({ method: 'DELETE', url: '/api/records?confirm=true' })).statusCode, 200);
  assert.equal((await power({ url: '/api/admin/users' })).statusCode, 403);
  assert.equal((await user({ url: '/api/admin/apikey' })).statusCode, 403);
  assert.equal((await power({ url: '/api/admin/apikey' })).statusCode, 200);
  assert.equal((await power({ url: '/api/admin/sso' })).statusCode, 403);

  assert.equal((await as('user', 'wrong-password')({ url: '/api/records' })).statusCode, 401);
});

test('check-ins require the API key by default; only admins can turn that off', async () => {
  const withKey = await setup();
  assert.equal((await withKey.app.inject({ method: 'POST', url: '/api/checkin?id=a' })).statusCode, 401);
  const noKey = await setup({}, { apiKey: false });
  assert.equal((await noKey.app.inject({ method: 'POST', url: '/api/checkin?id=a' })).statusCode, 401);
  await noKey.accounts.create({ username: 'pu', password: 'password1234', role: 'power' });
  const pu = noKey.as('pu', 'password1234');
  assert.equal((await pu({ method: 'POST', url: '/api/admin/apikey', payload: { action: 'require', required: false } })).statusCode, 403);
  const r = await noKey.admin({ method: 'POST', url: '/api/admin/apikey', payload: { action: 'require', required: false } });
  assert.equal(r.json().required, false);
  assert.equal((await noKey.app.inject({ method: 'POST', url: '/api/checkin?id=a' })).statusCode, 201);
  assert.equal((await noKey.app.inject({ url: '/api/records' })).statusCode, 401);
  assert.equal((await noKey.app.inject({ url: '/api/config' })).json().apiKeyRequired, false);
});

test('power users and admins can view and regenerate the API key', async () => {
  const { accounts, as, admin, app, key } = await setup();
  for (const role of ['user', 'power']) await accounts.create({ username: role, password: 'password1234', role });
  const user = as('user', 'password1234');
  const power = as('power', 'password1234');
  let r = await power({ url: '/api/admin/apikey' });
  assert.equal(r.json().key, key);
  assert.equal(r.json().revealable, true);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal((await user({ method: 'POST', url: '/api/admin/apikey', payload: { action: 'generate' } })).statusCode, 403);
  r = await power({ method: 'POST', url: '/api/admin/apikey', payload: { action: 'generate' } });
  const fresh = r.json().key;
  assert.match(fresh, /^ck_/);
  assert.notEqual(fresh, key);
  assert.equal((await app.inject({ method: 'POST', url: '/api/checkin?id=k', headers: { 'x-api-key': key } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/checkin?id=k', headers: { 'x-api-key': fresh } })).statusCode, 201);
  // a custom key is admin-only
  assert.equal((await power({ method: 'POST', url: '/api/admin/apikey', payload: { action: 'set', key: 'my-own-key-1234567890' } })).statusCode, 403);
  r = await admin({ method: 'POST', url: '/api/admin/apikey', payload: { action: 'set', key: 'my-own-key-1234567890' } });
  assert.equal(r.json().key, 'my-own-key-1234567890');
});

test('API key start-up: generated for new installs, older setups keep working', async () => {
  const mk = () => new Accounts(openDb(':memory:'), { secret: crypto.randomBytes(32), sessionTtlHours: 1 });
  // brand new install: a key is created and required
  let a = mk();
  a.bootstrapApiKey({ hasRecords: false });
  assert.equal(a.apiKeyInfo().set, true);
  assert.equal(a.apiKeyRequired, true);
  assert.match(a.revealApiKey(), /^ck_/);
  // API_KEY from the environment is used as-is
  a = mk();
  a.bootstrapApiKey({ envKey: 'env-key-1234567890abcd' });
  assert.equal(a.revealApiKey(), 'env-key-1234567890abcd');
  // an older hash-only key becomes viewable when API_KEY matches it
  a = mk();
  a.setSetting('apiKey', { hash: crypto.createHash('sha256').update('old-key-1234567890abcd').digest('hex'), prefix: 'old-ke', created: 'x', by: 'admin' });
  assert.equal(a.apiKeyInfo().revealable, false);
  a.bootstrapApiKey({ envKey: 'old-key-1234567890abcd', hasRecords: true });
  assert.equal(a.revealApiKey(), 'old-key-1234567890abcd');
  assert.equal(a.apiKeyRequired, true);
  // an older install that ran without a key and has data stays open, but gets a key ready
  a = mk();
  a.bootstrapApiKey({ hasRecords: true });
  assert.equal(a.apiKeyRequired, false);
  assert.equal(a.apiKeyInfo().set, true);
  // the policy is decided once; later starts don't change it
  a.setApiKeyRequired(true);
  a.bootstrapApiKey({ hasRecords: true });
  assert.equal(a.apiKeyRequired, true);
});

test('browser sessions require a CSRF token for writes', async () => {
  const { app } = await setup();
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'adminpass123' } });
  assert.equal(login.statusCode, 200);
  const cookie = login.cookies.find((c) => c.name === 'ci_session');
  assert.ok(cookie.httpOnly);
  const headers = { cookie: `ci_session=${cookie.value}` };
  const me = (await app.inject({ url: '/api/auth/me', headers })).json();
  assert.equal(me.role, 'admin');
  assert.equal((await app.inject({ method: 'POST', url: '/api/checkin?id=s', headers })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/checkin?id=s', headers: { ...headers, 'x-csrf-token': me.csrf } })).statusCode, 201);
  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, 'x-csrf-token': me.csrf } });
  assert.equal((await app.inject({ url: '/api/auth/me', headers })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'nope' } })).statusCode, 401);
});

test('setup can only run once and the last admin is protected', async () => {
  const { app, admin, accounts } = await setup();
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'x', password: 'password1234' } })).statusCode, 409);
  const me = accounts.list().find((u) => u.username === 'admin');
  assert.equal((await admin({ method: 'PATCH', url: `/api/admin/users/${me.id}`, payload: { role: 'user' } })).statusCode, 400);
  const r = await admin({ method: 'POST', url: '/api/admin/users', payload: { username: 'bob', password: 'short', role: 'user' } });
  assert.equal(r.statusCode, 400);
  const ok = await admin({ method: 'POST', url: '/api/admin/users', payload: { username: 'bob', role: 'user' } });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().user.hasPassword, false);
});

test('Entra SSO role mapping and provisioning', async () => {
  const { accounts } = await setup();
  accounts.updateSso({
    tenantId: 'tenant-1', clientId: 'c', defaultRole: 'none', autoCreate: true, syncRoles: true,
    groupMap: [{ groupId: 'G-POWER', role: 'power' }],
  });
  const claims = (oid, extra) => ({ tid: 't', oid, iss: 'x', sub: oid, name: 'Person ' + oid, preferred_username: `${oid}@contoso.com`, ...extra });

  const a = accounts.ssoLogin(claims('alice', { roles: ['CheckIn.User', 'CheckIn.Admin'] }));
  assert.equal(a.role, 'admin'); // highest wins
  const c = accounts.ssoLogin(claims('carl', { groups: ['g-power'] }));
  assert.equal(c.role, 'power'); // group match is case-insensitive
  assert.throws(() => accounts.ssoLogin(claims('nobody', {})), /not been assigned/);

  // Role sync on next login
  assert.equal(accounts.ssoLogin(claims('carl', { roles: ['CheckIn.Reader'] })).role, 'reader');

  // Pre-created user is linked by email, and keeps manual role when sync is off
  await accounts.create({ username: 'dana@contoso.com', role: 'user' });
  accounts.updateSso({ syncRoles: false, autoCreate: false });
  const d = accounts.ssoLogin(claims('dana', { roles: ['CheckIn.Reader'] }));
  assert.equal(d.username, 'dana@contoso.com');
  assert.equal(d.role, 'user');
  assert.ok(d.sso_sub);
  assert.throws(() => accounts.ssoLogin(claims('eve', { roles: ['CheckIn.Admin'] })), /has not been added/);
});

test('power users can pause check-ins; status is public', async () => {
  const { app, accounts, as, call } = await setup();
  await accounts.create({ username: 'uu', password: 'password1234', role: 'user' });
  await accounts.create({ username: 'pp', password: 'password1234', role: 'power' });
  const user = as('uu', 'password1234');
  const power = as('pp', 'password1234');

  let s = (await app.inject({ url: '/api/status' })).json();
  assert.deepEqual([s.accepting, s.paused, s.by], [true, false, undefined]);

  assert.equal((await user({ method: 'PUT', url: '/api/status', payload: { paused: true } })).statusCode, 403);
  assert.equal((await power({ method: 'PUT', url: '/api/status', payload: { paused: 'yes' } })).statusCode, 400);
  s = (await power({ method: 'PUT', url: '/api/status', payload: { paused: true } })).json();
  assert.deepEqual([s.accepting, s.by], [false, 'pp']);

  const anon = (await app.inject({ url: '/api/status' })).json();
  assert.equal(anon.accepting, false);
  assert.equal(anon.by, undefined); // who paused is only shown to signed-in callers

  const r = await call({ method: 'POST', url: '/api/checkin?id=x' });
  assert.equal(r.statusCode, 503);
  assert.equal(r.headers['retry-after'], '30');
  assert.equal((await call({ method: 'POST', url: '/api/import', payload: 'id\nx\n', headers: { 'content-type': 'text/csv' } })).statusCode, 503);
  assert.equal((await call({ url: '/api/records' })).statusCode, 200); // reads still work
  assert.equal((await app.inject({ url: '/health' })).json().accepting, false);

  await power({ method: 'PUT', url: '/api/status', payload: { paused: false } });
  assert.equal((await call({ method: 'POST', url: '/api/checkin?id=x' })).statusCode, 201);
});

function httpsGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port, path: urlPath, rejectUnauthorized: false, agent: false }, (res) => {
      const cert = res.socket.getPeerCertificate();
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, cert }));
    }).on('error', reject);
  });
}

test('HTTPS: self-signed certificate, redirect mode, HSTS and hot reload', async (t) => {
  const { app, admin: adminHttp, accounts, as } = await setup({ trustProxy: true });
  t.after(() => app.close());
  // Once HTTP redirects, admin calls must arrive as HTTPS (here via a trusted proxy header).
  const admin = (o) => adminHttp({ ...o, headers: { 'x-forwarded-proto': 'https', ...(o.headers || {}) } });
  await accounts.create({ username: 'pp', password: 'password1234', role: 'power' });
  assert.equal((await as('pp', 'password1234')({ url: '/api/admin/tls' })).statusCode, 403);

  let st = (await admin({ url: '/api/admin/tls' })).json();
  assert.deepEqual([st.mode, st.listening, st.cert], ['off', false, null]);
  assert.equal((await admin({ method: 'PUT', url: '/api/admin/tls', payload: { mode: 'both' } })).statusCode, 400); // no cert yet

  let r = await admin({ method: 'POST', url: '/api/admin/tls/certificate', payload: { type: 'self-signed', hostnames: 'checkin.local, 127.0.0.1', days: 30 } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().installed.subject, 'checkin.local');
  assert.deepEqual(r.json().installed.names, ['checkin.local', '127.0.0.1']);
  assert.equal(r.json().installed.selfSigned, true);
  assert.ok(fs.existsSync(path.join(app.tls.dir, 'key.pem')));

  st = (await admin({ method: 'PUT', url: '/api/admin/tls', payload: { mode: 'redirect', hsts: true, publicPort: 8443 } })).json();
  assert.equal(st.listening, true);
  const port = st.listeningPort;

  // HTTP is redirected (307 keeps the method), except /health
  r = await app.inject({ url: '/api/records?x=1', headers: { host: 'checkin.local:3000' } });
  assert.equal(r.statusCode, 307);
  assert.equal(r.headers.location, 'https://checkin.local:8443/api/records?x=1');
  assert.equal((await app.inject({ url: '/health' })).statusCode, 200);

  // Real TLS handshake against the shared handler
  let h = await httpsGet(port, '/health');
  assert.equal(h.status, 200);
  assert.equal(h.headers['strict-transport-security'], 'max-age=31536000');
  assert.equal(h.cert.subject.CN, 'checkin.local');

  // Replacing the certificate swaps it without restarting the server
  r = await admin({ method: 'POST', url: '/api/admin/tls/certificate', payload: { type: 'self-signed', hostnames: ['renewed.local'] } });
  assert.equal(r.statusCode, 200, r.body);
  h = await httpsGet(port, '/health');
  assert.equal(h.cert.subject.CN, 'renewed.local');
  assert.equal((await admin({ url: '/api/admin/tls' })).json().listeningPort, port);

  // Download the public certificate
  r = await admin({ url: '/api/admin/tls/certificate.pem' });
  assert.ok(r.body.startsWith('-----BEGIN CERTIFICATE-----'));

  assert.equal((await admin({ method: 'DELETE', url: '/api/admin/tls/certificate' })).statusCode, 400); // must turn off first
  st = (await admin({ method: 'PUT', url: '/api/admin/tls', payload: { mode: 'off' } })).json();
  assert.equal(st.listening, false);
  assert.equal((await app.inject({ url: '/api/auth/status' })).statusCode, 200); // no redirect when off
  assert.equal((await admin({ method: 'DELETE', url: '/api/admin/tls/certificate' })).json().cert, null);
});

test('HTTPS: PEM and PFX uploads are validated', async (t) => {
  const { app, admin } = await setup();
  t.after(() => app.close());
  const { generate } = await import('selfsigned');
  const a = await generate([{ name: 'commonName', value: 'a.local' }], { keySize: 2048 });
  const b = await generate([{ name: 'commonName', value: 'b.local' }], { keySize: 2048 });
  const up = (payload) => admin({ method: 'POST', url: '/api/admin/tls/certificate', payload });

  assert.match((await up({ type: 'pem', cert: a.cert, key: b.private })).json().error, /does not match/);
  assert.match((await up({ type: 'pem', cert: 'nope', key: a.private })).json().error, /BEGIN CERTIFICATE/);
  const encKey = crypto.createPrivateKey(a.private).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'k3y-pass' });
  assert.match((await up({ type: 'pem', cert: a.cert, key: encKey })).json().error, /encrypted/);
  const ok = await up({ type: 'pem', cert: a.cert, key: encKey, passphrase: 'k3y-pass' });
  assert.equal(ok.statusCode, 200);
  assert.ok(!fs.readFileSync(path.join(app.tls.dir, 'key.pem'), 'utf8').includes('ENCRYPTED')); // stored decrypted

  let openssl = true;
  try { execFileSync('openssl', ['version']); } catch { openssl = false; }
  if (!openssl) return t.diagnostic('openssl not available: skipping PFX checks');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-pfx-'));
  fs.writeFileSync(path.join(dir, 'c.pem'), b.cert);
  fs.writeFileSync(path.join(dir, 'k.pem'), b.private);
  execFileSync('openssl', ['pkcs12', '-export', '-in', path.join(dir, 'c.pem'), '-inkey', path.join(dir, 'k.pem'),
    '-out', path.join(dir, 'c.pfx'), '-passout', 'pass:pfx-pass']);
  const pfx = fs.readFileSync(path.join(dir, 'c.pfx')).toString('base64');
  assert.match((await up({ type: 'pfx', pfx, passphrase: 'wrong' })).json().error, /Wrong password/);
  const r = await up({ type: 'pfx', pfx, passphrase: 'pfx-pass' });
  assert.equal(r.json().installed.subject, 'b.local');
  assert.equal(r.json().source, 'pfx');
  assert.ok(!fs.existsSync(path.join(app.tls.dir, 'key.pem')));
  const st = (await admin({ method: 'PUT', url: '/api/admin/tls', payload: { mode: 'both' } })).json();
  assert.equal((await httpsGet(st.listeningPort, '/health')).cert.subject.CN, 'b.local');
});

test('HTTPS: TLS_DISABLE forces HTTP only', async (t) => {
  const { app, admin } = await setup({ tlsDisable: true });
  t.after(() => app.close());
  await admin({ method: 'POST', url: '/api/admin/tls/certificate', payload: { type: 'self-signed', hostnames: 'x.local' } });
  const r = await admin({ method: 'PUT', url: '/api/admin/tls', payload: { mode: 'redirect' } });
  assert.equal(r.statusCode, 200); // saved, but not applied
  const s2 = r.json();
  assert.deepEqual([s2.mode, s2.savedMode, s2.disabledByEnv, s2.listening], ['off', 'redirect', true, false]);
  assert.equal((await app.inject({ url: '/api/auth/status' })).statusCode, 200);
});

test('SSO never links an existing account through a spoofable claim', async () => {
  const { accounts } = await setup();
  accounts.updateSso({ tenantId: 'tenant-1', clientId: 'c', defaultRole: 'reader', autoCreate: true, syncRoles: false });
  const claims = (oid, extra) => ({ tid: 'tenant-1', oid, iss: 'https://login.microsoftonline.com/tenant-1/v2.0', sub: oid,
    name: oid, preferred_username: `${oid}@contoso.com`, ...extra });
  await accounts.create({ username: 'boss@contoso.com', role: 'admin', password: 'boss-password-12' });
  await accounts.create({ username: 'jordan', email: 'jordan@contoso.com', role: 'power' }); // SSO-only, pre-created

  // 1. Attacker sets their email claim to the admin's username: gets a new reader account, not the admin.
  const m = accounts.ssoLogin(claims('mallory', { email: 'boss@contoso.com' }));
  assert.equal(m.role, 'reader');
  assert.notEqual(m.username, 'boss@contoso.com');
  // 2. Even a matching sign-in name never links an account that has a password.
  const b = accounts.ssoLogin(claims('boss'));
  assert.equal(b.role, 'reader');
  assert.notEqual(b.username, 'boss@contoso.com');
  assert.equal(accounts.list().find((u) => u.username === 'boss@contoso.com').sso, false);
  // 3. A guest from another identity provider can't claim a pre-created SSO-only account.
  const g = accounts.ssoLogin(claims('guest1', { preferred_username: 'jordan@contoso.com', idp: 'https://sts.windows.net/other-tenant/' }));
  assert.equal(g.role, 'reader');
  // 4. A tenant member whose sign-in name matches the pre-created SSO-only account is linked, once.
  const j = accounts.ssoLogin(claims('jordan', { email: 'whatever@evil.example' }));
  assert.deepEqual([j.username, j.role], ['jordan', 'power']);
  const j2 = accounts.ssoLogin(claims('jordan-impostor', { preferred_username: 'jordan@contoso.com' }));
  assert.notEqual(j2.id, j.id); // already linked to a different identity
  assert.equal(accounts.ssoLogin(claims('jordan')).id, j.id); // same oid signs into the same account
});

test('returnTo only allows same-site paths', async () => {
  const { safeReturnTo } = await import('../src/auth/security.js');
  for (const bad of ['/\\evil.com', '//evil.com', '/\t/evil.com', '/\n/evil.com', 'https://evil.com', 'javascript:alert(1)', '\\/evil.com', ' /x', null, 5]) {
    assert.equal(safeReturnTo(bad), '/', JSON.stringify(bad));
  }
  assert.equal(safeReturnTo('/admin?x=1#h'), '/admin?x=1#h');
  assert.equal(safeReturnTo('/a/../../b'), '/b');
});

test('API field filters support match=any (OR)', async () => {
  const { call } = await setup();
  await call({ method: 'POST', url: '/api/checkin', payload: [
    { id: 'a', site: 'Dallas', owner: 'ops' }, { id: 'b', site: 'Austin', owner: 'it' }, { id: 'c', site: 'Denver', owner: 'ops' }] });
  const ids = async (qs) => (await call({ url: '/api/records?sort=id&' + qs })).json().records.map((r) => r.id);
  assert.deepEqual(await ids('f.site=Dallas&f.owner=ops'), ['a']);
  assert.deepEqual(await ids('f.site=Austin&f.owner=ops&match=any'), ['a', 'b', 'c']);
  assert.deepEqual(await ids('f.site=Austin&f.site=Denver&match=any'), ['c']); // repeated key: last value wins
  assert.deepEqual(await ids('q=Den&f.site=Austin&f.owner=ops&match=any'), ['c']); // search still narrows
});

test('API time range and status filters', async () => {
  const { call, store, accounts } = await setup();
  accounts.setSetting('staleMinutes', 15);
  for (const id of ['now', 'mid', 'old']) await call({ method: 'POST', url: '/api/checkin', payload: { id, kind: 'x' } });
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const set = store.db.prepare('UPDATE records SET created = ?, modified = ? WHERE id = ?');
  set.run(ago(60 * 24 * 10), ago(1), 'now');   // created 10 days ago, active
  set.run(ago(60 * 24 * 2), ago(20), 'mid');   // aging
  set.run(ago(60), ago(45), 'old');            // stale, created 1 hour ago
  const ids = async (qs) => {
    const r = await call({ url: '/api/records?sort=id&' + qs });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().records.map((x) => x.id);
  };
  assert.deepEqual(await ids('status=active'), ['now']);
  assert.deepEqual(await ids('status=aging'), ['mid']);
  assert.deepEqual(await ids('status=stale'), ['old']);
  assert.deepEqual(await ids('status=active,stale'), ['now', 'old']);
  assert.deepEqual(await ids('modifiedAfter=30m'), ['mid', 'now']);
  assert.deepEqual(await ids('modifiedBefore=15m'), ['mid', 'old']);
  assert.deepEqual(await ids('createdAfter=3d'), ['mid', 'old']);
  assert.deepEqual(await ids(`createdBefore=${encodeURIComponent(ago(60 * 24 * 5))}`), ['now']);
  // Ranges always AND with field filters, even with match=any.
  assert.deepEqual(await ids('status=stale&match=any&f.kind=x&f.id=now'), ['old']);
  assert.equal((await call({ url: '/api/records?status=bogus' })).statusCode, 400);
  assert.equal((await call({ url: '/api/records?modifiedAfter=yesterdayish' })).statusCode, 400);
});

test('saved views: personal views are private, team views need power user', async () => {
  const { admin, accounts, as, call, app } = await setup();
  await accounts.create({ username: 'pu', password: 'powerpass123', role: 'power' });
  await accounts.create({ username: 'u1', password: 'userpass1234', role: 'user' });
  const u2 = await accounts.create({ username: 'u2', password: 'userpass1234', role: 'reader' });
  const pu = as('pu', 'powerpass123'); const u1 = as('u1', 'userpass1234'); const r2 = as('u2', 'userpass1234');
  const state = { filters: [{ field: 'site', op: 'eq', value: 'Dallas' }], layout: 'cards', evil: 'dropped' };

  // Personal: any signed-in role, readers included; private to the owner.
  let r = await u1({ method: 'POST', url: '/api/views', payload: { name: 'Mine', scope: 'personal', state } });
  assert.equal(r.statusCode, 201, r.body);
  const mine = r.json().view;
  assert.equal(mine.state.evil, undefined);
  assert.equal((await r2({ method: 'POST', url: '/api/views', payload: { name: 'Mine', state } })).statusCode, 201);
  assert.deepEqual((await u1({ url: '/api/views' })).json().personal.map((v) => v.name), ['Mine']);
  assert.equal((await r2({ url: '/api/views' })).json().personal.length, 1);
  assert.equal((await r2({ method: 'DELETE', url: `/api/views/${mine.id}` })).statusCode, 404);
  assert.equal((await pu({ method: 'PUT', url: `/api/views/${mine.id}`, payload: { name: 'x' } })).statusCode, 404);
  // Saving the same name overwrites.
  r = await u1({ method: 'POST', url: '/api/views', payload: { name: 'mine', state: { layout: 'table' } } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().view.id, mine.id);
  // API keys have no account, so no personal views.
  assert.equal((await call({ method: 'POST', url: '/api/views', payload: { name: 'k', state } })).statusCode, 400);

  // Team: power and admin only; visible to everyone.
  assert.equal((await u1({ method: 'POST', url: '/api/views', payload: { name: 'Ops', scope: 'team', state } })).statusCode, 403);
  r = await pu({ method: 'POST', url: '/api/views', payload: { name: 'Ops', scope: 'team', state } });
  assert.equal(r.statusCode, 201);
  const team = r.json().view;
  assert.equal(team.updatedBy, 'pu');
  assert.deepEqual((await r2({ url: '/api/views' })).json().team.map((v) => v.name), ['Ops']);
  assert.equal((await u1({ method: 'PUT', url: `/api/views/${team.id}`, payload: { state } })).statusCode, 403);
  assert.equal((await u1({ method: 'DELETE', url: `/api/views/${team.id}` })).statusCode, 403);
  assert.equal((await admin({ method: 'PUT', url: `/api/views/${team.id}`, payload: { name: 'Ops 2' } })).json().view.name, 'Ops 2');
  assert.equal((await pu({ method: 'POST', url: '/api/views', payload: { name: 'Default', scope: 'team', state } })).statusCode, 400);
  assert.equal((await admin({ method: 'DELETE', url: `/api/views/${team.id}` })).statusCode, 200);

  // Deleting a user removes their personal views.
  await admin({ method: 'DELETE', url: `/api/admin/users/${u2.id}` });
  assert.equal(app && accounts.db.prepare('SELECT COUNT(*) AS n FROM views WHERE owner_id = ?').get(u2.id).n, 0);
});

test('agent scripts can be downloaded without signing in', async () => {
  const { app } = await setup();
  for (const f of ['checkin-agent.sh', 'checkin-agent.ps1']) {
    const r = await app.inject({ url: `/agent/${f}` });
    assert.equal(r.statusCode, 200, f);
    assert.match(r.body, /Check-In agent/);
  }
  assert.equal((await app.inject({ url: '/agent/..%2fsrc%2fconfig.js' })).statusCode, 404);
  assert.equal((await app.inject({ url: '/agent/seed.js' })).statusCode, 404);
});

test('one-line installers point back at the server they came from', async () => {
  const { app } = await setup({ trustProxy: true });
  let r = await app.inject({ url: '/install.sh?every=10&fields=default,security&extra=site=Dallas,owner=it', headers: { host: 'checkin.example.com', 'x-forwarded-proto': 'https' } });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /SERVER="\$\{CHECKIN_URL:-https:\/\/checkin\.example\.com\}"/);
  assert.match(r.body, /EVERY="\$\{CHECKIN_EVERY:-10\}"/);
  assert.match(r.body, /FIELDS="\$\{CHECKIN_FIELDS:-default,security\}"/);
  assert.match(r.body, /EXTRA='site=Dallas,owner=it'/);
  r = await app.inject({ url: '/install.ps1?every=120', headers: { host: 'checkin.example.com:8443' } });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /\$Server\s+= if \(\$env:CHECKIN_URL\)\s+\{ \$env:CHECKIN_URL \}\s+else \{ 'http:\/\/checkin\.example\.com:8443' \}/);
  assert.match(r.body, /'120'/);
  // explicit address override
  r = await app.inject({ url: '/install.sh?url=https://ops.example.org/' });
  assert.match(r.body, /CHECKIN_URL:-https:\/\/ops\.example\.org\}/);
  // unsafe or invalid options are refused with a script that fails loudly
  for (const q of ['every=0', 'every=60', 'fields=cpu,nope', "extra=a'b", 'extra=$(id)', 'url=ftp://x']) {
    r = await app.inject({ url: '/install.sh?' + q });
    assert.equal(r.statusCode, 400, q);
    assert.match(r.body, /exit 1/);
  }
  // environment variable references are kept literally (single quotes in the Linux installer)
  r = await app.inject({ url: '/install.sh?extra=' + encodeURIComponent('site=${SITE},owner=%USERNAME%,team=${TEAM:-it}') });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /EXTRA='site=\$\{SITE\},owner=%USERNAME%,team=\$\{TEAM:-it\}'/);
  r = await app.inject({ url: '/install.ps1?extra=' + encodeURIComponent('site=%SITE%') });
  assert.match(r.body, /else \{ 'site=%SITE%' \}/);
  for (const bad of ['a=$HOME', 'a=$(id)', 'a=${X']) {
    assert.equal((await app.inject({ url: '/install.sh?extra=' + encodeURIComponent(bad) })).statusCode, 400, bad);
  }
  r = await app.inject({ url: '/install.ps1?extra=%60whoami%60' });
  assert.equal(r.statusCode, 400);
  assert.match(r.body, /^throw /);
  assert.equal((await app.inject({ url: '/install.sh', headers: { host: 'evil"host' } })).statusCode, 400);
  // the dashboard learns the address the server sees
  assert.equal((await app.inject({ url: '/api/config', headers: { host: 'checkin.example.com', 'x-forwarded-proto': 'https' } })).json().siteUrl, 'https://checkin.example.com');
});
