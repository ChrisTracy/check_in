import crypto from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { HttpError } from './store.js';

/**
 * Load test (admins only): a simulated fleet inside the server that checks in through the real
 * API (Fastify routing, body parsing, auth, the write queue, status boxes, issues, live updates),
 * using app.inject, so the only thing skipped is the TCP socket. Devices start healthy; scenarios
 * such as "high CPU on 10% of devices" can be switched on and off while it runs.
 *
 * Simulated devices are ordinary records whose id is their hostname (`SIM-WS-00001`, `SIM-SRV-SQL-00030`...)
 * and `simulated: true`, so the
 * dashboard, status boxes and issues react to them exactly as to real ones. "Remove simulated
 * devices" deletes them. Nothing about the simulation survives a restart (the records do).
 */

/** Lets the simulator's own requests through auth. Random per process and never sent anywhere. */
export const LOADTEST_TOKEN = crypto.randomBytes(32).toString('hex');
export const SIM_PREFIX = 'SIM-';
const LEGACY_PREFIX = 'sim-'; // simulated devices from before ids matched hostnames
const nextPrefix = (p) => p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1);
const MAX_DEVICES = 20_000;
const MAX_INFLIGHT = 1000;

export const SCENARIOS = {
  high_cpu: { label: 'High CPU', desc: 'cpu_pct 92-99', apply: (f, r) => { f.cpu_pct = 92 + Math.round(r() * 7); f.load_1m = Math.round((f.cpu_cores * (0.95 + r() * 0.5)) * 10) / 10; } },
  high_memory: { label: 'High memory', desc: 'ram_pct 92-98', apply: (f, r) => { f.ram_pct = 92 + Math.round(r() * 6); f.swap_pct = 40 + Math.round(r() * 40); } },
  low_disk: { label: 'Low disk space', desc: 'disk_max_pct 95-99', apply: (f, r) => { f.disk_max_pct = 95 + Math.round(r() * 4); f.disk_pct = f.disk_max_pct; f.disk_free_gb = Math.round(r() * 30) / 10; } },
  disk_busy: { label: 'High disk activity', desc: 'disk_busy_pct 93-100', apply: (f, r) => { f.disk_busy_pct = 93 + Math.round(r() * 7); } },
  clock_skew: { label: 'Clock skew', desc: 'system_time 12 min fast', apply: (f) => { f.system_time = localTime(Date.now() + 12 * 60000); f.time_synced = false; } },
  failed_services: { label: 'Failed services', desc: 'two of its services stop', apply: null, services: true },
  rdp_closed: { label: 'RDP closed', desc: 'port_3389 closed (Windows devices)', apply: null, port: 3389 },
  ssh_closed: { label: 'SSH closed', desc: 'port_22 closed (Linux devices)', apply: null, port: 22 },
  reboot_required: { label: 'Reboot required', desc: 'reboot_required true', apply: (f) => { f.reboot_required = true; } },
  not_domain_joined: { label: 'Not domain joined', desc: 'domain_joined false', apply: (f) => { f.domain_joined = false; f.domain = ''; f.secure_channel_ok = false; } },
  offline: { label: 'Offline', desc: 'stops checking in', apply: null },
};

