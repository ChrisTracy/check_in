// End-to-end ACME tests against Pebble, Let's Encrypt's test CA (https://github.com/letsencrypt/pebble).
// Skipped unless PEBBLE_DIR points at a pebble checkout with the binaries built into $PEBBLE_DIR/bin:
//
//   git clone https://github.com/letsencrypt/pebble && cd pebble
//   go build -o bin/pebble ./cmd/pebble && go build -o bin/pebble-challtestsrv ./cmd/pebble-challtestsrv
//   PEBBLE_DIR=$PWD npm test        (from the check_in folder)
//
// It runs pebble-challtestsrv as DNS (every name → 127.0.0.1) and three Pebble CAs: a normal one,
// one that requires External Account Binding, and one issuing 2-hour certificates (always due for
// renewal), and points HTTP-01 validation at this app's HTTP port.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import { spawn } from 'node:child_process';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Accounts } from '../src/auth/accounts.js';
import { EntraOidc } from '../src/auth/oidc.js';
import { buildApp } from '../src/app.js';

const DIR = process.env.PEBBLE_DIR;
const skip = !DIR && 'set PEBBLE_DIR to run the ACME tests against Pebble';
const APP_PORT = 5402;
const EAB = { kid: 'kid-1', hmac: 'zWNDZM6eQGHWpSRTPal5eIUYFTu7EajVIoguysqZ9wG44nMEtx3MUAsUDkMTQ12W' };
const CAS = {
  normal: { port: 14000, mgmt: 15000, extra: {} },
  eab: { port: 14001, mgmt: 15001, extra: { externalAccountBindingRequired: true, externalAccountMACKeys: { [EAB.kid]: EAB.hmac } } },
  short: { port: 14002, mgmt: 15002, extra: {}, validity: 7200 },
};
const procs = [];
let app;
let admin;
let tmp;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(url, opts = {}) {
  for (let i = 0; i < 100; i++) {
    try { await fetchText(url, opts); return; } catch { await sleep(100); }
  }
  throw new Error(`${url} did not come up`);
}
function fetchText(url, { ca, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : require_http();
    const req = lib.request(u, { method, ca, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve({ status: res.statusCode, body: t }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
let httpMod;
function require_http() { return httpMod; }

function served(port, servername) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port, servername, rejectUnauthorized: false }, () => { const c = s.getPeerCertificate(); s.end(); resolve(c); });
    s.on('error', reject);
  });
}

