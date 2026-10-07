import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Accounts } from '../src/auth/accounts.js';
import { EntraOidc } from '../src/auth/oidc.js';
import { buildApp } from '../src/app.js';

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

async function setup(overrides = {}, { apiKey = true } = {}) {
  const config = { historyLimit: 3, maxBatch: 5000, maxFieldsPerRecord: 500, bodyLimitMb: 10, importLimitMb: 50,
    logLevel: 'silent', corsOrigin: '', cookieSecure: 'auto', trustProxy: false, oidcIssuerOverride: '', ...overrides };
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
  assert.equal((await power({ url: '/api/admin/apikey' })).statusCode, 403);
  assert.equal((await power({ url: '/api/admin/sso' })).statusCode, 403);

  assert.equal((await as('user', 'wrong-password')({ url: '/api/records' })).statusCode, 401);
});

test('check-ins are open only when no API key is set', async () => {
  const withKey = await setup();
  assert.equal((await withKey.app.inject({ method: 'POST', url: '/api/checkin?id=a' })).statusCode, 401);
  const noKey = await setup({}, { apiKey: false });
  assert.equal((await noKey.app.inject({ method: 'POST', url: '/api/checkin?id=a' })).statusCode, 201);
  assert.equal((await noKey.app.inject({ url: '/api/records' })).statusCode, 401);
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
