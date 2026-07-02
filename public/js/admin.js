// admin.js — página /admin: reutiliza el MISMO panel de usuarios que la
// pestaña "Usuarios" del menú Sistema de la consola (modules/system/users.js).
import { hydrateIcons } from './ui/icons.js';
import { mountUsersPanel } from './modules/system/users.js';

hydrateIcons();
mountUsersPanel(document.getElementById('users-root'));
