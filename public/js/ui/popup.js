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
export function dismissablePopup(el, { onDismiss } = {}) {
  let done = false;

  function dismiss() {
    if (done) return;
    done = true;
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', dismiss, true);
    window.removeEventListener('blur', dismiss);
    window.removeEventListener('resize', dismiss);
    onDismiss?.();
  }

  function onPointer(e) { if (!el.contains(e.target)) dismiss(); }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); dismiss(); } }

  // Diferimos el alta del pointerdown para no capturar el MISMO gesto que abrió
  // el popup (el pointerdown del click/contextmenu que lo disparó).
  setTimeout(() => { if (!done) document.addEventListener('pointerdown', onPointer, true); }, 0);
  document.addEventListener('keydown', onKey, true);        // captura: cierra antes que otros Esc
  window.addEventListener('scroll', dismiss, true);         // captura: cualquier scroll, no solo el de window
  window.addEventListener('blur', dismiss);
  window.addEventListener('resize', dismiss);

  return dismiss;
}
