import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { HttpError } from './store.js';
import { BOX_OPS, testBox } from './boxes.js';
import { csvRow } from './csv.js';

/**
 * Issues: power users and admins define what counts as a problem ("cpu_pct > 90 on 5 check-ins
 * in a row", "system_time more than 5 minutes off", "no check-in for 30 minutes"); the server opens an
 * issue for the device when one starts, adds further problems to that same issue (one open issue
 * per device), removes each problem when its clear rule has held long enough, and closes the
 * issue by itself when none are left. People can assign, ignore for a while, close and add notes.
 *
 * Every check-in is one test of every rule. A rule fails after N failing check-ins in a row (5 by
 * default) and its problem clears after M passing check-ins in a row (2 by default), so a single
 * reading never opens or closes anything on its own. "No check-in" rules are time-based (there are
 * no check-ins to count) and are checked on a timer.
 *
 * Per rule and device the server keeps (table issue_watch, in memory too):
 *   t, n  first failing check-in in the current run, and how many in a row (null/0 when passing)
 *   c, m  first passing check-in and how many in a row, while the problem is on an open issue
 *   v     the last check-in counted (its record version), so one check-in is never counted twice
 *   s  suppressed: closed by hand (or just cleared) while still true; it must stop being true
 *      before it can open again, so a manual close stays closed until the problem recurs.
 */
export const RULE_KINDS = ['field', 'skew', 'stale'];
export const SEVERITIES = ['critical', 'warning', 'info'];
const SEV_RANK = { critical: 3, warning: 2, info: 1 };
// Every lookup keyed by user input uses own properties only ("constructor", "__proto__"… are not ops).
const has = (obj, k) => typeof k === 'string' && Object.hasOwn(obj, k);
const isOp = (op) => has(BOX_OPS, op);
const opText = (op) => (isOp(op) ? BOX_OPS[op] : String(op));
const sevRank = (s) => (has(SEV_RANK, s) ? SEV_RANK[s] : 0);
const NO_VALUE = new Set(['empty', 'nempty']);
const MAX_RULES = 50;
const MAX_MINUTES = 7 * 24 * 60;
const MAX_IGNORE_MIN = 90 * 24 * 60;
const MAX_COUNT = 1000;
export const DEFAULT_FAIL_COUNT = 5;
export const DEFAULT_CLEAR_COUNT = 2;
// Open (or ignored) issues whose problems have all cleared: only exist when automatic closing is off.
const ALL_CLEAR = "status != 'closed' AND EXISTS (SELECT 1 FROM issue_problems p WHERE p.issue_id = issues.id) AND NOT EXISTS (SELECT 1 FROM issue_problems p WHERE p.issue_id = issues.id AND p.cleared_at IS NULL)";
const DEFAULT_SETTINGS = { enabled: false, reassignMinutes: 60, autoClose: true };

const isBlank = (v) => v === undefined || v === null || v === '';
const show = (v) => (isBlank(v) ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const nowIso = () => new Date().toISOString();
const msBetween = (a, b) => Date.parse(b) - Date.parse(a);

function cleanText(v, max, what) {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (s.length > max) throw new HttpError(400, `${what} must be ${max} characters or fewer`);
  return s;
}
function cleanCount(v, where, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 1 || n > MAX_COUNT) throw new HttpError(400, `${where}: the number of check-ins in a row must be between 1 and ${MAX_COUNT}`);
  return n;
}
// Rules saved before counts existed had minutes: 0 minutes = 1 check-in, otherwise the defaults.
const legacyCount = (obj, fallback) => (obj && obj.count === undefined && obj.minutes !== undefined ? (Number(obj.minutes) > 0 ? fallback : 1) : undefined);
function cleanMinutes(v, where, max = MAX_MINUTES) {
  const n = Math.round(Number(v ?? 0));
  if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, `${where}: minutes must be between 0 and ${max}`);
  return n;
}

/** Validate one rule from the editor. Returns a clean copy or throws a 400. */
export function cleanRule(r, i) {
  const where = `Rule ${i + 1}`;
  if (!r || typeof r !== 'object') throw new HttpError(400, `${where} is not valid`);
  const name = cleanText(r.name, 60, `${where}: the name`);
  if (!name) throw new HttpError(400, `${where} needs a name`);
  if (!isBlank(r.kind) && !(typeof r.kind === 'string' && RULE_KINDS.includes(r.kind))) throw new HttpError(400, `${where}: unknown type (use ${RULE_KINDS.join(', ')})`);
  if (!isBlank(r.severity) && !(typeof r.severity === 'string' && SEVERITIES.includes(r.severity))) throw new HttpError(400, `${where}: unknown severity (use ${SEVERITIES.join(', ')})`);
  const kind = isBlank(r.kind) ? 'field' : r.kind;
  const id = typeof r.id === 'string' && /^[0-9a-f]{8}$/.test(r.id) ? r.id : crypto.randomBytes(4).toString('hex');
  const out = {
    id, name, kind,
    severity: isBlank(r.severity) ? 'warning' : r.severity,
    enabled: r.enabled !== false,
    alert: r.alert === true,   // announce issues this rule opens (Settings → Alerts)
    field: '', op: '', value: '', count: 1,
    clear: { mode: 'auto', field: '', op: '', value: '', count: DEFAULT_CLEAR_COUNT },
  };
  const c = r.clear && typeof r.clear === 'object' ? r.clear : {};
  out.clear.count = cleanCount(c.count ?? legacyCount(c, DEFAULT_CLEAR_COUNT), `“${name}” (clears after)`, DEFAULT_CLEAR_COUNT);
  const failCount = () => cleanCount(r.count ?? legacyCount(r, DEFAULT_FAIL_COUNT), `“${name}”`, DEFAULT_FAIL_COUNT);
  if (kind === 'stale') {
    // "No check-in for N minutes": value = N (time-based: there are no check-ins to count).
    // Clears after clear.count check-ins in a row.
    const n = cleanMinutes(r.value, `“${name}”`);
    if (n < 1) throw new HttpError(400, `“${name}”: the time without a check-in must be at least 1 minute`);
    out.value = String(n);
    return out;
  }
  if (kind === 'skew') {
    // "Clock off by more than N minutes": a date/time field compared with the check-in time.
    out.field = cleanText(r.field || 'system_time', 200, `“${name}”: the field`);
    const n = Number(r.value);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_MINUTES) throw new HttpError(400, `“${name}”: the allowed difference must be more than 0 minutes`);
    out.value = String(n);
    out.count = failCount();
    if (c.mode === 'custom') {
      const cv = Number(c.value);
      if (!Number.isFinite(cv) || cv < 0 || cv > n) throw new HttpError(400, `“${name}”: the clear difference must be between 0 and ${n} minutes`);
      out.clear = { ...out.clear, mode: 'custom', value: String(cv) };
    }
    return out;
  }
  const cond = (src, label) => {
    const field = cleanText(src.field, 200, `“${name}”: the ${label} field`);
    if (!field) throw new HttpError(400, `“${name}” needs a ${label} field`);
    const op = typeof src.op === 'string' ? src.op : '';
    if (!isOp(op)) throw new HttpError(400, `“${name}”: unknown ${label} condition`);
    const value = NO_VALUE.has(op) ? '' : String(src.value ?? '').trim();
    if (!NO_VALUE.has(op) && value === '') throw new HttpError(400, `“${name}” needs a ${label} value to compare with`);
    if (value.length > 200) throw new HttpError(400, `“${name}”: the ${label} value is too long`);
    return { field, op, value };
  };
  Object.assign(out, cond(r, 'trigger'));
  out.count = failCount();
  if (c.mode === 'custom') out.clear = { ...out.clear, mode: 'custom', ...cond({ field: c.field || out.field, op: c.op, value: c.value }, 'clear') };
  return out;
}

