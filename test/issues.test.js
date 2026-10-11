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
import { parseCsv } from '../src/csv.js';

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const MIN = 60_000;
const T0 = Date.parse('2026-10-11T12:00:00.000Z');

async function setup(t) {
  // Fake clock: check-ins, issue times and the "no check-in" timer all use Date.
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const config = { historyLimit: 3, maxBatch: 5000, maxFieldsPerRecord: 500, bodyLimitMb: 10, importLimitMb: 50,
    logLevel: 'silent', corsOrigin: '', cookieSecure: 'auto', trustProxy: false, oidcIssuerOverride: '',
    host: '127.0.0.1', httpsPort: 0, tlsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ci-tls-')), tlsDisable: false, tlsPollMs: 0, acmeCheckMs: 0, issuesTickMs: 0 };
  const db = openDb(':memory:');
  const store = new Store(db, { historyLimit: 3 });
  const accounts = new Accounts(db, { secret: crypto.randomBytes(32), sessionTtlHours: 1 });
  const app = buildApp({ config, store, accounts, oidc: new EntraOidc(accounts, {}) });
  t.after(() => app.close());
  const users = {};
  for (const [u, role] of [['admin', 'admin'], ['pat', 'power'], ['uma', 'user'], ['ursula', 'user'], ['rex', 'reader']]) {
    users[u] = await accounts.create({ username: u, name: u[0].toUpperCase() + u.slice(1), password: `${u}-password-1`, role });
  }
  const key = accounts.generateApiKey('test');
  const as = (u) => async (opts) => {
    const r = await app.inject({ ...opts, headers: { authorization: basic(u, `${u}-password-1`), ...(opts.headers || {}) } });
    return Object.assign(r, { j: () => JSON.parse(r.body) });
  };
  const at = (minutes) => t.mock.timers.setTime(T0 + minutes * MIN);
  const checkin = async (minutes, fields) => {
    at(minutes);
    const r = await app.inject({ method: 'POST', url: '/api/checkin', headers: { 'x-api-key': key }, payload: { id: 'pc-1', ...fields } });
    assert.ok(r.statusCode < 300, r.body);
  };
  const A = { admin: as('admin'), power: as('pat'), user: as('uma'), user2: as('ursula'), reader: as('rex') };
  const enable = async () => assert.equal((await A.admin({ method: 'PUT', url: '/api/admin/issues', payload: { enabled: true } })).statusCode, 200);
  const setRules = async (rules) => {
    const cfg = (await A.power({ url: '/api/issues/config' })).j();
    const r = await A.power({ method: 'PUT', url: '/api/issues/rules', payload: { rules, version: cfg.version } });
    assert.equal(r.statusCode, 200, r.body);
    return r.j().rules;
  };
  const list = async (q = '') => (await A.reader({ url: '/api/issues' + q })).j();
  const one = async (id) => (await A.reader({ url: `/api/issues/${id}` })).j();
  return { app, store, accounts, users, A, at, checkin, enable, setRules, list, one };
}

// "Fails after 5 check-ins in a row, clears after 2" (the CPU clear has its own condition).
const CPU = { name: 'High CPU', kind: 'field', field: 'cpu_pct', op: 'gt', value: '90', count: 5, severity: 'critical',
  clear: { mode: 'custom', op: 'lt', value: '70', count: 2 } };
const MEM = { name: 'High memory', kind: 'field', field: 'mem_pct', op: 'gt', value: '90', count: 1, severity: 'warning', clear: { mode: 'auto', count: 1 } };

test('issues: off until an admin turns them on; only power users and up define rules', async (t) => {
  const { A, enable } = await setup(t);
  assert.equal((await A.reader({ url: '/api/issues' })).statusCode, 409);
  assert.equal((await A.reader({ url: '/api/issues/summary' })).j().enabled, false);
  assert.equal((await A.power({ method: 'PUT', url: '/api/admin/issues', payload: { enabled: true } })).statusCode, 403);
  await enable();
  assert.equal((await A.reader({ url: '/api/issues' })).statusCode, 200);
  const cfg = (await A.reader({ url: '/api/issues/config' })).j();
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.reassignMinutes, 60);
  // Rules: users can't, power users can; bad rules are rejected with a reason.
  assert.equal((await A.user({ method: 'PUT', url: '/api/issues/rules', payload: { rules: [CPU] } })).statusCode, 403);
  const bad = async (rule, re) => {
    const r = await A.power({ method: 'PUT', url: '/api/issues/rules', payload: { rules: [rule] } });
    assert.equal(r.statusCode, 400, r.body);
    assert.match(r.j().error, re);
  };
  await bad({ ...CPU, name: '' }, /needs a name/);
  await bad({ ...CPU, op: 'nope' }, /unknown trigger condition/);
  await bad({ ...CPU, value: '' }, /value/);
  await bad({ ...CPU, clear: { mode: 'custom', op: 'lt', value: '' } }, /clear value/);
  await bad({ name: 'Offline', kind: 'stale', value: 0 }, /at least 1 minute/);
  await bad({ name: 'Clock', kind: 'skew', value: 0 }, /more than 0/);
  await bad({ ...CPU, count: 0 }, /check-ins in a row must be between 1 and 1000/);
  await bad({ ...CPU, clear: { ...CPU.clear, count: 'x' } }, /clears after.*check-ins in a row/);
  let r = await A.power({ method: 'PUT', url: '/api/issues/rules', payload: { rules: [CPU], version: 99 } });
  assert.equal(r.statusCode, 409);
  r = await A.power({ method: 'PUT', url: '/api/issues/rules', payload: { rules: [CPU, MEM, { name: 'Defaults', field: 'x', op: 'gt', value: '1' },
    { name: 'Old 0', field: 'x', op: 'gt', value: '1', minutes: 0, clear: { minutes: 0 } }, { name: 'Old 10', field: 'x', op: 'gt', value: '1', minutes: 10, clear: { minutes: 5 } }] } });
  assert.equal(r.statusCode, 200, r.body);
  const [cpu, mem, defs, old0, old10] = r.j().rules;
  assert.equal(cpu.text, 'cpu_pct > 90 on 5 check-ins in a row');
  assert.equal(cpu.clearText, 'cpu_pct < 70 on 2 check-ins in a row');
  assert.equal(mem.text, 'mem_pct > 90');
  assert.equal(mem.clearText, 'Condition no longer true');
  assert.deepEqual([defs.count, defs.clear.count], [5, 2], 'defaults: fail after 5, clear after 2');
  assert.deepEqual([old0.count, old0.clear.count], [1, 1], 'rules saved with 0 minutes: 1 check-in');
  assert.deepEqual([old10.count, old10.clear.count], [5, 2], 'rules saved with minutes: the defaults');
  assert.equal(old10.minutes, undefined);
  // Settings: power users set the reassign window; users can't.
  assert.equal((await A.user({ method: 'PUT', url: '/api/issues/settings', payload: { reassignMinutes: 5 } })).statusCode, 403);
  assert.equal((await A.power({ method: 'PUT', url: '/api/issues/settings', payload: { reassignMinutes: 15 } })).j().reassignMinutes, 15);
});

