// Certificate deploy keys, PEM/PFX deploys, safety checks, hot reload and the HTTP-01 route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import forge from 'node-forge';
import { openDb } from '../src/db.js';
import { Store } from '../src/store.js';
import { Accounts } from '../src/auth/accounts.js';
import { EntraOidc } from '../src/auth/oidc.js';
import { buildApp } from '../src/app.js';
import { splitPem, parseAllowList } from '../src/certdeploy.js';

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

async function setup(overrides = {}) {
  const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-tls-'));
  const config = { historyLimit: 3, maxBatch: 5000, maxFieldsPerRecord: 500, bodyLimitMb: 10, importLimitMb: 50,
    logLevel: 'silent', corsOrigin: '', cookieSecure: 'auto', trustProxy: false, oidcIssuerOverride: '',
    host: '127.0.0.1', httpsPort: 0, tlsDir, tlsDisable: false, tlsPollMs: 0, acmeCheckMs: 0, ...overrides };
  const db = openDb(':memory:');
  const store = new Store(db, { historyLimit: config.historyLimit, maxBatch: config.maxBatch });
  const accounts = new Accounts(db, { secret: crypto.randomBytes(32), sessionTtlHours: 1 });
  const app = buildApp({ config, store, accounts, oidc: new EntraOidc(accounts, {}) });
  await accounts.create({ username: 'admin', password: 'adminpass123', role: 'admin' });
  await accounts.create({ username: 'pu', password: 'powerpass123', role: 'power' });
  const admin = (o) => app.inject({ ...o, headers: { authorization: basic('admin', 'adminpass123'), ...(o.headers || {}) } });
  const power = (o) => app.inject({ ...o, headers: { authorization: basic('pu', 'powerpass123'), ...(o.headers || {}) } });
  const deploy = (key, o = {}) => app.inject({ method: 'PUT', url: '/api/tls/certificate', remoteAddress: '127.0.0.1', ...o, headers: { ...(key ? { 'x-deploy-key': key } : {}), ...(o.headers || {}) } });
  return { app, accounts, admin, power, deploy, tlsDir };
}

// ---- a small test CA ---------------------------------------------------------------
function makeCa() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 3650 * 86400e3);
  const attrs = [{ name: 'commonName', value: 'Check-In Test CA' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { keys, cert, pem: forge.pki.certificateToPem(cert) };
}
let serial = 2;
function makeLeaf(ca, names, { days = 90, startDaysAgo = 1 } = {}) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = (serial++).toString(16).padStart(2, '0');
  cert.validity.notBefore = new Date(Date.now() - startDaysAgo * 86400e3);
  cert.validity.notAfter = new Date(Date.now() + days * 86400e3);
  cert.setSubject([{ name: 'commonName', value: names[0] }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([{ name: 'subjectAltName', altNames: names.map((n) => ({ type: 2, value: n })) }, { name: 'extKeyUsage', serverAuth: true }]);
  cert.sign(ca.keys.privateKey, forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  return {
    cert: certPem, key: keyPem, chain: certPem + ca.pem,
    pfx: (password) => Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert, ca.cert], password, { algorithm: '3des' })).getBytes(), 'binary'),
    fingerprint: new crypto.X509Certificate(certPem).fingerprint256,
  };
}
const ca = makeCa();

function served(port, servername) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port, servername, rejectUnauthorized: false }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(c);
    });
    s.on('error', reject);
  });
}

test('splitPem and allow lists', () => {
  const leaf = makeLeaf(ca, ['a.example.com']);
  const both = splitPem(leaf.chain + leaf.key);
  assert.equal((both.cert.match(/BEGIN CERTIFICATE/g) || []).length, 2);
  assert.match(both.key, /BEGIN (RSA )?PRIVATE KEY/);
  assert.deepEqual(parseAllowList('10.0.0.5, 10.0.0.0/24 2001:db8::/48'), ['10.0.0.5', '10.0.0.0/24', '2001:db8::/48']);
  assert.throws(() => parseAllowList('10.0.0.0/33'), /Not an IP/);
  assert.throws(() => parseAllowList('example.com'), /Not an IP/);
});

