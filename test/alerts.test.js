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
import { Alerts, cleanBaseUrl, cleanUrls } from '../src/alerts.js';

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

function fakeAccounts() {
  const m = new Map();
  return { secret: crypto.randomBytes(32), getSetting: (k, d) => (m.has(k) ? m.get(k) : d), setSetting: (k, v) => m.set(k, v) };
}
const okFetch = (calls) => async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, text: async () => '' }; };
const RULE = { name: 'High CPU', severity: 'critical', alert: true };
const tick = () => new Promise((r) => setImmediate(r));

function make(t, patch = {}, fetchFn) {
  try { t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 }); } catch { /* already on in this test */ }
  const calls = [];
  const a = new Alerts({ accounts: fakeAccounts(), defaultUrl: '', graceOverride: 0, fetchFn: fetchFn || okFetch(calls) });
  a.update({ enabled: true, appriseUrl: 'http://apprise:8000', urls: 'slack://tok/en/route', max: 3, perSeconds: 60, ...patch });
  t.after(() => a.close());
  return { a, calls };
}

test('alerts: validation of the address and destinations', () => {
  assert.equal(cleanBaseUrl('http://apprise:8000/', 'x'), 'http://apprise:8000');
  assert.equal(cleanBaseUrl('', 'x'), '');
  assert.throws(() => cleanBaseUrl('ftp://a', 'x'), /http/);
  assert.throws(() => cleanBaseUrl('http://u:p@a', 'x'), /login/);
  assert.throws(() => cleanBaseUrl('not a url', 'x'), /web address/);
  assert.deepEqual(cleanUrls('slack://a/b\nntfy://c,slack://a/b'), ['slack://a/b', 'ntfy://c']);
  assert.throws(() => cleanUrls('hello'), /Not an Apprise URL/);
});

test('alerts: nothing is sent unless on, with an address and a destination', async (t) => {
  const { a, calls } = make(t, { enabled: false });
  a.notifyOpened({ deviceId: 'd1', rule: RULE, issueId: 1 });
  await tick();
  assert.equal(calls.length, 0);
  assert.throws(() => a.update({ enabled: true, appriseUrl: '' }), /Apprise address/);
  const b = make(t, { urls: '' });                   // no destination
  b.a.notifyOpened({ deviceId: 'd1', rule: RULE, issueId: 1 });
  await tick();
  assert.equal(b.calls.length, 0);
  assert.equal(b.a.view().ready, false);
});

test('alerts: posts to Apprise /notify with the destinations, type and message; URLs are stored encrypted and never returned', async (t) => {
  const { a, calls } = make(t);
  a.notifyOpened({ deviceId: 'web-01', rule: RULE, value: 'cpu_pct 97', issueId: 7 });
  await tick(); await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://apprise:8000/notify');
  assert.equal(calls[0].body.urls, 'slack://tok/en/route');
  assert.equal(calls[0].body.type, 'failure');
  assert.match(calls[0].body.title, /Critical: High CPU on web-01/);
  assert.match(calls[0].body.body, /issue #7/);
  const v = JSON.stringify(a.view());
  assert.ok(!v.includes('tok/en/route'), 'the secret part of the URL is not returned');
  assert.deepEqual(a.view().destinations, ['slack://••••']);
  assert.ok(!JSON.stringify(a.accounts.getSetting('alerts')).includes('tok/en'), 'stored encrypted');
});

test('alerts: a saved Apprise key is used instead of URLs', async (t) => {
  const { a, calls } = make(t, { urls: '', configKey: 'checkin' });
  a.notifyOpened({ deviceId: 'd1', rule: { ...RULE, severity: 'warning' }, issueId: 1 });
  await tick(); await tick();
  assert.equal(calls[0].url, 'http://apprise:8000/notify/checkin');
  assert.equal(calls[0].body.urls, undefined);
  assert.equal(calls[0].body.type, 'warning');
});

test('alerts: more than the limit in the window are held back and ONE summary follows', async (t) => {
  const { a, calls } = make(t, { max: 3, perSeconds: 60 });
  for (let i = 1; i <= 10; i++) a.notifyOpened({ deviceId: `d${i}`, rule: RULE, issueId: i });
  await tick(); await tick(); await tick(); await tick();
  assert.equal(calls.length, 3, 'only the first three go out');
  assert.equal(a.view().held, 7);
  t.mock.timers.tick(61_000);
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(calls.length, 4);
  assert.match(calls[3].body.title, /7 more issues opened/);
  assert.match(calls[3].body.body, /d4 \(High CPU\)/);
  assert.equal(a.view().held, 0);
  // Window over: individual alerts flow again.
  a.notifyOpened({ deviceId: 'late', rule: RULE, issueId: 11 });
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(calls.length, 5);
  assert.match(calls[4].body.title, /late/);
});

test('alerts: quiet time after start-up holds alerts, then one summary', async (t) => {
  const { a, calls } = make(t, {}, undefined);
  a.graceOverride = 120;
  a.startedAt = Date.now();
  a.notifyOpened({ deviceId: 'd1', rule: RULE, issueId: 1 });
  a.notifyOpened({ deviceId: 'd2', rule: RULE, issueId: 2 });
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(calls.length, 0);
  t.mock.timers.tick(122_000);
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.title, /2 more issues opened/);
});