test('issues: fails after N check-ins in a row, clears after M; one issue per device that closes itself', async (t) => {
  const { checkin, enable, setRules, list, one } = await setup(t);
  await enable();
  await setRules([CPU, MEM]);
  // 4 failing, 1 passing, 4 failing: never 5 in a row.
  for (let i = 0; i < 4; i++) await checkin(i, { cpu_pct: 95, mem_pct: 40 });
  await checkin(4, { cpu_pct: 50 });
  for (let i = 5; i < 9; i++) await checkin(i, { cpu_pct: 95 });
  assert.equal((await list()).total, 0, 'a passing check-in resets the count');
  await checkin(9, {}); // no new values: the device still reports 95, and every check-in is a test
  let l = await list();
  assert.equal(l.total, 1, '5 failing check-ins in a row');
  const id = l.issues[0].id;
  assert.equal(l.issues[0].title, 'High CPU');
  assert.equal(l.issues[0].severity, 'critical');
  assert.equal(l.issues[0].openedAt, new Date(T0 + 9 * MIN).toISOString());
  assert.equal(l.issues[0].problems[0].startedAt, new Date(T0 + 5 * MIN).toISOString(), 'problem start = first failing check-in of the run');
  assert.match(l.issues[0].problems[0].startValue, /cpu_pct = 95 \(5 check-ins in a row\)/);
  assert.equal(l.summary.open, 1);

  await checkin(10, { mem_pct: 95 }); // count 1: straight away
  l = await list();
  assert.equal(l.total, 1, 'still one issue');
  assert.equal(l.issues[0].title, 'High CPU, High memory');
  assert.equal(l.issues[0].activeCount, 2);

  await checkin(11, { cpu_pct: 60 });   // passing 1
  await checkin(12, { cpu_pct: 80 });   // neither failing (≤ 90) nor clear (≥ 70): resets the clear count
  await checkin(13, { cpu_pct: 60 });   // passing 1 again
  assert.equal((await one(id)).activeCount, 2, 'clear needs 2 passing check-ins in a row');
  await checkin(14, { cpu_pct: 60 });   // passing 2
  let d = await one(id);
  assert.equal(d.status, 'open');
  assert.equal(d.activeCount, 1);
  assert.equal(d.title, 'High memory');
  const cpu = d.problems.find((p) => p.name === 'High CPU');
  assert.equal(cpu.clearedHow, 'cleared');
  assert.match(cpu.clearValue, /cpu_pct = 60 \(2 check-ins in a row\)/);
  assert.ok(d.events.some((e) => e.type === 'cleared' && /High CPU cleared/.test(e.text)));

  await checkin(15, { mem_pct: 50 });
  d = await one(id);
  assert.equal(d.status, 'closed');
  assert.equal(d.closedBy, null);
  assert.equal(d.closeReason, 'All problems cleared');
  assert.equal(d.events.at(-1).type, 'closed');
  assert.deepEqual(d.snapshot.cpu_pct, 95);
  assert.equal(d.current.mem_pct, 50);
  assert.equal((await list()).total, 0);
  assert.equal((await list('?status=closed')).total, 1);
  assert.equal((await list('?status=all&q=memory')).total, 1);
  assert.equal((await list('?status=all&q=nothing-like-this')).total, 0);
});

