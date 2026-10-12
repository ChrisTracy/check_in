import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Accounts } from '../src/auth/accounts.js';
import { EntraOidc } from '../src/auth/oidc.js';
import { buildApp } from '../src/app.js';
import { safeReturnTo } from '../src/auth/security.js';
import { parseTrustProxy } from '../src/config.js';

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

async function setup(t, { users = true, ...overrides } = {}) {
  const config = { historyLimit: 3, maxBatch: 5000, maxFieldsPerRecord: 500, bodyLimitMb: 10, importLimitMb: 50,
    logLevel: 'silent', corsOrigin: '', cookieSecure: 'auto', trustProxy: false, oidcIssuerOverride: '',
    host: '127.0.0.1', httpsPort: 0, tlsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ci-tls-')), tlsDisable: false, tlsPollMs: 0, acmeCheckMs: 0, issuesTickMs: 0, ...overrides };
  const db = openDb(':memory:');
  const accounts = new Accounts(db, { secret: crypto.randomBytes(32), sessionTtlHours: 1 });
  const app = buildApp({ config, store: new Store(db, { historyLimit: 3 }), accounts, oidc: new EntraOidc(accounts, {}) });
  t.after(() => app.close());
  if (users) {
    await accounts.create({ username: 'admin', password: 'admin-password-1', role: 'admin' });
    await accounts.create({ username: 'uma', password: 'uma-password-1', role: 'user' });
  }
  return { app, accounts };
}
const login = (app, username, password, extra = {}) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password }, ...extra });
const cookieOf = (r) => String(r.headers['set-cookie']).split(';')[0];

test('security 1: returnTo can never leave the site, even after the URL is tidied up', async (t) => {
  for (const bad of ['/.//evil.com', '/..//evil.com', '/%2e//evil.com', '/././/evil.com/x', '/a/..//evil.com', '//evil.com', '/\\evil.com', 'https://evil.com', '/%2e%2e//evil.com']) {
    assert.equal(safeReturnTo(bad), '/', bad);
  }
  assert.equal(safeReturnTo('/issues?id=4#x'), '/issues?id=4#x');
  assert.equal(safeReturnTo('/a/../issues'), '/issues');
  // Already signed in: /login?returnTo=... redirects straight away, and must stay on this site.
  const { app } = await setup(t);
  const c = cookieOf(await login(app, 'admin', 'admin-password-1'));
  for (const bad of ['/.//evil.com', '/..//evil.com', '/%2e//evil.com']) {
    const r = await app.inject({ url: '/login?returnTo=' + encodeURIComponent(bad), headers: { cookie: c } });
    assert.equal(r.statusCode, 302);
    assert.equal(r.headers.location, '/', bad);
  }
  const ok = await app.inject({ url: '/login?returnTo=%2Fissues', headers: { cookie: c } });
  assert.equal(ok.headers.location, '/issues');
  // The SSO start keeps the same rule (it stores returnTo in a cookie before going to Microsoft).
  const js = fs.readFileSync(new URL('../public/login.js', import.meta.url), 'utf8');
  assert.match(js, /out\.startsWith\('\/\/'\)/, 'the sign-in page checks the tidied path too');
});

