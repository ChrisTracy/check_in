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

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(t) {
  const config = { historyLimit: 3, maxBatch: 5000, maxFieldsPerRecord: 500, bodyLimitMb: 10, importLimitMb: 50,
    logLevel: 'silent', corsOrigin: '', cookieSecure: 'auto', trustProxy: false, oidcIssuerOverride: '',
    host: '127.0.0.1', httpsPort: 0, tlsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ci-tls-')), tlsDisable: false, tlsPollMs: 0, acmeCheckMs: 0, issuesTickMs: 0 };
  const db = openDb(':memory:');
  const store = new Store(db, { historyLimit: 3 });
  const accounts = new Accounts(db, { secret: crypto.randomBytes(32), sessionTtlHours: 1 });
  const app = buildApp({ config, store, accounts, oidc: new EntraOidc(accounts, {}) });
  t.after(() => app.close());
  await accounts.create({ username: 'admin', password: 'admin-password-1', role: 'admin' });
  await accounts.create({ username: 'pat', password: 'pat-password-1', role: 'power' });
  const as = (u) => async (opts) => {
    const r = await app.inject({ ...opts, headers: { authorization: basic(u, `${u}-password-1`), ...(opts.headers || {}) } });
    return Object.assign(r, { j: () => JSON.parse(r.body) });
  };
  return { app, store, accounts, admin: as('admin'), power: as('pat') };
}
const sims = (store) => store.list({ q: '' }).records.filter((r) => r.id.startsWith('SIM-'));
async function until(fn, ms = 25000) {
  const end = Date.now() + ms;
  for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error('timed out'); await sleep(50); }
}

test('load test: admins only; simulated check-ins need the internal token', async (t) => {
  const { app, admin, power } = await setup(t);
  assert.equal((await power({ url: '/api/admin/loadtest' })).statusCode, 403);
  assert.equal((await power({ method: 'POST', url: '/api/admin/loadtest/start' })).statusCode, 403);
  const r = await admin({ url: '/api/admin/loadtest' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.j().running, false);
  assert.ok(r.j().catalog.some((c) => c.key === 'high_cpu'));
  // Someone guessing at the token gets nowhere (check-ins require the API key here).
  const bad = await app.inject({ method: 'POST', url: '/api/checkin', headers: { 'x-loadtest-token': 'a'.repeat(64) }, payload: { id: 'x' } });
  assert.equal(bad.statusCode, 401);
  // Validation
  assert.equal((await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { devices: 0 } })).statusCode, 400);
  assert.equal((await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { interval: 0 } })).statusCode, 400);
  assert.equal((await admin({ method: 'POST', url: '/api/admin/loadtest/scenarios', payload: { key: 'nope' } })).statusCode, 400);
  assert.equal((await admin({ method: 'POST', url: '/api/admin/loadtest/scenarios', payload: { key: 'high_cpu', amount: 101 } })).statusCode, 400);
  assert.equal((await admin({ method: 'DELETE', url: '/api/admin/loadtest/devices' })).statusCode, 400);
});