test('issues: a check-in is only counted once (saving rules or clearing re-checks without counting)', async (t) => {
  const { A, checkin, enable, setRules, list } = await setup(t);
  await enable();
  const saved = await setRules([CPU]);
  for (let i = 0; i < 4; i++) await checkin(i, { cpu_pct: 95 });
  for (let i = 0; i < 3; i++) await setRules(saved); // unchanged rules: no extra counts
  await A.admin({ method: 'PUT', url: '/api/admin/issues', payload: { enabled: true } });
  assert.equal((await list()).total, 0);
  await checkin(4, { cpu_pct: 95 });
  assert.equal((await list()).total, 1);
  // Changing the rule starts counting again (the latest check-in counts as the first).
  await setRules([{ ...saved[0], count: 3 }]);
  await A.power({ method: 'DELETE', url: '/api/issues?confirm=true' });
  assert.equal((await list()).total, 0, 'after the change only the latest check-in has counted (1 of 3)');
  await checkin(5, { cpu_pct: 95 });
  await checkin(6, { cpu_pct: 95 });
  assert.equal((await list()).total, 1, '3 in a row under the new rule');
});

test('issues: assign, reassign when it comes back, notes, ignore and manual close', async (t) => {
  const { A, users, checkin, enable, setRules, list, one, app } = await setup(t);
  await enable();
  await setRules([CPU, MEM]);
  await checkin(0, { mem_pct: 95 });
  let id = (await list()).issues[0].id;

  // Assign: anyone at User or above, to anyone enabled in the users list.
  const people = (await A.user({ url: '/api/issues/assignees' })).j().users;
  assert.deepEqual(people.map((u) => u.username).sort(), ['admin', 'pat', 'rex', 'uma', 'ursula']);
  assert.equal((await A.reader({ url: '/api/issues/assignees' })).statusCode, 403);
  assert.equal((await A.reader({ method: 'PUT', url: `/api/issues/${id}/assign`, payload: { assignee: users.uma.id } })).statusCode, 403);
  let r = await A.user({ method: 'PUT', url: `/api/issues/${id}/assign`, payload: { assignee: users.ursula.id } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.j().assignedName, 'Ursula');
  assert.match(r.j().events.at(-1).text, /Assigned to Ursula by Uma/);
  assert.equal((await A.user2({ url: '/api/issues?assignee=me' })).j().total, 1);
  assert.equal((await A.user({ url: '/api/issues?assignee=me' })).j().total, 0);
  assert.equal((await A.user({ url: '/api/issues?assignee=none' })).j().total, 0);

  // Notes: User and up; delete your own, power users delete anyone's.
  assert.equal((await A.reader({ method: 'POST', url: `/api/issues/${id}/notes`, payload: { text: 'hi' } })).statusCode, 403);
  assert.equal((await A.user({ method: 'POST', url: `/api/issues/${id}/notes`, payload: { text: '   ' } })).statusCode, 400);
  r = await A.user({ method: 'POST', url: `/api/issues/${id}/notes`, payload: { text: 'Rebooted it.\nWatching.' } });
  const note = r.j().events.find((e) => e.type === 'note');
  assert.equal(note.text, 'Rebooted it.\nWatching.');
  assert.equal(note.userName, 'Uma');
  assert.equal((await A.user2({ method: 'DELETE', url: `/api/issues/${id}/notes/${note.id}` })).statusCode, 403);
  await A.user2({ method: 'POST', url: `/api/issues/${id}/notes`, payload: { text: 'second' } });
  assert.equal((await A.user({ method: 'DELETE', url: `/api/issues/${id}/notes/${note.id}` })).statusCode, 200);
  const other = (await one(id)).events.find((e) => e.type === 'note');
  assert.equal((await A.power({ method: 'DELETE', url: `/api/issues/${id}/notes/${other.id}` })).statusCode, 200);
  assert.equal((await one(id)).events.filter((e) => e.type === 'note').length, 0);

  // Ignore: the same problem flapping stays ignored; a new problem ends the ignore.
  assert.equal((await A.user({ method: 'POST', url: `/api/issues/${id}/ignore`, payload: { minutes: 0 } })).statusCode, 400);
  r = await A.user({ method: 'POST', url: `/api/issues/${id}/ignore`, payload: { minutes: 30 } });
  assert.equal(r.j().status, 'ignored');
  assert.equal(r.j().ignoredUntil, new Date(T0 + 30 * MIN).toISOString());
  assert.equal((await list()).summary.ignored, 1);
  assert.equal((await list('?status=open')).total, 0);
  await checkin(1, { mem_pct: 50, cpu_pct: 95 }); // memory clears; CPU is only 1 of 5
  assert.equal((await one(id)).status, 'closed', 'all problems cleared while ignored: closes');
  // New issue: memory again + ignore, then CPU joins on its 5th failing check-in -> ignore ends.
  await checkin(2, { mem_pct: 99 });
  const id2 = (await list()).issues[0].id;
  assert.notEqual(id2, id);
  assert.equal((await one(id2)).assignedName, 'Ursula', 'came back within the reassign window');
  assert.match((await one(id2)).events.find((e) => e.type === 'assigned').text, /came back within 60 min of issue #/);
  await A.user({ method: 'POST', url: `/api/issues/${id2}/ignore`, payload: { minutes: 60 } });
  await checkin(3, { mem_pct: 50 });
  await checkin(4, { mem_pct: 98 }); // memory again: same problem, still ignored
  assert.equal((await one(id2)).status, 'closed', 'memory cleared and closed the ignored issue');
  const id3 = (await list()).issues[0].id;
  await A.user({ method: 'POST', url: `/api/issues/${id3}/ignore`, payload: { minutes: 60 } });
  await checkin(6, { cpu_pct: 96 });
  let d = await one(id3);
  assert.equal(d.status, 'open', 'a new problem (High CPU, 5th failing check-in) ends the ignore');
  assert.ok(d.events.some((e) => e.type === 'unignored' && /new problem started \(High CPU\)/.test(e.text)));

  // Ignore runs out on its own (timer).
  await A.user({ method: 'POST', url: `/api/issues/${id3}/ignore`, payload: { minutes: 10 } });
  t.mock.timers.setTime(T0 + 17 * MIN);
  app.issues.tick();
  d = await one(id3);
  assert.equal(d.status, 'open');
  assert.match(d.events.at(-1).text, /Ignore ended/);
  await A.user({ method: 'POST', url: `/api/issues/${id3}/unignore` });

  // Manual close while still happening: stays closed until the problem stops and comes back.
  r = await A.user({ method: 'POST', url: `/api/issues/${id3}/close`, payload: { reason: 'Known: batch job' } });
  assert.equal(r.j().status, 'closed');
  assert.equal(r.j().closedBy, 'Uma');
  assert.equal(r.j().closeReason, 'Known: batch job');
  assert.equal((await A.user({ method: 'POST', url: `/api/issues/${id3}/close` })).statusCode, 409);
  await checkin(20, { cpu_pct: 97, mem_pct: 97 });
  await checkin(30, { cpu_pct: 97, mem_pct: 97 });
  assert.equal((await list()).total, 0, 'closed by hand while still happening: no new issue');
  await checkin(31, { cpu_pct: 50, mem_pct: 50 }); // both stop
  await checkin(32, { mem_pct: 95 });             // memory comes back
  const l = await list();
  assert.equal(l.total, 1);
  assert.equal(l.issues[0].title, 'High memory');
  assert.equal(l.issues[0].assignedName, 'Ursula', 'within 60 min of the manual close');
});

test('issues: the reassign window is configurable and skips disabled people', async (t) => {
  const { A, accounts, users, checkin, enable, setRules, list } = await setup(t);
  await enable();
  await setRules([MEM]);
  await A.power({ method: 'PUT', url: '/api/issues/settings', payload: { reassignMinutes: 10 } });
  await checkin(0, { mem_pct: 95 });
  let id = (await list()).issues[0].id;
  await A.user({ method: 'PUT', url: `/api/issues/${id}/assign`, payload: { assignee: users.uma.id } });
  await checkin(1, { mem_pct: 50 });
  await checkin(20, { mem_pct: 95 }); // 19 minutes later: outside the window
  id = (await list()).issues[0].id;
  assert.equal((await list()).issues[0].assignedName, null);
  await A.user({ method: 'PUT', url: `/api/issues/${id}/assign`, payload: { assignee: users.ursula.id } });
  await checkin(21, { mem_pct: 50 });
  await accounts.update(users.ursula.id, { disabled: true }, users.admin.id);
  await checkin(22, { mem_pct: 95 });
  assert.equal((await list()).issues[0].assignedName, null, 'disabled people are not given issues');
  assert.equal((await A.user({ method: 'PUT', url: `/api/issues/${(await list()).issues[0].id}/assign`, payload: { assignee: users.ursula.id } })).statusCode, 400);
  await A.power({ method: 'PUT', url: '/api/issues/settings', payload: { reassignMinutes: 0 } });
  id = (await list()).issues[0].id;
  await A.user({ method: 'PUT', url: `/api/issues/${id}/assign`, payload: { assignee: users.uma.id } });
  await checkin(23, { mem_pct: 50 });
  await checkin(24, { mem_pct: 95 });
  assert.equal((await list()).issues[0].assignedName, null, '0 = off');
});

test('issues: clock skew and "no check-in" rules', async (t) => {
  const { A, app, checkin, enable, setRules, list, one, store } = await setup(t);
  await enable();
  await setRules([
    { name: 'Clock skew', kind: 'skew', field: 'system_time', value: 5, count: 1, severity: 'warning', clear: { count: 1 } },
    { name: 'Offline', kind: 'stale', value: 10, severity: 'critical', clear: { count: 1 } },
  ]);
  const local = (atMin, offsetMin) => {
    // An agent's local time with a UTC offset, like the PowerShell and Linux agents send.
    const d = new Date(T0 + (atMin + offsetMin) * MIN - 5 * 3600e3);
    return d.toISOString().slice(0, 19) + '-05:00';
  };
  await checkin(0, { system_time: local(0, 2) });
  assert.equal((await list()).total, 0, '2 minutes off is fine');
  await checkin(1, { system_time: local(1, -8) });
  let l = await list();
  assert.equal(l.total, 1);
  assert.equal(l.issues[0].title, 'Clock skew');
  assert.match(l.issues[0].problems[0].startValue, /8\.0 min off/);
  await checkin(2, { system_time: local(2, 1) });
  assert.equal((await list()).total, 0, 'fixed: closes');

  // No check-in for 10 minutes (checked on the timer).
  app.issues.tick(T0 + 11 * MIN);
  assert.equal((await list()).total, 0, 'the server started less than 10 minutes ago');
  t.mock.timers.setTime(T0 + 13 * MIN);
  app.issues.tick();
  l = await list();
  assert.equal(l.total, 1);
  assert.equal(l.issues[0].title, 'Offline');
  assert.equal(l.issues[0].problems[0].startedAt, new Date(T0 + 12 * MIN).toISOString(), 'late since 10 min after the last check-in');
  app.issues.tick();
  assert.equal((await list()).issues[0].problems.length, 1, 'not added twice');
  await checkin(14, { system_time: local(14, 0) });
  const d = await one(l.issues[0].id);
  assert.equal(d.status, 'closed');
  assert.match(d.events.find((e) => e.type === 'cleared').text, /Offline cleared/);

  // Paused check-ins: nobody is late, and the pause doesn't count afterwards.
  await A.power({ method: 'PUT', url: '/api/status', payload: { paused: true } });
  t.mock.timers.setTime(T0 + 60 * MIN);
  app.issues.tick();
  assert.equal((await list()).total, 0);
  await A.power({ method: 'PUT', url: '/api/status', payload: { paused: false } });
  t.mock.timers.setTime(T0 + 65 * MIN);
  app.issues.tick();
  assert.equal((await list()).total, 0, 'only 5 minutes since check-ins resumed');
  t.mock.timers.setTime(T0 + 71 * MIN);
  app.issues.tick();
  assert.equal((await list()).total, 1);
  assert.ok(store.get('pc-1'));
});

test('issues: rule changes, deleted devices, CSV export and clear all', async (t) => {
  const { A, users, checkin, enable, setRules, list, one, app } = await setup(t);
  await enable();
  let rules = await setRules([CPU, MEM]);
  await checkin(0, { mem_pct: 95, cpu_pct: 10 });
  const id = (await list()).issues[0].id;
  await A.user({ method: 'PUT', url: `/api/issues/${id}/assign`, payload: { assignee: users.uma.id } });
  await A.user({ method: 'POST', url: `/api/issues/${id}/notes`, payload: { text: 'Checking, "quoted", comma' } });

  // CSV: one row per issue, and one row per log entry. Readers can't export (like records).
  assert.equal((await A.reader({ url: '/api/issues/export.csv' })).statusCode, 403);
  let r = await A.user({ url: '/api/issues/export.csv' });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-disposition'], /issues-.*\.csv/);
  let rows = parseCsv(r.body);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].device, 'pc-1');
  assert.equal(rows[0].status, 'open');
  assert.equal(rows[0].assigned_to, 'Uma');
  assert.match(rows[0].notes, /Uma: Checking, "quoted", comma/);
  assert.match(rows[0].problem_details, /High memory \[mem_pct > 90\] started .* \(mem_pct = 95\), still active/);
  assert.match(rows[0].log, /Issue opened for pc-1/);
  r = await A.user({ url: '/api/issues/export.csv?kind=log' });
  rows = parseCsv(r.body);
  assert.deepEqual(rows.map((x) => x.type), ['opened', 'problem', 'assigned', 'note']);

  // Turning a rule off removes its problem; the issue closes when nothing is left.
  rules = rules.map((x) => (x.name === 'High memory' ? { ...x, enabled: false } : x));
  await setRules(rules);
  let d = await one(id);
  assert.equal(d.status, 'closed');
  assert.match(d.events.find((e) => e.type === 'cleared').text, /High memory removed: its rule was turned off by Pat/);
  // Rule back on: the latest check-in counts, so a 1-check-in rule opens a new issue straight away.
  await setRules(rules.map((x) => ({ ...x, enabled: true })));
  const id2 = (await list()).issues[0].id;
  assert.notEqual(id2, id);

  // Deleting the device closes its issue.
  await app.inject({ method: 'DELETE', url: '/api/records/pc-1', headers: { authorization: basic('uma', 'uma-password-1') } });
  d = await one(id2);
  assert.equal(d.status, 'closed');
  assert.equal(d.closeReason, 'The device record was deleted');
  assert.equal(d.current, null);

  // Clear all: power users and up, with confirm. Problems still happening open fresh issues.
  await checkin(10, { mem_pct: 95 });
  assert.equal((await list('?status=all')).total, 3);
  assert.equal((await A.user({ method: 'DELETE', url: '/api/issues?confirm=true' })).statusCode, 403);
  assert.equal((await A.power({ method: 'DELETE', url: '/api/issues' })).statusCode, 400);
  r = await A.power({ method: 'DELETE', url: '/api/issues?confirm=true' });
  assert.equal(r.j().deleted, 3);
  const after = await list('?status=all');
  assert.equal(after.total, 1, 'memory is still high: a new issue');
  assert.equal(after.issues[0].events, undefined);
  assert.equal((await one(after.issues[0].id)).events.filter((e) => e.type === 'note').length, 0);
});