// Services each kind of device runs (what failed_services / failed_service_names report on).
const WIN_BASE = ['Dnscache', 'EventLog', 'W32Time', 'Spooler', 'wuauserv', 'WinDefend', 'BITS', 'TermService'];
// Remote access, reported like the agents' port checks (port_3389 / port_22 = open | closed).
// Stopping the service behind a port closes it too.
export const PORTS = { 3389: { label: 'RDP', service: 'TermService' }, 22: { label: 'SSH', service: 'sshd' } };
const LINUX_BASE = ['sshd', 'cron', 'rsyslog', 'chronyd', 'systemd-journald'];
const ROLES = {
  win: [
    { role: 'Web server', tag: 'WEB', services: ['W3SVC', 'WAS'] },
    { role: 'SQL server', tag: 'SQL', services: ['MSSQLSERVER', 'SQLSERVERAGENT'] },
    { role: 'Domain controller', tag: 'DC', services: ['NTDS', 'DNS', 'Netlogon', 'Kdc'] },
    { role: 'File server', tag: 'FS', services: ['LanmanServer', 'DFSR'] },
    { role: 'App server', tag: 'APP', services: ['CheckInApp', 'MSMQ'] },
  ],
  linux: [
    { role: 'Web server', tag: 'web', services: ['nginx'] },
    { role: 'Database server', tag: 'db', services: ['postgresql'] },
    { role: 'Container host', tag: 'docker', services: ['docker', 'containerd'] },
  ],
};

