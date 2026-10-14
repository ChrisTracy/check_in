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
 * devices" deletes them. Nothing about the simulation survives a restart (the records do; the
 * fleet size is picked up again from how many there are).
 *
 * The simulator never has more than MAX_INFLIGHT requests outstanding: regular turns are skipped
 * when it is full, and urgent sends (Burst, a device that was just changed) wait in a queue that is
 * drained a chunk at a time as slots free up, yielding to the event loop between chunks.
 *
 * It never writes over a record it didn't make: before its first check-in for an id, a record with
 * that id that isn't `simulated: true` (a real device that happens to have a SIM- name) makes the
 * simulator skip that device for good (counted as "name taken by a real device").
 */

/** Lets the simulator's own requests through auth. Random per process and never sent anywhere. */
export const LOADTEST_TOKEN = crypto.randomBytes(32).toString('hex');
export const SIM_PREFIX = 'SIM-';
const LEGACY_PREFIX = 'sim-'; // simulated devices from before ids matched hostnames
const nextPrefix = (p) => p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1);
const MAX_DEVICES = 20_000;
const MAX_INFLIGHT = 1000;
const CHUNK = 100;          // urgent sends started per turn of the event loop

/** A number from JSON: a finite number, or a plain decimal string. Anything else (true, [5], "0x10") is NaN. */
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return NaN;
}
const has = (obj, k) => typeof k === 'string' && Object.hasOwn(obj, k);
/** Per-scenario rank of a device: a 32-bit mix of (seed, index), stable however big the fleet is. */
function rank(seed, i) {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

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
/** "12d 4h 7m", the same text the agents send in `uptime`. */
function humanDuration(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return d ? `${d}d ${h}h ${mm}m` : h ? `${h}h ${mm}m` : `${mm}m`;
}
/** Small seeded random generator, so each device keeps its own character. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);

// What an agent with the topprocs group on sends: one text line per metric that is over 85%, and null
// (which clears the field) for the others. The names are made up and change every minute.
const TOP_WIN = ['sqlservr', 'chrome', 'MsMpEng', 'w3wp', 'svchost', 'python', 'node', 'TiWorker', 'backupsvc'];
const TOP_LINUX = ['postgres', 'java', 'nginx', 'python3', 'node', 'rsync', 'dockerd', 'kswapd0'];
export const TOP_THRESHOLD = 85;
function topProcessFields(f, s, i) {
  const r = rng((i + 1) * 7919 + Math.floor(Date.now() / 60000));
  const names = (s.os.startsWith('Windows') ? TOP_WIN : TOP_LINUX).slice();
  const three = [];
  for (let k = 0; k < 3; k++) three.push(names.splice(Math.floor(r() * names.length), 1)[0]);
  const shares = [0.4 + r() * 0.2, 0.15 + r() * 0.1, 0.05 + r() * 0.05];
  const out = { top_cpu: null, top_ram: null, top_disk: null };
  if (f.cpu_pct > TOP_THRESHOLD) out.top_cpu = three.map((n, k) => `${n} ${Math.max(1, Math.round(f.cpu_pct * shares[k]))}%`).join(', ');
  if (f.ram_pct > TOP_THRESHOLD) {
    out.top_ram = three.map((n, k) => {
      const mb = f.ram_total_mb * f.ram_pct / 100 * shares[k];
      return `${n} ${mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB'} (${Math.round(mb * 100 / f.ram_total_mb)}%)`;
    }).join(', ');
  }
  if (f.disk_busy_pct > TOP_THRESHOLD) out.top_disk = three.map((n, k) => `${n} ${(f.disk_busy_pct * [1.4, 0.5, 0.1][k] * (0.8 + r() * 0.4)).toFixed(1)} MB/s`).join(', ');
  return out;
}

export class LoadTest {
  constructor({ app, store, log = console }) {
    this.app = app;
    this.store = store;
    this.log = log;
    this.running = false;
    this.devices = 500;
    this.interval = 60;          // seconds between a device's check-ins
    this.topProcs = false;       // send top_cpu / top_ram / top_disk like an agent with the topprocs group on
    this.scenarios = [];         // { id, key, mode: 'percent'|'count', amount, set: Set<index> }
    this.overrides = new Map();  // index -> { problems: Set<key>, stopped: Set<service>, at } for specific devices
    this.statics = new Map();    // index -> per-device constants
    this.inflight = 0;
    this.urgent = new Set();     // indices waiting to be sent as soon as there is room (Burst, changed devices)
    this.bursting = false;       // a burst is still being sent
    this.lastBurst = 0;          // devices queued by the last burst
    this.claims = new Map();     // index -> 'ours' | 'taken' (a real record already has that id)
    this.drains = [];            // resolvers waiting for inflight to reach 0
    this.resetStats();
    // After a restart, pick up the fleet that is still in the database.
    try {
      // The highest device number, not the count: a run that skipped some devices (or a name taken
      // by a real device) still has records numbered up to the old fleet size.
      const n = this.db().prepare(`SELECT MAX(CAST(substr(id, -5) AS INTEGER)) AS n FROM records WHERE id >= ? AND id < ? AND json_type(data, '$.simulated') = 'true'`)
        .get(SIM_PREFIX, nextPrefix(SIM_PREFIX)).n || 0;
      if (n > this.devices) this.devices = Math.min(MAX_DEVICES, n);
    } catch { /* no records table yet */ }
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
      boot_time: localTime(s.boot), uptime: humanDuration(Date.now() - s.boot),
      uptime_h: Math.round((Date.now() - s.boot) / 36e5 * 10) / 10, ip: s.ip,
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
      // Two of its own services: its role's main one (servers; otherwise wuauserv on Windows,
      // systemd-journald on Linux) and Spooler (Windows) or chronyd (Linux).
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
    if (this.topProcs) Object.assign(f, topProcessFields(f, s, i));
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
      taken: this.claims.get(i) === 'taken',
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
    for (const k of problems) if (!has(SCENARIOS, k) || SCENARIOS[k].services || SCENARIOS[k].port) throw new HttpError(400, `Unknown problem: ${String(k).slice(0, 40)}`);
    const ports = closed.map(num);
    for (const p of ports) if (!s.ports.includes(p)) throw new HttpError(400, `${s.hostname} has no ${Object.hasOwn(PORTS, String(p)) ? PORTS[p].label : 'port ' + String(p).slice(0, 10)} port to close`);
    for (const n of stopped) if (typeof n !== 'string' || !s.services.includes(n)) throw new HttpError(400, `${s.hostname} doesn't run ${String(n).slice(0, 60)}`);
    if (!problems.length && !stopped.length && !ports.length) this.overrides.delete(i);
    else {
      if (!this.overrides.has(i) && this.overrides.size >= 5000) throw new HttpError(400, 'At most 5,000 customized devices');
      this.overrides.set(i, { problems: new Set(problems), stopped: new Set(stopped), closed: new Set(ports), at: new Date().toISOString() });
    }
    // Show it straight away rather than at the device's next turn (still within the in-flight cap).
    if (this.running) this.#queue([i]);
    return this.describe(i);
  }
  healAllDevices() {
    const changed = [...this.overrides.keys()];
    this.overrides.clear();
    // Like one device's Make healthy: they report it straight away (offline ones come back too).
    if (this.running) this.#queue(changed);
    return this.state();
  }

  // ------------------------------------------------------------ control
  configure({ devices, interval, topProcs } = {}) {
    // Validate everything before changing anything.
    let n = this.devices;
    let iv = this.interval;
    if (devices !== undefined) {
      n = num(devices);
      if (!Number.isInteger(n) || n < 1 || n > MAX_DEVICES) throw new HttpError(400, `Devices must be a whole number between 1 and ${MAX_DEVICES.toLocaleString()}`);
    }
    if (interval !== undefined) {
      iv = num(interval);
      if (!Number.isFinite(iv) || iv < 1 || iv > 3600) throw new HttpError(400, 'Interval must be a number between 1 and 3600 seconds');
    }
    let tp = this.topProcs;
    if (topProcs !== undefined) {
      if (typeof topProcs !== 'boolean') throw new HttpError(400, 'topProcs must be true or false');
      tp = topProcs;
    }
    if (n === this.devices && iv === this.interval && tp === this.topProcs) return this.state(); // nothing changed: keep the cycle going as it is
    this.topProcs = tp;
    const old = this.devices;
    // Where the cycle is: the next device due. Kept, so Apply doesn't start over from device #1.
    const pos = this.running ? this.cursor % old : 0;
    if (n < old) this.#drop(n, old);
    this.devices = n;
    this.interval = iv;
    if (n !== old) for (const sc of this.scenarios) this.#choose(sc);
    if (this.running) this.#rebase(pos < n ? pos : 0);
    return this.state();
  }

  /** The fleet shrank: forget devices n..old-1 and delete the records the simulator made for them. */
  #drop(n, old) {
    const ids = [];
    for (let k = n; k < old; k++) ids.push(this.id(k));
    for (const k of [...this.statics.keys()]) if (k >= n) this.statics.delete(k);
    for (const k of [...this.overrides.keys()]) if (k >= n) this.overrides.delete(k);
    for (const k of [...this.claims.keys()]) if (k >= n) this.claims.delete(k);
    for (const k of [...this.urgent]) if (k >= n) this.urgent.delete(k);
    this.store.flush(); // anything of theirs already queued is committed first, so it goes too
    this.#deleteSims(ids);
    // (Check-ins of theirs still in flight are deleted when they land: see #send.)
  }
  /** Delete those of these ids whose records are simulated (never a real device's). */
  #deleteSims(ids) {
    const mine = ids.filter((id) => this.#owner(id) === 'sim');
    return mine.length ? this.store.deleteMany(mine).length : 0;
  }
  /** Who has a record with this id: 'none', 'sim' (simulated: true) or 'real'. */
  #owner(id) {
    this.ownerStmt ??= this.db().prepare("SELECT json_type(data, '$.simulated') AS t FROM records WHERE id = ?");
    const row = this.ownerStmt.get(id);
    return !row ? 'none' : row.t === 'true' ? 'sim' : 'real';
  }
  /** May the simulator write device i? Checked once, before its first check-in. */
  #mine(i) {
    let c = this.claims.get(i);
    if (!c) {
      c = this.#owner(this.id(i)) === 'real' ? 'taken' : 'ours';
      this.claims.set(i, c);
      if (c === 'taken') this.log.warn?.({ id: this.id(i) }, 'load test: a real device has this name; skipping it');
    }
    return c === 'ours';
  }
  takenIds() {
    const out = [];
    for (const [i, c] of this.claims) if (c === 'taken' && i < this.devices) out.push(this.id(i));
    return out.sort();
  }

  start(opts = {}) {
    if (this.removing) throw new HttpError(409, 'Simulated devices are being removed');
    if (opts.devices !== undefined || opts.interval !== undefined || opts.topProcs !== undefined) this.configure(opts);
    if (this.running) return this.state();
    this.running = true;
    this.resetStats();
    this.claims.clear(); // look again: a real device may have gone (or arrived) since
    this.stats.startedAt = new Date().toISOString();
    this.#rebase();
    // Everything starts healthy: the first round checks every device in straight away (spread over a few seconds).
    this.first = true;
    this.timer = setInterval(() => this.#tick(), 50);
    this.timer.unref?.();
    this.log.info?.({ devices: this.devices, interval: this.interval }, 'load test started');
    return this.state();
  }

  /** Stops sending. Check-ins already in flight still land: await drain() before relying on that. */
  stop() {
    this.urgent.clear();
    this.bursting = false;
    if (!this.running) return this.state();
    this.running = false;
    clearInterval(this.timer);
    this.log.info?.('load test stopped');
    return this.state();
  }

  /** Resolves once nothing is in flight and the store's queue is committed. */
  async drain(ms = 30000) {
    if (this.inflight > 0) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        this.drains.push(() => { clearTimeout(t); resolve(); });
      });
    }
    this.store.flush();
  }

  /** Every device checks in once, as fast as the server takes them (never more than MAX_INFLIGHT at a time). */
  burst() {
    if (this.removing) throw new HttpError(409, 'Simulated devices are being removed');
    if (this.bursting) throw new HttpError(409, 'A burst is already being sent');
    const list = [];
    for (let i = 0; i < this.devices; i++) if (!this.#offline(i) && this.#mine(i)) list.push(i);
    this.lastBurst = list.length;
    if (list.length) { this.bursting = true; this.#queue(list); }
    return this.state();
  }

  /** Send these devices as soon as there is room. */
  #queue(list) {
    if (this.removing) return;
    for (const i of list) this.urgent.add(i);
    this.#schedulePump();
  }
  #schedulePump() {
    if (this.pumpScheduled || !this.urgent.size) return;
    this.pumpScheduled = true;
    setImmediate(() => { this.pumpScheduled = false; this.#pump(); });
  }
  #pump() {
    let started = 0;
    for (const i of this.urgent) {
      if (this.inflight >= MAX_INFLIGHT || started >= CHUNK) break;
      this.urgent.delete(i);
      if (i >= this.devices || this.#offline(i)) continue;
      this.#send(i);
      started++;
    }
    if (!this.urgent.size) this.bursting = false;
    // More to do and room for it: carry on after other work has had a turn.
    else if (this.inflight < MAX_INFLIGHT) this.#schedulePump();
  }

  /** Restart the clock so that device `pos` is the next one due. */
  #rebase(pos = 0) {
    const span = this.first ? Math.min(this.interval, 5) : this.interval;
    this.t0 = performance.now() - (pos / this.devices) * span * 1000;
    this.cursor = pos; // check-ins scheduled since t0
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

  async #send(i) {
    if (this.inflight >= MAX_INFLIGHT) { this.stats.skipped++; return; }
    if (!this.#mine(i)) return;
    const id = this.id(i);
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
      // The fleet shrank while this was in flight: don't leave it behind.
      if (i >= this.devices) { try { this.store.flush(); this.#deleteSims([id]); } catch { /* ignore */ } }
      if (this.inflight === 0 && this.drains.length) for (const done of this.drains.splice(0)) done();
      if (this.urgent.size) this.#schedulePump();
    }
  }

  // ------------------------------------------------------------ scenarios
  #choose(sc) {
    // Port problems only pick devices that have that port (RDP: Windows, SSH: Linux).
    const port = SCENARIOS[sc.key].port;
    // Stable picks: devices are ranked by a hash of (scenario seed, index), which doesn't depend on
    // the fleet size. The devices already picked stay picked (if still in the fleet); changing the
    // amount or the fleet size only adds the next-ranked devices or drops the last-ranked ones.
    const pool = [];
    for (let k = 0; k < this.devices; k++) if (!port || this.#static(k).ports.includes(port)) pool.push(k);
    const want = sc.mode === 'count' ? Math.min(pool.length, sc.amount) : Math.round(pool.length * sc.amount / 100);
    const r = new Map(pool.map((k) => [k, rank(sc.seed, k)]));
    const order = pool.sort((a, b) => r.get(a) - r.get(b) || a - b);
    const set = new Set();
    if (sc.set) for (const k of sc.set) if (r.has(k)) set.add(k);
    for (let j = 0; j < order.length && set.size < want; j++) set.add(order[j]);
    for (let j = order.length - 1; j >= 0 && set.size > want; j--) set.delete(order[j]);
    sc.set = set;
  }

  /** Checks a mode and amount: percent in (0, 100], count a whole number 1..MAX_DEVICES. */
  #amount(mode, amount) {
    if (mode !== 'percent' && mode !== 'count') throw new HttpError(400, 'Mode must be "percent" or "count"');
    const a = num(amount);
    if (mode === 'percent' && !(a > 0 && a <= 100)) throw new HttpError(400, 'Percent must be more than 0 and at most 100');
    if (mode === 'count' && !(Number.isInteger(a) && a >= 1 && a <= MAX_DEVICES)) throw new HttpError(400, `Count must be a whole number from 1 to ${MAX_DEVICES.toLocaleString()}`);
    return a;
  }

  addScenario({ key, mode = 'percent', amount = 10 } = {}) {
    if (!has(SCENARIOS, key)) throw new HttpError(400, 'Unknown scenario');
    const m = mode;
    const a = this.#amount(m, amount);
    if (this.scenarios.length >= 20) throw new HttpError(400, 'At most 20 scenarios at once');
    const sc = { id: crypto.randomBytes(4).toString('hex'), key, mode: m, amount: a, seed: crypto.randomInt(1, 2 ** 31), startedAt: new Date().toISOString() };
    this.#choose(sc);
    this.scenarios.push(sc);
    return this.state();
  }

  updateScenario(id, { mode, amount }) {
    const sc = this.scenarios.find((s) => s.id === id);
    if (!sc) throw new HttpError(404, 'Scenario not found');
    const m = mode === undefined ? sc.mode : mode;
    const a = this.#amount(m, amount === undefined ? sc.amount : amount);
    sc.mode = m; sc.amount = a;
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
    return { sql: "((id >= ? AND id < ?) OR (id >= ? AND id < ?)) AND json_type(data, '$.simulated') = 'true'",
      args: [SIM_PREFIX, nextPrefix(SIM_PREFIX), LEGACY_PREFIX, nextPrefix(LEGACY_PREFIX)] };
  }
  /** Delete every simulated record (the simulation must be stopped). Waits for in-flight check-ins first. */
  async removeDevices() {
    if (this.running) throw new HttpError(409, 'Stop the load test first');
    if (this.removing) throw new HttpError(409, 'Simulated devices are already being removed');
    // While removing, nothing new may be sent (a Burst or Start would bring records back).
    this.removing = true;
    try {
      this.stop(); // drops anything still queued (a burst while stopped)
      this.urgent.clear();
      this.bursting = false;
      await this.drain();
      this.store.flush();
      this.claims.clear();
      const w = this.#simWhere();
      const ids = this.db().prepare(`SELECT id FROM records WHERE ${w.sql}`).all(...w.args).map((r) => r.id);
      return { deleted: ids.length ? this.store.deleteMany(ids).length : 0 };
    } finally {
      this.removing = false;
    }
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
    const taken = this.takenIds();
    const recent = this.history.slice(-10);
    const sum = (k) => recent.reduce((a, p) => a + p[k], 0);
    const mem = process.memoryUsage();
    return {
      running: this.running,
      devices: this.devices,
      interval: this.interval,
      topProcs: this.topProcs,
      target: Math.round(this.devices / this.interval * 100) / 100,   // check-ins per second when running
      inflight: this.inflight,
      maxInflight: MAX_INFLIGHT,
      bursting: this.bursting,
      queued: this.urgent.size,
      lastBurst: this.lastBurst,
      taken: taken.length,           // devices skipped because a real device has that name
      takenIds: taken.slice(0, 20),
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
  // Stop answers once the check-ins already in flight have landed, so a Remove right after deletes them too.
  app.post('/api/admin/loadtest/stop', cap, async () => { loadTest.stop(); await loadTest.drain(); return full(); });
  app.post('/api/admin/loadtest/burst', cap, async () => { loadTest.burst(); return { ...full(), burst: loadTest.lastBurst }; });
  app.put('/api/admin/loadtest', cap, async (req) => { loadTest.configure(req.body || {}); return full(); });
  app.post('/api/admin/loadtest/scenarios', cap, async (req) => { loadTest.addScenario(req.body || {}); return full(); });
  app.put('/api/admin/loadtest/scenarios/:id', cap, async (req) => { loadTest.updateScenario(req.params.id, req.body || {}); return full(); });
  app.delete('/api/admin/loadtest/scenarios/:id', cap, async (req) => { loadTest.removeScenario(req.params.id); return full(); });
  app.get('/api/admin/loadtest/sims', cap, async (req) => loadTest.search(req.query));
  app.put('/api/admin/loadtest/sims/:id', cap, async (req) => ({ device: loadTest.setDevice(req.params.id, req.body || {}), ...full() }));
  app.delete('/api/admin/loadtest/sims', cap, async () => { loadTest.healAllDevices(); return full(); });
  app.delete('/api/admin/loadtest/devices', cap, async (req) => {
    if (String(req.query.confirm) !== 'true') throw new HttpError(400, 'Add ?confirm=true to delete every simulated device');
    const r = await loadTest.removeDevices();
    return { ...r, ...full() };
  });
}