test('load test: starts healthy, problems switch on and off, issues follow, clean up', async (t) => {
  const { app, store, admin } = await setup(t);
  await admin({ method: 'PUT', url: '/api/admin/issues', payload: { enabled: true } });
  const cfg = (await admin({ url: '/api/issues/config' })).j();
  await admin({ method: 'PUT', url: '/api/issues/rules', payload: { version: cfg.version, rules: [
    { name: 'High CPU', field: 'cpu_pct', op: 'gt', value: '90', count: 1, clear: { count: 1 } },
    { name: 'Clock skew', kind: 'skew', field: 'system_time', value: 5, count: 1, clear: { count: 1 } },
  ] } });

  let r = await admin({ method: 'POST', url: '/api/admin/loadtest/start', payload: { devices: 40, interval: 1 } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.j().running, true);
  assert.equal(r.j().target, 40);
  await until(() => sims(store).length === 40);
  let recs = sims(store);
  assert.ok(recs.every((x) => x.simulated === true && x.cpu_pct < 60 && x.ram_pct < 80 && x.disk_max_pct < 90 && x.failed_services === 0 && x.domain_joined === true));
  assert.ok(recs.every((x) => x.hostname === x.id && x.os && x.system_time), 'id and hostname always match');
  assert.equal((await admin({ url: '/api/issues' })).j().total, 0, 'everything healthy at the start');

  // High CPU on 25% (10 devices): they report it from their next check-in, and issues open.
  r = await admin({ method: 'POST', url: '/api/admin/loadtest/scenarios', payload: { key: 'high_cpu', mode: 'percent', amount: 25 } });
  const sc = r.j().scenarios[0];
  assert.equal(sc.affected, 10);
  await until(() => sims(store).filter((x) => x.cpu_pct >= 92).length === 10);
  await until(async () => (await admin({ url: '/api/issues' })).j().total === 10);
  const hot = new Set(sims(store).filter((x) => x.cpu_pct >= 92).map((x) => x.id));
  // More devices: the same 10 plus 10 more (stable picks).
  r = await admin({ method: 'PUT', url: `/api/admin/loadtest/scenarios/${sc.id}`, payload: { mode: 'count', amount: 20 } });
  assert.equal(r.j().scenarios[0].affected, 20);
  await until(() => sims(store).filter((x) => x.cpu_pct >= 92).length === 20);
  assert.ok([...hot].every((id) => store.get(id).cpu_pct >= 92));

  // Clock skew and offline on a few.
  await admin({ method: 'POST', url: '/api/admin/loadtest/scenarios', payload: { key: 'clock_skew', mode: 'count', amount: 3 } });
  r = await admin({ method: 'POST', url: '/api/admin/loadtest/scenarios', payload: { key: 'offline', mode: 'count', amount: 5 } });
  assert.equal(r.j().scenarios.length, 3);
  // (A device picked for both clock skew and offline never reports the skew, so allow for overlap.)
  await until(() => { const n = sims(store).filter((x) => x.time_synced === false).length; return n >= 1 && n <= 3; });
  await sleep(1200);
  await sleep(1500);
  const cutoff = new Date(Date.now() - 1200).toISOString();
  assert.equal(sims(store).filter((x) => x.modified < cutoff).length, 5, 'offline devices stop checking in');

  // Remove everything: healthy again from the next check-in, and the issues close.
  r = await admin({ method: 'DELETE', url: '/api/admin/loadtest/scenarios/all' });
  assert.equal(r.j().scenarios.length, 0);
  await until(() => sims(store).every((x) => x.cpu_pct < 60 && x.time_synced === true));
  await until(async () => (await admin({ url: '/api/issues' })).j().total === 0);
  assert.ok((await admin({ url: '/api/issues?status=closed' })).j().total >= 20);

  // Numbers on the page.
  r = await admin({ url: '/api/admin/loadtest' });
  const s = r.j();
  assert.ok(s.stats.sent >= 120 && s.stats.ok === s.stats.sent - s.inflight, JSON.stringify(s.stats));
  assert.equal(s.stats.errors, 0);
  assert.ok(s.history.length >= 3);
  assert.ok(s.rate > 0);
  assert.equal(s.simDevices, 40);
  assert.ok(s.server.rssMb > 0);

  // Paused check-ins are counted as rejected, not errors.
  await admin({ method: 'PUT', url: '/api/status', payload: { paused: true } });
  await until(async () => (await admin({ url: '/api/admin/loadtest' })).j().stats.rejected > 0);
  await admin({ method: 'PUT', url: '/api/status', payload: { paused: false } });

  // Clean up: only when stopped; deletes simulated records only (a real SIM- named device without simulated = true stays).
  await app.inject({ method: 'POST', url: '/api/checkin', headers: { authorization: basic('admin', 'admin-password-1') }, payload: { id: 'real-pc', cpu_pct: 5 } });
  await app.inject({ method: 'POST', url: '/api/checkin', headers: { authorization: basic('admin', 'admin-password-1') }, payload: { id: 'SIM-REAL-1', cpu_pct: 5 } });
  await app.inject({ method: 'POST', url: '/api/checkin', headers: { authorization: basic('admin', 'admin-password-1') }, payload: { id: 'sim-00001', simulated: true } });
  assert.equal((await admin({ method: 'DELETE', url: '/api/admin/loadtest/devices?confirm=true' })).statusCode, 409);
  await admin({ method: 'POST', url: '/api/admin/loadtest/stop' });
  await sleep(100);
  r = await admin({ method: 'DELETE', url: '/api/admin/loadtest/devices?confirm=true' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.j().deleted, 41, '40 simulated + 1 from an older version');
  assert.deepEqual(sims(store).map((x) => x.id), ['SIM-REAL-1']);
  assert.ok(store.get('real-pc'));
});

test('load test: burst sends every device at once; resizing the fleet while running', async (t) => {
  const { store, admin } = await setup(t);
  await admin({ method: 'POST', url: '/api/admin/loadtest/start', payload: { devices: 10, interval: 3600 } });
  let r = await admin({ method: 'POST', url: '/api/admin/loadtest/burst' });
  await until(() => sims(store).length === 10);
  r = await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { devices: 300, interval: 2 } });
  assert.equal(r.j().devices, 300);
  assert.equal(r.j().target, 150);
  await until(() => sims(store).length === 300);
  await admin({ method: 'POST', url: '/api/admin/loadtest/stop' });
});

