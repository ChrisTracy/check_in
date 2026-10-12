/* The account menu (avatar, top right) for the Issues and Load test pages, matching the dashboard's.
   Usage: CheckinUserMenu.mount(slotElement, { me, page: 'issues' | 'loadtest', onExport, onTheme }) */
(() => {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (n) => String(n || '?').split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';
  const I = {
    dash: '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    issues: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3l9.5 16.5h-19z"/><path d="M12 10v4M12 17v.5"/></svg>',
    load: '<svg class="i" viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
    agents: '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M12 7v5M9.5 9.5L12 12l2.5-2.5"/></svg>',
    settings: '<svg class="i" viewBox="0 0 24 24"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
    dl: '<svg class="i" viewBox="0 0 24 24"><path d="M12 4v12M7 11l5 5 5-5M4 20h16"/></svg>',
    theme: '<svg class="i" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    out: '<svg class="i" viewBox="0 0 24 24"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/></svg>',
  };

  function mount(slot, { me, page, onExport, onTheme }) {
    const u = me.user || {};
    const name = u.name || u.username || 'Signed in';
    const caps = me.caps || {};
    const item = (act, icon, label, show = true, extra = '') => (show ? `<button class="row-item${act === 'logout' ? ' danger' : ''}" data-um="${act}"${extra}>${icon}${label}</button>` : '');
    slot.classList.add('dropdown');
    slot.innerHTML = `
      <button class="user-btn" id="umBtn" title="Account" aria-haspopup="menu"><span class="avatar">${esc(initials(name))}</span><span class="who"><b>${esc(name)}</b><small>${esc(u.roleLabel || me.role || '')}</small></span></button>
      <div class="menu right" id="umMenu" role="menu">
        <div class="menu-head"><span class="avatar sm">${esc(initials(name))}</span><div><b>${esc(name)}</b><small>${esc(u.username || '')}${u.roleLabel ? ' · ' + esc(u.roleLabel) : ''}</small></div></div>
        ${page === 'issues' && caps.export ? `<div class="menu-group">${item('x-issues', I.dl, 'Export issues')}${item('x-log', I.dl, 'Export issue log')}${item('x-view', I.dl, 'Export current list')}</div>` : ''}
        ${caps.checkin ? `<div class="menu-group">${item('agents', I.agents, 'Add Device')}</div>` : ''}
        <div class="menu-group">${item('settings', I.settings, 'Settings')}</div>
        <div class="menu-group m-only">${item('theme', I.theme, 'Toggle dark mode')}</div>
        <div class="menu-group last">${item('logout', I.out, 'Sign out')}</div>
      </div>`;
    const menu = slot.querySelector('#umMenu');
    slot.querySelector('#umBtn').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
    document.addEventListener('click', (e) => { if (!slot.contains(e.target)) menu.classList.remove('open'); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.classList.remove('open'); });
    menu.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-um]')?.dataset.um;
      if (!act) return;
      menu.classList.remove('open');
      if (act === 'agents') location.href = '/?open=agents';
      if (act === 'settings') location.href = '/?open=settings';
      if (act === 'x-issues') onExport?.('issues');
      if (act === 'x-log') onExport?.('log');
      if (act === 'x-view') onExport?.('issues-view');
      if (act === 'theme') onTheme?.();
      if (act === 'logout') {
        try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': me.csrf || '' } }); } catch { /* ignore */ }
        location.href = '/login';
      }
    });
  }

  window.CheckinUserMenu = { mount };
})();
