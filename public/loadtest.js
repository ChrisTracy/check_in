/* Load test page (admins): run a simulated fleet and switch problems on and off. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = new Intl.NumberFormat();
  const local = {
    get(k, d) { try { const v = localStorage.getItem('checkin.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('checkin.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  let me = null;
  let st = null;
  let dirty = false; // the devices/interval inputs were edited and not applied yet

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.body !== undefined) { headers['content-type'] = 'application/json'; opts = { ...opts, body: JSON.stringify(opts.body) }; }
    if ((opts.method || 'GET') !== 'GET' && me?.csrf) headers['x-csrf-token'] = me.csrf;
    const res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
    if (res.status === 401) { location.href = '/login?returnTo=%2Floadtest'; throw new Error('Signed out'); }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    return data;
  }
  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 6000 : 3000);
  }
  function modal({ title, body, actions }) {
    $('#mTitle').textContent = title;
    $('#mBody').innerHTML = body;
    const box = $('#mActions');
    box.innerHTML = '';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'btn ' + (a.cls || '');
      b.textContent = a.label;
      b.onclick = async () => { if (a.onClick && (await a.onClick()) === false) return; $('#modalBack').hidden = true; };
      box.appendChild(b);
    }
    $('#modalBack').hidden = false;
  }
  function applyTheme() {
    const t = local.get('settings', {}).theme || 'auto';
    const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }
  const fmtMs = (v) => (v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(0) : v.toFixed(1));
  /** Check-ins per second for d devices every i seconds; slow fleets read "0.03/s (1 every 36 s)", not 0. */
  function fmtRate(d, i) {
    const r = d / i;
    if (r >= 1) return `${nf.format(r >= 10 ? Math.round(r) : Math.round(r * 10) / 10)} check-ins/s`;
    const every = i / d;
    const shown = r >= 0.01 ? Math.round(r * 100) / 100 : Number(r.toPrecision(1));
    return `${shown}/s (1 every ${every >= 10 ? nf.format(Math.round(every)) : Math.round(every * 10) / 10} s)`;
  }
  const affText = (n) => (n ? `${nf.format(n)} device${n === 1 ? '' : 's'}` : '0 devices (too few)');
  const affTitle = (n) => (n ? '' : 'This amount picks no devices with the current fleet size: raise it or use a number of devices');

  // ------------------------------------------------------------ rendering
  function render() {
    const s = st;
    $('#runState').className = 'live ' + (s.running ? 'on' : 'off');
    $('#runText').textContent = s.running ? `Running · ${nf.format(s.devices)} devices every ${s.interval}s` : 'Stopped';
    $('#startBtn').textContent = s.running ? 'Stop' : 'Start';
    $('#startBtn').className = 'btn ' + (s.running ? 'danger' : 'primary');
    $('#applyBtn').hidden = !(s.running && dirty);
    if (!dirty) { $('#devices').value = s.devices; $('#interval').value = s.interval; $('#topProcs').checked = Boolean(s.topProcs); }
    updateTarget();
    const last = s.history.at(-1) || {};
    $('#tRate').textContent = nf.format(s.running ? s.rate : last.ok || 0);
    $('#tRateSub').textContent = s.running ? `target ${fmtRate(s.devices, s.interval).replace(' check-ins/s', '')}${s.inflight ? ` · ${nf.format(s.inflight)} in flight` : ''}` : 'not running';
    $('#tP95').textContent = last.p95 ? fmtMs(last.p95) + ' ms' : '–';
    $('#tP50').textContent = last.p50 ? `p50 ${fmtMs(last.p50)} ms · max ${fmtMs(last.max)} ms` : 'p50 –';
    $('#tCpu').textContent = last.cpu !== undefined ? last.cpu + '%' : '–';
    $('#tLag').textContent = last.lag !== undefined ? `event loop p99 ${last.lag} ms · ${s.server.rssMb} MB` : 'event loop –';
    $('#tSent').textContent = nf.format(s.stats.sent);
    const bad = s.stats.errors + s.stats.rejected;
    $('#tErr').textContent = `${nf.format(bad)} failed${s.stats.rejected ? ` (${nf.format(s.stats.rejected)} paused)` : ''}${s.stats.skipped ? ` · ${nf.format(s.stats.skipped)} skipped` : ''}`;
    $('#tErr').classList.toggle('lt-bad', bad > 0);
    $('#tSim').textContent = nf.format(s.simDevices);
    $('#tRecords').textContent = `of ${nf.format(s.records)} records${s.queue ? ` · queue ${nf.format(s.queue)}` : ''}`;
    $('#tIssues').textContent = s.issues ? nf.format(s.issues.open) : '–';
    $('#tIssuesSub').textContent = s.issues ? `${nf.format(s.issues.ignored)} ignored · ${nf.format(s.issues.closed)} closed` : 'issues are off';
    $('#lastError').hidden = !s.stats.lastError || !bad;
    $('#lastError').textContent = s.stats.lastError ? 'Last error: ' + s.stats.lastError : '';
    $('#takenNote').hidden = !s.taken;
    $('#takenNote').textContent = s.taken ? `${nf.format(s.taken)} device${s.taken === 1 ? '' : 's'} skipped (name taken by a real device): ${s.takenIds.join(', ')}${s.taken > s.takenIds.length ? '…' : ''}. The simulator never writes to or removes a record that isn't marked simulated.` : '';
    $('#burstBtn').disabled = !!s.bursting;
    $('#burstBtn').title = s.bursting ? `A burst is being sent (${nf.format(s.queued)} still queued)` : 'Every device checks in once, right now';
    $('#removeBtn').disabled = s.running || !s.simDevices;
    $('#removeBtn').title = s.running ? 'Stop the test first' : s.simDevices ? '' : 'No simulated devices';
    renderScenarios();
    $('#customCount').hidden = !s.customCount;
    $('#customCount').textContent = `${nf.format(s.customCount)} changed`;
    $('#healDevices').hidden = !s.customCount;
    // The fleet changed size or problems moved: refresh the device list (unless someone is mid-edit).
    const sig = `${s.devices}|${s.scenarios.map((x) => x.id + ':' + x.affected).join(',')}|${s.customCount}`;
    if (sig !== dev.sig) { const first = !dev.sig; dev.sig = sig; if (first || !$('#devList').contains(document.activeElement)) loadDevices(); }
    drawCharts();
  }

  function updateTarget() {
    const d = Number($('#devices').value) || 0;
    const i = Number($('#interval').value) || 0;
    $('#target').textContent = d > 0 && i > 0 ? fmtRate(d, i) : '–';
  }

  let catalogDrawn = false;
  function renderScenarios() {
    const s = st;
    $('#healAll').hidden = !s.scenarios.length;
    // Rebuild only when something changed, and never under the cursor of someone editing an amount.
    const sig = JSON.stringify(s.scenarios.map((sc) => [sc.id, sc.amount, sc.mode, sc.affected]));
    const typing = $('#active').contains(document.activeElement) && document.activeElement.matches('input');
    if (typing) {
      // Keep what's being typed; just refresh the counts.
      for (const sc of s.scenarios) {
        const el = $(`.lt-sc[data-id="${sc.id}"] .lt-sc-aff`);
        if (el) { el.textContent = affText(sc.affected); el.title = affTitle(sc.affected); el.classList.toggle('lt-warn', !sc.affected); }
      }
    } else if (sig !== renderScenarios.sig) {
      renderScenarios.sig = sig;
      $('#active').innerHTML = s.scenarios.length ? s.scenarios.map((sc) => `<div class="lt-sc" data-id="${esc(sc.id)}">
        <span class="lt-sc-dot"></span>
        <div class="lt-sc-name"><b>${esc(sc.label)}</b><small>${esc(sc.desc)} · since ${esc(new Date(sc.startedAt).toLocaleTimeString())}</small></div>
        <span class="lt-sc-amt"><input class="input" type="number" min="1" step="1" value="${esc(sc.amount)}" data-amt>
          <select class="select" data-mode><option value="percent" ${sc.mode === 'percent' ? 'selected' : ''}>%</option><option value="count" ${sc.mode === 'count' ? 'selected' : ''}>devices</option></select></span>
        <span class="lt-sc-aff${sc.affected ? '' : ' lt-warn'}" title="${esc(affTitle(sc.affected))}">${esc(affText(sc.affected))}</span>
        <button class="btn sm" data-remove>Remove</button></div>`).join('')
      : '<p class="lt-healthy"><span class="dot fresh"></span> Every device is healthy.</p>';
    }
    if (!catalogDrawn) {
      const last = local.get('loadtest.amounts', {});
      $('#catalog').innerHTML = s.catalog.map((c) => `<div class="lt-cat" data-key="${esc(c.key)}">
          <div><b>${esc(c.label)}</b><small>${esc(c.desc)}</small></div>
          <span class="lt-sc-amt"><input class="input" type="number" min="1" step="1" value="${esc(last[c.key]?.amount ?? 10)}" data-amt>
            <select class="select" data-mode><option value="percent" ${last[c.key]?.mode !== 'count' ? 'selected' : ''}>%</option><option value="count" ${last[c.key]?.mode === 'count' ? 'selected' : ''}>devices</option></select></span>
          <button class="btn sm primary" data-trigger>Trigger</button></div>`).join('');
      catalogDrawn = true;
    }
  }

  // Single-series line charts with a crosshair tooltip (one y-axis each).
  let hovered = null; // { key, clientX } while the pointer is over a chart, so a redraw keeps the crosshair
  function drawCharts() {
    $$('.lt-chart').forEach(drawChart);
    const fig = hovered && $(`.lt-chart[data-key="${hovered.key}"]`);
    if (fig) hover({ target: fig, clientX: hovered.clientX });
  }
  function drawChart(fig) {
    const key = fig.dataset.key;
    const unit = fig.dataset.unit;
    const pts = st.history;
    const plot = $('.lt-plot', fig);
    const W = plot.clientWidth || 300;
    const H = 120;
    const pad = { l: 38, r: 8, t: 8, b: 18 };
    const vals = pts.map((p) => p[key] || 0);
    const max = niceMax(Math.max(1, ...vals));
    const now = Date.now();
    const span = 120_000;
    const x = (t) => pad.l + (1 - (now - t) / span) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
    const shown = pts.filter((p) => now - p.t <= span);
    const path = shown.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[key] || 0).toFixed(1)}`).join('');
    const grid = [0, 0.5, 1].map((f) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(max * f)}" y2="${y(max * f)}" class="lt-grid"/><text x="${pad.l - 6}" y="${y(max * f) + 4}" class="lt-axis" text-anchor="end">${nf.format(Math.round(max * f))}</text>`).join('');
    const ticks = [120, 60, 0].map((s) => `<text x="${x(now - s * 1000)}" y="${H - 4}" class="lt-axis" text-anchor="${s === 0 ? 'end' : s === 120 ? 'start' : 'middle'}">${s ? `-${s / 60 >= 1 ? s / 60 + 'm' : s + 's'}` : 'now'}</text>`).join('');
    const lastPt = shown.at(-1);
    plot.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc($('figcaption', fig).textContent)}">
      ${grid}${ticks}
      ${path ? `<path d="${path}" class="lt-line"/>` : `<text x="${(W + pad.l) / 2}" y="${H / 2}" class="lt-axis" text-anchor="middle">No data yet</text>`}
      ${lastPt ? `<circle cx="${x(lastPt.t)}" cy="${y(lastPt[key] || 0)}" r="4" class="lt-dot"/>` : ''}
      <line class="lt-cross" y1="${pad.t}" y2="${H - pad.b}" x1="0" x2="0" visibility="hidden"/>
      <circle class="lt-hover" r="4" visibility="hidden"/>
      <rect x="${pad.l}" y="0" width="${W - pad.l - pad.r}" height="${H}" fill="transparent" class="lt-hit"/></svg>`;
    fig._chart = { shown, x, y, key, unit, H };
  }
  function niceMax(v) {
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
    return 10 * p;
  }
  function hover(e) {
    const fig = e.target.closest('.lt-chart');
    const c = fig?._chart;
    const tip = $('#tip');
    if (fig) hovered = { key: fig.dataset.key, clientX: e.clientX };
    if (!c || !c.shown.length) { tip.hidden = true; return; }
    const svg = $('svg', fig);
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let best = c.shown[0];
    for (const p of c.shown) if (Math.abs(c.x(p.t) - mx) < Math.abs(c.x(best.t) - mx)) best = p;
    const cx = c.x(best.t);
    const cy = c.y(best[c.key] || 0);
    const cross = $('.lt-cross', svg);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
    const h = $('.lt-hover', svg);
    h.setAttribute('cx', cx); h.setAttribute('cy', cy); h.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.innerHTML = `<b>${esc(nf.format(best[c.key] || 0))}${esc(c.unit)}</b><span>${esc(new Date(best.t).toLocaleTimeString())}</span>${c.key === 'ok' ? `<span>${nf.format(best.err)} failed</span>` : c.key === 'p95' ? `<span>p50 ${fmtMs(best.p50)} · max ${fmtMs(best.max)} ms</span>` : `<span>event loop p99 ${best.lag} ms</span>`}`;
    const tx = Math.min(window.innerWidth - tip.offsetWidth - 8, rect.left + cx + 12);
    tip.style.left = tx + 'px';
    tip.style.top = (rect.top + window.scrollY + cy - 10) + 'px';
  }
  function unhover(e) {
    const fig = e.target.closest('.lt-chart');
    hovered = null;
    $('#tip').hidden = true;
    if (!fig) return;
    $$('.lt-cross, .lt-hover', fig).forEach((n) => n.setAttribute('visibility', 'hidden'));
  }


  // ------------------------------------------------------------ specific devices
  const dev = { q: '', kind: local.get('loadtest.filter', ''), list: [], total: 0, open: null, sig: '' };
  async function loadDevices() {
    try {
      const r = await api(`/api/admin/loadtest/sims?limit=60&filter=${encodeURIComponent(dev.kind)}&q=${encodeURIComponent(dev.q)}`);
      // Changes still on their way to the server win over what it had when it answered.
      for (const d of r.devices) { const p = pend.get(d.id); if (p) Object.assign(d, clone(p.want)); }
      dev.list = r.devices; dev.total = r.total;
      renderDevices();
    } catch (e) { $('#devList').innerHTML = `<div class="warn-box">${esc(e.message)}</div>`; }
  }
  const problemLabel = (key) => st.catalog.find((c) => c.key === key)?.label || key;
  function devChips(d) {
    if (d.taken) return '<span class="lt-chip warn" title="A real device already uses this name, so the simulator skips it">Skipped: name taken</span>';
    const chips = [
      ...d.problems.map((k) => `<span class="lt-chip bad">${esc(problemLabel(k))}</span>`),
      ...d.stopped.map((n) => `<span class="lt-chip bad">${esc(n)} stopped</span>`),
      ...d.ports.filter((p) => portClosed(d, p)).map((p) => `<span class="lt-chip bad">${esc(p.label)} closed</span>`),
      ...d.scenarios.map((l) => `<span class="lt-chip warn" title="From a percentage problem">${esc(l)}</span>`),
    ];
    return chips.length ? chips.join('') : '<span class="lt-chip ok">Healthy</span>';
  }
  // A port is closed when it was closed by hand or the service behind it is stopped.
  const portClosed = (d, p) => d.closed.includes(p.port) || d.stopped.includes(p.service);
  const changed = (d) => d.problems.length || d.stopped.length || d.closed.length;
  function devRow(d) {
    const open = dev.open === d.id;
    return `<div class="lt-dev${open ? ' open' : ''}${changed(d) ? ' changed' : ''}" data-id="${esc(d.id)}">
      <button class="lt-dev-head" data-toggle aria-expanded="${open}">
        <span class="lt-dev-name"><b>${esc(d.id)}</b><small>${esc(d.role)} · ${esc(d.os)} · ${esc(d.site)}</small></span>
        <span class="lt-dev-chips">${devChips(d)}</span>
        <svg class="i lt-chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      ${open ? `<div class="lt-dev-edit">
        <div class="lt-dev-sec"><span class="ir-lbl">Problems</span><div class="lt-toggles">${st.catalog.filter((c) => c.perDevice).map((c) => `<label class="lt-tog${d.problems.includes(c.key) ? ' on' : ''}" title="${esc(c.desc)}"><input type="checkbox" data-problem="${esc(c.key)}" ${d.problems.includes(c.key) ? 'checked' : ''}>${esc(c.label)}</label>`).join('')}</div></div>
        <div class="lt-dev-sec"><span class="ir-lbl">Remote access</span><div class="lt-svcs">${d.ports.map((p) => {
          const shut = portClosed(d, p);
          const bySvc = !d.closed.includes(p.port) && d.stopped.includes(p.service);
          return `<label class="lt-svc${shut ? ' stopped' : ''}" title="${bySvc ? `Closed because ${esc(p.service)} is stopped` : `port_${p.port}`}"><span class="switch"><input type="checkbox" data-port="${p.port}" ${shut ? '' : 'checked'} ${bySvc ? 'disabled' : ''}><span class="track"></span></span><span class="lt-svc-name">${esc(p.label)} · ${p.port}</span><small>${shut ? 'Closed' : 'Open'}</small></label>`;
        }).join('')}</div></div>
        <div class="lt-dev-sec"><span class="ir-lbl">Services</span><div class="lt-svcs">${d.services.map((n) => {
          const stopped = d.stopped.includes(n);
          return `<label class="lt-svc${stopped ? ' stopped' : ''}"><span class="switch"><input type="checkbox" data-service="${esc(n)}" ${stopped ? '' : 'checked'}><span class="track"></span></span><span class="lt-svc-name">${esc(n)}</span><small>${stopped ? 'Stopped' : 'Running'}</small></label>`;
        }).join('')}</div></div>
        <div class="lt-dev-foot">${d.scenarios.length ? `<span class="muted">Also in: ${esc(d.scenarios.join(', '))} (from the percentages above)</span>` : '<span></span>'}
          <button class="btn sm" data-heal ${changed(d) ? '' : 'disabled'}>Make healthy</button></div>
      </div>` : ''}
    </div>`;
  }
  function renderDevices() {
    $$('#devKind button').forEach((b) => b.classList.toggle('active', b.dataset.kind === dev.kind));
    $('#devCount').textContent = `${nf.format(dev.total)} device${dev.total === 1 ? '' : 's'}${dev.total > dev.list.length ? `, first ${dev.list.length} shown` : ''}`;
    $('#devList').innerHTML = dev.list.length ? dev.list.map(devRow).join('')
      : `<p class="lt-healthy">${dev.kind === 'custom' ? 'No devices have been changed.' : 'No devices match.'}</p>`;
  }
  // One device's changes go to the server one request at a time, each built from the latest thing the
  // user asked for (shown straight away), so quick clicks never undo each other.
  const pend = new Map(); // id -> { want: {problems, stopped, closed}, server: last device the server sent, busy }
  const clone = (b) => ({ problems: b.problems.slice(), stopped: b.stopped.slice(), closed: b.closed.slice() });
  const key = (b) => JSON.stringify([[...b.problems].sort(), [...b.stopped].sort(), [...b.closed].sort()]);
  function setDevice(id, change) {
    const d = dev.list.find((x) => x.id === id);
    if (!d) return;
    let p = pend.get(id);
    if (!p) { p = { want: clone(d), server: { ...d, ...clone(d) }, busy: false }; pend.set(id, p); }
    change(p.want);
    Object.assign(d, clone(p.want));
    renderDevices();
    if (!p.busy) sendDevice(id, p);
  }
  async function sendDevice(id, p) {
    p.busy = true;
    for (;;) {
      const body = clone(p.want);
      try {
        const r = await api(`/api/admin/loadtest/sims/${encodeURIComponent(id)}`, { method: 'PUT', body });
        p.server = r.device;
        st = r;
        if (key(body) !== key(p.want)) continue; // more clicks while this was on its way: send the latest
        pend.delete(id);
        showDevice(id, r.device);
        render();
        return;
      } catch (e) {
        toast(e.message, 'error');
        pend.delete(id);
        showDevice(id, p.server); // back to what the server has
        return;
      }
    }
  }
  function showDevice(id, device) {
    const d = dev.list.find((x) => x.id === id);
    if (d) Object.assign(d, device);
    if (d && dev.kind === 'custom' && !changed(d)) { dev.open = null; loadDevices(); } else renderDevices();
  }
  function bindDevices() {
    $('#devKind').addEventListener('click', (e) => {
      const b = e.target.closest('[data-kind]');
      if (!b) return;
      dev.kind = b.dataset.kind; local.set('loadtest.filter', dev.kind); dev.open = null;
      loadDevices();
    });
    let t;
    $('#devSearch').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { dev.q = e.target.value.trim(); loadDevices(); }, 200); });
    $('#devList').addEventListener('click', (e) => {
      const row = e.target.closest('.lt-dev');
      if (!row) return;
      if (e.target.closest('[data-toggle]')) { dev.open = dev.open === row.dataset.id ? null : row.dataset.id; renderDevices(); return; }
      if (e.target.closest('[data-heal]')) setDevice(row.dataset.id, (b) => { b.problems = []; b.stopped = []; b.closed = []; });
    });
    $('#devList').addEventListener('change', (e) => {
      const row = e.target.closest('.lt-dev');
      if (!row) return;
      const p = e.target.dataset.problem;
      const svc = e.target.dataset.service;
      const on = e.target.checked;
      if (p) setDevice(row.dataset.id, (b) => { b.problems = on ? [...new Set([...b.problems, p])] : b.problems.filter((x) => x !== p); });
      const port = Number(e.target.dataset.port);
      if (port) setDevice(row.dataset.id, (b) => { b.closed = on ? b.closed.filter((x) => x !== port) : [...new Set([...b.closed, port])]; });
      if (svc) setDevice(row.dataset.id, (b) => { b.stopped = on ? b.stopped.filter((x) => x !== svc) : [...new Set([...b.stopped, svc])]; });
    });
    $('#healDevices').addEventListener('click', async () => {
      if (await run('/api/admin/loadtest/sims', { method: 'DELETE' }, 'Every changed device is healthy again')) { dev.open = null; loadDevices(); }
    });
  }

  // ------------------------------------------------------------ actions
  async function refresh() {
    try { st = await api('/api/admin/loadtest'); render(); } catch (e) { $('#runText').textContent = e.message; }
  }
  async function run(path, opts, msg) {
    try { st = await api(path, opts); render(); if (msg) toast(msg); return true; } catch (e) { toast(e.message, 'error'); return false; }
  }
  const settings = () => ({ devices: Number($('#devices').value), interval: Number($('#interval').value), topProcs: $('#topProcs').checked });

  function bind() {
    $('#startBtn').addEventListener('click', async () => {
      if (st.running) { await run('/api/admin/loadtest/stop', { method: 'POST' }, 'Load test stopped'); return; }
      if (await run('/api/admin/loadtest/start', { method: 'POST', body: settings() }, 'Load test started: every device begins healthy')) dirty = false;
      render();
    });
    $('#applyBtn').addEventListener('click', async () => { if (await run('/api/admin/loadtest', { method: 'PUT', body: settings() }, 'Applied')) { dirty = false; render(); } });
    $('#burstBtn').addEventListener('click', async () => {
      try {
        st = await api('/api/admin/loadtest/burst', { method: 'POST' });
        render();
        const skipped = Math.max(0, st.devices - st.burst - (st.taken || 0));
        toast(st.burst ? `Burst: ${nf.format(st.burst)} check-ins on their way, up to ${nf.format(st.maxInflight)} at a time${skipped ? ` (${nf.format(skipped)} offline skipped)` : ''}` : 'Nothing to burst: every device is offline');
      } catch (e) { toast(e.message, 'error'); }
    });
    $('#topProcs').addEventListener('change', () => { dirty = true; $('#applyBtn').hidden = !st?.running; });
    for (const id of ['#devices', '#interval']) {
      $(id).addEventListener('input', () => { dirty = true; updateTarget(); $('#applyBtn').hidden = !st?.running; });
      $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') (st?.running ? $('#applyBtn') : $('#startBtn')).click(); });
    }
    $('#catalog').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-trigger]');
      if (!b) return;
      const row = b.closest('.lt-cat');
      const body = { key: row.dataset.key, amount: Number($('[data-amt]', row).value), mode: $('[data-mode]', row).value };
      const amounts = local.get('loadtest.amounts', {});
      amounts[body.key] = { amount: body.amount, mode: body.mode };
      local.set('loadtest.amounts', amounts);
      const label = $('b', row).textContent;
      if (!(await run('/api/admin/loadtest/scenarios', { method: 'POST', body }))) return;
      const sc = st.scenarios.at(-1);
      if (sc && !sc.affected) toast(`${label} triggered, but it picks none of the devices it applies to: raise the amount or use a number of devices`, 'error');
      else toast(`${label} triggered on ${affText(sc?.affected || 0)}${st?.running ? '' : ' (start the test to send it)'}`);
    });
    $('#active').addEventListener('click', (e) => {
      const b = e.target.closest('[data-remove]');
      if (!b) return;
      const id = b.closest('.lt-sc').dataset.id;
      run(`/api/admin/loadtest/scenarios/${id}`, { method: 'DELETE' }, 'Removed: those devices are healthy from their next check-in');
    });
    $('#active').addEventListener('change', async (e) => {
      const row = e.target.closest('.lt-sc');
      if (!row || !e.target.matches('[data-amt], [data-mode]')) return;
      const ok = await run(`/api/admin/loadtest/scenarios/${row.dataset.id}`, { method: 'PUT', body: { amount: Number($('[data-amt]', row).value), mode: $('[data-mode]', row).value } });
      if (!ok) {
        // Rejected: put the boxes back to what is really running.
        const sc = st.scenarios.find((x) => x.id === row.dataset.id);
        if (sc) { $('[data-amt]', row).value = sc.amount; $('[data-mode]', row).value = sc.mode; }
      }
    });
    $('#healAll').addEventListener('click', () => run('/api/admin/loadtest/scenarios/all', { method: 'DELETE' }, 'Every device is healthy from its next check-in'));
    $('#removeBtn').addEventListener('click', () => modal({
      title: 'Remove simulated devices?',
      body: `<p>Deletes all <b>${nf.format(st.simDevices)}</b> simulated (<code>SIM-*</code>) records and their history. Their open issues close. Real devices aren't touched.</p>`,
      actions: [{ label: 'Cancel' }, { label: 'Remove', cls: 'danger solid', onClick: async () => {
        try { const r = await api('/api/admin/loadtest/devices?confirm=true', { method: 'DELETE' }); st = r; render(); toast(`Removed ${nf.format(r.deleted)} simulated devices`); } catch (e) { toast(e.message, 'error'); return false; }
      } }],
    }));
    $('#themeBtn').addEventListener('click', () => {
      const s = local.get('settings', {});
      s.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      local.set('settings', s);
      applyTheme();
    });
    document.addEventListener('pointermove', (e) => { if (e.target.closest?.('.lt-hit')) hover(e); });
    document.addEventListener('pointerout', (e) => { if (e.target.closest?.('.lt-hit')) unhover(e); });
    window.addEventListener('resize', () => st && drawCharts());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modalBack').hidden = true; });
  }

  async function init() {
    applyTheme();
    try { me = await api('/api/auth/me'); } catch { return; }
    if (!me.caps?.loadTest) { location.href = '/'; return; }
    window.CheckinUserMenu?.mount($('#userMenuSlot'), { me, modal, toast, page: 'loadtest', onTheme: () => $('#themeBtn').click() });
    bind();
    bindDevices();
    await refresh();
    setInterval(refresh, 1000);
  }
  init();
})();