test('load test: specific servers and their services', async (t) => {
  const { store, admin } = await setup(t);
  await admin({ method: 'PUT', url: '/api/admin/issues', payload: { enabled: true } });
  const cfg = (await admin({ url: '/api/issues/config' })).j();
  await admin({ method: 'PUT', url: '/api/issues/rules', payload: { version: cfg.version, rules: [
    { name: 'IIS down', field: 'failed_service_names', op: 'contains', value: 'W3SVC', count: 1, clear: { count: 1 } },
    { name: 'High CPU', field: 'cpu_pct', op: 'gt', value: '90', count: 1, clear: { count: 1 } },
  ] } });
  await admin({ method: 'POST', url: '/api/admin/loadtest/start', payload: { devices: 200, interval: 2 } });

  // Find servers: every 5th device is one, each with its role's services.
  let r = await admin({ url: '/api/admin/loadtest/sims?limit=200' });
  assert.equal(r.j().total, 200);
  const servers = r.j().devices.filter((d) => d.kind === 'server');
  assert.equal(servers.length, 40);
  assert.ok(servers.every((d) => d.services.length > 5 && /^SIM-(SRV|LNX)-/.test(d.id) && d.id === d.hostname));
  assert.ok(r.j().devices.every((d) => d.id === d.hostname));
  r = await admin({ url: '/api/admin/loadtest/sims?q=W3SVC' });
  const web = r.j().devices[0];
  assert.ok(web, 'there is a Windows web server');
  assert.match(web.id, /^SIM-SRV-WEB-\d{5}$/);
  assert.ok(web.services.includes('W3SVC'));
  assert.equal((await admin({ url: `/api/admin/loadtest/sims?q=${web.id}` })).j().total, 1);

  // Validation
  assert.equal((await admin({ method: 'PUT', url: '/api/admin/loadtest/sims/SIM-WS-99999', payload: {} })).statusCode, 404);
  assert.equal((await admin({ method: 'PUT', url: `/api/admin/loadtest/sims/${web.id.replace('WEB', 'SQL')}`, payload: {} })).statusCode, 404, 'name must match exactly');
  assert.equal((await admin({ method: 'PUT', url: `/api/admin/loadtest/sims/${web.id}`, payload: { problems: ['nope'] } })).statusCode, 400);
  assert.equal((await admin({ method: 'PUT', url: `/api/admin/loadtest/sims/${web.id}`, payload: { stopped: ['nginx'] } })).statusCode, 400, 'a Windows web server has no nginx');

  // Stop IIS and add high CPU on that one server: it reports it at once.
  r = await admin({ method: 'PUT', url: `/api/admin/loadtest/sims/${web.id}`, payload: { problems: ['high_cpu'], stopped: ['W3SVC', 'WAS'] } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.j().device.stopped, ['W3SVC', 'WAS']);
  assert.equal(r.j().customCount, 1);
  assert.equal(r.j().custom[0].id, web.id);
  await until(() => store.get(web.id)?.failed_service_names === 'W3SVC, WAS');
  const rec = store.get(web.id);
  assert.equal(rec.failed_services, 2);
  assert.ok(rec.cpu_pct >= 92);
  assert.equal(rec.role, 'Web server');
  await until(async () => (await admin({ url: '/api/issues' })).j().total === 1);
  const issue = (await admin({ url: '/api/issues' })).j().issues[0];
  assert.equal(issue.recordId, web.id);
  assert.equal(issue.title, 'IIS down, High CPU');
  // Other servers stay healthy.
  assert.ok(store.list({}).records.filter((x) => x.id !== web.id).every((x) => !x.failed_services && x.cpu_pct < 92));

  // Start IIS again: that problem clears, CPU stays.
  r = await admin({ method: 'PUT', url: `/api/admin/loadtest/sims/${web.id}`, payload: { problems: ['high_cpu'], stopped: [] } });
  await until(() => store.get(web.id).failed_services === 0);
  await until(async () => (await admin({ url: `/api/issues/${issue.id}` })).j().activeCount === 1);
  assert.equal((await admin({ url: '/api/admin/loadtest/sims?filter=custom' })).j().total, 1);

  // Percentages still work alongside: failed services on 100% uses each device's own services.
  await admin({ method: 'POST', url: '/api/admin/loadtest/scenarios', payload: { key: 'failed_services', amount: 100 } });
  await until(() => store.list({}).records.every((x) => x.failed_services === 2));
  assert.ok(store.list({}).records.filter((x) => x.role === 'Web server' && x.id.startsWith('SIM-SRV-')).every((x) => x.failed_service_names.includes('W3SVC')));
  await admin({ method: 'DELETE', url: '/api/admin/loadtest/scenarios/all' });

  // Offline for one device, then make every changed device healthy.
  const other = (await admin({ url: '/api/admin/loadtest/sims?q=server&limit=5' })).j().devices.find((d) => d.id !== web.id);
  await admin({ method: 'PUT', url: `/api/admin/loadtest/sims/${other.id}`, payload: { problems: ['offline'] } });
  assert.equal((await admin({ url: `/api/admin/loadtest/sims?q=${other.id}` })).j().devices[0].offline, true);
  r = await admin({ method: 'DELETE', url: '/api/admin/loadtest/sims' });
  assert.equal(r.j().customCount, 0);
  await until(async () => (await admin({ url: '/api/issues' })).j().total === 0);
  await admin({ method: 'POST', url: '/api/admin/loadtest/stop' });
});

test('load test: RDP and SSH (port_3389 / port_22) like the agents report them', async (t) => {
  const { store, admin } = await setup(t);
  await admin({ method: 'POST', url: '/api/admin/loadtest/start', payload: { devices: 100, interval: 2 } });
  await until(() => sims(store).length === 100);
  const all = sims(store);
  const win = all.filter((x) => /Windows/.test(x.os));
  const lin = all.filter((x) => !/Windows/.test(x.os));
  assert.ok(win.length && lin.length);
  assert.ok(win.every((x) => x.port_3389 === 'open' && x.port_22 === undefined), 'Windows: RDP open');
  assert.ok(lin.every((x) => x.port_22 === 'open' && x.port_3389 === undefined), 'Linux: SSH open');

  // Percentages pick only devices that have the port.
  let r = await admin({ method: 'POST', url: '/api/admin/loadtest/scenarios', payload: { key: 'rdp_closed', amount: 100 } });
  assert.equal(r.j().scenarios[0].affected, win.length);
  assert.equal(r.j().catalog.find((c) => c.key === 'rdp_closed').perDevice, false);
  await until(() => sims(store).filter((x) => x.port_3389 === 'closed').length === win.length);
  assert.ok(sims(store).filter((x) => x.port_22).every((x) => x.port_22 === 'open'));
  await admin({ method: 'DELETE', url: '/api/admin/loadtest/scenarios/all' });
  await until(() => sims(store).every((x) => x.port_3389 !== 'closed'));

  // One device: close SSH on a Linux server; stopping TermService closes RDP on a Windows one.
  const lsrv = (await admin({ url: '/api/admin/loadtest/sims?q=SIM-LNX&limit=1' })).j().devices[0];
  const wsrv = (await admin({ url: '/api/admin/loadtest/sims?q=SIM-SRV&limit=1' })).j().devices[0];
  assert.deepEqual(lsrv.ports.map((p) => p.port), [22]);
  assert.equal((await admin({ method: 'PUT', url: `/api/admin/loadtest/sims/${lsrv.id}`, payload: { closed: [3389] } })).statusCode, 400);
  assert.equal((await admin({ method: 'PUT', url: `/api/admin/loadtest/sims/${lsrv.id}`, payload: { problems: ['ssh_closed'] } })).statusCode, 400, 'ports use closed, not problems');
  r = await admin({ method: 'PUT', url: `/api/admin/loadtest/sims/${lsrv.id}`, payload: { closed: [22] } });
  assert.deepEqual(r.j().device.closed, [22]);
  r = await admin({ method: 'PUT', url: `/api/admin/loadtest/sims/${wsrv.id}`, payload: { stopped: ['TermService'] } });
  await until(() => store.get(lsrv.id).port_22 === 'closed' && store.get(wsrv.id).port_3389 === 'closed');
  assert.equal(store.get(wsrv.id).failed_service_names, 'TermService');
  assert.equal(store.get(lsrv.id).failed_services, 0, 'closing the port alone stops no service');
  assert.equal((await admin({ url: '/api/admin/loadtest/sims?q=SSH&limit=200' })).j().total, lin.length);
  await admin({ method: 'DELETE', url: '/api/admin/loadtest/sims' });
  await until(() => store.get(lsrv.id).port_22 === 'open' && store.get(wsrv.id).port_3389 === 'open');
  await admin({ method: 'POST', url: '/api/admin/loadtest/stop' });
});

// ------------------------------------------------------------------ regressions
const ADMIN = { authorization: basic('admin', 'admin-password-1') };

test('load test: burst respects the in-flight cap, keeps the event loop free, one at a time, skips offline', async (t) => {
  const { app, store, admin } = await setup(t);
  const lt = app.loadTest;
  await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { devices: 6000 } });
  await admin({ method: 'POST', url: '/api/admin/loadtest/scenarios', payload: { key: 'offline', mode: 'count', amount: 100 } });
  let maxInflight = 0;
  let maxGap = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    maxInflight = Math.max(maxInflight, lt.inflight);
  }, 10);
  t.after(() => clearInterval(timer));
  const r = await admin({ method: 'POST', url: '/api/admin/loadtest/burst' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.j().burst, 5900, 'offline devices are not counted (or sent)');
  assert.ok(r.j().inflight <= 1000);
  const again = await admin({ method: 'POST', url: '/api/admin/loadtest/burst' });
  assert.equal(again.statusCode, 409, 'a second burst while one is running is refused');
  await until(() => sims(store).length === 5900, 60000);
  await until(() => lt.inflight === 0 && !lt.bursting);
  clearInterval(timer);
  assert.ok(maxInflight > 0 && maxInflight <= 1000, `in flight peaked at ${maxInflight}`);
  assert.ok(maxGap < 250, `event loop blocked for ${Math.round(maxGap)} ms`);
  assert.equal((await admin({ method: 'POST', url: '/api/admin/loadtest/burst' })).statusCode, 200, 'a new burst once the last one is done');
  await until(() => lt.inflight === 0 && !lt.bursting, 60000);
});

