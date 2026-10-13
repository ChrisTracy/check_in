import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HttpError } from '../store.js';
import { hashPassword, verifyPassword, passwordProblem, randomToken, sha256, encrypt, decrypt, MAX_USERNAME_LEN, MAX_PASSWORD_LEN } from './security.js';

export const ROLES = {
  reader: { level: 1, label: 'Reader' },
  user: { level: 2, label: 'User' },
  power: { level: 3, label: 'Power user' },
  admin: { level: 4, label: 'Admin' },
};
export const roleLevel = (r) => ROLES[r]?.level || 0;

/** Minimum role per capability. Keep in sync with the dashboard (public/app.js). */
export const CAPS = {
  view: 'reader',
  checkin: 'user',
  import: 'user',
  export: 'user',
  delete: 'user',
  clearAll: 'power',
  pause: 'power',
  threshold: 'power',
  teamViews: 'power',
  boxes: 'power',         // set up the status boxes everyone sees
  apiKey: 'power',        // view and regenerate the API key
  apiKeyPolicy: 'admin',  // use a custom key, or stop requiring one
  portCheckPolicy: 'admin', // turn port checks on or off
  issues: 'reader',       // see the issues list (when an admin has turned it on)
  issueWork: 'user',      // assign, ignore, close and add notes to issues
  issueRules: 'power',    // define what an issue is, the reassign window, clear all issues
  issuesEnable: 'admin',  // turn the issues list on or off
  alerts: 'admin',        // send new-issue alerts through an Apprise server
  loadTest: 'admin',      // the load test page: a simulated fleet inside the server
  sso: 'admin',
  users: 'admin',
  tls: 'admin',
  settingsView: 'power', // see the admin settings (read only); changing them still needs the capability above
};
export const can = (role, cap) => roleLevel(role) >= roleLevel(CAPS[cap]);
export const capsFor = (role) => Object.fromEntries(Object.keys(CAPS).map((c) => [c, can(role, c)]));

const USERNAME_RE = /^[A-Za-z0-9._@+-]{2,128}$/;

/** Why a custom API key can't be used by devices (they send it in a header / URL), or null. */
export function apiKeyProblem(key) {
  if (typeof key !== 'string' || !key) return 'API key is required';
  if (!/^[\x21-\x7e]+$/.test(key)) return 'API key may only contain printable ASCII characters (letters, numbers, punctuation) and no spaces';
  if (key.length < 16) return 'API key must be at least 16 characters';
  if (key.length > 256) return 'API key must be at most 256 characters';
  return null;
}

