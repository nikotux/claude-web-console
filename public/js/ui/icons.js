// ui/icons.js — sistema de íconos ÚNICO para toda la app.
//
// Un solo lenguaje visual para acciones/navegación: SVG de trazo (stroke),
// mismo viewBox y grosor, color heredado (currentColor) para que combine con
// cualquier texto/estado. NO reemplaza los íconos de TIPO DE ARCHIVO del
// Gestor de Archivos (esos son deliberadamente distintos: coloridos y
// codificados por extensión, como en Finder/VS Code).
//
// Uso: icon('refresh')  ó  icon('refresh', { size: 16, className: 'foo' })

const VB = '0 0 24 24';
const SW = 'var(--cwc-icon-stroke, 1.8)';
const COMMON = `fill="none" stroke="currentColor" stroke-width="${SW}" stroke-linecap="round" stroke-linejoin="round"`;

// Contenido interno (sin <svg> wrapper) por nombre de ícono.
const PATHS = {
  menu: `<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>`,
  plus: `<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`,
  minus: `<line x1="5" y1="12" x2="19" y2="12"/>`,
  close: `<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>`,
  chevronRight: `<polyline points="9,5 16,12 9,19"/>`,
  chevronDown: `<polyline points="5,9 12,16 19,9"/>`,
  chevronLeft: `<polyline points="15,5 8,12 15,19"/>`,
  refresh: `<path d="M20 11a8 8 0 0 0-14.6-4.6M4 13a8 8 0 0 0 14.6 4.6"/><polyline points="19,4 19,9 14,9"/><polyline points="5,20 5,15 10,15"/>`,
  terminal: `<rect x="3" y="4" width="18" height="16" rx="2"/><polyline points="7,9 11,12.5 7,16"/><line x1="12" y1="16" x2="16" y2="16"/>`,
  // "Mi Consola" (este proyecto): monitor de escritorio con el prompt >_ —
  // espejo del emoji 🖥️ que ya se usa en docs/chats para referirse a la
  // consola. Identidad visual del proyecto (ver ui/places.js).
  console: `<rect x="2.5" y="4" width="19" height="13" rx="2"/><polyline points="6.5,7.8 9.5,10.5 6.5,13.2"/><line x1="11.5" y1="13.2" x2="15" y2="13.2"/><line x1="12" y1="17" x2="12" y2="20.5"/><line x1="8.5" y1="20.5" x2="15.5" y2="20.5"/>`,
  sparkle: `<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>`,
  help: `<circle cx="12" cy="12" r="9"/><path d="M9.4 9.4a2.6 2.6 0 1 1 3.8 2.3c-.8.4-1.2 1-1.2 1.9"/><circle cx="12" cy="17" r=".6" fill="currentColor" stroke="none"/>`,
  // Salvavidas: ayuda y asistencia.
  lifebuoy: `<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><line x1="5.6" y1="5.6" x2="9.2" y2="9.2"/><line x1="18.4" y1="5.6" x2="14.8" y2="9.2"/><line x1="5.6" y1="18.4" x2="9.2" y2="14.8"/><line x1="18.4" y1="18.4" x2="14.8" y2="14.8"/>`,
  search: `<circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.5" y1="15.5" x2="21" y2="21"/>`,
  language: `<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M4.4 8h15.2M4.4 16h15.2"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/>`,
  gitCommit: `<circle cx="12" cy="12" r="3.2"/><line x1="3" y1="12" x2="8.8" y2="12"/><line x1="15.2" y1="12" x2="21" y2="12"/>`,
  bug: `<path d="M9 8a3 3 0 0 1 6 0"/><rect x="7.5" y="8" width="9" height="10" rx="4.5"/><line x1="12" y1="12" x2="12" y2="18"/><path d="M7.5 11H4M7.5 15H4.5M7.5 18l-2.5 2M16.5 11H20M16.5 15H19.5M16.5 18l2.5 2M9.5 8 8 6M14.5 8 16 6"/>`,
  home: `<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h4v-6h2v6h4a1 1 0 0 0 1-1v-9"/>`,
  gitBranch: `<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="9" r="2.4"/><path d="M6 8.4V15.6"/><path d="M6 15.6c0-3.6 3-4.8 6-4.8h4.7"/><path d="M18 6.4V6.8"/>`,
  // Worktree efímero: límite exterior punteado + caja sólida aislada.
  isolated: `<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="2.5 2.5"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none"/>`,
  check: `<polyline points="4,13 9,18 20,6"/>`,
  // Estados de ticket/PR del tablero Bugs & PRs (Fase 2 del rediseño: los
  // emoji funcionales 🎫✅/🎫✔/🎫✕/🎫○/◐ de las celdas pasan a SVG de trazo
  // para render consistente entre plataformas; el color lo pone .bb-icell--*).
  halfCircle: `<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>`,
  ticketDone: `<rect x="3" y="6" width="18" height="12" rx="2"/><line x1="15.5" y1="6.8" x2="15.5" y2="17.2" stroke-dasharray="2.2 2.2"/><circle cx="9.3" cy="12" r="4.1"/><polyline points="7.6,12.1 9,13.5 11.3,10.8"/>`,
  ticketCheck: `<rect x="3" y="6" width="18" height="12" rx="2"/><line x1="15.5" y1="6.8" x2="15.5" y2="17.2" stroke-dasharray="2.2 2.2"/><polyline points="6.6,12.2 8.9,14.4 12.4,10"/>`,
  ticketX: `<rect x="3" y="6" width="18" height="12" rx="2"/><line x1="15.5" y1="6.8" x2="15.5" y2="17.2" stroke-dasharray="2.2 2.2"/><line x1="7.2" y1="9.8" x2="11.6" y2="14.2"/><line x1="11.6" y1="9.8" x2="7.2" y2="14.2"/>`,
  ticketDot: `<rect x="3" y="6" width="18" height="12" rx="2"/><line x1="15.5" y1="6.8" x2="15.5" y2="17.2" stroke-dasharray="2.2 2.2"/><circle cx="9.3" cy="12" r="2.7"/>`,
  play: `<polygon points="6,4 20,12 6,20"/>`,
  trash: `<polyline points="4,7 20,7"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/>`,
  folder: `<path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>`,
  // Clip de adjuntar (composer del chat): un solo botón para imágenes, PDF,
  // texto y binarios — la consola detecta el tipo sola (ver chat/attachments.js).
  paperclip: `<path d="M20 11.5 12 19.5a4.5 4.5 0 0 1-6.4-6.4l8-8a3 3 0 0 1 4.3 4.3l-8 8a1.5 1.5 0 0 1-2.2-2.2l7.3-7.3"/>`,
  // Archivo genérico (chip de adjunto no-imagen en la burbuja).
  fileGeneric: `<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><polyline points="13,3 13,8 18,8"/>`,
  // Modo documento del chat: hoja con líneas de texto.
  docMode: `<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><polyline points="13,3 13,8 18,8"/><line x1="8" y1="12" x2="15" y2="12"/><line x1="8" y1="15.5" x2="15" y2="15.5"/><line x1="8" y1="19" x2="13" y2="19"/>`,
  upload: `<line x1="12" y1="20" x2="12" y2="6"/><polyline points="6,11 12,5 18,11"/><line x1="5" y1="20" x2="19" y2="20"/>`,
  download: `<line x1="12" y1="4" x2="12" y2="14"/><polyline points="6,9 12,15 18,9"/><line x1="5" y1="20" x2="19" y2="20"/>`,
  grid: `<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>`,
  list: `<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>`,
  gear: `<circle cx="12" cy="12" r="3"/><path d="M12 3v2.4M12 18.6V21M21 12h-2.4M5.4 12H3M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7M18.4 18.4l-1.7-1.7M7.3 7.3 5.6 5.6"/>`,
  keyboard: `<rect x="2.5" y="6" width="19" height="12" rx="2"/><line x1="6" y1="10" x2="6" y2="10.01"/><line x1="9.5" y1="10" x2="9.5" y2="10.01"/><line x1="13" y1="10" x2="13" y2="10.01"/><line x1="16.5" y1="10" x2="16.5" y2="10.01"/><line x1="7" y1="14.5" x2="17" y2="14.5"/>`,
  clipboard: `<rect x="6" y="4" width="12" height="17" rx="2"/><rect x="9" y="2.2" width="6" height="3.6" rx="1"/>`,
  eye: `<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>`,
  logout: `<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><polyline points="15,16 20,12 15,8"/><line x1="20" y1="12" x2="9" y2="12"/>`,
  archive: `<rect x="3" y="8" width="18" height="12" rx="1.5"/><path d="M3 8V5.5A1.5 1.5 0 0 1 4.5 4h15A1.5 1.5 0 0 1 21 5.5V8"/><line x1="10" y1="12" x2="14" y2="12"/>`,
  more: `<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>`,
  edit: `<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M14.5 7.5l3 3"/>`,
  // Tareas pendientes (módulo `tasks`): checklist en portapapeles.
  checklist: `<rect x="5" y="4" width="14" height="17" rx="2"/><rect x="9" y="2.4" width="6" height="3.4" rx="1"/><polyline points="8,11 9.4,12.4 12,9.6"/><polyline points="8,16.2 9.4,17.6 12,14.8"/><line x1="14" y1="11" x2="16.5" y2="11"/><line x1="14" y1="16.2" x2="16.5" y2="16.2"/>`,
  // Extracción de audio (módulo `audio`): micrófono.
  mic: `<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="8.5" y1="21" x2="15.5" y2="21"/>`,
  // Fantasma: sesión de terminal SIN Claude adentro (sin modelo).
  ghost: `<path d="M5 11a7 7 0 0 1 14 0v9l-2.3-2-2.4 2-2.3-2-2.3 2-2.4-2L5 20z"/><circle cx="9.5" cy="10.5" r=".9" fill="currentColor" stroke="none"/><circle cx="14.5" cy="10.5" r=".9" fill="currentColor" stroke="none"/>`,
  // Recursos de sistema (mini-gauges del rail colapsado).
  cpu: `<rect x="7" y="7" width="10" height="10" rx="1.5"/><line x1="10" y1="7" x2="10" y2="3.5"/><line x1="14" y1="7" x2="14" y2="3.5"/><line x1="10" y1="20.5" x2="10" y2="17"/><line x1="14" y1="20.5" x2="14" y2="17"/><line x1="7" y1="10" x2="3.5" y2="10"/><line x1="7" y1="14" x2="3.5" y2="14"/><line x1="20.5" y1="10" x2="17" y2="10"/><line x1="20.5" y1="14" x2="17" y2="14"/>`,
  ram: `<rect x="3" y="8" width="18" height="9" rx="1.5"/><line x1="7.5" y1="17" x2="7.5" y2="20"/><line x1="12" y1="17" x2="12" y2="20"/><line x1="16.5" y1="17" x2="16.5" y2="20"/><line x1="7.5" y1="11" x2="7.5" y2="14"/><line x1="12" y1="11" x2="12" y2="14"/><line x1="16.5" y1="11" x2="16.5" y2="14"/>`,
  disk: `<ellipse cx="12" cy="6.5" rx="8" ry="3"/><path d="M4 6.5v11c0 1.7 3.6 3 8 3s8-1.3 8-3v-11"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>`,
  // Enlace externo (abre en pestaña nueva): caja + flecha saliente.
  externalLink: `<path d="M14 4h6v6"/><line x1="20" y1="4" x2="11" y2="13"/><path d="M18 13.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H11"/>`,
  // Expandir a vista amplia (flechas a las 4 esquinas) — usado por el dashboard
  // de tickets para abrir una columna como tabla ancha tipo Excel.
  maximize: `<polyline points="9,4 4,4 4,9"/><polyline points="15,4 20,4 20,9"/><polyline points="9,20 4,20 4,15"/><polyline points="15,20 20,20 20,15"/>`,
  // Señal/interfono (motor Pac-Man, estado "delegando"): punto + ondas
  // concéntricas a ambos lados — eco del 📻 del panel Interfono. Se usa como
  // badge diminuto sobre el Pac-Man cuando está esperando la vuelta de un
  // subagente/proceso delegado (Task tool, pool paralelo, investigación, etc.).
  relay: `<circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none"/><path d="M8.6 8.6a5 5 0 0 0 0 6.8"/><path d="M15.4 8.6a5 5 0 0 0 0 6.8"/><path d="M5.6 5.6a10 10 0 0 0 0 12.8"/><path d="M18.4 5.6a10 10 0 0 0 0 12.8"/>`,
  // Pulso/actividad en vivo (botón "Vista Raw", PLAN-544): línea de latido tipo ECG.
  pulse: `<polyline points="2,13 7,13 9.5,6.5 13,19 15.5,13 22,13"/>`,
  // Sala compartida: dos conversaciones superpuestas.
  room: `<path d="M3 5h13v9H8l-4 3v-3H3z"/><path d="M9 17h12V8h-3"/>`,
  // Cerebro/red neuronal (botón "Cerebro del Pad"): dos lóbulos simétricos con
  // un tallo central — el banco de conocimientos visto como órgano vivo.
  brain: `<path d="M12 5.2v13.6"/><path d="M9.6 4.2a2.6 2.6 0 0 0-2.5 2.1 2.4 2.4 0 0 0-2 2.4 2.5 2.5 0 0 0 .6 1.6 2.5 2.5 0 0 0-.5 1.5 2.5 2.5 0 0 0 1.6 2.3 2.5 2.5 0 0 0 2.4 3.1 2.4 2.4 0 0 0 2.4-1.6"/><path d="M14.4 4.2a2.6 2.6 0 0 1 2.5 2.1 2.4 2.4 0 0 1 2 2.4 2.5 2.5 0 0 1-.6 1.6 2.5 2.5 0 0 1 .5 1.5 2.5 2.5 0 0 1-1.6 2.3 2.5 2.5 0 0 1-2.4 3.1 2.4 2.4 0 0 1-2.4-1.6"/>`,
};