test('issues: survive a restart', async (t) => {
  const { checkin, enable, setRules, list, app } = await setup(t);
  await enable();
  await setRules([CPU, MEM]);
  await checkin(0, { cpu_pct: 95, mem_pct: 95 });
  // A new engine on the same database picks up the open issue and the half-measured CPU.
  const { Issues } = await import('../src/issues.js');
  const again = new Issues({ db: app.issues.db, store: app.issues.store, accounts: app.issues.accounts, tickMs: 0 });
  t.after(() => again.close());
  assert.equal(again.open.size, 1);
  const o = again.open.get('pc-1');
  assert.equal(o.id, (await list()).issues[0].id);
  assert.equal(o.active.size, 1);
  const w = [...again.watch.entries()].find(([k]) => k.endsWith('\0pc-1') && again.rules.find((r) => r.name === 'High CPU' && k.startsWith(r.id)));
  assert.equal(w[1].t, new Date(T0).toISOString());
  assert.equal(w[1].n, 1, 'CPU is 1 of 5');
});

test('issues: review regressions (rule order, off/on, stale clear count, bad bodies, bulk delete)', async (t) => {
  const { A, app, checkin, enable, setRules, list, one, store } = await setup(t);
  await enable();
  const CPU1 = { ...MEM, name: 'High CPU', field: 'cpu_pct', severity: 'critical' };
  await setRules([CPU1, MEM]);
  // One check-in that ends one problem and starts another keeps a single issue.
  await checkin(0, { cpu_pct: 95, mem_pct: 10 });
  await checkin(1, { cpu_pct: 10, mem_pct: 95 });
  let l = await list('?status=all');
  assert.equal(l.total, 1);
  assert.equal(l.issues[0].status, 'open');
  assert.equal(l.issues[0].title, 'High memory');
  assert.equal(l.issues[0].problems.length, 2);
  await checkin(2, { mem_pct: 10 });

  // Turning issues off and on: counting starts again (check-ins weren't watched meanwhile).
  await setRules([{ ...CPU, count: 3 }]);
  await checkin(3, { cpu_pct: 95 });
  await checkin(4, { cpu_pct: 95 });
  await A.admin({ method: 'PUT', url: '/api/admin/issues', payload: { enabled: false } });
  await checkin(13, { cpu_pct: 10 });
  await checkin(100, { cpu_pct: 95 });
  await enable();
  assert.equal((await list()).total, 0, 'the latest check-in counts as 1, not 3');
  await checkin(101, { cpu_pct: 95 });
  assert.equal((await list()).total, 0);
  await checkin(102, { cpu_pct: 95 });
  l = await list();
  assert.equal(l.total, 1);
  assert.equal(l.issues[0].problems[0].startedAt, new Date(T0 + 100 * MIN).toISOString());
  await checkin(103, { cpu_pct: 10 });
  await checkin(104, { cpu_pct: 10 });
  assert.equal((await list()).total, 0);

  // No check-in rule that clears after 2 check-ins: going silent again starts the count over.
  await setRules([{ name: 'Offline', kind: 'stale', value: 10, severity: 'critical', clear: { mode: 'auto', count: 2 } }]);
  t.mock.timers.setTime(T0 + 115 * MIN);
  app.issues.tick();
  const id = (await list()).issues[0].id;
  await checkin(116, {});           // back: 1 of 2
  t.mock.timers.setTime(T0 + 130 * MIN);
  app.issues.tick();                // silent again: count starts over
  await checkin(131, {});           // 1 of 2 again
  assert.equal((await one(id)).status, 'open');
  await checkin(132, {});
  const d = await one(id);
  assert.equal(d.status, 'closed');
  assert.match(d.events.find((e) => e.type === 'cleared').text, /Offline cleared .*2 check-ins in a row/);

  // Bad bodies are 400s, not 500s.
  assert.equal((await A.power({ method: 'PUT', url: '/api/issues/settings', payload: '"x"', headers: { 'content-type': 'application/json' } })).statusCode, 400);
  assert.equal((await A.power({ method: 'PUT', url: '/api/issues/rules', payload: { rules: 'nope' } })).statusCode, 400);
  assert.equal((await A.user({ method: 'POST', url: '/api/issues/abc/notes', payload: { text: 'x' } })).statusCode, 404);
  assert.equal((await A.user({ method: 'POST', url: `/api/issues/${id}/ignore`, payload: {} })).statusCode, 409, 'closed issues cannot be ignored');

  // Many devices: check-ins, then a bulk delete, stay quick.
  await setRules([{ ...CPU, count: 3 }, { ...MEM, count: 3 }, { name: 'Disk', kind: 'field', field: 'disk', op: 'gt', value: '1', count: 3 }]);
  const N = 3000;
  t.mock.timers.setTime(T0 + 300 * MIN);
  const started = performance.now();
  await Promise.all(Array.from({ length: N }, (_, i) => store.enqueue(`d${i}`, { cpu_pct: 99, mem_pct: 99, disk: 5 })));
  const ingestMs = performance.now() - started;
  assert.equal(app.issues.watch.size, N * 3);
  const del = performance.now();
  store.deleteMany(Array.from({ length: N }, (_, i) => `d${i}`));
  const delMs = performance.now() - del;
  assert.equal(app.issues.watch.size, 0);
  assert.ok(delMs < 3000, `bulk delete took ${delMs} ms`);
  assert.ok(ingestMs < 5000, `check-ins took ${ingestMs} ms`);
});

