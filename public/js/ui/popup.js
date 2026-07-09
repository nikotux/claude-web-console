// ui/popup.js — helper ÚNICO para popups descartables (menús contextuales, ⋯).
//
// Muestra un elemento ya posicionado y lo cierra ante cualquier forma de
// "irme de acá": pointerdown fuera, Esc, scroll, blur de ventana, resize, o al
// invocar la función devuelta. Idempotente: se puede llamar dismiss() varias
// veces sin efecto. Resuelve el bug de menús que quedaban colgados porque solo
// escuchaban 'click'.
//
// Uso:
//   el.hidden = false;                      // o document.body.appendChild(el)
//   const dismiss = dismissablePopup(el, { onDismiss: () => el.remove() });
//   // ...al elegir una acción: dismiss(); accion();
import { escLayers, isTopEscLayer } from './dialog.js';

export function dismissablePopup(el, { onDismiss } = {}) {
  let done = false;
  // Nos sumamos a la pila global de capas Esc de dialog.js: si este popup se
  // abre SOBRE un modal, un Esc cierra SOLO el que está arriba (este popup),
  // no ambos en cascada. La capa se saca en dismiss().
  const layer = {};
  escLayers.push(layer);

  function dismiss() {
    if (done) return;
    done = true;
    const i = escLayers.indexOf(layer);
    if (i !== -1) escLayers.splice(i, 1);
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('blur', dismiss);
    window.removeEventListener('resize', dismiss);
    onDismiss?.();
  }

  function onPointer(e) { if (!el.contains(e.target)) dismiss(); }
  // Solo cierra si este popup es la capa de arriba (si hay un modal abierto
  // ENCIMA, que lo maneje él); evita la cascada popup+modal con un solo Esc.
  function onKey(e) { if (e.key === 'Escape' && isTopEscLayer(layer)) { e.stopPropagation(); dismiss(); } }
  // Scroll DENTRO del popup (una lista larga, p.ej. el autocompletado de
  // comandos) no es "irme de acá": solo cierra el scroll de afuera.
  function onScroll(e) { if (!el.contains(e.target)) dismiss(); }

  // Diferimos el alta del pointerdown para no capturar el MISMO gesto que abrió
  // el popup (el pointerdown del click/contextmenu que lo disparó).
  setTimeout(() => { if (!done) document.addEventListener('pointerdown', onPointer, true); }, 0);
  document.addEventListener('keydown', onKey, true);        // captura: cierra antes que otros Esc
  window.addEventListener('scroll', onScroll, true);        // captura: cualquier scroll, no solo el de window
  window.addEventListener('blur', dismiss);
  window.addEventListener('resize', dismiss);

  return dismiss;
}
