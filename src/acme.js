import { domainToASCII } from 'node:url';
import { HttpError } from './store.js';
import { encrypt, decrypt } from './auth/security.js';

/**
 * Automatic certificates over ACME (Let's Encrypt, or any ACME CA) with the HTTP-01 challenge.
 *
 * How it works: the CA asks for http://<domain>/.well-known/acme-challenge/<token> on port 80.
 * This server answers that path on its HTTP listener (also in "HTTPS only" mode, which redirects
 * everything else), so port 80 on each domain must reach this server's HTTP port, e.g. Docker
 * "80:3000". Behind a reverse proxy that already gets certificates (Caddy, Traefik...) you don't
 * need this.
 *
 * Renewal: checked every few hours; a certificate is renewed when a third of its lifetime is left
 * (30 days for Let's Encrypt's 90-day certificates). Failures retry with a growing delay (1 hour
 * up to a day) and show in Admin → HTTPS and the certificate history.
 *
 * Stored in the settings table: domains, email, CA, the ACME account key (encrypted with the app
 * secret) and the account URL, plus the last result. The certificate itself goes into the data
 * volume like any other (source "acme").
 */
export const ACME_DIRECTORIES = {
  letsencrypt: 'https://acme-v02.api.letsencrypt.org/directory',
  'letsencrypt-staging': 'https://acme-staging-v02.api.letsencrypt.org/directory',
};
const DEFAULTS = {
  enabled: false, domains: [], email: '', ca: 'letsencrypt', directoryUrl: '', eabKid: '', eabHmac: '',
  keyType: 'ecdsa', accountKey: '', accountUrl: '', accountFor: '',
  lastAttempt: null, lastSuccess: null, lastError: null, failures: 0, nextAttempt: null,
};
const CHECK_EVERY_MS = 6 * 3600_000;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
// Names that only exist on a local network: a public CA can never check them.
const PRIVATE_SUFFIXES = ['local', 'lan', 'internal', 'localhost', 'home.arpa', 'localdomain', 'intranet', 'corp', 'home'];

/** Normalise one domain for a certificate (IDN → punycode). Throws HttpError(400) with a clear reason. */
export function acmeDomain(input) {
  const d = String(input).trim().toLowerCase().replace(/\.$/, '');
  const show = d.slice(0, 80);
  if (d.startsWith('*.')) throw new HttpError(400, 'Wildcard names need the DNS-01 challenge, which isn\'t supported. List each name instead.');
  if (/^[\d.]+$/.test(d) || d.includes(':')) throw new HttpError(400, `IP addresses can't get certificates this way, only domain names: ${show}`);
  // International names (bücher.example) are requested in their ASCII (punycode) form.
  const ascii = /[^\x00-\x7f]/.test(d) ? domainToASCII(d) : d;
  if (!ascii) throw new HttpError(400, `Not a valid domain name: ${show}`);
  if (!ascii.includes('.')) throw new HttpError(400, `Use the full public domain name, not "${show}" (names like "localhost" or "server" can't get certificates)`);
  if (PRIVATE_SUFFIXES.some((x) => ascii === x || ascii.endsWith('.' + x))) {
    throw new HttpError(400, `${show} is a local-network name; a public certificate authority can only issue for domains registered on the internet`);
  }
  if (!DOMAIN_RE.test(ascii)) throw new HttpError(400, `Not a valid public domain name: ${show} (use letters, numbers and dashes, separated by dots)`);
  return ascii;
}

export class AcmeManager {
  constructor({ accounts, tls, log = console, checkEveryMs = CHECK_EVERY_MS, loadClient }) {
    this.accounts = accounts;
    this.tls = tls;
    this.log = log;
    this.challenges = new Map(); // token -> key authorization
    this.running = null;         // the order in progress, if any
    this.progress = null;        // what it's doing right now, for the admin page
    this.loadClient = loadClient || (async () => (await import('acme-client')).default);
    if (checkEveryMs > 0) {
      this.timer = setInterval(() => this.tick().catch(() => {}), checkEveryMs);
      this.timer.unref();
      // First check shortly after start (not during it), so a lapsed certificate is fixed quickly.
      this.startTimer = setTimeout(() => this.tick().catch(() => {}), 30_000);
      this.startTimer.unref();
    }
  }