test('security 2: parallel guesses cannot get past the sign-in limit (form and HTTP Basic)', async (t) => {
  const { app } = await setup(t);
  const tries = await Promise.all(Array.from({ length: 40 }, () => login(app, 'admin', 'wrong-password')));
  const codes = tries.map((r) => r.statusCode);
  assert.equal(codes.filter((c) => c === 401).length, 10, 'only 10 attempts reach the password check');
  assert.equal(codes.filter((c) => c === 429).length, 30);
  // The right password is refused too while blocked.
  assert.equal((await login(app, 'admin', 'admin-password-1')).statusCode, 429);

  const { app: app2 } = await setup(t);
  const b = await Promise.all(Array.from({ length: 30 }, () => app2.inject({ url: '/api/auth/me', headers: { authorization: basic('admin', 'nope') } })));
  assert.equal(b.filter((r) => r.statusCode === 401).length, 10);
  assert.equal(b.filter((r) => r.statusCode === 429).length, 20);
  // Many CORRECT sign-ins at once all succeed (they queue for a slot instead of being refused),
  // for several users, by form and by HTTP Basic.
  const { app: app4, accounts: acc4 } = await setup(t);
  for (const n of ['a1', 'a2', 'a3']) await acc4.create({ username: n, password: `${n}-password-1`, role: 'user' });
  const users = ['admin', 'uma', 'a1', 'a2', 'a3'];
  const pw = (u) => (u === 'admin' ? 'admin-password-1' : `${u}-password-1`);
  const ok = await Promise.all(Array.from({ length: 40 }, (_, i) => app4.inject({ url: '/api/auth/me', headers: { authorization: basic(users[i % 5], pw(users[i % 5])) } })));
  assert.deepEqual([...new Set(ok.map((r) => r.statusCode))], [200]);
  const { app: app5 } = await setup(t);
  const ok2 = await Promise.all(Array.from({ length: 15 }, () => login(app5, 'uma', 'uma-password-1')));
  assert.deepEqual([...new Set(ok2.map((r) => r.statusCode))], [200]);
  // Mixed: 5 wrong then correct ones in parallel: the wrong ones count, the right ones get in.
  const { app: app6 } = await setup(t);
  const mixed = await Promise.all([...Array.from({ length: 5 }, () => login(app6, 'uma', 'nope')), ...Array.from({ length: 10 }, () => login(app6, 'uma', 'uma-password-1'))]);
  assert.equal(mixed.filter((r) => r.statusCode === 401).length, 5);
  assert.equal(mixed.filter((r) => r.statusCode === 200).length, 10);
  // Successful sign-ins don't use up the allowance.
  const { app: app3 } = await setup(t);
  for (let i = 0; i < 15; i++) assert.equal((await login(app3, 'uma', 'uma-password-1')).statusCode, 200);
  for (let i = 0; i < 15; i++) assert.equal((await app3.inject({ url: '/api/auth/me', headers: { authorization: basic('uma', 'uma-password-1') } })).statusCode, 200);
});

