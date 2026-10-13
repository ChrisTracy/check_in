import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import forge from 'node-forge';
import tls from 'node:tls';
import crypto from 'node:crypto';
import net from 'node:net';
import { safeProto, HOST_RE } from './auth/security.js';
import { HttpError } from './store.js';
import { encrypt, decrypt } from './auth/security.js';

/**
 * Built-in HTTPS for deployments that can't sit behind a reverse proxy.
 *
 * Certificates live in the data volume (<data>/tls) so they survive container
 * rebuilds. Settings (mode, HSTS, public port, PFX passphrase encrypted) are
 * stored in the settings table. The HTTPS server shares Fastify's request
 * handler with the HTTP server, and certificates are swapped in place with
 * setSecureContext, so changes never need a restart.
 *
 * Modes:
 *   off       HTTP only (default)
 *   both      HTTPS and HTTP both serve the app
 *   redirect  HTTPS serves the app; HTTP redirects to HTTPS (except /health)
 */
export const TLS_MODES = ['off', 'both', 'redirect'];
const DEFAULTS = { mode: 'off', hsts: false, publicPort: null, source: null, pfxPass: '', uploadedAt: null, uploadedBy: null };
const FILES = { cert: 'cert.pem', key: 'key.pem', pfx: 'cert.pfx' };
const MAX_PEM = 256 * 1024;
const MAX_PFX = 512 * 1024;

function writeSecureFile(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Host names for a self-signed certificate: DNS names (a leading "*." is allowed) or IPv4 / IPv6
 * addresses, without ports. Returns [{ name, ip }] or throws HttpError(400).
 */
export function parseCertNames(input) {
  const raw = (Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/)).map((h) => String(h).trim()).filter(Boolean);
  if (!raw.length) throw new HttpError(400, 'Enter at least one host name or IP address');
  if (raw.length > 100) throw new HttpError(400, 'At most 100 host names');
  const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i;
  const out = [];
  for (const r of raw) {
    const n = r.startsWith('[') && r.endsWith(']') ? r.slice(1, -1) : r;
    const show = r.slice(0, 80);
    if (net.isIP(n)) { out.push({ name: n, ip: true }); continue; }
    if (/^\[.*\]:\d+$/.test(r) || /^[^:]+:\d+$/.test(r)) throw new HttpError(400, `Leave the port out of host names: ${show}`);
    if (/^[\d.]+$/.test(n)) throw new HttpError(400, `Not a valid IP address: ${show}`);
    if (n.includes(':')) throw new HttpError(400, `Not a valid IPv6 address: ${show}`);
    const name = n.replace(/\.$/, '');
    const labels = (name.startsWith('*.') ? name.slice(2) : name).split('.');
    if (name.length > 253 || !labels.every((l) => label.test(l))) {
      throw new HttpError(400, `Not a valid host name: ${show} (use letters, numbers and dashes, separated by dots)`);
    }
    out.push({ name: name.toLowerCase(), ip: false });
  }
  return out;
}

/** Refuse certificates that are expired or not valid yet (uploads, deploys, ACME). */
function assertCurrent(info) {
  if (info.expired) throw new HttpError(400, `That certificate expired on ${info.validTo.slice(0, 10)}. Install a current certificate.`);
  if (Date.parse(info.validFrom) > Date.now() + 5 * 60_000) {
    throw new HttpError(400, `That certificate is not valid until ${info.validFrom.slice(0, 16).replace('T', ' ')} UTC. Check the clock on the machine that made it.`);
  }
}