/** Minutes between a date/time field and the check-in time, or null if it can't be read. */
function skewMinutes(rule, rec) {
  const v = rec[rule.field];
  if (isBlank(v) || typeof v === 'object') return null;
  const t = typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : Date.parse(String(v));
  if (!Number.isFinite(t)) return null;
  return Math.abs(t - Date.parse(rec.modified)) / 60000;
}
export function triggerHit(rule, rec) {
  if (rule.kind === 'skew') { const m = skewMinutes(rule, rec); return m !== null && m > Number(rule.value); }
  if (rule.kind === 'stale') return false; // checked on the timer
  return testBox(rule, rec);
}
function clearHit(rule, rec) {
  if (rule.kind === 'stale') return true; // it checked in
  if (rule.kind === 'skew') {
    const m = skewMinutes(rule, rec);
    return m !== null && m <= Number(rule.clear.mode === 'custom' ? rule.clear.value : rule.value);
  }
  return rule.clear.mode === 'custom' ? testBox(rule.clear, rec) : !testBox(rule, rec);
}
/** What the rule looked at, for the log ("cpu_pct = 97"). */
function reading(rule, rec) {
  if (!rec) return '';
  if (rule.kind === 'stale') return `last check-in ${rec.modified}`;
  if (rule.kind === 'skew') {
    const m = skewMinutes(rule, rec);
    return m === null ? `${rule.field} missing` : `${rule.field} = ${show(rec[rule.field])} (${m.toFixed(1)} min off)`;
  }
  const f = rule.kind === 'field' ? rule.field : '';
  const parts = [`${f} = ${show(rec[f]) || '(empty)'}`];
  if (rule.clear.mode === 'custom' && rule.clear.field !== f) parts.push(`${rule.clear.field} = ${show(rec[rule.clear.field]) || '(empty)'}`);
  return parts.join(', ');
}
/** Opt-in "top processes" text the agent sent for the metric this rule watches (cpu_pct -> top_cpu, ...). */
const TOP_FOR = { cpu_pct: 'top_cpu', load_1m: 'top_cpu', ram_pct: 'top_ram', swap_pct: 'top_ram', disk_busy_pct: 'top_disk' };
function topLine(rule, rec) {
  const k = TOP_FOR[rule.field];
  const v = k && rec && rec[k];
  return typeof v === 'string' && v.trim() ? `top: ${v.trim()}` : '';
}
const inARow = (n) => (n > 1 ? ` on ${n} check-ins in a row` : '');
export function describeRule(r) {
  if (r.kind === 'stale') return `No check-in for ${r.value} min`;
  if (r.kind === 'skew') return `${r.field} more than ${r.value} min from the check-in time${inARow(r.count)}`;
  return `${r.field} ${opText(r.op)}${NO_VALUE.has(r.op) ? '' : ' ' + r.value}${inARow(r.count)}`;
}
export function describeClear(r) {
  const after = inARow(r.clear.count);
  if (r.kind === 'stale') return r.clear.count > 1 ? `Checks in ${r.clear.count} times in a row` : 'Checks in again';
  if (r.kind === 'skew') return `Within ${r.clear.mode === 'custom' ? r.clear.value : r.value} min${after}`;
  if (r.clear.mode === 'custom') return `${r.clear.field} ${opText(r.clear.op)}${NO_VALUE.has(r.clear.op) ? '' : ' ' + r.clear.value}${after}`;
  return `Condition no longer true${after}`;
}

const isEmpty = (w) => !w.t && !w.n && !w.c && !w.m && !w.s;
/** Forget counts (keep the manual-close hold). */
function resetCounts(w) { w.t = null; w.n = 0; w.c = null; w.m = 0; w.v = null; }