test('deploy keys: only admins manage them; shown once; stored hashed', async (t) => {
  const { app, admin, power, accounts } = await setup();
  t.after(() => app.close());
  assert.equal((await power({ url: '/api/admin/tls/deploy-keys' })).statusCode, 200, 'power users can list deploy keys (no secrets)');
  assert.equal((await power({ method: 'POST', url: '/api/admin/tls/deploy-keys', payload: { name: 'x' } })).statusCode, 403);
  assert.equal((await admin({ method: 'POST', url: '/api/admin/tls/deploy-keys', payload: { name: '' } })).statusCode, 400);
  assert.equal((await admin({ method: 'POST', url: '/api/admin/tls/deploy-keys', payload: { name: 'x', allowIps: 'nope' } })).statusCode, 400);
  const r = await admin({ method: 'POST', url: '/api/admin/tls/deploy-keys', payload: { name: 'certbot on web-01', allowIps: '127.0.0.1' } });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.headers['cache-control'], 'no-store');
  const { key, deployKey } = r.json();
  assert.match(key, /^ckd_[A-Za-z0-9_-]{40,}$/);
  assert.equal(deployKey.prefix, key.slice(0, 10));
  assert.equal(deployKey.hash, undefined);
  const list = (await admin({ url: '/api/admin/tls/deploy-keys' })).json().keys;
  assert.equal(list.length, 1);
  assert.equal(JSON.stringify(list).includes(key), false);
  assert.equal(JSON.stringify(accounts.getSetting('tlsDeployKeys')).includes(key), false); // only the hash is stored
  const up = await admin({ method: 'PUT', url: `/api/admin/tls/deploy-keys/${deployKey.id}`, payload: { name: 'renamed', allowIps: '' } });
  assert.deepEqual([up.json().deployKey.name, up.json().deployKey.allowIps], ['renamed', []]);
  assert.equal((await admin({ method: 'DELETE', url: `/api/admin/tls/deploy-keys/${deployKey.id}` })).statusCode, 200);
  assert.equal((await admin({ method: 'DELETE', url: `/api/admin/tls/deploy-keys/${deployKey.id}` })).statusCode, 404);
});