function derToPem(der) {
  const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/**
 * Old .pfx files (Windows before 2019, old exports using RC2-40 or other legacy encryption) are refused
 * by OpenSSL 3 ("Unsupported PKCS12 PFX data"). Open them in JavaScript instead and return the
 * certificate chain (leaf first) and the private key as PEM. RSA keys only.
 */
export function pfxToPem(pfx, passphrase = '') {
  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary'))), String(passphrase || ''));
  } catch (e) {
    const m = String(e.message || e);
    if (/mac could not be verified|invalid password/i.test(m)) throw new HttpError(400, 'Wrong password for the certificate file');
    throw new HttpError(400, 'Could not read that .pfx file: ' + m.slice(0, 160));
  }
  const bags = (type) => (p12.getBags({ bagType: type })[type] || []);
  const keyBag = [...bags(forge.pki.oids.pkcs8ShroudedKeyBag), ...bags(forge.pki.oids.keyBag)].find((b) => b.key);
  if (!keyBag) throw new HttpError(400, 'No RSA private key found in that .pfx file. Export the certificate with its private key, or upload PEM files.');
  const certs = bags(forge.pki.oids.certBag).map((b) => b.cert).filter(Boolean);
  if (!certs.length) throw new HttpError(400, 'No certificate found in that .pfx file');
  const n = keyBag.key.n?.toString(16);
  const leaf = certs.find((c) => c.publicKey?.n?.toString(16) === n) || certs[0];
  const chain = [leaf, ...certs.filter((c) => c !== leaf)];
  return { cert: chain.map((c) => forge.pki.certificateToPem(c)).join(''), key: forge.pki.privateKeyToPem(keyBag.key) };
}
const isUnsupportedPfx = (e) => /Unsupported PKCS12|unsupported/i.test(String(e?.message || e));

/** Validate TLS material and describe the leaf certificate. Throws HttpError(400) if unusable. */
export function inspectMaterial(opts) {
  let ctx;
  try {
    ctx = tls.createSecureContext(opts);
  } catch (e) {
    const m = String(e.message || e);
    if (/mac verify failure|bad decrypt|wrong password|bad password/i.test(m)) throw new HttpError(400, 'Wrong password for the certificate file');
    if (/key values mismatch/i.test(m)) throw new HttpError(400, 'The private key does not match the certificate');
    if (/no start line|bad base64|PEM/i.test(m)) throw new HttpError(400, 'Could not read the certificate or key. Use PEM text (BEGIN CERTIFICATE / BEGIN PRIVATE KEY) or a .pfx file.');
    throw new HttpError(400, 'Invalid certificate: ' + m);
  }
  // Read the configured leaf certificate back out of the secure context.
  const sock = new tls.TLSSocket(null, { isServer: true, secureContext: ctx });
  const raw = sock.getCertificate()?.raw;
  sock.destroy();
  if (!raw) throw new HttpError(400, 'No certificate found');
  const x = new crypto.X509Certificate(raw);
  const validTo = new Date(x.validTo);
  const subjectCN = (/(?:^|\n)CN=([^\n]+)/.exec(x.subject) || [])[1] || x.subject;
  const names = (x.subjectAltName || '').split(/,\s*/).filter(Boolean)
    .map((s) => s.replace(/^DNS:/, '').replace(/^IP Address:/, ''));
  let selfSigned = false;
  try { selfSigned = x.subject === x.issuer && x.verify(x.publicKey); } catch { /* ignore */ }
  return {
    // Some CAs (Pebble, Let's Encrypt short-lived certs) leave the subject empty: use the first name.
    subject: subjectCN || names[0] || '(no name)',
    names,
    issuer: (/(?:^|\n)(?:CN|O)=([^\n]+)/.exec(x.issuer) || [])[1] || x.issuer,
    validFrom: new Date(x.validFrom).toISOString(),
    validTo: validTo.toISOString(),
    daysLeft: Math.floor((validTo - Date.now()) / 86400000),
    expired: validTo < new Date(),
    selfSigned,
    fingerprint256: x.fingerprint256,
    serial: x.serialNumber,
    keyType: x.publicKey.asymmetricKeyType,
    pem: derToPem(raw),
  };
}

