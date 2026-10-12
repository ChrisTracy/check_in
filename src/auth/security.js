import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** scrypt password hash: "scrypt$<salt>$<hash>" */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password).normalize('NFKC'), salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) {
    // Burn comparable time so missing users can't be detected by timing.
    await scrypt('x', 'saltsaltsaltsalt', 64, SCRYPT);
    return false;
  }
  const [, saltB64, hashB64] = stored.split('$');
  const expected = Buffer.from(hashB64, 'base64url');
  const key = await scrypt(String(password).normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(key, expected);
}

export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters';
  if (pw.length > 256) return 'Password is too long';
  return null;
}

/**
 * App secret used to encrypt stored secrets (e.g. the SSO client secret) and
 * short-lived cookies. Taken from APP_SECRET, otherwise generated once and kept
 * next to the database.
 */
export function loadAppSecret(envSecret, dbPath) {
  if (envSecret) return crypto.createHash('sha256').update(envSecret).digest();
  const file = path.join(dbPath === ':memory:' ? process.cwd() : path.dirname(dbPath), '.app-secret');
  if (dbPath === ':memory:') return crypto.randomBytes(32);
  try {
    return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  } catch {
    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
    return key;
  }
}

export function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url');
}

export function decrypt(key, token) {
  try {
    const buf = Buffer.from(String(token), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Simple fixed-window limiter for login attempts. */
export class RateLimiter {
  constructor({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
    }, 60_000).unref();
  }
  blocked(key) {
    const h = this.hits.get(key);
    return h && h.reset > Date.now() && h.count >= this.max;
  }
  fail(key) {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < now) this.hits.set(key, { count: 1, reset: now + this.windowMs });
    else h.count++;
  }
  clear(key) { this.hits.delete(key); }
  #count(key) {
    const h = this.hits.get(key);
    return h && h.reset > Date.now() ? h.count : 0;
  }
  /**
   * Run a (slow) password check under the limit. Checks already running count against the
   * allowance, so a burst of parallel guesses can't all start before the first failure is
   * recorded; extra requests wait for a slot instead of being refused, so parallel CORRECT
   * sign-ins still all succeed. `check` resolves truthy on success; a falsy result counts as a
   * failure on every key. Returns { blocked: true } when a key is over the limit.
   */
  async guard(keys, check) {
    this.inflight ??= new Map();
    this.waiters ??= new Map();
    const busy = (k) => this.inflight.get(k) || 0;
    for (;;) {
      if (keys.some((k) => this.blocked(k))) return { blocked: true };
      if (keys.every((k) => this.#count(k) + busy(k) < this.max)) break;
      await new Promise((resolve) => { for (const k of keys) { if (!this.waiters.has(k)) this.waiters.set(k, []); this.waiters.get(k).push(resolve); } });
    }
    for (const k of keys) this.inflight.set(k, busy(k) + 1);
    try {
      const result = await check();
      if (!result) for (const k of keys) this.fail(k);
      return { result };
    } finally {
      for (const k of keys) {
        const n = busy(k) - 1;
        if (n > 0) this.inflight.set(k, n); else this.inflight.delete(k);
        const w = this.waiters.get(k);
        if (w) { this.waiters.delete(k); for (const resolve of w) resolve(); }
      }
    }
  }
}

/**
 * Only allow redirects to a path on this site. Rejects absolute URLs, protocol-relative
 * paths ("//evil"), backslashes ("/\evil", which browsers treat as "//"), and control
 * characters (browsers strip tabs/newlines, so "/\t/evil" would become "//evil").
 */
// Addresses a reverse proxy normally talks to the app from (Docker networks, the host, a LAN).
const PRIVATE = new net.BlockList();
for (const [a, b] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['169.254.0.0', 16], ['100.64.0.0', 10]]) PRIVATE.addSubnet(a, b, 'ipv4');
for (const [a, b] of [['fc00::', 7], ['fe80::', 10], ['::1', 128]]) PRIVATE.addSubnet(a, b, 'ipv6');
export function isPrivateAddress(ip) {
  let a = String(ip || '');
  if (a.startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7);
  const v = net.isIP(a);
  return v ? PRIVATE.check(a, v === 6 ? 'ipv6' : 'ipv4') : false;
}

/**
 * Fastify's trustProxy for TRUST_PROXY. A hop count N (Fastify 5 ignores plain numbers) trusts
 * the N proxies nearest the app, so the client address is the one the outermost of them added
 * and anything a client wrote further left in X-Forwarded-For is ignored. The proxy right in
 * front must connect from a private / loopback address, so a client reaching the app directly
 * over the internet can't pretend to be a proxy. Address lists are passed through unchanged.
 */
export function trustProxyOption(v) {
  if (typeof v === 'number' && v > 0) return (addr, i) => i < v && (i > 0 || isPrivateAddress(addr));
  return v;
}

/** The request's scheme, never anything but "http" or "https" (X-Forwarded-Proto is client-controlled). */
export const safeProto = (req) => (String(req.protocol || '').trim().toLowerCase() === 'https' ? 'https' : 'http');

export function safeReturnTo(value, fallback = '/') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 2048) return fallback;
  if (value.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(value)) return fallback;
  try {
    const u = new URL(value, 'http://this.host');
    if (u.origin !== 'http://this.host') return fallback;
    const out = u.pathname + u.search + u.hash;
    // The URL parser tidies "/.//evil.com" or "/%2e//evil.com" into "//evil.com", which a browser
    // treats as another site: check the result again, not just the input.
    if (!out.startsWith('/') || out.startsWith('//') || out.includes('\\')) return fallback;
    return out;
  } catch {
    return fallback;
  }
}
