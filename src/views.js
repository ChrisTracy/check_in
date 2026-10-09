import { HttpError } from './store.js';
import { can } from './auth/accounts.js';
import '../public/viewstate.js'; // defines globalThis.CheckinViewState (shared with the dashboard)

const { cleanViewState } = globalThis.CheckinViewState;

/**
 * Saved dashboard views, stored on the server.
 *   personal – owned by one user account, visible only to them.
 *   team     – visible to everyone; created/changed/deleted by power users and admins.
 */
const SCOPES = new Set(['personal', 'team']);
const MAX_STATE_BYTES = 64 * 1024;
const MAX_PERSONAL = 200;
const MAX_TEAM = 500;

function cleanName(name) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!n) throw new HttpError(400, 'View name is required');
  if (n.length > 80) throw new HttpError(400, 'View name must be 80 characters or fewer');
  if (n.toLowerCase() === 'default') throw new HttpError(400, '“Default” is reserved. Pick another name.');
  return n;
}

function cleanState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new HttpError(400, 'View state must be an object');
  // Type-checks every key: view state ends up in the dashboard's markup and styles.
  const json = JSON.stringify(cleanViewState(state));
  if (json.length > MAX_STATE_BYTES) throw new HttpError(400, 'View is too large');
  return json;
}

function safeParse(json) {
  try { return JSON.parse(json); } catch { return {}; }
}

const toView = (r) => ({
  // Cleaned on the way out too, so views saved by older versions can't carry bad values.
  id: r.id, scope: r.scope, name: r.name, state: cleanViewState(safeParse(r.state)),
  created: r.created, updated: r.updated, updatedBy: r.updated_by,
});

export class SavedViews {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS views (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        scope      TEXT NOT NULL CHECK (scope IN ('personal', 'team')),
        owner_id   INTEGER,
        name       TEXT NOT NULL COLLATE NOCASE,
        state      TEXT NOT NULL,
        created    TEXT NOT NULL,
        updated    TEXT NOT NULL,
        updated_by TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_views_name ON views(scope, IFNULL(owner_id, 0), name);
    `);
    this.s = {
      get: db.prepare('SELECT * FROM views WHERE id = ?'),
      byName: db.prepare('SELECT * FROM views WHERE scope = ? AND IFNULL(owner_id, 0) = ? AND name = ?'),
      count: db.prepare('SELECT COUNT(*) AS n FROM views WHERE scope = ? AND IFNULL(owner_id, 0) = ?'),
      personal: db.prepare("SELECT * FROM views WHERE scope = 'personal' AND owner_id = ? ORDER BY name"),
      team: db.prepare("SELECT * FROM views WHERE scope = 'team' ORDER BY name"),
    };
  }

  list(userId) {
    return {
      personal: userId ? this.s.personal.all(userId).map(toView) : [],
      team: this.s.team.all().map(toView),
    };
  }

  /** Throws unless `auth` may change views in `scope` (and, for personal views, owns it). */
  assertCanWrite(auth, scope, ownerId) {
    if (scope === 'team') {
      if (!can(auth.role, 'teamViews')) throw new HttpError(403, 'Only power users and admins can change team views');
      return;
    }
    if (!auth.userId) throw new HttpError(400, 'Personal views need a user account (not an API key)');
    if (ownerId !== undefined && ownerId !== auth.userId) throw new HttpError(404, 'View not found');
  }

  /** Create, or overwrite the view with the same name in the same scope. */
  save(auth, { scope = 'personal', name, state }) {
    if (!SCOPES.has(scope)) throw new HttpError(400, 'scope must be personal or team');
    this.assertCanWrite(auth, scope);
    const n = cleanName(name);
    const json = cleanState(state);
    const owner = scope === 'personal' ? auth.userId : null;
    const now = new Date().toISOString();
    const existing = this.s.byName.get(scope, owner || 0, n);
    if (existing) {
      this.db.prepare('UPDATE views SET name = ?, state = ?, updated = ?, updated_by = ? WHERE id = ?')
        .run(n, json, now, auth.name || '', existing.id);
      return { view: toView(this.s.get.get(existing.id)), created: false };
    }
    if (this.s.count.get(scope, owner || 0).n >= (scope === 'team' ? MAX_TEAM : MAX_PERSONAL)) {
      throw new HttpError(400, 'Too many saved views. Delete some first.');
    }
    const r = this.db.prepare('INSERT INTO views (scope, owner_id, name, state, created, updated, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(scope, owner, n, json, now, now, auth.name || '');
    return { view: toView(this.s.get.get(Number(r.lastInsertRowid))), created: true };
  }

  update(auth, id, { name, state }) {
    const row = this.s.get.get(Number(id));
    if (!row) throw new HttpError(404, 'View not found');
    this.assertCanWrite(auth, row.scope, row.scope === 'personal' ? row.owner_id : undefined);
    const n = name === undefined ? row.name : cleanName(name);
    const json = state === undefined ? row.state : cleanState(state);
    const clash = this.s.byName.get(row.scope, row.owner_id || 0, n);
    if (clash && clash.id !== row.id) throw new HttpError(409, `A view named “${n}” already exists`);
    this.db.prepare('UPDATE views SET name = ?, state = ?, updated = ?, updated_by = ? WHERE id = ?')
      .run(n, json, new Date().toISOString(), auth.name || '', row.id);
    return toView(this.s.get.get(row.id));
  }

  remove(auth, id) {
    const row = this.s.get.get(Number(id));
    if (!row) throw new HttpError(404, 'View not found');
    this.assertCanWrite(auth, row.scope, row.scope === 'personal' ? row.owner_id : undefined);
    this.db.prepare('DELETE FROM views WHERE id = ?').run(row.id);
    return row.scope;
  }

  removeOwner(userId) {
    this.db.prepare("DELETE FROM views WHERE scope = 'personal' AND owner_id = ?").run(userId);
  }
}

export function registerViews(app, { views, broadcast }) {
  const view = { config: { cap: 'view' } };
  const notify = (scope) => { if (scope === 'team') broadcast('views', { scope }); };

  app.get('/api/views', view, async (req) => ({ ok: true, ...views.list(req.auth.userId) }));

  app.post('/api/views', view, async (req, reply) => {
    const { view: v, created } = views.save(req.auth, req.body || {});
    notify(v.scope);
    return reply.code(created ? 201 : 200).send({ ok: true, created, view: v });
  });

  app.put('/api/views/:id', view, async (req) => {
    const v = views.update(req.auth, req.params.id, req.body || {});
    notify(v.scope);
    return { ok: true, view: v };
  });

  app.delete('/api/views/:id', view, async (req) => {
    notify(views.remove(req.auth, req.params.id));
    return { ok: true };
  });
}