test('alerts: a failing Apprise is counted and reported, and never throws into the caller', async (t) => {
  const { a } = make(t, {}, async () => ({ ok: false, status: 500, text: async () => '<b>boom</b>' }));
  assert.doesNotThrow(() => a.notifyOpened({ deviceId: 'd1', rule: RULE, issueId: 1 }));
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(a.stats.failed, 1);
  assert.match(a.stats.lastError, /Apprise answered 500: boom/);
  await assert.rejects(() => a.test(), /Apprise answered 500/);
  const dead = make(t, {}, async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
  await assert.rejects(() => dead.a.test(), /Could not reach Apprise.*ECONNREFUSED/);
});

test('alerts: API is admin-only to change, power users may look, and rules carry the Alert flag end to end', async (t) => {
  const config = { historyLimit: 3, maxBatch: 5000, maxFieldsPerRecord: 500, bodyLimitMb: 10, importLimitMb: 50,
    logLevel: 'silent', corsOrigin: '', cookieSecure: 'auto', trustProxy: false, oidcIssuerOverride: '',
    host: '127.0.0.1', httpsPort: 0, tlsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ci-tls-')), tlsDisable: false, tlsPollMs: 0, acmeCheckMs: 0, issuesTickMs: 0, alertsGraceSeconds: 0 };
  const db = openDb(':memory:');
  const store = new Store(db, { historyLimit: 3 });
  const accounts = new Accounts(db, { secret: crypto.randomBytes(32), sessionTtlHours: 1 });
  const app = buildApp({ config, store, accounts, oidc: new EntraOidc(accounts, {}) });
  t.after(() => app.close());
  for (const [u, role] of [['admin', 'admin'], ['pat', 'power']]) await accounts.create({ username: u, name: u, password: `${u}-password-1`, role });
  const as = (u) => async (o) => { const r = await app.inject({ ...o, headers: { authorization: basic(u, `${u}-password-1`) } }); return Object.assign(r, { j: () => JSON.parse(r.body) }); };
  const admin = as('admin'); const power = as('pat');
  const calls = [];
  app.alerts.fetch = okFetch(calls);

  assert.equal((await power({ url: '/api/admin/alerts' })).statusCode, 200);
  assert.equal((await power({ method: 'PUT', url: '/api/admin/alerts', payload: { enabled: true } })).statusCode, 403);
  assert.equal((await power({ method: 'POST', url: '/api/admin/alerts/test' })).statusCode, 403);
  const put = await admin({ method: 'PUT', url: '/api/admin/alerts', payload: { enabled: true, appriseUrl: 'http://apprise:8000', urls: 'ntfy://topic', max: 5, perSeconds: 30 } });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal(put.j().ready, true);
  assert.equal((await admin({ method: 'PUT', url: '/api/admin/alerts', payload: { max: 0 } })).statusCode, 400);
  assert.equal((await admin({ method: 'POST', url: '/api/admin/alerts/test' })).statusCode, 200);
  assert.equal(calls.length, 1);

  await admin({ method: 'PUT', url: '/api/admin/issues', payload: { enabled: true } });
  const cfg = (await power({ url: '/api/issues/config' })).j();
  const mk = (name, alert) => ({ name, kind: 'field', field: 'cpu_pct', op: 'gt', value: '90', count: 1, severity: 'critical', alert, clear: { mode: 'auto', count: 1 } });
  const saved = (await power({ method: 'PUT', url: '/api/issues/rules', payload: { version: cfg.version, rules: [mk('Loud', true), mk('Quiet', false)] } })).j();
  assert.deepEqual(saved.rules.map((r) => r.alert), [true, false]);
  const key = accounts.generateApiKey('t');
  await app.inject({ method: 'POST', url: '/api/checkin', headers: { 'x-api-key': key }, payload: { id: 'srv-1', cpu_pct: 99 } });
  for (let i = 0; i < 6; i++) await tick();
  const sent = calls.filter((c) => /srv-1/.test(c.body.title));
  assert.equal(sent.length, 1, 'only the rule with Alert ticked announces the new issue');
  assert.match(sent[0].body.title, /Loud on srv-1/);
  // More problems on the same issue (and a second check-in) are not new issues.
  await app.inject({ method: 'POST', url: '/api/checkin', headers: { 'x-api-key': key }, payload: { id: 'srv-1', cpu_pct: 98 } });
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(calls.filter((c) => /srv-1/.test(c.body.title)).length, 1);
});