test('load test: percentage picks are stable when the fleet grows or shrinks', async (t) => {
  const { app, admin } = await setup(t);
  const lt = app.loadTest;
  await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { devices: 1000 } });
  await admin({ method: 'POST', url: '/api/admin/loadtest/scenarios', payload: { key: 'high_cpu', mode: 'percent', amount: 10 } });
  await admin({ method: 'POST', url: '/api/admin/loadtest/scenarios', payload: { key: 'ssh_closed', mode: 'percent', amount: 50 } });
  await admin({ method: 'POST', url: '/api/admin/loadtest/scenarios', payload: { key: 'reboot_required', mode: 'count', amount: 40 } });
  const sets = () => lt.scenarios.map((s) => new Set(s.set));
  const subset = (a, b) => [...a].every((k) => b.has(k));
  const s1000 = sets();
  assert.equal(s1000[0].size, 100);
  let r = await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { devices: 1001 } });
  assert.equal(r.statusCode, 200);
  const s1001 = sets();
  assert.ok(subset(s1000[0], s1001[0]) && s1001[0].size === 100, 'one more device changes nothing');
  await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { devices: 1100 } });
  const s1100 = sets();
  assert.equal(s1100[0].size, 110);
  for (let k = 0; k < 3; k++) assert.ok(subset(s1000[k], s1100[k]), `scenario ${k}: growing keeps every pick`);
  assert.deepEqual([...s1100[2]].sort(), [...s1000[2]].sort(), 'a count stays the same devices');
  await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { devices: 900 } });
  const s900 = sets();
  assert.equal(s900[0].size, 90);
  for (let k = 0; k < 2; k++) {
    // Either only picks were dropped, or (when the dropped devices held more than their share) every
    // remaining pick was kept and topped up with the next-ranked devices.
    const kept = new Set([...s1100[k]].filter((i) => i < 900));
    assert.ok(subset(s900[k], s1100[k]) || subset(kept, s900[k]), `scenario ${k}: shrinking keeps picks`);
    assert.ok([...s900[k]].every((i) => i < 900));
  }
  // A count keeps its picks that are still in the fleet and tops up with the next-ranked ones.
  assert.equal(s900[2].size, 40);
  assert.ok([...s1100[2]].filter((i) => i < 900).every((i) => s900[2].has(i)));
  // Changing the amount is stable too.
  r = await admin({ method: 'PUT', url: `/api/admin/loadtest/scenarios/${lt.scenarios[0].id}`, payload: { amount: 20 } });
  assert.ok(subset(s900[0], lt.scenarios[0].set) && lt.scenarios[0].set.size === 180);
});