before(async () => {
  if (skip) return;
  httpMod = await import('node:http');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-acme-'));
  const bin = path.join(DIR, 'bin');
  const env = { ...process.env, PEBBLE_VA_NOSLEEP: '1', PEBBLE_WFE_NONCEREJECT: '0', PEBBLE_AUTHZREUSE: '0' };
  const run = (cmd, args) => {
    const p = spawn(path.join(bin, cmd), args, { cwd: DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.log = () => out;
    procs.push(p);
    return p;
  };
  run('pebble-challtestsrv', ['-defaultIPv6', '', '-defaultIPv4', '127.0.0.1', '-dnsserver', '127.0.0.1:8053', '-management', '127.0.0.1:8055', '-http01', '', '-https01', '', '-tlsalpn01', '', '-doh', '']);
  for (const [name, c] of Object.entries(CAS)) {
    const cfg = { pebble: {
      listenAddress: `127.0.0.1:${c.port}`, managementListenAddress: `127.0.0.1:${c.mgmt}`,
      certificate: 'test/certs/localhost/cert.pem', privateKey: 'test/certs/localhost/key.pem',
      httpPort: APP_PORT, tlsPort: 5401, ocspResponderURL: '', externalAccountBindingRequired: false,
      profiles: { default: { description: 'test', validityPeriod: c.validity || 7776000 } }, ...c.extra,
    } };
    const file = path.join(tmp, `pebble-${name}.json`);
    fs.writeFileSync(file, JSON.stringify(cfg));
    run('pebble', ['-config', file, '-dnsserver', '127.0.0.1:8053']);
  }
  const ca = fs.readFileSync(path.join(DIR, 'test/certs/pebble.minica.pem'));
  for (const c of Object.values(CAS)) await waitFor(`https://localhost:${c.port}/dir`, { ca });
  await waitFor('http://127.0.0.1:8055/');

  const config = { historyLimit: 3, maxBatch: 5000, maxFieldsPerRecord: 500, bodyLimitMb: 10, importLimitMb: 50,
    logLevel: 'silent', corsOrigin: '', cookieSecure: 'auto', trustProxy: true, oidcIssuerOverride: '',
    host: '127.0.0.1', httpsPort: 0, tlsDir: path.join(tmp, 'tls'), tlsDisable: false, tlsPollMs: 0, acmeCheckMs: 0 };
  const db = openDb(':memory:');
  const accounts = new Accounts(db, { secret: crypto.randomBytes(32), sessionTtlHours: 1 });
  app = buildApp({ config, store: new Store(db, { historyLimit: 3 }), accounts, oidc: new EntraOidc(accounts, {}) });
  await accounts.create({ username: 'admin', password: 'adminpass123', role: 'admin' });
  // Trust Pebble's TLS certificate for the ACME API (the equivalent of NODE_EXTRA_CA_CERTS).
  app.acme.loadClient = async () => {
    const acme = (await import('acme-client')).default;
    acme.axios.defaults.httpsAgent = new https.Agent({ ca });
    return acme;
  };
  await app.listen({ port: APP_PORT, host: '127.0.0.1' });
  await app.tls.apply();
  const auth = 'Basic ' + Buffer.from('admin:adminpass123').toString('base64');
  admin = (o) => app.inject({ ...o, headers: { authorization: auth, 'x-forwarded-proto': 'https', ...(o.headers || {}) } });
});

after(async () => {
  if (app) await app.close();
  for (const p of procs) p.kill();
});

const dir = (ca) => `https://localhost:${CAS[ca].port}/dir`;
const setAcme = (payload) => admin({ method: 'PUT', url: '/api/admin/tls/acme', payload });
const obtain = () => admin({ method: 'POST', url: '/api/admin/tls/acme/obtain' });

test('ACME HTTP-01: issue, install, serve over HTTPS, renew in "HTTPS only" mode', { skip, timeout: 120_000 }, async () => {
  let r = await setAcme({ enabled: true, agreeTos: true, ca: 'custom', directoryUrl: dir('normal'), domains: 'checkin.example.test, www.example.test', email: 'it@example.test' });
  assert.equal(r.statusCode, 200, r.body);
  r = await obtain();
  assert.equal(r.statusCode, 200, r.body);
  const first = r.json().installed;
  assert.equal(first.subject, 'checkin.example.test');
  assert.deepEqual(first.names.sort(), ['checkin.example.test', 'www.example.test']);
  assert.match(first.issuer, /Pebble/);
  assert.equal(first.keyType, 'ec');
  let st = (await admin({ url: '/api/admin/tls' })).json();
  assert.equal(st.source, 'acme');
  assert.equal(st.events[0].action, 'acme');
  assert.equal(st.events[0].ok, true);
  let acme = (await admin({ url: '/api/admin/tls/acme' })).json();
  assert.ok(acme.lastSuccess && !acme.lastError && acme.account);
  // 90-day certificate: renewal planned 30 days before expiry; nothing due now.
  assert.ok(Math.abs(Date.parse(acme.renewAt) - (Date.parse(first.validTo) - 30 * 86400e3)) < 5 * 60e3);
  assert.equal(app.acme.due(), false);
  assert.equal(await app.acme.tick(), null);
  assert.equal(app.acme.challenges.size, 0); // tokens removed afterwards

  // Serve it, switch to "HTTPS only" (HTTP redirects), and get a new one: the challenge path stays on HTTP.
  r = await admin({ method: 'PUT', url: '/api/admin/tls', payload: { mode: 'redirect' } });
  assert.equal(r.statusCode, 200, r.body);
  const port = r.json().listeningPort;
  let peer = await served(port, 'www.example.test');
  assert.equal(peer.serialNumber.toLowerCase(), first.serial.toLowerCase());
  const redirect = await fetchText(`http://127.0.0.1:${APP_PORT}/api/config`);
  assert.equal(redirect.status, 307);
  r = await obtain();
  assert.equal(r.statusCode, 200, r.body);
  const second = r.json().installed;
  assert.notEqual(second.serial, first.serial);
  assert.equal(r.json().acme.account, acme.account); // same ACME account reused
  peer = await served(port, 'checkin.example.test');
  assert.equal(peer.serialNumber.toLowerCase(), second.serial.toLowerCase()); // hot swapped
  // RSA keys on request.
  await setAcme({ keyType: 'rsa' });
  r = await obtain();
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().installed.keyType, 'rsa');
  await admin({ method: 'PUT', url: '/api/admin/tls', payload: { mode: 'off' } });
});

test('ACME: a domain that does not reach this server fails clearly, keeps the old certificate and backs off', { skip, timeout: 120_000 }, async () => {
  const before = (await admin({ url: '/api/admin/tls' })).json().cert;
  await fetchText('http://127.0.0.1:8055/add-a', { method: 'POST', body: JSON.stringify({ host: 'bad.example.test', addresses: ['127.0.0.2'] }) });
  let r = await setAcme({ ca: 'custom', directoryUrl: dir('normal'), domains: 'checkin.example.test, bad.example.test', keyType: 'ecdsa' });
  assert.equal(r.statusCode, 200, r.body);
  r = await obtain();
  assert.equal(r.statusCode, 502, r.body);
  assert.match(r.json().error, /port 80/);
  const acme = (await admin({ url: '/api/admin/tls/acme' })).json();
  assert.match(acme.lastError, /port 80/);
  const wait = Date.parse(acme.nextAttempt) - Date.now();
  assert.ok(wait > 50 * 60e3 && wait <= 60 * 60e3, `retry in ~1h, got ${wait}`);
  assert.equal(app.acme.due(), false); // backing off
  const st = (await admin({ url: '/api/admin/tls' })).json();
  assert.equal(st.cert.fingerprint256, before.fingerprint256);
  assert.equal(st.events[0].ok, false);
  assert.equal(app.acme.challenges.size, 0);
});

test('ACME: External Account Binding', { skip, timeout: 120_000 }, async () => {
  let r = await setAcme({ ca: 'custom', directoryUrl: dir('eab'), domains: 'eab.example.test', eabKid: '', eabHmac: '' });
  assert.equal(r.statusCode, 200, r.body);
  r = await obtain();
  assert.equal(r.statusCode, 502);
  assert.match(r.json().error, /External Account Binding|externalAccount/i);
  r = await setAcme({ eabKid: EAB.kid, eabHmac: EAB.hmac });
  r = await obtain();
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().installed.subject, 'eab.example.test');
});

test('ACME: renewal runs on its own when due', { skip, timeout: 120_000 }, async () => {
  let r = await setAcme({ ca: 'custom', directoryUrl: dir('short'), domains: 'short.example.test' });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([r.json().eabKid, r.json().eabHmacSet, r.json().account], ['', false, null]); // new CA: EAB and account reset
  r = await obtain();
  assert.equal(r.statusCode, 200, r.body);
  const first = r.json().installed;
  // A 2-hour certificate is inside its renewal window straight away.
  assert.equal(app.acme.due(), true);
  const renewed = await app.acme.tick();
  assert.ok(renewed, 'tick renewed it');
  assert.notEqual(renewed.installed.serial, first.serial);
  const st = (await admin({ url: '/api/admin/tls' })).json();
  assert.equal(st.events[0].reason, 'renewal');
  // Changing the domain list makes a new certificate due too.
  await setAcme({ ca: 'custom', directoryUrl: dir('normal'), domains: 'checkin.example.test' });
  await obtain();
  assert.equal(app.acme.due(), false);
  await setAcme({ domains: 'checkin.example.test, extra.example.test' });
  assert.equal(app.acme.due(), true);
  await setAcme({ enabled: false });
  assert.equal(app.acme.due(), false);
});
