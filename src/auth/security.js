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
}

/**
 * Only allow redirects to a path on this site. Rejects absolute URLs, protocol-relative
 * paths ("//evil"), backslashes ("/\evil", which browsers treat as "//"), and control
 * characters (browsers strip tabs/newlines, so "/\t/evil" would become "//evil").
 */
export function safeReturnTo(value, fallback = '/') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 2048) return fallback;
  if (value.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(value)) return fallback;
  try {
    const u = new URL(value, 'http://this.host');
    if (u.origin !== 'http://this.host') return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}