/** The SSO public URL as a bare origin (https://host[:port]), '' for none; HttpError(400) if it isn't one. */
export function publicOrigin(value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  const bad = () => new HttpError(400, 'Public URL must be just the address people use, like https://checkin.contoso.com (no path, query or spaces)');
  if (/[\s<>"'`\\]/.test(v) || !/^https?:\/\//i.test(v)) throw bad();
  let u;
  try { u = new URL(v); } catch { throw bad(); }
  if (!/^https?:$/.test(u.protocol) || !u.hostname || u.username || u.password || u.search || u.hash || v.includes('?') || v.includes('#')) throw bad();
  if (u.pathname !== '/' && u.pathname.replace(/\/+$/, '') !== '') throw bad();
  return u.origin;
}

export const DEFAULT_SSO = {
  enabled: false,
  tenantId: '',
  clientId: '',
  clientSecretEnc: '',
  buttonLabel: 'Sign in with Microsoft',
  publicUrl: '',
  autoCreate: true,
  defaultRole: 'reader',
  syncRoles: true,
  roleClaims: { admin: 'CheckIn.Admin', power: 'CheckIn.PowerUser', user: 'CheckIn.User', reader: 'CheckIn.Reader' },
  groupMap: [],
};

// Settings whose change can end someone's access (live streams re-check who they belong to).
const ACCESS_SETTINGS = new Set(['passwordLogin', 'apiKey', 'apiKeyRequired', 'sso']);

/**
 * Emits 'access' ({ userId? }) whenever something changes that can take away someone's access:
 * a user disabled, demoted, deleted or signed out, sessions revoked, the API key replaced, or the
 * sign-in options changed. Open live-update streams listen and re-check their identity.
 */
export class Accounts extends EventEmitter {
  constructor(db, { secret, sessionTtlHours = 12 }) {
    super();
    this.db = db;
    this.secret = secret;
    this.ttlMs = sessionTtlHours * 3600 * 1000;
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name          TEXT NOT NULL DEFAULT '',
        email         TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
        role          TEXT NOT NULL,
        password_hash TEXT,
        sso_sub       TEXT UNIQUE,
        disabled      INTEGER NOT NULL DEFAULT 0,
        created       TEXT NOT NULL,
        updated       TEXT NOT NULL,
        last_login    TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id       TEXT PRIMARY KEY,
        user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf     TEXT NOT NULL,
        method   TEXT NOT NULL,
        created  TEXT NOT NULL,
        expires  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.s = {
      byId: db.prepare('SELECT * FROM users WHERE id = ?'),
      byName: db.prepare('SELECT * FROM users WHERE username = ?'),
      // Pre-created, not-yet-linked, single-sign-on-only accounts (no password) matching a sign-in name.
      ssoLinkCandidate: db.prepare(`SELECT * FROM users WHERE (username = ?1 OR (email = ?1 COLLATE NOCASE AND email <> ''))
        AND sso_sub IS NULL AND password_hash IS NULL ORDER BY (username = ?1) DESC, id LIMIT 1`),
      bySub: db.prepare('SELECT * FROM users WHERE sso_sub = ?'),
      session: db.prepare(`SELECT s.id AS sid, s.csrf, s.expires, s.method, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE id = ?'),
      getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
      setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    };
    this.settingsCache = new Map();
    setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 3600_000).unref();
  }

  // ---------------------------------------------------------------- settings
  getSetting(key, fallback) {
    if (this.settingsCache.has(key)) return this.settingsCache.get(key);
    const row = this.s.getSetting.get(key);
    const v = row ? JSON.parse(row.value) : fallback;
    this.settingsCache.set(key, v);
    return v;
  }
  setSetting(key, value) {
    this.s.setSetting.run(key, JSON.stringify(value));
    this.settingsCache.set(key, value);
    if (ACCESS_SETTINGS.has(key)) this.#accessChanged({ setting: key });
  }
  #accessChanged(info = {}) {
    try { this.emit('access', info); } catch { /* a listener's problem must not fail the change */ }
  }

  get staleMinutes() { return this.getSetting('staleMinutes', 15); }
  get passwordLogin() { return this.getSetting('passwordLogin', true); }

  /** Whether the server is accepting check-ins (power users can pause it). */
  ingest() { return { paused: false, since: null, by: null, ...this.getSetting('ingest', {}) }; }
  setIngestPaused(paused, by) {
    const cur = this.ingest();
    if (cur.paused === Boolean(paused)) return cur;
    const next = { paused: Boolean(paused), since: new Date().toISOString(), by: by || null };
    this.setSetting('ingest', next);
    return next;
  }

  sso() { return { ...DEFAULT_SSO, ...this.getSetting('sso', {}) }; }
  ssoSecret() { const s = this.sso(); return s.clientSecretEnc ? decrypt(this.secret, s.clientSecretEnc) : ''; }
  ssoReady() { const s = this.sso(); return Boolean(s.enabled && s.tenantId && s.clientId && s.clientSecretEnc); }
  publicSso() {
    const { clientSecretEnc, ...rest } = this.sso();
    return { ...rest, hasSecret: Boolean(clientSecretEnc) };
  }
  updateSso(patch) {
    const cur = this.sso();
    const next = { ...cur };
    for (const k of ['enabled', 'autoCreate', 'syncRoles']) if (k in patch) next[k] = Boolean(patch[k]);
    for (const k of ['tenantId', 'clientId', 'buttonLabel', 'publicUrl']) if (k in patch) next[k] = String(patch[k] ?? '').trim();
    if ('defaultRole' in patch) {
      if (patch.defaultRole !== 'none' && !ROLES[patch.defaultRole]) throw new HttpError(400, 'Invalid default role');
      next.defaultRole = patch.defaultRole;
    }
    if (patch.roleClaims && typeof patch.roleClaims === 'object') {
      next.roleClaims = {};
      for (const r of Object.keys(ROLES)) next.roleClaims[r] = String(patch.roleClaims[r] ?? '').trim();
    }
    if (Array.isArray(patch.groupMap)) {
      next.groupMap = patch.groupMap
        .map((g) => ({ groupId: String(g.groupId || '').trim(), role: g.role }))
        .filter((g) => g.groupId && ROLES[g.role]);
    }
    if (typeof patch.clientSecret === 'string' && patch.clientSecret) next.clientSecretEnc = encrypt(this.secret, patch.clientSecret);
    if (patch.clearSecret) next.clientSecretEnc = '';
    next.publicUrl = publicOrigin(next.publicUrl);
    if (next.tenantId && !/^[A-Za-z0-9.-]{3,100}$/.test(next.tenantId)) throw new HttpError(400, 'Tenant ID looks invalid');
    if (next.enabled && (!next.tenantId || !next.clientId || !next.clientSecretEnc)) {
      throw new HttpError(400, 'Tenant ID, client ID and client secret are required to enable SSO');
    }
    // Turning single sign-on off (or breaking it) must not leave no admin able to sign in.
    const readyAfter = Boolean(next.enabled && next.tenantId && next.clientId && next.clientSecretEnc);
    if (this.ssoReady() && !readyAfter && this.signInAdmins() > 0 && this.signInAdmins({ ssoReady: false }) === 0) {
      throw new HttpError(400, 'No admin could sign in without single sign-on. Give an admin account a password first.');
    }
    if (this.passwordLogin === 'admins' && this.ssoReady() && !readyAfter) {
      throw new HttpError(400, 'Password sign-in is set to admins only, so nobody else could sign in without single sign-on. Allow everyone to use passwords first (Admin, Settings).');
    }
    this.setSetting('sso', next);
    return this.publicSso();
  }

  // ---------------------------------------------------------------- API key (stored hashed)
  // The API key is stored twice: hashed (to check requests quickly) and encrypted with the app
  // secret (so power users and admins can look it up again). Keys saved by older versions only
  // have the hash and can't be shown until they are regenerated or re-supplied via API_KEY.
  apiKeyInfo() {
    const k = this.getSetting('apiKey', null);
    const required = this.apiKeyRequired;
    return k
      ? { set: true, required, prefix: k.prefix, created: k.created, createdBy: k.by, revealable: Boolean(k.enc) }
      : { set: false, required };
  }
  /** Whether anonymous check-ins must present the API key (default: yes). */
  get apiKeyRequired() { return this.getSetting('apiKeyRequired', null) !== false; }
  setApiKeyRequired(required) { this.setSetting('apiKeyRequired', Boolean(required)); return this.apiKeyInfo(); }
  setApiKey(key, by) {
    key = String(key ?? '').trim();
    const p = apiKeyProblem(key);
    if (p) throw new HttpError(400, p);
    this.setSetting('apiKey', { hash: sha256(key), enc: encrypt(this.secret, key), prefix: key.slice(0, 6), created: new Date().toISOString(), by });
    return this.apiKeyInfo();
  }
  /** The current key in plain text, or null if it was stored by an older version (hash only). */
  revealApiKey() {
    const k = this.getSetting('apiKey', null);
    return k?.enc ? decrypt(this.secret, k.enc) : null;
  }
  /**
   * Start-up: make sure a key exists and the policy is set.
   * - API_KEY from the environment is used for a new install, and makes an older hash-only key viewable.
   * - Installs from before keys were required, which already have records but no key, keep accepting
   *   check-ins without one (so their devices don't break); everything else requires the key.
   * Returns notes for the start-up log.
   */
  bootstrapApiKey({ envKey = '', hasRecords = false } = {}) {
    const notes = [];
    const hadKey = this.apiKeyInfo().set;
    if (envKey) {
      if (!hadKey) { this.setApiKey(envKey, 'environment'); notes.push('API key set from API_KEY'); }
      else if (!this.apiKeyInfo().revealable && this.checkApiKey(envKey)) { this.setApiKey(envKey, 'environment'); }
    }
    if (!this.s.getSetting.get('apiKeyRequired')) {
      const legacyOpen = !hadKey && !envKey && hasRecords;
      this.setApiKeyRequired(!legacyOpen);
      if (legacyOpen) notes.push('check-ins stay open without an API key, as before; an admin can require it in Admin > API key');
    }
    if (!this.apiKeyInfo().set) { this.generateApiKey('system'); notes.push('generated an API key; power users and admins can see it on the Add Device page'); }
    return notes;
  }
  generateApiKey(by) {
    const key = 'ck_' + randomToken(30);
    this.setApiKey(key, by);
    return key;
  }
  checkApiKey(key) {
    const k = this.getSetting('apiKey', null);
    return Boolean(k && key && sha256(key) === k.hash);
  }

  // ---------------------------------------------------------------- users
  count() { return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n; }
  adminCount() { return this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n; }
  /** Can this account actually sign in: enabled, with a password, or linked to a working single sign-on? */
  canSignIn(u, ssoReady = this.ssoReady()) {
    return Boolean(u && !u.disabled && (u.password_hash || (ssoReady && u.sso_sub)));
  }
  /**
   * Active admins who can sign in. `change` describes one user's account after a pending change
   * ({ id, row }; row null = deleted), and `ssoReady` a pending single sign-on state.
   */
  signInAdmins({ change, ssoReady = this.ssoReady() } = {}) {
    let n = 0;
    for (let u of this.db.prepare("SELECT * FROM users WHERE role = 'admin' OR id = ?").all(change?.id ?? -1)) {
      if (change && u.id === change.id) u = change.row;
      if (u && u.role === 'admin' && this.canSignIn(u, ssoReady)) n++;
    }
    return n;
  }

  publicUser(u) {
    if (!u) return null;
    return {
      id: u.id, username: u.username, name: u.name, email: u.email, role: u.role,
      roleLabel: ROLES[u.role]?.label || u.role, disabled: Boolean(u.disabled),
      hasPassword: Boolean(u.password_hash), sso: Boolean(u.sso_sub),
      created: u.created, updated: u.updated, lastLogin: u.last_login,
    };
  }
  list() { return this.db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all().map((u) => this.publicUser(u)); }
  get(id) { return this.s.byId.get(id); }

  async create({ username, name = '', email = '', role, password }) {
    username = String(username || '').trim();
    if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Username must be 2–128 characters: letters, numbers, . _ @ + -');
    if (!ROLES[role]) throw new HttpError(400, 'Invalid role');
    if (this.s.byName.get(username)) throw new HttpError(409, 'A user with that username already exists');
    let hash = null;
    if (password) {
      const p = passwordProblem(password);
      if (p) throw new HttpError(400, p);
      hash = await hashPassword(password);
    }
    const now = new Date().toISOString();
    const info = this.db.prepare(
      'INSERT INTO users (username, name, email, role, password_hash, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(username, String(name).trim(), String(email).trim(), role, hash, now, now);
    return this.publicUser(this.get(info.lastInsertRowid));
  }

  async update(id, patch, actorId) {
    const u = this.get(id);
    if (!u) throw new HttpError(404, 'User not found');
    const next = { name: u.name, email: u.email, role: u.role, disabled: u.disabled, password_hash: u.password_hash };
    if ('name' in patch) next.name = String(patch.name ?? '').trim();
    if ('email' in patch) next.email = String(patch.email ?? '').trim();
    if ('role' in patch) {
      if (!ROLES[patch.role]) throw new HttpError(400, 'Invalid role');
      next.role = patch.role;
    }
    if ('disabled' in patch) next.disabled = patch.disabled ? 1 : 0;
    if (patch.password) {
      const p = passwordProblem(patch.password);
      if (p) throw new HttpError(400, p);
      next.password_hash = await hashPassword(patch.password);
    }
    if (patch.removePassword) next.password_hash = null;
    const losingAdmin = u.role === 'admin' && !u.disabled && (next.role !== 'admin' || next.disabled);
    if (losingAdmin && this.adminCount() <= 1) throw new HttpError(400, 'You cannot remove the last active admin');
    if (id === actorId && next.disabled) throw new HttpError(400, 'You cannot disable your own account');
    // Never leave no admin who can sign in (e.g. removing the last admin's password without SSO).
    if (u.role === 'admin' && this.canSignIn(u) && this.signInAdmins({ change: { id, row: { ...u, ...next } } }) === 0) {
      throw new HttpError(400, patch.removePassword
        ? 'This is the last admin who can sign in: removing the password would lock everyone out. Set up single sign-on and link an admin account first.'
        : 'You cannot remove the last admin who can sign in');
    }
    this.db.prepare('UPDATE users SET name = ?, email = ?, role = ?, disabled = ?, password_hash = ?, updated = ? WHERE id = ?')
      .run(next.name, next.email, next.role, next.disabled, next.password_hash, new Date().toISOString(), id);
    if (next.disabled || patch.password || patch.removePassword) this.revokeSessions(id, patch.keepSession);
    this.#accessChanged({ userId: id });
    return this.publicUser(this.get(id));
  }

  remove(id, actorId) {
    const u = this.get(id);
    if (!u) throw new HttpError(404, 'User not found');
    if (id === actorId) throw new HttpError(400, 'You cannot delete your own account');
    if (u.role === 'admin' && !u.disabled && this.adminCount() <= 1) throw new HttpError(400, 'You cannot delete the last active admin');
    if (u.role === 'admin' && this.canSignIn(u) && this.signInAdmins({ change: { id, row: null } }) === 0) {
      throw new HttpError(400, 'You cannot delete the last admin who can sign in');
    }
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    this.#accessChanged({ userId: id });
  }

  async verifyLogin(username, password) {
    // Nothing valid is this long: don't spend a hash on it (or look it up).
    if (String(username || '').length > MAX_USERNAME_LEN || String(password ?? '').length > MAX_PASSWORD_LEN) return null;
    const u = this.s.byName.get(String(username || '').trim());
    const ok = await verifyPassword(password, u?.password_hash);
    if (!ok || !u || u.disabled) return null;
    return u;
  }

  // ---------------------------------------------------------------- sessions
  createSession(userId, method) {
    const token = randomToken(32);
    const csrf = randomToken(24);
    this.db.prepare('INSERT INTO sessions (id, user_id, csrf, method, created, expires) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(token), userId, csrf, method, new Date().toISOString(), Date.now() + this.ttlMs);
    this.db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(new Date().toISOString(), userId);
    return { token, csrf };
  }
  getSession(token) {
    if (!token) return null;
    const id = sha256(token);
    const row = this.s.session.get(id);
    if (!row) return null;
    if (row.expires < Date.now() || row.disabled) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return null;
    }
    // Sliding expiry, written at most once a minute.
    const newExp = Date.now() + this.ttlMs;
    if (newExp - row.expires > 60_000) this.s.touch.run(newExp, id);
    return row;
  }
  /** Is this session (by its stored id) still valid? Read-only: doesn't extend it. Returns the row or null. */
  checkSession(sid) {
    if (!sid) return null;
    const row = this.s.session.get(sid);
    return row && row.expires >= Date.now() && !row.disabled ? row : null;
  }
  destroySession(token) {
    if (!token) return;
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
    this.#accessChanged({});
  }
  revokeSessions(userId, keepSid) {
    if (keepSid) this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, keepSid);
    else this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    this.#accessChanged({ userId });
  }

  // ---------------------------------------------------------------- SSO users
  /** Highest role granted by the token's app roles / group claims, or null. */
  mapRole(claims) {
    const sso = this.sso();
    const found = new Set();
    const tokenRoles = (Array.isArray(claims.roles) ? claims.roles : []).map((r) => String(r).toLowerCase());
    for (const [role, claim] of Object.entries(sso.roleClaims || {})) {
      if (claim && tokenRoles.includes(claim.toLowerCase())) found.add(role);
    }
    const groups = (Array.isArray(claims.groups) ? claims.groups : []).map((g) => String(g).toLowerCase());
    for (const g of sso.groupMap || []) if (groups.includes(g.groupId.toLowerCase())) found.add(g.role);
    let best = null;
    for (const r of found) if (!best || roleLevel(r) > roleLevel(best)) best = r;
    return best;
  }

  /**
   * Find, link or create the local user for an SSO login. Throws a user-facing error if not allowed.
   *
   * Identity is the immutable tenant + object ID (tid:oid). An existing local account is only
   * linked on first sign-in when ALL of these hold, so a spoofable claim can never take over an
   * account:
   *   - it was created by an admin as "single sign-on only" (it has no password),
   *   - it isn't already linked to another identity,
   *   - the sign-in name (preferred_username / upn, never the mutable `email` claim) matches its
   *     username or email,
   *   - the person is a member of the tenant, not a guest from another identity provider.
   */
  ssoLogin(claims) {
    const sso = this.sso();
    const sub = claims.tid && claims.oid ? `${claims.tid}:${claims.oid}` : `sub:${claims.iss}:${claims.sub}`;
    const signInName = String(claims.preferred_username || claims.upn || '').trim();
    const email = String(claims.email || signInName || '').trim(); // display/contact only
    const name = String(claims.name || '').trim();
    const isGuest = Boolean(claims.idp && claims.iss && claims.idp !== claims.iss);
    const mapped = this.mapRole(claims);
    const fallback = sso.defaultRole === 'none' ? null : sso.defaultRole;
    const now = new Date().toISOString();

    let u = this.s.bySub.get(sub);
    if (!u && signInName && !isGuest) {
      const candidate = this.s.ssoLinkCandidate.get(signInName);
      if (candidate) {
        this.db.prepare('UPDATE users SET sso_sub = ?, updated = ? WHERE id = ?').run(sub, now, candidate.id);
        u = this.get(candidate.id);
      }
    }
    if (!u) {
      if (!sso.autoCreate) throw new HttpError(403, 'Your account has not been added to this app. Ask an administrator for access.');
      const role = mapped || fallback;
      if (!role) throw new HttpError(403, 'You have not been assigned a role for this app. Ask an administrator for access.');
      // Never reuse an existing username: a clash gets a unique suffix instead of being linked.
      let username = signInName || email || name || sub;
      while (this.s.byName.get(username)) username = `${signInName || email || name || 'user'}-${crypto.randomBytes(3).toString('hex')}`;
      const info = this.db.prepare(
        'INSERT INTO users (username, name, email, role, sso_sub, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(username, name, email, role, sub, now, now);
      u = this.get(info.lastInsertRowid);
    } else {
      if (u.disabled) throw new HttpError(403, 'Your account is disabled.');
      let role = u.role;
      if (sso.syncRoles) {
        role = mapped || fallback;
        if (!role) throw new HttpError(403, 'You no longer have a role assigned for this app.');
        // Never let a sync demote the last admin and lock everyone out.
        if (u.role === 'admin' && role !== 'admin' && this.signInAdmins({ change: { id: u.id, row: { ...u, role } } }) === 0) role = 'admin';
      }
      this.db.prepare('UPDATE users SET name = ?, email = ?, role = ?, updated = ? WHERE id = ?')
        .run(name || u.name, email || u.email, role, now, u.id);
      u = this.get(u.id);
    }
    return u;
  }
}
