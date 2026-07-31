// login.js — login con usuario+contraseña, o con el token maestro (plegable).
import { initI18n, applyI18n } from './ui/i18n.js';

// Esta página no tiene sesión: inferimos inglés del navegador y para cualquier
// otro idioma usamos español, que es el fallback seguro de la interfaz.
const lang = navigator.language?.toLowerCase().startsWith('en') ? 'en' : 'es';
await initI18n(lang);
applyI18n(document);

const form = document.getElementById('login-form');
const errorEl = document.getElementById('error');

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

async function doLogin(body) {
  errorEl.hidden = true;
  try {
    const res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      window.location.href = '/';
    } else {
      const data = await res.json().catch(() => ({}));
      showError(data.error || 'Acceso denegado.');
    }
  } catch {
    showError('No se pudo conectar con el servidor.');
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  if (!username || !password) return;
  doLogin({ username, password });
});

document.getElementById('token-btn').addEventListener('click', () => {
  const token = document.getElementById('token').value.trim();
  if (!token) return;
  doLogin({ token });
});