export class Issues {
  constructor({ db, store, accounts, tickMs = 30_000, onChange = () => {}, onOpened = () => {} }) {
    this.db = db;
    this.store = store;
    this.accounts = accounts;
    this.onChange = onChange;
    this.onOpened = onOpened;
    this.startedAt = nowIso();
    db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id     TEXT NOT NULL,
        status        TEXT NOT NULL,            -- open | ignored | closed
        opened_at     TEXT NOT NULL,
        closed_at     TEXT,
        closed_by     TEXT,                     -- null = closed by itself
        close_reason  TEXT,
        assigned_to   INTEGER,
        assigned_name TEXT,
        ignored_until TEXT,
        ignored_by    TEXT,
        snapshot      TEXT,                     -- the device's fields when the issue opened
        updated       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_issues_record ON issues(record_id, closed_at);
      CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
      CREATE TABLE IF NOT EXISTS issue_problems (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id     INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        rule_id      TEXT NOT NULL,
        name         TEXT NOT NULL,
        severity     TEXT NOT NULL,
        rule_text    TEXT NOT NULL,
        started_at   TEXT NOT NULL,             -- when the condition began (first matching check-in)
        added_at     TEXT NOT NULL,             -- when it was added to the issue
        start_value  TEXT,
        cleared_at   TEXT,
        clear_value  TEXT,
        cleared_how  TEXT                       -- cleared | closed | rule | deleted
      );
      CREATE INDEX IF NOT EXISTS idx_issue_problems_issue ON issue_problems(issue_id);
      CREATE TABLE IF NOT EXISTS issue_events (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id  INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        at        TEXT NOT NULL,
        type      TEXT NOT NULL,                -- opened | problem | cleared | assigned | ignored | unignored | closed | note
        user_id   INTEGER,
        user_name TEXT,
        text      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_issue_events_issue ON issue_events(issue_id);
      CREATE TABLE IF NOT EXISTS issue_watch (
        rule_id     TEXT NOT NULL,
        record_id   TEXT NOT NULL,
        trig_since  TEXT,
        clear_since TEXT,
        suppressed  INTEGER NOT NULL DEFAULT 0,
        trig_count  INTEGER NOT NULL DEFAULT 0,
        clear_count INTEGER NOT NULL DEFAULT 0,
        last_version INTEGER,
        PRIMARY KEY (rule_id, record_id)
      );
      CREATE INDEX IF NOT EXISTS idx_issue_watch_record ON issue_watch(record_id);
      -- "Ignore these problems on this device": per device and rule, so it outlives the issue it was set on.
      CREATE TABLE IF NOT EXISTS issue_mutes (
        record_id TEXT NOT NULL,
        rule_id   TEXT NOT NULL,
        until     TEXT NOT NULL,
        by        TEXT,
        at        TEXT NOT NULL,
        PRIMARY KEY (record_id, rule_id)
      );
    `);
    const icols = new Set(db.prepare('PRAGMA table_info(issues)').all().map((c) => c.name));
    if (!icols.has('ignore_scope')) db.exec('ALTER TABLE issues ADD COLUMN ignore_scope TEXT');   // device | problems
    // Databases from before check-in counts: add the columns.
    const cols = new Set(db.prepare('PRAGMA table_info(issue_watch)').all().map((c) => c.name));
    for (const [c, def] of [['trig_count', 'INTEGER NOT NULL DEFAULT 0'], ['clear_count', 'INTEGER NOT NULL DEFAULT 0'], ['last_version', 'INTEGER']]) {
      if (!cols.has(c)) db.exec(`ALTER TABLE issue_watch ADD COLUMN ${c} ${def}`);
    }
    this.s = {
      watchSet: db.prepare(`INSERT INTO issue_watch (rule_id, record_id, trig_since, clear_since, suppressed, trig_count, clear_count, last_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rule_id, record_id) DO UPDATE SET trig_since = excluded.trig_since, clear_since = excluded.clear_since, suppressed = excluded.suppressed,
          trig_count = excluded.trig_count, clear_count = excluded.clear_count, last_version = excluded.last_version`),
      watchDel: db.prepare('DELETE FROM issue_watch WHERE rule_id = ? AND record_id = ?'),
      watchDelRecord: db.prepare('DELETE FROM issue_watch WHERE record_id = ?'),
      watchDelRule: db.prepare('DELETE FROM issue_watch WHERE rule_id = ?'),
      insIssue: db.prepare('INSERT INTO issues (record_id, status, opened_at, assigned_to, assigned_name, snapshot, updated) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      getIssue: db.prepare('SELECT * FROM issues WHERE id = ?'),
      setStatus: db.prepare('UPDATE issues SET status = ?, ignored_until = ?, ignored_by = ?, ignore_scope = ?, updated = ? WHERE id = ?'),
      muteSet: db.prepare('INSERT INTO issue_mutes (record_id, rule_id, until, by, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(record_id, rule_id) DO UPDATE SET until = excluded.until, by = excluded.by, at = excluded.at'),
      muteDel: db.prepare('DELETE FROM issue_mutes WHERE record_id = ? AND rule_id = ?'),
      close: db.prepare("UPDATE issues SET status = 'closed', closed_at = ?, closed_by = ?, close_reason = ?, ignored_until = NULL, ignore_scope = NULL, updated = ? WHERE id = ?"),
      assign: db.prepare('UPDATE issues SET assigned_to = ?, assigned_name = ?, updated = ? WHERE id = ?'),
      touch: db.prepare('UPDATE issues SET updated = ? WHERE id = ?'),
      insProblem: db.prepare('INSERT INTO issue_problems (issue_id, rule_id, name, severity, rule_text, started_at, added_at, start_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      clearProblem: db.prepare('UPDATE issue_problems SET cleared_at = ?, clear_value = ?, cleared_how = ? WHERE id = ?'),
      problems: db.prepare('SELECT * FROM issue_problems WHERE issue_id = ? ORDER BY id'),
      insEvent: db.prepare('INSERT INTO issue_events (issue_id, at, type, user_id, user_name, text) VALUES (?, ?, ?, ?, ?, ?)'),
      events: db.prepare('SELECT * FROM issue_events WHERE issue_id = ? ORDER BY id'),
      lastClosed: db.prepare("SELECT * FROM issues WHERE record_id = ? AND status = 'closed' AND closed_at >= ? ORDER BY closed_at DESC LIMIT 1"),
    };
    this.rules = this.#loadRules();
    /** `${ruleId}\0${recordId}` -> { t, c, s } */
    this.watch = new Map();
    for (const w of db.prepare('SELECT * FROM issue_watch').all()) {
      this.watch.set(this.#key(w.rule_id, w.record_id), { t: w.trig_since, n: w.trig_count || 0, c: w.clear_since, m: w.clear_count || 0, s: Boolean(w.suppressed), v: w.last_version ?? null });
    }
    /** recordId -> Map ruleId -> { until, by }: problems ignored on a device (see ignore()) */
    this.mutes = new Map();
    for (const m of db.prepare('SELECT * FROM issue_mutes').all()) {
      if (!this.mutes.has(m.record_id)) this.mutes.set(m.record_id, new Map());
      this.mutes.get(m.record_id).set(m.rule_id, { until: m.until, by: m.by });
    }
    /** recordId -> { id, status, active: Map ruleId -> problem row id, seen: Set ruleId } for open/ignored issues */
    this.open = new Map();
    this.#loadOpen();

    store.on('written', (results) => { if (this.enabled) this.#onWritten(results); });
    store.on('delete', ({ ids }) => this.#forgetRecords(ids, 'The device record was deleted'));
    store.on('clear', () => this.#forgetRecords([...this.open.keys()], 'All device records were cleared', true));
    if (tickMs > 0) {
      this.timer = setInterval(() => { try { this.tick(); } catch (e) { console.error('issues tick failed:', e); } }, tickMs);
      this.timer.unref();
    }
  }

  close() { clearInterval(this.timer); }

  // ------------------------------------------------------------ settings and rules
  settings() { return { ...DEFAULT_SETTINGS, ...this.accounts.getSetting('issues', {}) }; }
  get enabled() { return this.settings().enabled; }
  get version() { return this.accounts.getSetting('issueRulesVersion', 0); }
  #loadRules() {
    const raw = this.accounts.getSetting('issueRules', []);
    const out = [];
    (Array.isArray(raw) ? raw : []).forEach((r, i) => { try { out.push(cleanRule(r, i)); } catch { /* skip a broken rule */ } });
    return out;
  }
  publicRules() { return this.rules.map((r) => ({ ...r, text: describeRule(r), clearText: describeClear(r) })); }

  setEnabled(enabled) {
    const was = this.enabled;
    this.accounts.setSetting('issues', { ...this.settings(), enabled: Boolean(enabled) });
    if (!was && enabled) {
      // Check-ins weren't watched while it was off, so "since when" times are out of date.
      // Start measuring again (manual-close holds and open issues stay).
      this.db.transaction(() => { for (const [k, w] of [...this.watch]) { resetCounts(w); this.#saveWatch(k, w); } })();
      this.#evaluateAll();
    }
    this.onChange();
    return this.settings();
  }

  /**
   * Admins: close issues by themselves when every problem has cleared (default), or leave them
   * open as "all clear" until someone closes them. Turning it back on closes those straight away.
   */
  setAutoClose(on, by) {
    const was = this.settings().autoClose;
    this.accounts.setSetting('issues', { ...this.settings(), autoClose: Boolean(on) });
    if (!was && on) {
      const at = nowIso();
      this.db.transaction(() => {
        for (const [rid, o] of [...this.open]) if (!o.active.size) this.#closeIssue(rid, null, `All problems had cleared (automatic closing turned on by ${by.name})`, at);
      })();
    }
    this.onChange();
    return this.settings();
  }

  #cleanSettings(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be { "reassignMinutes": 60 }');
    const next = { ...this.settings() };
    if (Object.hasOwn(body, 'reassignMinutes')) {
      const v = body.reassignMinutes;
      if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '')) throw new HttpError(400, 'Reassign window: minutes must be a number');
      next.reassignMinutes = cleanMinutes(v, 'Reassign window', 30 * 24 * 60);
    }
    return next;
  }

  updateSettings(body) {
    const next = this.#cleanSettings(body);
    this.accounts.setSetting('issues', next);
    return next;
  }

  /**
   * Replace every rule. `settings` (optional, e.g. { reassignMinutes }) is saved in the same step,
   * and only if the rules are valid, so the editor never half-saves.
   */
  saveRules(list, version, by, settings) {
    if (!Array.isArray(list)) throw new HttpError(400, 'rules must be a list');
    if (version !== undefined && Number(version) !== this.version) {
      throw new HttpError(409, 'Someone else changed the issue rules while you were editing. Close this and open it again to see their changes.');
    }
    if (list.length > MAX_RULES) throw new HttpError(400, `At most ${MAX_RULES} rules`);
    const next = list.map(cleanRule);
    const nextSettings = settings === undefined ? null : this.#cleanSettings(settings);
    const seen = new Set();
    for (const r of next) { if (seen.has(r.id)) r.id = crypto.randomBytes(4).toString('hex'); seen.add(r.id); }
    const def = (r) => JSON.stringify([r.kind, r.field, r.op, r.value, r.count, r.clear]);
    const before = new Map(this.rules.map((r) => [r.id, r]));
    const gone = this.rules.filter((r) => { const n = next.find((x) => x.id === r.id); return !n || !n.enabled; });
    const changed = next.filter((r) => before.has(r.id) && def(before.get(r.id)) !== def(r));
    this.store.flush();
    if (nextSettings) this.accounts.setSetting('issues', nextSettings);
    this.accounts.setSetting('issueRules', next);
    this.accounts.setSetting('issueRulesVersion', this.version + 1);
    this.rules = next;
    const goneIds = new Set(gone.map((r) => r.id));
    const changedIds = new Set(changed.map((r) => r.id));
    this.db.transaction(() => {
      // Problems from removed or turned-off rules leave their issues (which close if nothing is left).
      for (const r of gone) {
        for (const [rid, o] of [...this.open]) {
          if (o.active.has(r.id)) this.#clearProblem(rid, r, { how: 'rule', text: `${r.name} removed: its rule was ${before.has(r.id) && next.some((x) => x.id === r.id) ? 'turned off' : 'deleted'} by ${by.name}` });
        }
        this.s.watchDelRule.run(r.id);
        this.db.prepare('DELETE FROM issue_mutes WHERE rule_id = ?').run(r.id);
        for (const [rec, byRule] of [...this.mutes]) { byRule.delete(r.id); if (!byRule.size) this.mutes.delete(rec); }
      }
      // Problems still open take the rule's new name, severity and wording (closed history keeps the old ones).
      const upd = this.db.prepare('UPDATE issue_problems SET name = ?, severity = ?, rule_text = ? WHERE rule_id = ? AND cleared_at IS NULL AND (name != ? OR severity != ? OR rule_text != ?)');
      for (const r of next) {
        if (!before.has(r.id) || goneIds.has(r.id)) continue;
        const text = describeRule(r);
        upd.run(r.name, r.severity, text, r.id, r.name, r.severity, text);
      }
      // Changed definitions start measuring again from the current readings (holds are kept).
      for (const id of changedIds) this.db.prepare('UPDATE issue_watch SET trig_since = NULL, clear_since = NULL, trig_count = 0, clear_count = 0, last_version = NULL WHERE rule_id = ?').run(id);
      if (goneIds.size || changedIds.size) {
        for (const [k, w] of [...this.watch]) {
          const ruleId = k.slice(0, k.indexOf('\0'));
          if (goneIds.has(ruleId)) this.watch.delete(k);
          else if (changedIds.has(ruleId)) { resetCounts(w); if (!w.s) this.watch.delete(k); }
        }
        this.db.exec('DELETE FROM issue_watch WHERE trig_since IS NULL AND clear_since IS NULL AND suppressed = 0');
      }
    })();
    if (this.enabled) this.#evaluateAll();
    this.onChange();
    return { rules: this.publicRules(), version: this.version };
  }

  // ------------------------------------------------------------ evaluation
  #key(ruleId, recordId) { return ruleId + '\0' + recordId; }
  #w(ruleId, recordId) {
    const k = this.#key(ruleId, recordId);
    let w = this.watch.get(k);
    if (!w) { w = { t: null, n: 0, c: null, m: 0, s: false, v: null }; this.watch.set(k, w); }
    return [k, w];
  }
  #saveWatch(k, w) {
    const i = k.indexOf('\0');
    const ruleId = k.slice(0, i);
    const recordId = k.slice(i + 1);
    if (isEmpty(w)) { this.watch.delete(k); this.s.watchDel.run(ruleId, recordId); }
    else this.s.watchSet.run(ruleId, recordId, w.t, w.c, w.s ? 1 : 0, w.n || 0, w.m || 0, w.v ?? null);
  }

  #onWritten(results) {
    if (!this.rules.some((r) => r.enabled)) return;
    let dirty = false;
    this.db.transaction(() => {
      for (const res of results) if (res?.record && this.#evaluate(res.record)) dirty = true;
    })();
    if (dirty) this.onChange();
  }

  /**
   * Apply one check-in to every rule. Returns true if an issue changed. Each check-in counts once
   * per rule (re-checking the latest check-in after a rule change or Clear all doesn't count again).
   */
  #evaluate(rec, now = rec.modified) {
    let changed = false;
    const at = rec.modified;
    const version = rec._version ?? null;
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const [k, w] = this.#w(rule.id, rec.id);
      const before = JSON.stringify(w);
      const fresh = version === null || w.v !== version; // a check-in this rule hasn't counted yet
      const o = this.open.get(rec.id);
      const active = Boolean(o?.active.has(rule.id));
      const trig = triggerHit(rule, rec);
      if (fresh) {
        w.v = version;
        if (trig) { if (!w.t) w.t = at; w.n = (w.n || 0) + 1; } else { w.t = null; w.n = 0; w.s = false; }
      }
      if (active) {
        if (fresh) {
          if (clearHit(rule, rec)) { if (!w.c) w.c = at; w.m = (w.m || 0) + 1; } else { w.c = null; w.m = 0; }
        }
        if (w.m >= rule.clear.count) {
          this.#clearProblem(rec.id, rule, { how: 'cleared', value: reading(rule, rec) + (rule.clear.count > 1 ? ` (${w.m} check-ins in a row)` : ''), at: now, deferClose: true });
          // If the clear rule overlaps the trigger, wait for the trigger to stop before it can return.
          w.c = null; w.m = 0; w.t = null; w.n = 0; w.s = trig;
          changed = true;
        }
      } else {
        w.c = null; w.m = 0;
        if (trig && !w.s && w.n >= rule.count) {
          if (this.#addProblem(rec, rule, { since: w.t, value: reading(rule, rec) + (rule.count > 1 ? ` (${w.n} check-ins in a row)` : ''), at: now })) changed = true;
        }
      }
      if (JSON.stringify(w) !== before) this.#saveWatch(k, w);
      else if (isEmpty(w)) this.watch.delete(k);
    }
    // Close only after every rule has had its say, so one check-in that ends one problem and
    // starts another keeps a single issue (whatever order the rules are in).
    const o = this.open.get(rec.id);
    if (o) { if (this.#syncIgnore(rec.id, now)) changed = true; }
    if (o && !o.active.size) this.#allCleared(rec.id, now);
    return changed;
  }

  /** Startup / rules saved / turned on: look at every record's latest check-in once. */
  #evaluateAll() {
    let dirty = false;
    this.db.transaction(() => {
      const now = nowIso();
      for (const rec of this.store.iterate()) if (this.#evaluate(rec, now)) dirty = true;
    })();
    if (this.tick() || dirty) this.onChange();
  }

  /** Timer: "no check-in" rules and ignores that have run out. Returns true if anything changed. */
  tick(now = Date.now()) {
    if (!this.enabled) return false;
    let changed = false;
    const at = new Date(now).toISOString();
    this.db.transaction(() => {
      // Problems ignored on a device whose time has run out.
      for (const [recordId, byRule] of [...this.mutes]) {
        for (const [ruleId, m] of [...byRule]) {
          if (m.until > at) continue;
          byRule.delete(ruleId);
          this.s.muteDel.run(recordId, ruleId);
          const o = this.open.get(recordId);
          if (o?.active.has(ruleId)) this.#event(o.id, 'unignored', null, `Ignore ended for ${this.#ruleName(ruleId)} (it was ignored until ${m.until})`, at);
          changed = true;
        }
        if (!byRule.size) this.mutes.delete(recordId);
      }
      for (const recordId of [...this.open.keys()]) if (this.#syncIgnore(recordId, at)) changed = true;
      for (const [rid, o] of this.open) {
        if (o.status !== 'ignored') continue;
        const row = this.s.getIssue.get(o.id);
        if (row.ignore_scope === 'problems') continue; // follows its problems' ignores (above)
        if (row.ignored_until && row.ignored_until <= at) {
          this.s.setStatus.run('open', null, null, null, at, o.id);
          o.status = 'open';
          this.#event(o.id, 'unignored', null, `Ignore ended (it was ignored until ${row.ignored_until})`, at);
          changed = true;
        }
      }
      const ingest = this.accounts.ingest();
      if (ingest.paused) return; // nobody can check in, so nobody is late
      // Don't count time the server was down or check-ins were paused against devices.
      const floor = [this.startedAt, ingest.since].filter(Boolean).sort().pop();
      for (const rule of this.rules) {
        if (!rule.enabled || rule.kind !== 'stale') continue;
        const ms = Number(rule.value) * 60000;
        const cutoff = new Date(now - ms).toISOString();
        if (floor > cutoff) continue;
        const rows = this.db.prepare('SELECT id FROM records WHERE modified < ?').all(cutoff);
        for (const { id } of rows) {
          const k = this.#key(rule.id, id);
          const w = this.watch.get(k) || { t: null, n: 0, c: null, m: 0, s: false, v: null };
          if (this.open.get(id)?.active.has(rule.id)) {
            // Silent again before it had checked in enough times to clear: start that over.
            if (w.c || w.m) { w.c = null; w.m = 0; this.watch.set(k, w); this.#saveWatch(k, w); }
            continue;
          }
          if (w.s) continue;
          this.watch.set(k, w);
          const rec = this.store.get(id);
          if (!rec) continue;
          const since = new Date(Date.parse([rec.modified, floor].sort().pop()) + ms).toISOString();
          w.t = since; w.c = null; w.m = 0;
          this.#saveWatch(k, w);
          if (this.#addProblem(rec, rule, { since, value: reading(rule, rec), at })) changed = true;
        }
      }
    })();
    if (changed) this.onChange();
    return changed;
  }

  // ------------------------------------------------------------ issue changes
  #loadOpen() {
    this.open.clear();
    for (const row of this.db.prepare("SELECT id, record_id, status FROM issues WHERE status != 'closed'").all()) {
      const o = { id: row.id, status: row.status, active: new Map(), seen: new Set() };
      for (const p of this.s.problems.all(row.id)) { o.seen.add(p.rule_id); if (!p.cleared_at) o.active.set(p.rule_id, p.id); }
      o.allClear = o.seen.size > 0 && !o.active.size;
      this.open.set(row.record_id, o);
    }
  }