export class TlsManager {
  constructor({ dir, accounts, handler, port, host, disabled = false, log = console, pollMs = 60_000 }) {
    this.dir = dir;
    this.accounts = accounts;
    this.handler = handler;
    this.port = port;
    this.host = host;
    this.disabled = disabled;
    this.log = log;
    this.server = null;
    this.listeningPort = null;
    this.error = null;
    this.info = null;
    this.mtimes = '';
    if (pollMs > 0) {
      // Pick up certificates renewed on disk (e.g. by certbot copying into the volume).
      this.timer = setInterval(() => this.#pollFiles(), pollMs);
      this.timer.unref();
    }
  }

  settings() { return { ...DEFAULTS, ...this.accounts.getSetting('tls', {}) }; }
  #save(patch) { this.accounts.setSetting('tls', { ...this.settings(), ...patch }); }
  #file(name) { return path.join(this.dir, FILES[name]); }
  #exists(name) { return fs.existsSync(this.#file(name)); }

  get mode() { return this.disabled ? 'off' : this.settings().mode; }
  get listening() { return Boolean(this.server && this.listeningPort !== null); }
  get publicPort() { return this.settings().publicPort || this.listeningPort || this.port; }

  /** Current certificate material from the volume, or null if none. */
  material() {
    const s = this.settings();
    if ((s.source === 'pfx' || s.pfxSource) && this.#exists('pfx')) {
      return { pfx: fs.readFileSync(this.#file('pfx')), passphrase: decrypt(this.accounts.secret, s.pfxPass) || '' };
    }
    if (this.#exists('cert') && this.#exists('key')) {
      return { cert: fs.readFileSync(this.#file('cert')), key: fs.readFileSync(this.#file('key')) };
    }
    return null;
  }

  #fileStamp() {
    return Object.keys(FILES).map((k) => {
      try { return fs.statSync(this.#file(k)).mtimeMs; } catch { return 0; }
    }).join(':');
  }

  async #pollFiles() {
    const stamp = this.#fileStamp();
    if (stamp === this.mtimes) return;
    this.mtimes = stamp;
    const st = await this.apply().catch(() => null);
    if (st?.cert) {
      this.logEvent({ action: 'file', ok: true, by: 'files in the data volume', subject: st.cert.subject, validTo: st.cert.validTo });
      if (this.mode !== 'off') this.log.info?.('TLS files changed on disk, reloaded certificate');
    }
  }

  /** Start, stop or reload the HTTPS server to match the saved settings. */
  async apply() {
    this.mtimes = this.#fileStamp();
    const mat = this.material();
    this.info = null;
    if (mat) {
      try { this.info = inspectMaterial(mat); } catch (e) { this.error = e.message; }
    }
    if (this.mode === 'off' || !mat || !this.info) {
      await this.stop();
      if (this.mode !== 'off' && !mat) this.error = 'HTTPS is turned on but no certificate is installed';
      else if (this.mode === 'off') this.error = null;
      return this.state();
    }
    this.error = null;
    if (this.server && this.listeningPort !== null) {
      this.server.setSecureContext(mat); // hot swap; existing connections keep their old context
      return this.state();
    }
    const server = https.createServer({ ...mat, minVersion: 'TLSv1.2' }, this.handler);
    server.keepAliveTimeout = 65_000;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.port, this.host, () => { server.off('error', reject); resolve(); });
      });
      this.server = server;
      this.listeningPort = server.address().port;
      server.on('error', (e) => { this.error = e.message; });
    } catch (e) {
      this.error = e.code === 'EADDRINUSE' ? `Port ${this.port} is already in use` : e.message;
      this.server = null;
      this.listeningPort = null;
    }
    return this.state();
  }

  async stop() {
    const s = this.server;
    this.server = null;
    this.listeningPort = null;
    if (!s) return;
    await new Promise((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections?.();
    });
  }

  close() {
    clearInterval(this.timer);
    return this.stop();
  }

  state() {
    const s = this.settings();
    const info = this.info ? { ...this.info } : null;
    if (info) delete info.pem;
    return {
      mode: this.mode,
      savedMode: s.mode,
      hsts: s.hsts,
      publicPort: s.publicPort,
      httpsPort: this.port,
      listening: this.listening,
      listeningPort: this.listeningPort,
      error: this.error,
      disabledByEnv: this.disabled,
      source: s.source,
      uploadedAt: s.uploadedAt,
      uploadedBy: s.uploadedBy,
      cert: info,
      events: this.events().slice(0, 20),
    };
  }

  // ---- certificate history (uploads, deploy keys, Let's Encrypt, files) ----
  events() { return this.accounts.getSetting('tlsEvents', []); }
  logEvent(e) {
    const list = [{ at: new Date().toISOString(), ...e }, ...this.events()].slice(0, 50);
    this.accounts.setSetting('tlsEvents', list);
  }

  /** The installed certificate's details (null when there is none or it can't be read). */
  current() {
    if (!this.info) {
      const mat = this.material();
      if (mat) { try { this.info = inspectMaterial(mat); } catch { this.info = null; } }
    }
    return this.info;
  }

  /** Install a PFX that arrived automatically (deploy key). Same checks as an upload. */
  async installPfx({ pfx, passphrase, source, by }) {
    if (!pfx?.length) throw new HttpError(400, 'Empty .pfx file');
    if (pfx.length > MAX_PFX) throw new HttpError(400, 'PFX file is too large');
    try { inspectMaterial({ pfx, passphrase }); } catch (e) {
      if (!isUnsupportedPfx(e)) throw e;
      const conv = pfxToPem(pfx, passphrase); // legacy encryption: store as PEM
      return this.installPem({ cert: conv.cert, key: conv.key, source, by });
    }
    const info = inspectMaterial({ pfx, passphrase });
    assertCurrent(info);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeSecureFile(this.#file('pfx'), pfx);
    for (const f of ['cert', 'key']) fs.rmSync(this.#file(f), { force: true });
    this.#save({ source, pfxPass: passphrase ? encrypt(this.accounts.secret, passphrase) : '', uploadedAt: new Date().toISOString(), uploadedBy: by || null, pfxSource: true });
    await this.apply();
    const installed = { ...info };
    delete installed.pem;
    return { ...this.state(), installed };
  }

  /**
   * Install a PEM certificate chain + key that arrived automatically (deploy key, Let's Encrypt).
   * Same checks as an upload; the HTTPS mode is left as it is.
   */
  async installPem({ cert, key, source, by }) {
    cert = String(cert || '');
    if (!cert.includes('BEGIN CERTIFICATE')) throw new HttpError(400, 'Certificate must be PEM text containing BEGIN CERTIFICATE');
    if (!/BEGIN [A-Z ]*PRIVATE KEY/.test(String(key || ''))) throw new HttpError(400, 'No private key found (PEM text containing BEGIN … PRIVATE KEY)');
    if (cert.length > MAX_PEM || String(key).length > MAX_PEM) throw new HttpError(400, 'Certificate or key is too large');
    let pkcs8;
    try { pkcs8 = crypto.createPrivateKey({ key: String(key) }).export({ type: 'pkcs8', format: 'pem' }); } catch (e) {
      throw new HttpError(400, /passphrase|bad decrypt/i.test(e.message) ? 'The private key is encrypted; send it unencrypted' : 'Could not read the private key: ' + e.message);
    }
    const info = inspectMaterial({ cert, key: pkcs8 });
    assertCurrent(info);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeSecureFile(this.#file('cert'), cert);
    writeSecureFile(this.#file('key'), pkcs8);
    fs.rmSync(this.#file('pfx'), { force: true });
    this.#save({ source, pfxPass: '', uploadedAt: new Date().toISOString(), uploadedBy: by || null, pfxSource: false });
    await this.apply();
    const installed = { ...info };
    delete installed.pem;
    return { ...this.state(), installed };
  }

  async updateSettings({ mode, hsts, publicPort }) {
    const patch = {};
    if (mode !== undefined) {
      if (!TLS_MODES.includes(mode)) throw new HttpError(400, 'mode must be off, both or redirect');
      if (mode !== 'off' && !this.material()) throw new HttpError(400, 'Install a certificate before turning HTTPS on');
      patch.mode = mode;
    }
    if (hsts !== undefined) patch.hsts = Boolean(hsts);
    if (publicPort !== undefined) {
      if (publicPort === null || publicPort === '') patch.publicPort = null;
      else {
        const p = Number(publicPort);
        if (!Number.isInteger(p) || p < 1 || p > 65535) throw new HttpError(400, 'Public port must be between 1 and 65535');
        patch.publicPort = p;
      }
    }
    const before = this.settings();
    this.#save(patch);
    if (this.disabled) return this.state(); // saved, but TLS_DISABLE keeps HTTPS off
    const st = await this.apply();
    if (patch.mode && patch.mode !== 'off' && !st.listening) {
      // Couldn't start HTTPS: roll back so HTTP never redirects to a dead port.
      this.#save({ mode: before.mode });
      await this.apply();
      throw new HttpError(400, `HTTPS could not start: ${st.error || 'unknown error'}`);
    }
    return this.state();
  }

  /** Validate and store a new certificate in the volume, then reload. */
  async install(body, by) {
    const type = body?.type;
    let mat;
    let files;
    let pfxPass = '';
    if (type === 'pem') {
      const cert = String(body.cert || '');
      let key = String(body.key || '');
      if (!cert.includes('BEGIN CERTIFICATE')) throw new HttpError(400, 'Certificate must be PEM text containing BEGIN CERTIFICATE');
      if (!/BEGIN [A-Z ]*PRIVATE KEY/.test(key)) throw new HttpError(400, 'Private key must be PEM text containing BEGIN … PRIVATE KEY');
      if (cert.length > MAX_PEM || key.length > MAX_PEM) throw new HttpError(400, 'Certificate or key file is too large');
      try {
        // Store the key unencrypted (like nginx) so restarts don't need the passphrase.
        key = crypto.createPrivateKey({ key, passphrase: body.passphrase || undefined }).export({ type: 'pkcs8', format: 'pem' });
      } catch (e) {
        throw new HttpError(400, /bad decrypt|passphrase|interrupted or cancelled/i.test(e.message)
          ? 'The private key is encrypted: enter the correct key password' : 'Could not read the private key: ' + e.message);
      }
      mat = { cert, key };
      files = { cert, key };
    } else if (type === 'pfx') {
      let buf;
      try { buf = Buffer.from(String(body.pfx || ''), 'base64'); } catch { buf = Buffer.alloc(0); }
      if (!buf.length) throw new HttpError(400, 'Choose a .pfx / .p12 file');
      if (buf.length > MAX_PFX) throw new HttpError(400, 'PFX file is too large');
      pfxPass = String(body.passphrase || '');
      mat = { pfx: buf, passphrase: pfxPass };
      files = { pfx: buf };
      try { inspectMaterial(mat); } catch (e) {
        if (!isUnsupportedPfx(e)) throw e;
        // Legacy encryption OpenSSL 3 refuses: convert once and keep it as PEM (no password needed after).
        const conv = pfxToPem(buf, pfxPass);
        mat = files = { cert: conv.cert, key: crypto.createPrivateKey(conv.key).export({ type: 'pkcs8', format: 'pem' }) };
        pfxPass = '';
      }
    } else if (type === 'self-signed') {
      const names = parseCertNames(body.hostnames);
      const days = body.days === undefined || body.days === null || body.days === '' ? 365 : Number(body.days);
      if (!Number.isInteger(days) || days < 1 || days > 3650) throw new HttpError(400, 'Valid for (days) must be a whole number from 1 to 3650');
      const { generate } = await import('selfsigned');
      // selfsigned 5 takes dates, not a number of days. Start a minute early for clock skew.
      const notBeforeDate = new Date(Date.now() - 60_000);
      const notAfterDate = new Date(notBeforeDate.getTime() + days * 86400_000);
      let pems;
      try {
        pems = await generate([{ name: 'commonName', value: names[0].name }], {
          notBeforeDate,
          notAfterDate,
          keySize: 2048,
          algorithm: 'sha256',
          extensions: [
            { name: 'basicConstraints', cA: false },
            { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
            { name: 'extKeyUsage', serverAuth: true },
            { name: 'subjectAltName', altNames: names.map((n) => (n.ip ? { type: 7, ip: n.name } : { type: 2, value: n.name })) },
          ],
        });
      } catch (e) {
        throw new HttpError(400, 'Could not create the certificate: ' + String(e?.message || e).slice(0, 200));
      }
      mat = { cert: pems.cert, key: pems.private };
      files = { cert: pems.cert, key: pems.private };
    } else {
      throw new HttpError(400, 'type must be pem, pfx or self-signed');
    }

    const info = inspectMaterial(mat); // throws a friendly 400 if unusable
    assertCurrent(info); // an expired (or not yet valid) certificate would be refused by every browser
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (files.pfx) {
      writeSecureFile(this.#file('pfx'), files.pfx);
      for (const f of ['cert', 'key']) fs.rmSync(this.#file(f), { force: true });
    } else {
      writeSecureFile(this.#file('cert'), files.cert);
      writeSecureFile(this.#file('key'), files.key);
      fs.rmSync(this.#file('pfx'), { force: true });
    }
    this.#save({
      source: type,
      pfxSource: !!files.pfx,
      pfxPass: pfxPass ? encrypt(this.accounts.secret, pfxPass) : '',
      uploadedAt: new Date().toISOString(),
      uploadedBy: by || null,
    });
    await this.apply();
    const installed = { ...info };
    delete installed.pem;
    this.logEvent({ action: 'upload', ok: true, by: by || null, source: type, subject: info.subject, validTo: info.validTo });
    return { ...this.state(), installed };
  }

  async remove() {
    if (this.settings().mode !== 'off') throw new HttpError(400, 'Turn HTTPS off before removing the certificate');
    for (const f of Object.keys(FILES)) fs.rmSync(this.#file(f), { force: true });
    this.#save({ source: null, pfxPass: '', uploadedAt: null, uploadedBy: null, pfxSource: false });
    await this.apply();
    return this.state();
  }

  certificatePem() {
    if (!this.info) {
      const mat = this.material();
      if (mat) this.info = inspectMaterial(mat);
    }
    return this.info?.pem || null;
  }

  /** Should this plain-HTTP request be sent to HTTPS? */
  redirectTarget(req) {
    if (this.mode !== 'redirect' || !this.listening) return null;
    if (safeProto(req) === 'https') return null; // already HTTPS (directly or via a trusted proxy)
    const url = req.url;
    if (url === '/health' || url.startsWith('/health?')) return null; // keep container health checks on HTTP
    if (url.startsWith('/.well-known/acme-challenge/')) return null; // Let's Encrypt checks over plain HTTP
    const port = this.publicPort;
    // The Host header is the caller's to choose: only redirect to something that is a plain host name,
    // never to what could be a user name, path or another site (a@evil.com, evil.com/@x ...).
    const rawHost = String(req.hostname || req.headers.host || '');
    if (!HOST_RE.test(rawHost.replace(/_/g, 'x'))) return false; // underscores are harmless and common in intranet names
    const host = rawHost.replace(/:\d+$/, '');
    return `https://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}${port === 443 ? '' : ':' + port}${url}`;
  }
}