test('load test: shrinking the fleet deletes the dropped simulated records and closes their issues', async (t) => {
  const { app, store, admin } = await setup(t);
  await admin({ method: 'PUT', url: '/api/admin/issues', payload: { enabled: true } });
  const cfg = (await admin({ url: '/api/issues/config' })).j();
  await admin({ method: 'PUT', url: '/api/issues/rules', payload: { version: cfg.version, rules: [
    { name: 'Reboot', field: 'reboot_required', op: 'eq', value: 'true', count: 1, clear: { count: 1 } },
  ] } });
  await admin({ method: 'POST', url: '/api/admin/loadtest/scenarios', payload: { key: 'reboot_required', amount: 100 } });
  await admin({ method: 'POST', url: '/api/admin/loadtest/start', payload: { devices: 120, interval: 1 } });
  await until(() => sims(store).length === 120);
  await until(async () => (await admin({ url: '/api/issues' })).j().total === 120);
  // A real device that looks simulated by name but isn't marked simulated is never touched.
  const keepId = app.loadTest.id(110);
  const r = await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { devices: 50 } });
  assert.equal(r.statusCode, 200);
  assert.equal(sims(store).length, 50, 'dropped devices are deleted straight away');
  assert.ok(!store.get(keepId));
  await sleep(1500);
  assert.equal(sims(store).length, 50, 'and they stay gone (nothing in flight brings them back)');
  assert.ok(sims(store).every((x) => app.loadTest.index(x.id) < 50));
  await until(async () => (await admin({ url: '/api/issues' })).j().total === 50);
  await admin({ method: 'POST', url: '/api/admin/loadtest/stop' });
});

