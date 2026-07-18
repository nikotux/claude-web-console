(function () {
  'use strict';

  const API = '/api/onboard/public';
  const root = document.getElementById('onboard-root');
  const state = {
    step: 'token',
    token: '',
    username: '',
    admin: false,
    url: '',
    error: '',
  };

  let loading = '';
  let exchanging = false;
  let pollId = null;
  let currentJobKey = '';

  function clearPoll() {
    if (pollId) {
      clearInterval(pollId);
      pollId = null;
    }
  }

  function setStep(step) {
    if (state.step === 'creds' && step !== 'creds') clearPoll();
    state.step = step;
    state.error = '';
    loading = '';
    exchanging = false;
    currentJobKey = '';
    render();
  }

  function setError(message) {
    state.error = message || 'Ocurrió un error.';
    loading = '';
    render();
  }

  function textEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text;
    return el;
  }

  function button(text, className, onClick) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = className || 'btn';
    el.textContent = text;
    el.addEventListener('click', onClick);
    return el;
  }

  function field(label, input) {
    const wrap = document.createElement('label');
    wrap.className = 'ob-field';
    wrap.appendChild(textEl('span', 'ob-label', label));
    wrap.appendChild(input);
    return wrap;
  }

  function input(id, type, placeholder, autocomplete) {
    const el = document.createElement('input');
    el.id = id;
    el.type = type;
    el.placeholder = placeholder;
    el.autocomplete = autocomplete || 'off';
    if (type === 'text') {
      el.autocapitalize = 'off';
      el.autocorrect = 'off';
      el.spellcheck = false;
    }
    return el;
  }

  function header(title, hint, activeStep) {
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'ob-head';
    head.appendChild(textEl('h1', 'ob-title', title));
    if (hint) head.appendChild(textEl('p', 'ob-hint', hint));
    frag.appendChild(head);

    const steps = document.createElement('div');
    steps.className = 'ob-steps';
    steps.setAttribute('aria-label', 'Progreso del onboarding');
    for (let i = 1; i <= 4; i += 1) {
      const step = document.createElement('span');
      step.className = i <= activeStep ? 'ob-step is-active' : 'ob-step';
      steps.appendChild(step);
    }
    frag.appendChild(steps);
    return frag;
  }

  function message() {
    if (!state.error) return null;
    return textEl('p', 'ob-error', state.error);
  }

  async function apiJson(path, options) {
    const res = await fetch(API + path, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
    });

    let data = {};
    try {
      data = await res.json();
    } catch (err) {
      data = {};
    }

    if (!res.ok) {
      const msg = data.error || data.reason || 'Error de servidor.';
      throw new Error(msg);
    }

    return data;
  }

  async function validateToken() {
    const tokenInput = document.getElementById('ob-token');
    const token = tokenInput ? tokenInput.value.trim() : '';
    if (!token) {
      setError('Ingresá el token de invitación.');
      return;
    }

    loading = 'token';
    state.error = '';
    render();

    try {
      const data = await apiJson('/validate', { method: 'POST', body: { token } });
      if (data.valid === true) {
        state.token = token;
        state.admin = Boolean(data.admin);
        setStep('register');
      } else {
        setError('Invitación ' + (data.reason || 'inválida'));
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function registerUser() {
    const usernameEl = document.getElementById('ob-username');
    const passwordEl = document.getElementById('ob-password');
    const repeatEl = document.getElementById('ob-password-repeat');
    const username = usernameEl ? usernameEl.value.trim() : '';
    const password = passwordEl ? passwordEl.value : '';
    const repeat = repeatEl ? repeatEl.value : '';

    if (!username) {
      setError('Ingresá un nombre de usuario.');
      return;
    }
    if (password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (password !== repeat) {
      setError('Las contraseñas no coinciden.');
      return;
    }

    loading = 'register';
    state.error = '';
    render();

    try {
      const data = await apiJson('/register', {
        method: 'POST',
        body: { token: state.token, username, password },
      });
      if (!data.ok) throw new Error(data.error || 'No se pudo crear la cuenta.');
      state.username = username;
      setStep('creds');
      startCreds();
    } catch (err) {
      setError(err.message);
    }
  }

  async function startCreds() {
    clearPoll();
    state.url = '';
    state.error = '';
    currentJobKey = '';
    renderCredsStatus({ status: 'starting' });

    try {
      await apiJson('/creds-start', { method: 'POST', body: { token: state.token } });
      pollCreds();
      pollId = setInterval(pollCreds, 1500);
    } catch (err) {
      clearPoll();
      renderCredsStatus({ status: 'error', error: err.message });
    }
  }

  async function pollCreds() {
    try {
      const data = await apiJson('/creds-status?token=' + encodeURIComponent(state.token), { method: 'GET' });
      renderCredsStatus(data || {});
    } catch (err) {
      clearPoll();
      renderCredsStatus({ status: 'error', error: err.message });
    }
  }

  async function sendCode() {
    const codeEl = document.getElementById('ob-code');
    const code = codeEl ? codeEl.value.trim() : '';
    if (!code) {
      state.error = 'Pegá el código de autorización.';
      renderCredsStatus({ status: 'awaiting-code', url: state.url });
      return;
    }

    exchanging = true;
    state.error = '';
    updateCodeButton();

    try {
      await apiJson('/creds-code', { method: 'POST', body: { token: state.token, code } });
      renderCredsStatus({ status: 'exchanging' });
    } catch (err) {
      exchanging = false;
      state.error = err.message;
      renderCredsStatus({ status: 'awaiting-code', url: state.url });
    }
  }

  function updateCodeButton() {
    const btn = document.getElementById('ob-code-btn');
    if (!btn) return;
    btn.disabled = exchanging;
    btn.textContent = exchanging ? 'Confirmando…' : 'Confirmar código';
  }

  function renderToken() {
    root.replaceChildren();
    root.appendChild(header('Bienvenido/a', 'Usá tu invitación para configurar el acceso.', 1));

    const form = document.createElement('form');
    form.className = 'ob-form';
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      validateToken();
    });

    const token = input('ob-token', 'text', 'Token de invitación', 'one-time-code');
    token.autofocus = true;
    form.appendChild(field('Token de invitación', token));

    const actions = document.createElement('div');
    actions.className = 'ob-actions';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn';
    submit.disabled = loading === 'token';
    submit.textContent = loading === 'token' ? 'Continuando…' : 'Continuar';
    actions.appendChild(submit);
    form.appendChild(actions);

    const err = message();
    if (err) form.appendChild(err);
    root.appendChild(form);
    token.focus();
  }

  function renderRegister() {
    root.replaceChildren();
    root.appendChild(header('Creá tu usuario', 'Elegí las credenciales para entrar a la consola.', 2));

    const form = document.createElement('form');
    form.className = 'ob-form';
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      registerUser();
    });

    if (state.admin) {
      form.appendChild(textEl('p', 'ob-note', 'Esta cuenta será administrador.'));
    }

    const username = input('ob-username', 'text', 'Usuario', 'username');
    const password = input('ob-password', 'password', 'Contraseña', 'new-password');
    const repeat = input('ob-password-repeat', 'password', 'Repetir contraseña', 'new-password');
    form.appendChild(field('Usuario', username));
    form.appendChild(field('Contraseña', password));
    form.appendChild(field('Repetir contraseña', repeat));

    const actions = document.createElement('div');
    actions.className = 'ob-actions';
    actions.appendChild(button('← volver', 'btn-ghost', function () {
      setStep('token');
    }));
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn';
    submit.disabled = loading === 'register';
    submit.textContent = loading === 'register' ? 'Creando…' : 'Crear cuenta';
    actions.appendChild(submit);
    form.appendChild(actions);

    const err = message();
    if (err) form.appendChild(err);
    root.appendChild(form);
    username.focus();
  }

  function renderCredsBase() {
    root.replaceChildren();
    root.appendChild(header('Conectá tu cuenta de Claude', 'Autorizá Claude para terminar la configuración.', 3));
  }

  function renderSpinner(text) {
    renderCredsBase();
    const line = document.createElement('div');
    line.className = 'ob-spinner-line';
    line.appendChild(document.createElement('span')).className = 'ob-spinner';
    line.appendChild(textEl('span', '', text));
    root.appendChild(line);
  }

  function renderAwaitingCode() {
    renderCredsBase();

    const list = document.createElement('ol');
    list.className = 'ob-list';

    const first = document.createElement('li');
    first.appendChild(textEl('span', '', 'Abrí este enlace y autorizá con tu cuenta de Claude:'));
    first.appendChild(document.createTextNode(' '));
    const link = document.createElement('a');
    link.className = 'ob-url';
    link.href = state.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = state.url;
    first.appendChild(link);
    const copy = button('Copiar enlace', 'btn-ghost ob-copy', async function () {
      try {
        await navigator.clipboard.writeText(state.url);
        copy.textContent = 'Copiado';
      } catch (err) {
        copy.textContent = 'No se pudo copiar';
      }
      window.setTimeout(function () {
        copy.textContent = 'Copiar enlace';
      }, 1800);
    });
    first.appendChild(copy);
    list.appendChild(first);

    const second = document.createElement('li');
    second.appendChild(textEl('span', '', 'Copiá el código que te da y pegalo acá:'));
    const row = document.createElement('div');
    row.className = 'ob-code-row';
    const code = input('ob-code', 'text', 'Código de autorización', 'one-time-code');
    const confirm = button('Confirmar código', 'btn', sendCode);
    confirm.id = 'ob-code-btn';
    row.appendChild(code);
    row.appendChild(confirm);
    second.appendChild(row);
    list.appendChild(second);

    root.appendChild(list);
    const err = message();
    if (err) root.appendChild(err);
    updateCodeButton();
  }

  function renderCredsStatus(job) {
    if (state.step !== 'creds') return;

    const status = job.status || (job.done ? 'done' : 'starting');
    const url = job.url || state.url || '';
    const stale = job.stale === true;
    const error = job.error || '';
    const jobKey = [status, url, stale ? 'stale' : '', error, state.error].join('|');

    if (status === 'done' || job.done) {
      clearPoll();
      setStep('done');
      return;
    }

    if (status === 'error') {
      clearPoll();
      currentJobKey = jobKey;
      state.error = error || 'No se pudo conectar la cuenta de Claude.';
      renderCredsBase();
      root.appendChild(textEl('p', 'ob-error', state.error));
      const actions = document.createElement('div');
      actions.className = 'ob-actions';
      actions.appendChild(button('Reintentar', 'btn', startCreds));
      root.appendChild(actions);
      return;
    }

    if (stale) {
      clearPoll();
      currentJobKey = jobKey;
      renderCredsBase();
      root.appendChild(textEl('p', 'ob-error', 'Parece que se interrumpió.'));
      const actions = document.createElement('div');
      actions.className = 'ob-actions';
      actions.appendChild(button('Reintentar', 'btn', startCreds));
      root.appendChild(actions);
      return;
    }

    if (jobKey === currentJobKey && status === 'awaiting-code') return;
    currentJobKey = jobKey;

    if (status === 'exchanging') {
      renderSpinner('Verificando el código…');
      return;
    }

    if (status === 'awaiting-code' && url) {
      state.url = url;
      renderAwaitingCode();
      return;
    }

    renderSpinner('Preparando…');
  }

  function renderDone() {
    root.replaceChildren();
    root.appendChild(header('✅ ¡Listo!', 'Tu cuenta quedó configurada.', 4));
    root.appendChild(textEl('p', 'ob-ok', 'Tu cuenta quedó configurada.'));
    const actions = document.createElement('div');
    actions.className = 'ob-actions';
    actions.appendChild(button('Ir a iniciar sesión', 'btn', function () {
      window.location.href = '/login';
    }));
    root.appendChild(actions);
  }

  function render() {
    if (!root) return;
    if (state.step === 'token') renderToken();
    else if (state.step === 'register') renderRegister();
    else if (state.step === 'creds') renderSpinner('Preparando…');
    else renderDone();
  }

  render();
}());
