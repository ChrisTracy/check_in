import crypto from 'node:crypto';
import net from 'node:net';
import { HttpError } from './store.js';
import { inspectMaterial } from './tls.js';

/**
 * Certificate deploy keys: let automation (a certbot deploy hook, a CI job, a key vault task)
 * replace the HTTPS certificate, and do nothing else.
 *
 *   PUT /api/tls/certificate        header  X-Deploy-Key: ckd_...
 *     body, any of:
 *       application/x-pem-file   the certificate chain and the private key in one PEM file
 *                                (cat fullchain.pem privkey.pem | curl --data-binary @- ...)
 *       application/json         { "cert": "<PEM chain>", "key": "<PEM key>" }
 *                                or { "pfx": "<base64>", "passphrase": "..." }
 *       application/x-pkcs12     a .pfx / .p12 file, password in the X-Pfx-Password header
 *     ?force=1                   skip the safety checks below
 *
 * Safety checks (skipped with ?force=1): the new certificate must not expire before the one it
 * replaces, and must share at least one name with it (when the current one is from a real CA).
 * Every attempt is logged in the certificate history (Admin → HTTPS).
 *
 * Keys are made in Admin → HTTPS, shown once, stored as SHA-256 hashes, and can be limited to
 * addresses or ranges (e.g. 10.0.0.5, 10.0.0.0/24, 2001:db8::/48).
 */
const MAX_KEYS = 20;
const FAIL_LIMIT = 10;              // bad keys per address ...
const FAIL_WINDOW_MS = 10 * 60_000; // ... per 10 minutes, then 429
const hash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
const plainIp = (ip) => (ip && ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip);

/** Parse "10.0.0.5, 10.0.0.0/24, 2001:db8::/48" into a clean list. Throws 400 on anything else. */
export function parseAllowList(value) {
  const parts = (Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);
  if (parts.length > 50) throw new HttpError(400, 'At most 50 addresses or ranges');
  for (const p of parts) {
    const [ip, bits, extra] = p.split('/');
    const v = net.isIP(ip);
    const max = v === 4 ? 32 : 128;
    if (!v || extra !== undefined || (bits !== undefined && (!/^\d{1,3}$/.test(bits) || Number(bits) > max))) {
      throw new HttpError(400, `Not an IP address or range: ${p.slice(0, 60)}`);
    }
  }
  return parts;
}

function allowed(list, ip) {
  if (!list?.length) return true;
  const addr = plainIp(ip);
  const type = net.isIP(addr);
  if (!type) return false;
  const bl = new net.BlockList();
  for (const p of list) {
    const [a, bits] = p.split('/');
    const t = net.isIP(a) === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) bl.addAddress(a, t); else bl.addSubnet(a, Number(bits), t);
  }
  return bl.check(addr, type === 6 ? 'ipv6' : 'ipv4');
}

/** Split a combined PEM into the certificate chain and the private key. */
export function splitPem(text) {
  const s = String(text || '');
  const certs = s.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  const key = (s.match(/-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]+?-----END \1PRIVATE KEY-----/) || [])[0] || '';
  return { cert: certs.join('\n') + (certs.length ? '\n' : ''), key: key ? key + '\n' : '' };
}

export class CertDeployKeys {
  constructor({ accounts, tls }) {
    this.accounts = accounts;
    this.tls = tls;
    this.fails = new Map(); // ip -> { count, reset }
  }

  #all() { return this.accounts.getSetting('tlsDeployKeys', []); }
  #save(list) { this.accounts.setSetting('tlsDeployKeys', list); }

  list() {
    return this.#all().map(({ hash: _h, ...k }) => k);
  }

