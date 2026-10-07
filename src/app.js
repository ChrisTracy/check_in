import path from 'node:path';
import querystring from 'node:querystring';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { HttpError, normalizeInput } from './store.js';
import { csvRow, parseCsv, decodeCell } from './csv.js';
import { ROOT } from './config.js';
import { registerAuth } from './auth/plugin.js';

const AUTH_QUERY_KEYS = new Set(['api_key', 'apikey']);
const MAX_BULK_DELETE = 100_000;

// querystring / form values can be arrays for repeated keys; the last one wins.
function flattenParams(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (AUTH_QUERY_KEYS.has(k.toLowerCase()) || k === '__proto__') continue;
    out[k] = Array.isArray(v) ? v[v.length - 1] : v;
  }
  return out;
}

function stamp() {
  return new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
}

export function buildApp({ config, store, accounts, oidc }) {
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    bodyLimit: config.bodyLimitMb * 1024 * 1024,
    keepAliveTimeout: 65_000,
    trustProxy: config.trustProxy,
  });

  // ---- body parsers ------------------------------------------------------
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    try { done(null, querystring.parse(body)); } catch (e) { done(e); }
  });
  app.addContentTypeParser(['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'],
    { parseAs: 'string' }, (req, body, done) => done(null, body));

  app.register(fastifyCookie);

  // ---- security headers --------------------------------------------------
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    return payload;
  });

  // ---- CORS (optional) ---------------------------------------------------
  if (config.corsOrigin) {
    app.addHook('onRequest', async (req, reply) => {
      reply.header('Access-Control-Allow-Origin', config.corsOrigin);
      reply.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') return reply.code(204).send();
    });
  }

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode || 500;
    if (status >= 500) req.log.error(err);
    reply.code(status).send({ ok: false, error: status >= 500 && !err.statusCode ? 'Internal error' : err.message });
  });

  // ---- live updates (Server-Sent Events) ---------------------------------
  const clients = new Set();
  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };

  // ---- auth --------------------------------------------------------------
  registerAuth(app, { accounts, oidc, config, broadcast });

  // ---- static assets -----------------------------------------------------
  app.register(fastifyStatic, { root: path.join(ROOT, 'public'), prefix: '/', index: false });

  app.get('/health', async () => ({ ok: true }));
  app.get('/api/config', { config: { cap: 'public' } }, async () => ({
    historyLimit: config.historyLimit,
    apiKeySet: accounts.apiKeyInfo().set,
  }));

  // ---- check-in (create or update) --------------------------------------
  app.post('/api/checkin', { config: { cap: 'checkin' } }, async (req, reply) => {
    const query = flattenParams(req.query);
    const body = req.body;

    if (Array.isArray(body)) {
      // Bulk: each element is its own check-in. Valid items are saved even if others fail.
      const pending = [];
      const errors = [];
      body.forEach((item, index) => {
        try {
          const merged = item && typeof item === 'object' && !Array.isArray(item) ? { ...query, ...item } : item;
          const { id, fields } = normalizeInput(merged, { maxFields: store.maxFields });
          pending.push(store.enqueue(id, fields).then((r) => ({ index, id, action: r.action, changed: r.changed })));
        } catch (e) {
          errors.push({ index, error: e.message });
        }
      });
      const results = await Promise.all(pending);
      return reply.code(errors.length && !results.length ? 400 : 200).send({
        ok: errors.length === 0,
        received: body.length,
        created: results.filter((r) => r.action === 'created').length,
        updated: results.filter((r) => r.action === 'updated').length,
        results,
        errors,
      });
    }

    const ct = req.headers['content-type'] || '';
    const fromBody = body && typeof body === 'object'
      ? (ct.includes('application/x-www-form-urlencoded') ? flattenParams(body) : body) : {};
    const result = await store.upsert({ ...query, ...fromBody });
    return reply.code(result.action === 'created' ? 201 : 200).send({ ok: true, ...result });
  });

  // ---- read --------------------------------------------------------------
  const view = { config: { cap: 'view' } };
  app.get('/api/records', view, async (req) => {
    const q = req.query;
    const filters = {};
    for (const [k, v] of Object.entries(flattenParams(q))) {
      if (k.startsWith('f.') && k.length > 2) filters[k.slice(2)] = v;
    }
    return store.list({
      sinceRev: q.sinceRev, q: q.q, filters, sort: q.sort, order: q.order, limit: q.limit, offset: q.offset,
    });
  });

  app.get('/api/records/:id', view, async (req, reply) => {
    const rec = store.get(req.params.id);
    if (!rec) return reply.code(404).send({ ok: false, error: 'Not found' });
    return rec;
  });

  app.get('/api/records/:id/history', view, async (req, reply) => {
    const rec = store.get(req.params.id);
    const history = store.history(req.params.id, { limit: req.query.limit });
    if (!rec && !history.length) return reply.code(404).send({ ok: false, error: 'Not found' });
    return { id: req.params.id, record: rec, history };
  });

  app.get('/api/history', view, async (req) => ({ history: store.recentHistory(req.query) }));
  app.get('/api/fields', view, async () => ({ fields: store.fields() }));
  app.get('/api/stats', view, async () => store.summary());

  // ---- delete ------------------------------------------------------------
  app.delete('/api/records/:id', { config: { cap: 'delete' } }, async (req, reply) => {
    if (!store.delete(req.params.id)) return reply.code(404).send({ ok: false, error: 'Not found' });
    return { ok: true };
  });

  // Delete several records at once: { "ids": ["a", "b", ...] }
  app.post('/api/records/delete', { config: { cap: 'delete' } }, async (req) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'Body must be { "ids": [ ... ] }');
    if (ids.length > MAX_BULK_DELETE) throw new HttpError(400, `At most ${MAX_BULK_DELETE} ids per request`);
    const deleted = store.deleteMany(ids);
    return { ok: true, requested: ids.length, deleted: deleted.length };
  });

  // Clears every record AND all history. Requires ?confirm=true to avoid accidents.
  app.delete('/api/records', { config: { cap: 'clearAll' } }, async (req, reply) => {
    if (String(req.query.confirm) !== 'true') {
      return reply.code(400).send({ ok: false, error: 'Add ?confirm=true to clear all records and history' });
    }
    return { ok: true, deleted: store.clearAll() };
  });

  // ---- CSV export --------------------------------------------------------
  app.get('/api/export.csv', { config: { cap: 'export' } }, async (req, reply) => {
    const requested = req.query.fields ? String(req.query.fields).split(',').map((s) => s.trim()).filter(Boolean) : null;
    const columns = requested || ['id', 'created', 'modified', ...store.fields().map((f) => f.name)];
    function* gen() {
      yield csvRow(columns);
      for (const rec of store.iterate()) yield csvRow(columns.map((c) => rec[c]));
    }
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="checkins-${stamp()}.csv"`);
    return reply.send(Readable.from(gen()));
  });

  app.get('/api/history/export.csv', { config: { cap: 'export' } }, async (req, reply) => {
    const fieldNames = store.fields().map((f) => f.name);
    const columns = ['history_id', 'id', 'version', 'action', 'at', 'changed_fields', ...fieldNames];
    function* gen() {
      yield csvRow(columns);
      for (const h of store.iterateHistory()) {
        yield csvRow([h.hid, h.id, h.version, h.action, h.at, Object.keys(h.changes).join(';'),
          ...fieldNames.map((f) => h.data[f])]);
      }
    }
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="checkin-history-${stamp()}.csv"`);
    return reply.send(Readable.from(gen()));
  });

  // ---- CSV import --------------------------------------------------------
  // Each row is processed as a check-in (create or update, with history).
  // Empty cells are skipped so they don't overwrite existing values.
  app.post('/api/import', { bodyLimit: config.importLimitMb * 1024 * 1024, config: { cap: 'import' } }, async (req) => {
    if (typeof req.body !== 'string') {
      throw new HttpError(415, 'Send the CSV file as the raw request body with Content-Type: text/csv');
    }
    let rows;
    try { rows = parseCsv(req.body); } catch (e) { throw new HttpError(400, 'Could not parse CSV: ' + e.message); }
    if (!rows.length) throw new HttpError(400, 'CSV has no data rows');
    const header = Object.keys(rows[0]);
    if (!header.some((h) => h.toLowerCase() === 'id')) throw new HttpError(400, 'CSV must have an "id" column');

    const errors = [];
    const pending = [];
    rows.forEach((row, i) => {
      try {
        const decoded = {};
        for (const k of Object.keys(row)) if (k !== '__proto__') decoded[k] = decodeCell(row[k]);
        const { id, fields } = normalizeInput(decoded, { maxFields: store.maxFields, skipEmpty: true });
        pending.push(store.enqueue(id, fields));
      } catch (e) {
        if (errors.length < 200) errors.push({ row: i + 2, error: e.message });
      }
    });
    const results = await Promise.all(pending);
    return {
      ok: true,
      rows: rows.length,
      imported: results.length,
      created: results.filter((r) => r.action === 'created').length,
      updated: results.filter((r) => r.action === 'updated').length,
      failed: rows.length - results.length,
      errors,
    };
  });

  // ---- SSE stream --------------------------------------------------------
  let pendingChange = null;
  let timer = null;
  // Coalesce bursts of writes into at most ~4 notifications per second.
  store.on('change', (e) => {
    pendingChange = { rev: e.rev, count: (pendingChange?.count || 0) + e.count };
    if (!timer) {
      timer = setTimeout(() => { timer = null; broadcast('change', pendingChange); pendingChange = null; }, 250);
    }
  });
  store.on('delete', (e) => {
    // Very large deletes: tell clients to reload instead of shipping every id.
    if (e.ids.length > 20_000) broadcast('reload', {});
    else broadcast('delete', e);
  });
  store.on('clear', () => broadcast('clear', {}));
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25_000);
  heartbeat.unref();

  app.get('/api/events', view, (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ rev: store.rev })}\n\n`);
    clients.add(res);
    req.raw.on('close', () => clients.delete(res));
  });

  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    clients.clear();
  });

  return app;
}