test('issues: older databases get the check-in count columns', async (t) => {
  const { openDb: open } = await import('../src/db.js');
  const db = open(':memory:');
  db.exec(`CREATE TABLE issue_watch (rule_id TEXT NOT NULL, record_id TEXT NOT NULL, trig_since TEXT, clear_since TEXT,
    suppressed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (rule_id, record_id));
    INSERT INTO issue_watch VALUES ('aaaaaaaa', 'pc-9', '2026-10-01T00:00:00.000Z', NULL, 1);`);
  const store = new Store(db, { historyLimit: 3 });
  const accounts = new Accounts(db, { secret: crypto.randomBytes(32), sessionTtlHours: 1 });
  const { Issues } = await import('../src/issues.js');
  const iss = new Issues({ db, store, accounts, tickMs: 0 });
  t.after(() => iss.close());
  const cols = db.prepare('PRAGMA table_info(issue_watch)').all().map((c) => c.name);
  assert.ok(['trig_count', 'clear_count', 'last_version'].every((c) => cols.includes(c)));
  const w = iss.watch.get('aaaaaaaa\0pc-9');
  assert.equal(w.s, true, 'manual-close holds survive');
  assert.equal(w.n, 0);
});

test('issues: admins can turn off automatic closing; issues then wait as "all clear"', async (t) => {
  const { A, checkin, enable, setRules, list, one } = await setup(t);
  await enable();
  await setRules([MEM, { ...MEM, name: 'High CPU', field: 'cpu_pct' }]);
  assert.equal((await A.reader({ url: '/api/issues/config' })).j().autoClose, true, 'on by default');
  assert.equal((await A.power({ method: 'PUT', url: '/api/admin/issues', payload: { autoClose: false } })).statusCode, 403, 'admins only');
  assert.equal((await A.admin({ method: 'PUT', url: '/api/admin/issues', payload: {} })).statusCode, 400);
  let r = await A.admin({ method: 'PUT', url: '/api/admin/issues', payload: { autoClose: false } });
  assert.equal(r.j().autoClose, false);
  assert.equal(r.j().enabled, true, 'changing it leaves issues on');

  await checkin(0, { mem_pct: 95 });
  const id = (await list()).issues[0].id;
  await checkin(1, { mem_pct: 50 });
  let d = await one(id);
  assert.equal(d.status, 'open', 'stays open');
  assert.equal(d.allClear, true);
  assert.equal(d.clearedAt, new Date(T0 + 1 * MIN).toISOString());
  assert.equal(d.events.filter((e) => e.type === 'allclear').length, 1);
  await checkin(2, { mem_pct: 50 });
  assert.equal((await one(id)).events.filter((e) => e.type === 'allclear').length, 1, 'noted once');
  let l = await list();
  assert.equal(l.summary.allClear, 1);
  assert.equal((await list('?status=allclear')).total, 1);

  // A problem that starts again joins the same issue (no new one).
  await checkin(3, { cpu_pct: 95 });
  l = await list('?status=all');
  assert.equal(l.total, 1);
  d = await one(id);
  assert.equal(d.allClear, false);
  assert.equal(d.title, 'High CPU');
  await checkin(4, { cpu_pct: 10 });
  assert.equal((await one(id)).allClear, true);
  assert.equal((await one(id)).events.filter((e) => e.type === 'allclear').length, 2);

  // Someone closes it by hand: nothing is held back (nothing was still happening).
  r = await A.user({ method: 'POST', url: `/api/issues/${id}/close`, payload: { reason: 'Checked, fine' } });
  assert.equal(r.j().status, 'closed');
  await checkin(5, { mem_pct: 99 });
  const id2 = (await list()).issues[0].id;
  assert.notEqual(id2, id, 'a new problem opens a new issue straight away');
  await checkin(6, { mem_pct: 10 });
  assert.equal((await one(id2)).allClear, true);

  // Turning automatic closing back on closes the issues that are already all clear.
  r = await A.admin({ method: 'PUT', url: '/api/admin/issues', payload: { autoClose: true } });
  d = await one(id2);
  assert.equal(d.status, 'closed');
  assert.match(d.closeReason, /automatic closing turned on by Admin/);
  assert.equal((await list()).summary.allClear, 0);
  await checkin(7, { mem_pct: 99 });
  await checkin(8, { mem_pct: 10 });
  assert.equal((await list()).total, 0, 'closes by itself again');
});

