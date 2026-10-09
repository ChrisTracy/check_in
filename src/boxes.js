import crypto from 'node:crypto';
import { HttpError, jsonPath } from './store.js';

/**
 * Status boxes: optional cards under Active / Aging / Stale that count devices matching a rule,
 * such as "cpu_pct > 90 for at least 10 minutes". Power users and admins set them up; everyone
 * sees them.
 *
 * "For at least N minutes" means every check-in for that long matched. The server keeps, for each
 * box and device, the time the condition started being true ("since"), updated on every check-in
 * and stored so it survives restarts. Records carry it to the dashboard as `_boxes: { boxId: since }`,
 * and the dashboard decides what counts (since <= now - minutes, optionally skipping stale devices).
 */
export const BOX_OPS = {
  gt: '>', gte: '≥', lt: '<', lte: '≤', eq: 'is', neq: 'is not',
  contains: 'contains', ncontains: 'does not contain', empty: 'is empty', nempty: 'is not empty',
};
const NO_VALUE = new Set(['empty', 'nempty']);
export const BOX_TONES = ['bad', 'warn', 'info', 'neutral'];
const MAX_BOXES = 24;
const MAX_MINUTES = 7 * 24 * 60;

const isBlank = (v) => v === undefined || v === null || v === '';
const isNumeric = (v) => typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));
const show = (v) => (isBlank(v) ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Does `data` (a record's fields) match the box's condition? */
export function testBox(box, data) {
  const v = box.field === 'id' ? data.id : data[box.field];
  switch (box.op) {
    case 'empty': return isBlank(v);
    case 'nempty': return !isBlank(v);
    case 'eq': return !isBlank(v) && show(v).toLowerCase() === box.value.toLowerCase();
    case 'neq': return show(v).toLowerCase() !== box.value.toLowerCase();
    case 'contains': return !isBlank(v) && show(v).toLowerCase().includes(box.value.toLowerCase());
    case 'ncontains': return !show(v).toLowerCase().includes(box.value.toLowerCase());
    default: {
      if (isBlank(v)) return false;
      const c = isNumeric(v) && isNumeric(box.value) ? Number(v) - Number(box.value) : collator.compare(show(v), box.value);
      return box.op === 'gt' ? c > 0 : box.op === 'gte' ? c >= 0 : box.op === 'lt' ? c < 0 : c <= 0;
    }
  }
}

/** Validate one box from the editor. Returns a clean copy or throws a 400. */
function cleanBox(b, i) {
  const where = `Box ${i + 1}`;
  if (!b || typeof b !== 'object') throw new HttpError(400, `${where} is not valid`);
  const name = String(b.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new HttpError(400, `${where} needs a name`);
  if (name.length > 40) throw new HttpError(400, `${where}: the name must be 40 characters or fewer`);
  const field = String(b.field ?? '').trim();
  if (!field) throw new HttpError(400, `“${name}” needs a field`);
  if (field.length > 200) throw new HttpError(400, `“${name}”: the field name is too long`);
  const op = String(b.op ?? '');
  if (!BOX_OPS[op]) throw new HttpError(400, `“${name}”: unknown condition`);
  const value = NO_VALUE.has(op) ? '' : String(b.value ?? '').trim();
  if (!NO_VALUE.has(op) && value === '') throw new HttpError(400, `“${name}” needs a value to compare with`);
  if (value.length > 200) throw new HttpError(400, `“${name}”: the value is too long`);
  const minutes = Math.round(Number(b.minutes ?? 0));
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > MAX_MINUTES) throw new HttpError(400, `“${name}”: minutes must be between 0 and ${MAX_MINUTES}`);
  // Ids are always server-made 8-hex strings (never e.g. "constructor", which plain objects already have).
  const id = typeof b.id === 'string' && /^[0-9a-f]{8}$/.test(b.id) ? b.id : crypto.randomBytes(4).toString('hex');
  return {
    id, name, field, op, value, minutes,
    tone: BOX_TONES.includes(b.tone) ? b.tone : 'warn',
    ignoreStale: b.ignoreStale !== false,
    enabled: b.enabled !== false,
  };
}
const ruleKey = (b) => JSON.stringify([b.field, b.op, b.value]);

export class StatBoxes {
  constructor({ db, store, accounts }) {
    this.db = db;
    this.store = store;
    this.accounts = accounts;
    db.exec(`
      CREATE TABLE IF NOT EXISTS box_state (
        box_id    TEXT NOT NULL,
        record_id TEXT NOT NULL,
        since     TEXT NOT NULL,
        PRIMARY KEY (box_id, record_id)
      );
      CREATE INDEX IF NOT EXISTS idx_box_state_record ON box_state(record_id);
    `);
    this.s = {
      set: db.prepare('INSERT INTO box_state (box_id, record_id, since) VALUES (?, ?, ?) ON CONFLICT(box_id, record_id) DO UPDATE SET since = excluded.since'),
      del: db.prepare('DELETE FROM box_state WHERE box_id = ? AND record_id = ?'),
      delRecord: db.prepare('DELETE FROM box_state WHERE record_id = ?'),
      delBox: db.prepare('DELETE FROM box_state WHERE box_id = ?'),
    };
    this.boxes = this.#loadDefs();
    /** recordId -> { boxId: since } */
    this.state = new Map();
    for (const r of db.prepare('SELECT box_id, record_id, since FROM box_state').all()) this.#put(r.record_id, r.box_id, r.since);
    this.#reconcile();

    store.decorate = (id) => this.state.get(id) || null;
    store.on('written', (results) => this.#onWritten(results));
    store.on('delete', ({ ids }) => this.#forget(ids));
    store.on('clear', () => { this.db.exec('DELETE FROM box_state'); this.state.clear(); });
  }

  #loadDefs() {
    const raw = this.accounts.getSetting('statBoxes', []);
    if (!Array.isArray(raw)) return [];
    const out = [];
    raw.forEach((b, i) => { try { out.push(cleanBox(b, i)); } catch { /* skip a broken box */ } });
    return out;
  }

  list() { return this.boxes; }
  /** Bumps on every save, so an editor working from an old copy can't overwrite newer changes. */
  get version() { return this.accounts.getSetting('statBoxesVersion', 0); }

  #put(recordId, boxId, since) {
    let m = this.state.get(recordId);
    if (!m) this.state.set(recordId, (m = Object.create(null)));
    m[boxId] = since;
  }
  #drop(recordId, boxId) {
    const m = this.state.get(recordId);
    if (!m || !(boxId in m)) return;
    delete m[boxId];
    if (!Object.keys(m).length) this.state.delete(recordId);
  }

  /** Check-ins: start or end each box's "since" for the records just written. */
  #onWritten(results) {
    if (!this.boxes.length) return;
    this.db.transaction(() => {
      for (const r of results) {
        const rec = r?.record;
        if (!rec) continue;
        const cur = this.state.get(rec.id);
        for (const b of this.boxes) {
          const hit = testBox(b, rec);
          const had = cur && b.id in cur;
          if (hit && !had) { this.#put(rec.id, b.id, rec.modified); this.s.set.run(b.id, rec.id, rec.modified); }
          else if (!hit && had) { this.#drop(rec.id, b.id); this.s.del.run(b.id, rec.id); }
        }
      }
    })();
  }

  #forget(ids) {
    this.db.transaction(() => {
      for (const id of ids) { if (this.state.delete(id)) this.s.delRecord.run(id); }
    })();
  }

  /**
   * Work out "since" for boxes whose rule is new or changed: for each device that matches now,
   * walk back through its stored history while the check-ins kept matching. Reads just the one
   * field (SQLite's -> operator) and stops as soon as the answer is known, so it stays quick with
   * thousands of devices and long histories:
   *   - at the first check-in that didn't match;
   *   - once it has gone back further than the box's minutes (enough to know the device counts);
   *   - for "0 minutes" boxes, after PAGE * 2 check-ins (only used to show "since" in the details).
   * With a short HISTORY_LIMIT it can only look back as far as the history goes.
   */
  async #backfill(boxes) {
    if (!boxes.length) return;
    const PAGE = 25;
    const CHUNK = 250; // devices per slice; check-ins are served between slices
    const now = Date.now();
    const keepsHistory = this.store.historyLimit !== 0;
    const one = this.db.prepare('SELECT id, created, modified, data -> ? AS v FROM records WHERE id = ?');
    const page = this.db.prepare('SELECT hid, at, data -> ? AS v FROM history WHERE record_id = ? AND hid < ? ORDER BY hid DESC LIMIT ?');
    const parse = (v) => (v === null || v === undefined ? undefined : JSON.parse(v));
    for (const b of boxes) {
      const path = jsonPath(b.field);
      const cutoff = new Date(now - b.minutes * 60000).toISOString();
      const maxWalk = b.minutes > 0 ? Infinity : 10; // 0-minute boxes only need history for the "since" shown in details
      const ids = this.db.prepare('SELECT id FROM records').all().map((r) => r.id);
      for (let i = 0; i < ids.length; i += CHUNK) {
        if (i) await new Promise((r) => setImmediate(r));
        if (!this.boxes.some((x) => x.id === b.id && ruleKey(x) === ruleKey(b))) return; // replaced by a newer save
        this.db.transaction(() => {
          for (const id of ids.slice(i, i + CHUNK)) {
            // Read each record now (not from a list taken earlier): check-ins keep arriving meanwhile.
            const r = one.get(path, id);
            this.#drop(id, b.id);
            this.s.del.run(b.id, id);
            if (!r) continue;
            const valueAt = (v, at) => (b.field === 'id' ? r.id : b.field === 'created' ? r.created : b.field === 'modified' ? at : parse(v));
            if (!testBox(b, { id: r.id, [b.field]: valueAt(r.v, r.modified) })) continue;
            let since = r.modified;
            if (keepsHistory) {
              let before = Number.MAX_SAFE_INTEGER;
              let walked = 0;
              let done = false;
              while (!done) {
                const hs = page.all(path, r.id, before, PAGE);
                for (const h of hs) {
                  before = h.hid;
                  if (h.at >= r.modified) continue; // the snapshot of the current state
                  if (!testBox(b, { id: r.id, [b.field]: valueAt(h.v, h.at) })) { done = true; break; }
                  since = h.at;
                  if (++walked >= maxWalk || (b.minutes > 0 && h.at <= cutoff)) { done = true; break; }
                }
                if (hs.length < PAGE) done = true;
              }
            }
            this.#put(r.id, b.id, since);
            this.s.set.run(b.id, r.id, since);
          }
        })();
      }
    }
  }

  /** Startup: make the stored state agree with the current records (cheap; no history reads). */
  #reconcile() {
    if (!this.boxes.length) { this.db.exec('DELETE FROM box_state'); this.state.clear(); return; }
    const ids = new Set(this.boxes.map((b) => b.id));
    this.db.transaction(() => {
      for (const id of this.db.prepare('SELECT DISTINCT box_id FROM box_state').all().map((r) => r.box_id)) {
        if (!ids.has(id)) this.s.delBox.run(id);
      }
      this.state.forEach((m) => { for (const k of Object.keys(m)) if (!ids.has(k)) delete m[k]; }); // empty maps are pruned below
      for (const rec of this.store.iterate()) {
        for (const b of this.boxes) {
          const hit = testBox(b, rec);
          const had = this.state.get(rec.id)?.[b.id];
          if (hit && !had) { this.#put(rec.id, b.id, rec.modified); this.s.set.run(b.id, rec.id, rec.modified); }
          else if (!hit && had) { this.#drop(rec.id, b.id); this.s.del.run(b.id, rec.id); }
        }
      }
      for (const [id, m] of [...this.state]) if (!Object.keys(m).length || !this.store.s.get.get(id)) { this.state.delete(id); this.s.delRecord.run(id); }
    })();
  }

  /** Replace the whole list (the editor saves everything at once). */
  /** Saves run one at a time (each may recompute box state in slices). */
  save(list, version) {
    const run = (this.saving || Promise.resolve()).then(() => this.#save(list, version));
    this.saving = run.catch(() => {});
    return run;
  }

  async #save(list, version) {
    if (!Array.isArray(list)) throw new HttpError(400, 'boxes must be a list');
    if (version !== undefined && Number(version) !== this.version) {
      throw new HttpError(409, 'Someone else changed the status boxes while you were editing. Close this and open it again to see their changes.');
    }
    if (list.length > MAX_BOXES) throw new HttpError(400, `At most ${MAX_BOXES} boxes`);
    const next = list.map(cleanBox);
    const seen = new Set();
    for (const b of next) { if (seen.has(b.id)) b.id = crypto.randomBytes(4).toString('hex'); seen.add(b.id); }
    const before = new Map(this.boxes.map((b) => [b.id, b]));
    const changed = next.filter((b) => !before.has(b.id) || ruleKey(before.get(b.id)) !== ruleKey(b));
    const removed = [...before.keys()].filter((id) => !next.some((b) => b.id === id));
    this.store.flush(); // so the backfill sees every check-in already accepted
    this.accounts.setSetting('statBoxes', next);
    this.accounts.setSetting('statBoxesVersion', this.version + 1);
    this.boxes = next;
    const clear = [...removed, ...changed.filter((b) => before.has(b.id)).map((b) => b.id)];
    this.db.transaction(() => { for (const id of clear) this.s.delBox.run(id); })();
    for (const [rid, m] of [...this.state]) {
      for (const id of clear) delete m[id];
      if (!Object.keys(m).length) this.state.delete(rid);
    }
    await this.#backfill(changed);
    return { boxes: next, version: this.version, recomputed: changed.length > 0 || removed.length > 0 };
  }
}

export function registerBoxes(app, { boxes, broadcast }) {
  app.get('/api/boxes', { config: { cap: 'view' } }, async () => ({ boxes: boxes.list(), version: boxes.version }));
  app.put('/api/boxes', { config: { cap: 'boxes' } }, async (req) => {
    const r = await boxes.save(req.body?.boxes, req.body?.version);
    broadcast('boxes', { reload: r.recomputed, version: r.version });
    return { ok: true, boxes: r.boxes, version: r.version, recomputed: r.recomputed };
  });
}
