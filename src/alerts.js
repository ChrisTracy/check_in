import { HttpError } from './store.js';
import { encrypt, decrypt } from './auth/security.js';

/**
 * Alerts: tell people when a new issue opens, through an Apprise API server (https://github.com/caronc/apprise-api),
 * which can reach Teams, Slack, Discord, email, ntfy, Telegram and about a hundred other services.
 *
 *   - Optional. Nothing is sent until an admin turns alerts on AND gives an Apprise address. Without
 *     the Apprise container the rest of the app is unaffected.
 *   - Only issues opened by a rule that has "Alert" ticked in Issue rules are announced.
 *   - Where to send: either Apprise URLs kept here (stored encrypted, never shown again), or the name
 *     of a configuration saved inside Apprise (its "key").
 *   - Flood protection: at most `max` alerts per `perSeconds`. Past that, individual alerts stop and one
 *     summary ("N more issues opened") goes out when the window ends. For `graceSeconds` after the server
 *     starts nothing is sent individually either (a restart re-checks every device).
 *   - Sending never blocks check-ins: alerts wait in a short queue and are posted one at a time.
 */
export const ALERT_DEFAULTS = { enabled: false, appriseUrl: '', configKey: '', max: 5, perSeconds: 60, graceSeconds: 120, linkUrl: '' };
const MAX_QUEUE = 100;
const TIMEOUT_MS = 10_000;
const TYPE = { critical: 'failure', warning: 'warning', info: 'info' };
const MAX_URLS = 20;

/** An http(s) address with no credentials, query or spaces, as a bare string without a trailing slash; '' for none. */
export function cleanBaseUrl(v, what) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { throw new HttpError(400, `${what} must be a web address like http://apprise:8000`); }
  if (!/^https?:$/.test(u.protocol) || /\s/.test(s)) throw new HttpError(400, `${what} must start with http:// or https://`);
  if (u.username || u.password || u.search || u.hash) throw new HttpError(400, `${what} must not contain a login, query or #`);
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/** "teams://…" lines or a list → clean array. Apprise URLs look like scheme://something. */
export function cleanUrls(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[\r\n,]+/);
  const out = [];
  for (const raw of list) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(s) || s.length > 2000) throw new HttpError(400, `Not an Apprise URL: ${s.slice(0, 30)}… (they look like slack://… or ntfy://…)`);
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > MAX_URLS) throw new HttpError(400, `At most ${MAX_URLS} destinations`);
  return out;
}

const mask = (u) => u.replace(/^([a-z][a-z0-9+.-]*:\/\/).*$/i, '$1••••');

export class Alerts {
  constructor({ accounts, log, defaultUrl = '', graceOverride, fetchFn = (...a) => fetch(...a) }) {
    this.accounts = accounts;
    this.log = log || { warn() {}, info() {} };
    this.defaultUrl = defaultUrl;
    this.fetch = fetchFn;
    this.startedAt = Date.now();
    this.graceOverride = graceOverride;     // tests: seconds, overriding the saved value
    this.queue = [];
    this.sending = false;
    this.times = [];                        // when recent individual alerts were sent (sliding window)
    this.held = { count: 0, names: [] };    // alerts withheld by the limit, waiting for the summary
    this.summaryTimer = null;
    this.closed = false;
    this.stats = { sent: 0, held: 0, failed: 0, summaries: 0, lastOk: null, lastError: null, lastErrorAt: null };
  }

  // ---------------------------------------------------------------- settings
  get settings() {
    const s = { ...ALERT_DEFAULTS, ...(this.accounts.getSetting('alerts', null) || {}) };
    delete s.urlsEnc;
    if (!s.appriseUrl && this.defaultUrl) s.appriseUrl = this.defaultUrl;
    return s;
  }
  #urls() {
    const enc = (this.accounts.getSetting('alerts', null) || {}).urlsEnc;
    if (!enc) return [];
    const t = decrypt(this.accounts.secret, enc);
    try { const a = JSON.parse(t); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  /** What the settings page may see: never the URLs themselves, only how many and which service. */
  view() {
    const s = this.settings;
    const urls = this.#urls();
    return { ...s, fromEnv: !(this.accounts.getSetting('alerts', null) || {}).appriseUrl && !!this.defaultUrl, destinations: urls.map(mask), ready: this.ready, stats: this.stats, queued: this.queue.length, held: this.held.count };
  }
  get ready() {
    const s = this.settings;
    return s.enabled && !!s.appriseUrl && (!!s.configKey || this.#urls().length > 0);
  }

  update(patch) {
    const raw = this.accounts.getSetting('alerts', null) || {};
    const next = { ...ALERT_DEFAULTS, ...raw };
    const num = (v, lo, hi, what) => {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, `${what} must be between ${lo} and ${hi}`);
      return n;
    };
    if ('enabled' in patch) next.enabled = patch.enabled === true;
    if ('appriseUrl' in patch) next.appriseUrl = cleanBaseUrl(patch.appriseUrl, 'The Apprise address');
    if ('configKey' in patch) {
      const k = String(patch.configKey ?? '').trim();
      if (k && !/^[A-Za-z0-9_.-]{1,64}$/.test(k)) throw new HttpError(400, 'The Apprise key may only contain letters, numbers, dots, dashes and underscores');
      next.configKey = k;
    }
    if ('linkUrl' in patch) next.linkUrl = cleanBaseUrl(patch.linkUrl, 'The link address');
    if ('max' in patch) next.max = num(patch.max, 1, 1000, 'Alerts per window');
    if ('perSeconds' in patch) next.perSeconds = num(patch.perSeconds, 5, 86_400, 'The window (seconds)');
    if ('graceSeconds' in patch) next.graceSeconds = num(patch.graceSeconds, 0, 3600, 'The quiet time after start-up (seconds)');
    if ('urls' in patch) {
      const urls = cleanUrls(patch.urls);
      next.urlsEnc = urls.length ? encrypt(this.accounts.secret, JSON.stringify(urls)) : '';
    }
    if (next.enabled && !(next.appriseUrl || this.defaultUrl)) throw new HttpError(400, 'Enter the Apprise address before turning alerts on');
    this.accounts.setSetting('alerts', next);
    return this.view();
  }

  // ---------------------------------------------------------------- the limiter
  /**
   * An issue opened by a rule with "Alert" ticked. Cheap and synchronous (it is called while the
   * issue is being written); the actual sending happens later.
   */
  notifyOpened({ deviceId, rule, value, issueId }) {
    try {
      if (!this.ready || this.closed) return;
      const s = this.settings;
      const now = Date.now();
      const grace = (this.graceOverride ?? s.graceSeconds) * 1000;
      this.times = this.times.filter((t) => now - t < s.perSeconds * 1000);
      if (now - this.startedAt < grace || this.times.length >= s.max) { this.#hold(deviceId, rule, s); return; }
      this.times.push(now);
      this.#enqueue({
        title: `${rule.severity === 'critical' ? 'Critical' : rule.severity === 'info' ? 'Info' : 'Warning'}: ${rule.name} on ${deviceId}`,
        body: [`New issue #${issueId} for ${deviceId}`, `${rule.name}${value ? ` — ${value}` : ''}`, s.linkUrl ? `${s.linkUrl}/issues` : ''].filter(Boolean).join('\n'),
        type: TYPE[rule.severity] || 'warning',
      });
    } catch (e) { this.log.warn?.({ err: e.message }, 'alert not queued'); }
  }

