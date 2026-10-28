// ui/pacman.js — MOTOR de estados "Pac-Man" (componente compartido, usado en
// TODA la consola: header del chat, tarjetas de Sesiones, y todo loader de
// proceso largo — revisión de salud, triage, backup, desk-live, investigar,
// Optimización IA, Uso).
//
// Catálogo ÚNICO de estados (PAC_STATES): agregar/ajustar acá se propaga a
// toda la app. Regla de diseño (pedido del usuario 2026-07-05): la ÚNICA
// animación estática es 'dormant' (nada activo ni delegado). Todo lo demás
// tiene movimiento propio y distinguible — el color solo no alcanza, cada
// estado se reconoce por CÓMO se mueve, no solo por su tono:
//   - working    dorado, mordisco rápido + bolitas viajando de derecha a
//                izquierda: un proceso trabajando activamente ahora mismo.
//   - delegating violeta, boca entreabierta fija + bolitas orbitando de ida
//                y vuelta (no en una sola dirección) + badge con el ícono
//                del interfono: está esperando la vuelta de un subagente u
//                otro proceso delegado (Task tool, pool paralelo, una
//                investigación, una consulta a Desk).
//   - queued     ámbar atenuado, pulso de opacidad ("respirando"): en cola
//                detrás de un lock o de otro paso, todavía no arrancó.
//   - waiting    verde, parpadeo lento de boca sin bolitas: esperando que
//                decidas/respondas vos (permiso pendiente, tu turno).
//   - stale      ámbar apagado, ESTÁTICO: señal perdida/vieja — no se sabe
//                si sigue activo (incertidumbre, no confirmación de nada).
//   - error      rojo, ESTÁTICO: paró por una falla; no hay proceso corriendo.
//   - dormant    gris, ESTÁTICO: nada activo ni en background. Default.
//
// Retrocompat: `working:true/false` (API vieja) sigue andando — se mapea a
// 'working'/'dormant' — así ningún llamador no migrado se rompe.
import { icon } from './icons.js';

// Escapa un valor para uso seguro dentro de un atributo HTML con comillas
// dobles (title puede venir de datos user-controlled: título de sesión/chat,
// nombre de modelo, fase de un job, etc.).
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// clase CSS que dispara la animación/color de cada estado (ver .cwc-pacman en
// ui.css). 'working' conserva el nombre histórico `is-working` (ya usado en 3
// lugares del CSS) para no romper nada del comportamiento ya afinado.
export const PAC_STATES = {
  working: 'is-working',
  delegating: 'pac-st-delegating',
  queued: 'pac-st-queued',
  waiting: 'pac-st-waiting',
  stale: 'pac-st-stale',
  error: 'pac-st-error',
  dormant: '',
};

// Normaliza cualquier entrada (state nuevo, o working:bool viejo) a una clave
// válida de PAC_STATES. Nunca revienta con un estado desconocido: cae a
// 'dormant' (fallback más seguro — nunca "trabajando" a los ponchazos).
function resolveState({ state, working }) {
  if (state && PAC_STATES[state] !== undefined) return state;
  if (working === false) return 'dormant';
  if (working === true) return 'working';
  return 'dormant';
}

// Arma la lista de clases del contenedor `.cwc-pacman` para un estado+tamaño.
// La usan tanto `pacman()` (render inicial) como las actualizaciones EN
// LUGAR (sessions.js, health-review-modal.js, etc.) que solo tocan
// `el.className` sin regenerar el HTML interno.
export function pacClass(input = 'working', { size = '', cls = '' } = {}) {
  const st = resolveState(typeof input === 'string' ? { state: input } : (input || {}));
  const sizeCls = size === 'sm' ? 'pac-sm' : '';
  return ['cwc-pacman', PAC_STATES[st], sizeCls, cls].filter(Boolean).join(' ');
}

// Retrocompat clave: `pacman()` SIN argumentos (decenas de call sites en
// loaders de Salud/Backup/Optimización/Uso) siempre significó "el loader
// está acá, luego está trabajando" — default histórico `working=true`, NO
// 'dormant'. Se preserva a propósito: 'dormant' es el fallback de resolveState
// solo para un estado EXPLÍCITO desconocido, nunca para "no me dijeron nada".
export function pacman({ state, working = true, size = '', cls = '', title = '' } = {}) {
  const classes = pacClass({ state, working }, { size, cls });
  return `<span class="${escapeAttr(classes)}"${title ? ` title="${escapeAttr(title)}"` : ''}>` +
    '<span class="pac-man"></span>' +
    '<span class="pac-track"><i class="pac-dot"></i><i class="pac-dot"></i><i class="pac-dot"></i></span>' +
    // El badge SIEMPRE está en el markup (una actualización en lugar solo
    // cambia la clase del contenedor, nunca reinyecta HTML interno); su
    // visibilidad la decide el CSS según el estado (.pac-st-delegating .pac-badge).
    `<i class="pac-badge">${icon('relay', { size: '9px' })}</i>` +
    '</span>';
}