test('load test: Apply keeps the cycle position (no-op when unchanged), so no device goes stale', async (t) => {
  const { app, store, admin } = await setup(t);
  const lt = app.loadTest;
  await admin({ method: 'POST', url: '/api/admin/loadtest/start', payload: { devices: 100, interval: 1 } });
  await until(() => sims(store).length === 100 && !lt.first);
  await sleep(400);
  const t0 = lt.t0;
  lt.configure({ devices: 100, interval: 1 });
  assert.equal(lt.t0, t0, 'nothing changed: the clock is left alone');
  const pos = lt.cursor % lt.devices;
  lt.configure({ interval: 2 });
  assert.equal(lt.cursor, pos, 'the next device due is still the same one');
  // Apply over and over (faster than a cycle): every device still checks in.
  const start = new Date().toISOString();
  const end = Date.now() + 4500;
  let flip = false;
  while (Date.now() < end) {
    flip = !flip;
    const r = await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { devices: 100, interval: flip ? 1.5 : 2 } });
    assert.equal(r.statusCode, 200);
    await sleep(250);
  }
  const stale = sims(store).filter((x) => x.modified < start);
  assert.equal(stale.length, 0, `${stale.length} devices never checked in again`);
  await admin({ method: 'POST', url: '/api/admin/loadtest/stop' });
});

test('load test: "Make all of these healthy" sends at once, offline devices included', async (t) => {
  const { app, store, admin } = await setup(t);
  await admin({ method: 'POST', url: '/api/admin/loadtest/start', payload: { devices: 30, interval: 3600 } });
  await until(() => sims(store).length === 30 && !app.loadTest.first);
  const [a, b] = [app.loadTest.id(0), app.loadTest.id(1)];
  await admin({ method: 'PUT', url: `/api/admin/loadtest/sims/${a}`, payload: { problems: ['high_cpu', 'reboot_required'] } });
  await until(() => store.get(a).reboot_required === true);
  await admin({ method: 'PUT', url: `/api/admin/loadtest/sims/${b}`, payload: { problems: ['offline'] } });
  await sleep(50);
  const before = store.get(b).modified;
  const r = await admin({ method: 'DELETE', url: '/api/admin/loadtest/sims' });
  assert.equal(r.j().customCount, 0);
  await until(() => store.get(a).reboot_required === false && store.get(a).cpu_pct < 92, 3000);
  await until(() => store.get(b).modified > before, 3000);
  await admin({ method: 'POST', url: '/api/admin/loadtest/stop' });
});

test('load test: a real device with a simulated name is never written or removed', async (t) => {
  const { app, store, admin } = await setup(t);
  const lt = app.loadTest;
  const realId = lt.id(3);
  await app.inject({ method: 'POST', url: '/api/checkin', headers: ADMIN, payload: { id: realId, cpu_pct: 5, owner: 'finance' } });
  // A record that says simulated: 1 (not true) is a real one too.
  const oneId = lt.id(4);
  await app.inject({ method: 'POST', url: '/api/checkin', headers: ADMIN, payload: { id: oneId, simulated: 1 } });
  let r = await admin({ method: 'POST', url: '/api/admin/loadtest/start', payload: { devices: 20, interval: 1 } });
  await until(() => sims(store).filter((x) => x.simulated === true).length === 18);
  await admin({ method: 'POST', url: '/api/admin/loadtest/burst' });
  await admin({ method: 'PUT', url: `/api/admin/loadtest/sims/${realId}`, payload: { problems: ['high_cpu'] } });
  await sleep(1200);
  r = await admin({ url: '/api/admin/loadtest' });
  assert.equal(r.j().taken, 2);
  assert.deepEqual(r.j().takenIds, [realId, oneId].sort());
  const real = store.get(realId);
  assert.equal(real.simulated, undefined);
  assert.equal(real._version, 1, 'never written by the simulator');
  assert.equal(real.owner, 'finance');
  assert.equal(store.get(oneId)._version, 1);
  await admin({ method: 'POST', url: '/api/admin/loadtest/stop' });
  r = await admin({ method: 'DELETE', url: '/api/admin/loadtest/devices?confirm=true' });
  assert.equal(r.j().deleted, 18);
  assert.ok(store.get(realId) && store.get(oneId), 'Remove leaves them alone');
});

