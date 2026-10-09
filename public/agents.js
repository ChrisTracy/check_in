/* Add Device: builds the one-line install commands and shows the example agent scripts.
 * The commands point at the address this page was opened from. The server generates the
 * installers in src/agents.js; the agents themselves are scripts/checkin-agent.ps1 and .sh. */
(() => {
  'use strict';
  const UI = window.CheckinUI;
  const { esc, toast, can } = UI;
  const $ = (s, el = document) => el.querySelector(s);

  const GROUPS = [
    ['system', 'System', 'OS, model, serial'],
    ['cpu', 'CPU', 'usage, cores'],
    ['ram', 'Memory', 'usage, total'],
    ['disk', 'Disk', 'activity %, space used %, free GB'],
    ['time', 'Time', 'system time, time zone, sync'],
    ['uptime', 'Uptime', 'boot time, uptime'],
    ['network', 'Network', 'IP, MAC, gateway, DNS'],
    ['domain', 'Domain', 'AD / Entra join, trust'],
    ['users', 'Users', 'who is signed in'],
    ['health', 'Health', 'failed services, reboot needed'],
    ['updates', 'Updates', 'pending updates (slower)'],
    ['security', 'Security', 'firewall, antivirus, encryption'],
  ];
  const DEFAULT = ['system', 'cpu', 'ram', 'disk', 'time', 'uptime', 'network', 'domain', 'users', 'health'];
  const ICON = {
    copy: '<svg class="i" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    x: '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    ext: '<svg class="i" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  };

  const st = { keyInfo: null, os: 'windows', every: 5, groups: new Set(DEFAULT), extra: '', key: '', insecure: false, shell: 'ps', removeRecord: true };
  let root = null;

  function origin() { return location.origin; }
  function query() {
    const p = new URLSearchParams();
    if (st.every !== 5) p.set('every', st.every);
    const sel = GROUPS.map(([g]) => g).filter((g) => st.groups.has(g));
    const isDefault = sel.length === DEFAULT.length && DEFAULT.every((g) => st.groups.has(g));
    const hasDefaults = DEFAULT.every((g) => st.groups.has(g));
    if (!isDefault) {
      p.set('fields', sel.length === GROUPS.length ? 'all'
        : hasDefaults ? ['default', ...sel.filter((g) => !DEFAULT.includes(g))].join(',') : sel.join(','));
    }
    if (st.extra.trim()) p.set('extra', st.extra.trim());
    if (st.insecure) p.set('insecure', '1');
    // If the server sees itself under another address (e.g. behind a proxy without TRUST_PROXY), pin ours.
    const site = UI.state.config.siteUrl;
    if (site && site !== origin()) p.set('url', origin());
    const s = p.toString().replace(/%2C/gi, ',').replace(/%3D/gi, '=').replace(/%3A/gi, ':').replace(/%2F/gi, '/');
    return s ? '?' + s : '';
  }
  function commands() {
    const https = location.protocol === 'https:';
    const key = st.key.trim();
    if (st.os === 'linux') {
      const url = `${origin()}/install.sh${query()}`;
      return { main: `curl -fsSL${st.insecure ? 'k' : ''} '${url}' | sudo ${key ? `CHECKIN_API_KEY=${key} ` : ''}bash`, url, note: 'Run on the Linux machine as root (the command uses sudo). Needs curl.' };
    }
    const url = `${origin()}/install.ps1${query()}`;
    const pre = (key ? `$env:CHECKIN_API_KEY='${key}'; ` : '')
      + (https ? "[Net.ServicePointManager]::SecurityProtocol='Tls12'; " : '')
      + (st.insecure ? '[Net.ServicePointManager]::ServerCertificateValidationCallback={$true}; ' : '');
    const ps = `${pre}irm '${url}' | iex`;
    return st.shell === 'cmd'
      ? { main: `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`, url, note: 'Run in a Command Prompt opened with "Run as administrator".' }
      : { main: ps, url, note: 'Run in Windows PowerShell opened with "Run as administrator".' };
  }

  // Commands to remove the agent again (run on the machine itself).
  function removeCommands() {
    if (st.os === 'linux') {
      return {
        main: `sudo checkin-agent --uninstall${st.removeRecord ? ' --remove-record' : ''}`,
        manual: "sudo sh -c 'systemctl disable --now checkin-agent.timer 2>/dev/null; rm -f /etc/systemd/system/checkin-agent.service /etc/systemd/system/checkin-agent.timer /etc/cron.d/checkin-agent /usr/local/bin/checkin-agent; rm -rf /etc/check-in'",
        where: 'Run on the Linux machine (uses sudo).',
      };
    }
    return {
      main: `powershell -NoProfile -ExecutionPolicy Bypass -File C:\\ProgramData\\CheckIn\\checkin-agent.ps1 -Uninstall${st.removeRecord ? ' -RemoveRecord' : ''}`,
      manual: st.shell === 'cmd'
        ? 'schtasks /Delete /TN "Check-In Agent" /F & rmdir /S /Q C:\\ProgramData\\CheckIn'
        : "schtasks /Delete /TN 'Check-In Agent' /F; Remove-Item C:\\ProgramData\\CheckIn -Recurse -Force",
      where: `Run on the Windows machine in an elevated ${st.shell === 'cmd' ? 'Command Prompt' : 'PowerShell'}.`,
    };
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* not a secure context */ }
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }

  const keyRequired = () => UI.state.config.apiKeyRequired !== false;
  function noteHtml(c) {
    const missing = keyRequired() && !st.key.trim();
    return `${esc(c.note)} ${missing ? '<b class="ag-warn">Add the API key above first, or the install will fail.</b>' : ''}`;
  }

  function render() {
    const keyNeeded = keyRequired();
    const ki = st.keyInfo;
    const c = commands();
    const agentFile = st.os === 'linux' ? 'checkin-agent.sh' : 'checkin-agent.ps1';
    const cfgPath = st.os === 'linux' ? '/etc/check-in/agent.conf' : 'C:\\ProgramData\\CheckIn\\agent.json';
    const site = UI.state.config.siteUrl;
    const rm = removeCommands();
    root.querySelector('.ag-body').innerHTML = `
      <div class="ag-os seg text" role="tablist">
        <button data-os="windows" class="${st.os === 'windows' ? 'active' : ''}">Windows</button>
        <button data-os="linux" class="${st.os === 'linux' ? 'active' : ''}">Linux</button>
      </div>

      <section class="ag-step">
        <h4><span class="ag-num">1</span>Choose options</h4>
        <div class="ag-grid">
          <label class="field">Check in every
            <select class="select" id="agEvery">${[1, 2, 3, 4, 5, 10, 15, 30].concat(st.os === 'windows' ? [60] : []).map((m) => `<option value="${m}" ${m === st.every ? 'selected' : ''}>${m} minute${m === 1 ? '' : 's'}</option>`).join('')}</select>
          </label>
          <div class="field"><span class="field-label">API key ${keyNeeded ? '<small>required</small>' : '<small>optional</small>'}</span>
            ${can('apiKey') && ki?.key
              ? `<div class="copy-row"><input class="input mono" id="agKey" value="${esc(st.key)}" readonly spellcheck="false"><button class="btn" id="agRegen" type="button">Regenerate</button></div>
                 <small>This server's key, filled in for you. Regenerating replaces it, so devices already set up need the new key.</small>`
              : can('apiKey')
                ? `<div class="copy-row"><input class="input mono" id="agKey" placeholder="ck_..." value="${esc(st.key)}" autocomplete="off" spellcheck="false"><button class="btn" id="agRegen" type="button">${ki?.set ? 'Regenerate' : 'Generate'}</button></div>
                   <small>${ki?.set ? 'The current key was saved by an older version and can\'t be shown. Paste it, or regenerate it (devices already set up then need the new key).' : 'Loading the key…'}</small>`
                : `<input class="input mono" id="agKey" placeholder="ck_..." value="${esc(st.key)}" autocomplete="off" spellcheck="false">
                   <small>${keyNeeded ? 'Ask a power user or admin for it. It is saved on each machine, not on this page.' : 'This server accepts check-ins without a key.'}</small>`}
          </div>
          <label class="field"><span class="field-label">Extra fields <small>optional</small></span>
            <input class="input mono" id="agExtra" placeholder="${st.os === 'windows' ? 'site=Dallas,owner=%USERNAME%' : 'site=Dallas,owner=${OWNER:-it}'}" value="${esc(st.extra)}" spellcheck="false">
            <small>Sent with every check-in. A value can use the machine's environment variables, read on every run: <code>\${NAME}</code>, <code>\${NAME:-fallback}</code> or <code>%NAME%</code>. ${st.os === 'windows' ? 'Set them as System variables so the scheduled task can see them.' : 'Put them in /etc/environment or the agent config so the timer or cron job can see them.'}</small>
          </label>
        </div>
        <div class="field" style="margin-top:12px">What to send
          <div class="ag-groups">${GROUPS.map(([g, l, d]) => `<label class="ag-group ${st.groups.has(g) ? 'on' : ''}"><input type="checkbox" value="${g}" ${st.groups.has(g) ? 'checked' : ''}><b>${l}</b><small>${d}</small></label>`).join('')}</div>
        </div>
        ${location.protocol === 'https:' ? `<label class="switch" style="margin-top:12px"><input type="checkbox" id="agInsecure" ${st.insecure ? 'checked' : ''}><span class="track"></span>Accept a self-signed certificate</label>` : ''}
      </section>

      <section class="ag-step">
        <h4><span class="ag-num">2</span>Run this on the ${st.os === 'linux' ? 'Linux machine' : 'Windows machine'}</h4>
        ${st.os === 'windows' ? `<div class="seg text ag-shell"><button data-shell="ps" class="${st.shell === 'ps' ? 'active' : ''}">PowerShell</button><button data-shell="cmd" class="${st.shell === 'cmd' ? 'active' : ''}">Command Prompt</button></div>` : ''}
        <div class="ag-cmd"><code id="agCmd">${esc(c.main)}</code><button class="btn primary" id="agCopy">${ICON.copy}<span>Copy</span></button></div>
        <p class="ag-note" id="agNote">${noteHtml(c)}</p>
        ${site && site !== origin() ? `<div class="callout ag-callout">This server sees its own address as <code>${esc(site)}</code>, but you're using <code>${esc(origin())}</code>, so the command tells machines to use yours. Behind a reverse proxy, set <code>TRUST_PROXY</code> so the server knows its public address.</div>` : ''}
        <ul class="ag-what">
          <li>Downloads the agent from <b>${esc(origin())}</b> and installs it ${st.os === 'linux' ? 'to <code>/usr/local/bin/checkin-agent</code>' : 'to <code>C:\\ProgramData\\CheckIn</code>'}.</li>
          <li>${st.os === 'linux' ? 'Runs it every ' + st.every + ' min with a systemd timer (cron if there is no systemd).' : 'Creates the scheduled task <b>Check-In Agent</b>: runs as SYSTEM every ' + st.every + ' min, at startup and on battery.'}</li>
          <li>Each run first checks that this server is accepting check-ins, then sends the selected fields with the computer name as the ID.</li>
        </ul>
      </section>

      <section class="ag-step">
        <h4><span class="ag-num">3</span>Example scripts and where to change things</h4>
        <div class="ag-links">
          <a class="btn" href="${esc(c.url)}" target="_blank" rel="noopener">${ICON.ext}<span>View this installer</span></a>
          <a class="btn" href="/agent/${agentFile}" target="_blank" rel="noopener">${ICON.ext}<span>View the agent (${agentFile})</span></a>
          <a class="btn" href="/agent/${agentFile}" download>Download the agent</a>
        </div>
        <ul class="ag-where">
          <li><b>One machine, after installing:</b> edit <code>${cfgPath}</code> (URL, API key, fields, extra fields). It applies on the next run.${st.os === 'linux' ? ' Change the schedule by running the install command again with a new interval.' : ' Change the schedule by running the command again with a new interval.'}</li>
          <li><b>Defaults for future installs:</b> pick them above (they're carried in the command's URL), or change <code>INSTALL_DEFAULTS</code> in <code>src/agents.js</code> on the server.</li>
          <li><b>What the agent collects:</b> the <code>SETTINGS - change these</code> block at the top of <code>scripts/${agentFile}</code>, then the field groups below it. Machines pick up a new version when the install command is run again.</li>
          <li><b>Try it first:</b> ${st.os === 'linux' ? '<code>sudo checkin-agent --dry-run --fields all</code>' : '<code>powershell -ExecutionPolicy Bypass -File C:\\ProgramData\\CheckIn\\checkin-agent.ps1 -DryRun -Fields all</code>'} prints what would be sent.</li>
        </ul>
      </section>

      <section class="ag-step">
        <h4><span class="ag-num">4</span>Remove a machine</h4>
        <p class="ag-note">${esc(rm.where)} It stops the ${st.os === 'linux' ? 'timer or cron job' : 'scheduled task'} and deletes the agent and its settings, including the saved API key.</p>
        <label class="switch"><input type="checkbox" id="agRemoveRecord" ${st.removeRecord ? 'checked' : ''}><span class="track"></span>Also delete its record from this dashboard</label>
        <div class="ag-cmd"><code id="agRmCmd">${esc(rm.main)}</code><button class="btn" data-copy="agRmCmd">${ICON.copy}<span>Copy</span></button></div>
        <details class="ag-details">
          <summary>If the agent file is already gone</summary>
          <p class="ag-note">Removes the ${st.os === 'linux' ? 'timer, cron job, agent and settings' : 'scheduled task and the C:\\ProgramData\\CheckIn folder'} directly. It can't delete the record, so do that here afterwards.</p>
          <div class="ag-cmd"><code id="agRmManual">${esc(rm.manual)}</code><button class="btn" data-copy="agRmManual">${ICON.copy}<span>Copy</span></button></div>
        </details>
        <ul class="ag-what">
          <li>Records are never deleted on their own. A machine that stops checking in turns <b>stale</b> and stays listed until someone deletes it.</li>
          <li>To clear out several: click the <b>Stale</b> card, tick the machines you've retired (or the header box for all of them), then choose <b>Delete</b> in the bar at the bottom.</li>
          ${st.removeRecord ? '<li>Deleting the record uses the API key saved on the machine. If it was changed since, the agent is still removed; delete the record here instead.</li>' : ''}
        </ul>
      </section>`;
  }

  function update() {
    // Re-render the command only (keeps focus in the text inputs).
    const c = commands();
    $('#agCmd', root).textContent = c.main;
    $('#agNote', root).innerHTML = noteHtml(c);
    root.querySelectorAll('.ag-links a').forEach((a) => { if (a.textContent.includes('installer')) a.href = c.url; });
  }

  function bind() {
    root.addEventListener('click', async (e) => {
      if (e.target === root || e.target.closest('#agClose')) { close(); return; }
      const os = e.target.closest('[data-os]')?.dataset.os;
      if (os) { st.os = os; if (os === 'linux' && st.every > 59) st.every = 30; render(); return; }
      const sh = e.target.closest('[data-shell]')?.dataset.shell;
      if (sh) { st.shell = sh; render(); return; }
      if (e.target.closest('#agRegen')) { regenerate(); return; }
      const copyBtn = e.target.closest('#agCopy, [data-copy]');
      if (copyBtn) {
        const text = copyBtn.id === 'agCopy' ? commands().main : $('#' + copyBtn.dataset.copy, root).textContent;
        const ok = await copyText(text);
        toast(ok ? 'Command copied' : 'Select the command and copy it', ok ? '' : 'error');
      }
    });
    root.addEventListener('change', (e) => {
      if (e.target.id === 'agEvery') { st.every = Number(e.target.value); render(); }
      else if (e.target.id === 'agInsecure') { st.insecure = e.target.checked; render(); }
      else if (e.target.id === 'agRemoveRecord') { st.removeRecord = e.target.checked; render(); }
      else if (e.target.closest('.ag-groups')) {
        if (e.target.checked) st.groups.add(e.target.value); else st.groups.delete(e.target.value);
        if (!st.groups.size) { st.groups.add(e.target.value); e.target.checked = true; toast('Pick at least one group', 'error'); }
        e.target.closest('.ag-group').classList.toggle('on', e.target.checked);
        update();
      }
    });
    root.addEventListener('input', (e) => {
      if (e.target.id === 'agKey') { st.key = e.target.value.replace(/[^A-Za-z0-9_-]/g, ''); if (st.key !== e.target.value) e.target.value = st.key; update(); }
      if (e.target.id === 'agExtra') { st.extra = e.target.value.replace(/[^A-Za-z0-9_.:@/ =,+${}%-]/g, ''); if (st.extra !== e.target.value) e.target.value = st.extra; update(); }
    });
  }

  async function loadKey() {
    if (!can('apiKey')) return;
    try {
      st.keyInfo = await UI.apiJson('/api/admin/apikey');
      if (st.keyInfo.key) st.key = st.keyInfo.key;
    } catch { st.keyInfo = null; }
    if (root && !root.hidden) render();
  }
  function regenerate() {
    const go = async () => {
      try {
        const r = await UI.apiJson('/api/admin/apikey', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'generate' }) });
        st.keyInfo = r; st.key = r.key;
        UI.state.config.apiKeySet = true;
        render();
        toast('New API key created and filled in. Devices already set up need it too.');
      } catch (e) { toast(e.message, 'error'); }
    };
    if (!st.keyInfo?.set) return go();
    UI.modal({
      title: 'Regenerate the API key?',
      body: '<div class="warn-box">The current key stops working immediately. Devices already set up keep failing to check in until you run the new install command on them, or put the new key in their settings file.</div>',
      actions: [{ label: 'Cancel' }, { label: 'Regenerate', cls: 'danger solid', onClick: go }],
    });
  }

  function onKey(e) { if (e.key === 'Escape' && document.getElementById('modalBack')?.hidden !== false) close(); }
  function open() {
    if (!root) {
      root = document.createElement('div');
      root.className = 'admin-back ag-back';
      root.innerHTML = `<div class="ag" role="dialog" aria-modal="true" aria-label="Add Device">
        <div class="ag-head"><div><h3>Add Device</h3><p>Install the agent with one command. It reports to this server every few minutes.</p></div>
          <button class="icon-btn" id="agClose" title="Close (Esc)">${ICON.x}</button></div>
        <div class="ag-body"></div></div>`;
      document.body.appendChild(root);
      bind();
      // Start on the tab matching this computer's OS.
      if (/Linux|X11/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent)) st.os = 'linux';
    }
    render();
    root.hidden = false;
    loadKey();
    document.addEventListener('keydown', onKey);
  }
  function close() { if (root) root.hidden = true; document.removeEventListener('keydown', onKey); }

  window.CheckinAgents = { open, close };
})();
