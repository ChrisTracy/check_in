/* Metrics chart for the record drawer: CPU / RAM / disk % over the record's stored history.
 * One shared 0-100% axis (all three are percentages), 2px lines in fixed series colours,
 * direct labels at the line ends, a crosshair + tooltip on hover, and a min/avg/max table. */
(() => {
  'use strict';

  // Which fields count as each metric (first one present wins). The agents send *_pct;
  // the others cover data sent by other tools.
  const METRICS = [
    { key: 'cpu', label: 'CPU', hint: 'Processor busy %, sampled over one second at each check-in', fields: ['cpu_pct', 'cpu', 'cpu_percent', 'cpu_usage', 'cpu_load_pct'] },
    { key: 'ram', label: 'RAM', hint: 'Memory in use %', fields: ['ram_pct', 'ram', 'mem_pct', 'memory_pct', 'mem', 'memory', 'ram_percent'] },
    { key: 'disk', label: 'Disk space', hint: 'Space used on the system drive (C: or /), not disk activity', fields: ['disk_pct', 'disk', 'disk_root_pct', 'disk_used_pct', 'disk_percent'] },
  ];
  const num = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v) => (v === null || v === undefined ? '—' : (Math.round(v * 10) / 10).toLocaleString() + '%');

  /** Turn a record + its history into chart series. Returns null when there is nothing to plot. */
  function extract(record, history) {
    const snaps = [...history].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .map((h) => ({ t: Date.parse(h.at), data: h.data || {} }));
    // The current record is the newest point (covers HISTORY_LIMIT=0 and fresh changes).
    if (record) {
      const t = Date.parse(record.modified);
      if (!snaps.length || snaps[snaps.length - 1].t < t) snaps.push({ t, data: record });
    }
    const series = [];
    for (const m of METRICS) {
      const field = m.fields.find((f) => snaps.some((s) => num(s.data[f]) !== null));
      if (!field) continue;
      const pts = snaps.map((s) => ({ t: s.t, v: num(s.data[field]) }));
      if (pts.some((p) => p.v !== null)) series.push({ ...m, field, pts });
    }
    if (!series.length) return null;
    return { series, times: snaps.map((s) => s.t) };
  }

  function timeFmt(spanMs) {
    if (spanMs > 2 * 86400e3) return { month: 'short', day: 'numeric' };
    if (spanMs > 20 * 3600e3) return { weekday: 'short', hour: 'numeric', minute: '2-digit' };
    return { hour: 'numeric', minute: '2-digit' };
  }

  /** Render into `el`. `hidden` is a Set of metric keys the viewer switched off. */
  function render(el, model, { hidden = new Set(), onToggle } = {}) {
    const { series, times } = model;
    const W = Math.max(280, el.clientWidth);
    const H = 240;
    const m = { l: 40, r: 52, t: 12, b: 26 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const visible = series.filter((s) => !hidden.has(s.key));
    const t0 = times[0];
    const t1 = times[times.length - 1];
    const span = Math.max(1, t1 - t0);
    let vmax = 100;
    for (const s of visible) for (const p of s.pts) if (p.v !== null && p.v > vmax) vmax = Math.ceil(p.v / 25) * 25;
    const x = (t) => (times.length === 1 ? m.l + iw / 2 : m.l + ((t - t0) / span) * iw);
    const y = (v) => m.t + ih - (Math.max(0, v) / vmax) * ih;

    // Gridlines and y labels every 25%.
    let grid = '';
    for (let v = 0; v <= vmax; v += 25) {
      grid += `<line class="mc-grid${v === 0 ? ' base' : ''}" x1="${m.l}" x2="${m.l + iw}" y1="${y(v)}" y2="${y(v)}"/>`
        + `<text class="mc-axis" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`;
    }
    // X ticks: up to 5, evenly spaced in time.
    const tf = new Intl.DateTimeFormat(undefined, timeFmt(span));
    const nt = times.length === 1 ? 1 : Math.min(5, Math.max(2, Math.floor(iw / 110)));
    let xt = '';
    for (let i = 0; i < nt; i++) {
      const t = nt === 1 ? t0 : t0 + (span * i) / (nt - 1);
      const anchor = nt === 1 ? 'middle' : i === 0 ? 'start' : i === nt - 1 ? 'end' : 'middle';
      xt += `<text class="mc-axis" x="${x(t)}" y="${H - 6}" text-anchor="${anchor}">${esc(tf.format(t))}</text>`;
    }

    // Lines (broken where a value is missing), single points as dots, direct labels at the end.
    let lines = '';
    const ends = [];
    for (const s of visible) {
      let d = '';
      let pen = false;
      const lonely = [];
      s.pts.forEach((p, i) => {
        if (p.v === null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
        const prev = s.pts[i - 1];
        const next = s.pts[i + 1];
        if ((!prev || prev.v === null) && (!next || next.v === null)) lonely.push(p);
        pen = true;
      });
      lines += `<path class="mc-line s-${s.key}" d="${d}"/>`;
      lines += lonely.map((p) => `<circle class="mc-dot s-${s.key}" cx="${x(p.t)}" cy="${y(p.v)}" r="4"/>`).join('');
      const last = [...s.pts].reverse().find((p) => p.v !== null);
      if (last) ends.push({ s, y: y(last.v), v: last.v });
    }
    // Keep end labels from overlapping (at least 13px apart).
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    const labels = ends.map((e) => `<text class="mc-end" x="${m.l + iw + 6}" y="${e.y + 4}"><tspan class="mc-end-k s-${e.s.key}">●</tspan> ${esc(fmt(e.v))}</text>`).join('');

    const legend = series.map((s) => {
      const last = [...s.pts].reverse().find((p) => p.v !== null);
      return `<button class="mc-key ${hidden.has(s.key) ? 'off' : ''}" data-metric="${s.key}" aria-pressed="${!hidden.has(s.key)}" title="${esc(s.hint)} (field: ${esc(s.field)}). Click to ${hidden.has(s.key) ? 'show' : 'hide'}.">
        <i class="mc-sw s-${s.key}"></i>${esc(s.label)} <span>${esc(fmt(last && last.v))}</span></button>`;
    }).join('');

    const stats = series.map((s) => {
      const vals = s.pts.map((p) => p.v).filter((v) => v !== null);
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      return `<tr title="${esc(s.hint)}"><td><i class="mc-sw s-${s.key}"></i>${esc(s.label)} <span class="muted">${esc(s.field)}</span></td>
        <td>${fmt(Math.min(...vals))}</td><td>${fmt(avg)}</td><td>${fmt(Math.max(...vals))}</td><td><b>${fmt(vals[vals.length - 1])}</b></td></tr>`;
    }).join('');

    el.innerHTML = `
      <div class="mc-legend">${legend}</div>
      <div class="mc-plot" style="height:${H}px">
        <svg width="${W}" height="${H}" role="img" aria-label="${esc(series.map((s) => s.label).join(', '))} percentage over time">
          ${grid}${xt}
          <g class="mc-lines">${lines}</g>
          ${labels}
          <line class="mc-cross" y1="${m.t}" y2="${m.t + ih}" x1="0" x2="0" visibility="hidden"/>
          <g class="mc-hover"></g>
          <rect class="mc-hit" x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent"/>
        </svg>
        <div class="mc-tip" hidden></div>
        ${visible.length ? '' : '<div class="mc-empty">All series hidden: turn one back on above.</div>'}
      </div>
      <table class="mc-stats"><thead><tr><th></th><th>Min</th><th>Avg</th><th>Max</th><th>Latest</th></tr></thead><tbody>${stats}</tbody></table>`;

    // Hover: snap to the nearest check-in, show every visible value at that time.
    const svg = el.querySelector('svg');
    const cross = el.querySelector('.mc-cross');
    const hov = el.querySelector('.mc-hover');
    const tip = el.querySelector('.mc-tip');
    const full = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const hide = () => { cross.setAttribute('visibility', 'hidden'); hov.innerHTML = ''; tip.hidden = true; };
    const move = (clientX) => {
      if (!visible.length) return;
      const r = svg.getBoundingClientRect();
      const px = clientX - r.left;
      let best = 0;
      for (let i = 1; i < times.length; i++) if (Math.abs(x(times[i]) - px) < Math.abs(x(times[best]) - px)) best = i;
      const cx = x(times[best]);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      hov.innerHTML = visible.map((s) => (s.pts[best].v === null ? '' : `<circle class="mc-dot ring s-${s.key}" cx="${cx}" cy="${y(s.pts[best].v)}" r="4.5"/>`)).join('');
      tip.innerHTML = `<div class="mc-tip-t">${esc(full.format(times[best]))}</div>`
        + visible.map((s) => `<div class="mc-tip-r"><i class="mc-sw s-${s.key}"></i>${esc(s.label)}<b>${esc(fmt(s.pts[best].v))}</b></div>`).join('');
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = Math.min(Math.max(4, cx + 12 + tw > W ? cx - tw - 12 : cx + 12), W - tw - 4) + 'px';
      tip.style.top = m.t + 4 + 'px';
    };
    const hit = el.querySelector('.mc-hit');
    hit.addEventListener('pointermove', (e) => move(e.clientX));
    hit.addEventListener('pointerdown', (e) => move(e.clientX));
    hit.addEventListener('pointerleave', hide);
    el.querySelector('.mc-legend').addEventListener('click', (e) => {
      const b = e.target.closest('[data-metric]');
      if (b && onToggle) onToggle(b.dataset.metric);
    });
  }

  window.CheckinChart = { extract, render, METRICS };
})();
