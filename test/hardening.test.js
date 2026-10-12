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

async function setup(t, db = openDb(':memory:')) {
  const config = { historyLimit: 3, maxBatch: 5000, maxFieldsPerRecord: 500, bodyLimitMb: 10, importLimitMb: 50,
    logLevel: 'silent', corsOrigin: '', cookieSecure: 'auto', trustProxy: false, oidcIssuerOverride: '',
    host: '127.0.0.1', httpsPort: 0, tlsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ci-tls-')), tlsDisable: false, tlsPollMs: 0, acmeCheckMs: 0, issuesTickMs: 0 };
  const store = new Store(db, { historyLimit: 3 });
  const accounts = new Accounts(db, { secret: crypto.randomBytes(32), sessionTtlHours: 1 });
  const app = buildApp({ config, store, accounts, oidc: new EntraOidc(accounts, {}) });
  t.after(() => app.close());
  const key = accounts.generateApiKey('t');
  const checkin = (payload) => app.inject({ method: 'POST', url: '/api/checkin', headers: { 'x-api-key': key, 'content-type': 'application/json' }, payload });
  return { app, store, db, accounts, key, checkin };
}
const nestedArray = (n) => '['.repeat(n) + ']'.repeat(n);
const nestedObject = (n) => '{"a":'.repeat(n) + '1' + '}'.repeat(n);

test('check-ins nested too deeply are refused (400), shallow nesting still works', async (t) => {
  const { checkin, store } = await setup(t);
  for (const depth of [33, 1000, 5000, 20000]) {
    let r = await checkin(`{"id":"deep-a","v":${nestedArray(depth)}}`);
    assert.equal(r.statusCode, 400, `array ${depth}: ${r.body.slice(0, 120)}`);
    assert.match(r.body, /nested too deeply/);
    r = await checkin(`{"id":"deep-o","v":${nestedObject(depth)}}`);
    assert.equal(r.statusCode, 400, `object ${depth}`);
  }
  assert.ok(!store.get('deep-a'));
  assert.ok(!store.get('deep-o'));
  // Ordinary structured values are fine, and filtering/sorting on the field works.
  const ok = await checkin(`{"id":"fine","services":{"a":{"b":[1,2,{"c":true}]}},"v":${nestedArray(30)}}`);
  assert.equal(ok.statusCode, 201, ok.body);
});

test('one over-deep payload does not fail the valid check-ins sent at the same time', async (t) => {
  const { checkin, store, app, key } = await setup(t);
  const jobs = [];
  for (let i = 0; i < 30; i++) jobs.push(checkin({ id: `ok-${i}`, cpu_pct: i }));
  jobs.splice(10, 0, checkin(`{"id":"evil","v":${nestedArray(20000)}}`));
  const res = await Promise.all(jobs);
  assert.equal(res.filter((r) => r.statusCode === 201).length, 30);
  assert.equal(res.filter((r) => r.statusCode === 400).length, 1);
  assert.equal(res.filter((r) => r.statusCode >= 500).length, 0);
  assert.ok(!store.get('evil'));
  // Bulk import and the batch endpoint refuse it too, without losing the good rows.
  const b = await app.inject({ method: 'POST', url: '/api/checkin', headers: { 'x-api-key': key, 'content-type': 'application/json' },
    payload: `[{"id":"b1"},{"id":"b2","v":${nestedArray(5000)}},{"id":"b3"}]` });
  assert.ok(b.statusCode < 500, b.body.slice(0, 200));
  assert.ok(store.get('b1') && store.get('b3'));
  assert.ok(!store.get('b2'));
});

test('a malformed stored row cannot stop the server from starting or break filtering', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ci-db-')), 'x.sqlite');
  const db = openDb(file);
  const first = await setup(t, db);
  assert.equal((await first.checkin({ id: 'good', host: 'h' })).statusCode, 201);
  first.store.flush();
  // Simulate a row written by an older version that stored something SQLite's JSON functions reject.
  db.prepare("INSERT INTO records (id, created, modified, version, rev, data) VALUES ('bad', 'x', 'x', 1, 1, ?)").run('{"v":' + '['.repeat(1500) + ']'.repeat(1500) + '}');
  const again = new Store(db, { historyLimit: 3 }); // used to throw "malformed JSON" here
  assert.ok(again.get('good'));
});

