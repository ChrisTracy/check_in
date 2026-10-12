// Users, sign-in options, live-stream access, the API key and HTTPS admin regressions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import forge from 'node-forge';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Accounts, apiKeyProblem, publicOrigin } from '../src/auth/accounts.js';
import { EntraOidc } from '../src/auth/oidc.js';
import { buildApp } from '../src/app.js';
import { parseCertNames } from '../src/tls.js';
import { acmeDomain } from '../src/acme.js';

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const SSO = { enabled: true, tenantId: 'contoso.example', clientId: 'client-1', clientSecret: 'secret-1' };

async function setup(t, overrides = {}) {
  const config = { historyLimit: 3, maxBatch: 5000, maxFieldsPerRecord: 500, bodyLimitMb: 10, importLimitMb: 50,
    logLevel: 'silent', corsOrigin: '', cookieSecure: 'auto', trustProxy: false, oidcIssuerOverride: '',
    host: '127.0.0.1', httpsPort: 0, tlsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ci-tls-')), tlsDisable: false,
    tlsPollMs: 0, acmeCheckMs: 0, issuesTickMs: 0, ...overrides };
  const db = openDb(':memory:');
  const accounts = new Accounts(db, { secret: crypto.randomBytes(32), sessionTtlHours: 1 });
  const app = buildApp({ config, store: new Store(db, { historyLimit: 3 }), accounts, oidc: new EntraOidc(accounts, {}) });
  t.after(() => app.close());
  const adminUser = await accounts.create({ username: 'admin', password: 'admin-password-1', role: 'admin' });
  const uma = await accounts.create({ username: 'uma', password: 'uma-password-1', role: 'user' });
  const admin = (o) => app.inject({ ...o, headers: { authorization: basic('admin', 'admin-password-1'), ...(o.headers || {}) } });
  return { app, accounts, admin, adminUser, uma };
}
const login = (app, username, password, extra = {}) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password }, ...extra });
/** Sign in; returns { cookie, csrf, call } where call() sends the session cookie and CSRF token. */
async function session(app, username, password) {
  const r = await login(app, username, password);
  assert.equal(r.statusCode, 200, r.body);
  const cookie = String(r.headers['set-cookie']).split(';')[0];
  const csrf = (await app.inject({ url: '/api/auth/me', headers: { cookie } })).json().csrf;
  const call = (o) => app.inject({ ...o, headers: { cookie, 'x-csrf-token': csrf, ...(o.headers || {}) } });
  return { cookie, csrf, call };
}

