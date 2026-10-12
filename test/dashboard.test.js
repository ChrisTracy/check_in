// Regression tests for the dashboard data APIs: built-in property names as fields, CSV round
// trips, record filters and search, import errors and reserved view names.
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
import { testBox } from '../src/boxes.js';
import { parseCsv } from '../src/csv.js';

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

async function setup(overrides = {}) {
  const config = { historyLimit: 3, maxBatch: 5000, maxFieldsPerRecord: 500, bodyLimitMb: 10, importLimitMb: 50,
    logLevel: 'silent', corsOrigin: '', cookieSecure: 'auto', trustProxy: false, oidcIssuerOverride: '',
    host: '127.0.0.1', httpsPort: 0, tlsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ci-tls-')), tlsDisable: false, tlsPollMs: 0, acmeCheckMs: 0, ...overrides };
  const db = openDb(':memory:');
  const store = new Store(db, { historyLimit: config.historyLimit, maxBatch: config.maxBatch });
  const accounts = new Accounts(db, { secret: crypto.randomBytes(32), sessionTtlHours: 1 });
  const oidc = new EntraOidc(accounts, {});
  const app = buildApp({ config, store, accounts, oidc });
  await accounts.create({ username: 'admin', password: 'adminpass123', role: 'admin' });
  const key = accounts.generateApiKey('test');
  const call = (opts) => app.inject({ ...opts, headers: { 'x-api-key': key, ...(opts.headers || {}) } });
  const admin = (opts) => app.inject({ ...opts, headers: { authorization: basic('admin', 'adminpass123'), ...(opts.headers || {}) } });
  return { app, store, call, admin };
}
const csv = { 'content-type': 'text/csv' };
const BUILTINS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'];

test('built-in object property names: never exported as native code, real values kept', async () => {
  const { call, admin } = await setup();
  await call({ method: 'POST', url: '/api/checkin', payload: [{ id: 'a', site: 'x' }, { id: 'b', constructor: 'real-ctor', toString: 7 }] });
  // Columns that the record doesn't have are empty, whatever their name.
  let r = await call({ url: '/api/export.csv?fields=id,' + BUILTINS.join(',') });
  assert.equal(r.statusCode, 200);
  assert.doesNotMatch(r.body, /native code|function/);
  const rows = parseCsv(r.body);
  assert.deepEqual(rows.find((x) => x.id === 'a'), { id: 'a', constructor: '', toString: '', valueOf: '', hasOwnProperty: '' });
  assert.equal(rows.find((x) => x.id === 'b').constructor, 'real-ctor');
  assert.equal(rows.find((x) => x.id === 'b').toString, '7');

  // Full export, then import it back: no new fields, no changes.
  r = await call({ url: '/api/export.csv' });
  assert.doesNotMatch(r.body, /native code/);
  const fieldsBefore = (await call({ url: '/api/fields' })).json().fields;
  r = await call({ method: 'POST', url: '/api/import', payload: (await call({ url: '/api/export.csv?fields=id,site,' + BUILTINS.join(',') })).body, headers: csv });
  assert.equal(r.json().failed, 0);
  assert.deepEqual((await call({ url: '/api/fields' })).json().fields, fieldsBefore);
  const a = (await call({ url: '/api/records/a/history' })).json();
  assert.deepEqual(a.history[0].changes, {});
  assert.equal(Object.hasOwn(a.record, 'constructor'), false);
  const b = (await call({ url: '/api/records/b' })).json();
  assert.equal(b.constructor, 'real-ctor');
  assert.equal(b.toString, 7);

  // History export reads the snapshot's own fields only.
  r = await call({ url: '/api/history/export.csv' });
  assert.doesNotMatch(r.body, /native code/);

  // Status boxes: a box on "constructor" counts only records that really have the field, both on
  // check-in and when the box is created (history backfill), so the two agree.
  r = await admin({ method: 'PUT', url: '/api/boxes', payload: { boxes: [{ name: 'Has ctor', field: 'constructor', op: 'nempty', minutes: 0 }] } });
  assert.equal(r.statusCode, 200);
  const boxId = r.json().boxes[0].id;
  const inBox = async (id) => Boolean((await call({ url: `/api/records/${id}` })).json()._boxes?.[boxId]);
  assert.equal(await inBox('a'), false);
  assert.equal(await inBox('b'), true);
  await call({ method: 'POST', url: '/api/checkin', payload: { id: 'a', site: 'y' } });
  assert.equal(await inBox('a'), false);
  for (const f of BUILTINS) assert.equal(testBox({ field: f, op: 'empty', value: '' }, { id: 'z' }), true, f);
  assert.equal(testBox({ field: 'toString', op: 'eq', value: '7' }, { id: 'z', toString: 7 }), true);
});

test('CSV round trip keeps header names and value types', async () => {
  const { call } = await setup();
  const rec = { id: 'dev-1', '@user': 'ann', '-flag': 'on', '+plus': 1, '=calc': 'x', '42': 'num name', true: 'yes',
    n: 42, neg: -3.5, big: 1e21, on: true, off: false, obj: { a: [1, 2] }, arr: ['x'], s_num: '42', s_bool: 'true',
    s_json: '{"a":1}', zip: '007', formula: '=SUM(A1)', dash: '-5', apos: "'quoted", text: 'plain, "with" comma',
    multi: 'line 1\nline 2' };
  await call({ method: 'POST', url: '/api/checkin', payload: rec });
  const before = (await call({ url: '/api/records/dev-1' })).json();
  const exported = (await call({ url: '/api/export.csv' })).body;
  const r = await call({ method: 'POST', url: '/api/import', payload: exported, headers: csv });
  assert.deepEqual([r.json().failed, r.json().updated], [0, 1]);
  const after = (await call({ url: '/api/records/dev-1/history' })).json();
  // Text that only LOOKS like a number / boolean / JSON is exported plainly (so spreadsheets
  // see numbers) and comes back typed; everything else round-trips exactly.
  const retyped = { s_num: 42, s_bool: true, s_json: { a: 1 }, dash: -5 };
  assert.deepEqual(Object.keys(after.history[0].changes).sort(), Object.keys(retyped).sort());
  for (const [k, v] of Object.entries(rec)) assert.deepEqual(after.record[k], k in retyped ? retyped[k] : v, k);
  assert.equal(after.record._version, before._version + 1);
  assert.deepEqual((await call({ url: '/api/fields' })).json().fields.map((f) => f.name).sort(), Object.keys(rec).filter((k) => k !== 'id').sort());
  // Spreadsheet safety is kept: formula-like text and headers start with an apostrophe; numbers
  // and numeric-looking text don't (no "'42" in Excel).
  const header = exported.split('\r\n')[0].split(',');
  assert.ok(header.includes("'@user") && header.includes("'=calc") && header.includes('42'));
  assert.match(exported, /,'=SUM\(A1\),/);
  assert.doesNotMatch(exported, /'42|'-5|'true/);
  // A second round trip is now exact.
  await call({ method: 'POST', url: '/api/import', payload: (await call({ url: '/api/export.csv' })).body, headers: csv });
  assert.deepEqual((await call({ url: '/api/records/dev-1/history' })).json().history[0].changes, {});
});

test('CSV import: typed cells, duplicate headers rejected, error rows are file lines', async () => {
  const { call } = await setup();
  let r = await call({ method: 'POST', url: '/api/import', payload: 'id,n,b,s,city,f\nx,5,true,\'5,\'s-Hertogenbosch,\'=1+1\n', headers: csv });
  assert.equal(r.json().created, 1);
  const x = (await call({ url: '/api/records/x' })).json();
  assert.deepEqual([x.n, x.b, x.s, x.city, x.f], [5, true, "'5", "'s-Hertogenbosch", '=1+1'], 'only a guard apostrophe is removed');
  // id column not first, with a short first row; JSON- or number-looking ids stay text.
  r = await call({ method: 'POST', url: '/api/import', payload: 'name,site,id\nx,y\na,b,c\n', headers: csv });
  assert.equal(r.statusCode, 200, r.body);
  r = await call({ method: 'POST', url: '/api/import', payload: 'id,a\n[1],1\n"{""a"":1}",2\n10023,3\n', headers: csv });
  assert.deepEqual([r.json().imported, r.json().failed], [3, 0], r.body);
  assert.equal((await call({ url: '/api/records/%5B1%5D' })).json().a, 1);
  assert.equal((await call({ url: '/api/records/10023' })).json().id, '10023');

  for (const head of ['id,a,a', 'id,site,ID', "id,@u,'@u"]) {
    r = await call({ method: 'POST', url: '/api/import', payload: head + '\n1,2,3\n', headers: csv });
    assert.equal(r.statusCode, 400, head);
    assert.match(r.json().error, /Duplicate column/);
  }

  // Row 2 has a cell over three lines, so the bad row (missing id) starts on line 5.
  r = await call({ method: 'POST', url: '/api/import', payload: 'id,note\r\nok1,"a\r\nb\r\nc"\r\n,missing id\r\nok2,fine\r\n\r\n,also missing\r\n', headers: csv });
  assert.equal(r.json().imported, 2);
  assert.deepEqual(r.json().errors.map((e) => e.row), [5, 8]);
  r = await call({ method: 'POST', url: '/api/import', payload: 'id,note\nok3,"x\ny"\n,bad\n', headers: csv });
  assert.deepEqual(r.json().errors.map((e) => e.row), [4]);
});

test('record filters: booleans match true/false, created/modified are exact', async () => {
  const { call } = await setup();
  for (const p of [{ id: 'a', online: true, n: 1 }, { id: 'b', online: false, n: 2 }, { id: 'c', online: 'true', n: 1.5 }, { id: 'd' }]) {
    await call({ method: 'POST', url: '/api/checkin', payload: p });
    await new Promise((r) => setTimeout(r, 3)); // distinct created/modified times
  }
  const ids = async (qs) => (await call({ url: '/api/records?sort=id&' + qs })).json().records.map((r) => r.id);
  assert.deepEqual(await ids('f.online=true'), ['a', 'c']);
  assert.deepEqual(await ids('f.online=false'), ['b']);
  assert.deepEqual(await ids('f.online=1'), []);
  assert.deepEqual(await ids('f.n=1.5'), ['c']);
  const b = (await call({ url: '/api/records/b' })).json();
  assert.deepEqual(await ids('f.modified=' + encodeURIComponent(b.modified)), ['b']);
  assert.deepEqual(await ids('f.created=' + encodeURIComponent(b.created)), ['b']);
  assert.deepEqual(await ids('f.created=2000-01-01'), []);
});

test('search looks at values only, unescaped; invalid limit is rejected', async () => {
  const { call } = await setup();
  await call({ method: 'POST', url: '/api/checkin', payload: [
    { id: 'a', site: 'Dallas', quote: 'say "hi"' }, { id: 'b', path: 'C:\\Windows\\System32' },
    { id: 'c', online: true, cpu: 42.5, tags: ['red', 'blue'] }, { id: 'd', café: 'Über' }] });
  const ids = async (q) => (await call({ url: '/api/records?sort=id&q=' + encodeURIComponent(q) })).json().records.map((r) => r.id);
  assert.deepEqual(await ids('site'), [], 'field names are not searched');
  assert.deepEqual(await ids('dallas'), ['a']);
  assert.deepEqual(await ids('"hi"'), ['a']);
  assert.deepEqual(await ids('C:\\Windows'), ['b']);
  assert.deepEqual(await ids('\\System32'), ['b']);
  assert.deepEqual(await ids('true'), ['c']);
  assert.deepEqual(await ids('42.5'), ['c']);
  assert.deepEqual(await ids('blue'), ['c']);
  assert.deepEqual(await ids('Über'), ['d']);
  assert.deepEqual(await ids('b'), ['b', 'c', 'd'], 'id b, the value "blue" and "Über"');
  assert.deepEqual(await ids('50%'), []);

  for (const bad of ['-1', 'abc', '1.5']) {
    const r = await call({ url: '/api/records?limit=' + bad });
    assert.equal(r.statusCode, 400, bad);
    assert.match(r.json().error, /limit/);
  }
  assert.equal((await call({ url: '/api/records?offset=-2' })).statusCode, 400);
  assert.equal((await call({ url: '/api/records?limit=0' })).json().records.length, 0);
  assert.deepEqual((await call({ url: '/api/records?sort=id&limit=2&offset=1' })).json().records.map((r) => r.id), ['b', 'c']);
  assert.deepEqual((await call({ url: '/api/records?sort=id&offset=3' })).json().records.map((r) => r.id), ['d']);
  assert.equal((await call({ url: '/api/records?limit=' })).json().records.length, 4);
});

test('fields starting with "_" are stored and listed; reserved ones cannot be set', async () => {
  const { call } = await setup();
  await call({ method: 'POST', url: '/api/checkin', payload: { id: 'a', _owner: 'ops', _version: 99, _boxes: 'x', _rev: 1 } });
  const rec = (await call({ url: '/api/records/a' })).json();
  assert.equal(rec._owner, 'ops');
  assert.equal(rec._version, 1);
  assert.deepEqual((await call({ url: '/api/fields' })).json().fields.map((f) => f.name), ['_owner']);
  assert.deepEqual((await call({ url: '/api/records?f._owner=ops' })).json().records.map((r) => r.id), ['a']);
});

test('a saved view cannot be called "Default View"', async () => {
  const { admin } = await setup();
  for (const name of ['Default View', 'default view', 'DEFAULT', ' Default   View ']) {
    const r = await admin({ method: 'POST', url: '/api/views', payload: { scope: 'personal', name, state: {} } });
    assert.equal(r.statusCode, 400, name);
    assert.match(r.json().error, /reserved/);
  }
  assert.equal((await admin({ method: 'POST', url: '/api/views', payload: { scope: 'personal', name: 'Default View 2', state: {} } })).statusCode, 201);
});