  #hold(deviceId, rule, s) {
    this.held.count++;
    this.stats.held++;
    if (this.held.names.length < 5) this.held.names.push(`${deviceId} (${rule.name})`);
    if (!this.summaryTimer) {
      // One summary when the window has had time to pass (and at least once the quiet time is over).
      const grace = (this.graceOverride ?? s.graceSeconds) * 1000;
      const wait = Math.max(s.perSeconds * 1000, grace - (Date.now() - this.startedAt) + 1000);
      this.summaryTimer = setTimeout(() => this.#sendSummary(), wait);
      this.summaryTimer.unref?.();
    }
  }

  #sendSummary() {
    this.summaryTimer = null;
    const { count, names } = this.held;
    this.held = { count: 0, names: [] };
    if (!count || !this.ready || this.closed) return;
    const s = this.settings;
    this.stats.summaries++;
    this.#enqueue({
      title: `${count} more issue${count === 1 ? '' : 's'} opened (not sent one by one)`,
      body: `The limit of ${s.max} alerts per ${s.perSeconds} seconds was reached (or the server had just started), so ${count} alert${count === 1 ? ' was' : 's were'} held back.\n` +
        `First: ${names.join(', ')}${count > names.length ? ', …' : ''}\nOpen the Issues page to see them all.`,
      type: 'warning',
    });
  }

  // ---------------------------------------------------------------- sending
  #enqueue(msg) {
    if (this.queue.length >= MAX_QUEUE) { this.queue.shift(); this.stats.failed++; }
    this.queue.push(msg);
    this.#drain();
  }
  async #drain() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length && !this.closed) {
        const m = this.queue.shift();
        try { await this.send(m); this.stats.sent++; this.stats.lastOk = new Date().toISOString(); }
        catch (e) {
          this.stats.failed++;
          this.stats.lastError = e.message;
          this.stats.lastErrorAt = new Date().toISOString();
          this.log.warn?.({ err: e.message }, 'alert failed');
        }
      }
    } finally { this.sending = false; }
  }

  /** One POST to Apprise. Throws with a readable message when it doesn't work. */
  async send({ title, body, type = 'info' }) {
    const s = this.settings;
    if (!s.appriseUrl) throw new Error('No Apprise address set');
    const urls = this.#urls();
    const key = s.configKey;
    if (!key && !urls.length) throw new Error('No destinations set');
    const endpoint = `${s.appriseUrl}/notify${key ? '/' + encodeURIComponent(key) : ''}`;
    const payload = { title, body, type, format: 'text' };
    if (!key) payload.urls = urls.join(',');
    let res;
    try {
      res = await this.fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      const why = e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code || e.message);
      throw new Error(`Could not reach Apprise at ${s.appriseUrl} (${why})`);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = String((await res.text()) || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160); } catch { /* ignore */ }
      throw new Error(`Apprise answered ${res.status}${detail ? `: ${detail}` : ''}`);
    }
  }

  /** The Send test button: goes straight out (not counted against the limit) and reports the result. */
  async test() {
    const s = this.settings;
    if (!s.appriseUrl) throw new HttpError(400, 'Enter the Apprise address first');
    try {
      await this.send({ title: 'Check-In test alert', body: 'If you can read this, alerts from Check-In are working.', type: 'info' });
      return { ok: true };
    } catch (e) { throw new HttpError(502, e.message); }
  }

  close() {
    this.closed = true;
    clearTimeout(this.summaryTimer);
    this.queue.length = 0;
  }
}

export function registerAlerts(app, { alerts }) {
  const admin = { config: { cap: 'alerts' } };
  app.get('/api/admin/alerts', { config: { cap: 'settingsView' } }, async () => alerts.view());
  app.put('/api/admin/alerts', admin, async (req) => alerts.update(req.body && typeof req.body === 'object' ? req.body : {}));
  app.post('/api/admin/alerts/test', admin, async () => alerts.test());
}
