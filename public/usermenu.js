/* The account menu (avatar, top right) for the Issues and Load test pages, matching the dashboard's.
   Usage: CheckinUserMenu.mount(slotElement, { me, modal, toast, page: 'issues' | 'loadtest' }) */
(() => {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (n) => String(n || '?').split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';
  const I = {
    dash: '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    issues: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3l9.5 16.5h-19z"/><path d="M12 10v4M12 17v.5"/></svg>',
    load: '<svg class="i" viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
    agents: '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M12 7v5M9.5 9.5L12 12l2.5-2.5"/></svg>',
    admin: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>',
    theme: '<svg class="i" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    pw: '<svg class="i" viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    out: '<svg class="i" viewBox="0 0 24 24"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/></svg>',
  };

  function mount(slot, { me, modal, toast, page, onTheme }) {
    const u = me.user || {};
    const name = u.name || u.username || 'Signed in';
    const caps = me.caps || {};
    const item = (act, icon, label, show = true, extra = '') => (show ? `<button class="row-item${act === 'logout' ? ' danger' : ''}" data-um="${act}"${extra}>${icon}${label}</button>` : '');
    slot.classList.add('dropdown');
    slot.innerHTML = `
      <button class="user-btn" id="umBtn" title="Account" aria-haspopup="menu"><span class="avatar">${esc(initials(name))}</span><span class="who"><b>${esc(name)}</b><small>${esc(u.roleLabel || me.role || '')}</small></span></button>
      <div class="menu right" id="umMenu" role="menu">
        <div class="menu-head"><span class="avatar sm">${esc(initials(name))}</span><div><b>${esc(name)}</b><small>${esc(u.username || '')}${u.roleLabel ? ' · ' + esc(u.roleLabel) : ''}</small></div></div>
        ${item('dash', I.dash, 'Dashboard')}
        ${item('issues', I.issues, 'Issues', caps.issues && page !== 'issues', ' hidden')}
        ${item('loadtest', I.load, 'Load test', caps.loadTest && page !== 'loadtest')}
        ${item('agents', I.agents, 'Add Device', caps.checkin)}
        ${item('admin', I.admin, 'Admin', caps.users)}
        ${item('theme', I.theme, 'Toggle dark mode')}
        ${item('password', I.pw, u.hasPassword ? 'Change password' : 'Set a password', me.kind === 'session' || Boolean(u.id))}
        <hr>
        ${item('logout', I.out, 'Sign out')}
      </div>`;
    const menu = slot.querySelector('#umMenu');
    // Only show Issues when an admin has turned it on.
    if (caps.issues && page !== 'issues') {
      fetch('/api/issues/summary', { credentials: 'same-origin' }).then((r) => r.json()).then((s) => {
        const b = slot.querySelector('[data-um="issues"]');
        if (b && s.enabled) b.hidden = false;
      }).catch(() => {});
    }
    slot.querySelector('#umBtn').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
    document.addEventListener('click', (e) => { if (!slot.contains(e.target)) menu.classList.remove('open'); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.classList.remove('open'); });
    menu.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-um]')?.dataset.um;
      if (!act) return;
      menu.classList.remove('open');
      if (act === 'dash') location.href = '/';
      if (act === 'issues') location.href = '/issues';
      if (act === 'loadtest') location.href = '/loadtest';
      if (act === 'agents') location.href = '/?open=agents';
      if (act === 'admin') location.href = '/?open=admin';
      if (act === 'theme') onTheme?.();
      if (act === 'password') changePassword();
      if (act === 'logout') {
        try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': me.csrf || '' } }); } catch { /* ignore */ }
        location.href = '/login';
      }
    });

    function changePassword() {
      const hasPw = u.hasPassword;
      modal({
        title: hasPw ? 'Change password' : 'Set a password',
        body: `${hasPw ? '' : '<p>You sign in with single sign-on. Setting a password also lets you use HTTP Basic auth for scripts.</p>'}
          ${hasPw ? '<label>Current password<input class="input" id="pwCur" type="password" autocomplete="current-password"></label>' : ''}
          <label>New password<input class="input" id="pwNew" type="password" autocomplete="new-password"></label>
          <label>Confirm new password<input class="input" id="pwNew2" type="password" autocomplete="new-password"></label>
          <p style="font-size:12px">At least 10 characters. Your other sessions will be signed out.</p>`,
        actions: [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => {
          const next = document.getElementById('pwNew').value;
          if (next !== document.getElementById('pwNew2').value) { toast('Passwords do not match', 'error'); return false; }
          const res = await fetch('/api/auth/password', { method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf || '' },
            body: JSON.stringify({ current: document.getElementById('pwCur')?.value || '', next }) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) { toast(data.error || 'Could not change the password', 'error'); return false; }
          u.hasPassword = true;
          toast('Password updated');
        } }],
      });
    }
  }

  window.CheckinUserMenu = { mount };
})();