test('deploy: authentication, address limits, rate limiting and revocation', async (t) => {
  const { app, admin, deploy } = await setup();
  t.after(() => app.close());
  const leaf = makeLeaf(ca, ['checkin.example.com']);
  const pem = { 'content-type': 'application/x-pem-file' };
  const { key, deployKey } = (await admin({ method: 'POST', url: '/api/admin/tls/deploy-keys', payload: { name: 'ci', allowIps: '10.0.0.0/8' } })).json();
  // The device API key / a user can't use this endpoint; neither can a missing or wrong key.
  assert.equal((await deploy(null, { headers: pem, payload: leaf.chain + leaf.key })).statusCode, 401);
  assert.equal((await admin({ method: 'PUT', url: '/api/tls/certificate', headers: pem, payload: leaf.chain + leaf.key })).statusCode, 401);
  // Right key, wrong address.
  let r = await deploy(key, { headers: pem, payload: leaf.chain + leaf.key });
  assert.equal(r.statusCode, 403, r.body);
  r = await deploy(key, { headers: pem, payload: leaf.chain + leaf.key, remoteAddress: '10.1.2.3' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().installed.subject, 'checkin.example.com');
  assert.match(r.json().https, /HTTPS is off/);
  // Usage recorded.
  const k = (await admin({ url: '/api/admin/tls/deploy-keys' })).json().keys[0];
  assert.deepEqual([k.uses, k.lastIp], [1, '10.1.2.3']);
  // Revoked keys stop working.
  await admin({ method: 'DELETE', url: `/api/admin/tls/deploy-keys/${deployKey.id}` });
  assert.equal((await deploy(key, { headers: pem, payload: leaf.chain + leaf.key, remoteAddress: '10.1.2.3' })).statusCode, 401);
  // After ten bad keys from one address → 429 (even with a good key), other addresses unaffected.
  for (let i = 0; i < 10; i++) assert.equal((await deploy('ckd_wrong' + i, { remoteAddress: '192.0.2.9' })).statusCode, 401);
  assert.equal((await deploy('ckd_wrong', { remoteAddress: '192.0.2.9' })).statusCode, 429);
  assert.equal((await deploy('ckd_wrong', { remoteAddress: '192.0.2.10' })).statusCode, 401);
});

test('deploy: PEM, JSON and PFX bodies; safety checks; history; live reload over HTTPS', async (t) => {
  const { app, admin, deploy, tlsDir } = await setup();
  t.after(() => app.close());
  const { key } = (await admin({ method: 'POST', url: '/api/admin/tls/deploy-keys', payload: { name: 'automation' } })).json();
  const pemHdr = { 'content-type': 'application/x-pem-file' };

  // 1. Combined PEM file (cat fullchain.pem privkey.pem | curl --data-binary @-)
  const first = makeLeaf(ca, ['checkin.example.com', 'www.example.com'], { days: 60 });
  let r = await deploy(key, { headers: pemHdr, payload: first.chain + first.key });
  assert.equal(r.statusCode, 200, r.body);
  // HTTPS on: it serves the deployed certificate.
  r = await admin({ method: 'PUT', url: '/api/admin/tls', payload: { mode: 'both' } });
  assert.equal(r.statusCode, 200, r.body);
  const port = r.json().listeningPort;
  assert.equal((await served(port, 'checkin.example.com')).fingerprint256, first.fingerprint);

  // 2. Safety: shorter expiry → 409; force=1 installs anyway.
  const shorter = makeLeaf(ca, ['checkin.example.com'], { days: 30 });
  r = await deploy(key, { headers: { 'content-type': 'application/json' }, payload: { cert: shorter.chain, key: shorter.key } });
  assert.equal(r.statusCode, 409, r.body);
  assert.match(r.json().error, /before the current one/);
  // 3. Safety: no shared names → 409.
  const other = makeLeaf(ca, ['unrelated.example.org'], { days: 120 });
  r = await deploy(key, { headers: pemHdr, payload: other.chain + other.key });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /shares no names/);
  // A wildcard covering the current name is fine (JSON with cert + key).
  const wild = makeLeaf(ca, ['*.example.com'], { days: 90 });
  r = await deploy(key, { headers: { 'content-type': 'application/json' }, payload: { cert: wild.chain, key: wild.key } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await served(port, 'checkin.example.com')).fingerprint256, wild.fingerprint); // hot swapped, same port

  // 4. PFX as-is (application/x-pkcs12) with its password; wrong password → 400.
  const viaPfx = makeLeaf(ca, ['checkin.example.com'], { days: 200 });
  r = await deploy(key, { headers: { 'content-type': 'application/x-pkcs12', 'x-pfx-password': 'nope' }, payload: viaPfx.pfx('s3cret') });
  assert.equal(r.statusCode, 400, r.body);
  assert.match(r.json().error, /password/i);
  r = await deploy(key, { headers: { 'content-type': 'application/x-pkcs12', 'x-pfx-password': 's3cret' }, payload: viaPfx.pfx('s3cret') });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await served(port, 'checkin.example.com')).fingerprint256, viaPfx.fingerprint);
  // JSON PFX (base64) works too, and survives a restart (password stored encrypted).
  const viaJsonPfx = makeLeaf(ca, ['checkin.example.com'], { days: 300 });
  r = await deploy(key, { headers: { 'content-type': 'application/json' }, payload: { pfx: viaJsonPfx.pfx('pw2').toString('base64'), passphrase: 'pw2' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(fs.existsSync(path.join(tlsDir, 'cert.pfx')));
  assert.equal(fs.existsSync(path.join(tlsDir, 'cert.pem')), false);
  assert.equal((await served(port, 'checkin.example.com')).fingerprint256, viaJsonPfx.fingerprint);

  // 5. Force past the checks; expired certificates are refused even with force.
  r = await deploy(key, { url: '/api/tls/certificate?force=1', headers: pemHdr, payload: shorter.chain + shorter.key });
  assert.equal(r.statusCode, 200, r.body);
  const expired = makeLeaf(ca, ['checkin.example.com'], { days: -1, startDaysAgo: 30 });
  r = await deploy(key, { url: '/api/tls/certificate?force=1', headers: pemHdr, payload: expired.chain + expired.key });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /expired/);
  // Garbage and a key that doesn't match.
  assert.equal((await deploy(key, { headers: pemHdr, payload: 'hello' })).statusCode, 400);
  r = await deploy(key, { url: '/api/tls/certificate?force=1', headers: pemHdr, payload: other.chain + first.key });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /does not match/);
  assert.equal((await deploy(key, { headers: { 'content-type': 'image/png' }, payload: Buffer.from('x') })).statusCode, 415);

  // 6. History and state.
  const st = (await admin({ url: '/api/admin/tls' })).json();
  assert.equal(st.source, 'deploy');
  assert.match(st.uploadedBy, /automation/);
  const deploys = st.events.filter((e) => e.action === 'deploy');
  assert.ok(deploys.some((e) => e.ok) && deploys.some((e) => !e.ok && /before the current one/.test(e.error)));
  assert.ok(deploys.some((e) => e.forced));
  // Still serving the forced one.
  assert.equal((await served(port, 'checkin.example.com')).fingerprint256, shorter.fingerprint);
});

