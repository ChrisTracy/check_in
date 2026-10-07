(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  let mode = 'login'; // login | setup

  function showError(msg) {
    const el = $('#error');
    el.textContent = msg;
    el.hidden = !msg;
    if (msg) { $('#card').classList.remove('shake'); void $('#card').offsetWidth; $('#card').classList.add('shake'); }
  }

  function busy(on) {
    $('#submit').disabled = on;
    $('#submitText').textContent = on ? (mode === 'setup' ? 'Creating account…' : 'Signing in…') : (mode === 'setup' ? 'Create admin account' : 'Sign in');
  }

  async function init() {
    if (params.get('error')) showError(params.get('error'));
    let st;
    try {
      st = await (await fetch('/api/auth/status')).json();
    } catch {
      showError('Cannot reach the server. Check your connection and try again.');
      return;
    }
    if (st.signedIn && !params.get('error')) { location.replace('/'); return; }

    if (st.setupRequired) {
      mode = 'setup';
      $('#title').textContent = 'Create your admin account';
      $('#subtitle').textContent = 'No users exist yet. The first account you create becomes the administrator.';
      $('#nameRow').hidden = false;
      $('#confirmRow').hidden = false;
      $('#pwHint').hidden = false;
      $('#password').autocomplete = 'new-password';
      $('#form').hidden = false;
      busy(false);
      $('#name').focus();
      return;
    }

    const returnTo = params.get('returnTo') || '/';
    if (st.sso.enabled) {
      $('#ssoBtn').hidden = false;
      $('#ssoLabel').textContent = st.sso.label;
      $('#ssoBtn').href = '/auth/oidc/login?returnTo=' + encodeURIComponent(returnTo);
    }
    const showForm = !st.sso.enabled || st.passwordLogin === true || params.has('local');
    if (showForm) {
      $('#form').hidden = false;
      $('#divider').hidden = !st.sso.enabled;
      $('#username').focus();
    } else {
      $('#localToggle').hidden = false;
      $('#localToggle').textContent = 'Administrator sign-in';
      $('#subtitle').textContent = 'Use your organization account to continue.';
    }
    busy(false);
  }

  $('#localToggle').addEventListener('click', () => {
    $('#form').hidden = false;
    $('#divider').hidden = false;
    $('#localToggle').hidden = true;
    $('#username').focus();
  });

  $('#pwToggle').addEventListener('click', () => {
    const show = $('#password').type === 'password';
    $('#password').type = show ? 'text' : 'password';
    $('#pwToggle').classList.toggle('on', show);
    $('#pwToggle').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  $('#form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const username = $('#username').value.trim();
    const password = $('#password').value;
    if (!username || !password) { showError('Enter your username and password.'); return; }
    let url = '/api/auth/login';
    const body = { username, password };
    if (mode === 'setup') {
      if (password.length < 10) { showError('Password must be at least 10 characters.'); return; }
      if (password !== $('#confirm').value) { showError('Passwords do not match.'); return; }
      url = '/api/auth/setup';
      body.name = $('#name').value.trim();
    }
    busy(true);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Sign-in failed');
      const rt = params.get('returnTo');
      location.replace(rt && rt.startsWith('/') && !rt.startsWith('//') ? rt : '/');
    } catch (err) {
      showError(err.message);
      busy(false);
      $('#password').select();
    }
  });

  init();
})();
