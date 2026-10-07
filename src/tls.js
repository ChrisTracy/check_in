import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
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

function derToPem(der) {
  const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

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
    subject: subjectCN,
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
    if (s.source === 'pfx' && this.#exists('pfx')) {
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
    if (this.mode !== 'off') {
      this.log.info?.('TLS files changed on disk, reloading certificate');
      await this.apply().catch(() => {});
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
    };
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
    } else if (type === 'self-signed') {
      const names = (Array.isArray(body.hostnames) ? body.hostnames : String(body.hostnames || '').split(/[\s,]+/))
        .map((h) => String(h).trim()).filter(Boolean);
      if (!names.length) throw new HttpError(400, 'Enter at least one host name or IP address');
      if (names.some((n) => !/^[A-Za-z0-9.*:-]{1,253}$/.test(n))) throw new HttpError(400, 'Host names may contain only letters, numbers, dots, dashes, colons and *');
      const days = Math.min(Math.max(Number(body.days) || 365, 1), 3650);
      const { generate } = await import('selfsigned');
      const isIp = (n) => /^\d{1,3}(\.\d{1,3}){3}$/.test(n) || n.includes(':');
      const pems = await generate([{ name: 'commonName', value: names[0] }], {
        days,
        keySize: 2048,
        algorithm: 'sha256',
        extensions: [
          { name: 'basicConstraints', cA: false },
          { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
          { name: 'extKeyUsage', serverAuth: true },
          { name: 'subjectAltName', altNames: names.map((n) => (isIp(n) ? { type: 7, ip: n } : { type: 2, value: n })) },
        ],
      });
      mat = { cert: pems.cert, key: pems.private };
      files = { cert: pems.cert, key: pems.private };
    } else {
      throw new HttpError(400, 'type must be pem, pfx or self-signed');
    }

    const info = inspectMaterial(mat); // throws a friendly 400 if unusable
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
      pfxPass: pfxPass ? encrypt(this.accounts.secret, pfxPass) : '',
      uploadedAt: new Date().toISOString(),
      uploadedBy: by || null,
    });
    await this.apply();
    const installed = { ...info };
    delete installed.pem;
    return { ...this.state(), installed };
  }

  async remove() {
    if (this.settings().mode !== 'off') throw new HttpError(400, 'Turn HTTPS off before removing the certificate');
    for (const f of Object.keys(FILES)) fs.rmSync(this.#file(f), { force: true });
    this.#save({ source: null, pfxPass: '', uploadedAt: null, uploadedBy: null });
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
    if (req.protocol === 'https') return null; // already HTTPS (directly or via a trusted proxy)
    const url = req.url;
    if (url === '/health' || url.startsWith('/health?')) return null; // keep container health checks on HTTP
    const port = this.publicPort;
    const host = (req.hostname || 'localhost').replace(/:\d+$/, '');
    return `https://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}${port === 443 ? '' : ':' + port}${url}`;
  }
}
