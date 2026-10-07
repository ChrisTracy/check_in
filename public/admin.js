/* Admin panel: users, single sign-on (Entra ID) and API key. Loaded after app.js. */
(() => {
  'use strict';
  const UI = window.CheckinUI;
  const { apiJson, modal, toast, esc, nf, relTime, absTime, initials } = UI;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const ROLES = [
    ['admin', 'Admin', 'Everything, including users, single sign-on and the API key'],
    ['power', 'Power user', 'User rights plus Clear all, pausing check-ins and the fresh threshold'],
    ['user', 'User', 'View, import, export and delete records'],
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
  function close() { $('#adminBack').hidden = true; }

  function select(t) {
    tab = t;
    $$('.admin-nav [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    $('#aBody').innerHTML = '<div class="muted">Loading…</div>';
    foot('');
    ({ users: loadUsers, sso: loadSso, apikey: loadApiKey, tls: loadTls })[t]();
  }

  // ================================================================== Users
  async function loadUsers() {
    try {
      users = (await apiJson('/api/admin/users')).users;
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
        <div class="grid2" style="grid-template-columns:repeat(4,minmax(0,1fr))">
          ${ROLES.map(([r, l, d]) => `<div class="radio-card" style="cursor:default;flex-direction:column;align-items:flex-start;gap:4px"><span class="role-badge r-${r}">${esc(l)}</span><small>${esc(d)}</small></div>`).join('')}
        </div>
      </div>
      <table class="utable">
        <thead><tr><th>User</th><th style="width:160px">Role</th><th>Sign-in</th><th>Last sign-in</th><th>Status</th><th style="width:120px"></th></tr></thead>
        <tbody>${list.map((u) => `
          <tr class="${u.disabled ? 'disabled' : ''}" data-id="${u.id}">
            <td><div class="ucell"><span class="avatar sm">${esc(initials(u))}</span><div style="min-width:0">
              <b>${esc(u.name || u.username)} ${u.id === me ? '<span class="tag">You</span>' : ''}</b>
              <small>${esc(u.username)}${u.email && u.email !== u.username ? ' · ' + esc(u.email) : ''}</small></div></div></td>
            <td><select class="select" data-role>${roleOptions(u.role)}</select></td>
            <td>${u.hasPassword ? '<span class="tag">Password</span>' : ''}${u.sso ? '<span class="tag">Entra SSO</span>' : ''}${!u.hasPassword && !u.sso ? '<span class="tag">SSO (not linked yet)</span>' : ''}</td>
            <td title="${esc(absTime(u.lastLogin))}">${u.lastLogin ? esc(relTime(u.lastLogin)) : '<span class="muted">Never</span>'}</td>
            <td>${u.disabled ? '<span class="tag off">Disabled</span>' : '<span class="tag ok">Active</span>'}</td>
            <td style="text-align:right;white-space:nowrap">
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
        ? 'On their first Microsoft sign-in, the account is linked by matching the username or email to their Entra sign-in name.'
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

  function setPassword(u) {
    modal({
      title: u.hasPassword ? `Reset password for ${u.username}` : `Set a password for ${u.username}`,
      body: `<label>New password<input class="input" id="rpPw" type="password" autocomplete="new-password" placeholder="At least 10 characters"></label>
        <p style="font-size:12px">The user's existing sessions will be signed out.</p>
        ${u.hasPassword && u.sso ? '<label class="switch" style="font-weight:500"><input type="checkbox" id="rpRemove"><span class="track"></span>Remove password (SSO only)</label>' : ''}`,
      actions: [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => {
        if ($('#rpRemove')?.checked) return patchUser(u.id, { removePassword: true }, 'Password removed');
        const pw = $('#rpPw').value;
        if (!pw) { toast('Enter a password', 'error'); return false; }
        await patchUser(u.id, { password: pw }, 'Password updated');
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
          <label class="radio-card"><input type="radio" name="pwl" value="admins" ${passwordLogin === 'admins' ? 'checked' : ''}><span><b>Admins only</b><small>Only Microsoft sign-in is shown. Local admins can still sign in with a password (break-glass) via "Administrator sign-in".</small></span></label>
        </div>
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
    $('#aBody').innerHTML = `
      <div class="admin-section">
        <div class="radio-card" style="cursor:default;align-items:center">
          <span style="flex:1">
            <span class="status-line">${info.set ? '<i class="dot fresh"></i><b>API key is set</b>' : '<i class="dot aging"></i><b>No API key</b>'}</span>
            <small>${info.set ? `Starts with <code>${esc(info.prefix)}…</code> · created ${esc(relTime(info.created))}${info.createdBy ? ' by ' + esc(info.createdBy) : ''}` : 'Anyone who can reach the server can check in. Reading data still requires sign-in.'}</small>
          </span>
          <span style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
            <button class="btn primary" id="kGen">${info.set ? 'Regenerate' : 'Generate key'}</button>
            <button class="btn" id="kSet">Use my own</button>
            ${info.set ? '<button class="btn danger" id="kOff">Remove</button>' : ''}
          </span>
        </div>
      </div>
      <div class="admin-section">
        <h4>What the key allows</h4>
        <div class="callout">
          The API key acts like a <b>User</b>: it can check in, read records and history, import, export and delete records.
          It cannot clear all records or change settings. While a key is set, check-ins <b>without</b> a key (or a signed-in user) are rejected.
          The key is stored hashed, so it's shown only once when it's created.
        </div>
      </div>
      <div class="admin-section">
        <h4>Usage</h4>
        <pre class="key-reveal" style="border-style:solid;border-color:var(--border);white-space:pre-wrap">curl -X POST "${esc(origin)}/api/checkin?id=device-1&amp;status=ok" -H "X-API-Key: &lt;key&gt;"

Invoke-RestMethod -Method Post "${esc(origin)}/api/checkin?id=device-1&amp;status=ok" -Headers @{ "X-API-Key" = "&lt;key&gt;" }</pre>
        <p class="muted" style="margin:0;font-size:12px">You can also send <code>Authorization: Bearer &lt;key&gt;</code> or <code>?api_key=&lt;key&gt;</code>. Scripts can use a user account instead, with HTTP Basic auth (<code>curl -u user:password</code>), and get that user's role.</p>
      </div>`;
    $('#kGen').addEventListener('click', () => {
      const go = async () => {
        try {
          const r = await apiJson('/api/admin/apikey', json('POST', { action: 'generate' }));
          renderApiKey(r);
          UI.state.config.apiKeySet = true;
          setTimeout(() => showKey(r.key), 50);
        } catch (e) { toast(e.message, 'error'); }
      };
      if (!info.set) return go();
      modal({
        title: 'Regenerate API key?',
        body: '<div class="warn-box">The current key stops working immediately. Every device using it must be updated.</div>',
        actions: [{ label: 'Cancel' }, { label: 'Regenerate', cls: 'danger solid', onClick: go }],
      });
    });
    $('#kSet').addEventListener('click', () => modal({
      title: 'Use your own API key',
      body: '<label>API key<input class="input" id="kCustom" type="password" autocomplete="off" placeholder="At least 16 characters"></label><p style="font-size:12px">Use this to keep an existing key that devices already have.</p>',
      actions: [{ label: 'Cancel' }, { label: 'Save', cls: 'primary', onClick: async () => {
        try {
          renderApiKey(await apiJson('/api/admin/apikey', json('POST', { action: 'set', key: $('#kCustom').value })));
          UI.state.config.apiKeySet = true;
          toast('API key saved');
        } catch (e) { toast(e.message, 'error'); return false; }
      } }],
    }));
    $('#kOff')?.addEventListener('click', () => modal({
      title: 'Remove the API key?',
      body: '<div class="warn-box">Check-ins will be accepted from anyone who can reach the server, without a key.</div>',
      actions: [{ label: 'Cancel' }, { label: 'Remove key', cls: 'danger solid', onClick: async () => {
        try {
          renderApiKey(await apiJson('/api/admin/apikey', json('POST', { action: 'disable' })));
          UI.state.config.apiKeySet = false;
          toast('API key removed');
        } catch (e) { toast(e.message, 'error'); }
      } }],
    }));
  }

  function showKey(key) {
    modal({
      title: 'Your new API key',
      body: `<p>Copy it now. For security it won't be shown again.</p><div class="key-reveal" id="newKey">${esc(key)}</div>`,
      actions: [{ label: 'Copy key', cls: 'primary', onClick: () => { copy(key); return false; } }, { label: 'Done' }],
    });
  }

  // ================================================================== HTTPS / TLS
  let tlsState = null;
  let tlsSource = 'pem';

  async function loadTls() {
    try { tlsState = await apiJson('/api/admin/tls'); renderTls(); } catch (e) { $('#aBody').innerHTML = `<div class="warn-box">${esc(e.message)}</div>`; }
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
    const src = { pem: 'PEM upload', pfx: 'PFX upload', 'self-signed': 'Generated (self-signed)' }[st.source] || 'Files in the data volume';
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
        <h4>${st.cert ? 'Replace certificate' : 'Install a certificate'}</h4>
        <div id="tForm" class="install-form">${installForm()}</div>
        <p class="muted" style="margin:0;font-size:12px">Certificates are saved in the data volume (<code>data/tls</code>) and survive container rebuilds. You can also copy <code>cert.pem</code> and <code>key.pem</code> into that folder (for example from certbot); changes are picked up within a minute.</p>
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
        body = { type: 'self-signed', hostnames: $('#tHosts').value, days: Number($('#tDays').value) || 365 };
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

  // ================================================================== wiring
  $$('.admin-nav [data-tab]').forEach((b) => b.addEventListener('click', () => select(b.dataset.tab)));
  $('#adminClose').addEventListener('click', close);
  $('#adminBack').addEventListener('click', (e) => { if (e.target.id === 'adminBack') close(); });

  window.CheckinAdmin = { open, close };
})();