test('load test: Stop then Remove (and Remove during a burst) leaves nothing behind', async (t) => {
  const { app, store, admin } = await setup(t);
  await admin({ method: 'POST', url: '/api/admin/loadtest/start', payload: { devices: 5000, interval: 3600 } });
  await admin({ method: 'POST', url: '/api/admin/loadtest/burst' });
  await until(() => app.loadTest.inflight > 50, 10000);
  let r = await admin({ method: 'POST', url: '/api/admin/loadtest/stop' });
  assert.equal(r.j().inflight, 0, 'stop answers once in-flight check-ins have landed');
  r = await admin({ method: 'DELETE', url: '/api/admin/loadtest/devices?confirm=true' });
  assert.equal(r.statusCode, 200, r.body);
  await sleep(500);
  assert.equal(sims(store).length, 0);
  // A burst while stopped, removed straight away (no waiting in between).
  await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { devices: 4000 } });
  await admin({ method: 'POST', url: '/api/admin/loadtest/burst' });
  await until(() => app.loadTest.inflight > 50, 10000);
  r = await admin({ method: 'DELETE', url: '/api/admin/loadtest/devices?confirm=true' });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.j().deleted > 0);
  await sleep(500);
  assert.equal(sims(store).length, 0);
  assert.equal(app.loadTest.inflight, 0);
});

test('load test: built-in property names are not problems; loose numbers are rejected', async (t) => {
  const { app, store, admin } = await setup(t);
  const bad = ['__proto__', 'toString', 'constructor', '__defineGetter__', 'hasOwnProperty', 'valueOf'];
  for (const key of bad) {
    assert.equal((await admin({ method: 'POST', url: '/api/admin/loadtest/scenarios', payload: { key } })).statusCode, 400, key);
  }
  assert.equal(app.loadTest.scenarios.length, 0);
  await admin({ method: 'POST', url: '/api/admin/loadtest/start', payload: { devices: 10, interval: 1 } });
  await until(() => sims(store).length === 10);
  const id = app.loadTest.id(4);
  for (const k of bad) {
    assert.equal((await admin({ method: 'PUT', url: `/api/admin/loadtest/sims/${id}`, payload: { problems: [k] } })).statusCode, 400, k);
    assert.equal((await admin({ method: 'PUT', url: `/api/admin/loadtest/sims/${id}`, payload: { stopped: [k] } })).statusCode, 400, k);
    assert.equal((await admin({ method: 'PUT', url: `/api/admin/loadtest/sims/${id}`, payload: { closed: [k] } })).statusCode, 400, k);
  }
  assert.equal((await admin({ method: 'PUT', url: `/api/admin/loadtest/sims/${id}`, payload: { problems: [{}] } })).statusCode, 400);
  assert.equal(app.loadTest.overrides.size, 0);
  // Check-ins keep working.
  const sent = (await admin({ url: '/api/admin/loadtest' })).j().stats;
  await sleep(1200);
  const now = (await admin({ url: '/api/admin/loadtest' })).j().stats;
  assert.ok(now.ok > sent.ok && now.errors === 0, JSON.stringify(now));

  // Loose numbers.
  for (const devices of [true, [5], '0x10', 2.5, '', null, '1e3', {}]) {
    assert.equal((await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { devices } })).statusCode, 400, JSON.stringify(devices));
  }
  for (const interval of [true, [5], '0x10', '', null]) {
    assert.equal((await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { interval } })).statusCode, 400, JSON.stringify(interval));
  }
  // Nothing is half-applied when one value is bad.
  assert.equal((await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { devices: 20, interval: 'x' } })).statusCode, 400);
  assert.equal(app.loadTest.devices, 10);
  assert.equal((await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { devices: '12' } })).j().devices, 12, 'a plain number string is fine');
  const sc = (k, mode, amount) => admin({ method: 'POST', url: '/api/admin/loadtest/scenarios', payload: { key: k, mode, amount } });
  assert.equal((await sc('high_cpu', 'count', 0.4)).statusCode, 400, 'a count that rounds to 0');
  assert.equal((await sc('high_cpu', 'count', 2.5)).statusCode, 400);
  assert.equal((await sc('high_cpu', 'count', true)).statusCode, 400);
  assert.equal((await sc('high_cpu', 'percent', [5])).statusCode, 400);
  assert.equal((await sc('high_cpu', 'percent', 0)).statusCode, 400);
  assert.equal((await sc('high_cpu', 'bogus', 5)).statusCode, 400);
  assert.equal((await sc('high_cpu', 'count', 20001)).statusCode, 400);
  let r = await sc('high_cpu', 'percent', 1);
  assert.equal(r.statusCode, 200);
  assert.equal(r.j().scenarios[0].affected, 0, 'a small percentage of a small fleet picks nobody (and says so)');
  const sid = r.j().scenarios[0].id;
  assert.equal((await admin({ method: 'PUT', url: `/api/admin/loadtest/scenarios/${sid}`, payload: { mode: 'count', amount: 0.3 } })).statusCode, 400);
  assert.equal((await admin({ method: 'PUT', url: `/api/admin/loadtest/scenarios/${sid}`, payload: { amount: 'abc' } })).statusCode, 400);
  r = await admin({ url: '/api/admin/loadtest' });
  assert.equal(r.j().scenarios[0].amount, 1);
  assert.equal(r.j().scenarios[0].mode, 'percent');
  // Slow fleets don't show a target of 0.
  r = await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { devices: 1, interval: 36 } });
  assert.equal(r.j().target, 0.03);
  await admin({ method: 'POST', url: '/api/admin/loadtest/stop' });
});