// Devuelve markup <svg>…</svg> para el nombre dado. Si no existe, un círculo
// discreto (evita romper el layout con un ícono ausente).
// Escapa un valor para interpolarlo seguro dentro de un atributo HTML con
// comillas dobles. `icon()` es la función de íconos ÚNICA de toda la app: aunque
// hoy todos los call-sites pasan `className` literal, no imponía barrera para un
// futuro caller que derive la clase de datos externos.
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function icon(name, { size, className = '' } = {}) {
  const body = PATHS[name] || `<circle cx="12" cy="12" r="8"/>`;
  const px = size || 'var(--cwc-icon-size, 18px)';
  const cls = className ? ` class="cwc-icon ${escapeAttr(className)}"` : ' class="cwc-icon"';
  return `<svg${cls} viewBox="${VB}" width="${px}" height="${px}" ${COMMON} aria-hidden="true">${body}</svg>`;
}

export const ICON_NAMES = Object.keys(PATHS);

// Rellena todo elemento con [data-icon="nombre"] con su SVG. Permite escribir
// los íconos declarativamente en el HTML estático (data-icon="menu") sin perder
// el sistema único. Idempotente: no re-inyecta si ya tiene el ícono.
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.dataset.iconDone) continue;
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
    el.dataset.iconDone = '1';
  }
}
