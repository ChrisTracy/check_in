/* Admin panel: users, single sign-on (Entra ID) and API key. Loaded after app.js. */
(() => {
  'use strict';
  const UI = window.CheckinUI;
  const { apiJson, modal, toast, esc, nf, relTime, absTime, initials } = UI;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const ROLES = [
    ['admin', 'Admin', 'Everything, including users, single sign-on, port checks and whether the API key is required'],
    ['power', 'Power user', 'User rights plus Clear all, pausing check-ins, the active threshold, the API key and the issue rules'],
    ['user', 'User', 'View, import, export and delete records; assign, ignore, close and add notes to issues'],
    ['reader', 'Reader', 'View records and history only'],
  ];
  const roleLabel = (r) => ROLES.find((x) => x[0] === r)?.[1] || r;
  const roleOptions = (sel, extra = []) => [...extra, ...ROLES].map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const ICON = {
    key: '<svg class="i" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M16 7l3 3M14 9l2 2"/></svg>',
    ban: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>',
    check: '<svg class="i" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    trash: '<svg class="i" viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    plus: '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    copy: '<svg class="i" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    x: '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    download: '<svg class="i" viewBox="0 0 24 24"><path d="M12 4v12M7 11l5 5 5-5M4 20h16"/></svg>',
    edit: '<svg class="i" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/></svg>',
  };

  let tab = 'users';
  let users = [];
  let ssoReady = false; // from /api/admin/users: can SSO-linked accounts sign in right now?
  let userFilter = '';

  function head(title, sub, actions = '') {
    $('#aTitle').textContent = title;
    $('#aSub').textContent = sub;
    $('#aHeadActions').innerHTML = actions;
  }
  function foot(html) {
    $('#aFoot').hidden = !html;
    $('#aFoot').innerHTML = html || '';
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); } catch { toast('Clipboard unavailable', 'error'); }
  }

  function open(t = 'users') {
    if (!UI.can('users')) return;
    $('#adminBack').hidden = false;
    select(t);
  }
  function close() { $('#adminBack').hidden = true; UI.refreshCertWarning?.(); }

  function select(t) {
    tab = t;
    $$('.admin-nav [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    $('#aBody').innerHTML = '<div class="muted">Loading…</div>';
    foot('');
    ({ users: loadUsers, sso: loadSso, apikey: loadApiKey, tls: loadTls, ports: loadPorts, issues: loadIssuesAdmin })[t]();
  }

  // ================================================================== Users
  async function loadUsers() {
    try {
      const r = await apiJson('/api/admin/users');
      users = r.users;
      ssoReady = Boolean(r.ssoReady);
      renderUsers();
    } catch (e) { $('#aBody').innerHTML = `<div class="warn-box">${esc(e.message)}</div>`; }
  }

  function renderUsers() {
    const me = UI.state.me.user.id;
    head('Users', `${nf.format(users.length)} user${users.length === 1 ? '' : 's'} · control who can sign in and what they can do`,
      `<div class="copy-row"><input class="input" id="uSearch" placeholder="Search users…" value="${esc(userFilter)}" style="width:200px;font-family:inherit;background:var(--surface)">
       <button class="btn primary" id="uAdd">${ICON.plus}<span>Add user</span></button></div>`);
    const q = userFilter.toLowerCase();
    const list = users.filter((u) => !q || [u.username, u.name, u.email, u.roleLabel].some((x) => String(x || '').toLowerCase().includes(q)));
    $('#aBody').innerHTML = `
      <div class="admin-section">
        <div class="grid2 role-grid">
          ${ROLES.map(([r, l, d]) => `<div class="radio-card" style="cursor:default;flex-direction:column;align-items:flex-start;gap:4px"><span class="role-badge r-${r}">${esc(l)}</span><small>${esc(d)}</small></div>`).join('')}
        </div>
      </div>
      <table class="utable users-table">
        <thead><tr><th>User</th><th style="width:160px">Role</th><th>Sign-in</th><th>Last sign-in</th><th>Status</th><th style="width:120px"></th></tr></thead>
        <tbody>${list.map((u) => `
          <tr class="${u.disabled ? 'disabled' : ''}" data-id="${u.id}">
            <td class="u-user"><div class="ucell"><span class="avatar sm">${esc(initials(u))}</span><div style="min-width:0">
              <b>${esc(u.name || u.username)} ${u.id === me ? '<span class="tag">You</span>' : ''}</b>
              <small>${esc(u.username)}${u.email && u.email !== u.username ? ' · ' + esc(u.email) : ''}</small></div></div></td>
            <td class="u-role"><select class="select" data-role>${roleOptions(u.role)}</select></td>
            <td class="u-signin">${u.hasPassword ? '<span class="tag">Password</span>' : ''}${u.sso ? '<span class="tag">Entra SSO</span>' : ''}${!u.hasPassword && !u.sso ? '<span class="tag">SSO (not linked yet)</span>' : ''}</td>
            <td class="u-last" title="${esc(absTime(u.lastLogin))}">${u.lastLogin ? esc(relTime(u.lastLogin)) : '<span class="muted">Never</span>'}</td>
            <td class="u-status">${u.disabled ? '<span class="tag off">Disabled</span>' : '<span class="tag ok">Active</span>'}</td>
            <td class="u-actions" style="text-align:right;white-space:nowrap">
              <button class="icon-btn" data-act="edit" title="Edit details">${ICON.edit}</button>
              <button class="icon-btn" data-act="password" title="${u.hasPassword ? 'Reset password' : 'Set password'}">${ICON.key}</button>
              ${u.id === me ? '' : `<button class="icon-btn" data-act="toggle" title="${u.disabled ? 'Enable' : 'Disable'}">${u.disabled ? ICON.check : ICON.ban}</button>
              <button class="icon-btn" data-act="delete" title="Delete">${ICON.trash}</button>`}
            </td>
          </tr>`).join('') || '<tr><td colspan="6" class="muted">No users match.</td></tr>'}
        </tbody>
      </table>`;
    $('#uSearch').addEventListener('input', (e) => { userFilter = e.target.value; const pos = e.target.selectionStart; renderUsers(); const el = $('#uSearch'); el.focus(); el.setSelectionRange(pos, pos); });
    $('#uAdd').addEventListener('click', addUser);
  }

  async function patchUser(id, body, msg) {
    try {
      const r = await apiJson(`/api/admin/users/${id}`, json('PATCH', body));
      users = users.map((u) => (u.id === id ? r.user : u));
      if (id === UI.state.me.user.id && body.role) { toast('Your role changed. Reloading…'); setTimeout(() => location.reload(), 900); return; }
      if (msg) toast(msg);
      renderUsers();
    } catch (e) { toast(e.message, 'error'); renderUsers(); }
  }

  function addUser() {
    modal({
      title: 'Add user',
      body: `<label>Username<input class="input" id="nuUser" autocomplete="off" placeholder="jane or jane@contoso.com"></label>
        <div class="row"><label>Display name<input class="input" id="nuName" autocomplete="off"></label>
        <label>Email<input class="input" id="nuEmail" type="email" autocomplete="off"></label></div>
        <label>Role<select class="select" id="nuRole">${roleOptions('user')}</select></label>
        <label class="switch" style="margin:4px 0 12px;font-weight:500"><input type="checkbox" id="nuSso"><span class="track"></span>Single sign-on only (no password)</label>
        <label id="nuPwRow">Password<input class="input" id="nuPw" type="password" autocomplete="new-password" placeholder="At least 10 characters"></label>
        <p style="font-size:12px" id="nuHint">The user signs in with this username and password, or with HTTP Basic auth from scripts.</p>`,
      actions: [{ label: 'Cancel' }, { label: 'Add user', cls: 'primary', onClick: async () => {
        const sso = $('#nuSso').checked;
        const body = { username: $('#nuUser').value.trim(), name: $('#nuName').value, email: $('#nuEmail').value, role: $('#nuRole').value };
        if (!sso) body.password = $('#nuPw').value;
        if (!sso && !body.password) { toast('Enter a password, or choose single sign-on only', 'error'); return false; }
        try {
          const r = await apiJson('/api/admin/users', json('POST', body));
          users.push(r.user);
          users.sort((a, b) => a.username.localeCompare(b.username));
          toast(`Added ${r.user.username}`);
          renderUsers();
        } catch (e) { toast(e.message, 'error'); return false; }
      } }],
    });
    $('#nuSso').addEventListener('change', (e) => {
      $('#nuPwRow').hidden = e.target.checked;
      $('#nuHint').textContent = e.target.checked
        ? 'On their first Microsoft sign-in, the account is linked when their Entra sign-in name (UPN) matches this username or email. Guests from other tenants are never linked.'
        : 'The user signs in with this username and password, or with HTTP Basic auth from scripts.';
    });
  }

  function editUser(u) {
    modal({
      title: `Edit ${u.username}`,
      body: `<label>Display name<input class="input" id="euName" value="${esc(u.name)}"></label>
        <label>Email<input class="input" id="euEmail" type="email" value="${esc(u.email)}"></label>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: () => patchUser(u.id, { name: $('#euName').value, email: $('#euEmail').value }, 'Saved') }],
    });
  }

  // Can this account sign in at all (the server applies the same rule)?
  const canSignIn = (x) => !x.disabled && (x.hasPassword || (ssoReady && x.sso));
  /** Would removing this user's password leave no admin who can sign in? */
  function removeLocksOut(u) {
    if (u.role !== 'admin' || !canSignIn(u)) return false;
    if (ssoReady && u.sso) return false; // still signs in with Microsoft
    return !users.some((x) => x.id !== u.id && x.role === 'admin' && canSignIn(x));
  }

  function setPassword(u) {
    const self = u.id === UI.state.me.user.id;
    const locked = u.hasPassword && removeLocksOut(u);
    modal({
      title: u.hasPassword ? `Reset password for ${u.username}` : `Set a password for ${u.username}`,
      body: `<label>New password<input class="input" id="rpPw" type="password" autocomplete="new-password" placeholder="At least 10 characters"></label>
        <p style="font-size:12px">${self ? 'Your other sessions will be signed out; you stay signed in here.' : 'The user\'s existing sessions will be signed out.'}</p>
        ${u.hasPassword && locked ? `<p style="font-size:12px" id="rpNoRemove">${self ? 'You are' : 'This is'} the last admin who can sign in, so the password can't be removed. Set up single sign-on and link an admin account first.</p>` : ''}
        ${u.hasPassword && !locked ? `<label class="switch" style="font-weight:500"><input type="checkbox" id="rpRemove"><span class="track"></span>Remove password (single sign-on only)</label>
          ${u.sso ? '' : '<p style="font-size:12px">Accounts with a password are never linked to Microsoft sign-in automatically. Removing the password lets this account be linked on the user\'s next Microsoft sign-in.</p>'}` : ''}`,
      actions: [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => {
        if ($('#rpRemove')?.checked) return patchUser(u.id, { removePassword: true }, 'Password removed');
        const pw = $('#rpPw').value;
        if (!pw) { toast('Enter a password', 'error'); return false; }
        if (pw.length < 10) { toast('Password must be at least 10 characters', 'error'); return false; }
        await patchUser(u.id, { password: pw }, self ? 'Password updated. Your other sessions were signed out.' : 'Password updated');
      } }],
    });
  }

  function deleteUser(u) {
    modal({
      title: `Delete ${u.username}?`,
      body: `<p>${esc(u.name || u.username)} will lose access immediately. If they use single sign-on and auto-create is on, they could be re-created on their next sign-in. Disable the account instead to block them.</p>`,
      actions: [{ label: 'Cancel' }, { label: 'Delete user', cls: 'danger solid', onClick: async () => {
        try {
          await apiJson(`/api/admin/users/${u.id}`, { method: 'DELETE' });
          users = users.filter((x) => x.id !== u.id);
          toast(`Deleted ${u.username}`);
          renderUsers();
        } catch (e) { toast(e.message, 'error'); }
      } }],
    });
  }

  $('#aBody').addEventListener('change', (e) => {
    if (tab !== 'users' || !e.target.matches('[data-role]')) return;
    const id = Number(e.target.closest('tr').dataset.id);
    patchUser(id, { role: e.target.value }, `Role changed to ${roleLabel(e.target.value)}`);
  });
  $('#aBody').addEventListener('click', (e) => {
    if (tab !== 'users') return;
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const u = users.find((x) => x.id === Number(btn.closest('tr').dataset.id));
    if (!u) return;
    const act = btn.dataset.act;
    if (act === 'edit') editUser(u);
    if (act === 'password') setPassword(u);
    if (act === 'toggle') patchUser(u.id, { disabled: !u.disabled }, u.disabled ? `Enabled ${u.username}` : `Disabled ${u.username}`);
    if (act === 'delete') deleteUser(u);
  });

  // ================================================================== SSO
  let sso = null;
  let passwordLogin = true;

  async function loadSso() {
    try {
      [sso, { passwordLogin }] = await Promise.all([apiJson('/api/admin/sso'), apiJson('/api/settings')]);
      renderSso();
    } catch (e) { $('#aBody').innerHTML = `<div class="warn-box">${esc(e.message)}</div>`; }
  }

  function gmRow(g = { groupId: '', role: 'reader' }) {
    return `<div class="gm-row"><input class="input" data-gm-id placeholder="Group object ID (GUID)" value="${esc(g.groupId)}">
      <select class="select" data-gm-role>${roleOptions(g.role)}</select>
      <button class="icon-btn" data-gm-del title="Remove">${ICON.x}</button></div>`;
  }

  function renderSso() {
    head('Single sign-on', 'Microsoft Entra ID (OpenID Connect)',
      sso.ready ? '<span class="tag ok">Enabled</span>' : sso.enabled ? '<span class="tag off">Incomplete</span>' : '<span class="tag">Off</span>');
    $('#aBody').innerHTML = `
      <div class="admin-section">
        <label class="switch"><input type="checkbox" id="sEnabled" ${sso.enabled ? 'checked' : ''}><span class="track"></span><b>Allow sign-in with Microsoft Entra ID</b></label>
      </div>

      <div class="admin-section">
        <h4>App registration</h4>
        <div class="callout"><b>Set up in the Microsoft Entra admin center</b>
          <ol>
            <li><b>App registrations → New registration.</b> Choose <i>Single tenant</i>.</li>
            <li>Under <b>Authentication</b>, add a <b>Web</b> platform with this redirect URI:</li>
          </ol>
          <div class="copy-row" style="margin:8px 0 6px 18px"><input class="input" readonly value="${esc(sso.redirectUri)}" id="sRedirect"><button class="btn sm" id="sCopy">${ICON.copy}Copy</button></div>
          <ol start="3">
            <li><b>Certificates &amp; secrets → New client secret.</b> Paste the secret <i>value</i> below.</li>
            <li>Recommended: under <b>App roles</b>, create roles whose values match the role mapping below, then assign people or groups in <b>Enterprise applications → Users and groups</b>.</li>
          </ol>
        </div>
        <div class="grid2">
          <label class="field">Directory (tenant) ID<input class="input" id="sTenant" value="${esc(sso.tenantId)}" placeholder="00000000-0000-0000-0000-000000000000" spellcheck="false"></label>
          <label class="field">Application (client) ID<input class="input" id="sClient" value="${esc(sso.clientId)}" placeholder="00000000-0000-0000-0000-000000000000" spellcheck="false"></label>
          <label class="field">Client secret<input class="input" id="sSecret" type="password" autocomplete="new-password" placeholder="${sso.hasSecret ? '•••••••• saved (leave blank to keep)' : 'Paste the secret value'}">
            <small>Stored encrypted. ${sso.hasSecret ? 'Enter a new value to replace it.' : ''}</small></label>
          <label class="field">Button label<input class="input" id="sLabel" value="${esc(sso.buttonLabel)}"></label>
          <label class="field" style="grid-column:1/-1">Public URL <small>(optional) Set this when the app runs behind a proxy or load balancer, e.g. https://checkin.contoso.com. The redirect URI is built from it.</small>
            <input class="input" id="sPublic" value="${esc(sso.publicUrl)}" placeholder="https://checkin.contoso.com"></label>
        </div>
      </div>

      <div class="admin-section">
        <h4>Role mapping</h4>
        <p class="muted" style="margin:0;font-size:13px">Roles come from the token's <code>roles</code> claim (app roles) or <code>groups</code> claim. If several match, the highest role wins.</p>
        <div class="grid2">
          ${ROLES.map(([r, l]) => `<label class="field">${esc(l)} app role value<input class="input" data-claim="${r}" value="${esc(sso.roleClaims?.[r] || '')}" spellcheck="false"></label>`).join('')}
        </div>
        <div class="field">Group mapping <small>Requires a groups claim (Token configuration → Add groups claim). App roles are recommended for large tenants.</small></div>
        <div id="gmList" style="display:flex;flex-direction:column;gap:8px">${(sso.groupMap || []).map(gmRow).join('')}</div>
        <div><button class="btn sm" id="gmAdd">${ICON.plus}Add group</button></div>
      </div>

      <div class="admin-section">
        <h4>Provisioning</h4>
        <label class="switch"><input type="checkbox" id="sAuto" ${sso.autoCreate ? 'checked' : ''}><span class="track"></span>Create users automatically on first sign-in</label>
        <label class="switch"><input type="checkbox" id="sSync" ${sso.syncRoles ? 'checked' : ''}><span class="track"></span>Update each user's role from Entra every time they sign in</label>
        <label class="field" style="max-width:360px">Role when no mapping matches
          <select class="select" id="sDefault">${roleOptions(sso.defaultRole, [['none', 'No access (deny sign-in)']])}</select></label>
      </div>

      <div class="admin-section">
        <h4>Password sign-in</h4>
        <div class="grid2">
          <label class="radio-card"><input type="radio" name="pwl" value="all" ${passwordLogin === true ? 'checked' : ''}><span><b>Everyone</b><small>The login page shows both Microsoft sign-in and the username/password form.</small></span></label>
          <label class="radio-card"><input type="radio" name="pwl" value="admins" ${passwordLogin === 'admins' ? 'checked' : ''} ${!sso.ready && passwordLogin !== 'admins' ? 'disabled' : ''}><span><b>Admins only</b><small>Only Microsoft sign-in is shown. Local admins can still sign in with a password (break-glass) via "Administrator sign-in".</small></span></label>
        </div>
        ${!sso.ready ? `<p class="muted" style="margin:0;font-size:12px" id="pwlNote">${passwordLogin === 'admins'
          ? 'Single sign-on isn\'t working, so only admins can sign in right now. Choose Everyone, or finish setting up single sign-on.'
          : '"Admins only" becomes available once single sign-on is set up, turned on and saved; until then nobody else could sign in.'}</p>` : ''}
      </div>`;
    foot(`<button class="btn" id="sTest">Test connection</button><button class="btn primary" id="sSave">Save changes</button>`);

    $('#sCopy').addEventListener('click', () => copy(sso.redirectUri));
    $('#gmAdd').addEventListener('click', () => $('#gmList').insertAdjacentHTML('beforeend', gmRow()));
    $('#gmList').addEventListener('click', (e) => { if (e.target.closest('[data-gm-del]')) e.target.closest('.gm-row').remove(); });
    $('#sSave').addEventListener('click', saveSso);
    $('#sTest').addEventListener('click', testSso);
  }

  async function saveSso() {
    const body = {
      enabled: $('#sEnabled').checked,
      tenantId: $('#sTenant').value.trim(),
      clientId: $('#sClient').value.trim(),
      buttonLabel: $('#sLabel').value.trim() || 'Sign in with Microsoft',
      publicUrl: $('#sPublic').value.trim(),
      autoCreate: $('#sAuto').checked,
      syncRoles: $('#sSync').checked,
      defaultRole: $('#sDefault').value,
      roleClaims: Object.fromEntries($$('[data-claim]').map((i) => [i.dataset.claim, i.value.trim()])),
      groupMap: $$('.gm-row').map((r) => ({ groupId: $('[data-gm-id]', r).value.trim(), role: $('[data-gm-role]', r).value })).filter((g) => g.groupId),
    };
    const secret = $('#sSecret').value;
    if (secret) body.clientSecret = secret;
    const pwl = $('input[name=pwl]:checked')?.value === 'admins' ? 'admins' : true;
    $('#sSave').disabled = true;
    try {
      // Opening password sign-in up goes first (so SSO can then be turned off in the same save);
      // limiting it to admins goes last (it needs single sign-on to be saved and working).
      if (pwl === true && pwl !== passwordLogin) passwordLogin = (await apiJson('/api/settings', json('PUT', { passwordLogin: pwl }))).passwordLogin;
      sso = await apiJson('/api/admin/sso', json('PUT', body));
      if (pwl !== passwordLogin) passwordLogin = (await apiJson('/api/settings', json('PUT', { passwordLogin: pwl }))).passwordLogin;
      toast('Single sign-on settings saved');
      renderSso();
    } catch (e) {
      toast(e.message, 'error');
      $('#sSave').disabled = false;
    }
  }

  async function testSso() {
    $('#sTest').disabled = true;
    try {
      const r = await apiJson('/api/admin/sso/test', { method: 'POST' });
      modal({
        title: 'Connection OK',
        body: `<p>Discovery succeeded for <code>${esc(r.issuer)}</code>.</p>
          <p style="font-size:12px">This checks the tenant ID. The client ID and secret are only verified on a real sign-in, so open the login page in a private window and try <b>${esc(sso.buttonLabel)}</b>.</p>`,
        actions: [{ label: 'OK', cls: 'primary' }],
      });
    } catch (e) { toast(e.message, 'error'); }
    $('#sTest').disabled = false;
  }

  // ================================================================== API key
  async function loadApiKey() {
    try { renderApiKey(await apiJson('/api/admin/apikey')); } catch (e) { $('#aBody').innerHTML = `<div class="warn-box">${esc(e.message)}</div>`; }
  }

  function renderApiKey(info) {
    head('API key', 'For devices and scripts that check in or call the API');
    const origin = location.origin;
    const isAdmin = UI.can('apiKeyPolicy');
    const masked = info.key ? info.key.slice(0, 6) + '•'.repeat(Math.max(8, info.key.length - 6)) : '';
    $('#aBody').innerHTML = `
      <div class="admin-section">
        <div class="radio-card" style="cursor:default;flex-direction:column;align-items:stretch;gap:12px">
          <span class="status-line">${info.required ? '<i class="dot fresh"></i><b>Required for check-ins</b>' : '<i class="dot aging"></i><b>Not required: anyone who can reach the server can check in</b>'}</span>
          ${info.key
            ? `<div class="copy-row"><input class="input" id="kValue" readonly value="${esc(masked)}" data-shown="0" spellcheck="false">
                 <button class="btn" id="kShow">Show</button><button class="btn" id="kCopy">Copy</button></div>`
            : info.set
              ? `<div class="warn-box" style="margin:0">This key (starts with <code>${esc(info.prefix)}…</code>) was saved by an older version, which stored it in a form that can't be shown again. Set <code>API_KEY</code> to the same key and restart to make it viewable, or regenerate it.</div>`
              : ''}
          <small class="muted">${info.set ? `Created ${esc(relTime(info.created))}${info.createdBy ? ' by ' + esc(info.createdBy) : ''}. ` : ''}Power users and admins can see it here and on the Add Device page, which puts it into the install command.</small>
          <span style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn primary" id="kGen">${info.set ? 'Regenerate' : 'Generate key'}</button>
            ${isAdmin ? '<button class="btn" id="kSet">Use my own</button>' : ''}
          </span>
        </div>
      </div>
      ${isAdmin ? `<div class="admin-section">
        <h4>Requirement</h4>
        <label class="switch"><input type="checkbox" id="kRequired" ${info.required ? 'checked' : ''}><span class="track"></span>Require the API key for check-ins</label>
        <p class="muted" style="margin:0;font-size:12px">On by default. When off, anyone who can reach the server can send check-ins; reading data still needs a sign-in. Only admins can change this.</p>
      </div>` : ''}
      <div class="admin-section">
        <h4>What the key allows</h4>
        <div class="callout">
          The API key acts like a <b>User</b>: it can check in, read records and history, import, export and delete records.
          It cannot clear all records or change settings. It's stored encrypted, and only power users and admins can see or regenerate it.
        </div>
      </div>
      <div class="admin-section">
        <h4>Usage</h4>
        <pre class="key-reveal" style="border-style:solid;border-color:var(--border);white-space:pre-wrap">curl -X POST "${esc(origin)}/api/checkin?id=device-1&amp;status=ok" -H "X-API-Key: &lt;key&gt;"

Invoke-RestMethod -Method Post "${esc(origin)}/api/checkin?id=device-1&amp;status=ok" -Headers @{ "X-API-Key" = "&lt;key&gt;" }</pre>
        <p class="muted" style="margin:0;font-size:12px">You can also send <code>Authorization: Bearer &lt;key&gt;</code> or <code>?api_key=&lt;key&gt;</code>. Scripts can use a user account instead, with HTTP Basic auth (<code>curl -u user:password</code>), and get that user's role.</p>
      </div>`;
    $('#kShow')?.addEventListener('click', (e) => {
      const el = $('#kValue');
      const shown = el.dataset.shown === '1';
      el.value = shown ? masked : info.key;
      el.dataset.shown = shown ? '0' : '1';
      e.target.textContent = shown ? 'Show' : 'Hide';
    });
    $('#kCopy')?.addEventListener('click', () => copy(info.key));
    $('#kGen').addEventListener('click', () => {
      const go = async () => {
        try {
          const r = await apiJson('/api/admin/apikey', json('POST', { action: 'generate' }));
          renderApiKey(r);
          UI.state.config.apiKeySet = true;
          toast('New API key created. Update your devices with it.');
        } catch (e) { toast(e.message, 'error'); }
      };
      if (!info.set) return go();
      modal({
        title: 'Regenerate API key?',
        body: '<div class="warn-box">The current key stops working immediately. Every device using it must be updated: run the install command from Add Device again, or edit the key in its settings file.</div>',
        actions: [{ label: 'Cancel' }, { label: 'Regenerate', cls: 'danger solid', onClick: go }],
      });
    });
    $('#kSet')?.addEventListener('click', () => modal({
      title: 'Use your own API key',
      body: '<label>API key<input class="input" id="kCustom" type="password" autocomplete="off" placeholder="16–256 characters, no spaces"></label><p style="font-size:12px">Use this to keep an existing key that devices already have. Letters, numbers and punctuation (printable ASCII) only, no spaces.</p>',
      actions: [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => {
        try {
          renderApiKey(await apiJson('/api/admin/apikey', json('POST', { action: 'set', key: $('#kCustom').value })));
          UI.state.config.apiKeySet = true;
          toast('API key saved');
        } catch (e) { toast(e.message, 'error'); return false; }
      } }],
    }));
    $('#kRequired')?.addEventListener('change', (e) => {
      const required = e.target.checked;
      const apply = async () => {
        try {
          renderApiKey(await apiJson('/api/admin/apikey', json('POST', { action: 'require', required })));
          UI.state.config.apiKeyRequired = required;
          toast(required ? 'Check-ins now require the API key' : 'Check-ins no longer require the API key');
        } catch (err) { toast(err.message, 'error'); renderApiKey(info); }
      };
      if (required) return apply();
      e.target.checked = true; // stays on unless confirmed
      modal({
        title: 'Stop requiring the API key?',
        body: '<div class="warn-box">Anyone who can reach this server will be able to create and change records by checking in.</div>',
        actions: [{ label: 'Cancel' }, { label: 'Stop requiring it', cls: 'danger solid', onClick: apply }],
      });
    });
  }

  // ================================================================== HTTPS / TLS
  let tlsState = null;
  let tlsSource = 'pem';
  let acmeState = null;
  let deployKeys = [];

  async function loadTls() {
    try {
      [tlsState, acmeState, deployKeys] = await Promise.all([
        apiJson('/api/admin/tls'), apiJson('/api/admin/tls/acme'), apiJson('/api/admin/tls/deploy-keys').then((r) => r.keys),
      ]);
      renderTls();
    } catch (e) { $('#aBody').innerHTML = `<div class="warn-box">${esc(e.message)}</div>`; }
  }

  function tlsStatusTag(st) {
    if (st.disabledByEnv) return '<span class="tag off">Disabled by TLS_DISABLE</span>';
    if (st.listening) return `<span class="tag ok">On · port ${st.listeningPort}</span>`;
    if (st.error) return '<span class="tag off">Error</span>';
    return '<span class="tag">Off</span>';
  }

  function certCard(c, st) {
    if (!c) return '<div class="radio-card" style="cursor:default"><span><b>No certificate installed</b><small>Install one below: your own certificate (PEM or PFX), or a self-signed one for testing.</small></span></div>';
    const days = c.daysLeft;
    const exp = c.expired ? '<span class="tag off">Expired</span>' : days < 30 ? `<span class="tag off">Expires in ${days} days</span>` : `<span class="tag ok">${days} days left</span>`;
    const src = { pem: 'PEM upload', pfx: 'PFX upload', 'self-signed': 'Generated (self-signed)', acme: 'Automatic (ACME)', deploy: 'Deploy key' }[st.source] || 'Files in the data volume';
    return `<div class="radio-card" style="cursor:default;flex-direction:column;align-items:stretch;gap:10px">
      <div class="status-line" style="justify-content:space-between;flex-wrap:wrap">
        <span class="status-line"><i class="dot ${c.expired ? 'stale' : days < 30 ? 'aging' : 'fresh'}"></i><b>${esc(c.subject)}</b>${c.selfSigned ? '<span class="tag">Self-signed</span>' : ''}</span>${exp}</div>
      <table class="kv" style="font-size:13px">
        <tr><td>Names</td><td>${c.names.length ? c.names.map((n) => `<span class="tag">${esc(n)}</span>`).join(' ') : '<span class="muted">none (subject only)</span>'}</td></tr>
        <tr><td>Issuer</td><td>${esc(c.issuer)}</td></tr>
        <tr><td>Valid</td><td>${esc(absTime(c.validFrom))} → ${esc(absTime(c.validTo))}</td></tr>
        <tr><td>Key</td><td>${esc((c.keyType || '').toUpperCase())}</td></tr>
        <tr><td>SHA-256</td><td><code style="word-break:break-all">${esc(c.fingerprint256)}</code></td></tr>
        <tr><td>Source</td><td>${esc(src)}${st.uploadedAt ? ` · ${esc(relTime(st.uploadedAt))}${st.uploadedBy ? ' by ' + esc(st.uploadedBy) : ''}` : ''}</td></tr>
      </table>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn sm" id="tDownload">${ICON.download}Download certificate</button>
        <button class="btn sm danger" id="tRemove" ${st.savedMode !== 'off' ? 'disabled title="Turn HTTPS off first"' : ''}>${ICON.trash}Remove</button>
      </div></div>`;
  }

  function installForm() {
    const host = location.hostname;
    const seg = (k, l) => `<button data-src="${k}" class="${tlsSource === k ? 'active' : ''}">${l}</button>`;
    let form = '';
    if (tlsSource === 'pem') {
      form = `<div class="grid2">
        <label class="field">Certificate (.pem, .crt, .cer)<input class="input" type="file" id="tCert" accept=".pem,.crt,.cer,.txt"><small>Include intermediate certificates (full chain) after your certificate.</small></label>
        <label class="field">Private key (.key, .pem)<input class="input" type="file" id="tKey" accept=".key,.pem,.txt"></label>
        <label class="field"><span class="field-label">Key password <small>(only if the key is encrypted)</small></span><input class="input" type="password" id="tKeyPass" autocomplete="off"></label></div>`;
    } else if (tlsSource === 'pfx') {
      form = `<div class="grid2">
        <label class="field">PFX / PKCS#12 file (.pfx, .p12)<input class="input" type="file" id="tPfx" accept=".pfx,.p12"><small>The usual export format from Windows certificate stores and many CAs.</small></label>
        <label class="field">Password<input class="input" type="password" id="tPfxPass" autocomplete="off"><small>Stored encrypted with the app secret.</small></label></div>`;
    } else {
      form = `<div class="callout">Self-signed certificates encrypt traffic, but browsers and devices show a warning unless they're set to trust it. Use for testing, or download it afterwards and install it as trusted on your clients. For production, use a certificate from your CA.</div>
        <div class="grid2">
        <label class="field">Host names and IP addresses<input class="input" id="tHosts" value="${esc([host, host === 'localhost' ? '' : 'localhost'].filter(Boolean).join(', '))}"><small>Comma-separated: every name clients use to reach the server.</small></label>
        <label class="field">Valid for (days)<input class="input" type="number" id="tDays" min="1" max="3650" value="365"></label></div>`;
    }
    return `<div class="seg text" id="tSrc">${seg('pem', 'PEM files')}${seg('pfx', 'PFX / P12')}${seg('self-signed', 'Generate self-signed')}</div>
      ${form}
      <div><button class="btn primary" id="tInstall">${tlsState.cert ? 'Replace certificate' : 'Install certificate'}</button></div>`;
  }

  function renderTls() {
    const st = tlsState;
    head('HTTPS', 'Serve the dashboard and API over TLS without a reverse proxy', tlsStatusTag(st));
    const mode = st.savedMode;
    const radio = (v, title, desc) => `<label class="radio-card"><input type="radio" name="tlsMode" value="${v}" ${mode === v ? 'checked' : ''} ${v !== 'off' && !st.cert ? 'disabled' : ''}><span><b>${title}</b><small>${desc}</small></span></label>`;
    $('#aBody').innerHTML = `
      ${st.disabledByEnv ? '<div class="warn-box">HTTPS is forced off by the <code>TLS_DISABLE=true</code> environment variable. Settings can be changed but won\'t take effect until it\'s removed.</div>' : ''}
      ${st.error && !st.disabledByEnv ? `<div class="warn-box">${esc(st.error)}</div>` : ''}
      <div class="admin-section">
        <h4>Certificate</h4>
        ${certCard(st.cert, st)}
      </div>
      <div class="admin-section">
        <h4>Mode</h4>
        <div style="display:grid;gap:8px">
          ${radio('off', 'Off', 'HTTP only. Use this when a reverse proxy or load balancer handles HTTPS.')}
          ${radio('both', 'HTTPS and HTTP', 'Both work. Useful while moving devices over, or for devices that can only speak HTTP.')}
          ${radio('redirect', 'HTTPS only', 'HTTP requests are redirected to HTTPS (307, keeps POST bodies). <code>/health</code> stays on HTTP for container health checks.')}
        </div>
        <label class="switch"><input type="checkbox" id="tHsts" ${st.hsts ? 'checked' : ''}><span class="track"></span>Send HSTS (browsers will insist on HTTPS for this host for a year)</label>
        <div class="grid2">
          <label class="field"><span class="field-label">Public HTTPS port <small>(optional)</small></span><input class="input" type="number" id="tPublicPort" min="1" max="65535" placeholder="${st.httpsPort}" value="${st.publicPort ?? ''}">
            <small>The port clients use, if different from the one the server listens on, e.g. 443 when Docker maps <code>443:${st.httpsPort}</code>. Used for redirects.</small></label>
          <div class="field">Listening port<div class="input" style="display:flex;align-items:center;background:var(--surface-2)">${st.httpsPort} <span class="muted" style="margin-left:6px">(HTTPS_PORT)</span></div>
            <small>Set with the <code>HTTPS_PORT</code> environment variable. In Docker, publish it: <code>"443:${st.httpsPort}"</code>.</small></div>
        </div>
        <p class="muted" style="margin:0;font-size:12px">Using Entra sign-in over HTTPS? Set <b>Public URL</b> in Single sign-on to your <code>https://</code> address and add that redirect URI in Entra. If you lock yourself out, start the container with <code>TLS_DISABLE=true</code>.</p>
      </div>
      <div class="admin-section" id="acmeSection">${acmeHtml()}</div>
      <div class="admin-section">
        <h4>${st.cert ? 'Replace with your own certificate' : 'Install your own certificate'}</h4>
        <div id="tForm" class="install-form">${installForm()}</div>
        <p class="muted" style="margin:0;font-size:12px">Certificates are saved in the data volume (<code>data/tls</code>) and survive container rebuilds. You can also copy <code>cert.pem</code> and <code>key.pem</code> into that folder (for example from certbot); changes are picked up within a minute.</p>
      </div>
      <div class="admin-section" id="deploySection">${deployHtml()}</div>
      <div class="admin-section">
        <h4>Certificate history</h4>
        ${historyHtml(st.events || [])}
      </div>`;
    foot('<button class="btn primary" id="tSave">Save HTTPS settings</button>');

    // Delegate on the container: the source switcher is re-rendered with the form.
    $('#tForm').addEventListener('click', (e) => {
      const b = e.target.closest('[data-src]');
      if (!b || b.dataset.src === tlsSource) return;
      tlsSource = b.dataset.src;
      $('#tForm').innerHTML = installForm();
      wireInstall();
    });
    wireInstall();
    $('#tDownload')?.addEventListener('click', downloadCert);
    $('#tRemove')?.addEventListener('click', () => modal({
      title: 'Remove the certificate?',
      body: '<p>The certificate and key are deleted from the data volume.</p>',
      actions: [{ label: 'Cancel' }, { label: 'Remove', cls: 'danger solid', onClick: async () => {
        try { tlsState = await apiJson('/api/admin/tls/certificate', { method: 'DELETE' }); renderTls(); toast('Certificate removed'); } catch (e) { toast(e.message, 'error'); }
      } }],
    }));
    $('#tSave').addEventListener('click', saveTls);
    wireAcme();
    wireDeploy();
  }

  // ---- history ----
  function historyHtml(events) {
    if (!events.length) return '<p class="muted" style="margin:0">Nothing yet. Uploads, deploys, automatic renewals and files picked up from the data volume are listed here.</p>';
    const what = { upload: 'Uploaded', deploy: 'Deploy', acme: 'ACME', file: 'Picked up from files' };
    return `<table class="utable cert-history"><thead><tr><th>When</th><th>What</th><th>Result</th></tr></thead><tbody>${events.map((e) => `<tr>
      <td title="${esc(absTime(e.at))}">${esc(relTime(e.at))}</td>
      <td>${esc(what[e.action] || e.action)}${e.by ? ` <span class="muted">· ${esc(e.by)}</span>` : ''}${e.ip ? ` <span class="muted">from ${esc(e.ip)}</span>` : ''}${e.reason === 'renewal' ? ' <span class="tag">automatic renewal</span>' : ''}${e.forced ? ' <span class="tag">forced</span>' : ''}</td>
      <td>${e.ok ? `<span class="tag ok">OK</span> ${esc(e.subject || '')}${e.validTo ? ` <span class="muted">until ${esc(new Date(e.validTo).toLocaleDateString())}</span>` : ''}` : `<span class="tag off">Failed</span> <span class="cert-err">${esc(e.error || '')}</span>`}</td></tr>`).join('')}</tbody></table>`;
  }

  // ---- automatic certificates (ACME / Let's Encrypt, HTTP-01) ----
  function acmeHtml() {
    const a = acmeState || {};
    const custom = a.ca === 'custom';
    const status = a.running ? `<span class="tag">Working…</span> <span class="muted" id="acmeProgress">${esc(a.progress || '')}</span>`
      : a.lastError ? `<span class="tag off">Last attempt failed</span> <span class="muted">${esc(relTime(a.lastAttempt))}${a.nextAttempt && Date.parse(a.nextAttempt) > Date.now() + 60_000 ? ` · retrying automatically at ${esc(new Date(a.nextAttempt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }))}` : a.enabled ? ' · retrying soon' : ''}</span>`
        : a.active ? `<span class="tag ok">Active</span> <span class="muted">renews automatically around ${esc(new Date(a.renewAt).toLocaleDateString())}</span>`
          : a.enabled ? '<span class="tag">On</span> <span class="muted">no certificate from it yet: click Get certificate now</span>' : '<span class="tag">Off</span>';
    return `<h4>Automatic certificate (Let's Encrypt)</h4>
      <div class="status-line" style="flex-wrap:wrap;gap:6px">${status}</div>
      ${a.lastError ? `<div class="warn-box" style="margin:0">${esc(a.lastError)}</div>` : ''}
      <div class="callout">Gets a free certificate and renews it on its own (30 days before it expires) using the <b>HTTP-01</b> check:
        the certificate authority fetches <code>http://&lt;your domain&gt;/.well-known/acme-challenge/…</code> on <b>port 80</b>, so each domain must point here and port 80 must reach this server's HTTP port
        (in Docker: <code>"80:3000"</code>). It works in every HTTPS mode. Behind a reverse proxy that already gets certificates (Caddy, Traefik), you don't need this.</div>
      <label class="switch"><input type="checkbox" id="acEnabled" ${a.enabled ? 'checked' : ''}><span class="track"></span><b>Get and renew a certificate automatically</b></label>
      <div class="grid2">
        <label class="field">Domain names<input class="input" id="acDomains" value="${esc((a.domains || []).join(', '))}" placeholder="checkin.example.com" spellcheck="false"><small>Comma-separated; every name devices and browsers use. No wildcards, IP addresses or internal names.</small></label>
        <label class="field"><span class="field-label">Email <small>(optional)</small></span><input class="input" id="acEmail" type="email" value="${esc(a.email || '')}" placeholder="it@example.com"><small>For notices from the certificate authority.</small></label>
        <label class="field">Certificate authority<select class="select" id="acCa">
          <option value="letsencrypt" ${a.ca === 'letsencrypt' ? 'selected' : ''}>Let's Encrypt</option>
          <option value="letsencrypt-staging" ${a.ca === 'letsencrypt-staging' ? 'selected' : ''}>Let's Encrypt staging (testing: not trusted by browsers)</option>
          <option value="custom" ${custom ? 'selected' : ''}>Another ACME CA…</option></select></label>
        <label class="field">Key type<select class="select" id="acKey">
          <option value="ecdsa" ${a.keyType !== 'rsa' ? 'selected' : ''}>ECDSA P-256 (recommended)</option>
          <option value="rsa" ${a.keyType === 'rsa' ? 'selected' : ''}>RSA 2048 (for old clients)</option></select></label>
      </div>
      <div class="grid2" id="acCustom" ${custom ? '' : 'hidden'}>
        <label class="field">ACME directory URL<input class="input" id="acDir" value="${esc(a.directoryUrl || '')}" placeholder="https://acme.example.com/directory" spellcheck="false"><small>e.g. ZeroSSL, Google Trust Services, Sectigo, DigiCert, or your own step-ca. Its certificate must be trusted by this server (<code>NODE_EXTRA_CA_CERTS</code> for a private CA).</small></label>
        <div class="grid2" style="gap:10px">
          <label class="field"><span class="field-label">EAB key ID <small>(if required)</small></span><input class="input" id="acKid" value="${esc(a.eabKid || '')}" spellcheck="false"></label>
          <label class="field"><span class="field-label">EAB HMAC key</span><input class="input" id="acHmac" type="password" autocomplete="off" placeholder="${a.eabHmacSet ? 'saved (leave empty to keep)' : ''}"></label>
        </div>
      </div>
      ${a.enabled ? '' : `<label class="checkline"><input type="checkbox" id="acTos"> I accept the certificate authority's terms of service (<a href="https://letsencrypt.org/repository/" target="_blank" rel="noopener">Let's Encrypt</a>)</label>`}
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="acSave">Save</button>
        <button class="btn primary" id="acObtain" ${a.enabled && !a.running ? '' : 'disabled'} title="${a.enabled ? 'Request a certificate now (takes up to a minute)' : 'Turn it on and save first'}">Get certificate now</button>
      </div>
      ${a.account ? `<small class="muted">ACME account: <code style="word-break:break-all">${esc(a.account)}</code></small>` : ''}`;
  }

  function wireAcme() {
    $('#acCa').addEventListener('change', (e) => { $('#acCustom').hidden = e.target.value !== 'custom'; });
    $('#acSave').addEventListener('click', saveAcme);
    $('#acObtain').addEventListener('click', obtainAcme);
  }

  async function saveAcme() {
    const body = {
      enabled: $('#acEnabled').checked,
      domains: $('#acDomains').value,
      email: $('#acEmail').value,
      ca: $('#acCa').value,
      keyType: $('#acKey').value,
    };
    if (body.ca === 'custom') {
      body.directoryUrl = $('#acDir').value;
      body.eabKid = $('#acKid').value;
      if ($('#acHmac').value) body.eabHmac = $('#acHmac').value;
    }
    if ($('#acTos')) body.agreeTos = $('#acTos').checked;
    try {
      acmeState = await apiJson('/api/admin/tls/acme', json('PUT', body));
      $('#acmeSection').innerHTML = acmeHtml();
      wireAcme();
      toast(body.enabled && !acmeState.active ? 'Saved. Click "Get certificate now" to request one.' : 'Saved');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function obtainAcme() {
    $('#acObtain').disabled = true;
    $('#acObtain').textContent = 'Working…';
    // Show progress while the request runs (it waits for the certificate authority).
    const poll = setInterval(async () => {
      try {
        const a = await apiJson('/api/admin/tls/acme');
        if (a.progress && $('#acObtain')) $('#acObtain').textContent = a.progress.length > 70 ? a.progress.slice(0, 70) + '…' : a.progress;
      } catch { /* ignore */ }
    }, 1500);
    try {
      const r = await apiJson('/api/admin/tls/acme/obtain', { method: 'POST' });
      toast(`Certificate installed for ${r.installed.names.join(', ')}${r.tls.listening ? '. HTTPS reloaded' : '. Turn HTTPS on under Mode to use it'}`);
    } catch (e) { toast(e.message, 'error'); }
    clearInterval(poll);
    await loadTls();
  }

  // ---- deploy keys (automation replaces the certificate, nothing else) ----
  function deployHtml() {
    const rows = deployKeys.map((k) => `<tr data-id="${esc(k.id)}">
      <td><b>${esc(k.name)}</b><br><code class="muted">${esc(k.prefix)}…</code></td>
      <td>${k.allowIps.length ? k.allowIps.map((ip) => `<span class="tag">${esc(ip)}</span>`).join(' ') : '<span class="muted">anywhere</span>'}</td>
      <td>${k.lastUsed ? `${esc(relTime(k.lastUsed))}<br><small class="muted">${esc(k.lastIp || '')} · ${nf.format(k.uses || 0)}×</small>` : '<span class="muted">never</span>'}</td>
      <td style="text-align:right;white-space:nowrap"><button class="btn sm" data-dk-edit>Edit</button> <button class="btn sm danger" data-dk-revoke>Revoke</button></td></tr>`).join('');
    return `<h4>Deploy keys</h4>
      <p class="muted" style="margin:0;font-size:13px">For automation that renews certificates elsewhere (a certbot or acme.sh hook, a CI job, a key vault task). A deploy key can <b>only replace the certificate</b>: it can't read data or change anything else. Not the same as the device API key.</p>
      ${acmeState?.enabled ? '<div class="warn-box" style="margin:0">Automatic certificates are on, so a pushed or uploaded certificate is replaced at the next check (within 6 hours). Turn automatic certificates off to manage the certificate with deploy keys.</div>' : ''}
      ${deployKeys.length ? `<table class="utable"><thead><tr><th>Name</th><th>Allowed from</th><th>Last used</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : ''}
      <div><button class="btn" id="dkNew">${ICON.plus}New deploy key</button></div>`;
  }

  function wireDeploy() {
    $('#dkNew').addEventListener('click', () => deployKeyDialog());
    $('#deploySection').querySelectorAll('[data-dk-edit]').forEach((b) => b.addEventListener('click', () => {
      deployKeyDialog(deployKeys.find((k) => k.id === b.closest('tr').dataset.id));
    }));
    $('#deploySection').querySelectorAll('[data-dk-revoke]').forEach((b) => b.addEventListener('click', () => {
      const k = deployKeys.find((x) => x.id === b.closest('tr').dataset.id);
      modal({
        title: 'Revoke deploy key?',
        body: `<p><b>${esc(k.name)}</b> (<code>${esc(k.prefix)}…</code>) stops working immediately. The installed certificate isn't changed.</p>`,
        actions: [{ label: 'Cancel' }, { label: 'Revoke', cls: 'danger solid', onClick: async () => {
          try { await apiJson(`/api/admin/tls/deploy-keys/${k.id}`, { method: 'DELETE' }); toast('Deploy key revoked'); await loadTls(); } catch (e) { toast(e.message, 'error'); }
        } }],
      });
    }));
  }

  function deployKeyDialog(k) {
    modal({
      title: k ? 'Edit deploy key' : 'New deploy key',
      body: `<label>Name<input class="input" id="dkName" maxlength="60" value="${esc(k?.name || '')}" placeholder="e.g. certbot on web-01"></label>
        <label>Allowed from <small class="muted">(optional)</small><input class="input" id="dkIps" value="${esc((k?.allowIps || []).join(', '))}" placeholder="10.0.0.5, 10.0.0.0/24" spellcheck="false"></label>
        <p style="font-size:12px">Addresses or ranges the key may be used from, comma-separated. Empty = anywhere. Behind a reverse proxy, set <code>TRUST_PROXY</code> so the server sees the real address.</p>`,
      actions: [{ label: 'Cancel' }, { label: k ? 'Save' : 'Create key', cls: 'primary', onClick: async () => {
        const body = { name: $('#dkName').value, allowIps: $('#dkIps').value };
        try {
          if (k) { await apiJson(`/api/admin/tls/deploy-keys/${k.id}`, json('PUT', body)); toast('Deploy key saved'); await loadTls(); return; }
          const r = await apiJson('/api/admin/tls/deploy-keys', json('POST', body));
          await loadTls();
          setTimeout(() => showNewDeployKey(r.key), 0);
        } catch (e) { toast(e.message, 'error'); return false; }
      } }],
    });
  }

  function showNewDeployKey(key) {
    const origin = location.origin;
    const curl = `cat fullchain.pem privkey.pem | curl -fsS -X PUT "${origin}/api/tls/certificate" \\\n  -H "X-Deploy-Key: ${key}" -H "Content-Type: application/x-pem-file" --data-binary @-`;
    const certbot = `certbot renew --deploy-hook 'cat "$RENEWED_LINEAGE/fullchain.pem" "$RENEWED_LINEAGE/privkey.pem" | curl -fsS -X PUT "${origin}/api/tls/certificate" -H "X-Deploy-Key: ${key}" -H "Content-Type: application/x-pem-file" --data-binary @-'`;
    const ps = `Invoke-RestMethod -Method Put "${origin}/api/tls/certificate" -Headers @{ "X-Deploy-Key" = "${key}"; "X-Pfx-Password" = "<pfx password>" } -ContentType "application/x-pkcs12" -InFile .\\cert.pfx`;
    modal({
      title: 'Deploy key created',
      body: `<div class="warn-box" style="margin:0 0 10px">Copy it now: it isn't shown again (only a hash is kept).</div>
        <div class="copy-row"><input class="input mono" id="dkKey" readonly value="${esc(key)}"><button class="btn" id="dkCopy">${ICON.copy}Copy</button></div>
        <p style="font-size:12px;margin-top:12px"><b>Send a certificate</b> (PEM chain + key in one body; the server checks it and swaps it in live):</p>
        <pre class="key-reveal" style="white-space:pre-wrap;font-size:11px">${esc(curl)}</pre>
        <p style="font-size:12px"><b>certbot</b>, after each renewal:</p>
        <pre class="key-reveal" style="white-space:pre-wrap;font-size:11px">${esc(certbot)}</pre>
        <p style="font-size:12px"><b>PowerShell</b> with a .pfx (JSON <code>{"cert","key"}</code> or <code>{"pfx": base64, "passphrase"}</code> works too):</p>
        <pre class="key-reveal" style="white-space:pre-wrap;font-size:11px">${esc(ps)}</pre>
        <p style="font-size:12px">The new certificate must not expire before the current one and must share a name with it, unless you add <code>?force=1</code>. Every attempt shows in the certificate history.</p>`,
      wide: true,
      actions: [{ label: 'Done', cls: 'primary' }],
    });
    $('#dkCopy').addEventListener('click', () => copy(key));
  }

  function wireInstall() {
    $('#tSrc').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.src === tlsSource));
    $('#tInstall').addEventListener('click', installCert);
  }

  const readText = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); });
  const readB64 = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = rej;
    r.readAsDataURL(file);
  });

  async function installCert() {
    let body;
    try {
      if (tlsSource === 'pem') {
        const c = $('#tCert').files[0];
        const k = $('#tKey').files[0];
        if (!c || !k) { toast('Choose both the certificate and the private key', 'error'); return; }
        body = { type: 'pem', cert: await readText(c), key: await readText(k), passphrase: $('#tKeyPass').value };
      } else if (tlsSource === 'pfx') {
        const f = $('#tPfx').files[0];
        if (!f) { toast('Choose a .pfx or .p12 file', 'error'); return; }
        body = { type: 'pfx', pfx: await readB64(f), passphrase: $('#tPfxPass').value };
      } else {
        const d = $('#tDays').value.trim();
        const days = d === '' ? 365 : Number(d);
        if (!Number.isInteger(days) || days < 1 || days > 3650) { toast('Valid for (days) must be a whole number from 1 to 3650', 'error'); return; }
        body = { type: 'self-signed', hostnames: $('#tHosts').value, days };
      }
    } catch { toast('Could not read the file', 'error'); return; }
    $('#tInstall').disabled = true;
    try {
      const r = await apiJson('/api/admin/tls/certificate', json('POST', body));
      tlsState = r;
      renderTls();
      toast(`Installed certificate for ${r.installed.subject}${r.listening ? '. HTTPS reloaded' : ''}`);
    } catch (e) {
      toast(e.message, 'error');
      $('#tInstall').disabled = false;
    }
  }

  async function downloadCert() {
    try {
      const res = await UI.api('/api/admin/tls/certificate.pem');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = 'check-in-certificate.pem';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function saveTls() {
    const mode = $('input[name=tlsMode]:checked')?.value || 'off';
    const pp = $('#tPublicPort').value.trim();
    const body = { mode, hsts: $('#tHsts').checked, publicPort: pp ? Number(pp) : null };
    $('#tSave').disabled = true;
    try {
      tlsState = await apiJson('/api/admin/tls', json('PUT', body));
      renderTls();
      if (tlsState.listening && location.protocol === 'http:') {
        const port = tlsState.publicPort || tlsState.listeningPort;
        const url = `https://${location.hostname}${port === 443 ? '' : ':' + port}${location.pathname}`;
        modal({
          title: 'HTTPS is on',
          body: `<p>The server is now listening for HTTPS on port ${tlsState.listeningPort}.${mode === 'redirect' ? ' Plain HTTP now redirects there.' : ''}</p>
            <p><code>${esc(url)}</code></p>
            ${tlsState.cert?.selfSigned ? '<p style="font-size:12px">Your browser will warn about the self-signed certificate until you trust it.</p>' : ''}`,
          actions: [{ label: 'Stay here' }, { label: 'Open HTTPS', cls: 'primary', onClick: () => { location.href = url; } }],
        });
      } else {
        toast(mode === 'off' ? 'HTTPS turned off' : 'HTTPS settings saved');
      }
    } catch (e) {
      toast(e.message, 'error');
      $('#tSave').disabled = false;
    }
  }

  // ================================================================== Port checks
  // ---- issues list on/off ----
  async function loadIssuesAdmin() {
    let cfg;
    try { cfg = await apiJson('/api/issues/config'); } catch (e) { $('#aBody').innerHTML = `<div class="warn-box">${esc(e.message)}</div>`; return; }
    head('Issues', 'Track problems on devices: who is on them, notes and history', cfg.enabled ? '<span class="tag ok">On</span>' : '<span class="tag">Off</span>');
    const rules = cfg.rules.filter((r) => r.enabled);
    $('#aBody').innerHTML = `
      <div class="admin-section">
        <label class="switch"><input type="checkbox" id="isEnabled" ${cfg.enabled ? 'checked' : ''}><span class="track"></span><b>Turn on the issues list</b></label>
        <p class="muted" style="margin:0;font-size:12px">Adds an <b>Issues</b> page (button at the top of the dashboard). The server opens an issue when a device breaks one of the issue rules and adds further problems to the same issue. Everyone can see issues; Users and up can assign, ignore, close and add notes; Power users and admins define the rules and can clear the list.</p>
      </div>
      <div class="admin-section">
        <h4>When a problem clears on its own</h4>
        <label class="switch"><input type="checkbox" id="isAutoClose" ${cfg.autoClose !== false ? 'checked' : ''}><span class="track"></span><b>Close issues automatically when every problem has cleared</b></label>
        <p class="muted" style="margin:0;font-size:12px">${cfg.autoClose !== false
          ? 'On: each problem leaves the issue when its clear rule is met, and the issue closes by itself once none are left.'
          : 'Off: problems still clear and are noted in the log, but the issue stays open, marked <b>All clear</b>, until someone closes it. A problem that starts again joins the same issue.'}
          Turning this back on closes the issues that are already all clear.</p>
      </div>
      <div class="admin-section">
        <h4>Rules</h4>
        ${rules.length ? `<table class="utable"><thead><tr><th>Name</th><th>Opens when</th><th>Clears when</th></tr></thead><tbody>${rules.map((r) => `<tr><td><b>${esc(r.name)}</b></td><td>${esc(r.text)}</td><td>${esc(r.clearText)}</td></tr>`).join('')}</tbody></table>`
          : '<p class="muted" style="margin:0">No rules yet.</p>'}
        <p class="muted" style="margin:0;font-size:12px">Rules and the reassign window (now ${cfg.reassignMinutes ? `${cfg.reassignMinutes} min` : 'off'}) are edited on the Issues page with <b>Issue rules</b>.</p>
        <div><a class="btn" href="/issues">Open the Issues page</a></div>
      </div>`;
    $('#isAutoClose').addEventListener('change', async (e) => {
      try {
        await apiJson('/api/admin/issues', json('PUT', { autoClose: e.target.checked }));
        toast(e.target.checked ? 'Issues close automatically when they clear' : 'Issues stay open until someone closes them');
        loadIssuesAdmin();
      } catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'error'); }
    });
    $('#isEnabled').addEventListener('change', async (e) => {
      try {
        await apiJson('/api/admin/issues', json('PUT', { enabled: e.target.checked }));
        toast(e.target.checked ? 'Issues turned on' : 'Issues turned off');
        loadIssuesAdmin();
      } catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'error'); }
    });
  }

  async function loadPorts() {
    try { renderPorts(await apiJson('/api/admin/portcheck')); } catch (e) { $('#aBody').innerHTML = `<div class="warn-box">${esc(e.message)}</div>`; }
  }

  function renderPorts(pc) {
    head('Port checks', 'Devices ask the server whether their ports can be reached');
    const origin = location.origin;
    const s = pc.stats || {};
    UI.state.config.portCheck = { enabled: pc.enabled, maxPorts: pc.maxPorts, perIpPerMinute: pc.perIpPerMinute };
    $('#aBody').innerHTML = `
      <div class="admin-section">
        <label class="switch"><input type="checkbox" id="pcEnabled" ${pc.enabled ? 'checked' : ''}><span class="track"></span><b>Allow port checks</b></label>
        <p class="muted" style="margin:0;font-size:12px">Off by default. When on, a device can ask the server to try connecting back to it on a few ports, either with its check-in (saved on its record as <code>port_3389</code> = open / closed) or on its own (the answer goes back to the device only). The Add Device page offers it once this is on.</p>
      </div>
      <div class="admin-section">
        <h4>Limits</h4>
        <div class="row" style="display:flex;gap:12px;flex-wrap:wrap;max-width:720px">
          <label class="field" style="flex:1;min-width:180px">Wait for an answer (ms)<input class="input" id="pcTimeout" type="number" min="200" max="10000" step="100" value="${esc(pc.timeoutMs)}"></label>
          <label class="field" style="flex:1;min-width:180px">Ports per request<input class="input" id="pcMax" type="number" min="1" max="20" value="${esc(pc.maxPorts)}"></label>
          <label class="field" style="flex:1;min-width:180px">Checks per address per minute<input class="input" id="pcRate" type="number" min="10" max="1000000" step="10" value="${esc(pc.perIpPerMinute)}"></label>
        </div>
        <p class="muted" style="margin:6px 0 10px;font-size:12px">A port that doesn't answer within the wait counts as closed (shown as <i>filtered</i> in the details). The per-address limit stops one caller from keeping the server busy; raise it when many devices share one address (a site behind NAT, or a load test).</p>
        <button class="btn primary" id="pcSave" style="align-self:flex-start">Save limits</button>
      </div>
      <div class="admin-section">
        <h4>How it works</h4>
        <div class="callout">
          The server only ever checks <b>the address the request came from</b>; a device can't ask it to check anything else, so this can't be used to scan other machines.
          "Open" means reachable <b>from this server</b>: firewalls between the server and the device count, and a device behind NAT, a VPN gateway or a proxy is checked at that gateway's address.
          ${pc.yourAddress ? `<br><br>Right now the server sees you as <code>${esc(pc.yourAddress)}</code>. Behind a reverse proxy, set <code>TRUST_PROXY</code> so it sees each device's real address instead of the proxy's.` : ''}
        </div>
      </div>
      <div class="admin-section">
        <h4>Usage</h4>
        <pre class="key-reveal" style="border-style:solid;border-color:var(--border);white-space:pre-wrap"># Just ask (the answer comes back; nothing is saved)
curl -H "X-API-Key: &lt;key&gt;" "${esc(origin)}/api/portcheck?ports=22,443"
  → {"ok":true,"ip":"10.0.0.15","ports":{"22":"open","443":"closed"},"ms":3}

# With a check-in (saved as port_3389 on the record, details in the reply)
curl -X POST "${esc(origin)}/api/checkin?id=web-01&amp;check_ports=3389" -H "X-API-Key: &lt;key&gt;"

# The agents
sudo checkin-agent --port-check 22,443          (Linux: ask once)
checkin-agent.ps1 -PortCheck 3389                (Windows: ask once)
--check-ports 22 / -CheckPorts 3389              (with every check-in; Add Device sets this)</pre>
      </div>
      <div class="admin-section">
        <h4>Since the server started</h4>
        <p class="muted" style="margin:0">${nf.format(s.checks || 0)} ports checked: ${nf.format(s.open || 0)} open, ${nf.format(s.closed || 0)} closed, ${nf.format(s.filtered || 0)} no answer${s.error ? `, ${nf.format(s.error)} errors` : ''}.</p>
      </div>`;
    $('#pcEnabled').addEventListener('change', async (e) => {
      try {
        renderPorts(await apiJson('/api/admin/portcheck', json('PUT', { enabled: e.target.checked })));
        toast(e.target.checked ? 'Port checks turned on' : 'Port checks turned off');
      } catch (err) { toast(err.message, 'error'); e.target.checked = !e.target.checked; }
    });
    $('#pcSave').addEventListener('click', async () => {
      try {
        renderPorts(await apiJson('/api/admin/portcheck', json('PUT', { timeoutMs: Number($('#pcTimeout').value), maxPorts: Number($('#pcMax').value), perIpPerMinute: Number($('#pcRate').value) })));
        toast('Port check limits saved');
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  // ================================================================== wiring
  $$('.admin-nav [data-tab]').forEach((b) => b.addEventListener('click', () => select(b.dataset.tab)));
  $('#adminClose').addEventListener('click', close);
  $('#adminBack').addEventListener('click', (e) => { if (e.target.id === 'adminBack') close(); });

  window.CheckinAdmin = { open, close };
})();
