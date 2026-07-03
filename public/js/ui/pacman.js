// ui/pacman.js — Pac-Man loader COMPARTIDO (el mismo del header del chat).
//
// Indicador de "proceso largo corriendo": un Pac-Man dorado masticando
// bolitas que llegan de derecha a izquierda (CSS puro, ver .cwc-pacman en
// ui.css). Usarlo en TODA espera significativa (> ~5 s: revisión profunda,
// triage de bugs, subida de PRs, push a GitHub…) en lugar del spinner
// genérico — el spinner queda para cargas breves (listar, abrir un modal).
//
// `working:false` lo pinta dormido (gris, boca cerrada, sin bolitas): solo
// lo usa el header del chat, que alterna vivo/dormido; un loader de proceso
// se muestra siempre working y se REMUEVE al terminar.
export function pacman({ working = true, cls = '', title = '' } = {}) {
  return `<span class="cwc-pacman${working ? ' is-working' : ''}${cls ? ` ${cls}` : ''}"${title ? ` title="${title}"` : ''}>` +
    '<span class="pac-man"></span>' +
    '<span class="pac-track"><i class="pac-dot"></i><i class="pac-dot"></i><i class="pac-dot"></i></span>' +
    '</span>';
}