  create({ name, allowIps }, by) {
    const n = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!n) throw new HttpError(400, 'Give the key a name, e.g. "certbot on web-01"');
    if (n.length > 60) throw new HttpError(400, 'Name must be 60 characters or fewer');
    const list = this.#all();
    if (list.length >= MAX_KEYS) throw new HttpError(400, `At most ${MAX_KEYS} deploy keys`);
    const key = 'ckd_' + crypto.randomBytes(32).toString('base64url');
    const entry = {
      id: crypto.randomBytes(6).toString('hex'), name: n, prefix: key.slice(0, 10), hash: hash(key),
      allowIps: parseAllowList(allowIps), created: new Date().toISOString(), createdBy: by || null,
      lastUsed: null, lastIp: null, uses: 0,
    };
    this.#save([...list, entry]);
    const { hash: _h, ...pub } = entry;
    return { key, deployKey: pub };
  }

  update(id, { name, allowIps }) {
    const list = this.#all();
    const k = list.find((x) => x.id === id);
    if (!k) throw new HttpError(404, 'Deploy key not found');
    if (name !== undefined) {
      const n = String(name).trim().replace(/\s+/g, ' ');
      if (!n || n.length > 60) throw new HttpError(400, 'Name must be 1-60 characters');
      k.name = n;
    }
    if (allowIps !== undefined) k.allowIps = parseAllowList(allowIps);
    this.#save(list);
    const { hash: _h, ...pub } = k;
    return pub;
  }

  revoke(id) {
    const list = this.#all();
    if (!list.some((k) => k.id === id)) throw new HttpError(404, 'Deploy key not found');
    this.#save(list.filter((k) => k.id !== id));
  }

  /** The key entry for this request, or a thrown 401/403/429. */
  authenticate(req) {
    const ip = plainIp(req.ip);
    const now = Date.now();
    let f = this.fails.get(ip);
    if (f && f.reset <= now) { this.fails.delete(ip); f = null; }
    if (f && f.count >= FAIL_LIMIT) throw new HttpError(429, 'Too many bad deploy keys from this address; try again later');
    const given = String(req.headers['x-deploy-key'] || '');
    const want = given ? hash(given) : '';
    const entry = given && this.#all().find((k) => crypto.timingSafeEqual(Buffer.from(k.hash, 'hex'), Buffer.from(want, 'hex')));
    if (!entry) {
      const e = f || { count: 0, reset: now + FAIL_WINDOW_MS };
      e.count++;
      this.fails.set(ip, e);
      if (this.fails.size > 10_000) for (const [k, v] of this.fails) if (v.reset <= now) this.fails.delete(k);
      throw new HttpError(401, given ? 'Invalid deploy key' : 'Send the deploy key in the X-Deploy-Key header');
    }
    if (!allowed(entry.allowIps, ip)) throw new HttpError(403, `This deploy key can't be used from ${ip}`);
    return entry;
  }

  #touch(id, ip) {
    const list = this.#all();
    const k = list.find((x) => x.id === id);
    if (!k) return;
    k.lastUsed = new Date().toISOString();
    k.lastIp = ip;
    k.uses = (k.uses || 0) + 1;
    this.#save(list);
  }

  /** The request body as { cert, key } PEM or { pfx, passphrase }. */
  static material(req) {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const body = req.body;
    if (ct === 'application/x-pkcs12' || ct === 'application/x-pfx') {
      if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'Send the .pfx file as the request body');
      return { pfx: body, passphrase: String(req.headers['x-pfx-password'] || '') };
    }
    if (ct === 'application/json' && body && typeof body === 'object') {
      if (body.pfx) return { pfx: Buffer.from(String(body.pfx), 'base64'), passphrase: String(body.passphrase || '') };
      if (body.cert && !body.key) return splitPem(body.cert);
      return { cert: String(body.cert || ''), key: String(body.key || '') };
    }
    if (typeof body === 'string') return splitPem(body);
    throw new HttpError(415, 'Send a PEM file (application/x-pem-file), JSON {cert, key} or a .pfx (application/x-pkcs12)');
  }

  async deploy(req) {
    const entry = this.authenticate(req);
    const ip = plainIp(req.ip);
    const by = `deploy key "${entry.name}"`;
    try {
      const mat = CertDeployKeys.material(req);
      const force = req.query.force === '1' || req.query.force === 'true';
      if (!force) this.#safetyChecks(mat);
      const r = mat.pfx
        ? await this.tls.installPfx({ pfx: mat.pfx, passphrase: mat.passphrase, source: 'deploy', by })
        : await this.tls.installPem({ cert: mat.cert, key: mat.key, source: 'deploy', by });
      this.#touch(entry.id, ip);
      this.tls.logEvent({ action: 'deploy', ok: true, by, ip, subject: r.installed.subject, validTo: r.installed.validTo, forced: force || undefined });
      return {
        ok: true,
        installed: r.installed,
        https: r.listening ? `reloaded on port ${r.listeningPort}` : 'HTTPS is off; the certificate is saved and used when it is turned on',
      };
    } catch (e) {
      this.tls.logEvent({ action: 'deploy', ok: false, by, ip, error: e.message });
      throw e;
    }
  }

  #safetyChecks(mat) {
    const cur = this.tls.current();
    if (!cur || cur.expired || cur.selfSigned) return;
    let next;
    try {
      next = mat.pfx ? inspectMaterial({ pfx: mat.pfx, passphrase: mat.passphrase }) : inspectMaterial({ cert: mat.cert, key: mat.key });
    } catch { return; } // the install step reports unreadable certificates properly
    if (new Date(next.validTo) < new Date(cur.validTo)) {
      throw new HttpError(409, `The new certificate expires ${next.validTo.slice(0, 10)}, before the current one (${cur.validTo.slice(0, 10)}). Add ?force=1 to install it anyway.`);
    }
    const lower = (a) => a.map((n) => n.toLowerCase());
    // A name is covered by an exact match or a wildcard one level up (*.example.com covers a.example.com).
    const covers = (names, n) => names.some((m) => m === n || (m.startsWith('*.') && n.endsWith(m.slice(1)) && !n.slice(0, n.length - m.length + 1).includes('.')));
    // Shared if any name of one is covered by the other (either way round, for wildcards).
    const shared = lower(cur.names).some((n) => covers(lower(next.names), n)) || lower(next.names).some((n) => covers(lower(cur.names), n));
    if (cur.names.length && next.names.length && !shared) {
      throw new HttpError(409, `The new certificate (${next.names.join(', ')}) shares no names with the current one (${cur.names.join(', ')}). Add ?force=1 to install it anyway.`);
    }
  }
}