  #event(issueId, type, user, text, at = nowIso()) {
    this.s.insEvent.run(issueId, at, type, user?.id ?? null, user?.name ?? null, text);
    this.s.touch.run(at, issueId);
  }

  #ruleName(ruleId) { return this.rules.find((r) => r.id === ruleId)?.name || 'that problem'; }
  /** Is this rule ignored on this device right now? */
  #muted(recordId, ruleId, at = nowIso()) {
    const m = this.mutes.get(recordId)?.get(ruleId);
    return Boolean(m && m.until > at);
  }

  /**
   * An issue whose every active problem is ignored is itself shown as Ignored (it comes back to Open
   * as soon as one of them isn't). A whole-device ignore ("device" scope) is left alone. Returns true
   * if the issue's status changed.
   */
  #syncIgnore(recordId, at = nowIso()) {
    const o = this.open.get(recordId);
    if (!o) return false;
    const row = this.s.getIssue.get(o.id);
    if (!row || row.status === 'closed') return false;
    if (row.status === 'ignored' && row.ignore_scope !== 'problems') return false;
    const live = [...o.active.keys()].filter((r) => !this.#muted(recordId, r, at));
    const mutes = [...o.active.keys()].map((r) => this.mutes.get(recordId)?.get(r)).filter(Boolean);
    if (row.status === 'open' && o.active.size && !live.length && mutes.length) {
      const first = mutes.reduce((a, b) => (a.until <= b.until ? a : b));
      this.s.setStatus.run('ignored', first.until, first.by, 'problems', at, o.id);
      o.status = 'ignored';
      return true;
    }
    if (row.status === 'ignored' && (live.length || !o.active.size)) {
      this.s.setStatus.run('open', null, null, null, at, o.id);
      o.status = 'open';
      return true;
    }
    return false;
  }

  /** Returns true if it added a problem (false: that problem is being ignored on this device). */
  #addProblem(rec, rule, { since, value, at }) {
    const top = topLine(rule, rec);
    if (top) value = (value ? value + '; ' : '') + top;
    const muted = this.#muted(rec.id, rule.id, at);
    let o = this.open.get(rec.id);
    if (!o && muted) return false;
    if (!o) {
      // Back within the reassign window of the last issue closing: give it to the same person.
      let assignee = null;
      const win = this.settings().reassignMinutes;
      if (win > 0) {
        const last = this.s.lastClosed.get(rec.id, new Date(Date.parse(at) - win * 60000).toISOString());
        if (last?.assigned_to) {
          const u = this.accounts.get(last.assigned_to);
          if (u && !u.disabled) assignee = { id: u.id, name: u.name || u.username, from: last.id };
        }
      }
      const snap = {};
      for (const k of Object.keys(rec)) if (k !== '_boxes') snap[k] = rec[k];
      const info = this.s.insIssue.run(rec.id, 'open', at, assignee?.id ?? null, assignee?.name ?? null, JSON.stringify(snap), at);
      o = { id: Number(info.lastInsertRowid), status: 'open', active: new Map(), seen: new Set() };
      this.open.set(rec.id, o);
      this.#event(o.id, 'opened', null, `Issue opened for ${rec.id} (last check-in ${rec.modified})`, at);
      // Announce it (alerts) when the rule that opened it has "Alert" ticked. Must never throw into the write.
      if (rule.alert) { try { this.onOpened({ issueId: o.id, deviceId: rec.id, rule, value, at }); } catch { /* alerts are best effort */ } }
      if (assignee) this.#event(o.id, 'assigned', null, `Assigned to ${assignee.name}: the problem came back within ${win} min of issue #${assignee.from} closing`, at);
    } else if (o.status === 'ignored' && !o.seen.has(rule.id) && !muted) {
      this.s.setStatus.run('open', null, null, null, at, o.id);
      o.status = 'open';
      this.#event(o.id, 'unignored', null, `Ignore ended: a new problem started (${rule.name})`, at);
    }
    o.allClear = false;
    const info = this.s.insProblem.run(o.id, rule.id, rule.name, rule.severity, describeRule(rule), since || at, at, value || '');
    o.active.set(rule.id, Number(info.lastInsertRowid));
    o.seen.add(rule.id);
    this.#event(o.id, 'problem', null, `${rule.name} started ${since && since !== at ? since : ''}`.trim() + (value ? ` — ${value}` : '') + ` [${describeRule(rule)}]`, at);
    this.#syncIgnore(rec.id, at);
    return true;
  }

  #clearProblem(recordId, rule, { how, value = '', text, at = nowIso(), deferClose = false }) {
    const o = this.open.get(recordId);
    const pid = o?.active.get(rule.id);
    if (!pid) return;
    this.s.clearProblem.run(at, value, how, pid);
    o.active.delete(rule.id);
    this.#event(o.id, 'cleared', null, text || `${rule.name} cleared${value ? ` — ${value}` : ''} [${describeClear(rule)}]`, at);
    this.#syncIgnore(recordId, at);
    if (!o.active.size && !deferClose) this.#allCleared(recordId, at);
  }

  /** Every problem on the issue has cleared: close it, or (automatic closing off) note it once and leave it open. */
  #allCleared(recordId, at) {
    const o = this.open.get(recordId);
    if (!o || o.active.size) return;
    if (this.settings().autoClose) { this.#closeIssue(recordId, null, 'All problems cleared', at); return; }
    if (o.allClear) return;
    o.allClear = true;
    this.#event(o.id, 'allclear', null, 'All problems cleared. Automatic closing is off, so the issue stays open until someone closes it', at);
  }

  #closeIssue(recordId, user, reason, at = nowIso()) {
    const o = this.open.get(recordId);
    if (!o) return;
    for (const [ruleId, pid] of o.active) {
      this.s.clearProblem.run(at, '', 'closed', pid);
      // Closed by hand while still happening: stays closed until the problem stops and comes back.
      const [k, w] = this.#w(ruleId, recordId);
      w.s = true; w.c = null; w.m = 0;
      this.#saveWatch(k, w);
    }
    o.active.clear();
    this.s.close.run(at, user?.name ?? null, reason, at, o.id);
    this.open.delete(recordId);
    this.#event(o.id, 'closed', user, user ? `Closed by ${user.name}${reason ? `: ${reason}` : ''}` : `Closed automatically: ${reason}`, at);
  }

  #forgetRecords(ids, reason, all = false) {
    let dirty = false;
    this.db.transaction(() => {
      for (const id of ids) {
        if (this.open.has(id)) {
          const o = this.open.get(id);
          for (const pid of o.active.values()) this.s.clearProblem.run(nowIso(), '', 'deleted', pid);
          o.active.clear();
          this.#closeIssue(id, null, reason);
          dirty = true;
        }
        if (!all) { this.s.watchDelRecord.run(id); this.db.prepare('DELETE FROM issue_mutes WHERE record_id = ?').run(id); this.mutes.delete(id); }
      }
      if (all) { this.db.exec('DELETE FROM issue_watch; DELETE FROM issue_mutes'); this.watch.clear(); this.mutes.clear(); }
      else if (ids.length) {
        const gone = new Set(ids);
        for (const k of [...this.watch.keys()]) if (gone.has(k.slice(k.indexOf('\0') + 1))) this.watch.delete(k);
      }
    })();
    if (dirty) this.onChange();
  }

  // ------------------------------------------------------------ people actions
  #mustBeOn() {
    if (!this.enabled) throw new HttpError(409, 'The issues list is turned off. An admin can turn it on in Admin → Issues.');
  }
  #row(id) {
    const row = this.s.getIssue.get(Number(id));
    if (!row) throw new HttpError(404, 'Issue not found');
    return row;
  }
  #openFor(row) {
    const o = this.open.get(row.record_id);
    if (!o || o.id !== row.id) throw new HttpError(409, 'This issue is already closed');
    return o;
  }

  assign(id, assignee, user) {
    this.#mustBeOn();
    const row = this.#row(id);
    let u = null;
    if (assignee !== null && assignee !== undefined) {
      if (!Number.isSafeInteger(assignee) || assignee < 1) throw new HttpError(400, 'assignee must be a user id (a whole number) or null to unassign');
      u = this.accounts.get(assignee);
      if (!u) throw new HttpError(400, 'That user no longer exists');
      if (u.disabled) throw new HttpError(400, `${u.name || u.username} is disabled`);
    }
    if ((row.assigned_to ?? null) === (u?.id ?? null)) return this.get(id);
    const at = nowIso();
    this.db.transaction(() => {
      this.s.assign.run(u?.id ?? null, u ? (u.name || u.username) : null, at, row.id);
      this.#event(row.id, 'assigned', user, u ? `Assigned to ${u.name || u.username} by ${user.name}` : `Unassigned by ${user.name}${row.assigned_name ? ` (was ${row.assigned_name})` : ''}`, at);
    })();
    this.onChange();
    return this.get(id);
  }

  /**
   * Ignore an issue for a while. With no `problems` it is the whole device (the issue leaves the Open
   * list; a new kind of problem brings it back). With `problems` (rule ids from its active problems) only
   * those are ignored, on this device, for that long: the others still count, and the ignore keeps
   * applying if the issue closes and the problem comes back inside the time.
   */
  ignore(id, minutes, user, problems) {
    this.#mustBeOn();
    const row = this.#row(id);
    const o = this.#openFor(row);
    const m = Math.round(Number(minutes));
    if (!Number.isFinite(m) || m < 1 || m > MAX_IGNORE_MIN) throw new HttpError(400, `Ignore for between 1 minute and ${MAX_IGNORE_MIN / 1440} days`);
    const at = nowIso();
    const until = new Date(Date.now() + m * 60000).toISOString();
    if (problems === undefined || problems === null || problems === 'all') {
      this.db.transaction(() => {
        this.s.setStatus.run('ignored', until, user.name, 'device', at, row.id);
        o.status = 'ignored';
        this.#event(row.id, 'ignored', user, `Ignored by ${user.name} until ${until} (${fmtMinutes(m)})`, at);
      })();
    } else {
      if (!Array.isArray(problems) || !problems.length || problems.some((r) => typeof r !== 'string')) throw new HttpError(400, 'problems must be "all" or a list of the problems to ignore');
      const rules = [...new Set(problems)];
      const bad = rules.filter((r) => !o.active.has(r));
      if (bad.length) throw new HttpError(400, 'Only problems that are happening now can be ignored');
      this.db.transaction(() => {
        let byRule = this.mutes.get(row.record_id);
        if (!byRule) this.mutes.set(row.record_id, byRule = new Map());
        for (const r of rules) { byRule.set(r, { until, by: user.name }); this.s.muteSet.run(row.record_id, r, until, user.name, at); }
        this.#event(row.id, 'ignored', user, `${rules.map((r) => this.#ruleName(r)).join(', ')} ignored on this device by ${user.name} until ${until} (${fmtMinutes(m)})`, at);
        this.#syncIgnore(row.record_id, at);
      })();
    }
    this.onChange();
    return this.get(id);
  }

  /** Stop ignoring: the whole device (and every ignored problem), or just the listed problems (rule ids). */
  unignore(id, user, problems) {
    this.#mustBeOn();
    const row = this.#row(id);
    const o = this.#openFor(row);
    const at = nowIso();
    const list = Array.isArray(problems) && problems.length ? [...new Set(problems.filter((r) => typeof r === 'string'))] : null;
    const byRule = this.mutes.get(row.record_id);
    const mutedHere = byRule ? [...byRule.keys()] : [];
    const fresh = list ? list.filter((r) => mutedHere.includes(r)) : mutedHere;
    if (!list && o.status !== 'ignored' && !fresh.length) return this.get(id);
    if (list && !fresh.length) return this.get(id);
    this.db.transaction(() => {
      for (const r of fresh) { byRule.delete(r); this.s.muteDel.run(row.record_id, r); }
      if (byRule && !byRule.size) this.mutes.delete(row.record_id);
      if (!list && o.status === 'ignored') {
        this.s.setStatus.run('open', null, null, null, at, row.id);
        o.status = 'open';
      }
      this.#event(row.id, 'unignored', user, list || fresh.length ? `No longer ignoring ${fresh.map((r) => this.#ruleName(r)).join(', ')} (${user.name})` : `No longer ignored (${user.name})`, at);
      this.#syncIgnore(row.record_id, at);
    })();
    this.onChange();
    return this.get(id);
  }

  closeByUser(id, note, user) {
    this.#mustBeOn();
    const row = this.#row(id);
    this.#openFor(row);
    if (note !== undefined && note !== null && typeof note !== 'string') throw new HttpError(400, 'The reason must be text');
    const reason = cleanText(note, 500, 'The reason');
    this.db.transaction(() => this.#closeIssue(row.record_id, user, reason))();
    this.onChange();
    return this.get(id);
  }

  addNote(id, text, user) {
    this.#mustBeOn();
    const row = this.#row(id);
    if (text !== undefined && text !== null && typeof text !== 'string') throw new HttpError(400, 'The note must be text');
    const t = String(text ?? '').trim();
    if (!t) throw new HttpError(400, 'Write a note first');
    if (t.length > 4000) throw new HttpError(400, 'Notes must be 4000 characters or fewer');
    this.db.transaction(() => this.#event(row.id, 'note', user, t))();
    this.onChange();
    return this.get(id);
  }

  deleteNote(id, eventId, user, canAny) {
    this.#mustBeOn();
    const row = this.#row(id);
    const ev = this.db.prepare("SELECT * FROM issue_events WHERE id = ? AND issue_id = ? AND type = 'note'").get(Number(eventId), row.id);
    if (!ev) throw new HttpError(404, 'Note not found');
    if (!canAny && (ev.user_id === null || ev.user_id !== user.id)) throw new HttpError(403, 'You can only delete your own notes');
    this.db.prepare('DELETE FROM issue_events WHERE id = ?').run(ev.id);
    this.s.touch.run(nowIso(), row.id);
    this.onChange();
    return this.get(id);
  }

  clearAll() {
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM issues').get().n;
    this.db.transaction(() => {
      this.db.exec('DELETE FROM issue_events; DELETE FROM issue_problems; DELETE FROM issues; DELETE FROM issue_mutes;');
      this.mutes.clear();
      // Problems that are still happening open fresh issues; manual-close holds are forgotten too.
      for (const [k, w] of [...this.watch]) { w.s = false; w.c = null; w.m = 0; this.#saveWatch(k, w); }
    })();
    this.open.clear();
    if (this.enabled) this.#evaluateAll();
    this.onChange();
    return n;
  }

  // ------------------------------------------------------------ reading
  #shape(row, problems) {
    const active = problems.filter((p) => !p.cleared_at);
    const now = nowIso();
    const mute = (p) => (p.cleared_at ? null : this.mutes.get(row.record_id)?.get(p.rule_id) || null);
    const muteNow = (p) => { const m = mute(p); return m && m.until > now ? m : null; };
    // Severity and the title count the problems that still need attention (ignored ones don't), unless that is all there is.
    const live = active.filter((p) => !muteNow(p));
    const shown = live.length ? live : active;
    const sevOf = (list) => list.reduce((best, p) => (sevRank(p.severity) > sevRank(best) ? p.severity : best), 'info');
    return {
      id: row.id,
      recordId: row.record_id,
      status: row.status,
      title: [...new Set((shown.length ? shown : problems).map((p) => p.name))].join(', ') || '(no problems)',
      severity: problems.length ? sevOf(shown.length ? shown : problems) : 'info',
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      closedBy: row.closed_by,
      closeReason: row.close_reason,
      assignedTo: row.assigned_to,
      assignedName: row.assigned_name,
      ignoredUntil: row.ignored_until,
      ignoredBy: row.ignored_by,
      ignoreScope: row.status === 'ignored' ? (row.ignore_scope || 'device') : null,
      updated: row.updated,
      activeCount: active.length,
      // Still open with nothing left (only when automatic closing is off).
      allClear: row.status !== 'closed' && problems.length > 0 && !active.length,
      clearedAt: row.status !== 'closed' && problems.length && !active.length ? problems.map((p) => p.cleared_at).sort().pop() : null,
      problems: problems.map((p) => ({
        id: p.id, ruleId: p.rule_id, name: p.name, severity: p.severity, rule: p.rule_text,
        ignoredUntil: muteNow(p)?.until || null, ignoredBy: muteNow(p)?.by || null,
        startedAt: p.started_at, addedAt: p.added_at, startValue: p.start_value,
        clearedAt: p.cleared_at, clearValue: p.clear_value, clearedHow: p.cleared_how,
      })),
    };
  }

  get(id) {
    const row = this.#row(id);
    const out = this.#shape(row, this.s.problems.all(row.id));
    out.events = this.s.events.all(row.id).map((e) => ({ id: e.id, at: e.at, type: e.type, userId: e.user_id, userName: e.user_name, text: e.text }));
    out.snapshot = row.snapshot ? JSON.parse(row.snapshot) : null;
    out.current = this.store.get(row.record_id);
    if (out.current) delete out.current._boxes;
    return out;
  }

  #where(q, me) {
    const where = [];
    const args = [];
    const st = String(q.status || 'active');
    if (st === 'active') where.push("status != 'closed'");
    else if (['open', 'ignored', 'closed'].includes(st)) { where.push('status = ?'); args.push(st); }
    else if (st === 'allclear') where.push(ALL_CLEAR);
    else if (st !== 'all') throw new HttpError(400, 'status must be active, open, ignored, allclear, closed or all');
    const a = q.assignee;
    if (a === 'me') { where.push('assigned_to = ?'); args.push(me ?? -1); }
    else if (a === 'none') where.push('assigned_to IS NULL');
    else if (a !== undefined && a !== '') { where.push('assigned_to = ?'); args.push(Number(a)); }
    const text = String(q.q || '').trim();
    if (text) {
      const like = '%' + text.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      where.push("(record_id LIKE ? ESCAPE '\\' OR assigned_name LIKE ? ESCAPE '\\' OR CAST(id AS TEXT) = ? OR id IN (SELECT issue_id FROM issue_problems WHERE name LIKE ? ESCAPE '\\'))");
      args.push(like, like, text.replace(/^#/, ''), like);
    }
    if (q.since) { where.push('opened_at >= ?'); args.push(String(q.since)); }
    return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
  }

  list(q = {}, me = null) {
    const { sql, args } = this.#where(q, me);
    const limit = Math.min(1000, Math.max(1, wholeNumber(q.limit, 200, 'limit')));
    const offset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, wholeNumber(q.offset, 0, 'offset')));
    // Ties (same opened time) go the same way as the sort, by issue number.
    const order = q.sort === 'updated' ? 'updated DESC, id DESC' : q.sort === 'opened_asc' ? 'opened_at ASC, id ASC' : 'opened_at DESC, id DESC';
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM issues ${sql}`).get(...args).n;
    const rows = this.db.prepare(`SELECT * FROM issues ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const probs = new Map();
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      for (const p of this.db.prepare(`SELECT * FROM issue_problems WHERE issue_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids)) {
        if (!probs.has(p.issue_id)) probs.set(p.issue_id, []);
        probs.get(p.issue_id).push(p);
      }
    }
    return { issues: rows.map((r) => this.#shape(r, probs.get(r.id) || [])), total, summary: this.summary(me) };
  }

  summary(me = null) {
    const r = this.db.prepare(`SELECT
      SUM(status = 'open') AS open, SUM(status = 'ignored') AS ignored,
      SUM(status != 'closed' AND assigned_to IS NULL) AS unassigned,
      SUM(status != 'closed' AND assigned_to = ?) AS mine,
      SUM(${ALL_CLEAR}) AS allClear,
      SUM(status = 'closed') AS closed, COUNT(*) AS total FROM issues`).get(me ?? -1);
    const out = {};
    for (const k of Object.keys(r)) out[k] = Number(r[k] || 0);
    return out;
  }

  /** CSV: one row per issue (with every problem, note and log line), or one row per log entry. */
  *csv(q, me) {
    const { sql, args } = this.#where({ ...q, status: q.status || 'all' }, me);
    const rows = this.db.prepare(`SELECT * FROM issues ${sql} ORDER BY opened_at, id`).iterate(...args);
    if (q.kind === 'log') {
      yield csvRow(['issue_id', 'device', 'issue_status', 'at', 'type', 'user', 'text']);
      for (const row of rows) for (const e of this.s.events.all(row.id)) yield csvRow([row.id, row.record_id, row.status, e.at, e.type, e.user_name || '', e.text]);
      return;
    }
    yield csvRow(['issue_id', 'device', 'status', 'severity', 'problems', 'active_problems', 'opened_at', 'closed_at', 'duration_min',
      'closed_by', 'close_reason', 'assigned_to', 'ignored_until', 'ignored_by', 'problem_details', 'notes', 'log']);
    for (const row of rows) {
      const probs = this.s.problems.all(row.id);
      const s = this.#shape(row, probs);
      const events = this.s.events.all(row.id);
      const end = row.closed_at || nowIso();
      yield csvRow([
        row.id, row.record_id, row.status, s.severity,
        [...new Set(probs.map((p) => p.name))].join('; '),
        probs.filter((p) => !p.cleared_at).map((p) => p.name).join('; '),
        row.opened_at, row.closed_at || '', Math.round(msBetween(row.opened_at, end) / 600) / 100,
        row.closed_by || (row.closed_at ? '(automatic)' : ''), row.close_reason || '', row.assigned_name || '',
        row.ignored_until || '', row.ignored_by || '',
        probs.map((p) => `${p.name} [${p.rule_text}] started ${p.started_at}${p.start_value ? ` (${p.start_value})` : ''}${p.cleared_at ? `, ${p.cleared_how} ${p.cleared_at}${p.clear_value ? ` (${p.clear_value})` : ''}` : ', still active'}`).join('\n'),
        events.filter((e) => e.type === 'note').map((e) => `${e.at} ${e.user_name || ''}: ${e.text}`).join('\n'),
        events.filter((e) => e.type !== 'note').map((e) => `${e.at} ${e.text}`).join('\n'),
      ]);
    }
  }

  assignees() {
    return this.db.prepare('SELECT id, username, name, role FROM users WHERE disabled = 0 ORDER BY COALESCE(NULLIF(name, \'\'), username) COLLATE NOCASE')
      .all().map((u) => ({ id: u.id, username: u.username, name: u.name || u.username, role: u.role }));
  }
}

/** A query-string number: blank = fallback; anything that isn't a finite number is a 400. */
function wholeNumber(v, fallback, what) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new HttpError(400, `${what} must be a number`);
  return Math.trunc(n);
}

export function fmtMinutes(m) {
  if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? '' : 's'}`;
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? '' : 's'}`;
  return `${m} min`;
}

export function registerIssues(app, { issues, can }) {
  const who = (req) => ({ id: req.auth.userId ?? null, name: req.auth.user?.name || req.auth.user?.username || req.auth.name || 'unknown' });
  const view = { config: { cap: 'issues' } };
  const work = { config: { cap: 'issueWork' } };
  const rules = { config: { cap: 'issueRules' } };
  const on = () => { if (!issues.enabled) throw new HttpError(409, 'The issues list is turned off. An admin can turn it on in Admin → Issues.'); };
  const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);

  app.get('/api/issues/config', view, async () => ({ ...issues.settings(), rules: issues.publicRules(), version: issues.version, severities: SEVERITIES }));
  app.put('/api/admin/issues', { config: { cap: 'issuesEnable' } }, async (req) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const hasEnabled = Object.hasOwn(b, 'enabled');
    const hasAutoClose = Object.hasOwn(b, 'autoClose');
    if (!hasEnabled && !hasAutoClose) throw new HttpError(400, 'Body must be { "enabled": true } and/or { "autoClose": false }');
    if (hasEnabled && typeof b.enabled !== 'boolean') throw new HttpError(400, '"enabled" must be true or false');
    if (hasAutoClose && typeof b.autoClose !== 'boolean') throw new HttpError(400, '"autoClose" must be true or false');
    if (hasAutoClose) issues.setAutoClose(b.autoClose, who(req));
    if (hasEnabled) issues.setEnabled(b.enabled);
    return issues.settings();
  });
  app.put('/api/issues/settings', rules, async (req) => issues.updateSettings(req.body || {}));
  app.put('/api/issues/rules', rules, async (req) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const settings = Object.hasOwn(b, 'reassignMinutes') ? { reassignMinutes: b.reassignMinutes } : undefined;
    const out = issues.saveRules(b.rules, b.version, who(req), settings);
    return settings ? { ...out, reassignMinutes: issues.settings().reassignMinutes } : out;
  });

  // `?quiet=1` (the Issues page's live reloads): when the list has just been turned off, answer
  // { enabled: false } with 200 rather than 409, so a reload racing the switch doesn't log an error.
  const off = (req) => (String(req.query.quiet) === '1' && !issues.enabled ? { enabled: false } : null);
  app.get('/api/issues', view, async (req) => off(req) || (on(), issues.list(req.query, req.auth.userId)));
  app.get('/api/issues/summary', view, async (req) => ({ enabled: issues.enabled, ...issues.summary(req.auth.userId) }));
  app.get('/api/issues/assignees', work, async () => { on(); return { users: issues.assignees() }; });
  app.get('/api/issues/export.csv', { config: { cap: 'export' } }, async (req, reply) => {
    on();
    if (!can(req.auth.role, 'issues')) throw new HttpError(403, 'Not allowed');
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="issues${req.query.kind === 'log' ? '-log' : ''}-${stamp()}.csv"`);
    return reply.send(Readable.from(issues.csv(req.query, req.auth.userId)));
  });
  app.delete('/api/issues', rules, async (req, reply) => {
    on();
    if (String(req.query.confirm) !== 'true') return reply.code(400).send({ ok: false, error: 'Add ?confirm=true to delete every issue, open and closed, with their notes and logs' });
    return { ok: true, deleted: issues.clearAll() };
  });
  app.get('/api/issues/:id', view, async (req) => off(req) || (on(), issues.get(req.params.id)));
  app.put('/api/issues/:id/assign', work, async (req) => issues.assign(req.params.id, req.body?.assignee ?? null, who(req)));
  app.post('/api/issues/:id/ignore', work, async (req) => issues.ignore(req.params.id, req.body?.minutes, who(req), req.body?.problems));
  app.post('/api/issues/:id/unignore', work, async (req) => issues.unignore(req.params.id, who(req), req.body?.problems));
  app.post('/api/issues/:id/close', work, async (req) => issues.closeByUser(req.params.id, req.body?.reason, who(req)));
  app.post('/api/issues/:id/notes', work, async (req) => issues.addNote(req.params.id, req.body?.text, who(req)));
  app.delete('/api/issues/:id/notes/:noteId', work, async (req) => issues.deleteNote(req.params.id, req.params.noteId, who(req), can(req.auth.role, 'issueRules')));
}