test('install.sh: the url override can only be a plain address', async (t) => {
  const { app } = await setup(t);
  const bad = ['http://a$({touch,pwned}).example.com', 'http://a`id`.example.com', 'http://a;b.example.com', 'http://a&b.example.com',
    "http://a'b.example.com", 'http://a"b.example.com', 'http://user:pw@example.com', 'http://a{b}.example.com', 'http://a(b).example.com'];
  for (const url of bad) {
    for (const route of ['/install.sh', '/install.ps1']) {
      const r = await app.inject({ method: 'GET', url: `${route}?url=${encodeURIComponent(url)}` });
      assert.equal(r.statusCode, 400, `${route} ${url} -> ${r.statusCode}`);
      assert.ok(!/pwned|\$\(|`id`/.test(r.body), 'nothing from the url is echoed');
    }
  }
  for (const url of ['https://checkin.example.com', 'http://10.0.0.5:3000', 'https://[::1]:8443', 'https://xn--bcher-kva.example.com']) {
    const r = await app.inject({ method: 'GET', url: `/install.sh?url=${encodeURIComponent(url)}` });
    assert.equal(r.statusCode, 200, url);
    assert.ok(r.body.includes(`SERVER="\${CHECKIN_URL:-${new URL(url).origin}}"`));
  }
  const r = await app.inject({ method: 'GET', url: '/install.sh?url=' + encodeURIComponent('https://bücher.example.com') });
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.includes('xn--bcher-kva.example.com'));
});

test('graph: the axis never loops over a huge value (static check of chart.js)', () => {
  const js = fs.readFileSync(new URL('../public/chart.js', import.meta.url), 'utf8');
  assert.match(js, /if \(vmax \/ step > 8\)/);
  assert.match(js, /for \(let v = 0; v <= vmax; v \+= step\)/);
  assert.ok(!/v <= vmax; v \+= 25/.test(js));
});