test('certificates copied into the data volume are picked up and logged', async (t) => {
  const { app, admin, tlsDir } = await setup({ tlsPollMs: 100 });
  t.after(() => app.close());
  const a = makeLeaf(ca, ['files.example.com']);
  await admin({ method: 'POST', url: '/api/admin/tls/certificate', payload: { type: 'pem', cert: a.chain, key: a.key } });
  const port = (await admin({ method: 'PUT', url: '/api/admin/tls', payload: { mode: 'both' } })).json().listeningPort;
  assert.equal((await served(port, 'files.example.com')).fingerprint256, a.fingerprint);
  const b = makeLeaf(ca, ['files.example.com'], { days: 120 });
  fs.writeFileSync(path.join(tlsDir, 'cert.pem'), b.chain);
  fs.writeFileSync(path.join(tlsDir, 'key.pem'), b.key);
  await new Promise((res) => setTimeout(res, 400));
  assert.equal((await served(port, 'files.example.com')).fingerprint256, b.fingerprint);
  const ev = (await admin({ url: '/api/admin/tls' })).json().events;
  assert.equal(ev[0].action, 'file');
  assert.equal(ev[1].action, 'upload');
});

test('ACME settings validation and the challenge route', async (t) => {
  const { app, admin, power } = await setup();
  t.after(() => app.close());
  assert.equal((await power({ url: '/api/admin/tls/acme' })).statusCode, 200, 'power users can look at the ACME settings');
  assert.equal((await power({ method: 'PUT', url: '/api/admin/tls/acme', payload: { enabled: false } })).statusCode, 403);
  const put = (payload) => admin({ method: 'PUT', url: '/api/admin/tls/acme', payload });
  assert.equal((await put({ domains: 'localhost' })).statusCode, 400);
  assert.equal((await put({ domains: '10.0.0.5' })).statusCode, 400);
  assert.match((await put({ domains: '*.example.com' })).json().error, /DNS-01/);
  assert.equal((await put({ email: 'nope' })).statusCode, 400);
  assert.equal((await put({ ca: 'custom', directoryUrl: 'http://insecure.example.com/dir' })).statusCode, 400);
  assert.equal((await put({ enabled: true, domains: 'checkin.example.com' })).statusCode, 400); // terms not accepted
  let r = await put({ enabled: true, agreeTos: true, domains: 'Checkin.Example.com, www.example.com, checkin.example.com', email: 'it@example.com', eabKid: 'kid', eabHmac: 'abcdefghijklmnopqrstuvwx' });
  assert.equal(r.statusCode, 200, r.body);
  const st = r.json();
  assert.deepEqual(st.domains, ['checkin.example.com', 'www.example.com']);
  assert.equal(st.eabHmacSet, true);
  assert.equal(JSON.stringify(st).includes('abcdefghijklmnopqrstuvwx'), false);
  assert.equal((await put({ enabled: false })).json().enabled, false);
  // Unknown tokens 404; the path is public and isn't redirected to HTTPS.
  r = await app.inject({ url: '/.well-known/acme-challenge/abc' });
  assert.equal(r.statusCode, 404);
  app.acme.challenges.set('tok123', 'tok123.thumb');
  r = await app.inject({ url: '/.well-known/acme-challenge/tok123' });
  assert.deepEqual([r.statusCode, r.body, r.headers['content-type'].split(';')[0]], [200, 'tok123.thumb', 'text/plain']);
});