  close() { clearInterval(this.timer); clearTimeout(this.startTimer); }

  #raw() { return { ...DEFAULTS, ...this.accounts.getSetting('acme', {}) }; }
  #save(patch) { this.accounts.setSetting('acme', { ...this.#raw(), ...patch }); }

  directoryUrl(s = this.#raw()) {
    return s.ca === 'custom' ? s.directoryUrl : ACME_DIRECTORIES[s.ca] || ACME_DIRECTORIES.letsencrypt;
  }

  /** Settings and status for the admin page (no secrets). */
  state() {
    const s = this.#raw();
    const cert = this.tls.current();
    const active = this.tls.settings().source === 'acme';
    return {
      enabled: s.enabled, domains: s.domains, email: s.email, ca: s.ca, directoryUrl: s.directoryUrl,
      eabKid: s.eabKid, eabHmacSet: Boolean(s.eabHmac), keyType: s.keyType,
      account: s.accountUrl || null,
      lastAttempt: s.lastAttempt, lastSuccess: s.lastSuccess, lastError: s.lastError, nextAttempt: s.nextAttempt,
      running: Boolean(this.running), progress: this.progress,
      active, renewAt: active && cert ? this.#renewAt(cert).toISOString() : null,
    };
  }

  update(body = {}) {
    const s = this.#raw();
    const patch = {};
    if ('domains' in body) {
      const list = (Array.isArray(body.domains) ? body.domains : String(body.domains || '').split(/[\s,]+/))
        .map((d) => String(d).trim()).filter(Boolean);
      if (list.length > 100) throw new HttpError(400, 'At most 20 domains');
      const unique = [...new Set(list.map(acmeDomain))];
      if (unique.length > 20) throw new HttpError(400, 'At most 20 domains');
      patch.domains = unique;
    }
    if ('email' in body) {
      const e = String(body.email || '').trim();
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, 'Enter a valid email address, or leave it empty');
      patch.email = e;
    }
    if ('ca' in body) {
      if (!['letsencrypt', 'letsencrypt-staging', 'custom'].includes(body.ca)) throw new HttpError(400, 'Unknown certificate authority');
      patch.ca = body.ca;
    }
    if ('directoryUrl' in body) {
      const u = String(body.directoryUrl || '').trim();
      if (u) {
        let url;
        try { url = new URL(u); } catch { throw new HttpError(400, 'The ACME directory must be a full https:// address'); }
        if (url.protocol !== 'https:') throw new HttpError(400, 'The ACME directory must use https://');
      }
      patch.directoryUrl = u;
    }
    if ('eabKid' in body) patch.eabKid = String(body.eabKid || '').trim().slice(0, 500);
    if ('eabHmac' in body && body.eabHmac !== undefined) {
      const h = String(body.eabHmac || '').trim();
      if (h && !/^[A-Za-z0-9_\-+/=]{16,500}$/.test(h)) throw new HttpError(400, 'The EAB HMAC key should be base64url text');
      patch.eabHmac = h ? encrypt(this.accounts.secret, h) : '';
    }
    if ('keyType' in body) {
      if (!['ecdsa', 'rsa'].includes(body.keyType)) throw new HttpError(400, 'Key type must be ecdsa or rsa');
      patch.keyType = body.keyType;
    }
    if (body.enabled === true && !s.enabled && body.agreeTos !== true) throw new HttpError(400, 'Accept the certificate authority\'s terms of service to continue');
    if ('enabled' in body) patch.enabled = body.enabled === true;
    if (body.enabled === true && body.agreeTos === true) patch.tosAgreedAt = new Date().toISOString();
    const next = { ...s, ...patch };
    if (next.ca === 'custom' && !next.directoryUrl && next.enabled) throw new HttpError(400, 'Enter the ACME directory address for your certificate authority');
    if (next.enabled && !next.domains.length) throw new HttpError(400, 'Enter at least one domain name');
    // A different CA (or EAB key) needs a new ACME account. EAB keys belong to one CA, so they're
    // cleared when the CA changes unless new ones come with the change.
    const caChanged = this.directoryUrl(next) !== this.directoryUrl(s);
    if (caChanged && !('eabKid' in body)) Object.assign(patch, { eabKid: '', eabHmac: '' });
    if (caChanged || (patch.eabKid ?? s.eabKid) !== s.eabKid) Object.assign(patch, { accountKey: '', accountUrl: '', accountFor: '' });
    if (patch.enabled === true || patch.domains || patch.ca || patch.directoryUrl !== undefined) Object.assign(patch, { failures: 0, nextAttempt: null });
    this.#save(patch);
    return this.state();
  }

  /** The HTTP-01 response for a token, or null. */
  challengeResponse(token) { return this.challenges.get(String(token)) || null; }

  #renewAt(cert) {
    const from = new Date(cert.validFrom).getTime();
    const to = new Date(cert.validTo).getTime();
    return new Date(to - Math.max((to - from) / 3, 24 * 3600_000));
  }

  /** Is a new certificate needed now? */
  due() {
    const s = this.#raw();
    if (!s.enabled || !s.domains.length) return false;
    if (s.nextAttempt && Date.now() < Date.parse(s.nextAttempt)) return false;
    const cert = this.tls.current();
    if (!cert || this.tls.settings().source !== 'acme') return true;
    const names = cert.names.map((n) => n.toLowerCase());
    if (s.domains.some((d) => !names.includes(d))) return true; // the domain list changed
    return Date.now() >= this.#renewAt(cert).getTime();
  }

  async tick() {
    if (this.running || !this.due()) return null;
    return this.obtain('renewal').catch(() => null);
  }

  /**
   * Get a certificate now (from the admin page, or when renewal is due). One at a time. Only when
   * automatic certificates are turned on, which needs the CA's terms to have been accepted.
   */
  obtain(reason = 'requested') {
    if (this.running) return this.running;
    const s = this.#raw();
    // Turning it on is only possible after accepting the terms (recorded as tosAgreedAt).
    if (!s.enabled) return Promise.reject(new HttpError(409, 'Turn on automatic certificates (and accept the certificate authority\'s terms) first'));
    this.running = this.#obtain(reason).finally(() => { this.running = null; this.progress = null; });
    return this.running;
  }

  async #obtain(reason) {
    const s = this.#raw();
    if (!s.domains.length) throw new HttpError(400, 'Enter at least one domain name first');
    const dirUrl = this.directoryUrl(s);
    if (!dirUrl) throw new HttpError(400, 'Enter the ACME directory address first');
    this.#save({ lastAttempt: new Date().toISOString() });
    const step = (msg) => { this.progress = msg; this.log.info?.(`ACME: ${msg}`); };
    try {
      const acme = await this.loadClient();
      step('Preparing the ACME account');
      let accountKey = s.accountKey ? decrypt(this.accounts.secret, s.accountKey) : '';
      if (!accountKey) {
        accountKey = (await acme.crypto.createPrivateEcdsaKey('P-256')).toString();
        this.#save({ accountKey: encrypt(this.accounts.secret, accountKey), accountUrl: '', accountFor: dirUrl });
      }
      const opts = { directoryUrl: dirUrl, accountKey, backoffAttempts: 10, backoffMin: 2000, backoffMax: 15000 };
      const hmac = s.eabHmac ? decrypt(this.accounts.secret, s.eabHmac) : '';
      if (s.eabKid && hmac) opts.externalAccountBinding = { kid: s.eabKid, hmacKey: hmac };
      if (s.accountUrl) opts.accountUrl = s.accountUrl;
      const client = new acme.Client(opts);

      step(`Creating a ${s.keyType === 'rsa' ? 'RSA' : 'ECDSA'} key and certificate request for ${s.domains.join(', ')}`);
      const key = s.keyType === 'rsa' ? await acme.crypto.createPrivateRsaKey(2048) : await acme.crypto.createPrivateEcdsaKey('P-256');
      const [, csr] = await acme.crypto.createCsr({ commonName: s.domains[0], altNames: s.domains }, key);

      step(`Asking ${new URL(dirUrl).host} for a certificate`);
      const cert = await client.auto({
        csr,
        email: s.email || undefined,
        termsOfServiceAgreed: true,
        challengePriority: ['http-01'],
        // The CA checks from the internet; a self-check from here often fails behind NAT.
        skipChallengeVerification: true,
        challengeCreateFn: async (authz, challenge, keyAuthorization) => {
          if (challenge.type !== 'http-01') throw new Error(`Only HTTP-01 is supported (offered: ${challenge.type})`);
          step(`Waiting for ${authz.identifier.value} to be checked over http://…/.well-known/acme-challenge/`);
          this.challenges.set(challenge.token, keyAuthorization);
        },
        challengeRemoveFn: async (authz, challenge) => { this.challenges.delete(challenge.token); },
      });
      try { this.#save({ accountUrl: client.getAccountUrl() }); } catch { /* not created */ }

      step('Installing the certificate');
      const r = await this.tls.installPem({ cert, key: key.toString(), source: 'acme', by: `ACME (${new URL(dirUrl).host})` });
      this.#save({ lastSuccess: new Date().toISOString(), lastError: null, failures: 0, nextAttempt: null });
      this.tls.logEvent({ action: 'acme', ok: true, by: new URL(dirUrl).host, reason, subject: r.installed.subject, validTo: r.installed.validTo });
      return r;
    } catch (e) {
      const failures = (this.#raw().failures || 0) + 1;
      const wait = Math.min(24 * 3600_000, 3600_000 * 2 ** (failures - 1));
      const msg = acmeError(e);
      this.#save({ lastError: msg, failures, nextAttempt: new Date(Date.now() + wait).toISOString() });
      this.tls.logEvent({ action: 'acme', ok: false, by: safeHost(dirUrl), reason, error: msg });
      this.log.warn?.(`ACME: ${msg}`);
      throw new HttpError(502, msg);
    } finally {
      this.challenges.clear();
    }
  }
}