// ---- login length limits ----------------------------------------------------------------
test('login: oversized or non-text usernames and passwords are refused cheaply', async (t) => {
  const { app, accounts } = await setup(t);
  await accounts.create({ username: 'ann', password: 'ann-password-1', role: 'admin' });
  const login = (payload, headers = {}) => app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json', ...headers }, payload });
  // A 4 MB username is stopped by the body limit before it is parsed, let alone stored as a limiter key.
  const huge = await login(JSON.stringify({ username: 'x'.repeat(4 * 1024 * 1024), password: 'p' }));
  assert.equal(huge.statusCode, 413);
  assert.equal((await login({ username: 'x'.repeat(129), password: 'password-123' })).statusCode, 400);
  assert.equal((await login({ username: 'ann', password: 'p'.repeat(257) })).statusCode, 400);
  assert.equal((await login({ username: ['ann'], password: 'ann-password-1' })).statusCode, 400);
  assert.equal((await login({ username: 'ann', password: ['ann-password-1'] })).statusCode, 400);
  assert.equal((await login({ username: 'ann' })).statusCode, 400);
  assert.equal((await login({ username: 'ann', password: 'wrong-password-1' })).statusCode, 401);
  assert.equal((await login({ username: 'x'.repeat(128), password: 'password-123' })).statusCode, 401, 'the longest allowed name is just a wrong name');
  assert.equal((await login({ username: 'ann', password: 'ann-password-1' })).statusCode, 200);
  // The same limits apply to Basic auth, without hashing anything.
  const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
  assert.equal((await app.inject({ method: 'GET', url: '/api/records', headers: { authorization: basic('y'.repeat(5000), 'pw') } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/records', headers: { authorization: basic('ann', 'ann-password-1') } })).statusCode, 200);
});

// ---- device id length ---------------------------------------------------------------------
test('device ids are at most 64 characters', async (t) => {
  const { checkin, app, store, key } = await setup(t);
  assert.equal((await checkin({ id: 'a'.repeat(64) })).statusCode, 201);
  const r = await checkin({ id: 'a'.repeat(65) });
  assert.equal(r.statusCode, 400);
  assert.match(r.body, /too long \(max 64\)/);
  assert.ok(!store.get('a'.repeat(65)));
  const csv = `id,cpu\n${'b'.repeat(65)},1\nshort,2\n`;
  const imp = await app.inject({ method: 'POST', url: '/api/import', headers: { 'x-api-key': key, 'content-type': 'text/csv' }, payload: csv });
  assert.equal(imp.statusCode, 200, imp.body);
  assert.equal(JSON.parse(imp.body).failed, 1);
  assert.ok(store.get('short'));
  // Every record can be opened and deleted one by one (the id fits in the URL).
  const id = 'c'.repeat(64);
  await checkin({ id, x: 1 });
  store.flush();
  assert.equal(store.get(id).id, id);
});

// ---- HTTPS redirect ------------------------------------------------------------------------
test('HTTPS redirect only ever points at a plain host name', async (t) => {
  const { app } = await setup(t);
  const tls = app.tls;
  Object.defineProperty(tls, 'mode', { get: () => 'redirect' });
  Object.defineProperty(tls, 'listening', { get: () => true });
  Object.defineProperty(tls, 'publicPort', { get: () => 8443 });
  const req = (host, url = '/x') => ({ url, hostname: host, headers: { host }, protocol: 'http' });
  assert.equal(tls.redirectTarget(req('checkin.example.com')), 'https://checkin.example.com:8443/x');
  assert.equal(tls.redirectTarget(req('checkin.example.com:3000', '/a?b=1')), 'https://checkin.example.com:8443/a?b=1');
  assert.equal(tls.redirectTarget(req('10.0.0.5:80')), 'https://10.0.0.5:8443/x');
  assert.equal(tls.redirectTarget(req('[::1]:3000')), 'https://[::1]:8443/x');
  assert.equal(tls.redirectTarget(req('my_box')), 'https://my_box:8443/x');
  for (const evil of ['a@evil.com:80', 'evil.com/@x', 'evil.com\\@x', 'a b', 'evil.com#', 'evil.com?', '', 'x'.repeat(300)]) {
    assert.equal(tls.redirectTarget(req(evil)), false, JSON.stringify(evil));
  }
  assert.equal(tls.redirectTarget(req('anything', '/health')), null);
  // And through the real request path: a bad Host gets a 400, never a Location header.
  const r = await app.inject({ method: 'GET', url: '/x', headers: { host: 'a@evil.com:80' } });
  assert.equal(r.statusCode, 400);
  assert.ok(!r.headers.location);
  const ok = await app.inject({ method: 'GET', url: '/x', headers: { host: 'good.example.com' } });
  assert.equal(ok.statusCode, 307);
  assert.equal(ok.headers.location, 'https://good.example.com:8443/x');
});

// ---- Content-Security-Policy ---------------------------------------------------------------
test('Content-Security-Policy is sent, and no page needs inline scripts', async (t) => {
  const { app, key } = await setup(t);
  for (const url of ['/login', '/api/auth/status', '/styles.css', '/theme-init.js']) {
    const r = await app.inject({ method: 'GET', url });
    const csp = r.headers['content-security-policy'];
    assert.ok(csp, `${url} has a CSP`);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /base-uri 'self'/);
    assert.ok(!/script-src[^;]*unsafe/.test(csp), 'no unsafe scripts');
  }
  assert.ok((await app.inject({ method: 'GET', url: '/api/records', headers: { 'x-api-key': key } })).headers['content-security-policy']);
  for (const f of fs.readdirSync(new URL('../public/', import.meta.url)).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(new URL('../public/' + f, import.meta.url), 'utf8');
    for (const m of html.matchAll(/<script\b([^>]*)>/g)) assert.match(m[1], /\bsrc=/, `${f}: inline <script>`);
    assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html), `${f}: inline event handler`);
    assert.ok(!/javascript:/i.test(html), `${f}: javascript: url`);
  }
  const js = fs.readdirSync(new URL('../public/', import.meta.url)).filter((x) => x.endsWith('.js'));
  for (const f of js) {
    const src = fs.readFileSync(new URL('../public/' + f, import.meta.url), 'utf8');
    assert.ok(!/\beval\(|new Function\(|\son(click|change|input|error|load)=\\?["']|javascript:/.test(src), `${f}: needs unsafe-inline/eval`);
  }
});

// ---- Windows scripts must be plain ASCII ---------------------------------------------------
// Windows PowerShell 5.1 reads a file without a byte-order mark as ANSI, so a character such as an arrow
// (UTF-8 bytes E2 86 92) turns into "â†'" whose last byte is a smart quote that ends a string early and
// breaks the whole script. Keep everything we serve or tell people to run on Windows to ASCII.
test('Windows PowerShell scripts and the installer contain only ASCII', async (t) => {
  const { app } = await setup(t);
  const bad = (name, text) => { const m = /[^\x00-\x7F]/.exec(text); return m ? `${name}: U+${m[0].codePointAt(0).toString(16)} near "${text.slice(Math.max(0, m.index - 30), m.index + 10).replace(/\n/g, ' ')}"` : null; };
  const found = [];
  for (const f of fs.readdirSync(new URL('../scripts/', import.meta.url)).filter((x) => x.endsWith('.ps1'))) {
    found.push(bad('scripts/' + f, fs.readFileSync(new URL('../scripts/' + f, import.meta.url), 'utf8')));
  }
  for (const url of ['/install.ps1', '/install.ps1?ports=3389&extra=site%3DDallas&fields=all', '/agent/checkin-agent.ps1', '/install.sh', '/agent/checkin-agent.sh']) {
    const r = await app.inject({ url, headers: { host: 'checkin.example.com' } });
    assert.equal(r.statusCode, 200, url);
    found.push(bad(url, r.body));
  }
  assert.deepEqual(found.filter(Boolean), []);
});

// ---- views remember which fields they have seen -------------------------------------------
test('saved views: `known` fields are kept, and views saved before it get the current fields once', async (t) => {
  const { app, store, db, accounts } = await setup(t);
  await accounts.create({ username: 'vic', password: 'vic-password-1', role: 'power' });
  const as = (u) => async (opts) => {
    const r = await app.inject({ ...opts, headers: { authorization: 'Basic ' + Buffer.from(`${u}:${u}-password-1`).toString('base64'), ...(opts.headers || {}) } });
    return Object.assign(r, { j: () => JSON.parse(r.body) });
  };
  const vic = as('vic');
  // The API keeps `known` (and a long hidden list) as sent.
  const saved = await vic({ method: 'POST', url: '/api/views', payload: { scope: 'personal', name: 'with-known', state: { hidden: ['b'], known: ['a', 'b', 'c'] } } });
  assert.ok([200, 201].includes(saved.statusCode), saved.body);
  assert.deepEqual(saved.j().view.state.known, ['a', 'b', 'c']);
  assert.deepEqual(saved.j().view.state.hidden, ['b']);
  const bad = await vic({ method: 'POST', url: '/api/views', payload: { scope: 'personal', name: 'junk', state: { known: 'nope', hidden: [1, { x: 1 }, 'ok'] } } });
  assert.deepEqual(bad.j().view.state.known, []);
  assert.deepEqual(bad.j().view.state.hidden, ['1', 'ok']);
  // An older view (no `known`) is stamped with the fields that exist when the server starts; others are left alone.
  const now = new Date().toISOString();
  db.prepare("INSERT INTO views (scope, owner_id, name, state, created, updated, updated_by) VALUES ('team', NULL, 'old', ?, ?, ?, '')").run(JSON.stringify({ hidden: ['b'] }), now, now);
  await store.upsert({ id: 'd1', cpu: 1, ram: 2 });
  store.flush();
  const { SavedViews } = await import('../src/views.js');
  const sv = new SavedViews(db);
  sv.stampKnown(store.fieldCounts.keys());
  const list = (await vic({ url: '/api/views' })).j();
  const old = list.team.find((v) => v.name === 'old');
  assert.deepEqual([...old.state.known].sort(), ['cpu', 'ram']);
  assert.deepEqual(old.state.hidden, ['b'], 'what it hid is unchanged');
  assert.deepEqual(list.personal.find((v) => v.name === 'with-known').state.known, ['a', 'b', 'c'], 'already had a list: untouched');
  sv.stampKnown(['new1', 'new2']); // a second start must not stamp again
  assert.deepEqual([...(await vic({ url: '/api/views' })).j().team.find((v) => v.name === 'old').state.known].sort(), ['cpu', 'ram']);
});

test('the built-in Default View lists the agreed columns', () => {
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const m = /const DEFAULT_COLS = \[([^\]]*)\];/.exec(js);
  assert.ok(m, 'DEFAULT_COLS is defined');
  assert.deepEqual(m[1].split(',').map((x) => x.trim().replace(/'/g, '')), ['os', 'cpu_pct', 'ram_pct', 'disk_busy_pct', 'disk_pct', 'uptime']);
  assert.match(js, /v\.order = \[STATUS_KEY, \.\.\.DEFAULT_COLS\.filter\(\(f\) => S\.fieldCounts\.has\(f\)\), 'modified', 'created'\];/);
});

test('settings: one Settings panel; Pause moved off the top bar; admin tabs readable (not editable) by power users', async (t) => {
  const read = (f) => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
  const html = read('index.html');
  for (const gone of ['liveToggle', 'adminItem', 'pwItem', 'mPause', 'm-pause']) {
    assert.ok(!html.includes(gone) && !read('app.js').includes(gone), `${gone} should be gone`);
  }
  assert.match(html, /aria-label="Settings"/);
  assert.ok(!html.includes('id="clearBtn"') && !read('issues.html').includes('id="clearBtn"'), 'Clear buttons live in Settings > Reset');
  assert.match(html, /data-tab="reset"/);
  // Page tabs replace the Issues button; Import/Export live in the account menu (not the header); Load test is in Settings.
  assert.match(html, /<nav class="top-tabs" id="topTabs"/);
  assert.ok(!html.includes('id="issuesBtn"') && !html.includes('id="importBtn"') && !html.includes('id="exportBtn"'));
  assert.match(html, /data-act="m-import"/);
  assert.match(html, /data-act="m-export-history"/);
  assert.match(html, /data-tab="loadtest"/);
  assert.ok(!/data-act="(issues|loadtest)"/.test(html));
  assert.match(read('issues.html'), /class="top-tabs"/);
  assert.ok(!read('issues.html').includes('id="exportWrap"'));
  for (const tabName of ['prefs', 'checkins', 'users', 'sso', 'apikey', 'ports', 'issues', 'tls']) assert.match(html, new RegExp(`data-tab="${tabName}"`));
  // Admin tabs are shown to power users and above only; the panel no longer requires the users capability to open.
  assert.match(html, /data-min="settingsView"/);
  assert.ok(!/if \(!UI\.can\('users'\)\) return;/.test(read('admin.js')));
  // The account menu: Settings and Sign out, no Admin / Change password entries; the other pages link to ?open=settings.
  const um = read('usermenu.js');
  assert.match(um, /\?open=settings/);
  assert.ok(!/Admin|Change password/.test(um));
  assert.ok(read('admin.js').includes('class="ro-banner"'));
  // Server: power can read the admin settings, user and reader cannot, and nobody below admin can change them.
  const { app, accounts } = await setup(t);
  const ses = async (role) => {
    await accounts.create({ username: role, password: `${role}-password-1`, role });
    const authorization = 'Basic ' + Buffer.from(`${role}:${role}-password-1`).toString('base64');
    return (o) => app.inject({ ...o, headers: { authorization, ...(o.headers || {}) } });
  };
  const power = await ses('power');
  const user = await ses('user');
  const reader = await ses('reader');
  for (const url of ['/api/admin/users', '/api/admin/sso', '/api/admin/tls', '/api/admin/portcheck', '/api/admin/apikey']) {
    assert.equal((await power({ url })).statusCode, 200, `power reads ${url}`);
    assert.equal((await user({ url })).statusCode, 403, `user blocked ${url}`);
    assert.equal((await reader({ url })).statusCode, 403, `reader blocked ${url}`);
  }
  assert.equal((await power({ method: 'PUT', url: '/api/admin/portcheck', payload: { enabled: false } })).statusCode, 403);
});

test('dashboard: a failed first load retries by itself instead of leaving the table empty', () => {
  const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="loadBanner"/);
  assert.match(js, /async function ensureLoaded\(\)/);
  assert.match(js, /retryTimer = setTimeout\(ensureLoaded, retryDelay\)/);   // backs off and tries again
  assert.match(js, /if \(!S\.loaded\) ensureLoaded\(\)/);                      // when the live connection comes up
  assert.match(js, /if \(!S\.loaded\) \{ markLoaded\(\)/);                     // or when a live update brings everything
  assert.ok(!js.includes("toast('Could not load records: '"), 'no vanishing toast for this error');
  assert.match(js, /if \(S\.loaded \|\| loadingAll\) return;/);               // never a second parallel download
});

test('issues page: every visit opens on Open, whatever status filter was used last time', () => {
  const js = fs.readFileSync(new URL('../public/issues.js', import.meta.url), 'utf8');
  assert.match(js, /status: 'open', q: ''/);
  assert.ok(!js.includes("local.get('issues.status'") && !js.includes("local.set('issues.status'"), 'the status filter is no longer saved');
});