function localTime(ms) {
  const d = new Date(ms - 5 * 3600e3);
  return d.toISOString().slice(0, 19) + '-05:00';
}
/** Small seeded random generator, so each device keeps its own character. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);

export class LoadTest {
  constructor({ app, store, log = console }) {
    this.app = app;
    this.store = store;
    this.log = log;
    this.running = false;
    this.devices = 500;
    this.interval = 60;          // seconds between a device's check-ins
    this.scenarios = [];         // { id, key, mode: 'percent'|'count', amount, set: Set<index> }
    this.overrides = new Map();  // index -> { problems: Set<key>, stopped: Set<service>, at } for specific devices
    this.statics = new Map();    // index -> per-device constants
    this.inflight = 0;
    this.resetStats();
    this.history = [];           // one point per second: { t, sent, ok, err, p95, cpu, lag }
    this.loop = monitorEventLoopDelay({ resolution: 20 });
    this.loop.enable();
    this.cpuPrev = process.cpuUsage();
    this.cpuAt = performance.now();
    this.storePrev = store.stats.writes;
    this.sampler = setInterval(() => this.#sample(), 1000);
    this.sampler.unref();
  }

  close() {
    this.stop();
    clearInterval(this.sampler);
    this.loop.disable();
  }

  resetStats() {
    this.stats = { sent: 0, ok: 0, rejected: 0, errors: 0, skipped: 0, lastError: null, startedAt: null };
    this.window = { sent: 0, ok: 0, err: 0, lat: [] };
  }

  // ------------------------------------------------------------ devices
  /** A device's id is its hostname (SIM- keeps it apart from real devices). */
  id(i) { return this.#static(i).hostname; }
  #static(i) {
    let s = this.statics.get(i);
    if (!s) {
      const r = rng(i * 2654435761 + 7);
      const n = String(i + 1).padStart(5, '0');
      // Every 5th device is a server, so there are always some to pick; the rest are workstations, laptops and kiosks.
      const kind = i % 5 === 4 ? 'server' : pick(r, ['workstation', 'workstation', 'workstation', 'laptop', 'laptop', 'kiosk']);
      const win = kind === 'server' ? r() < 0.65 : kind === 'kiosk' ? r() < 0.5 : r() < 0.9;
      const roleDef = kind === 'server' ? pick(r, ROLES[win ? 'win' : 'linux']) : null;
      const prefix = { workstation: 'WS', laptop: 'LT', kiosk: 'KIOSK' }[kind];
      s = {
        r, kind,
        role: roleDef ? roleDef.role : kind[0].toUpperCase() + kind.slice(1),
        hostname: `${SIM_PREFIX}${roleDef ? `${win ? 'SRV' : 'LNX'}-${roleDef.tag.toUpperCase()}` : prefix}-${n}`,
        services: [...(win ? WIN_BASE : LINUX_BASE), ...(roleDef ? roleDef.services : [])],
        roleServices: roleDef ? roleDef.services : [],
        ports: win ? [3389] : [22],
        os: kind === 'server' ? (win ? pick(r, ['Windows Server 2022', 'Windows Server 2019', 'Windows Server 2025']) : pick(r, ['Ubuntu 24.04 LTS', 'Debian 12', 'RHEL 9.4']))
          : win ? pick(r, ['Windows 11 Pro', 'Windows 11 Enterprise', 'Windows 10 Enterprise']) : pick(r, ['Ubuntu 24.04 LTS', 'Fedora 40']),
        site: pick(r, ['Dallas', 'Austin', 'Chicago', 'Denver', 'Seattle']),
        cpu_cores: kind === 'server' ? pick(r, [4, 8, 8, 16, 32]) : pick(r, [2, 4, 4, 8, 8]),
        ram_total_mb: kind === 'server' ? pick(r, [16384, 32768, 65536]) : pick(r, [8192, 16384, 16384, 32768]),
        disk_size_gb: kind === 'server' ? pick(r, [512, 1024, 2048]) : pick(r, [256, 512, 512, 1024]),
        cpuBase: 5 + r() * 30, ramBase: 30 + r() * 30, diskBase: 30 + r() * 45,
        ip: `10.${20 + (i >> 16)}.${(i >> 8) & 255}.${i & 255}`,
        boot: Date.now() - Math.round(r() * 30 * 86400e3),
      };
      this.statics.set(i, s);
    }
    return s;
  }
  /** Healthy readings with a little noise, then any scenarios this device is in. */
  fields(i) {
    const s = this.#static(i);
    const r = s.r;
    const jitter = (base, spread) => Math.max(0, Math.min(100, Math.round(base + (r() - 0.5) * spread)));
    const f = {
      id: this.id(i), simulated: true, hostname: s.hostname, os: s.os, site: s.site, role: s.role,
      cpu_pct: jitter(s.cpuBase, 10), cpu_cores: s.cpu_cores, load_1m: Math.round(s.cpu_cores * s.cpuBase / 100 * 10) / 10,
      ram_pct: jitter(s.ramBase, 6), ram_total_mb: s.ram_total_mb, swap_pct: jitter(5, 6),
      disk_pct: jitter(s.diskBase, 2), disk_max_pct: jitter(s.diskBase + 5, 2), disk_size_gb: s.disk_size_gb,
      disk_free_gb: Math.round(s.disk_size_gb * (1 - (s.diskBase + 5) / 100)), disk_busy_pct: jitter(8, 12),
      system_time: localTime(Date.now()), time_synced: true, timezone: 'Central Standard Time',
      uptime_h: Math.round((Date.now() - s.boot) / 36e5), ip: s.ip,
      domain_joined: true, domain: 'corp.example.com', secure_channel_ok: true,
      failed_services: 0, failed_service_names: '', reboot_required: false, processes: 120 + Math.round(r() * 120),
      services_total: s.services.length,
    };
    for (const p of s.ports) f[`port_${p}`] = 'open';
    const stopped = new Set();
    const closed = new Set();
    const apply = (key) => {
      const sc = SCENARIOS[key];
      if (sc.apply) sc.apply(f, r);
      // Two of its own services: its role's main one (servers) and the print spooler / cron.
      if (sc.services) for (const name of [s.roleServices[0] || s.services[4], s.services[3]]) stopped.add(name);
      if (sc.port && s.ports.includes(sc.port)) closed.add(sc.port);
    };
    for (const sc of this.scenarios) if (sc.set.has(i)) apply(sc.key);
    const o = this.overrides.get(i);
    if (o) {
      for (const key of o.problems) apply(key);
      for (const name of o.stopped) stopped.add(name);
      for (const p of o.closed) closed.add(p);
    }
    for (const p of s.ports) if (closed.has(p) || stopped.has(PORTS[p].service)) f[`port_${p}`] = 'closed';
    if (stopped.size) {
      f.failed_services = stopped.size;
      f.failed_service_names = s.services.filter((x) => stopped.has(x)).join(', ');
    }
    return f;
  }
  #offline(i) { return this.overrides.get(i)?.problems.has('offline') || this.scenarios.some((sc) => sc.key === 'offline' && sc.set.has(i)); }

  // ------------------------------------------------------------ specific devices
  index(id) {
    const m = /-(\d{5})$/.exec(String(id));
    const i = m ? Number(m[1]) - 1 : -1;
    if (i < 0 || i >= this.devices || this.id(i) !== String(id)) throw new HttpError(404, 'No such simulated device');
    return i;
  }
  describe(i) {
    const s = this.#static(i);
    const o = this.overrides.get(i);
    return {
      id: s.hostname, hostname: s.hostname, kind: s.kind, role: s.role, os: s.os, site: s.site, services: s.services,
      problems: o ? [...o.problems] : [], stopped: o ? s.services.filter((x) => o.stopped.has(x)) : [],
      ports: s.ports.map((p) => ({ port: p, label: PORTS[p].label, service: PORTS[p].service })),
      closed: o ? s.ports.filter((p) => o.closed.has(p)) : [],
      scenarios: this.scenarios.filter((sc) => sc.set.has(i)).map((sc) => SCENARIOS[sc.key].label),
      offline: this.#offline(i),
    };
  }
  /** Search the fleet by name, role, OS, site or service; filter = 'custom' for the changed ones. */
  search({ q = '', filter = '', limit = 50 } = {}) {
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    const max = Math.min(200, Math.max(1, Number(limit) || 50));
    const out = [];
    let total = 0;
    const custom = String(filter) === 'custom';
    for (let i = 0; i < this.devices; i++) {
      const s = this.#static(i);
      if (custom && !this.overrides.has(i)) continue;
      if (words.length) {
        const hay = `${s.hostname} ${s.role} ${s.os} ${s.site} ${s.services.join(' ')} ${s.ports.map((p) => PORTS[p].label).join(' ')}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
      }
      total++;
      if (out.length < max) out.push(this.describe(i));
    }
    return { devices: out, total };
  }
  /** Set exactly which problems a device has and which of its services are stopped (empty = healthy). */
  setDevice(id, { problems = [], stopped = [], closed = [] } = {}) {
    const i = this.index(id);
    const s = this.#static(i);
    if (!Array.isArray(problems) || !Array.isArray(stopped) || !Array.isArray(closed)) throw new HttpError(400, 'problems, stopped and closed must be lists');
    for (const k of problems) if (!SCENARIOS[k] || SCENARIOS[k].services || SCENARIOS[k].port) throw new HttpError(400, `Unknown problem: ${String(k).slice(0, 40)}`);
    const ports = closed.map(Number);
    for (const p of ports) if (!s.ports.includes(p)) throw new HttpError(400, `${s.hostname} has no ${PORTS[p]?.label || 'port ' + String(p).slice(0, 10)} port to close`);
    for (const n of stopped) if (!s.services.includes(n)) throw new HttpError(400, `${s.hostname} doesn't run ${String(n).slice(0, 60)}`);
    if (!problems.length && !stopped.length && !ports.length) this.overrides.delete(i);
    else {
      if (!this.overrides.has(i) && this.overrides.size >= 5000) throw new HttpError(400, 'At most 5,000 customized devices');
      this.overrides.set(i, { problems: new Set(problems), stopped: new Set(stopped), closed: new Set(ports), at: new Date().toISOString() });
    }
    // Show it straight away rather than at the device's next turn.
    if (this.running && !this.#offline(i)) this.#send(i, true);
    return this.describe(i);
  }
  healAllDevices() { this.overrides.clear(); return this.state(); }

  // ------------------------------------------------------------ control
  configure({ devices, interval } = {}) {
    if (devices !== undefined) {
      const n = Math.round(Number(devices));
      if (!Number.isFinite(n) || n < 1 || n > MAX_DEVICES) throw new HttpError(400, `Devices must be between 1 and ${MAX_DEVICES.toLocaleString()}`);
      if (n < this.devices) {
        for (const k of [...this.statics.keys()]) if (k >= n) this.statics.delete(k);
        for (const k of [...this.overrides.keys()]) if (k >= n) this.overrides.delete(k);
      }
      this.devices = n;
      for (const sc of this.scenarios) this.#choose(sc);
    }
    if (interval !== undefined) {
      const s = Number(interval);
      if (!Number.isFinite(s) || s < 1 || s > 3600) throw new HttpError(400, 'Interval must be between 1 and 3600 seconds');
      this.interval = s;
    }
    if (this.running) this.#rebase();
    return this.state();
  }

  start(opts = {}) {
    if (opts.devices !== undefined || opts.interval !== undefined) this.configure(opts);
    if (this.running) return this.state();
    this.running = true;
    this.resetStats();
    this.stats.startedAt = new Date().toISOString();
    this.#rebase();
    // Everything starts healthy: the first round checks every device in straight away (spread over a few seconds).
    this.first = true;
    this.timer = setInterval(() => this.#tick(), 50);
    this.timer.unref?.();
    this.log.info?.({ devices: this.devices, interval: this.interval }, 'load test started');
    return this.state();
  }

  stop() {
    if (!this.running) return this.state();
    this.running = false;
    clearInterval(this.timer);
    this.log.info?.('load test stopped');
    return this.state();
  }

  /** Every device checks in once, right now (as fast as the server takes them). */
  burst() {
    for (let i = 0; i < this.devices; i++) if (!this.#offline(i)) this.#send(i, true);
    return this.state();
  }

  #rebase() {
    this.t0 = performance.now();
    this.cursor = 0; // check-ins scheduled so far this run
  }

  #tick() {
    // Spread check-ins evenly: by now, (elapsed / interval) * devices of them are due.
    const span = this.first ? Math.min(this.interval, 5) : this.interval;
    const due = Math.floor(((performance.now() - this.t0) / 1000 / span) * this.devices);
    let n = due - this.cursor;
    if (n <= 0) return;
    if (n > this.devices) { this.stats.skipped += n - this.devices; this.cursor = due - this.devices; n = this.devices; }
    while (n-- > 0) {
      const i = this.cursor % this.devices;
      this.cursor++;
      if (!this.#offline(i)) {
        if (this.inflight >= MAX_INFLIGHT) this.stats.skipped++; // the server is behind: don't pile up
        else this.#send(i);
      }
      if (this.first && this.cursor >= this.devices) { this.first = false; this.#rebase(); break; }
    }
  }

  async #send(i, force = false) {
    if (!force && this.inflight >= MAX_INFLIGHT) { this.stats.skipped++; return; }
    this.inflight++;
    this.stats.sent++;
    this.window.sent++;
    const t = performance.now();
    try {
      const r = await this.app.inject({
        method: 'POST', url: '/api/checkin', remoteAddress: '127.0.0.1',
        headers: { 'content-type': 'application/json', 'x-loadtest-token': LOADTEST_TOKEN },
        payload: JSON.stringify(this.fields(i)),
      });
      const ms = performance.now() - t;
      this.window.lat.push(ms);
      if (r.statusCode < 300) { this.stats.ok++; this.window.ok++; }
      else if (r.statusCode === 503) { this.stats.rejected++; this.window.err++; this.stats.lastError = 'Check-ins are paused (503)'; }
      else { this.stats.errors++; this.window.err++; this.stats.lastError = `HTTP ${r.statusCode}: ${String(r.body).slice(0, 160)}`; }
    } catch (e) {
      this.stats.errors++; this.window.err++; this.stats.lastError = e.message;
    } finally {
      this.inflight--;
    }
  }

  // ------------------------------------------------------------ scenarios
  #choose(sc) {
    // Port problems only pick devices that have that port (RDP: Windows, SSH: Linux).
    const port = SCENARIOS[sc.key].port;
    // Stable picks: the same devices each time for this scenario (shuffled by its seed), so
    // changing the amount adds or removes devices at the edge instead of reshuffling.
    if (!sc.order || sc.fleet !== this.devices) {
      const r = rng(sc.seed);
      sc.fleet = this.devices;
      sc.order = Array.from({ length: this.devices }, (_, k) => k).filter((k) => !port || this.#static(k).ports.includes(port));
      for (let k = sc.order.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [sc.order[k], sc.order[j]] = [sc.order[j], sc.order[k]]; }
    }
    const pool = sc.order.length;
    const want = sc.mode === 'count' ? Math.min(pool, sc.amount) : Math.round(pool * sc.amount / 100);
    sc.set = new Set(sc.order.slice(0, want));
  }

  addScenario({ key, mode = 'percent', amount = 10 } = {}) {
    if (!SCENARIOS[key]) throw new HttpError(400, 'Unknown scenario');
    const m = mode === 'count' ? 'count' : 'percent';
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0 || (m === 'percent' && a > 100) || (m === 'count' && a > MAX_DEVICES)) throw new HttpError(400, m === 'percent' ? 'Percent must be between 0 and 100' : 'Count must be at least 1');
    if (this.scenarios.length >= 20) throw new HttpError(400, 'At most 20 scenarios at once');
    const sc = { id: crypto.randomBytes(4).toString('hex'), key, mode: m, amount: m === 'count' ? Math.round(a) : a, seed: crypto.randomInt(1, 2 ** 31), startedAt: new Date().toISOString() };
    this.#choose(sc);
    this.scenarios.push(sc);
    return this.state();
  }

  updateScenario(id, { mode, amount }) {
    const sc = this.scenarios.find((s) => s.id === id);
    if (!sc) throw new HttpError(404, 'Scenario not found');
    const m = mode === undefined ? sc.mode : mode === 'count' ? 'count' : 'percent';
    const a = amount === undefined ? sc.amount : Number(amount);
    if (!Number.isFinite(a) || a <= 0 || (m === 'percent' && a > 100)) throw new HttpError(400, 'Amount out of range');
    sc.mode = m; sc.amount = m === 'count' ? Math.round(a) : a;
    this.#choose(sc);
    return this.state();
  }

  removeScenario(id) {
    const n = this.scenarios.length;
    this.scenarios = id === 'all' ? [] : this.scenarios.filter((s) => s.id !== id);
    if (this.scenarios.length === n && id !== 'all') throw new HttpError(404, 'Scenario not found');
    return this.state();
  }

  /** Records the simulator made: SIM-* (and older sim-*) ids that also say simulated = true. */
  #simWhere() {
    return { sql: "((id >= ? AND id < ?) OR (id >= ? AND id < ?)) AND json_extract(data, '$.simulated') = 1",
      args: [SIM_PREFIX, nextPrefix(SIM_PREFIX), LEGACY_PREFIX, nextPrefix(LEGACY_PREFIX)] };
  }
  /** Delete every simulated record (the simulation must be stopped). */
  removeDevices() {
    if (this.running) throw new HttpError(409, 'Stop the load test first');
    const w = this.#simWhere();
    const ids = this.db().prepare(`SELECT id FROM records WHERE ${w.sql}`).all(...w.args).map((r) => r.id);
    return { deleted: ids.length ? this.store.deleteMany(ids).length : 0 };
  }

  // ------------------------------------------------------------ measuring
  #sample() {
    const now = performance.now();
    const cpu = process.cpuUsage(this.cpuPrev);
    const cpuPct = ((cpu.user + cpu.system) / 1000) / (now - this.cpuAt) * 100;
    this.cpuPrev = process.cpuUsage();
    this.cpuAt = now;
    const lat = this.window.lat.sort((a, b) => a - b);
    const writes = this.store.stats.writes;
    const point = {
      t: Date.now(), sent: this.window.sent, ok: this.window.ok, err: this.window.err,
      p50: Math.round(percentile(lat, 0.5) * 10) / 10, p95: Math.round(percentile(lat, 0.95) * 10) / 10, max: Math.round((lat.at(-1) || 0) * 10) / 10,
      cpu: Math.round(cpuPct), lag: Math.round(this.loop.percentile(99) / 1e5) / 10, writes: writes - this.storePrev,
    };
    this.storePrev = writes;
    this.loop.reset();
    this.window = { sent: 0, ok: 0, err: 0, lat: [] };
    this.history.push(point);
    if (this.history.length > 300) this.history.shift();
  }

  db() { return this.store.db; }
  simCount() {
    const w = this.#simWhere();
    return this.db().prepare(`SELECT COUNT(*) AS n FROM records WHERE ${w.sql}`).get(...w.args).n;
  }

  state() {
    const recent = this.history.slice(-10);
    const sum = (k) => recent.reduce((a, p) => a + p[k], 0);
    const mem = process.memoryUsage();
    return {
      running: this.running,
      devices: this.devices,
      interval: this.interval,
      target: Math.round(this.devices / this.interval * 10) / 10,   // check-ins per second when running
      inflight: this.inflight,
      stats: { ...this.stats },
      rate: recent.length ? Math.round(sum('ok') / recent.length) : 0,
      scenarios: this.scenarios.map((s) => ({ id: s.id, key: s.key, label: SCENARIOS[s.key].label, desc: SCENARIOS[s.key].desc, mode: s.mode, amount: s.amount, affected: s.set.size, startedAt: s.startedAt })),
      catalog: Object.entries(SCENARIOS).map(([key, s]) => ({ key, label: s.label, desc: s.desc, perDevice: !s.services && !s.port })),
      custom: [...this.overrides.keys()].sort((a, b) => a - b).slice(0, 500).map((i) => this.describe(i)),
      customCount: this.overrides.size,
      history: this.history.slice(-120),
      server: { rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576), uptimeS: Math.round(process.uptime()), node: process.version },
    };
  }
}

