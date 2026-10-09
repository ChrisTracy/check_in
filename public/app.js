/* Check-in dashboard — vanilla JS, no build step. */
(() => {
  'use strict';

  // ------------------------------------------------------------------ utils
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('checkin.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('checkin.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const nf = new Intl.NumberFormat();
  const SYS = ['id', 'created', 'modified'];
  const STATUS_KEY = '__status';
  const isNumeric = (v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(v) && isFinite(v));
  const show = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const icon = (d, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24"><path d="${d}"/></svg>`;
  const ICON = {
    filter: 'M3 5h18l-7 8v6l-4 2v-8z', x: 'M6 6l12 12M18 6L6 18', chev: 'M6 9l6 6 6-6', grip: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
    plus: 'M12 5v14M5 12h14', pulse: 'M3 12h4l3-8 4 16 3-8h4', edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
    pause: 'M8 5v14M16 5v14', play: 'M7 4l13 8-13 8z',
    up: 'M6 15l6-6 6 6', down: 'M6 9l6 6 6-6', trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4',
    star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z',
    user: 'M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21a8 8 0 0 1 16 0',
    users: 'M13 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0M2 21a7 7 0 0 1 14 0M17 11a3 3 0 1 0 0-6M22 21a6 6 0 0 0-4-5.6',
  };

  function relTime(iso, now = Date.now()) {
    const t = Date.parse(iso);
    if (!t) return '';
    const s = Math.round((now - t) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + (m % 60 ? (m % 60) + 'm ' : '') + 'ago';
    const d = Math.floor(h / 24);
    if (d < 30) return d + 'd ago';
    return new Date(t).toLocaleDateString();
  }
  const absTime = (iso) => (iso ? new Date(iso).toLocaleString() : '');
  const shortTime = (iso) => {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
      : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  const GOOD = /^(ok|okay|online|up|healthy|success|succeeded|pass|passed|active|running|true|yes|green|ready|complete|completed|done)$/i;
  const WARN = /^(warn|warning|degraded|pending|slow|busy|yellow|amber|starting|partial|retry|retrying)$/i;
  const BAD = /^(error|err|fail|failed|failure|down|offline|critical|crit|dead|false|no|red|stopped|unhealthy|fatal|timeout)$/i;
  const INFO = /^(info|new|idle|maintenance|paused|unknown|blue)$/i;
  function pillClass(v) {
    if (typeof v !== 'string' && typeof v !== 'boolean') return '';
    const s = String(v).trim();
    if (s.length > 20) return '';
    if (GOOD.test(s)) return 'good';
    if (WARN.test(s)) return 'warn';
    if (BAD.test(s)) return 'bad';
    if (INFO.test(s)) return 'info';
    return '';
  }

  // ------------------------------------------------------------------ state
  const DEFAULT_VIEW = () => ({
    search: '', filters: [], match: 'all', time: 0, status: 'all', sort: [{ key: 'modified', dir: 'desc' }],
    hidden: [], order: [], widths: {}, groupBy: '', layout: 'table', box: '',
  });
  // Defaults + a saved/stored state, with every value type-checked (see viewstate.js).
  const normView = (st) => Object.assign(DEFAULT_VIEW(), window.CheckinViewState.cleanViewState(st));
  const S = {
    records: new Map(), // id -> record
    searchText: new Map(), // id -> lowercase haystack
    rev: 0,
    fieldCounts: new Map(),
    fields: [],
    // First visit on a phone: cards read better than a wide table.
    view: normView(store.get('view', null) || (matchMedia('(max-width: 720px)').matches ? { layout: 'cards' } : {})),
    viewRef: store.get('viewRef', ''), // '' = Default, 'p:<id>' = personal view, 't:<id>' = team view
    views: { personal: [], team: [] }, // saved views from the server
    viewDefaults: { mine: null, team: null }, // which view opens first (see effectiveDefault)
    settings: Object.assign({ theme: 'auto', compact: false }, store.get('settings', {}), { staleMinutes: 15 }),
    me: null, // { user, role, caps, csrf }
    checked: new Set(), // multi-selected record ids
    lastChecked: null,
    ingest: { paused: false, since: null, by: null }, // server-wide check-in pause
    items: [], // flattened render list for table/cards
    filtered: [], // filtered + sorted records
    collapsed: new Set(),
    selected: null,
    flash: new Map(), // id -> timestamp of last change seen live
    config: { historyLimit: 100, apiKeySet: false, apiKeyRequired: true },
    boxes: [], // status boxes (shared; set up by power users)
    boxesVersion: null, // server's version of that list (bumps on every save)
    connected: false,
  };

  // Ids of the records matching the current filters (built on demand, reset by computeView).
  Object.defineProperty(S, 'matching', {
    get() { return S.matchingCache || (S.matchingCache = new Set(S.filtered.map((r) => r.id))); },
  });

  // ------------------------------------------------------------------ API
  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    const method = (opts.method || 'GET').toUpperCase();
    if (method !== 'GET' && S.me?.csrf) headers['x-csrf-token'] = S.me.csrf;
    const res = await fetch(path, Object.assign({}, opts, { headers, credentials: 'same-origin' }));
    if (res.status === 401) {
      location.href = '/login?returnTo=' + encodeURIComponent(location.pathname + location.search);
      throw new Error('Signed out');
    }
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
      throw new Error(msg);
    }
    return res;
  }
  const apiJson = async (p, o) => (await api(p, o)).json();

  // ------------------------------------------------------------------ data
  function indexRecord(rec) {
    const prev = S.records.get(rec.id);
    if (prev) for (const k in prev) if (!SYS.includes(k) && k[0] !== '_') bumpField(k, -1);
    for (const k in rec) if (!SYS.includes(k) && k[0] !== '_') bumpField(k, 1);
    S.records.set(rec.id, rec);
    let s = rec.id;
    for (const k in rec) if (k[0] !== '_' && k !== 'created' && k !== 'modified' && k !== 'id') s += '\u0001' + show(rec[k]);
    S.searchText.set(rec.id, s.toLowerCase());
  }
  function removeRecord(id) {
    const prev = S.records.get(id);
    if (!prev) return;
    for (const k in prev) if (!SYS.includes(k) && k[0] !== '_') bumpField(k, -1);
    S.records.delete(id);
    S.searchText.delete(id);
  }
  function bumpField(k, d) {
    const n = (S.fieldCounts.get(k) || 0) + d;
    if (n <= 0) S.fieldCounts.delete(k); else S.fieldCounts.set(k, n);
  }
  function refreshFieldList() {
    S.fields = [...S.fieldCounts.entries()].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0])).map((e) => e[0]);
  }

  // Full download of every record: used on page load (and when the server's data was replaced).
  let loadingAll = null;
  function loadAll() {
    if (loadingAll) return loadingAll;
    loadingAll = (async () => {
      const data = await apiJson('/api/records');
      S.records.clear(); S.searchText.clear(); S.fieldCounts.clear();
      for (const r of data.records) indexRecord(r);
      S.rev = data.rev;
      refreshFieldList();
      scheduleRender(true);
    })().finally(() => { loadingAll = null; });
    return loadingAll;
  }

  // Live updates. However fast devices check in, the dashboard fetches what changed at most
  // once per LIVE_INTERVAL and re-sorts/re-renders at most that often, so thousands of
  // devices don't keep the browser busy. Interactions (typing, sorting...) still render at once.
  const LIVE_INTERVAL = 1000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let fetching = false;
  let fetchAgain = false;
  let lastFetch = 0;
  async function fetchChanges() {
    if (fetching) { fetchAgain = true; return; }
    fetching = true;
    try {
      do {
        fetchAgain = false;
        if (loadingAll) await loadingAll.catch(() => {}); // the full load already includes these changes
        const wait = lastFetch + LIVE_INTERVAL - Date.now();
        if (wait > 0) await sleep(wait);
        lastFetch = Date.now();
        const data = await apiJson('/api/records?sinceRev=' + S.rev);
        if (data.rev < S.rev) { await loadAll(); continue; } // server data was replaced: start over
        const now = Date.now();
        for (const r of data.records) { indexRecord(r); S.flash.set(r.id, now); }
        S.rev = Math.max(S.rev, data.rev);
        if (data.records.length) {
          refreshFieldList();
          scheduleLiveRender();
          if (S.selected && data.records.some((r) => r.id === S.selected)) refreshDrawer();
          if (S.view.layout === 'activity') loadNewActivity();
        }
      } while (fetchAgain);
    } catch (e) { console.warn(e); } finally { fetching = false; }
  }

  // After a reconnect: fetch only what changed while we were away, and drop records that were
  // deleted meanwhile using the list of ids, instead of downloading every record again.
  async function resync() {
    try {
      if (!S.rev) { await loadAll(); return; }
      fetchChanges();
      const { ids, rev } = await apiJson('/api/records?idsOnly=1');
      const keep = new Set(ids);
      // Only records the id list could know about: anything with a newer rev arrived after it.
      const gone = [];
      for (const [id, rec] of S.records) if (!keep.has(id) && (rec._rev || 0) <= rev) gone.push(id);
      if (!gone.length) return;
      for (const id of gone) { removeRecord(id); S.checked.delete(id); }
      refreshFieldList();
      updateSelBar();
      if (S.selected && !S.records.has(S.selected)) closeDrawer();
      scheduleRender(true);
    } catch (e) { console.warn(e); }
  }

  // ------------------------------------------------------------------ live (SSE)
  let es = null;
  let everConnected = false;
  function connect() {
    if (es) es.close();
    es = new EventSource('/api/events');
    es.addEventListener('hello', () => {
      S.connected = true;
      updateLive();
      if (everConnected) { // catch up after a reconnect
        resync(); loadIngest(); if (S.view.layout === 'activity') loadActivity();
        loadBoxes().then((changed) => { if (changed) loadAll().catch(() => {}); });
      }
      everConnected = true;
    });
    es.addEventListener('change', (e) => {
      fetchChanges();
    });
    es.addEventListener('delete', (e) => {
      const { ids } = JSON.parse(e.data);
      ids.forEach((id) => { removeRecord(id); S.checked.delete(id); });
      refreshFieldList();
      updateSelBar();
      if (S.selected && ids.includes(S.selected)) closeDrawer();
      scheduleRender(true);
    });
    es.addEventListener('views', () => loadViews());
    // Box definitions changed. When a rule changed, every record's box state was recomputed.
    es.addEventListener('boxes', (e) => {
      const d = JSON.parse(e.data || '{}');
      if (d.version === S.boxesVersion) return; // our own save, already applied
      loadBoxes();
      if (d.reload) loadAll().catch(() => {});
    });
    es.addEventListener('ingest', (e) => { S.ingest = JSON.parse(e.data); updateLive(); });
    es.addEventListener('reload', () => { S.checked.clear(); updateSelBar(); loadAll().catch(() => {}); });
    es.addEventListener('settings', (e) => {
      const st = JSON.parse(e.data);
      S.settings.staleMinutes = st.staleMinutes;
      scheduleRender(true);
    });
    es.addEventListener('clear', () => {
      S.checked.clear(); updateSelBar();
      S.records.clear(); S.searchText.clear(); S.fieldCounts.clear(); refreshFieldList();
      closeDrawer();
      scheduleRender(true);
      if (S.view.layout === 'activity') loadActivity();
    });
    es.onerror = () => {
      S.connected = false;
      updateLive();
      // If the session expired, EventSource keeps failing; check and bounce to login.
      fetch('/api/auth/me').then((r) => { if (r.status === 401) location.href = '/login'; }).catch(() => {});
    };
  }

  function updateLive() {
    const el = $('#liveStatus');
    const paused = S.ingest.paused;
    el.className = 'live ' + (!S.connected ? 'off' : paused ? 'paused' : 'on');
    $('#liveText').textContent = !S.connected ? 'Reconnecting…' : paused ? 'Check-ins paused' : 'Live';
    const who = S.ingest.by ? ` by ${S.ingest.by}` : '';
    el.title = paused ? `Paused${who} ${relTime(S.ingest.since)}. New check-ins are rejected with HTTP 503.` : 'Accepting check-ins';
    $('#liveToggle').innerHTML = paused ? icon(ICON.play) + '<span>Resume check-ins</span>' : icon(ICON.pause) + '<span>Pause check-ins</span>';
    $('#liveToggle').title = paused ? 'Start accepting check-ins again' : 'Stop accepting check-ins (devices get HTTP 503)';
    $('#pauseBanner').hidden = !paused;
    $('#pauseText').innerHTML = `<b>Check-ins are paused</b>${esc(who)} ${esc(relTime(S.ingest.since))}. New check-ins and imports are rejected with HTTP 503 until resumed.`;
    $('#pauseResume').hidden = !can('pause');
  }

  async function loadIngest() {
    try { S.ingest = await apiJson('/api/status'); updateLive(); } catch { /* ignore */ }
  }

  async function setIngestPaused(paused) {
    try {
      S.ingest = await apiJson('/api/status', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused }) });
      updateLive();
      toast(paused ? 'Check-ins paused' : 'Check-ins resumed');
    } catch (e) { toast(e.message, 'error'); }
  }

  function togglePause() {
    if (!can('pause')) return;
    if (S.ingest.paused) { setIngestPaused(false); return; }
    modal({
      title: 'Pause check-ins?',
      body: `<p>While paused, the server <b>rejects</b> new check-ins and CSV imports with HTTP 503 (Retry-After: 30). Devices should retry later. Nothing is queued.</p>
        <p style="font-size:12px">Viewing, exporting and deleting still work. Anyone can check the state at <code>GET /api/status</code>.</p>`,
      actions: [{ label: 'Cancel' }, { label: 'Pause check-ins', cls: 'danger solid', onClick: () => setIngestPaused(true) }],
    });
  }

  // ------------------------------------------------------------------ status
  function statusOf(rec, now) {
    const age = (now - Date.parse(rec.modified)) / 60000;
    const m = S.settings.staleMinutes;
    return age <= m ? 'fresh' : age <= m * 2 ? 'aging' : 'stale';
  }

  // ------------------------------------------------------------------ filtering & sorting
  // Filter conditions. `kinds` says which field types offer the condition:
  //   text   – custom fields, ID and "Any field"
  //   status – the computed Status column (active / aging / stale)
  //   date   – Created and Modified
  // fn(value, preparedFilter) → boolean. See prepareFilter() for the prepared values.
  const isBlank = (v) => v === undefined || v === null || v === '';
  const OPS = {
    contains: { label: 'contains', kinds: ['text'], fn: (v, f) => show(v).toLowerCase().includes(f.lc) },
    ncontains: { label: 'does not contain', kinds: ['text'], fn: (v, f) => !show(v).toLowerCase().includes(f.lc) },
    eq: { label: 'is', kinds: ['text', 'status'], fn: (v, f) => show(v).toLowerCase() === f.lc },
    neq: { label: 'is not', kinds: ['text', 'status'], fn: (v, f) => show(v).toLowerCase() !== f.lc },
    starts: { label: 'starts with', kinds: ['text'], fn: (v, f) => show(v).toLowerCase().startsWith(f.lc) },
    gt: { label: '>', kinds: ['text'], fn: (v, f) => cmpLoose(v, f.value) > 0 },
    gte: { label: '≥', kinds: ['text'], fn: (v, f) => cmpLoose(v, f.value) >= 0 },
    lt: { label: '<', kinds: ['text'], fn: (v, f) => cmpLoose(v, f.value) < 0 },
    lte: { label: '≤', kinds: ['text'], fn: (v, f) => cmpLoose(v, f.value) <= 0 },
    regex: { label: 'matches regex', kinds: ['text'], fn: (v, f) => f.re.test(show(v)) },
    empty: { label: 'is empty', kinds: ['text'], noValue: true, fn: (v) => isBlank(v) },
    nempty: { label: 'is not empty', kinds: ['text'], noValue: true, fn: (v) => !isBlank(v) },
    within: { label: 'in the last', kinds: ['date'], value: 'duration', fn: (v, f) => Date.parse(v) >= f.now - f.ms },
    older: { label: 'more than … ago', chip: 'more than', suffix: 'ago', kinds: ['date'], value: 'duration', fn: (v, f) => Date.parse(v) < f.now - f.ms },
    after: { label: 'after', kinds: ['date'], value: 'datetime', fn: (v, f) => Date.parse(v) > f.t },
    before: { label: 'before', kinds: ['date'], value: 'datetime', fn: (v, f) => Date.parse(v) < f.t },
    on: { label: 'on', kinds: ['date'], value: 'date', fn: (v, f) => { const t = Date.parse(v); return t >= f.t && t < f.t2; } },
  };
  const DATE_FIELDS = new Set(['created', 'modified']);
  const fieldKind = (field) => (field === STATUS_KEY ? 'status' : DATE_FIELDS.has(field) ? 'date' : 'text');
  const DEFAULT_OP = { text: 'contains', status: 'eq', date: 'within' };
  const UNITS = { m: ['minute', 60000], h: ['hour', 3600000], d: ['day', 86400000] };
  function parseDuration(s) {
    const m = /^(\d+(?:\.\d+)?)([mhd])$/.exec(String(s ?? '').trim());
    return m ? { n: Number(m[1]), unit: m[2], ms: Number(m[1]) * UNITS[m[2]][1] } : null;
  }
  const durationLabel = (s) => { const d = parseDuration(s); return d ? `${d.n} ${UNITS[d.unit][0]}${d.n === 1 ? '' : 's'}` : s; };
  function localDayRange(ymd) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    return [new Date(y, m - 1, d).getTime(), new Date(y, m - 1, d + 1).getTime()];
  }

  /** Precompute what a filter needs once per render. Returns null for an unusable filter (it's then ignored). */
  function prepareFilter(f, now) {
    const op = OPS[f.op];
    if (!op) return null;
    const p = { ...f, fn: op.fn, lc: String(f.value ?? '').toLowerCase(), now };
    if (f.op === 'regex') { try { p.re = new RegExp(f.value, 'i'); } catch { return null; } }
    if (op.value === 'duration') { const d = parseDuration(f.value); if (!d) return null; p.ms = d.ms; }
    if (op.value === 'datetime') { p.t = new Date(f.value).getTime(); if (!Number.isFinite(p.t)) return null; }
    if (op.value === 'date') { [p.t, p.t2] = localDayRange(f.value); if (!Number.isFinite(p.t)) return null; }
    return p;
  }

  /** Human-readable pieces of a filter for chips: [field, condition, value]. */
  function describeFilter(f) {
    const op = OPS[f.op];
    const field = f.field === '*' ? 'Any field' : colLabel(f.field);
    if (!op) return [field, f.op, f.value];
    if (op.noValue) return [field, op.label, ''];
    let value = f.value;
    if (f.field === STATUS_KEY) value = statusLabel(f.value);
    else if (op.value === 'duration') value = durationLabel(f.value) + (op.suffix ? ' ' + op.suffix : '');
    else if (op.value === 'datetime') value = new Date(f.value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    else if (op.value === 'date') value = new Date(localDayRange(f.value)[0]).toLocaleDateString([], { dateStyle: 'medium' });
    return [field, op.chip || op.label, value];
  }
  function cmpLoose(a, b) {
    if (a === undefined || a === null || a === '') return NaN;
    if (isNumeric(a) && isNumeric(b)) return Number(a) - Number(b);
    return collator.compare(show(a), show(b));
  }
  function cmpSort(a, b) {
    const ae = a === undefined || a === null || a === '';
    const be = b === undefined || b === null || b === '';
    if (ae || be) return ae && be ? 0 : ae ? 1 : -1; // empties last
    if (isNumeric(a) && isNumeric(b)) return Number(a) - Number(b);
    return collator.compare(show(a), show(b));
  }
  const STATUS_RANK = { fresh: 0, aging: 1, stale: 2 };
  // Internal status keys stay the same (saved views use them); this is what people see.
  const STATUS_LABEL = { fresh: 'active', aging: 'aging', stale: 'stale' };
  const statusLabel = (k) => STATUS_LABEL[k] || k;
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  // Sorting uses the status rank (active < aging < stale); filtering uses the status key.
  function getVal(rec, key, now) {
    if (key === STATUS_KEY) return STATUS_RANK[statusOf(rec, now)];
    return rec[key];
  }
  function getFilterVal(rec, key, now) {
    if (key === STATUS_KEY) return statusOf(rec, now);
    return rec[key];
  }

  /** Is this record counted in box `b` right now? (condition held for the box's minutes) */
  function boxHit(rec, b, st, now) {
    const since = rec._boxes?.[b.id];
    if (!since) return false;
    if (b.ignoreStale && st === 'stale') return false;
    return now - Date.parse(since) >= b.minutes * 60000;
  }

  function computeView() {
    const v = S.view;
    const now = Date.now();
    const q = v.search.trim().toLowerCase();
    const terms = q ? q.split(/\s+/) : [];
    const filters = v.filters.map((f) => prepareFilter(f, now)).filter(Boolean);
    const timeMs = Math.abs(v.time) * 60000;
    const counts = { all: 0, fresh: 0, aging: 0, stale: 0, rate: 0, box: {} };
    const boxes = S.boxes.filter((b) => b.enabled);
    for (const b of boxes) counts.box[b.id] = 0;
    const boxFilter = boxes.find((b) => b.id === v.box) || null;
    const out = [];
    for (const rec of S.records.values()) {
      const st = statusOf(rec, now);
      counts.all++; counts[st]++;
      const mod = Date.parse(rec.modified);
      if (now - mod <= 60000) counts.rate++;
      if (rec._boxes) for (const b of boxes) if (boxHit(rec, b, st, now)) counts.box[b.id]++;
      if (v.status !== 'all' && st !== v.status) continue;
      if (boxFilter && !boxHit(rec, boxFilter, st, now)) continue;
      if (v.time > 0 && now - mod > timeMs) continue;
      if (v.time < 0 && now - mod <= timeMs) continue;
      if (terms.length) {
        const hay = S.searchText.get(rec.id);
        if (!terms.every((t) => hay.includes(t))) continue;
      }
      // Filter chips: "all" = every chip must match (AND), "any" = at least one (OR).
      // Search, the status card and the time filter always narrow the results.
      const test = (f) => {
        if (f.field === '*') {
          const keys = Object.keys(rec).filter((k) => k[0] !== '_' && k !== 'created' && k !== 'modified');
          if (f.op === 'ncontains' || f.op === 'neq' || f.op === 'empty') return keys.every((k) => f.fn(rec[k], f));
          return keys.some((k) => f.fn(rec[k], f));
        }
        return f.fn(getFilterVal(rec, f.field, now), f);
      };
      const ok = !filters.length || (v.match === 'any' ? filters.some(test) : filters.every(test));
      if (ok) out.push(rec);
    }
    const sorts = v.sort.filter((s) => s.key);
    if (sorts.length) {
      // Created/Modified are ISO-8601 UTC strings, which sort correctly as plain strings and much
      // faster than through the locale-aware comparer (this runs on every live update).
      const cmps = sorts.map((s) => {
        const sign = s.dir === 'desc' ? -1 : 1;
        if (DATE_FIELDS.has(s.key)) return (a, b) => { const x = a[s.key]; const y = b[s.key]; return x === y ? 0 : (x < y ? -sign : sign); };
        return (a, b) => sign * cmpSort(getVal(a, s.key, now), getVal(b, s.key, now));
      });
      out.sort((a, b) => {
        for (const c of cmps) { const r = c(a, b); if (r) return r; }
        return collator.compare(a.id, b.id);
      });
    }
    S.filtered = out;
    S.counts = counts;
    S.matchingCache = null;

    // grouping → flattened list of { g } and { r }
    const items = [];
    if (v.groupBy) {
      const groups = new Map();
      for (const r of out) {
        const key = v.groupBy === STATUS_KEY ? statusOf(r, now) : show(r[v.groupBy]);
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { key, rows: [], st: { fresh: 0, aging: 0, stale: 0 } }));
        g.rows.push(r);
        g.st[statusOf(r, now)]++;
      }
      const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : collator.compare(a, b)));
      for (const k of keys) {
        const g = groups.get(k);
        items.push({ g });
        if (!S.collapsed.has(k)) for (const r of g.rows) items.push({ r });
      }
    } else {
      for (const r of out) items.push({ r });
    }
    S.items = items;
  }

  // ------------------------------------------------------------------ columns
  function allColumns() {
    return [STATUS_KEY, 'id', ...S.fields, 'modified', 'created'];
  }
  function orderedColumns() {
    const all = allColumns().filter((c) => c !== 'id');
    const order = S.view.order.filter((c) => all.includes(c));
    for (const c of all) if (!order.includes(c)) {
      // new fields go before modified/created unless the user placed those
      const idx = order.indexOf('modified');
      if (c !== 'modified' && c !== 'created' && idx >= 0 && !S.view.order.includes(c)) order.splice(idx, 0, c);
      else order.push(c);
    }
    return ['id', ...order];
  }
  function visibleColumns() {
    const hidden = new Set(S.view.hidden);
    return orderedColumns().filter((c) => c === 'id' || !hidden.has(c));
  }
  // If the data has its own "status" field, label the built-in one distinctly.
  const builtinStatusLabel = () => (S.fields.some((f) => f.toLowerCase() === 'status') ? 'Status (check-in)' : 'Status');
  const colLabel = (c) => (c === STATUS_KEY ? builtinStatusLabel() : c === 'id' ? 'ID' : c === 'created' ? 'Created' : c === 'modified' ? 'Modified' : c);
  const SEL_KEY = '__sel';
  const canSelect = () => can('delete') || can('export');
  function renderCols() { return canSelect() ? [SEL_KEY, ...visibleColumns()] : visibleColumns(); }
  function colWidth(c) {
    if (c === SEL_KEY) return 40;
    const w = Number(S.view.widths[c]);
    if (w > 0) return Math.min(2000, Math.max(40, Math.round(w)));
    if (c === STATUS_KEY) return 92;
    if (c === 'id') return 180;
    if (c === 'modified') return 130;
    if (c === 'created') return 190;
    return Math.min(260, Math.max(110, c.length * 9 + 50));
  }

  // ------------------------------------------------------------------ rendering
  let renderQueued = false;
  let activityDirty = false;
  let needCompute = false;
  let viewChanged = false;
  // compute: re-filter/sort the records. live: the reason is new data, not a change to the view
  // (the activity feed then only adds the new entries instead of being rebuilt).
  function scheduleRender(compute, live = false) {
    if (compute) { needCompute = true; if (!live) viewChanged = true; }
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (needCompute) {
        computeView(); needCompute = false; renderChrome();
        if (viewChanged) { activityDirty = true; viewChanged = false; }
        if (S.checked.size) updateSelBar();
      }
      renderBody();
    });
  }
  let lastLiveRender = 0;
  let liveTimer = null;
  function scheduleLiveRender() {
    if (liveTimer) return;
    const go = () => { liveTimer = null; lastLiveRender = Date.now(); scheduleRender(true, true); };
    const wait = lastLiveRender + LIVE_INTERVAL - Date.now();
    if (wait <= 0) go(); else liveTimer = setTimeout(go, wait);
  }

  function renderChrome() {
    const c = S.counts;
    $('#statTotal').textContent = nf.format(c.all);
    $('#statFields').textContent = `${S.fields.length} field${S.fields.length === 1 ? '' : 's'} · history ${S.config.historyLimit < 0 ? '∞' : S.config.historyLimit}/record`;
    $('#statFresh').textContent = nf.format(c.fresh);
    $('#statAging').textContent = nf.format(c.aging);
    $('#statStale').textContent = nf.format(c.stale);
    const m = S.settings.staleMinutes;
    $('#statFreshSub').textContent = `checked in ≤ ${m}m ago`;
    $('#statAgingSub').textContent = `${m}–${m * 2}m ago`;
    $('#statStaleSub').textContent = `> ${m * 2}m ago`;
    $('#statRate').textContent = nf.format(c.rate);
    $$('.stat[data-status]').forEach((el) => el.classList.toggle('active', el.dataset.status === S.view.status && S.view.status !== 'all'));
    renderBoxCounts();
    const shown = S.filtered.length;
    $('#countText').textContent = shown === c.all ? `${nf.format(c.all)} records` : `Showing ${nf.format(shown)} of ${nf.format(c.all)} records`;
    $('#exportViewHint').textContent = `${nf.format(shown)} rows · ${visibleColumns().filter((x) => x !== STATUS_KEY).length} columns`;
    renderChips();
    renderGroupOptions();
    renderHeader();
    const empty = $('#empty');
    if (S.view.layout === 'activity') empty.hidden = true;
    else if (!c.all) {
      empty.hidden = false;
      const origin = location.origin;
      empty.innerHTML = `<div><div class="big">No check-ins yet</div>
        ${can('checkin') ? '<div>Install the agent on your Windows and Linux machines with one command:</div><button class="btn primary empty-action" data-open-agents>Add Device</button><div style="margin-top:14px">or send a POST with an <b>id</b> and any fields you like:</div>' : '<div>Send a POST with an <b>id</b> and any fields you like:</div>'}
        <code>curl -X POST "${esc(origin)}/api/checkin?id=device-1&amp;status=ok"${S.config.apiKeyRequired !== false ? ' -H "X-API-Key: …"' : ''}</code></div>`;
    } else if (!shown) {
      empty.hidden = false;
      empty.innerHTML = '<div><div class="big">No matching records</div><div>Try removing a filter or clearing the search.</div></div>';
    } else empty.hidden = true;
  }

  function renderChips() {
    const v = S.view;
    const chips = [];
    if (v.status !== 'all') chips.push(`<span class="chip"><span class="op">status</span><b>${esc(statusLabel(v.status))}</b><button data-rm="status">${icon(ICON.x)}</button></span>`);
    const fb = activeBox();
    if (fb) chips.push(`<span class="chip"><span class="op">box</span><b>${esc(fb.name)}</b><button data-rm="box" title="Remove box filter">${icon(ICON.x)}</button></span>`);
    const anyMode = v.match === 'any';
    if (v.filters.length > 1) {
      chips.push(`<span class="seg text match-seg" title="How filter chips combine"><button data-match="all" class="${anyMode ? '' : 'active'}">Match all</button><button data-match="any" class="${anyMode ? 'active' : ''}">Match any</button></span>`);
    }
    v.filters.forEach((f, i) => {
      if (i > 0) chips.push(`<span class="chip-join">${anyMode ? 'or' : 'and'}</span>`);
      const [fl, ol, vl] = describeFilter(f);
      const bad = !prepareFilter(f, Date.now());
      chips.push(`<span class="chip${bad ? ' bad' : ''}" data-edit="${i}" title="${bad ? 'This filter is invalid and is ignored. ' : ''}Click to edit · × to remove"><b>${esc(fl)}</b><span class="op">${esc(ol)}</span>${vl !== '' ? `<b>${esc(vl)}</b>` : ''}<button data-rm="f${i}" title="Remove filter">${icon(ICON.x)}</button></span>`);
    });
    if (chips.length || v.search || v.time) chips.push('<span class="chip clear" data-rm="all">Clear filters</span>');
    const html = chips.join('');
    if ($('#chips').dataset.html !== html) { $('#chips').innerHTML = html; $('#chips').dataset.html = html; }
  }

  function renderGroupOptions() {
    const sel = $('#groupBy');
    const opts = ['', STATUS_KEY, ...S.fields];
    if (S.view.groupBy && !opts.includes(S.view.groupBy)) opts.push(S.view.groupBy);
    const sig = opts.join('\u0001');
    if (sel.dataset.sig !== sig) {
      sel.innerHTML = opts.map((o) => `<option value="${esc(o)}">${o ? 'Group: ' + esc(colLabel(o)) : 'No grouping'}</option>`).join('');
      sel.dataset.sig = sig;
    }
    sel.value = S.view.groupBy;
  }

  function gridTemplate(cols) {
    return cols.map((c) => colWidth(c) + 'px').join(' ') + ' minmax(0,1fr)';
  }
  function totalWidth(cols) { return cols.reduce((a, c) => a + colWidth(c), 0); }

  function renderHeader() {
    const cols = renderCols();
    const th = $('#thead');
    th.style.gridTemplateColumns = gridTemplate(cols);
    th.style.width = Math.max(totalWidth(cols), 0) + 'px';
    th.style.minWidth = '100%';
    const sortIdx = new Map(S.view.sort.map((s, i) => [s.key, i]));
    const filtered = new Set(S.view.filters.map((f) => f.field));
    // Live updates re-run this every second; only rebuild the header when it would look different
    // (rebuilding it mid-drag would cancel a column drag).
    const sig = JSON.stringify([cols, S.view.sort, [...filtered], builtinStatusLabel()]);
    if (th.dataset.sig === sig) { syncHeaderCheckbox(); return; }
    th.dataset.sig = sig;
    th.innerHTML = cols.map((c) => {
      if (c === SEL_KEY) return '<div class="th cbcell" title="Select all matching records"><input type="checkbox" class="cb" id="cbAll" aria-label="Select all"></div>';
      const si = sortIdx.get(c);
      const s = si !== undefined ? S.view.sort[si] : null;
      const sortHtml = s ? `<span class="sort">${s.dir === 'asc' ? '▲' : '▼'}${S.view.sort.length > 1 ? `<sub>${si + 1}</sub>` : ''}</span>` : '';
      return `<div class="th" data-col="${esc(c)}" draggable="${c !== 'id'}" title="Click to sort · Shift+click to add sort · Drag to reorder">
        <span class="t">${esc(colLabel(c))}</span>${sortHtml}
        <button class="fbtn ${filtered.has(c) ? 'on' : ''}" data-filter="${esc(c)}" title="Filter ${esc(colLabel(c))}">${icon(ICON.filter)}</button>
        <span class="rz" data-rz="${esc(c)}"></span></div>`;
    }).join('') + '<div class="th" style="cursor:default"></div>';
    syncHeaderCheckbox();
  }

  function syncHeaderCheckbox() {
    const cb = $('#cbAll');
    if (!cb) return;
    let n = 0;
    for (const r of S.filtered) if (S.checked.has(r.id)) n++;
    cb.checked = n > 0 && n === S.filtered.length;
    cb.indeterminate = n > 0 && n < S.filtered.length;
  }

  function cellHtml(rec, c, now) {
    if (c === SEL_KEY) return `<div class="td cbcell"><input type="checkbox" class="cb" tabindex="-1" aria-label="Select ${esc(rec.id)}" ${S.checked.has(rec.id) ? 'checked' : ''}></div>`;
    if (c === STATUS_KEY) {
      const st = statusOf(rec, now);
      return `<div class="td"><span class="pill ${st === 'fresh' ? 'good' : st === 'aging' ? 'warn' : 'bad'}"><i class="dot ${st}" style="box-shadow:none;margin-right:6px"></i>${statusLabel(st)}</span></div>`;
    }
    if (c === 'id') return `<div class="td id" title="${esc(rec.id)}">${esc(rec.id)}</div>`;
    if (c === 'modified') return `<div class="td rel" title="${esc(absTime(rec.modified))}">${esc(relTime(rec.modified, now))}</div>`;
    if (c === 'created') return `<div class="td" title="${esc(relTime(rec.created, now))}">${esc(absTime(rec.created))}</div>`;
    const v = rec[c];
    if (v === undefined || v === null || v === '') return '<div class="td empty-cell">—</div>';
    if (typeof v === 'object') { const s = JSON.stringify(v); return `<div class="td obj" title="${esc(s)}">${esc(s)}</div>`; }
    const s = String(v);
    const pc = pillClass(v);
    if (pc) return `<div class="td"><span class="pill ${pc}">${esc(s)}</span></div>`;
    return `<div class="td${isNumeric(v) ? ' num' : ''}" title="${esc(s)}">${esc(s)}</div>`;
  }

  function renderBody() {
    const layout = S.view.layout;
    $('#tableWrap').hidden = layout !== 'table';
    $('#cardsWrap').hidden = layout !== 'cards';
    $('#activityWrap').hidden = layout !== 'activity';
    $$('#layoutSeg button').forEach((b) => b.classList.toggle('active', b.dataset.layout === layout));
    if (layout === 'table') renderTableRows();
    else if (layout === 'cards') renderCards();
    else if (layout === 'activity') {
      if (activityDirty) { activityDirty = false; renderActivity(); }
      else { const n = $('#actNote b'); if (n) n.textContent = nf.format(S.filtered.length); }
    }
  }

  function rowHeight() { return S.settings.compact ? 32 : 40; }

  function renderTableRows() {
    const wrap = $('#tableWrap');
    const body = $('#tbody');
    const cols = renderCols();
    const rh = rowHeight();
    const tpl = gridTemplate(cols);
    const width = totalWidth(cols);
    body.style.height = S.items.length * rh + 'px';
    body.style.width = width + 'px';
    const headH = $('#thead').offsetHeight;
    const top = Math.max(0, wrap.scrollTop - headH);
    const start = Math.max(0, Math.floor(top / rh) - 8);
    const end = Math.min(S.items.length, Math.ceil((top + wrap.clientHeight) / rh) + 8);
    const now = Date.now();
    let html = '';
    for (let i = start; i < end; i++) {
      const it = S.items[i];
      const y = i * rh;
      if (it.g) {
        const g = it.g;
        html += `<div class="gr ${S.collapsed.has(g.key) ? 'collapsed' : ''}" data-group="${esc(g.key)}" style="transform:translateY(${y}px)">${icon(ICON.chev)}
          ${S.view.groupBy === STATUS_KEY ? `<i class="dot ${esc(g.key)}"></i>` : ''}<span>${g.key === '' ? '<span class="muted">(empty)</span>' : esc(S.view.groupBy === STATUS_KEY ? statusLabel(g.key) : g.key)}</span>
          <span class="count">${nf.format(g.rows.length)}</span>
          <span class="mini"><span><i class="dot fresh"></i>${g.st.fresh}</span><span><i class="dot aging"></i>${g.st.aging}</span><span><i class="dot stale"></i>${g.st.stale}</span></span></div>`;
      } else {
        const r = it.r;
        const fl = S.flash.get(r.id);
        const flash = fl && now - fl < 1200 ? ' flash' : '';
        html += `<div class="tr${r.id === S.selected ? ' sel' : ''}${S.checked.has(r.id) ? ' checked' : ''}${flash}" data-id="${esc(r.id)}" style="transform:translateY(${y}px);grid-template-columns:${tpl}">${cols.map((c) => cellHtml(r, c, now)).join('')}<div></div></div>`;
      }
    }
    body.innerHTML = html;
    if (S.flash.size > 5000) S.flash.clear();
  }

  // cards (virtualised by rows)
  const CARD_GAP = 12;
  function renderCards() {
    const wrap = $('#cardsWrap');
    const box = $('#cards');
    const width = wrap.clientWidth - 32;
    const fieldCols = visibleColumns().filter((c) => !['id', STATUS_KEY, 'modified', 'created'].includes(c)).slice(0, 6);
    const CARD_H = 52 + Math.max(1, fieldCols.length) * 22.5;
    const perRow = Math.max(1, Math.floor((width + CARD_GAP) / (280 + CARD_GAP)));
    const cw = (width - CARD_GAP * (perRow - 1)) / perRow;
    // layout rows: group headers take a full row of 44px
    const rows = [];
    let y = 16;
    let cur = null;
    for (const it of S.items) {
      if (it.g) { rows.push({ y, h: 44, g: it.g }); y += 44; cur = null; continue; }
      if (!cur || cur.cards.length >= perRow) { cur = { y, h: CARD_H + CARD_GAP, cards: [] }; rows.push(cur); y += CARD_H + CARD_GAP; }
      cur.cards.push(it.r);
    }
    box.style.height = y + 16 + 'px';
    const top = wrap.scrollTop - 400;
    const bottom = wrap.scrollTop + wrap.clientHeight + 400;
    const now = Date.now();
    const selectable = canSelect();
    let html = '';
    for (const row of rows) {
      if (row.y + row.h < top || row.y > bottom) continue;
      if (row.g) {
        html += `<div class="card-group" style="top:${row.y}px;left:16px;right:16px">${S.view.groupBy === STATUS_KEY ? `<i class="dot ${esc(row.g.key)}"></i>` : ''}${row.g.key === '' ? '<span class="muted">(empty)</span>' : esc(S.view.groupBy === STATUS_KEY ? statusLabel(row.g.key) : row.g.key)} <span class="count">${row.g.rows.length}</span></div>`;
        continue;
      }
      row.cards.forEach((r, i) => {
        const st = statusOf(r, now);
        const dl = fieldCols.map((c) => {
          const v = r[c];
          const pc = pillClass(v);
          const val = v === undefined || v === null || v === '' ? '<span class="muted">—</span>' : pc ? `<span class="pill ${pc}">${esc(show(v))}</span>` : esc(show(v));
          return `<dt title="${esc(c)}">${esc(c)}</dt><dd title="${esc(show(v))}">${val}</dd>`;
        }).join('');
        const ck = S.checked.has(r.id);
        html += `<div class="card${ck ? ' checked' : ''}" data-id="${esc(r.id)}" style="top:${row.y}px;left:${16 + i * (cw + CARD_GAP)}px;width:${cw}px;height:${CARD_H}px">
          <div class="card-head"><i class="dot ${st}"></i><span class="cid">${esc(r.id)}</span><span class="rel" title="${esc(absTime(r.modified))}">${esc(relTime(r.modified, now))}</span></div>
          <dl>${dl || '<dt class="muted">No fields</dt><dd></dd>'}</dl>
          ${selectable ? `<input type="checkbox" class="cb card-cb" aria-label="Select ${esc(r.id)}" ${ck ? 'checked' : ''}>` : ''}</div>`;
      });
    }
    box.classList.toggle('selecting', S.checked.size > 0);
    box.innerHTML = html;
  }

  // activity feed
  // Loads the newest 300 entries once, then only fetches entries newer than the top one
  // (without each entry's full snapshot) and prepends them, keeping at most ACT_MAX rows.
  const ACT_PAGE = 300;
  const ACT_MAX = 1000;
  let activity = [];
  let activityMore = false; // older entries exist on the server
  let actSeq = 0; // bumps on every full load so late responses are ignored
  const actUrl = (q, limit = ACT_PAGE) => `/api/history?data=0&limit=${limit}${q}`;
  const loadActivity = debounce(async () => {
    const seq = ++actSeq;
    try {
      const data = await apiJson(actUrl(''));
      if (seq !== actSeq) return;
      activity = data.history;
      activityMore = data.history.length === ACT_PAGE;
      renderActivity();
    } catch (e) { console.warn(e); }
  }, 300);
  let actFetching = false;
  let actAgain = false;
  async function loadNewActivity() {
    if (actFetching) { actAgain = true; return; }
    if (!activity.length) { loadActivity(); return; }
    actFetching = true;
    try {
      do {
        actAgain = false;
        const seq = actSeq;
        const top = activity[0].hid;
        const data = await apiJson(actUrl('&after=' + top, ACT_MAX));
        // Ignore the answer if a full load replaced the list meanwhile.
        if (seq !== actSeq || activity[0]?.hid !== top || S.view.layout !== 'activity') return;
        if (data.history.length >= ACT_MAX) { loadActivity(); return; } // fell too far behind: start over
        prependActivity(data.history);
      } while (actAgain);
    } catch (e) { console.warn(e); } finally { actFetching = false; }
  }
  async function loadMoreActivity() {
    const last = activity[activity.length - 1];
    if (!last) return;
    const seq = actSeq;
    const data = await apiJson(actUrl('&before=' + last.hid));
    if (seq !== actSeq) return;
    activity = activity.concat(data.history);
    activityMore = data.history.length === ACT_PAGE;
    const list = $('#actList');
    if (list) list.insertAdjacentHTML('beforeend', activityRows(data.history));
    syncMoreButton();
  }
  function changesHtml(changes, max = 12) {
    const keys = Object.keys(changes);
    if (!keys.length) return '<div class="none">Checked in — no field changes</div>';
    const parts = keys.slice(0, max).map((k) => {
      const [from, to] = changes[k];
      return `<span class="chg" title="${esc(k)}: ${esc(show(from))} → ${esc(show(to))}"><span class="k">${esc(k)}</span> ${from !== null ? `<del>${esc(show(from))}</del> → ` : ''}${to !== null ? `<ins>${esc(show(to))}</ins>` : '<del>removed</del>'}</span>`;
    });
    if (keys.length > max) parts.push(`<span class="chg">+${keys.length - max} more</span>`);
    return `<div class="changes">${parts.join('')}</div>`;
  }
  const activityFiltering = () => { const v = S.view; return Boolean(v.search || v.filters.length || v.status !== 'all' || v.time || activeBox()); };
  // Rows for these entries, limited to the records that match the current filters.
  function activityRows(entries) {
    let list = entries;
    if (activityFiltering()) list = entries.filter((h) => S.matching.has(h.id));
    return list.map((h) => `<div class="act" data-id="${esc(h.id)}" data-hid="${Number(h.hid)}">
      <time title="${esc(absTime(h.at))}">${esc(shortTime(h.at))}</time>
      <div class="ico ${esc(h.action)}">${icon(h.action === 'create' ? ICON.plus : Object.keys(h.changes).length ? ICON.edit : ICON.pulse)}</div>
      <div class="what"><b>${esc(h.id)}</b> <span class="muted">${h.action === 'create' ? 'created' : 'v' + esc(h.version)}</span>${changesHtml(h.changes, 8)}</div></div>`).join('');
  }
  function syncMoreButton() {
    const btn = $('#moreActivity');
    if (btn) btn.hidden = !activityMore;
  }
  function prependActivity(entries) {
    if (!entries.length) return;
    activity = entries.concat(activity);
    const list = $('#actList');
    if (!list) { renderActivity(); return; }
    // New entries may belong to records that only now match the filters: refresh the matching set.
    if (activityFiltering()) computeView();
    list.insertAdjacentHTML('afterbegin', activityRows(entries));
    if (activity.length > ACT_MAX) {
      activity.length = ACT_MAX;
      activityMore = true;
      // Drop the rows of entries that fell off the end (they can be loaded again with "Load older").
      const oldest = activity[activity.length - 1].hid;
      while (list.lastElementChild && Number(list.lastElementChild.dataset.hid) < oldest) list.lastElementChild.remove();
    }
    syncMoreButton();
  }
  function renderActivity() {
    const el = $('#activity');
    if (!activity.length) {
      el.innerHTML = `<div class="empty" style="position:static;padding:60px"><div><div class="big">No activity yet</div><div>${S.config.historyLimit === 0 ? 'History is disabled (HISTORY_LIMIT=0).' : 'Check-ins will appear here as they arrive.'}</div></div></div>`;
      return;
    }
    const note = activityFiltering() ? `<div class="muted" id="actNote" style="padding:8px 16px;font-size:12px">Showing activity for the <b>${nf.format(S.filtered.length)}</b> records matching your filters.</div>` : '';
    el.innerHTML = note + `<div id="actList">${activityRows(activity)}</div>`
      + `<button class="btn load-more" id="moreActivity"${activityMore ? '' : ' hidden'}>Load older</button>`;
  }

  // ------------------------------------------------------------------ drawer
  let drawerTab = 'fields';
  let drawerData = null;
  const graphHidden = new Set(); // metrics switched off in the Graph tab
  async function openDrawer(id) {
    S.selected = id;
    $('#drawer').classList.add('open');
    $('#scrim').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#dTitle').textContent = id;
    $('#dBody').innerHTML = '<div class="muted">Loading…</div>';
    scheduleRender();
    await refreshDrawer();
  }
  async function refreshDrawer() {
    const id = S.selected;
    if (!id) return;
    try {
      const data = await apiJson('/api/records/' + encodeURIComponent(id) + '/history?limit=1000');
      if (S.selected !== id) return;
      drawerData = data;
      renderDrawer();
    } catch (e) {
      $('#dBody').innerHTML = `<div class="muted">${esc(e.message)}</div>`;
    }
  }
  function renderDrawer() {
    const { record, history } = drawerData;
    const now = Date.now();
    $('#dHistCount').textContent = history.length;
    // Graph tab: only when the record has CPU / RAM / disk percentages (now or in its history).
    const chart = window.CheckinChart ? window.CheckinChart.extract(record, history) : null;
    const gTab = $('#dGraphTab');
    gTab.disabled = !chart;
    gTab.title = chart ? 'CPU %, RAM %, disk space used % and disk activity % over time' : 'No CPU, RAM or disk % fields on this record (e.g. cpu_pct, ram_pct, disk_pct, disk_busy_pct)';
    if (!chart && drawerTab === 'graph') drawerTab = 'fields';
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === drawerTab));
    if (!record) { $('#dBody').innerHTML = '<div class="muted">Record no longer exists.</div>'; return; }
    const st = statusOf(record, now);
    $('#dSub').innerHTML = `<i class="dot ${st}"></i> ${statusLabel(st)} · last check-in ${esc(relTime(record.modified, now))} · version ${record._version}`;
    if (drawerTab === 'fields') {
      const keys = Object.keys(record).filter((k) => !SYS.includes(k) && k[0] !== '_').sort(collator.compare);
      const val = (v) => (typeof v === 'object' && v !== null ? `<pre>${esc(JSON.stringify(v, null, 2))}</pre>` : pillClass(v) ? `<span class="pill ${pillClass(v)}">${esc(show(v))}</span>` : esc(show(v)));
      $('#dBody').innerHTML = drawerBoxesHtml(record, now) + `<table class="kv">
        ${keys.map((k) => `<tr><td>${esc(k)}</td><td>${val(record[k])}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">No custom fields</td></tr>'}
        <tr class="sys"><td>created</td><td>${esc(absTime(record.created))} <span class="muted">(${esc(relTime(record.created, now))})</span></td></tr>
        <tr class="sys"><td>modified</td><td>${esc(absTime(record.modified))} <span class="muted">(${esc(relTime(record.modified, now))})</span></td></tr>
        <tr class="sys"><td>version</td><td>${record._version}</td></tr></table>`;
    } else if (drawerTab === 'graph') {
      const n = chart.times.length;
      const df = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      $('#dBody').innerHTML = `<div class="muted mc-caption">${n === 1 ? 'Only one check-in so far: the graph fills in as more arrive.' : `${nf.format(n)} check-ins, ${esc(df.format(chart.times[0]))} – ${esc(df.format(chart.times[n - 1]))}.`}
        ${S.config.historyLimit > 0 ? ` History keeps the last ${nf.format(S.config.historyLimit)} per record (HISTORY_LIMIT).` : S.config.historyLimit === 0 ? ' History is off (HISTORY_LIMIT=0), so only the latest values are shown.' : ''}</div>
        <div class="mc" id="dChart"></div>`;
      const draw = () => window.CheckinChart.render($('#dChart'), chart, {
        hidden: graphHidden,
        onToggle: (k) => { if (graphHidden.has(k)) graphHidden.delete(k); else graphHidden.add(k); draw(); },
      });
      draw();
    } else {
      if (!history.length) {
        $('#dBody').innerHTML = `<div class="muted">${S.config.historyLimit === 0 ? 'History is disabled (HISTORY_LIMIT=0).' : 'No history stored.'}</div>`;
        return;
      }
      $('#dBody').innerHTML = `<div class="muted" style="margin-bottom:12px;font-size:12px">Showing ${history.length} most recent change${history.length === 1 ? '' : 's'}${S.config.historyLimit > 0 ? ` (keeps up to ${S.config.historyLimit})` : ''}.</div>
        <ol class="timeline">${history.map((h) => `<li class="tl ${h.action === 'create' ? 'create' : Object.keys(h.changes).length ? 'changed' : ''}"><span class="node"></span>
          <div class="tl-head"><b>${h.action === 'create' ? 'Created' : 'Version ' + h.version}</b><time title="${esc(absTime(h.at))}">${esc(absTime(h.at))} · ${esc(relTime(h.at, now))}</time></div>
          ${changesHtml(h.changes, 50)}</li>`).join('')}</ol>`;
    }
  }
  function closeDrawer() {
    S.selected = null;
    drawerData = null;
    $('#drawer').classList.remove('open');
    $('#scrim').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    scheduleRender();
  }

  // ------------------------------------------------------------------ modal & toast
  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
  }
  function modal({ title, body, actions, wide = false }) {
    $('#modalBack .modal').classList.toggle('wide', wide);
    $('#mTitle').textContent = title;
    $('#mBody').innerHTML = body;
    const box = $('#mActions');
    box.innerHTML = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'btn ' + (a.cls || '');
      b.textContent = a.label;
      if (a.id) b.id = a.id;
      b.onclick = async () => { if (a.onClick) { const keep = await a.onClick(); if (keep === false) return; } closeModal(); };
      box.appendChild(b);
    }
    $('#modalBack').hidden = false;
    const first = $('#mBody input');
    if (first) setTimeout(() => first.focus(), 30);
  }
  function closeModal() { $('#modalBack').hidden = true; }

  // ------------------------------------------------------------------ status boxes
  // Optional cards under Active / Aging / Stale, e.g. "High CPU: cpu_pct > 90 for 10+ minutes".
  // Power users and admins set them up (shared with everyone). The server tracks since when each
  // device has matched each box (record._boxes); this side decides what counts right now.
  const BOX_OPS = {
    gt: '>', gte: '≥', lt: '<', lte: '≤', eq: 'is', neq: 'is not',
    contains: 'contains', ncontains: 'does not contain', empty: 'is empty', nempty: 'is not empty',
  };
  const BOX_NO_VALUE = new Set(['empty', 'nempty']);
  const BOX_TONES = { bad: 'Red', warn: 'Amber', info: 'Blue', neutral: 'Grey' };
  const BOX_PRESETS = [
    { key: 'cpu', label: 'High CPU', box: { name: 'High CPU', field: 'cpu_pct', op: 'gt', value: '90', minutes: 10, tone: 'bad' } },
    { key: 'ram', label: 'High memory', box: { name: 'High memory', field: 'ram_pct', op: 'gt', value: '90', minutes: 15, tone: 'warn' } },
    { key: 'io', label: 'High disk activity', box: { name: 'High disk activity', field: 'disk_busy_pct', op: 'gt', value: '90', minutes: 10, tone: 'warn' } },
    { key: 'disk', label: 'Low disk space', box: { name: 'Low disk space', field: 'disk_max_pct', op: 'gte', value: '90', minutes: 0, tone: 'warn' } },
    { key: 'reboot', label: 'Reboot required', box: { name: 'Reboot required', field: 'reboot_required', op: 'eq', value: 'true', minutes: 0, tone: 'info' } },
    { key: 'domain', label: 'Not domain joined', box: { name: 'Not domain joined', field: 'domain_joined', op: 'eq', value: 'false', minutes: 0, tone: 'neutral' } },
    { key: 'custom', label: 'Custom…', box: { name: '', field: '', op: 'gt', value: '', minutes: 0, tone: 'warn' } },
  ];
  const fmtMinutes = (m) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`);
  const boxRule = (b) => `${colLabel(b.field)} ${BOX_OPS[b.op] || b.op}${BOX_NO_VALUE.has(b.op) ? '' : ' ' + b.value}`;
  const boxSummary = (b) => boxRule(b) + (b.minutes ? ` · ${fmtMinutes(b.minutes)}+` : '');
  const activeBox = () => (S.view.box ? S.boxes.find((b) => b.enabled && b.id === S.view.box) || null : null);

  // Returns true when the list changed since we last had it (the records' _boxes may have been
  // recomputed then too, e.g. while this dashboard was disconnected).
  async function loadBoxes() {
    let r;
    try { r = await apiJson('/api/boxes'); } catch { return false; }
    const changed = S.boxesVersion !== null && r.version !== S.boxesVersion;
    S.boxes = r.boxes || [];
    S.boxesVersion = r.version;
    renderBoxes();
    scheduleRender(true);
    return changed;
  }

  // Card structure (only when the list of boxes changes); counts are filled in by renderBoxCounts().
  function renderBoxes() {
    const el = $('#boxes');
    const shown = S.boxes.filter((b) => b.enabled);
    const editable = can('boxes');
    const sig = JSON.stringify([shown, editable]);
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.hidden = !shown.length;
    el.innerHTML = shown.map((b) => `<button class="stat box tone-${esc(b.tone)}" data-box="${esc(b.id)}"
        title="${esc(boxRule(b))}${b.minutes ? ` for at least ${esc(fmtMinutes(b.minutes))}` : ''}${b.ignoreStale ? ' · stale devices not counted' : ''}. Click to show these devices.">
        <span class="label"><i class="tone-dot"></i>${esc(b.name)}</span>
        <span class="value" data-count>0</span>
        <span class="sub">${esc(boxSummary(b))}</span></button>`).join('')
      + (editable ? `<button class="box-edit" id="boxEdit" title="Edit status boxes" aria-label="Edit status boxes">${icon(ICON.sliders)}</button>` : '');
  }
  function renderBoxCounts() {
    renderBoxes();
    const counts = S.counts?.box || {};
    $$('#boxes [data-box]').forEach((el) => {
      const n = counts[el.dataset.box] || 0;
      el.querySelector('[data-count]').textContent = nf.format(n);
      el.classList.toggle('zero', !n);
      el.classList.toggle('active', el.dataset.box === S.view.box);
    });
  }

  // Badges in the record drawer: which boxes this device is in (or is on its way into).
  function drawerBoxesHtml(record, now) {
    const st = statusOf(record, now);
    const items = S.boxes.filter((b) => b.enabled && record._boxes?.[b.id]).map((b) => {
      const since = record._boxes[b.id];
      const held = now - Date.parse(since);
      const counted = boxHit(record, b, st, now);
      const why = counted ? `since ${relTime(since, now).replace(' ago', '')}` : b.ignoreStale && st === 'stale' ? 'not counted while stale' : `${fmtMinutes(Math.floor(held / 60000))} of ${fmtMinutes(b.minutes)}`;
      return `<span class="box-badge tone-${esc(b.tone)}${counted ? '' : ' pending'}" title="${esc(boxRule(b))} since ${esc(absTime(since))}"><i class="tone-dot"></i>${esc(b.name)} <small>${esc(why)}</small></span>`;
    });
    return items.length ? `<div class="d-boxes">${items.join('')}</div>` : '';
  }

  function openBoxEditor() {
    if (!can('boxes')) return;
    let draft = S.boxes.map((b) => ({ ...b }));
    const known = new Set(S.fields);
    const row = (b, i) => `<div class="bx${b.enabled ? '' : ' off'}" data-i="${i}">
      <div class="bx-row">
        <label class="bx-name">Name<input class="input" data-k="name" maxlength="40" value="${esc(b.name)}" placeholder="e.g. High CPU"></label>
        <label class="bx-tone">Color<select class="select" data-k="tone">${Object.entries(BOX_TONES).map(([k, l]) => `<option value="${k}" ${b.tone === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <div class="bx-tools">
          <label class="switch" title="Show this box on the dashboard"><input type="checkbox" data-k="enabled" ${b.enabled ? 'checked' : ''}><span class="track"></span></label>
          <button class="icon-btn sm" data-move="-1" title="Move up" ${i === 0 ? 'disabled' : ''}>${icon(ICON.up)}</button>
          <button class="icon-btn sm" data-move="1" title="Move down" ${i === draft.length - 1 ? 'disabled' : ''}>${icon(ICON.down)}</button>
          <button class="icon-btn sm danger" data-del title="Delete box">${icon(ICON.trash)}</button>
        </div>
      </div>
      <div class="bx-row">
        <label class="bx-field">Field<input class="input" data-k="field" list="bxFields" value="${esc(b.field)}" placeholder="e.g. cpu_pct" autocomplete="off"></label>
        <label class="bx-op">Condition<select class="select" data-k="op">${Object.entries(BOX_OPS).map(([k, l]) => `<option value="${k}" ${b.op === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label class="bx-val">Value<input class="input" data-k="value" value="${esc(b.value)}" ${BOX_NO_VALUE.has(b.op) ? 'disabled' : ''}></label>
        <label class="bx-min">For at least<span class="bx-unit"><input class="input" type="number" min="0" max="10080" step="1" data-k="minutes" value="${Number(b.minutes) || 0}">min</span></label>
      </div>
      <label class="bx-check"><input type="checkbox" data-k="ignoreStale" ${b.ignoreStale !== false ? 'checked' : ''}>Don't count stale devices (their last reading is out of date)</label>
      <div class="bx-warn"${fieldWarn(b.field) ? '' : ' hidden'}>${fieldWarn(b.field)}</div>
    </div>`;
    function fieldWarn(f) { return f && S.records.size && !known.has(f) && f !== 'id' ? `No device has reported <code>${esc(f)}</code> yet.` : ''; }
    const draw = () => {
      $('#bxList').innerHTML = draft.length ? draft.map(row).join('')
        : '<div class="bx-empty muted">No boxes yet. Start with a preset below, or build your own.</div>';
    };
    modal({
      title: 'Status boxes',
      wide: true,
      body: `<p style="font-size:13px">Boxes sit under Active / Aging / Stale and count the devices that match a rule. Everyone sees them; clicking one shows just those devices.
          <b>For at least</b> means every check-in for that long matched (0 = the latest check-in matches).</p>
        <div id="bxList"></div>
        <div class="bx-add"><span class="muted">Add a box:</span>${BOX_PRESETS.map((p) => `<button class="btn sm" data-preset="${p.key}">${icon(ICON.plus)}${esc(p.label)}</button>`).join('')}</div>
        <datalist id="bxFields">${S.fields.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => {
        try {
          const r = await apiJson('/api/boxes', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ boxes: draft, version: S.boxesVersion }) });
          S.boxes = r.boxes;
          S.boxesVersion = r.version;
          if (r.recomputed) loadAll().catch(() => {}); // records' _boxes were worked out again
          renderBoxes();
          if (S.view.box && !activeBox()) setView({ box: '' }); else scheduleRender(true);
          toast('Status boxes saved for everyone');
        } catch (e) { toast(e.message, 'error'); if (/someone else/i.test(e.message)) loadBoxes(); return false; }
      } }],
    });
    draw();
    const list = $('#bxList');
    list.addEventListener('input', (e) => {
      const k = e.target.dataset.k;
      const i = Number(e.target.closest('.bx')?.dataset.i);
      if (!k || !draft[i]) return;
      const b = draft[i];
      b[k] = e.target.type === 'checkbox' ? e.target.checked : k === 'minutes' ? Math.max(0, Math.round(Number(e.target.value) || 0)) : e.target.value;
      if (k === 'op') { const v = e.target.closest('.bx').querySelector('[data-k="value"]'); v.disabled = BOX_NO_VALUE.has(b.op); }
      if (k === 'enabled') e.target.closest('.bx').classList.toggle('off', !b.enabled);
    });
    list.addEventListener('change', (e) => {
      if (e.target.dataset.k !== 'field') return;
      const w = e.target.closest('.bx').querySelector('.bx-warn');
      w.innerHTML = fieldWarn(e.target.value.trim());
      w.hidden = !w.innerHTML;
    });
    list.addEventListener('click', (e) => {
      const i = Number(e.target.closest('.bx')?.dataset.i);
      const mv = e.target.closest('[data-move]');
      if (mv) { const j = i + Number(mv.dataset.move); [draft[i], draft[j]] = [draft[j], draft[i]]; draw(); return; }
      if (e.target.closest('[data-del]')) { draft.splice(i, 1); draw(); }
    });
    $('#mBody .bx-add').addEventListener('click', (e) => {
      const p = BOX_PRESETS.find((x) => x.key === e.target.closest('[data-preset]')?.dataset.preset);
      if (!p) return;
      if (draft.length >= 24) { toast('At most 24 boxes', 'error'); return; }
      draft.push({ ...p.box, ignoreStale: true, enabled: true });
      draw();
      const last = $$('#bxList .bx').pop();
      last?.scrollIntoView({ block: 'nearest' });
      last?.querySelector(p.key === 'custom' ? '[data-k="name"]' : '[data-k="value"]')?.focus();
    });
  }

  // ------------------------------------------------------------------ views
  // Saved views live on the server: personal views belong to your account,
  // team views are shared with everyone and managed by power users and admins.
  function saveState() {
    store.set('view', S.view);
    store.set('viewRef', S.viewRef);
  }
  function setView(patch, compute = true) {
    Object.assign(S.view, patch);
    saveState();
    updateViewDirty();
    scheduleRender(compute);
  }
  const viewRef = (v) => (v.scope === 'team' ? 't:' : 'p:') + v.id;
  function findView(ref) {
    if (!ref) return null;
    const list = ref[0] === 't' ? S.views.team : S.views.personal;
    return list.find((v) => viewRef(v) === ref) || null;
  }
  const canWriteView = (v) => Boolean(v) && (v.scope === 'personal' || can('teamViews'));
  // Comparable form of a view state (fills in defaults so old and new states line up).
  const viewKey = (st) => JSON.stringify(normView(st));
  function updateViewDirty() {
    const saved = findView(S.viewRef);
    const dirty = saved ? viewKey(saved.state) !== viewKey(S.view) : false;
    $('#viewSave').classList.toggle('dirty', dirty);
    $('#viewSave').title = dirty ? 'Save view (you have unsaved changes)' : 'Save view';
  }
  function renderViewSelect() {
    if (S.viewsLoaded && S.viewRef && !findView(S.viewRef)) { S.viewRef = ''; saveState(); }
    const def = effectiveDefault();
    const cur = findView(S.viewRef) ? S.viewRef : '';
    const { personal, team } = S.views;
    // Default markers: star + one person = your default, star + two people = the team default.
    const mineRef = S.viewDefaults.mine === 'builtin' ? '' : (S.viewDefaults.mine && findView(S.viewDefaults.mine) ? S.viewDefaults.mine : null);
    const teamRef = S.viewDefaults.team && findView(S.viewDefaults.team) ? S.viewDefaults.team : null;
    // Solid silhouettes read better than outlines at this size; the second person sits behind, faded.
    const svgUser = '<svg class="i person" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4.2"/><path d="M3.5 21c0-4.4 3.8-7.5 8.5-7.5s8.5 3.1 8.5 7.5z"/></svg>';
    const svgUsers = '<svg class="i person" viewBox="0 0 24 24"><g opacity=".5"><circle cx="16.5" cy="7.5" r="3.4"/><path d="M13.5 13.9c1-.5 2-.8 3-.8 3.7 0 6.5 2.6 6.5 6.4h-6.2c-.3-2.3-1.4-4.3-3.3-5.6z"/></g><circle cx="8.5" cy="9" r="3.8"/><path d="M1 21c0-4 3.3-6.8 7.5-6.8S16 17 16 21z"/></svg>';
    const badges = (ref) => (ref === mineRef ? `<span class="vbadge mine" title="Your default view: opens when you load the dashboard">${icon(ICON.star, 'i star')}${svgUser}</span>` : '')
      + (ref === teamRef ? `<span class="vbadge team" title="Team default view: opens for everyone who hasn't picked their own${mineRef !== null && ref !== mineRef ? ' (you picked another)' : ''}">${icon(ICON.star, 'i star')}${svgUsers}</span>` : '');
    const item = (ref, name, title) => `<button type="button" class="vm-item${ref === cur ? ' sel' : ''}" data-ref="${esc(ref)}" role="option" aria-selected="${ref === cur}">
        <span class="vm-name" title="${esc(title)}">${esc(name)}</span>${badges(ref)}</button>`;
    $('#viewMenu').innerHTML = item('', 'Default View', 'The standard layout')
      + (personal.length ? '<div class="vm-head">My views</div>' + personal.map((v) => item(viewRef(v), v.name, 'Only you can see this view')).join('') : '')
      + (team.length ? '<div class="vm-head">Team views</div>' + team.map((v) => item(viewRef(v), v.name, `Team view, updated by ${v.updatedBy || 'unknown'}`)).join('') : '');
    $('#viewBtnName').textContent = cur ? findView(cur).name : 'Default View';
    $('#viewBtnBadges').innerHTML = badges(cur);
    const del = canWriteView(findView(S.viewRef));
    $('#viewDelete').disabled = !del;
    $('#viewDelete').style.opacity = del ? 1 : .4;
    $('#viewDelete').title = del ? 'Delete view' : S.viewRef ? 'Only power users and admins can delete team views' : 'Delete view';
    const dbtn = $('#viewDefault');
    dbtn.classList.toggle('active', def !== null && def === (findView(S.viewRef) ? S.viewRef : ''));
    dbtn.hidden = !personalDefaultsOk() && !can('teamViews');
    updateViewDirty();
  }

  // ---- default view: which view opens first ----
  const personalDefaultsOk = () => S.me?.kind === 'session' || Boolean(S.me?.user?.id);
  /** The view to open on page load: '' = built-in layout, a view ref, or null = reopen as last left. */
  function effectiveDefault() {
    const { mine, team } = S.viewDefaults;
    if (mine === 'builtin') return '';
    if (mine && findView(mine)) return mine;
    if (team && findView(team)) return team;
    return null;
  }
  function openDefaultView() {
    const mineOk = personalDefaultsOk();
    const teamOk = can('teamViews');
    const { personal, team } = S.views;
    const cur = findView(S.viewRef) ? S.viewRef : '';
    const curName = cur ? findView(cur).name : 'Default View';
    const teamView = S.viewDefaults.team && findView(S.viewDefaults.team);
    const opts = (list, sel) => list.map((v) => `<option value="${viewRef(v)}" ${viewRef(v) === sel ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
    const mineSel = S.viewDefaults.mine && (S.viewDefaults.mine === 'builtin' || findView(S.viewDefaults.mine)) ? S.viewDefaults.mine : '';
    const teamSel = teamView ? S.viewDefaults.team : '';
    modal({
      title: 'Default view',
      body: `<p>Choose the view that opens when you load the dashboard. You're looking at <b>${esc(curName)}</b>.</p>
        ${mineOk ? `<label>My default (follows you to any browser)<select class="select" id="dvMine">
          <option value="">${teamView ? `Same as the team: ${esc(teamView.name)}` : 'None: reopen the way I left it in this browser'}</option>
          <option value="builtin" ${mineSel === 'builtin' ? 'selected' : ''}>Default View</option>
          ${personal.length ? `<optgroup label="My views">${opts(personal, mineSel)}</optgroup>` : ''}
          ${team.length ? `<optgroup label="Team views">${opts(team, mineSel)}</optgroup>` : ''}
        </select></label>` : ''}
        ${teamOk ? `<label>Team default (everyone who hasn't picked their own)<select class="select" id="dvTeam">
          <option value="">None: each person reopens the way they left it</option>
          ${opts(team, teamSel)}
        </select></label>
        ${team.length ? '' : '<p style="font-size:12px">Save a team view first to make it the team default.</p>'}` : ''}
        <p style="font-size:12px">The default opens each time the page loads; you can still switch views while you work.</p>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => {
        const body = {};
        if (mineOk) body.mine = $('#dvMine').value || null;
        if (teamOk) body.team = $('#dvTeam').value || null;
        try {
          const r = await apiJson('/api/views/defaults', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          S.viewDefaults = r.defaults;
          renderViewSelect();
          toast('Default view saved');
        } catch (e) { toast(e.message, 'error'); return false; }
      } }],
    });
  }

  function applyNamedView(ref) {
    S.viewRef = ref;
    const saved = findView(ref);
    S.view = normView(saved ? saved.state : {});
    S.collapsed.clear();
    syncControls();
    saveState();
    renderViewSelect();
    scheduleRender(true);
  }
  async function loadViews() {
    try {
      const r = await apiJson('/api/views');
      S.views = { personal: r.personal || [], team: r.team || [] };
      S.viewDefaults = r.defaults || { mine: null, team: null };
      S.viewsLoaded = true;
    } catch { /* keep what we have */ }
    renderViewSelect();
  }
  // One-time move of views saved in this browser (older versions) to the account.
  async function migrateLocalViews() {
    let legacy;
    try { legacy = JSON.parse(localStorage.getItem('checkin.views') || 'null'); } catch { legacy = null; }
    if (!legacy || typeof legacy !== 'object' || S.me?.kind !== 'session') return;
    const oldName = store.get('viewName', '');
    let moved = 0;
    for (const [name, state] of Object.entries(legacy)) {
      const n = name.toLowerCase() === 'default' ? 'My default' : name;
      if (S.views.personal.some((v) => v.name.toLowerCase() === n.toLowerCase())) continue;
      try {
        const r = await apiJson('/api/views', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'personal', name: n, state }) });
        S.views.personal.push(r.view);
        if (name === oldName) S.viewRef = viewRef(r.view);
        moved++;
      } catch { /* skip invalid entries */ }
    }
    try { localStorage.removeItem('checkin.views'); localStorage.removeItem('checkin.viewName'); } catch { /* ignore */ }
    S.views.personal.sort((a, b) => collator.compare(a.name, b.name));
    saveState();
    renderViewSelect();
    if (moved) toast(`Moved ${moved} saved view${moved === 1 ? '' : 's'} from this browser to your account`);
  }
  function openSaveView() {
    const cur = findView(S.viewRef);
    const teamOk = can('teamViews');
    const personalOk = S.me?.kind === 'session' || Boolean(S.me?.user?.id);
    let scope = cur && canWriteView(cur) ? cur.scope : (personalOk ? 'personal' : 'team');
    let confirmReplace = null;
    modal({
      title: 'Save view',
      body: `<p>Saves the current filters, search, sorting, grouping, layout and columns.</p>
        <label>View name<input class="input" id="viewName" maxlength="80" value="${esc(cur ? cur.name : '')}" placeholder="e.g. Stale devices"></label>
        <div class="scope-label">Save to</div>
        <div class="scope-pick" id="viewScope">
          <button type="button" data-scope="personal" ${personalOk ? '' : 'disabled'}><b>My views</b><small>Only you can see it</small></button>
          <button type="button" data-scope="team" ${teamOk ? '' : 'disabled title="Requires the Power user role"'}><b>Team views</b><small>${teamOk ? 'Everyone can see it' : 'Power users and admins only'}</small></button>
        </div>
        <div class="pop-error" id="viewErr" hidden></div>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', id: 'viewSaveBtn', onClick: async () => {
        const name = $('#viewName').value.trim();
        const err = $('#viewErr');
        const fail = (m) => { err.textContent = m; err.hidden = false; return false; };
        if (!name) return fail('Enter a name for the view.');
        if (name.toLowerCase() === 'default') return fail('“Default” is reserved. Pick another name.');
        const clash = S.views[scope].find((v) => v.name.toLowerCase() === name.toLowerCase());
        if (clash && clash !== cur && confirmReplace !== clash) {
          confirmReplace = clash;
          $('#viewSaveBtn').textContent = 'Replace';
          return fail(`${scope === 'team' ? 'A team view' : 'One of your views'} is already called “${clash.name}”. Click Replace to overwrite it.`);
        }
        try {
          const r = await apiJson('/api/views', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope, name, state: S.view }) });
          const list = S.views[scope].filter((v) => v.id !== r.view.id);
          list.push(r.view);
          list.sort((a, b) => collator.compare(a.name, b.name));
          S.views[scope] = list;
          S.viewRef = viewRef(r.view);
          saveState();
          renderViewSelect();
          toast(scope === 'team' ? `Saved team view “${r.view.name}” for everyone` : `Saved view “${r.view.name}”`);
        } catch (e) { return fail(e.message); }
      } }],
    });
    const paint = () => $$('#viewScope button').forEach((b) => b.classList.toggle('active', b.dataset.scope === scope));
    paint();
    $('#viewScope').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-scope]');
      if (!b || b.disabled) return;
      scope = b.dataset.scope; confirmReplace = null;
      $('#viewSaveBtn').textContent = 'Save'; $('#viewErr').hidden = true;
      paint();
    });
    $('#viewName').addEventListener('input', () => { confirmReplace = null; $('#viewSaveBtn').textContent = 'Save'; $('#viewErr').hidden = true; });
    $('#viewName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#viewSaveBtn').click(); });
  }
  function deleteCurrentView() {
    const v = findView(S.viewRef);
    if (!canWriteView(v)) return;
    modal({
      title: v.scope === 'team' ? 'Delete team view?' : 'Delete view?',
      body: `<p>Delete <b>${esc(v.name)}</b>?${v.scope === 'team' ? ' It will be removed for everyone.' : ''} Your current filters stay as they are.</p>`,
      actions: [{ label: 'Cancel' }, { label: 'Delete', cls: 'danger', onClick: async () => {
        try {
          await apiJson(`/api/views/${v.id}`, { method: 'DELETE' });
          S.views[v.scope] = S.views[v.scope].filter((x) => x.id !== v.id);
          S.viewRef = '';
          saveState();
          renderViewSelect();
          toast(`Deleted view “${v.name}”`);
        } catch (e) { toast(e.message, 'error'); return false; }
      } }],
    });
  }
  function syncControls() {
    $('#search').value = S.view.search;
    $('#timeRange').value = String(S.view.time);
  }

  // ------------------------------------------------------------------ permissions & account
  function can(cap) { return Boolean(S.me?.caps?.[cap]); }

  function initials(u) {
    const src = (u.name || u.username || '?').trim();
    const parts = src.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
    return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
  }

  function applyCaps() {
    const u = S.me.user;
    $('#importBtn').hidden = !can('import');
    $('#exportBtn').parentElement.hidden = !can('export');
    $('#clearBtn').hidden = !can('clearAll');
    $('#liveToggle').hidden = !can('pause');
    $('#dDelete').hidden = !can('delete');
    $('#adminItem').hidden = !can('users');
    $('#agentsItem').hidden = !can('checkin');
    $('#boxesItem').hidden = !can('boxes');
    $('#pwItem').hidden = S.me.kind !== 'session';
    $('#selDelete').hidden = !can('delete');
    $('#selExport').hidden = !can('export');
    $('#mPause').hidden = !can('pause');
    $('#mImport').hidden = !can('import');
    $('#mExportView').hidden = !can('export');
    $('#mExportAll').hidden = !can('export');
    $('#mClear').hidden = !can('clearAll');
    for (const el of [$('#userAvatar'), $('#userAvatar2')]) el.textContent = initials(u);
    $('#userName').textContent = u.name || u.username;
    $('#userName2').textContent = u.name || u.username;
    $('#userRole').textContent = S.me.roleLabel;
    $('#userSub').innerHTML = `<span>${esc(u.email || u.username)}</span><span class="role-badge r-${esc(S.me.role)}">${esc(S.me.roleLabel)}</span>`;
    $('#liveStatus').style.cursor = can('pause') ? 'pointer' : 'default';
    scheduleRender(true);
  }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    location.href = '/login';
  }

  function changePassword() {
    const hasPw = S.me.user.hasPassword;
    modal({
      title: hasPw ? 'Change password' : 'Set a password',
      body: `${hasPw ? '' : '<p>You sign in with single sign-on. Setting a password also lets you use HTTP Basic auth for scripts.</p>'}
        ${hasPw ? '<label>Current password<input class="input" id="pwCur" type="password" autocomplete="current-password"></label>' : ''}
        <label>New password<input class="input" id="pwNew" type="password" autocomplete="new-password"></label>
        <label>Confirm new password<input class="input" id="pwNew2" type="password" autocomplete="new-password"></label>
        <p style="font-size:12px">At least 10 characters. Your other sessions will be signed out.</p>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => {
        const next = $('#pwNew').value;
        if (next !== $('#pwNew2').value) { toast('Passwords do not match', 'error'); return false; }
        try {
          await apiJson('/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ current: $('#pwCur')?.value || '', next }) });
          S.me.user.hasPassword = true;
          toast('Password updated');
        } catch (e) { toast(e.message, 'error'); return false; }
      } }],
    });
  }

  // ------------------------------------------------------------------ multi-select
  function toggleChecked(id, shift) {
    const on = !S.checked.has(id);
    if (shift && S.lastChecked !== null) {
      const ids = S.filtered.map((r) => r.id);
      const a = ids.indexOf(S.lastChecked);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) { if (on) S.checked.add(ids[i]); else S.checked.delete(ids[i]); }
      }
    }
    if (on) S.checked.add(id); else S.checked.delete(id);
    S.lastChecked = id;
    updateSelBar();
    scheduleRender();
  }

  function setAllFiltered(on) {
    for (const r of S.filtered) { if (on) S.checked.add(r.id); else S.checked.delete(r.id); }
    updateSelBar();
    scheduleRender();
  }

  function clearChecked() {
    S.checked.clear();
    S.lastChecked = null;
    updateSelBar();
    scheduleRender();
  }

  function updateSelBar() {
    const n = S.checked.size;
    $('#selbar').classList.toggle('show', n > 0);
    $('#selCount').textContent = `${nf.format(n)} selected`;
    let inView = 0;
    for (const r of S.filtered) if (S.checked.has(r.id)) inView++;
    const remaining = S.filtered.length - inView;
    $('#selAll').hidden = remaining <= 0;
    $('#selAll').textContent = `Select all ${nf.format(S.filtered.length)} matching`;
    syncHeaderCheckbox();
  }

  function confirmDeleteChecked() {
    const ids = [...S.checked];
    if (!ids.length || !can('delete')) return;
    const preview = ids.slice(0, 6).map((id) => `<code>${esc(id)}</code>`).join(' ');
    modal({
      title: `Delete ${nf.format(ids.length)} record${ids.length === 1 ? '' : 's'}?`,
      body: `<div class="warn-box">The selected records and <b>all of their history</b> will be permanently deleted.</div>
        <p style="line-height:1.9">${preview}${ids.length > 6 ? ` <span class="muted">and ${nf.format(ids.length - 6)} more</span>` : ''}</p>`,
      actions: [{ label: 'Cancel' }, { label: `Delete ${nf.format(ids.length)}`, cls: 'danger solid', onClick: async () => {
        let deleted = 0;
        try {
          for (let i = 0; i < ids.length; i += 50000) {
            const r = await apiJson('/api/records/delete', { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ids: ids.slice(i, i + 50000) }) });
            deleted += r.deleted;
          }
          clearChecked();
          toast(`Deleted ${nf.format(deleted)} record${deleted === 1 ? '' : 's'}`);
        } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
      } }],
    });
  }

  function exportChecked() {
    const order = new Map(S.filtered.map((r, i) => [r.id, i]));
    const rows = [...S.checked].map((id) => S.records.get(id)).filter(Boolean)
      .sort((a, b) => (order.get(a.id) ?? 1e12) - (order.get(b.id) ?? 1e12));
    exportRows(rows, 'checkins-selected');
  }

  // ------------------------------------------------------------------ export / import
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  function csvCell(v) {
    let s = show(v);
    if (/^[=+\-@\t\r]/.test(s) && !isNumeric(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function exportRows(rows, name) {
    const cols = visibleColumns().filter((c) => c !== STATUS_KEY);
    const lines = [cols.map(csvCell).join(',')];
    for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(','));
    download(new Blob(['\ufeff' + lines.join('\r\n') + '\r\n'], { type: 'text/csv' }), `${name}-${stamp()}.csv`);
    toast(`Exported ${nf.format(rows.length)} rows`);
  }
  function exportView() { exportRows(S.filtered, 'checkins-view'); }

  async function exportServer(path, name) {
    try {
      const res = await api(path);
      download(await res.blob(), `${name}-${stamp()}.csv`);
    } catch (e) { toast('Export failed: ' + e.message, 'error'); }
  }
  async function importCsv(file) {
    toast(`Uploading ${file.name}…`);
    try {
      const res = await api('/api/import', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: file });
      const r = await res.json();
      if (r.failed) {
        modal({
          title: 'Import finished with errors',
          body: `<p>${nf.format(r.imported)} rows imported (${nf.format(r.created)} created, ${nf.format(r.updated)} updated). ${nf.format(r.failed)} rows failed:</p>
            <div class="err-list">${r.errors.map((e) => `Row ${e.row}: ${esc(e.error)}`).join('<br>')}</div>`,
          actions: [{ label: 'OK', cls: 'primary' }],
        });
      } else toast(`Imported ${nf.format(r.imported)} rows · ${nf.format(r.created)} created · ${nf.format(r.updated)} updated`);
    } catch (e) { toast('Import failed: ' + e.message, 'error'); }
  }

  function confirmClearAll() {
    const total = S.records.size;
    modal({
      title: 'Clear all records?',
      body: `<div class="warn-box">This permanently deletes <b>all ${nf.format(total)} records and their entire history</b>. It cannot be undone.</div>
        <p>Consider exporting first. Type <b>CLEAR</b> to confirm.</p>
        <label>Confirmation<input class="input" id="clearConfirm" autocomplete="off" placeholder="CLEAR"></label>`,
      actions: [
        { label: 'Cancel' },
        { label: 'Delete everything', cls: 'danger solid', id: 'clearGo', onClick: async () => {
          if ($('#clearConfirm').value.trim() !== 'CLEAR') return false;
          try {
            const r = await apiJson('/api/records?confirm=true', { method: 'DELETE' });
            toast(`Cleared ${nf.format(r.deleted.records)} records and ${nf.format(r.deleted.history)} history entries`);
          } catch (e) { toast('Clear failed: ' + e.message, 'error'); }
        } },
      ],
    });
    const go = $('#clearGo');
    go.disabled = true;
    $('#clearConfirm').addEventListener('input', (e) => { go.disabled = e.target.value.trim() !== 'CLEAR'; });
    $('#clearConfirm').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !go.disabled) go.click(); });
  }

  function openSettings() {
    const canThreshold = can('threshold');
    modal({
      title: 'Settings',
      body: `<div class="row">
          <label>Active threshold (minutes)<input class="input" id="setStale" type="number" min="1" value="${S.settings.staleMinutes}" ${canThreshold ? '' : 'disabled title="Requires the Power user role"'}></label>
          <label>Theme<select class="select" id="setTheme">
            ${['auto', 'light', 'dark'].map((t) => `<option ${S.settings.theme === t ? 'selected' : ''} value="${t}">${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select></label>
        </div>
        <p style="font-size:12px">Records are <b>active</b> within the threshold, <b>aging</b> up to 2×, and <b>stale</b> after that.
        ${canThreshold ? 'The threshold applies to everyone.' : 'Only power users and admins can change the threshold.'}</p>
        <p style="font-size:12px">Server keeps <b>${S.config.historyLimit < 0 ? 'unlimited' : S.config.historyLimit}</b> history entries per record (HISTORY_LIMIT).</p>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => {
        S.settings.theme = $('#setTheme').value;
        store.set('settings', { theme: S.settings.theme, compact: S.settings.compact });
        applyTheme();
        const m = Math.max(1, Number($('#setStale').value) || 15);
        if (canThreshold && m !== S.settings.staleMinutes) {
          try {
            const r = await apiJson('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ staleMinutes: m }) });
            S.settings.staleMinutes = r.staleMinutes;
            toast('Active threshold updated for everyone');
          } catch (e) { toast(e.message, 'error'); return false; }
        }
        scheduleRender(true);
      } }],
    });
  }

  function applyTheme() {
    const t = S.settings.theme;
    const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.body.classList.toggle('compact', !!S.settings.compact);
    $('#densityBtn').classList.toggle('active', !!S.settings.compact);
  }

  // ------------------------------------------------------------------ filter popover
  let editIndex = null; // index of the filter being edited, or null when adding
  function fieldOptions() { return [STATUS_KEY, 'id', ...S.fields, 'modified', 'created']; }

  function openFilterPop(field, index = null) {
    closeMenus();
    editIndex = index;
    const existing = index !== null ? S.view.filters[index] : null;
    const fsel = $('#fField');
    const opts = fieldOptions();
    if (existing && existing.field !== '*' && !opts.includes(existing.field)) opts.push(existing.field);
    fsel.innerHTML = '<option value="*">Any field</option>' + opts.map((f) => `<option value="${esc(f)}">${esc(colLabel(f))}</option>`).join('');
    fsel.value = existing ? existing.field : (field && opts.includes(field) ? field : '*');
    $('#fTitle').textContent = existing ? 'Edit filter' : 'Add filter';
    $('#fAdd').textContent = existing ? 'Update filter' : 'Add filter';
    renderOps(existing?.op);
    renderValue(existing?.value);
    $('#filterPop').classList.add('open');
    setTimeout(() => $('#fValueBox input, #fValueBox select')?.focus(), 20);
  }

  function currentKind() { const f = $('#fField').value; return f === '*' ? 'text' : fieldKind(f); }

  function renderOps(preferred) {
    const kind = currentKind();
    const ops = Object.entries(OPS).filter(([, o]) => o.kinds.includes(kind));
    $('#fOp').innerHTML = ops.map(([k, o]) => `<option value="${k}">${esc(o.label)}</option>`).join('');
    $('#fOp').value = preferred && OPS[preferred]?.kinds.includes(kind) ? preferred : DEFAULT_OP[kind];
  }

  function renderValue(preset) {
    const field = $('#fField').value;
    const kind = currentKind();
    const op = OPS[$('#fOp').value];
    const box = $('#fValueBox');
    $('#fError').hidden = true;
    $('#fValueWrap').hidden = Boolean(op?.noValue);
    let facets = '';
    if (kind === 'status') {
      const val = preset || 'fresh';
      box.innerHTML = `<select class="select" id="fStatus">${['fresh', 'aging', 'stale'].map((k) => `<option value="${k}" ${k === val ? 'selected' : ''}>${cap(statusLabel(k))} (${nf.format(S.counts[k] || 0)})</option>`).join('')}</select>`;
      facets = ['fresh', 'aging', 'stale'].map((k) => `<button class="facet" data-op="eq" data-value="${k}"><i class="dot ${k}"></i> ${statusLabel(k)}<span>${nf.format(S.counts[k] || 0)}</span></button>`).join('');
    } else if (op?.value === 'duration') {
      const d = parseDuration(preset) || { n: 15, unit: 'm' };
      box.innerHTML = `<div class="fv-row"><input class="input" id="fNum" type="number" min="1" step="1" value="${d.n}">
        <select class="select" id="fUnit">${Object.entries(UNITS).map(([u, [l]]) => `<option value="${u}" ${u === d.unit ? 'selected' : ''}>${l}s</option>`).join('')}</select>
        ${op.suffix ? `<span class="muted">${op.suffix}</span>` : ''}</div>`;
    } else if (op?.value === 'datetime') {
      const pad = (n) => String(n).padStart(2, '0');
      const d = new Date();
      const def = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      box.innerHTML = `<input class="input" id="fDateTime" type="datetime-local" value="${esc(preset || def)}">`;
    } else if (op?.value === 'date') {
      const d = new Date();
      const def = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      box.innerHTML = `<input class="input" id="fDate" type="date" value="${esc(preset || def)}">`;
    } else {
      box.innerHTML = `<input class="input" id="fValue" list="fValues" autocomplete="off" value="${esc(preset ?? '')}" placeholder="${op?.label === 'matches regex' ? 'e.g. ^(Dallas|Austin)$' : ''}"><datalist id="fValues"></datalist>`;
      if (field !== '*') {
        const counts = new Map();
        for (const r of S.records.values()) {
          const v = show(r[field]);
          if (v === '') continue;
          counts.set(v, (counts.get(v) || 0) + 1);
          if (counts.size > 2000) break;
        }
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
        $('#fValues').innerHTML = top.map(([v]) => `<option value="${esc(v)}">`).join('');
        if (top.length && counts.size > 1) {
          facets = top.map(([v, n]) => `<button class="facet" data-op="eq" data-value="${esc(v)}" title="${esc(v)}">${esc(v.length > 30 ? v.slice(0, 30) + '…' : v)}<span>${n}</span></button>`).join('');
        }
      }
    }
    if (kind === 'date') {
      const presets = [['within', '15m', 'Last 15 min'], ['within', '1h', 'Last hour'], ['within', '24h', 'Last 24 hours'], ['within', '7d', 'Last 7 days'], ['older', '1h', 'Over an hour ago'], ['older', '1d', 'Over a day ago']];
      facets = presets.map(([o, v, l]) => `<button class="facet" data-op="${o}" data-value="${v}">${l}</button>`).join('');
    }
    $('#fFacets').innerHTML = facets;
    box.querySelectorAll('input').forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitFilter(); }));
  }

  /** Read the value control. Returns the value string, or throws an Error with a message for the user. */
  function readValue() {
    const op = OPS[$('#fOp').value];
    if (!op) throw new Error('Choose a condition');
    if (op.noValue) return '';
    if (currentKind() === 'status') return $('#fStatus').value;
    if (op.value === 'duration') {
      const n = Number($('#fNum').value);
      if (!(n > 0)) throw new Error('Enter a number greater than 0');
      return `${n}${$('#fUnit').value}`;
    }
    if (op.value === 'datetime') {
      const v = $('#fDateTime').value;
      if (!v || !Number.isFinite(new Date(v).getTime())) throw new Error('Pick a date and time');
      return v;
    }
    if (op.value === 'date') {
      const v = $('#fDate').value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('Pick a date');
      return v;
    }
    const v = $('#fValue').value;
    if (v === '') throw new Error('Enter a value');
    if ($('#fOp').value === 'regex') { try { new RegExp(v, 'i'); } catch (e) { throw new Error('Invalid regex: ' + e.message); } }
    return v;
  }

  function saveFilter(f) {
    const filters = S.view.filters.slice();
    if (editIndex !== null && filters[editIndex]) filters[editIndex] = f; else filters.push(f);
    editIndex = null;
    setView({ filters });
    closeMenus();
  }

  function submitFilter() {
    try {
      saveFilter({ field: $('#fField').value, op: $('#fOp').value, value: readValue() });
    } catch (e) {
      $('#fError').textContent = e.message;
      $('#fError').hidden = false;
    }
  }

  // ------------------------------------------------------------------ columns popover
  function renderColumnList() {
    const q = $('#colSearch').value.trim().toLowerCase();
    const hidden = new Set(S.view.hidden);
    $('#colList').innerHTML = orderedColumns().filter((c) => c !== 'id' && (!q || colLabel(c).toLowerCase().includes(q))).map((c) => `
      <div class="col-item" draggable="true" data-col="${esc(c)}">${icon(ICON.grip, 'i grip')}
        <input type="checkbox" ${hidden.has(c) ? '' : 'checked'} data-col="${esc(c)}">
        <span class="name">${esc(colLabel(c))}</span><span class="cnt">${SYS.includes(c) || c === STATUS_KEY ? '' : nf.format(S.fieldCounts.get(c) || 0)}</span></div>`).join('');
  }
  function moveColumn(from, to, before = true) {
    if (from === to || from === 'id' || to === 'id') return;
    const order = orderedColumns().filter((c) => c !== 'id' && c !== from);
    let idx = order.indexOf(to);
    if (!before) idx++;
    order.splice(idx, 0, from);
    setView({ order }, false);
    scheduleRender(true);
  }

  function closeMenus() { $$('.menu.open').forEach((m) => m.classList.remove('open')); }

  // ------------------------------------------------------------------ events
  function bind() {
    $('#search').addEventListener('input', debounce((e) => setView({ search: e.target.value }), 120));
    $('#timeRange').addEventListener('change', (e) => setView({ time: Number(e.target.value) }));
    $('#groupBy').addEventListener('change', (e) => { S.collapsed.clear(); setView({ groupBy: e.target.value }); });
    $$('#layoutSeg button').forEach((b) => b.addEventListener('click', () => {
      setView({ layout: b.dataset.layout });
      if (b.dataset.layout === 'activity') loadActivity();
    }));
    $('#densityBtn').addEventListener('click', () => { S.settings.compact = !S.settings.compact; store.set('settings', S.settings); applyTheme(); scheduleRender(); });
    $('#themeBtn').addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme;
      S.settings.theme = cur === 'dark' ? 'light' : 'dark';
      store.set('settings', S.settings);
      applyTheme();
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
    $('#liveToggle').addEventListener('click', togglePause);
    $('#pauseResume').addEventListener('click', () => setIngestPaused(false));
    $('#liveStatus').addEventListener('click', () => { if (can('pause')) $('#liveToggle').click(); });

    // account menu
    $('#userBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      const open = $('#userMenu').classList.contains('open');
      closeMenus();
      if (!open) {
        $('#mPause span').textContent = S.ingest.paused ? 'Resume check-ins' : 'Pause check-ins';
        $('#userMenu').classList.add('open');
      }
    });
    $('#empty').addEventListener('click', (e) => { if (e.target.closest('[data-open-agents]')) window.CheckinAgents?.open(); });
    $('#userMenu').addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      closeMenus();
      if (act === 'logout') logout();
      if (act === 'settings') openSettings();
      if (act === 'boxes') openBoxEditor();
      if (act === 'password') changePassword();
      if (act === 'admin') window.CheckinAdmin?.open('users');
      if (act === 'agents') window.CheckinAgents?.open();
      // Phone-only shortcuts for the header buttons hidden on small screens
      if (act === 'm-pause') togglePause();
      if (act === 'm-import') $('#importFile').click();
      if (act === 'm-export-view') exportView();
      if (act === 'm-export-all') exportServer('/api/export.csv', 'checkins');
      if (act === 'm-theme') $('#themeBtn').click();
      if (act === 'm-clear') $('#clearBtn').click();
    });

    // selection bar
    $('#selAll').addEventListener('click', () => setAllFiltered(true));
    $('#selClear').addEventListener('click', clearChecked);
    $('#selDelete').addEventListener('click', confirmDeleteChecked);
    $('#selExport').addEventListener('click', exportChecked);
    $('#thead').addEventListener('click', (e) => {
      if (!e.target.closest('.th.cbcell')) return;
      e.stopPropagation();
      let n = 0;
      for (const r of S.filtered) if (S.checked.has(r.id)) n++;
      setAllFiltered(!(n > 0 && n === S.filtered.length));
    }, true);

    $$('.stat[data-status]').forEach((el) => el.addEventListener('click', () => {
      const s = el.dataset.status;
      setView({ status: S.view.status === s ? 'all' : s });
    }));
    $('#boxes').addEventListener('click', (e) => {
      if (e.target.closest('#boxEdit')) { openBoxEditor(); return; }
      const id = e.target.closest('[data-box]')?.dataset.box;
      if (id) setView({ box: S.view.box === id ? '' : id });
    });

    $('#chips').addEventListener('click', (e) => {
      const m = e.target.closest('[data-match]')?.dataset.match;
      if (m) { if (m !== S.view.match) setView({ match: m }); return; }
      const rm = e.target.closest('[data-rm]')?.dataset.rm;
      const edit = e.target.closest('[data-edit]')?.dataset.edit;
      if (!rm && edit !== undefined) { e.stopPropagation(); openFilterPop(null, Number(edit)); return; }
      if (!rm) return;
      if (rm === 'all') { setView({ filters: [], match: 'all', status: 'all', search: '', time: 0, box: '' }); syncControls(); }
      else if (rm === 'status') setView({ status: 'all' });
      else if (rm === 'box') setView({ box: '' });
      else setView({ filters: S.view.filters.filter((_, i) => 'f' + i !== rm) });
    });

    // menus
    const toggle = (btn, menu, onOpen) => $(btn).addEventListener('click', (e) => {
      e.stopPropagation();
      const open = $(menu).classList.contains('open');
      closeMenus();
      if (!open) { $(menu).classList.add('open'); onOpen && onOpen(); }
    });
    toggle('#exportBtn', '#exportMenu');
    toggle('#columnsBtn', '#columnsPop', () => { $('#colSearch').value = ''; renderColumnList(); });
    $('#filterBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      if ($('#filterPop').classList.contains('open')) closeMenus(); else openFilterPop();
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });

    $('#exportMenu').addEventListener('click', (e) => {
      const k = e.target.closest('[data-export]')?.dataset.export;
      if (!k) return;
      closeMenus();
      if (k === 'view') exportView();
      if (k === 'all') exportServer('/api/export.csv', 'checkins');
      if (k === 'history') exportServer('/api/history/export.csv', 'checkin-history');
    });
    $('#importBtn').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) importCsv(f);
      e.target.value = '';
    });
    // drag & drop CSV anywhere
    document.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
    document.addEventListener('drop', (e) => {
      if (!can('import')) return;
      const f = e.dataTransfer?.files?.[0];
      if (f) { e.preventDefault(); if (/\.csv$/i.test(f.name) || f.type.includes('csv')) importCsv(f); else toast('Drop a .csv file to import', 'error'); }
    });
    $('#clearBtn').addEventListener('click', confirmClearAll);

    // filter popover
    $('#fField').addEventListener('change', () => { renderOps(); renderValue(); });
    $('#fOp').addEventListener('change', () => {
      // Keep what was typed when switching between conditions of the same value type.
      const prev = $('#fValue')?.value;
      renderValue(OPS[$('#fOp').value]?.value ? undefined : prev);
    });
    $('#fAdd').addEventListener('click', submitFilter);
    $('#fCancel').addEventListener('click', () => { editIndex = null; closeMenus(); });
    $('#fFacets').addEventListener('click', (e) => {
      const b = e.target.closest('.facet');
      if (!b) return;
      saveFilter({ field: $('#fField').value, op: b.dataset.op, value: b.dataset.value });
    });

    // columns popover
    $('#colSearch').addEventListener('input', renderColumnList);
    $('#colList').addEventListener('change', (e) => {
      const c = e.target.dataset.col;
      const hidden = new Set(S.view.hidden);
      if (e.target.checked) hidden.delete(c); else hidden.add(c);
      setView({ hidden: [...hidden] });
    });
    $('#colAll').addEventListener('click', () => { setView({ hidden: [] }); renderColumnList(); });
    $('#colNone').addEventListener('click', () => { setView({ hidden: orderedColumns().filter((c) => c !== 'id') }); renderColumnList(); });
    $('#colReset').addEventListener('click', () => { setView({ hidden: [], order: [], widths: {} }); renderColumnList(); });
    let dragCol = null;
    $('#colList').addEventListener('dragstart', (e) => { dragCol = e.target.closest('.col-item')?.dataset.col; e.dataTransfer.effectAllowed = 'move'; });
    $('#colList').addEventListener('dragover', (e) => {
      const it = e.target.closest('.col-item');
      if (!it || !dragCol) return;
      e.preventDefault();
      $$('.col-item.drag-over').forEach((x) => x.classList.remove('drag-over'));
      it.classList.add('drag-over');
    });
    $('#colList').addEventListener('drop', (e) => {
      const it = e.target.closest('.col-item');
      if (it && dragCol) { e.preventDefault(); moveColumn(dragCol, it.dataset.col); renderColumnList(); }
      dragCol = null;
    });

    // table header: sort, filter, resize, reorder
    const thead = $('#thead');
    thead.addEventListener('click', (e) => {
      if (e.target.closest('.rz')) return;
      const fb = e.target.closest('[data-filter]');
      if (fb) { e.stopPropagation(); openFilterPop(fb.dataset.filter); return; }
      const th = e.target.closest('.th[data-col]');
      if (!th) return;
      const key = th.dataset.col;
      let sort = S.view.sort.slice();
      const i = sort.findIndex((s) => s.key === key);
      if (e.shiftKey) {
        if (i < 0) sort.push({ key, dir: 'asc' });
        else if (sort[i].dir === 'asc') sort[i] = { key, dir: 'desc' };
        else sort.splice(i, 1);
      } else {
        const cur = i >= 0 ? sort[i].dir : null;
        sort = cur === null ? [{ key, dir: key === 'modified' || key === 'created' ? 'desc' : 'asc' }]
          : cur === (key === 'modified' || key === 'created' ? 'desc' : 'asc') ? [{ key, dir: cur === 'asc' ? 'desc' : 'asc' }] : [];
      }
      setView({ sort });
    });
    let resizing = null;
    thead.addEventListener('pointerdown', (e) => {
      const rz = e.target.closest('.rz');
      if (!rz) return;
      e.preventDefault();
      e.stopPropagation();
      rz.classList.add('active');
      resizing = { col: rz.dataset.rz, x: e.clientX, w: colWidth(rz.dataset.rz), el: rz };
      rz.setPointerCapture(e.pointerId);
    });
    thead.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      const w = Math.max(60, Math.min(900, resizing.w + e.clientX - resizing.x));
      S.view.widths = { ...S.view.widths, [resizing.col]: w };
      renderHeaderWidthsOnly();
    });
    thead.addEventListener('pointerup', () => {
      if (!resizing) return;
      resizing.el.classList.remove('active');
      resizing = null;
      saveState();
      scheduleRender(true);
    });
    thead.addEventListener('dblclick', (e) => {
      const rz = e.target.closest('.rz');
      if (!rz) return;
      const w = { ...S.view.widths };
      delete w[rz.dataset.rz];
      setView({ widths: w });
    });
    let dragTh = null;
    thead.addEventListener('dragstart', (e) => {
      const th = e.target.closest('.th[data-col]');
      if (!th || resizing) { e.preventDefault(); return; }
      dragTh = th.dataset.col;
      th.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    thead.addEventListener('dragover', (e) => {
      const th = e.target.closest('.th[data-col]');
      if (!th || !dragTh || th.dataset.col === 'id') return;
      e.preventDefault();
      $$('.th.drag-over').forEach((x) => x.classList.remove('drag-over'));
      th.classList.add('drag-over');
    });
    thead.addEventListener('drop', (e) => {
      const th = e.target.closest('.th[data-col]');
      if (th && dragTh) { e.preventDefault(); moveColumn(dragTh, th.dataset.col); }
    });
    thead.addEventListener('dragend', () => { dragTh = null; $$('.th.dragging, .th.drag-over').forEach((x) => x.classList.remove('dragging', 'drag-over')); });

    // body interactions
    $('#tableWrap').addEventListener('scroll', () => scheduleRender(), { passive: true });
    $('#cardsWrap').addEventListener('scroll', () => scheduleRender(), { passive: true });
    window.addEventListener('resize', () => scheduleRender());
    window.addEventListener('resize', debounce(() => { if (drawerData && drawerTab === 'graph') renderDrawer(); }, 150));
    $('#tbody').addEventListener('click', (e) => {
      const g = e.target.closest('.gr');
      if (g) {
        const k = g.dataset.group;
        if (S.collapsed.has(k)) S.collapsed.delete(k); else S.collapsed.add(k);
        scheduleRender(true);
        return;
      }
      const tr = e.target.closest('.tr');
      if (!tr) return;
      if (e.target.closest('.cbcell')) { e.preventDefault(); toggleChecked(tr.dataset.id, e.shiftKey); return; }
      openDrawer(tr.dataset.id);
    });
    $('#cards').addEventListener('click', (e) => {
      const c = e.target.closest('.card');
      if (!c) return;
      if (e.target.closest('.card-cb')) { e.preventDefault(); toggleChecked(c.dataset.id, e.shiftKey); return; }
      openDrawer(c.dataset.id);
    });
    $('#activity').addEventListener('click', (e) => {
      if (e.target.id === 'moreActivity') { loadMoreActivity(); return; }
      const a = e.target.closest('.act');
      if (a) openDrawer(a.dataset.id);
    });

    // drawer
    $('#dClose').addEventListener('click', closeDrawer);
    $('#scrim').addEventListener('click', closeDrawer);
    $$('.tab').forEach((t) => t.addEventListener('click', () => { drawerTab = t.dataset.tab; if (drawerData) renderDrawer(); }));
    $('#dCopy').addEventListener('click', async () => {
      const rec = drawerData?.record;
      if (!rec) return;
      const clean = Object.fromEntries(Object.entries(rec).filter(([k]) => k[0] !== '_'));
      try { await navigator.clipboard.writeText(JSON.stringify(clean, null, 2)); toast('Copied JSON'); } catch { toast('Clipboard unavailable', 'error'); }
    });
    $('#dDelete').addEventListener('click', () => {
      const id = S.selected;
      modal({
        title: 'Delete record?',
        body: `<p>Delete <b>${esc(id)}</b> and all of its history? This cannot be undone.</p>`,
        actions: [{ label: 'Cancel' }, { label: 'Delete', cls: 'danger solid', onClick: async () => {
          try { await api('/api/records/' + encodeURIComponent(id), { method: 'DELETE' }); toast('Deleted ' + id); closeDrawer(); } catch (e) { toast(e.message, 'error'); }
        } }],
      });
    });

    // views
    toggle('#viewBtn', '#viewMenu');
    $('#viewMenu').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ref]');
      if (!b) return;
      closeMenus();
      applyNamedView(b.dataset.ref);
    });
    $('#viewSave').addEventListener('click', openSaveView);
    $('#viewDelete').addEventListener('click', deleteCurrentView);
    $('#viewDefault').addEventListener('click', openDefaultView);

    // keyboard
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('#modalBack').hidden) closeModal();
        else if (!$('#adminBack').hidden) window.CheckinAdmin?.close();
        else if ($('.menu.open')) closeMenus();
        else if (S.selected) closeDrawer();
        else if (S.checked.size) clearChecked();
      }
      const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'checkbox';
      if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && S.checked.size && $('#modalBack').hidden && $('#adminBack').hidden) {
        e.preventDefault();
        confirmDeleteChecked();
      }
      if (e.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); $('#search').focus(); }
    });
    $('#modalBack').addEventListener('click', (e) => { if (e.target.id === 'modalBack') closeModal(); });

    // keep relative times and fresh/aging/stale buckets current
    setInterval(() => {
      scheduleRender(true, true);
      if (S.selected && drawerData) renderDrawer();
      if (S.ingest.paused) updateLive();
    }, 10_000);
  }

  function renderHeaderWidthsOnly() {
    const cols = renderCols();
    const tpl = gridTemplate(cols);
    const w = totalWidth(cols) + 'px';
    $('#thead').style.gridTemplateColumns = tpl;
    $('#thead').style.width = w;
    $('#tbody').style.width = w;
    $$('#tbody .tr').forEach((r) => { r.style.gridTemplateColumns = tpl; });
  }

  // ------------------------------------------------------------------ init
  async function init() {
    applyTheme();
    bind();
    syncControls();
    renderViewSelect();
    updateLive();
    try {
      S.me = await apiJson('/api/auth/me');
    } catch { return; }
    try { S.config = await apiJson('/api/config'); } catch { /* ignore */ }
    try { S.settings.staleMinutes = (await apiJson('/api/settings')).staleMinutes; } catch { /* ignore */ }
    applyCaps();
    // Saved views first, so a default view can open before the records arrive.
    await loadViews();
    const startRef = effectiveDefault();
    if (startRef !== null && S.viewsLoaded) applyNamedView(startRef);
    migrateLocalViews();
    loadBoxes();
    await loadIngest();
    connect();
    try { await loadAll(); } catch (e) { if (e.message !== 'API key required') toast('Could not load records: ' + e.message, 'error'); }
    if (S.view.layout === 'activity') loadActivity();
  }
  window.CheckinUI = { api, apiJson, modal, closeModal, toast, esc, nf, relTime, absTime, initials, state: S, can };
  init();
})();