test('load test: after a restart the fleet size comes from the simulated records in the database', async (t) => {
  const { app, store } = await setup(t);
  const { LoadTest } = await import('../src/loadtest.js');
  const ids = [];
  for (let i = 0; i < 700; i++) ids.push(app.loadTest.id(i));
  await Promise.all(ids.map((id) => store.upsert({ id, simulated: true })));
  await store.upsert({ id: 'SIM-REAL-9', cpu_pct: 1 });
  const lt = new LoadTest({ app, store, log: {} });
  t.after(() => lt.close());
  assert.equal(lt.devices, 700);
});

test('load test: after a restart with gaps, the fleet size is the highest simulated number', async (t) => {
  const { app, store } = await setup(t);
  const { LoadTest } = await import('../src/loadtest.js');
  const ids = [];
  for (let i = 0; i < 900; i++) ids.push(app.loadTest.id(i));
  await Promise.all(ids.map((id) => store.upsert({ id, simulated: true })));
  store.deleteMany(ids.slice(0, 850)); // only 50 left, but numbered up to 900
  const lt = new LoadTest({ app, store, log: {} });
  t.after(() => lt.close());
  assert.equal(lt.devices, 900);
});

test('load test: Burst and Start are refused while Remove is running, and nothing comes back', async (t) => {
  const { app, store, admin } = await setup(t);
  await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { devices: 3000, interval: 3600 } });
  await admin({ method: 'POST', url: '/api/admin/loadtest/burst' });
  await until(() => app.loadTest.inflight > 50, 10000);
  const removing = app.loadTest.removeDevices(); // sets the flag straight away, then waits for in-flight check-ins
  assert.equal(app.loadTest.removing, true);
  const b = await admin({ method: 'POST', url: '/api/admin/loadtest/burst' });
  assert.equal(b.statusCode, 409, b.body);
  const s = await admin({ method: 'POST', url: '/api/admin/loadtest/start' });
  assert.equal(s.statusCode, 409, s.body);
  const r = await removing;
  assert.ok(r.deleted > 0);
  await sleep(500);
  assert.equal(sims(store).length, 0);
  assert.equal(app.loadTest.running, false);
  // Afterwards everything works again.
  assert.equal((await admin({ method: 'POST', url: '/api/admin/loadtest/burst' })).statusCode, 200);
  await until(() => sims(store).length === 3000, 20000);
});

test('load test: top processes are opt in; text only when a metric is over 85, else null', async (t) => {
  const { admin, app, store } = await setup(t);
  const { LoadTest } = await import('../src/loadtest.js');
  const lt = new LoadTest({ app, store, log: { info() {}, warn() {}, error() {} } });
  assert.equal(lt.fields(0).top_cpu, undefined);
  lt.topProcs = true;
  const healthy = lt.fields(0);
  assert.deepEqual([healthy.top_cpu, healthy.top_ram, healthy.top_disk], [null, null, null]);
  for (const key of ['high_cpu', 'high_memory', 'disk_busy']) lt.scenarios.push({ id: key, key, mode: 'count', amount: 1, set: new Set([0]) });
  const hot = lt.fields(0);
  assert.match(hot.top_cpu, /^\S+ \d+%, \S+ \d+%, \S+ \d+%$/);
  assert.match(hot.top_ram, /^\S+ [\d.]+ GB \(\d+%\), /);
  assert.match(hot.top_disk, /^\S+ [\d.]+ MB\/s, /);
  assert.equal((await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { topProcs: 'yes' } })).statusCode, 400);
  const ok = await admin({ method: 'PUT', url: '/api/admin/loadtest', payload: { topProcs: true } });
  assert.equal(ok.statusCode, 200);
  assert.equal((await admin({ url: '/api/admin/loadtest' })).j().topProcs, true);
});

test('load test: simulated devices send uptime like the agents (boot_time, uptime, uptime_h)', async (t) => {
  const { app, store } = await setup(t);
  const { LoadTest } = await import('../src/loadtest.js');
  const lt = new LoadTest({ app, store, log: { info() {}, warn() {}, error() {} } });
  const f = lt.fields(3);
  assert.match(f.uptime, /^(\d+d \d+h \d+m|\d+h \d+m|\d+m)$/);
  assert.match(f.boot_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[-+]\d{2}:\d{2}$/);
  assert.ok(Math.abs((Date.now() - Date.parse(f.boot_time)) / 36e5 - f.uptime_h) < 0.1, 'uptime_h matches boot_time');
});
