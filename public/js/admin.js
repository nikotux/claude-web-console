// admin.js — página /admin: reutiliza el MISMO panel de usuarios que la
// pestaña "Usuarios" del menú Sistema de la consola (modules/system/users.js).
import { hydrateIcons } from './ui/icons.js';
import { mountUsersPanel } from './modules/system/users.js';
import { initI18n, applyI18n } from './ui/i18n.js';

const meForLang = await (async () => {
  try { return await (await fetch('/api/whoami')).json(); } catch { return null; }
})();
await initI18n(meForLang?.lang || 'es');
applyI18n(document);

hydrateIcons();
mountUsersPanel(document.getElementById('users-root'));
