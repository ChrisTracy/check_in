import net from 'node:net';
import { HttpError } from './store.js';

/**
 * Port checks: the server tries to open a TCP connection back to the caller's own address and
 * reports whether each port answered. Off until an admin turns it on (Admin → Port checks).
 *
 *   - Only the address the request came from is ever checked; there is no way to name another
 *     host, so this can't be used to scan other machines.
 *   - Two ways to use it:
 *       POST/GET /api/portcheck?ports=443,8080      returns { ip, ports: { "443": "open", ... } }
 *       a check-in with check_ports=3389            also saves port_3389 = "open" | "closed"
 *                                                    on the record (and returns the details)
 *   - Results: open (connected), closed (refused), filtered (no answer before the timeout),
 *     error (e.g. network unreachable). Saved fields use just open / closed (anything but open).
 *   - Limits: a few ports per request, a per-address rate limit, and a cap on checks in flight.
 */
// perIpPerMinute: ports checked per caller address per minute (raise it when many devices share
// one address, e.g. a load test or a site behind NAT).
export const PORTCHECK_DEFAULTS = { enabled: false, timeoutMs: 2000, maxPorts: 5, perIpPerMinute: 300 };
const MAX_IN_FLIGHT = 5000;             // probes waiting for an answer, server-wide

/** "22, 3389" → [22, 3389]. Throws a 400 for anything that isn't a list of ports. */
export function parsePorts(value, maxPorts) {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
  const parts = raw.split(/[\s,;]+/).filter(Boolean);
  if (!parts.length) throw new HttpError(400, 'ports is required, e.g. ports=443 or ports=22,3389');
  const ports = [];
  for (const p of parts) {
    if (!/^\d{1,5}$/.test(p) || Number(p) < 1 || Number(p) > 65535) throw new HttpError(400, `Not a port number: ${p.slice(0, 20)}`);
    if (!ports.includes(Number(p))) ports.push(Number(p));
  }
  if (ports.length > maxPorts) throw new HttpError(400, `At most ${maxPorts} ports per request`);
  return ports;
}

/** The caller's address as something net.connect accepts (strips the IPv4-in-IPv6 prefix). */
export function callerAddress(req) {
  let ip = String(req.ip || '');
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  return net.isIP(ip) ? ip : null;
}

export class PortChecker {
  constructor(accounts) {
    this.accounts = accounts;
    this.inFlight = 0;
    this.buckets = new Map(); // ip -> { count, reset }
    this.stats = { checks: 0, open: 0, closed: 0, filtered: 0, error: 0 };
  }

  get settings() {
    const s = this.accounts.getSetting('portCheck', null) || {};
    return { ...PORTCHECK_DEFAULTS, ...s };
  }
  get enabled() { return this.settings.enabled === true; }

  update(patch) {
    const cur = this.settings;
    const next = { ...cur };
    if ('enabled' in patch) next.enabled = patch.enabled === true;
    if ('timeoutMs' in patch) {
      const t = Math.round(Number(patch.timeoutMs));
      if (!Number.isFinite(t) || t < 200 || t > 10000) throw new HttpError(400, 'Timeout must be between 200 and 10,000 ms');
      next.timeoutMs = t;
    }
    if ('maxPorts' in patch) {
      const m = Math.round(Number(patch.maxPorts));
      if (!Number.isFinite(m) || m < 1 || m > 20) throw new HttpError(400, 'Ports per request must be between 1 and 20');
      next.maxPorts = m;
    }
    if ('perIpPerMinute' in patch) {
      const n = Math.round(Number(patch.perIpPerMinute));
      if (!Number.isFinite(n) || n < 10 || n > 1_000_000) throw new HttpError(400, 'Checks per address per minute must be between 10 and 1,000,000');
      next.perIpPerMinute = n;
    }
    this.accounts.setSetting('portCheck', next);
    return next;
  }

  /** One TCP connection attempt. Resolves 'open' | 'closed' | 'filtered' | 'error'. */
  probe(host, port, timeoutMs) {
    return new Promise((resolve) => {
      const sock = net.connect({ host, port });
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.removeAllListeners();
        sock.on('error', () => {});
        // Reset instead of a normal close, so nothing lingers in TIME_WAIT on the server.
        if (typeof sock.resetAndDestroy === 'function' && sock.readyState === 'open') sock.resetAndDestroy(); else sock.destroy();
        resolve(result);
      };
      const timer = setTimeout(() => done('filtered'), timeoutMs);
      sock.once('connect', () => done('open'));
      sock.once('error', (e) => done(e.code === 'ECONNREFUSED' ? 'closed' : e.code === 'ETIMEDOUT' ? 'filtered' : 'error'));
    });
  }

  /** Check these ports on the caller's address. Throws 403 when off, 429/503 when limited. */
  async check(req, ports) {
    const s = this.settings;
    if (!s.enabled) throw new HttpError(403, 'Port checks are turned off. An admin can turn them on in Admin → Port checks.');
    const ip = callerAddress(req);
    if (!ip) throw new HttpError(400, 'Could not tell which address the request came from');
    const now = Date.now();
    let b = this.buckets.get(ip);
    if (!b || b.reset <= now) { b = { count: 0, reset: now + 60_000 }; this.buckets.set(ip, b); }
    if (b.count + ports.length > s.perIpPerMinute) {
      throw Object.assign(new HttpError(429, `Too many port checks from ${ip}; try again in a minute`), { retryAfter: Math.ceil((b.reset - now) / 1000) });
    }
    if (this.inFlight + ports.length > MAX_IN_FLIGHT) throw new HttpError(503, 'The server is busy with other port checks; try again shortly');
    b.count += ports.length;
    if (this.buckets.size > 50_000) for (const [k, v] of this.buckets) if (v.reset <= now) this.buckets.delete(k);

    this.inFlight += ports.length;
    try {
      const results = await Promise.all(ports.map((p) => this.probe(ip, p, s.timeoutMs)));
      const out = {};
      ports.forEach((p, i) => { out[p] = results[i]; this.stats.checks++; this.stats[results[i]]++; });
      return { ip, ports: out };
    } finally {
      this.inFlight -= ports.length;
    }
  }
}

export function registerPortCheck(app, { portChecker }) {
  const handler = async (req, reply) => {
    const ports = parsePorts(req.query.ports ?? req.body?.ports, portChecker.settings.maxPorts);
    try {
      const t0 = Date.now();
      const r = await portChecker.check(req, ports);
      return { ok: true, ...r, ms: Date.now() - t0 };
    } catch (e) {
      if (e.retryAfter) reply.header('retry-after', e.retryAfter);
      throw e;
    }
  };
  app.get('/api/portcheck', { config: { cap: 'checkin' } }, handler);
  app.post('/api/portcheck', { config: { cap: 'checkin' } }, handler);

  const admin = { config: { cap: 'portCheckPolicy' } };
  app.get('/api/admin/portcheck', admin, async (req) => ({ ...portChecker.settings, yourAddress: callerAddress(req), stats: portChecker.stats }));
  app.put('/api/admin/portcheck', admin, async (req) => ({ ...portChecker.update(req.body || {}), yourAddress: callerAddress(req), stats: portChecker.stats }));
}