test('security 3: TRUST_PROXY believes only the address the proxy added', async (t) => {
  assert.equal(parseTrustProxy('true'), 1, '"true" now means one proxy');
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy(''), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('10.0.0.0/8'), '10.0.0.0/8');

  const { app, accounts } = await setup(t, { trustProxy: parseTrustProxy('true') });
  const key = accounts.generateApiKey('t');
  const admin = basic('admin', 'admin-password-1');
  await app.inject({ method: 'PUT', url: '/api/admin/portcheck', headers: { authorization: admin }, payload: { enabled: true, timeoutMs: 200 } });
  // A client sends its own X-Forwarded-For; Caddy appends the real address (here 127.0.0.1 is the proxy).
  const r = await app.inject({ url: '/api/portcheck?ports=9', remoteAddress: '127.0.0.1',
    headers: { 'x-api-key': key, 'x-forwarded-for': '10.255.255.7, 192.0.2.44' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().ip, '192.0.2.44', 'the address Caddy saw, not the one the client wrote');
  // A client reaching the app directly from the internet can't pose as the proxy.
  const direct = await app.inject({ url: '/api/portcheck?ports=9', remoteAddress: '203.0.113.9',
    headers: { 'x-api-key': key, 'x-forwarded-for': '10.255.255.7' } });
  assert.equal(direct.json().ip, '203.0.113.9');
  // Behind Docker the proxy talks from a private address: still trusted.
  const docker = await app.inject({ url: '/api/portcheck?ports=9', remoteAddress: '172.18.0.5',
    headers: { 'x-api-key': key, 'x-forwarded-for': '198.51.100.7' } });
  assert.equal(docker.json().ip, '198.51.100.7');

  // Deploy-key allow lists can't be talked round with the header either.
  const k = (await app.inject({ method: 'POST', url: '/api/admin/tls/deploy-keys', headers: { authorization: admin }, payload: { name: 'ci', allowIps: '10.1.1.1' } })).json().key;
  const d = await app.inject({ method: 'PUT', url: '/api/tls/certificate', remoteAddress: '127.0.0.1',
    headers: { 'x-deploy-key': k, 'content-type': 'application/x-pem-file', 'x-forwarded-for': '10.1.1.1, 192.0.2.44' }, payload: 'x' });
  assert.equal(d.statusCode, 403);
  assert.match(d.json().error, /192\.0\.2\.44/);

  // Rate limits: rotating the forged part doesn't give fresh allowances.
  const tries = await Promise.all(Array.from({ length: 20 }, (_, i) => login(app, 'admin', 'nope', { remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': `10.9.9.${i}, 192.0.2.44` } })));
  assert.equal(tries.filter((x) => x.statusCode === 429).length, 10);
});

test('security 4: X-Forwarded-Proto never reaches the installer scripts as-is', async (t) => {
  const { app } = await setup(t, { trustProxy: 1 });
  const evil = 'https"; touch /tmp/pwned; echo "';
  for (const url of ['/install.sh', '/install.ps1']) {
    const r = await app.inject({ url, remoteAddress: '127.0.0.1', headers: { host: 'checkin.example.com', 'x-forwarded-proto': evil } });
    assert.equal(r.statusCode, 200);
    assert.ok(!r.body.includes('pwned'), `${url} must not contain the header`);
    assert.ok(r.body.includes('http://checkin.example.com'), `${url}: anything but "https" counts as http`);
  }
  const ok = await app.inject({ url: '/install.sh', remoteAddress: '127.0.0.1', headers: { host: 'checkin.example.com', 'x-forwarded-proto': 'https' } });
  assert.ok(ok.body.includes('https://checkin.example.com'));
  // Any capitalisation of https counts as https, everywhere it matters (cookies, installers).
  const up = await app.inject({ url: '/install.sh', remoteAddress: '127.0.0.1', headers: { host: 'checkin.example.com', 'x-forwarded-proto': 'HTTPS' } });
  assert.ok(up.body.includes('https://checkin.example.com'));
  const li = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-proto': 'HTTPS' }, payload: { username: 'admin', password: 'admin-password-1' } });
  assert.match(String(li.headers['set-cookie']), /Secure/);
  // Basic auth: header spelling variants share one cache entry and still work.
  for (const h of [basic('uma', 'uma-password-1'), basic('uma', 'uma-password-1').replace('Basic', 'basic   '), basic('UMA', 'uma-password-1')]) {
    assert.equal((await app.inject({ url: '/api/auth/me', headers: { authorization: h } })).statusCode, 200, h);
  }
});

test('security 5: "password sign-in for admins only" covers HTTP Basic', async (t) => {
  const { app, accounts } = await setup(t);
  // Limiting password sign-in needs single sign-on to be working (see admin 3).
  accounts.updateSso({ enabled: true, tenantId: 'contoso.example', clientId: 'client-1', clientSecret: 'secret-1' });
  const admin = basic('admin', 'admin-password-1');
  const user = basic('uma', 'uma-password-1');
  assert.equal((await app.inject({ url: '/api/auth/me', headers: { authorization: user } })).statusCode, 200, 'cached before the change');
  const r = await app.inject({ method: 'PUT', url: '/api/settings', headers: { authorization: admin }, payload: { passwordLogin: 'admins' } });
  assert.equal(r.statusCode, 200, r.body);
  const me = await app.inject({ url: '/api/auth/me', headers: { authorization: user } });
  assert.equal(me.statusCode, 403, 'the 5-minute Basic cache is not a way round it');
  assert.match(me.json().error, /admins/);
  assert.equal((await app.inject({ method: 'POST', url: '/api/checkin', headers: { authorization: user }, payload: { id: 'x' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/auth/me', headers: { authorization: admin } })).statusCode, 200, 'admins still can');
  assert.equal((await login(app, 'uma', 'uma-password-1')).statusCode, 403);
});

test('security 6: only one first admin, however many setups arrive at once', async (t) => {
  const { app, accounts } = await setup(t, { users: false });
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: `boss${i}`, password: `boss-password-${i}x` } })));
  assert.equal(rs.filter((r) => r.statusCode === 200).length, 1, rs.map((r) => r.statusCode).join(','));
  assert.ok(rs.filter((r) => r.statusCode !== 200).every((r) => r.statusCode === 409));
  assert.equal(accounts.count(), 1);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { username: 'late', password: 'late-password-1' } })).statusCode, 409);
});

test('security 7: sign-in and setup refuse cross-site form posts', async (t) => {
  const { app } = await setup(t);
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  let r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: form, payload: 'username=admin&password=admin-password-1' });
  assert.equal(r.statusCode, 415);
  assert.equal(r.headers['set-cookie'], undefined, 'no session cookie');
  r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'text/plain' }, payload: '{"username":"admin","password":"admin-password-1"}' });
  assert.equal(r.statusCode, 415);
  r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: '"admin"' });
  assert.equal(r.statusCode, 400);
  // JSON (what the sign-in page sends) still works, with a charset too.
  r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json; charset=utf-8' }, payload: JSON.stringify({ username: 'admin', password: 'admin-password-1' }) });
  assert.equal(r.statusCode, 200);

  const { app: fresh, accounts } = await setup(t, { users: false });
  r = await fresh.inject({ method: 'POST', url: '/api/auth/setup', headers: form, payload: 'username=attacker&password=attacker-pass-1' });
  assert.equal(r.statusCode, 415);
  assert.equal(accounts.count(), 0, 'a fresh install cannot be claimed from another site');
});