function safeHost(u) { try { return new URL(u).host; } catch { return u; } }

/** Plain-language message for common ACME failures. */
function acmeError(e) {
  const m = String(e?.message || e);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|socket hang up/i.test(m) && !/urn:ietf/.test(m)) return `Couldn't reach the certificate authority: ${m}`;
  if (/unauthorized|Invalid response from|Timeout during connect|Connection refused|404/i.test(m)) {
    return `The certificate authority couldn't fetch the challenge from your domain over http:// (port 80). Check that the domain points to this server and port 80 is forwarded to its HTTP port. Details: ${m}`;
  }
  if (/rateLimited|too many/i.test(m)) return `Rate limited by the certificate authority; try again later (or use staging while testing). Details: ${m}`;
  if (/rejectedIdentifier|caa/i.test(m)) return `The certificate authority won't issue for this name (check CAA records). Details: ${m}`;
  if (/externalAccountRequired|eab/i.test(m)) return `This certificate authority needs External Account Binding (EAB key ID and HMAC key). Details: ${m}`;
  return m;
}

export function registerAcme(app, { acme }) {
  // Public: the CA fetches this over plain HTTP. Only tokens of an order in progress answer.
  app.get('/.well-known/acme-challenge/:token', { config: { cap: 'public' } }, async (req, reply) => {
    const v = acme.challengeResponse(req.params.token);
    if (!v) return reply.code(404).type('text/plain').send('Not found');
    return reply.type('text/plain').header('cache-control', 'no-store').send(v);
  });
  const cap = { config: { cap: 'tls' } };
  app.get('/api/admin/tls/acme', cap, async () => acme.state());
  app.put('/api/admin/tls/acme', cap, async (req) => acme.update(req.body || {}));
  // Starts the order and waits for it (usually 5-30 seconds).
  app.post('/api/admin/tls/acme/obtain', cap, async (req) => {
    const r = await acme.obtain('requested from Admin → HTTPS by ' + (req.auth.user?.username || req.auth.name));
    return { ok: true, installed: r.installed, tls: r, acme: acme.state() };
  });
}