/** Open /api/events over a real socket. `ended` resolves (with what arrived) when the server ends it. */
function openStream(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers }, (res) => {
      let data = '';
      let done = false;
      const ended = new Promise((r) => {
        const fin = () => { if (!done) { done = true; r(data); } };
        res.on('end', fin);
        res.on('close', fin);
      });
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      resolve({ status: res.statusCode, ended, isOpen: () => !done, data: () => data, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: not within ${ms}ms`)), ms))]);
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test('admin 1: open live streams end once their identity is no longer valid', async (t) => {
  const { app, accounts, admin, uma } = await setup(t, { sseHeartbeatMs: 150 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  await accounts.create({ username: 'rita', password: 'rita-password-1', role: 'reader' });
  await accounts.create({ username: 'bob', password: 'bob-password-1', role: 'user' });

  const adminS = await session(app, 'admin', 'admin-password-1');
  const umaS = await session(app, 'uma', 'uma-password-1');
  const ritaS = await session(app, 'rita', 'rita-password-1');
  const streams = {
    admin: await openStream(port, { cookie: adminS.cookie }),
    uma: await openStream(port, { cookie: umaS.cookie }),
    rita: await openStream(port, { cookie: ritaS.cookie }),
    bobBasic: await openStream(port, { authorization: basic('bob', 'bob-password-1') }),
    key: await openStream(port, { 'x-api-key': accounts.generateApiKey('t') }),
  };
  t.after(() => Object.values(streams).forEach((s) => s.close()));
  for (const [k, s] of Object.entries(streams)) assert.equal(s.status, 200, k);
  await tick();

  // Disabling a user ends their stream straight away (not just on the next heartbeat).
  assert.equal((await admin({ method: 'PATCH', url: `/api/admin/users/${uma.id}`, payload: { disabled: true } })).statusCode, 200);
  const got = await within(streams.uma.ended, 1000, 'disabled user stream');
  assert.match(got, /event: signedout/);
  // Signing out ends that session's stream.
  assert.equal((await ritaS.call({ method: 'POST', url: '/api/auth/logout' })).statusCode, 200);
  await within(streams.rita.ended, 1000, 'signed-out stream');
  // HTTP Basic: a password reset ends a stream opened with the old password.
  const bob = accounts.list().find((u) => u.username === 'bob');
  await admin({ method: 'PATCH', url: `/api/admin/users/${bob.id}`, payload: { password: 'bob-password-2' } });
  await within(streams.bobBasic.ended, 1000, 'basic stream after password reset');
  // Replacing the API key ends streams opened with the old one.
  accounts.generateApiKey('t2');
  await within(streams.key.ended, 1000, 'old API key stream');
  // The admin's own stream is untouched by all of that.
  await tick(400);
  assert.equal(streams.admin.isOpen(), true, 'valid streams stay open');
  assert.match(streams.admin.data(), /: ping/, 'heartbeats still arrive');
  // A session that runs out with no event at all is caught by the heartbeat check.
  accounts.db.prepare('UPDATE sessions SET expires = 0').run();
  await within(streams.admin.ended, 1000, 'expired session stream');
  // And a fresh stream from a disabled user is refused outright.
  assert.equal((await openStream(port, { cookie: umaS.cookie })).status, 401);
});

test('admin 1b: deleting a user or revoking their sessions ends their streams', async (t) => {
  const { app, accounts, admin, uma } = await setup(t);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = app.server.address().port;
  const p1 = await session(app, 'uma', 'uma-password-1');
  const s1 = await openStream(port, { cookie: p1.cookie });
  t.after(() => s1.close());
  accounts.revokeSessions(uma.id);
  await within(s1.ended, 1000, 'revoked sessions');
  const p2 = await session(app, 'uma', 'uma-password-1');
  const s2 = await openStream(port, { cookie: p2.cookie });
  t.after(() => s2.close());
  assert.equal((await admin({ method: 'DELETE', url: `/api/admin/users/${uma.id}` })).statusCode, 200);
  await within(s2.ended, 1000, 'deleted user');
});

test('admin 2: the last admin who can sign in cannot lose their only way in', async (t) => {
  const { app, accounts, admin, adminUser } = await setup(t);
  const me = await session(app, 'admin', 'admin-password-1');
  let r = await me.call({ method: 'PATCH', url: `/api/admin/users/${adminUser.id}`, payload: { removePassword: true } });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /lock everyone out/);
  assert.ok(accounts.get(adminUser.id).password_hash, 'password kept');
  assert.equal((await me.call({ url: '/api/auth/me' })).statusCode, 200, 'still signed in');

  // Another admin without any way to sign in (SSO-only, not linked, SSO off) doesn't count.
  const ghost = await accounts.create({ username: 'ghost', role: 'admin' });
  r = await admin({ method: 'PATCH', url: `/api/admin/users/${adminUser.id}`, payload: { removePassword: true } });
  assert.equal(r.statusCode, 400);
  // ...and deleting or disabling the only admin who can sign in is refused too (by another admin).
  await accounts.update(ghost.id, { password: 'ghost-password-1' });
  r = await admin({ method: 'PATCH', url: `/api/admin/users/${ghost.id}`, payload: { removePassword: true } });
  assert.equal(r.statusCode, 200, 'fine while the admin still has a password');
  r = await app.inject({ method: 'DELETE', url: `/api/admin/users/${adminUser.id}`, headers: { authorization: basic('admin', 'admin-password-1') } });
  assert.equal(r.statusCode, 400, 'cannot delete yourself anyway');
  assert.throws(() => accounts.remove(adminUser.id, ghost.id), /last admin who can sign in/);

  // With single sign-on working and the admin linked to it, removing the password is fine.
  accounts.updateSso(SSO);
  accounts.db.prepare('UPDATE users SET sso_sub = ? WHERE id = ?').run('tid:oid-admin', adminUser.id);
  r = await me.call({ method: 'PATCH', url: `/api/admin/users/${adminUser.id}`, payload: { removePassword: true } });
  assert.equal(r.statusCode, 200, r.body);
  // Now turning single sign-on off would leave no admin able to sign in.
  r = await me.call({ method: 'PUT', url: '/api/admin/sso', payload: { enabled: false } });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /password/);
  assert.equal(accounts.ssoReady(), true);
  // The Users list tells the page whether SSO counts as a way in.
  assert.equal((await me.call({ url: '/api/admin/users' })).json().ssoReady, true);
});

test('admin 3: "password sign-in: admins only" needs working single sign-on', async (t) => {
  const { app, accounts, admin } = await setup(t);
  let r = await admin({ method: 'PUT', url: '/api/settings', payload: { passwordLogin: 'admins' } });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /single sign-on/);
  assert.equal(accounts.passwordLogin, true);
  assert.equal((await login(app, 'uma', 'uma-password-1')).statusCode, 200, 'everyone can still sign in');
  accounts.updateSso(SSO);
  r = await admin({ method: 'PUT', url: '/api/settings', payload: { passwordLogin: 'admins' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().passwordLogin, 'admins');
  // While it's "admins only", single sign-on can't be turned off (everyone else would be locked out).
  r = await admin({ method: 'PUT', url: '/api/admin/sso', payload: { enabled: false } });
  assert.equal(r.statusCode, 400, r.body);
  assert.match(r.json().error, /admins only/);
  assert.equal(accounts.ssoReady(), true);
  assert.equal((await admin({ method: 'PUT', url: '/api/settings', payload: { passwordLogin: true } })).json().passwordLogin, true);
  r = await admin({ method: 'PUT', url: '/api/admin/sso', payload: { enabled: false } });
  assert.equal(r.statusCode, 200, r.body);
  // The settings page disables the choice with an explanation while SSO isn't ready.
  const js = fs.readFileSync(new URL('../public/admin.js', import.meta.url), 'utf8');
  assert.match(js, /value="admins"[^\n]*!sso\.ready && passwordLogin !== 'admins' \? 'disabled'/);
});

// ---- certificates -----------------------------------------------------------------
function makeCert(names, { from, to }) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0' + crypto.randomBytes(6).toString('hex');
  cert.validity.notBefore = from;
  cert.validity.notAfter = to;
  const attrs = [{ name: 'commonName', value: names[0] }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'subjectAltName', altNames: names.map((n) => ({ type: 2, value: n })) }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}
const DAY = 86400e3;

test('admin 4: expired and not-yet-valid certificates are refused on upload', async (t) => {
  const { admin } = await setup(t);
  const install = (payload) => admin({ method: 'POST', url: '/api/admin/tls/certificate', payload });
  const old = makeCert(['old.example.com'], { from: new Date(Date.now() - 400 * DAY), to: new Date(Date.now() - 10 * DAY) });
  let r = await install({ type: 'pem', ...old });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /expired on/);
  const future = makeCert(['future.example.com'], { from: new Date(Date.now() + 10 * DAY), to: new Date(Date.now() + 100 * DAY) });
  r = await install({ type: 'pem', ...future });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /not valid until/);
  assert.equal((await admin({ url: '/api/admin/tls' })).json().cert, null, 'nothing was installed');
  const good = makeCert(['good.example.com'], { from: new Date(Date.now() - DAY), to: new Date(Date.now() + 90 * DAY) });
  r = await install({ type: 'pem', ...good });
  assert.equal(r.statusCode, 200, r.body);
});

test('admin 5: self-signed certificates honour "valid for" and validate host names', async (t) => {
  const { admin } = await setup(t);
  const gen = (hostnames, days) => admin({ method: 'POST', url: '/api/admin/tls/certificate', payload: { type: 'self-signed', hostnames, days } });
  let r = await gen('checkin.local, 10.0.0.5, ::1, *.example.com', 30);
  assert.equal(r.statusCode, 200, r.body);
  const c = r.json().installed;
  const days = (Date.parse(c.validTo) - Date.now()) / DAY;
  assert.ok(days > 29 && days < 30.1, `valid for ~30 days, got ${days}`);
  assert.ok(c.names.includes('10.0.0.5') && c.names.includes('checkin.local') && c.names.includes('*.example.com'));
  r = await gen('checkin.local', 3650);
  assert.equal(r.statusCode, 200);
  assert.ok((Date.parse(r.json().installed.validTo) - Date.now()) / DAY > 3649);
  for (const d of [0, -1, 3651, 1.5, 'abc']) {
    r = await gen('checkin.local', d);
    assert.equal(r.statusCode, 400, `days ${d}`);
    assert.match(r.json().error, /1 to 3650/);
  }
  for (const bad of ['1.2.3.999', 'host:8443', '[::1]:443', '10.0.0.5:80', 'bad_name', '-x.example.com', 'a..b', 'fe80::zz']) {
    r = await gen(bad, 30);
    assert.equal(r.statusCode, 400, `${bad}: ${r.body}`);
  }
  assert.match((await gen('host:8443', 30)).json().error, /port/);
  assert.deepEqual(parseCertNames('[2001:db8::1] Host.Example.com.').map((n) => n.name), ['2001:db8::1', 'host.example.com']);
});

test('admin 6: changing your password needs a real new password', async (t) => {
  const { app, accounts, adminUser } = await setup(t);
  const me = await session(app, 'admin', 'admin-password-1');
  const before = accounts.get(adminUser.id).password_hash;
  for (const body of [{ current: 'admin-password-1', next: '' }, { current: 'admin-password-1' }, { current: 'admin-password-1', next: 'short' }, { current: 'admin-password-1', next: 12345678901 }]) {
    const r = await me.call({ method: 'POST', url: '/api/auth/password', payload: body });
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.equal(r.json().ok, false);
  }
  assert.match((await me.call({ method: 'POST', url: '/api/auth/password', payload: { current: 'admin-password-1', next: '' } })).json().error, /new password/);
  assert.equal(accounts.get(adminUser.id).password_hash, before, 'unchanged');
  const ok = await me.call({ method: 'POST', url: '/api/auth/password', payload: { current: 'admin-password-1', next: 'admin-password-2' } });
  assert.equal(ok.statusCode, 200);
  assert.equal((await login(app, 'admin', 'admin-password-2')).statusCode, 200);
  // The account menu (Issues / Load test pages) checks before sending and shows server errors.
  const js = fs.readFileSync(new URL('../public/usermenu.js', import.meta.url), 'utf8');
  assert.match(js, /if \(!next\) \{ toast\('Enter a new password', 'error'\); return false; \}/);
  assert.match(js, /if \(!res\.ok\) \{ toast\(data\.error/);
});

test('admin 7: resetting your own password in Admin → Users keeps you signed in', async (t) => {
  const { app, adminUser, uma } = await setup(t);
  const here = await session(app, 'admin', 'admin-password-1');
  const elsewhere = await session(app, 'admin', 'admin-password-1');
  let r = await here.call({ method: 'PATCH', url: `/api/admin/users/${adminUser.id}`, payload: { password: 'admin-password-2' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await here.call({ url: '/api/auth/me' })).statusCode, 200, 'this session survives');
  assert.equal((await elsewhere.call({ url: '/api/auth/me' })).statusCode, 401, 'other sessions end');
  // A client can't use keepSession to keep someone else's session alive.
  const umaS = await session(app, 'uma', 'uma-password-1');
  r = await here.call({ method: 'PATCH', url: `/api/admin/users/${uma.id}`, payload: { password: 'uma-password-2', keepSession: 'x' } });
  assert.equal(r.statusCode, 200);
  assert.equal((await umaS.call({ url: '/api/auth/me' })).statusCode, 401, "everyone else's sessions end");
});

test('admin 8: automatic certificates can only be requested once turned on', async (t) => {
  const { admin } = await setup(t);
  let r = await admin({ method: 'POST', url: '/api/admin/tls/acme/obtain' });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /Turn on automatic certificates/);
  await admin({ method: 'PUT', url: '/api/admin/tls/acme', payload: { domains: 'checkin.example.com' } });
  r = await admin({ method: 'POST', url: '/api/admin/tls/acme/obtain' });
  assert.equal(r.statusCode, 409, 'domains alone are not enough: the terms were never accepted');
  r = await admin({ method: 'PUT', url: '/api/admin/tls/acme', payload: { enabled: true } });
  assert.equal(r.statusCode, 400, 'terms needed');
  const st = (await admin({ url: '/api/admin/tls/acme' })).json();
  assert.equal(st.enabled, false);
  assert.equal(st.lastAttempt, null, 'nothing was attempted');
});

test('admin 9: custom API keys must be usable by devices', async (t) => {
  const { admin, accounts } = await setup(t);
  const set = (key) => admin({ method: 'POST', url: '/api/admin/apikey', payload: { action: 'set', key } });
  for (const bad of ['                    ', 'kéy-with-accents-1234', 'key with spaces 12345', 'tab\there-1234567890', 'nul\u0000here-1234567890', 'short', 'x'.repeat(257), '']) {
    const r = await set(bad);
    assert.equal(r.statusCode, 400, JSON.stringify(bad));
  }
  assert.match((await set('kéy-with-accents-1234')).json().error, /printable ASCII/);
  const r = await set('  my-Existing_Key.0123456789  ');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().key, 'my-Existing_Key.0123456789', 'trimmed');
  assert.equal(accounts.checkApiKey('my-Existing_Key.0123456789'), true);
  assert.equal(apiKeyProblem('A!~' + 'z'.repeat(13)), null);
  assert.equal(apiKeyProblem('x'.repeat(256)), null);
});

test('admin 10: one person\'s typos do not lock everyone behind the same address out', async (t) => {
  const { app } = await setup(t);
  // 10 failures for uma: uma is blocked (per address + username)...
  for (let i = 0; i < 10; i++) assert.equal((await login(app, 'uma', 'nope')).statusCode, 401);
  assert.equal((await login(app, 'uma', 'uma-password-1')).statusCode, 429);
  // ...but the admin at the same address can still sign in.
  assert.equal((await login(app, 'admin', 'admin-password-1')).statusCode, 200);
  // Successes don't count towards the address limit; failures from many usernames do (50 in total).
  for (let i = 0; i < 20; i++) assert.equal((await login(app, 'admin', 'admin-password-1')).statusCode, 200);
  const spray = await Promise.all(Array.from({ length: 60 }, (_, i) => login(app, `user${i % 6}`, 'nope')));
  assert.equal(spray.filter((r) => r.statusCode === 401).length, 40, '50 failures per address in total (10 already used)');
  assert.equal(spray.filter((r) => r.statusCode === 429).length, 20);
  assert.equal((await login(app, 'admin', 'admin-password-1')).statusCode, 429, 'now the whole address waits');
  assert.equal((await login(app, 'admin', 'admin-password-1', { remoteAddress: '10.1.2.3' })).statusCode, 200, 'other addresses are unaffected');
});

test('admin 11: ACME domains: local names refused, international names converted', async (t) => {
  const { admin } = await setup(t);
  const put = (domains) => admin({ method: 'PUT', url: '/api/admin/tls/acme', payload: { domains } });
  for (const bad of ['printer.local', 'nas.lan', 'app.internal', 'x.localhost', 'router.home.arpa', 'server', 'a_b.example.com']) {
    const r = await put(bad);
    assert.equal(r.statusCode, 400, bad);
  }
  assert.match((await put('printer.local')).json().error, /local-network name/);
  assert.match((await put('server')).json().error, /full public domain name/);
  const r = await put('Bücher.Example, checkin.example.com');
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().domains, ['xn--bcher-kva.example', 'checkin.example.com']);
  assert.equal(acmeDomain('checkin.example.test.'), 'checkin.example.test');
});

test('admin 12: SSO public URL must be an origin; the redirect URI never trusts a bad Host', async (t) => {
  const { app, admin } = await setup(t);
  const put = (publicUrl) => admin({ method: 'PUT', url: '/api/admin/sso', payload: { publicUrl } });
  for (const bad of ['https://check in.example.com', 'https://checkin.example.com/<x>', 'https://checkin.example.com/?a=1', 'https://checkin.example.com/app', 'javascript:alert(1)', 'checkin.example.com', 'https://user:pw@checkin.example.com', 'https://checkin.example.com#x']) {
    const r = await put(bad);
    assert.equal(r.statusCode, 400, bad);
  }
  let r = await put('https://Checkin.Example.com:8443/');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().publicUrl, 'https://checkin.example.com:8443');
  assert.equal(r.json().redirectUri, 'https://checkin.example.com:8443/auth/oidc/callback');
  assert.equal(publicOrigin(''), '');
  r = await put('');
  assert.equal(r.json().publicUrl, '');
  // Without a public URL the Host header is used only when it's a plain host[:port].
  r = await admin({ url: '/api/admin/sso', headers: { host: 'checkin.example.com:3000' } });
  assert.equal(r.json().redirectUri, 'http://checkin.example.com:3000/auth/oidc/callback');
  r = await admin({ url: '/api/admin/sso', headers: { host: 'evil.example.com/phish?x=' } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().redirectUri, '', 'not built from a bad Host');
});

test('admin 13: an empty JSON body is "no fields", and the role check comes first', async (t) => {
  const { app, uma } = await setup(t);
  const json = { 'content-type': 'application/json' };
  // Unauthenticated / unauthorised callers get 401 / 403, not a body error.
  let r = await app.inject({ method: 'DELETE', url: `/api/admin/users/${uma.id}`, headers: json, payload: '' });
  assert.equal(r.statusCode, 401, r.body);
  r = await app.inject({ method: 'DELETE', url: `/api/admin/users/${uma.id}`, headers: { ...json, authorization: basic('uma', 'uma-password-1') }, payload: '' });
  assert.equal(r.statusCode, 403, r.body);
  r = await app.inject({ method: 'POST', url: '/api/admin/apikey', headers: { ...json, authorization: basic('uma', 'uma-password-1') }, payload: '{bad json' });
  assert.equal(r.statusCode, 403, 'role check before parsing');
  // Authorised callers aren't broken by the empty body.
  const other = await app.inject({ method: 'POST', url: '/api/admin/users', headers: { authorization: basic('admin', 'admin-password-1') }, payload: { username: 'gone', password: 'gone-password-1', role: 'reader' } });
  r = await app.inject({ method: 'DELETE', url: `/api/admin/users/${other.json().user.id}`, headers: { ...json, authorization: basic('admin', 'admin-password-1') }, payload: '' });
  assert.equal(r.statusCode, 200, r.body);
  r = await app.inject({ method: 'POST', url: '/api/admin/apikey', headers: { ...json, authorization: basic('admin', 'admin-password-1') }, payload: '' });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /action must be/);
  // Real JSON errors still report as 400 for authorised callers, and sign-in still wants an object.
  r = await app.inject({ method: 'POST', url: '/api/admin/apikey', headers: { ...json, authorization: basic('admin', 'admin-password-1') }, payload: '{bad json' });
  assert.equal(r.statusCode, 400);
  r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: json, payload: '' });
  assert.equal(r.statusCode, 401, 'empty sign-in is just a wrong password');
});

test('admin 2b: SSO role sync never demotes the last admin who can sign in', async (t) => {
  const { accounts } = await setup(t);
  accounts.updateSso({ ...SSO, autoCreate: true, syncRoles: true, defaultRole: 'none' });
  const claims = (oid, roles) => ({ tid: 't', oid, iss: 'x', sub: oid, name: oid, preferred_username: `${oid}@contoso.com`, roles });
  const sam = accounts.ssoLogin(claims('sam', ['CheckIn.Admin']));
  assert.equal(sam.role, 'admin');
  // Every password admin goes away; a leftover admin account that can't sign in doesn't count.
  for (const u of accounts.list()) if (u.role === 'admin' && u.id !== sam.id) accounts.db.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(u.id);
  assert.equal(accounts.ssoLogin(claims('sam', ['CheckIn.User'])).role, 'admin', 'kept: nobody else could sign in as admin');
  // With another admin who can sign in, the sync applies.
  await accounts.create({ username: 'backup', password: 'backup-password-1', role: 'admin' });
  assert.equal(accounts.ssoLogin(claims('sam', ['CheckIn.User'])).role, 'user');
});
