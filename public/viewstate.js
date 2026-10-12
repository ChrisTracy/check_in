/* Saved-view state sanitiser, shared by the dashboard (loaded as a script) and the server
 * (imported by src/views.js). Anything that doesn't have the expected shape is dropped, so a
 * view saved by an older version, edited by hand or crafted on purpose can't inject markup
 * or break the dashboard. Only keys present in the input are returned. */
(() => {
  'use strict';
  const LAYOUTS = ['table', 'cards', 'activity'];
  const STATUSES = ['all', 'fresh', 'aging', 'stale'];
  const MAX_STR = 200;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v, max = MAX_STR) => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
  const strList = (v, max) => (Array.isArray(v) ? v.slice(0, max).map((s) => str(s)).filter((s) => s !== null && s !== '') : []);

  function cleanViewState(state) {
    const out = {};
    if (!isObj(state)) return out;
    const has = (k) => Object.prototype.hasOwnProperty.call(state, k);
    if (has('search')) out.search = str(state.search, 500) ?? '';
    if (has('filters')) {
      out.filters = (Array.isArray(state.filters) ? state.filters : []).slice(0, 50).filter(isObj).map((f) => {
        const field = str(f.field);
        const op = typeof f.op === 'string' && /^[a-z]{1,16}$/.test(f.op) ? f.op : null;
        if (!field || !op) return null;
        const value = typeof f.value === 'boolean' ? String(f.value) : str(f.value, 1000);
        return value === null ? { field, op } : { field, op, value };
      }).filter(Boolean);
    }
    if (has('match')) out.match = state.match === 'any' ? 'any' : 'all';
    // Minutes: positive = "in the last …", negative = "not in the last …", 0 = any time.
    if (has('time')) { const t = Number(state.time); out.time = Number.isFinite(t) ? Math.max(-5256000, Math.min(5256000, t)) : 0; }
    if (has('status')) out.status = STATUSES.includes(state.status) ? state.status : 'all';
    if (has('sort')) {
      out.sort = (Array.isArray(state.sort) ? state.sort : []).slice(0, 10).filter(isObj)
        .map((s) => ({ key: str(s.key), dir: s.dir === 'asc' ? 'asc' : 'desc' })).filter((s) => s.key);
    }
    // `known`: the fields this view has already seen. A field that appears later isn't in it, so it starts hidden.
    if (has('known')) out.known = strList(state.known, 5000);
    if (has('hidden')) out.hidden = strList(state.hidden, 5000);
    if (has('order')) out.order = strList(state.order, 1000);
    if (has('widths')) {
      const w = {};
      if (isObj(state.widths)) {
        for (const k of Object.keys(state.widths).slice(0, 1000)) {
          const n = Math.round(Number(state.widths[k]));
          if (k && k.length <= MAX_STR && k !== '__proto__' && typeof state.widths[k] !== 'boolean' && Number.isFinite(n)) w[k] = Math.min(2000, Math.max(40, n));
        }
      }
      out.widths = w;
    }
    if (has('groupBy')) out.groupBy = str(state.groupBy) ?? '';
    if (has('box')) out.box = typeof state.box === 'string' && /^[a-z0-9]{0,16}$/.test(state.box) ? state.box : '';
    if (has('layout')) out.layout = LAYOUTS.includes(state.layout) ? state.layout : 'table';
    return out;
  }

  globalThis.CheckinViewState = { cleanViewState };
})();
