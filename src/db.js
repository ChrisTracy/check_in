import fs from 'node:fs';
import path from 'node:path';

// Node's built-in SQLite (no native add-on to install or compile).
// Node 22 prints a one-time "experimental" notice for it; hide just that notice.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const msg = typeof warning === 'string' ? warning : warning?.message;
  if (msg && msg.includes('SQLite is an experimental feature')) return;
  return emitWarning.call(process, warning, ...args);
};
const { DatabaseSync } = await import('node:sqlite');

/**
 * Thin wrapper over node:sqlite's DatabaseSync that adds the two helpers the
 * app uses: pragma() and transaction().
 */
class Db {
  constructor(file) {
    this.raw = new DatabaseSync(file);
    this.depth = 0;
  }
  prepare(sql) { return this.raw.prepare(sql); }
  exec(sql) { this.raw.exec(sql); }
  pragma(p) { return this.raw.prepare(`PRAGMA ${p}`).all(); }
  close() { this.raw.close(); }

  /** Returns a function that runs fn inside BEGIN/COMMIT, rolling back on error. Nested calls join the outer transaction. */
  transaction(fn) {
    return (...args) => {
      if (this.depth > 0) return fn(...args);
      this.raw.exec('BEGIN IMMEDIATE');
      this.depth++;
      try {
        const result = fn(...args);
        this.raw.exec('COMMIT');
        return result;
      } catch (err) {
        try { this.raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      } finally {
        this.depth--;
      }
    };
  }
}

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Db(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -65536'); // 64 MB
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id       TEXT PRIMARY KEY,
      data     TEXT NOT NULL DEFAULT '{}',
      created  TEXT NOT NULL,
      modified TEXT NOT NULL,
      version  INTEGER NOT NULL DEFAULT 1,
      rev      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_records_rev ON records(rev);
    CREATE INDEX IF NOT EXISTS idx_records_modified ON records(modified);

    CREATE TABLE IF NOT EXISTS history (
      hid       INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id TEXT NOT NULL,
      version   INTEGER NOT NULL,
      action    TEXT NOT NULL,
      changes   TEXT NOT NULL,
      data      TEXT NOT NULL,
      at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_record ON history(record_id, hid);
  `);
  return db;
}