test('issues: RDP and SSH closed rules (port_3389 / port_22 from port checks)', async (t) => {
  const { checkin, enable, setRules, list, one } = await setup(t);
  await enable();
  const rules = await setRules([
    { name: 'RDP closed', field: 'port_3389', op: 'eq', value: 'closed', count: 2, severity: 'critical', clear: { mode: 'custom', field: 'port_3389', op: 'eq', value: 'open', count: 1 } },
    { name: 'SSH closed', field: 'port_22', op: 'eq', value: 'closed', count: 2, severity: 'critical', clear: { mode: 'custom', field: 'port_22', op: 'eq', value: 'open', count: 1 } },
  ]);
  assert.equal(rules[0].text, 'port_3389 is closed on 2 check-ins in a row');
  assert.equal(rules[0].clearText, 'port_3389 is open');
  await checkin(0, { port_3389: 'open' });
  await checkin(1, { port_3389: 'closed' });
  assert.equal((await list()).total, 0, 'one closed reading is not enough');
  await checkin(2, { port_3389: 'closed', port_22: 'closed' });
  let l = await list();
  assert.equal(l.total, 1);
  assert.equal(l.issues[0].title, 'RDP closed');
  await checkin(3, { port_22: 'closed' });
  l = await list();
  assert.equal(l.issues[0].title, 'RDP closed, SSH closed');
  await checkin(4, { port_3389: 'open' });
  assert.equal((await one(l.issues[0].id)).title, 'SSH closed');
  await checkin(5, { port_22: 'open' });
  assert.equal((await one(l.issues[0].id)).status, 'closed');
  // A device that doesn't check the port never matches.
  await checkin(6, { port_3389: null, port_22: null });
  await checkin(7, {});
  assert.equal((await list()).total, 0);
});