export function registerLoadTest(app, { loadTest, store, issues }) {
  const cap = { config: { cap: 'loadTest' } };
  const full = () => ({ ...loadTest.state(), simDevices: loadTest.simCount(), records: store.summary().records, queue: store.queue.length, issues: issues?.enabled ? issues.summary() : null });
  app.get('/api/admin/loadtest', cap, async () => full());
  app.post('/api/admin/loadtest/start', cap, async (req) => { loadTest.start(req.body || {}); return full(); });
  app.post('/api/admin/loadtest/stop', cap, async () => { loadTest.stop(); return full(); });
  app.post('/api/admin/loadtest/burst', cap, async () => { loadTest.burst(); return full(); });
  app.put('/api/admin/loadtest', cap, async (req) => { loadTest.configure(req.body || {}); return full(); });
  app.post('/api/admin/loadtest/scenarios', cap, async (req) => { loadTest.addScenario(req.body || {}); return full(); });
  app.put('/api/admin/loadtest/scenarios/:id', cap, async (req) => { loadTest.updateScenario(req.params.id, req.body || {}); return full(); });
  app.delete('/api/admin/loadtest/scenarios/:id', cap, async (req) => { loadTest.removeScenario(req.params.id); return full(); });
  app.get('/api/admin/loadtest/sims', cap, async (req) => loadTest.search(req.query));
  app.put('/api/admin/loadtest/sims/:id', cap, async (req) => ({ device: loadTest.setDevice(req.params.id, req.body || {}), ...full() }));
  app.delete('/api/admin/loadtest/sims', cap, async () => { loadTest.healAllDevices(); return full(); });
  app.delete('/api/admin/loadtest/devices', cap, async (req) => {
    if (String(req.query.confirm) !== 'true') throw new HttpError(400, 'Add ?confirm=true to delete every simulated device');
    return { ...loadTest.removeDevices(), ...full() };
  });
}
