/* Issues page: problems the server found on devices, who's on them, notes and history. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const local = {
    get(k, d) { try { const v = localStorage.getItem('checkin.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('checkin.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const nf = new Intl.NumberFormat();
  const SEV = { critical: 'Critical', warning: 'Warning', info: 'Info' };
  const OPS = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: 'is', neq: 'is not', contains: 'contains', ncontains: 'does not contain', empty: 'is empty', nempty: 'is not empty' };
  const NO_VALUE = new Set(['empty', 'nempty']);
  const KINDS = { field: 'A field matches a condition', skew: 'Clock is off', stale: 'No check-in' };
  const IGNORE_PRESETS = [[15, '15 minutes'], [60, '1 hour'], [240, '4 hours'], [1440, '1 day'], [4320, '3 days'], [10080, '1 week']];
  const PRESETS = [
    { key: 'cpu', label: 'High CPU', rule: { name: 'High CPU', kind: 'field', field: 'cpu_pct', op: 'gt', value: '90', count: 5, severity: 'critical', clear: { mode: 'custom', field: 'cpu_pct', op: 'lt', value: '80', count: 2 } } },
    { key: 'ram', label: 'High memory', rule: { name: 'High memory', kind: 'field', field: 'ram_pct', op: 'gt', value: '90', count: 5, severity: 'warning', clear: { mode: 'custom', field: 'ram_pct', op: 'lt', value: '85', count: 2 } } },
    { key: 'disk', label: 'Low disk space', rule: { name: 'Low disk space', kind: 'field', field: 'disk_max_pct', op: 'gte', value: '90', count: 2, severity: 'warning', clear: { mode: 'auto', count: 2 } } },
    { key: 'skew', label: 'Clock skew', rule: { name: 'Clock skew', kind: 'skew', field: 'system_time', value: '5', count: 3, severity: 'warning', clear: { mode: 'auto', count: 2 } } },
    { key: 'offline', label: 'Offline', rule: { name: 'Offline', kind: 'stale', value: '30', severity: 'critical', clear: { mode: 'auto', count: 1 } } },
    { key: 'services', label: 'Failed services', rule: { name: 'Failed services', kind: 'field', field: 'failed_services', op: 'gt', value: '0', count: 3, severity: 'warning', clear: { mode: 'auto', count: 2 } } },
    { key: 'rdp', label: 'RDP closed', rule: { name: 'RDP closed', kind: 'field', field: 'port_3389', op: 'eq', value: 'closed', count: 2, severity: 'critical', clear: { mode: 'custom', field: 'port_3389', op: 'eq', value: 'open', count: 1 } } },
    { key: 'ssh', label: 'SSH closed', rule: { name: 'SSH closed', kind: 'field', field: 'port_22', op: 'eq', value: 'closed', count: 2, severity: 'critical', clear: { mode: 'custom', field: 'port_22', op: 'eq', value: 'open', count: 1 } } },
    { key: 'custom', label: 'Custom', rule: { name: '', kind: 'field', field: '', op: 'gt', value: '', count: 5, severity: 'warning', clear: { mode: 'auto', count: 2 } } },
  ];
  const ICON = {
    user: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    snooze: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M5 3L2 6M19 3l3 3"/></svg>',
    check: '<svg class="i" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    wake: '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    trash: '<svg class="i" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    plus: '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    up: '<svg class="i" viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
    down: '<svg class="i" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    ext: '<svg class="i" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  };

  const S = {
    me: null, cfg: null, users: null, fields: [],
    status: local.get('issues.status', 'active'), q: '', assignee: local.get('issues.assignee', ''),
    issues: [], total: 0, summary: {}, limit: 200,
    openId: null, detail: null, connected: false,
  };
  const can = (cap) => Boolean(S.me?.caps?.[cap]);

  // ------------------------------------------------------------ basics
  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.body !== undefined && typeof opts.body !== 'string') { headers['content-type'] = 'application/json'; opts = { ...opts, body: JSON.stringify(opts.body) }; }
    if ((opts.method || 'GET') !== 'GET' && S.me?.csrf) headers['x-csrf-token'] = S.me.csrf;
    const res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
    if (res.status === 401) { location.href = '/login?returnTo=' + encodeURIComponent(location.pathname + location.search); throw new Error('Signed out'); }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status });
    return data;
  }
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
      if (a.disabled) b.disabled = true;
      b.onclick = async () => {
        if (a.onClick) { b.disabled = true; const keep = await a.onClick(); b.disabled = false; if (keep === false) return; }
        closeModal();
      };
      box.appendChild(b);
    }
    $('#modalBack').hidden = false;
    const first = $('#mBody input:not([type=checkbox]), #mBody textarea');
    if (first) setTimeout(() => first.focus(), 30);
  }
  const closeModal = () => { $('#modalBack').hidden = true; };
  function relTime(iso, now = Date.now()) {
    const t = Date.parse(iso);
    if (!t) return '';
    const s = Math.round((now - t) / 1000);
    const fut = s < 0;
    const a = Math.abs(s);
    const v = a < 45 ? 'just now' : a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
    return v === 'just now' ? v : fut ? `in ${v}` : `${v} ago`;
  }
  const absTime = (iso) => (iso ? new Date(iso).toLocaleString() : '');
  // Log lines carry UTC timestamps (exports stay exact); show them in local time here.
  const localTimes = (text) => esc(text).replace(/\b(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\b/g, (m) => esc(new Date(m).toLocaleString()));
  function duration(from, to) {
    const m = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 60000));
    if (m < 60) return `${m}m`;
    if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
    return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  }
  const initials = (n) => String(n || '?').split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';
  const statusTag = (i) => (i.allClear ? `<span class="tag ok" title="Every problem cleared${i.clearedAt ? ' ' + esc(absTime(i.clearedAt)) : ''}; waiting for someone to close it">All clear</span>${i.status === 'ignored' ? '<span class="tag warn">Ignored</span>' : ''}`
    : i.status === 'open' ? '<span class="tag off">Open</span>'
    : i.status === 'ignored' ? `<span class="tag warn" title="Ignored until ${esc(absTime(i.ignoredUntil))}">Ignored ${esc(relTime(i.ignoredUntil).replace('in ', ''))}</span>`
      : '<span class="tag ok">Closed</span>');

  function applyTheme() {
    const t = local.get('settings', {}).theme || 'auto';
    const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }

  // ------------------------------------------------------------ loading
  async function init() {
    applyTheme();
    try { S.me = await api('/api/auth/me'); } catch { return; }
    window.CheckinUserMenu?.mount($('#userMenuSlot'), { me: S.me, modal, toast, page: 'issues', onTheme: () => $('#themeBtn').click() });
    if (!can('issues')) return showOff('Your role can\'t see issues.');
    try { S.cfg = await api('/api/issues/config'); } catch (e) { return showOff(esc(e.message)); }
    bind();
    connect();
    if (!S.cfg.enabled) return showOff();
    await start();
  }

  async function start() {
    $('#offBox').hidden = true;
    for (const id of ['#stats', '#toolbar', '#main']) $(id).hidden = false;
    $('#rulesBtn').hidden = !can('issueRules');
    $('#clearBtn').hidden = !can('issueRules');
    $('#exportWrap').hidden = !can('export');
    if (can('issueWork')) { try { S.users = (await api('/api/issues/assignees')).users; } catch { S.users = []; } }
    renderAssigneeFilter();
    syncControls();
    await loadList();
    const id = Number(new URLSearchParams(location.search).get('id'));
    if (id) openIssue(id);
    if (!S.cfg.rules.length && can('issueRules')) toast('No issue rules yet: click "Issue rules" to define what an issue is');
  }

  function showOff(msg) {
    for (const id of ['#stats', '#toolbar', '#main']) $(id).hidden = true;
    $('#rulesBtn').hidden = true; $('#clearBtn').hidden = true; $('#exportWrap').hidden = true;
    const box = $('#offBox');
    box.hidden = false;
    box.innerHTML = msg || `<b>The issues list is turned off.</b> ${can('issuesEnable')
      ? 'Turn it on to start tracking problems on your devices. You can also do this in <b>Admin → Issues</b>.<div style="margin-top:10px"><button class="btn primary" id="turnOn">Turn on issues</button></div>'
      : 'An admin can turn it on in Admin → Issues.'}`;
    $('#turnOn')?.addEventListener('click', async () => {
      try { await api('/api/admin/issues', { method: 'PUT', body: { enabled: true } }); S.cfg = await api('/api/issues/config'); toast('Issues turned on'); start(); } catch (e) { toast(e.message, 'error'); }
    });
  }

  function query(extra = {}) {
    const p = new URLSearchParams();
    p.set('status', S.status);
    if (S.q) p.set('q', S.q);
    if (S.assignee) p.set('assignee', S.assignee);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p.toString();
  }

  let loading = null;
  async function loadList() {
    const mine = (loading = Symbol('load'));
    try {
      const r = await api('/api/issues?' + query({ limit: S.limit }));
      if (mine !== loading) return;
      S.issues = r.issues; S.total = r.total; S.summary = r.summary;
      renderList();
      renderStats();
    } catch (e) {
      if (e.status === 409) { S.cfg.enabled = false; showOff(); return; }
      toast('Could not load issues: ' + e.message, 'error');
    }
  }

  let reloadTimer = null;
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (!S.cfg?.enabled) return;
      loadList();
      if (S.openId) refreshDetail();
    }, 300);
  }

  function connect() {
    const es = new EventSource('/api/events');
    const live = (on) => {
      S.connected = on;
      $('#liveStatus').className = 'live ' + (on ? 'on' : 'off');
      $('#liveText').textContent = on ? 'Live' : 'Reconnecting…';
    };
    es.addEventListener('hello', () => { live(true); scheduleReload(); });
    es.addEventListener('issues', async () => {
      try {
        const was = S.cfg.enabled;
        S.cfg = await api('/api/issues/config');
        if (!was && S.cfg.enabled) { start(); return; }
        if (was && !S.cfg.enabled) { showOff(); closeDrawer(); return; }
      } catch { /* ignore */ }
      scheduleReload();
    });
    es.onerror = () => live(false);
    // Times in the list ("5m ago") keep moving.
    setInterval(() => { if (S.cfg?.enabled && S.issues.length) renderList(); }, 60_000);
  }

  // ------------------------------------------------------------ list
  function renderStats() {
    const s = S.summary;
    $('#sOpen').textContent = nf.format(s.open || 0);
    $('#sUnassigned').textContent = nf.format(s.unassigned || 0);
    $('#sMine').textContent = nf.format(s.mine || 0);
    $('#sIgnored').textContent = nf.format(s.ignored || 0);
    $('#sClosed').textContent = nf.format(s.closed || 0);
    const which = S.assignee === 'none' && S.status === 'active' ? 'unassigned' : S.assignee === 'me' && S.status === 'active' ? 'mine'
      : !S.assignee && ['open', 'ignored', 'closed', 'allclear'].includes(S.status) ? S.status : '';
    // "All clear" only exists while automatic closing is off (or until those issues are closed).
    const showAll = S.cfg.autoClose === false || (s.allClear || 0) > 0;
    $('#sAllClear').closest('.stat').hidden = !showAll;
    $('#sAllClear').textContent = nf.format(s.allClear || 0);
    $('#statusSeg [data-status="allclear"]').hidden = !showAll;
    if (!showAll && S.status === 'allclear') { S.status = 'active'; syncControls(); }
    $$('#stats .stat').forEach((b) => b.classList.toggle('active', b.dataset.q === which));
    $('#sMine').closest('.stat').hidden = !S.me.user?.id;
  }

  function renderAssigneeFilter() {
    const opts = [['', 'Anyone'], ['me', 'Assigned to me'], ['none', 'Unassigned'], ...(S.users || []).map((u) => [String(u.id), u.name])];
    if (S.assignee && !opts.some(([v]) => v === S.assignee)) S.assignee = '';
    $('#assigneeFilter').innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}" ${v === S.assignee ? 'selected' : ''}>${esc(l)}</option>`).join('');
  }

  function syncControls() {
    $$('#statusSeg button').forEach((b) => b.classList.toggle('active', b.dataset.status === S.status));
    $('#assigneeFilter').value = S.assignee;
  }

  function problemChips(i, max = 4) {
    const active = i.problems.filter((p) => !p.clearedAt);
    const cleared = i.problems.filter((p) => p.clearedAt);
    const done = i.status === 'closed' || i.allClear;
    const show = (done ? i.problems : active).slice(0, max);
    const names = new Set();
    const chips = show.filter((p) => !names.has(p.name) && names.add(p.name))
      .map((p) => `<span class="iss-chip ${esc(p.severity)}${p.clearedAt ? ' done' : ''}">${esc(p.name)}</span>`).join('');
    const more = (done ? i.problems.length : active.length) - show.length;
    const gone = !done && cleared.length ? `<span class="muted iss-cleared">+${cleared.length} cleared</span>` : '';
    return chips + (more > 0 ? `<span class="muted">+${more}</span>` : '') + gone;
  }

  function renderList() {
    const list = $('#list');
    $('#countText').textContent = S.total ? `${nf.format(S.issues.length)}${S.total > S.issues.length ? ` of ${nf.format(S.total)}` : ''} issue${S.total === 1 ? '' : 's'}` : '';
    $('#moreWrap').hidden = S.issues.length >= S.total;
    if (!S.issues.length) {
      const filtered = S.q || S.assignee || S.status !== 'active';
      list.innerHTML = `<div class="iss-empty">${filtered
        ? '<div class="big">No issues match</div>Try another filter or search.'
        : S.cfg.rules.some((r) => r.enabled)
          ? '<div class="big">No open issues</div>Every device is within its rules. New issues appear here live.'
          : `<div class="big">No issue rules yet</div>${can('issueRules') ? 'Click <b>Issue rules</b> to say what counts as a problem (high CPU, clock skew, offline…).' : 'A power user or admin needs to set up the issue rules.'}`}</div>`;
      return;
    }
    list.innerHTML = `<div class="iss-row iss-head"><span></span><span>Issue</span><span>Device</span><span>Problems</span><span>Status</span><span>Assigned to</span><span>Opened</span><span>Duration</span></div>`
      + S.issues.map((i) => `<button class="iss-row${i.id === S.openId ? ' sel' : ''}" data-id="${i.id}">
        <span class="iss-sev ${esc(i.severity)}" title="${esc(SEV[i.severity])}"></span>
        <span class="iss-id">#${i.id}</span>
        <span class="iss-dev" title="${esc(i.recordId)}">${esc(i.recordId)}</span>
        <span class="iss-probs">${problemChips(i)}</span>
        <span class="iss-st">${statusTag(i)}</span>
        <span class="iss-who">${i.assignedName ? `<span class="avatar xs">${esc(initials(i.assignedName))}</span><span>${esc(i.assignedName)}</span>` : '<span class="muted">Unassigned</span>'}</span>
        <span class="iss-time" title="${esc(absTime(i.openedAt))}">${esc(relTime(i.openedAt))}</span>
        <span class="iss-dur" title="${i.closedAt ? 'Closed ' + esc(absTime(i.closedAt)) : 'Still open'}">${esc(duration(i.openedAt, i.closedAt))}</span>
      </button>`).join('');
  }

  // ------------------------------------------------------------ detail drawer
  async function openIssue(id) {
    S.openId = id;
    history.replaceState(null, '', '?id=' + id);
    $$('#list .iss-row').forEach((r) => r.classList.toggle('sel', Number(r.dataset.id) === id));
    $('#drawer').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    $('#scrim').classList.add('open');
    $('#dTitle').textContent = '#' + id;
    $('#dSub').textContent = '';
    $('#dActions').innerHTML = '';
    $('#dBody').innerHTML = '<div class="muted">Loading…</div>';
    await refreshDetail();
  }
  async function refreshDetail() {
    const id = S.openId;
    try {
      const d = await api('/api/issues/' + id);
      if (S.openId !== id) return;
      S.detail = d;
      renderDetail();
    } catch (e) {
      if (S.openId !== id) return;
      $('#dBody').innerHTML = `<div class="warn-box">${e.status === 404 ? 'This issue no longer exists: the issues list was cleared.' : esc(e.message)}</div>`;
      $('#dActions').innerHTML = '';
    }
  }
  function closeDrawer() {
    S.openId = null; S.detail = null;
    history.replaceState(null, '', location.pathname);
    $('#drawer').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    $('#scrim').classList.remove('open');
    $$('#list .iss-row.sel').forEach((r) => r.classList.remove('sel'));
  }

  function renderDetail() {
    const d = S.detail;
    const work = can('issueWork');
    const open = d.status !== 'closed';
    $('#dEyebrow').innerHTML = `Issue #${d.id} · <span class="iss-sevtxt ${esc(d.severity)}">${esc(SEV[d.severity])}</span>`;
    $('#dTitle').textContent = d.title;
    $('#dSub').innerHTML = `${statusTag(d)} <a href="/?record=${encodeURIComponent(d.recordId)}" class="iss-devlink" title="Open this device on the dashboard">${esc(d.recordId)} ${ICON.ext}</a>`;
    $('#dActions').innerHTML = work ? `
      <button class="btn sm" data-act="assign">${ICON.user}${d.assignedName ? 'Reassign' : 'Assign'}</button>
      ${open ? (d.status === 'ignored' ? `<button class="btn sm" data-act="unignore">${ICON.wake}Stop ignoring</button>` : `<button class="btn sm" data-act="ignore">${ICON.snooze}Ignore…</button>`) : ''}
      ${open ? `<button class="btn sm" data-act="close">${ICON.check}Close issue</button>` : ''}` : '';
    const problems = d.problems.map((p) => `<div class="iss-prob${p.clearedAt ? ' done' : ''}">
        <div class="iss-prob-head"><span class="iss-chip ${esc(p.severity)}${p.clearedAt ? ' done' : ''}">${esc(p.name)}</span>
          <span class="muted">${esc(p.rule)}</span>
          <span class="iss-prob-state">${p.clearedAt ? `<span class="tag">${p.clearedHow === 'cleared' ? 'Cleared' : p.clearedHow === 'closed' ? 'Closed by hand' : p.clearedHow === 'rule' ? 'Rule removed' : 'Device deleted'}</span>` : '<span class="tag off">Active</span>'}</span></div>
        <div class="iss-prob-times">
          <span>Started <b title="${esc(absTime(p.startedAt))}">${esc(absTime(p.startedAt))}</b>${p.startValue ? ` · <code>${esc(p.startValue)}</code>` : ''}</span>
          ${p.clearedAt ? `<span>Ended <b>${esc(absTime(p.clearedAt))}</b> after ${esc(duration(p.startedAt, p.clearedAt))}${p.clearValue ? ` · <code>${esc(p.clearValue)}</code>` : ''}</span>` : `<span>Ongoing for ${esc(duration(p.startedAt))}</span>`}
        </div></div>`).join('');
    const notes = d.events.filter((e) => e.type === 'note');
    const log = d.events.filter((e) => e.type !== 'note');
    const mayDelete = (n) => work && (can('issueRules') || (n.userId && n.userId === S.me.user?.id));
    const snap = d.snapshot ? Object.entries(d.snapshot).filter(([k]) => !k.startsWith('_')) : [];
    const watched = new Set(d.problems.map((p) => p.rule.split(' ')[0]));
    $('#dBody').innerHTML = `
      <table class="kv iss-kv">
        <tr><td>Opened</td><td>${esc(absTime(d.openedAt))} <span class="muted">(${esc(relTime(d.openedAt))})</span></td></tr>
        <tr><td>${d.closedAt ? 'Closed' : 'Open for'}</td><td>${d.closedAt ? `${esc(absTime(d.closedAt))} <span class="muted">after ${esc(duration(d.openedAt, d.closedAt))} · ${d.closedBy ? 'by ' + esc(d.closedBy) : 'automatically'}${d.closeReason ? ': ' + esc(d.closeReason) : ''}</span>` : esc(duration(d.openedAt))}</td></tr>
        <tr><td>Assigned to</td><td>${d.assignedName ? esc(d.assignedName) : '<span class="muted">Nobody</span>'}</td></tr>
        ${d.status === 'ignored' ? `<tr><td>Ignored</td><td>until ${esc(absTime(d.ignoredUntil))} <span class="muted">by ${esc(d.ignoredBy || '')}</span></td></tr>` : ''}
        ${d.allClear ? `<tr><td>All clear</td><td>since ${esc(absTime(d.clearedAt))} <span class="muted">· every problem cleared; close it when you're happy</span></td></tr>` : ''}
        <tr><td>Device now</td><td>${d.current ? `last check-in ${esc(relTime(d.current.modified))}` : '<span class="muted">record deleted</span>'}</td></tr>
      </table>
      <h4 class="iss-h">Problems <span class="badge">${d.problems.length}</span></h4>
      <div class="iss-probs-list">${problems || '<p class="muted">None</p>'}</div>
      <h4 class="iss-h">Notes <span class="badge">${notes.length}</span></h4>
      ${work ? `<div class="iss-note-new"><textarea class="input" id="noteText" rows="2" maxlength="4000" placeholder="Add a note: what you found, what you did…"></textarea><button class="btn sm primary" id="noteAdd">Add note</button></div>` : ''}
      <div class="iss-notes">${notes.length ? notes.slice().reverse().map((n) => `<div class="iss-note" data-note="${n.id}">
          <div class="iss-note-head"><span class="avatar xs">${esc(initials(n.userName))}</span><b>${esc(n.userName || 'unknown')}</b><span class="muted" title="${esc(absTime(n.at))}">${esc(relTime(n.at))}</span>
          ${mayDelete(n) ? `<button class="icon-btn sm danger" data-del-note="${n.id}" title="Delete note">${ICON.trash}</button>` : ''}</div>
          <div class="iss-note-text">${esc(n.text)}</div></div>`).join('') : '<p class="muted" style="margin:0">No notes yet.</p>'}</div>
      <h4 class="iss-h">Log <span class="badge">${log.length}</span></h4>
      <ol class="iss-log">${log.slice().reverse().map((e) => `<li class="ev-${esc(e.type)}"><span class="iss-log-time" title="${esc(absTime(e.at))}">${esc(new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</span><span>${localTimes(e.text)}</span></li>`).join('')}</ol>
      ${snap.length ? `<details class="iss-snap"><summary>Device fields when the issue opened <span class="muted">(${snap.length})</span></summary>
        <table class="kv">${snap.sort(([a], [b]) => (watched.has(b) - watched.has(a)) || a.localeCompare(b)).map(([k, v]) => {
          const now = d.current?.[k];
          const changed = d.current && k !== 'modified' && k !== '_version' && JSON.stringify(now) !== JSON.stringify(v);
          return `<tr${watched.has(k) ? ' class="hl"' : ''}><td>${esc(k)}</td><td><pre>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</pre>${changed ? `<small class="muted">now: ${esc(now === undefined ? '(gone)' : typeof now === 'object' ? JSON.stringify(now) : now)}</small>` : ''}</td></tr>`;
        }).join('')}</table></details>` : ''}`;
    $('#noteAdd')?.addEventListener('click', addNote);
    $('#noteText')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addNote(); });
  }

  async function act(path, body, msg) {
    try {
      S.detail = await api(`/api/issues/${S.openId}${path}`, { method: path === '/assign' ? 'PUT' : 'POST', body });
      renderDetail();
      if (msg) toast(msg);
      scheduleReload();
      return true;
    } catch (e) { toast(e.message, 'error'); return false; }
  }

  async function addNote() {
    const t = $('#noteText').value.trim();
    if (!t) { $('#noteText').focus(); return; }
    const kept = $('#noteText').value;
    if (!(await act('/notes', { text: t }, 'Note added'))) $('#noteText').value = kept;
  }

  function assignDialog() {
    const d = S.detail;
    const people = S.users || [];
    const row = (u) => `<button class="iss-person${u.id === d.assignedTo ? ' cur' : ''}" data-uid="${u.id}"><span class="avatar xs">${esc(initials(u.name))}</span><span><b>${esc(u.name)}</b><small>${esc(u.username)}${u.id === S.me.user?.id ? ' · you' : ''}</small></span>${u.id === d.assignedTo ? '<span class="tag">current</span>' : ''}</button>`;
    modal({
      title: `Assign issue #${d.id}`,
      body: `<label class="search iss-psearch"><svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="pSearch" placeholder="Search people by name or username" autocomplete="off"></label>
        <div class="iss-people" id="pList"></div>`,
      actions: [
        ...(d.assignedTo ? [{ label: 'Unassign', cls: 'danger', onClick: () => act('/assign', { assignee: null }, 'Unassigned') }] : []),
        ...(S.me.user?.id && S.me.user.id !== d.assignedTo ? [{ label: 'Assign to me', onClick: () => act('/assign', { assignee: S.me.user.id }, 'Assigned to you') }] : []),
        { label: 'Cancel' },
      ],
    });
    const draw = () => {
      const q = $('#pSearch').value.trim().toLowerCase();
      const hits = people.filter((u) => !q || u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q));
      $('#pList').innerHTML = hits.length ? hits.slice(0, 100).map(row).join('') : '<p class="muted" style="padding:8px">Nobody matches.</p>';
    };
    draw();
    $('#pSearch').addEventListener('input', draw);
    $('#pSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pList .iss-person')?.click(); });
    $('#pList').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-uid]');
      if (!b) return;
      const u = people.find((x) => x.id === Number(b.dataset.uid));
      if (await act('/assign', { assignee: u.id }, `Assigned to ${u.name}`)) closeModal();
    });
  }

  function ignoreDialog() {
    const d = S.detail;
    modal({
      title: `Ignore issue #${d.id}`,
      body: `<p>Hides it from the Open list for a while. It stays on the device's record and keeps tracking problems: if they all clear it closes, and a <b>new kind of problem</b> on this device brings it back to Open straight away.</p>
        <div class="iss-ign">${IGNORE_PRESETS.map(([m, l], i) => `<label class="radio-card"><input type="radio" name="ign" value="${m}" ${i === 1 ? 'checked' : ''}><span><b>${l}</b></span></label>`).join('')}
          <label class="radio-card"><input type="radio" name="ign" value="custom"><span><b>Custom</b><span class="iss-ign-custom"><input class="input" type="number" id="ignN" min="1" value="2"><select class="select" id="ignU"><option value="60">hours</option><option value="1440">days</option><option value="1">minutes</option></select></span></span></label></div>`,
      actions: [{ label: 'Cancel' }, { label: 'Ignore', cls: 'primary', onClick: async () => {
        const v = $('input[name=ign]:checked').value;
        const minutes = v === 'custom' ? Math.round(Number($('#ignN').value) * Number($('#ignU').value)) : Number(v);
        return (await act('/ignore', { minutes }, 'Ignored')) ? undefined : false;
      } }],
    });
    $('#ignN').addEventListener('focus', () => { $('input[name=ign][value=custom]').checked = true; });
  }

  function closeDialog() {
    const d = S.detail;
    const active = d.problems.filter((p) => !p.clearedAt);
    modal({
      title: `Close issue #${d.id}?`,
      body: `<p>${active.length ? `Still active: <b>${esc(active.map((p) => p.name).join(', '))}</b>. Closing it by hand means these won't open a new issue until they stop and then happen again.` : 'It will be marked closed.'}</p>
        <label>Reason <small class="muted">(optional, saved in the log)</small><input class="input" id="closeReason" maxlength="500" placeholder="e.g. Fixed: restarted the service"></label>`,
      actions: [{ label: 'Cancel' }, { label: 'Close issue', cls: 'primary', onClick: async () => ((await act('/close', { reason: $('#closeReason').value }, 'Issue closed')) ? undefined : false) }],
    });
    $('#closeReason').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#mActions .primary').click(); });
  }

  // ------------------------------------------------------------ rules (power users and admins)
  async function rulesDialog() {
    try { S.cfg = await api('/api/issues/config'); } catch (e) { toast(e.message, 'error'); return; }
    try { S.fields = (await api('/api/fields')).fields.map((f) => f.name); } catch { S.fields = []; }
    const draft = S.cfg.rules.map((r) => JSON.parse(JSON.stringify(r)));
    const opSel = (k, v) => `<select class="select" data-k="${k}">${Object.entries(OPS).map(([o, l]) => `<option value="${o}" ${o === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    const num = (k, v, min = 0) => `<input class="input" type="number" min="${min}" step="1" data-k="${k}" value="${esc(v)}">`;
    const row = (r, i) => {
      const c = r.clear || { mode: 'auto', count: 2 };
      let trig = '';
      let clear = '';
      if (r.kind === 'stale') {
        trig = `<label class="ir-w">No check-in for<span class="bx-unit">${num('value', r.value, 1)}min</span></label>`;
        clear = `<label class="ir-w ir-wide">Clears when it checks in again, after<span class="bx-unit">${num('clear.count', c.count ?? 1, 1)}check-ins in a row</span></label>`;
      } else if (r.kind === 'skew') {
        trig = `<label class="ir-f">Date/time field<input class="input" data-k="field" list="irFields" value="${esc(r.field || 'system_time')}"></label>
          <label class="ir-w">Off by more than<span class="bx-unit">${num('value', r.value, 0)}min</span></label>
          <label class="ir-w">Fails after<span class="bx-unit">${num('count', r.count ?? 5, 1)}in a row</span></label>`;
        clear = `<label class="ir-mode">Clears when<select class="select" data-k="clear.mode"><option value="auto" ${c.mode !== 'custom' ? 'selected' : ''}>it's back within the limit</option><option value="custom" ${c.mode === 'custom' ? 'selected' : ''}>it's within…</option></select></label>
          ${c.mode === 'custom' ? `<label class="ir-w">Within<span class="bx-unit">${num('clear.value', c.value)}min</span></label>` : ''}
          <label class="ir-w">Clears after<span class="bx-unit">${num('clear.count', c.count ?? 2, 1)}in a row</span></label>`;
      } else {
        trig = `<label class="ir-f">Field<input class="input" data-k="field" list="irFields" value="${esc(r.field)}" placeholder="e.g. cpu_pct" autocomplete="off"></label>
          <label class="ir-op">Condition${opSel('op', r.op)}</label>
          <label class="ir-v">Value<input class="input" data-k="value" value="${esc(r.value)}" ${NO_VALUE.has(r.op) ? 'disabled' : ''}></label>
          <label class="ir-w">Fails after<span class="bx-unit">${num('count', r.count ?? 5, 1)}in a row</span></label>`;
        clear = `<label class="ir-mode">Clears when<select class="select" data-k="clear.mode"><option value="auto" ${c.mode !== 'custom' ? 'selected' : ''}>the condition is no longer true</option><option value="custom" ${c.mode === 'custom' ? 'selected' : ''}>another condition is true…</option></select></label>
          ${c.mode === 'custom' ? `<label class="ir-f">Field<input class="input" data-k="clear.field" list="irFields" value="${esc(c.field || r.field)}"></label>
            <label class="ir-op">Condition${opSel('clear.op', c.op || 'lt')}</label>
            <label class="ir-v">Value<input class="input" data-k="clear.value" value="${esc(c.value || '')}" ${NO_VALUE.has(c.op) ? 'disabled' : ''}></label>` : ''}
          <label class="ir-w">Clears after<span class="bx-unit">${num('clear.count', c.count ?? 2, 1)}in a row</span></label>`;
      }
      return `<div class="bx ir${r.enabled === false ? ' off' : ''}" data-i="${i}">
        <div class="bx-row">
          <label class="bx-name">Name<input class="input" data-k="name" maxlength="60" value="${esc(r.name)}" placeholder="e.g. High CPU"></label>
          <label class="ir-kind">Type<select class="select" data-k="kind">${Object.entries(KINDS).map(([k, l]) => `<option value="${k}" ${r.kind === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label class="bx-tone">Severity<select class="select" data-k="severity">${Object.entries(SEV).map(([k, l]) => `<option value="${k}" ${r.severity === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <div class="bx-tools">
            <label class="switch" title="Rule is on"><input type="checkbox" data-k="enabled" ${r.enabled !== false ? 'checked' : ''}><span class="track"></span></label>
            <button class="icon-btn sm" data-move="-1" title="Move up" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
            <button class="icon-btn sm" data-move="1" title="Move down" ${i === draft.length - 1 ? 'disabled' : ''}>${ICON.down}</button>
            <button class="icon-btn sm danger" data-del title="Delete rule">${ICON.trash}</button>
          </div>
        </div>
        <div class="ir-sec"><span class="ir-lbl">Opens</span><div class="bx-row">${trig}</div></div>
        <div class="ir-sec"><span class="ir-lbl">Clears</span><div class="bx-row">${clear}</div></div>
      </div>`;
    };
    const draw = () => {
      $('#irList').innerHTML = draft.length ? draft.map(row).join('') : '<div class="bx-empty muted">No rules yet. Start with a preset below.</div>';
    };
    modal({
      title: 'Issue rules',
      wide: true,
      body: `<p style="font-size:13px">Every check-in tests every rule. A rule <b>fails</b> after that many failing check-ins in a row and opens an issue for the device;
          problems that start while it's open are added to it (one issue per device). A problem <b>clears</b> after that many passing check-ins in a row,
          and ${S.cfg.autoClose === false ? 'when none are left the issue is marked <b>All clear</b> and waits for someone to close it (automatic closing is off in Admin → Issues)' : 'the issue closes itself when none are left'}. A passing check-in resets the fail count, and a failing one resets the clear count.</p>
        <div class="callout iss-reassign"><b>Same person when it comes back</b>
          <span class="iss-reassign-row">If a device gets a new issue within <span class="bx-unit"><input class="input" type="number" min="0" max="43200" id="irReassign" value="${S.cfg.reassignMinutes}">min</span> of its last issue closing, it goes to whoever had that one. 0 turns this off.</span></div>
        <div id="irList"></div>
        <div class="bx-add"><span class="muted">Add a rule:</span>${PRESETS.map((p) => `<button class="btn sm" data-preset="${p.key}">${ICON.plus}${esc(p.label)}</button>`).join('')}</div>
        <datalist id="irFields">${S.fields.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => {
        try {
          const reassign = Math.max(0, Math.round(Number($('#irReassign').value) || 0));
          if (reassign !== S.cfg.reassignMinutes) await api('/api/issues/settings', { method: 'PUT', body: { reassignMinutes: reassign } });
          const r = await api('/api/issues/rules', { method: 'PUT', body: { rules: draft, version: S.cfg.version } });
          S.cfg = { ...S.cfg, rules: r.rules, version: r.version, reassignMinutes: reassign };
          toast('Issue rules saved');
          scheduleReload();
        } catch (e) { toast(e.message, 'error'); return false; }
      } }],
    });
    draw();
    const list = $('#irList');
    const setPath = (obj, k, v) => { if (k.startsWith('clear.')) { obj.clear = obj.clear || { mode: 'auto', count: 2 }; obj.clear[k.slice(6)] = v; } else obj[k] = v; };
    list.addEventListener('input', (e) => {
      const k = e.target.dataset.k;
      const box = e.target.closest('.ir');
      const r = draft[Number(box?.dataset.i)];
      if (!k || !r) return;
      let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      if (e.target.type === 'number') v = e.target.value === '' ? '' : Number(e.target.value);
      setPath(r, k, v);
      if (k === 'enabled') box.classList.toggle('off', !v);
      if (k === 'op' || k === 'clear.op') { const t = box.querySelector(`[data-k="${k === 'op' ? 'value' : 'clear.value'}"]`); if (t) t.disabled = NO_VALUE.has(v); }
    });
    list.addEventListener('change', (e) => {
      const k = e.target.dataset.k;
      const r = draft[Number(e.target.closest('.ir')?.dataset.i)];
      if (!r) return;
      if (k === 'kind') {
        if (r.kind === 'skew') { r.field = r.field && /time/i.test(r.field) ? r.field : 'system_time'; r.value = r.value && Number(r.value) > 0 ? r.value : 5; }
        if (r.kind === 'stale') { r.value = Number(r.value) >= 1 ? r.value : 30; }
        r.clear = { mode: 'auto', count: r.clear?.count || (r.kind === 'stale' ? 1 : 2) };
        draw();
      }
      if (k === 'clear.mode') {
        if (r.clear.mode === 'custom' && r.kind === 'field') { r.clear.field = r.clear.field || r.field; r.clear.op = r.clear.op || ({ gt: 'lt', gte: 'lt', lt: 'gt', lte: 'gt', eq: 'neq', neq: 'eq' }[r.op] || 'lt'); }
        if (r.clear.mode === 'custom' && r.kind === 'skew') r.clear.value = r.clear.value ?? Math.max(0, Number(r.value) - 1);
        draw();
      }
    });
    list.addEventListener('click', (e) => {
      const i = Number(e.target.closest('.ir')?.dataset.i);
      const mv = e.target.closest('[data-move]');
      if (mv) { const j = i + Number(mv.dataset.move); [draft[i], draft[j]] = [draft[j], draft[i]]; draw(); return; }
      if (e.target.closest('[data-del]')) { draft.splice(i, 1); draw(); }
    });
    $('#mBody .bx-add').addEventListener('click', (e) => {
      const p = PRESETS.find((x) => x.key === e.target.closest('[data-preset]')?.dataset.preset);
      if (!p) return;
      if (draft.length >= 50) { toast('At most 50 rules', 'error'); return; }
      draft.push({ ...JSON.parse(JSON.stringify(p.rule)), enabled: true });
      draw();
      const last = $$('#irList .ir').pop();
      last?.scrollIntoView({ block: 'nearest' });
      last?.querySelector(p.key === 'custom' ? '[data-k="name"]' : '[data-k="value"]')?.focus();
    });
  }

  function clearDialog() {
    const n = (S.summary.total || 0);
    modal({
      title: 'Clear the issues list?',
      body: `<div class="warn-box" style="margin:0 0 12px">This permanently deletes <b>every issue: ${nf.format(n)} in total</b>, open, ignored and closed, together with everything in them:
          their problems, notes, assignments and logs. It can't be undone. Export a CSV first if you might need them.</div>
        <p>Rules and settings are kept. Problems that are still happening open fresh issues right away (without their old assignments).</p>
        <label class="checkline"><input type="checkbox" id="clearOk"> I understand that all ${nf.format(n)} issues and their notes and logs will be deleted</label>`,
      actions: [{ label: 'Cancel' }, { label: 'Delete all issues', cls: 'danger solid', id: 'clearGo', disabled: true, onClick: async () => {
        try {
          const r = await api('/api/issues?confirm=true', { method: 'DELETE' });
          toast(`Deleted ${nf.format(r.deleted)} issue${r.deleted === 1 ? '' : 's'}`);
          closeDrawer();
          scheduleReload();
        } catch (e) { toast(e.message, 'error'); return false; }
      } }],
    });
    $('#clearOk').addEventListener('change', (e) => { $('#clearGo').disabled = !e.target.checked; });
  }

  function exportCsv(kind) {
    const p = kind === 'issues-view' ? query() : 'status=all';
    const a = document.createElement('a');
    a.href = `/api/issues/export.csv?${p}${kind === 'log' ? '&kind=log' : ''}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ------------------------------------------------------------ events
  function bind() {
    $('#statusSeg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-status]');
      if (!b) return;
      S.status = b.dataset.status; local.set('issues.status', S.status);
      syncControls(); loadList();
    });
    let t;
    $('#search').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { S.q = e.target.value.trim(); loadList(); }, 250); });
    $('#assigneeFilter').addEventListener('change', (e) => { S.assignee = e.target.value; local.set('issues.assignee', S.assignee); loadList(); });
    $('#stats').addEventListener('click', (e) => {
      const q = e.target.closest('[data-q]')?.dataset.q;
      if (!q) return;
      if (q === 'unassigned') { S.status = 'active'; S.assignee = 'none'; }
      else if (q === 'mine') { S.status = 'active'; S.assignee = 'me'; }
      else { S.status = q; S.assignee = ''; }
      local.set('issues.status', S.status); local.set('issues.assignee', S.assignee);
      syncControls(); loadList();
    });
    $('#moreBtn').addEventListener('click', () => { S.limit += 200; loadList(); });
    $('#list').addEventListener('click', (e) => { const r = e.target.closest('.iss-row[data-id]'); if (r) openIssue(Number(r.dataset.id)); });
    $('#dClose').addEventListener('click', closeDrawer);
    $('#scrim').addEventListener('click', closeDrawer);
    $('#dActions').addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (a === 'assign') assignDialog();
      if (a === 'ignore') ignoreDialog();
      if (a === 'unignore') act('/unignore', {}, 'No longer ignored');
      if (a === 'close') closeDialog();
    });
    $('#dBody').addEventListener('click', (e) => {
      const b = e.target.closest('[data-del-note]');
      if (!b) return;
      modal({ title: 'Delete this note?', body: '<p>It is removed from the issue for everyone.</p>', actions: [{ label: 'Cancel' }, { label: 'Delete', cls: 'danger solid', onClick: async () => {
        try { S.detail = await api(`/api/issues/${S.openId}/notes/${b.dataset.delNote}`, { method: 'DELETE' }); renderDetail(); toast('Note deleted'); } catch (err) { toast(err.message, 'error'); return false; }
      } }] });
    });
    $('#rulesBtn').addEventListener('click', rulesDialog);
    $('#clearBtn').addEventListener('click', clearDialog);
    $('#exportBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#exportMenu').classList.toggle('open'); });
    $('#exportMenu').addEventListener('click', (e) => { const k = e.target.closest('[data-export]')?.dataset.export; if (k) { $('#exportMenu').classList.remove('open'); exportCsv(k); } });
    document.addEventListener('click', (e) => { if (!e.target.closest('#exportWrap')) $('#exportMenu').classList.remove('open'); });
    $('#themeBtn').addEventListener('click', () => {
      const s = local.get('settings', {});
      s.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      local.set('settings', s);
      applyTheme();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#modalBack').hidden) closeModal();
      else if (S.openId) closeDrawer();
    });
    $('#modalBack').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) closeModal(); });
  }

  init();
})();
