import zlib from 'node:zlib';
import { promisify } from 'node:util';

/**
 * Response compression (Brotli or gzip, whichever the browser prefers) for JSON, CSV, HTML,
 * scripts and styles. Written as a root onSend hook so it covers every route, including the
 * ones registered before plugins finish loading. Compression runs on libuv's thread pool, so
 * even the full record list (megabytes with thousands of devices) doesn't block check-ins.
 *
 * Skipped for: small bodies, already-encoded responses, partial (range) responses, HEAD,
 * and the SSE stream (it writes to the raw socket and never reaches this hook).
 */
const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const THRESHOLD = 1024;
// Quality 4 is about as fast as gzip and ~15% smaller; Brotli's default (11) is far too slow for live data.
const BROTLI = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } };
const GZIP = { level: 5 };
const COMPRESSIBLE = /^(?:text\/(?!event-stream)|application\/(?:json|javascript|xml|x-ndjson)|image\/svg\+xml)/i;

/** 'br' | 'gzip' | null for an Accept-Encoding header (honours q=0). */
export function pickEncoding(header) {
  if (!header) return null;
  const ok = new Map();
  for (const part of String(header).toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    ok.set(name.trim(), q ? Number(q.slice(2)) : 1);
  }
  const allowed = (e) => (ok.has(e) ? ok.get(e) > 0 : ok.has('*') && ok.get('*') > 0);
  if (allowed('br')) return 'br';
  if (allowed('gzip')) return 'gzip';
  return null;
}

function addVary(reply) {
  const v = reply.getHeader('vary');
  if (!v) reply.header('vary', 'Accept-Encoding');
  else if (!/accept-encoding/i.test(String(v))) reply.header('vary', `${v}, Accept-Encoding`);
}

export function registerCompression(app) {
  app.addHook('onSend', async (req, reply, payload) => {
    if (payload === null || payload === undefined || req.method === 'HEAD') return payload;
    if (reply.statusCode === 204 || reply.statusCode === 206 || reply.statusCode === 304) return payload;
    if (reply.getHeader('content-encoding') || reply.getHeader('content-range')) return payload;
    if (!COMPRESSIBLE.test(String(reply.getHeader('content-type') || ''))) return payload;
    addVary(reply);
    const enc = pickEncoding(req.headers['accept-encoding']);
    if (!enc) return payload;

    const setHeaders = () => {
      reply.header('content-encoding', enc);
      reply.removeHeader('content-length');
      // The compressed body differs byte-for-byte, so a strong validator would be wrong.
      const etag = reply.getHeader('etag');
      if (etag && !String(etag).startsWith('W/')) reply.header('etag', 'W/' + etag);
    };

    if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
      const buf = typeof payload === 'string' ? Buffer.from(payload) : payload;
      if (buf.length < THRESHOLD) return payload;
      const out = enc === 'br' ? await brotli(buf, BROTLI) : await gzip(buf, GZIP);
      setHeaders();
      return out;
    }
    if (typeof payload.pipe === 'function') {
      // Static files and CSV exports. Skip small files whose size is known.
      const len = Number(reply.getHeader('content-length'));
      if (Number.isFinite(len) && len > 0 && len < THRESHOLD) return payload;
      setHeaders();
      const z = enc === 'br' ? zlib.createBrotliCompress(BROTLI) : zlib.createGzip(GZIP);
      payload.on('error', (err) => z.destroy(err));
      return payload.pipe(z);
    }
    return payload;
  });
}
