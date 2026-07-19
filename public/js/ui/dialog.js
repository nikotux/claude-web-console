// ui/dialog.js — diálogos y modales PROPIOS de la app.
//
// Reemplazan por completo a confirm()/prompt()/alert() nativos (prohibidos).
// Estilos en public/css/ui.css. Tres niveles:
//   openModal({...})    → cáscara genérica (la usan Lanzador/Uso/Sistema)
//   confirmDialog({...}) → Promise<boolean>
//   promptDialog({...})  → Promise<string|null>
//   alertDialog({...})   → Promise<void> (aviso con un solo botón)
import { icon } from './icons.js';
import { t } from './i18n.js';

// Pila global de "capas Esc" abiertas: modales (openModal) Y popups
// descartables (ui/popup.js). Esc solo debe cerrar la que está ARRIBA:
// stopPropagation() no evita que OTROS listeners registrados en el mismo nodo
// (document) y misma fase (capture) se disparen, así que sin esta pila
// compartida un Esc cierra en cascada. popup.js se suma a ESTA misma pila para
// que un popup abierto sobre un modal no cierre a ambos con un solo Esc.
export const escLayers = [];
// ¿`entry` es la capa de arriba de la pila? (referencia exacta)
export function isTopEscLayer(entry) {
  return escLayers[escLayers.length - 1] === entry;
}

// Cáscara de modal. Devuelve { overlay, card, body, close, setTitle }.
// Cierra con Esc, clic en el fondo o el botón ×; onClose se llama UNA vez.
export function openModal({ title = '', width = 480, onClose = null } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'dlg-overlay';
  const card = document.createElement('div');
  card.className = 'dlg-card';
  card.style.maxWidth = typeof width === 'number' ? `${width}px` : width;
  card.innerHTML = `
    <header class="dlg-head">
      <span class="dlg-title"></span>
      <button class="btn-ghost btn--sm btn--icon dlg-x" title="${t('core.dialog.close', 'Cerrar')}">${icon('close', { size: 15 })}</button>
    </header>
    <div class="dlg-body"></div>`;
  card.querySelector('.dlg-title').textContent = title;
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  let closed = false;
  const entry = {};
  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    const idx = escLayers.indexOf(entry);
    if (idx !== -1) escLayers.splice(idx, 1);
    onClose?.();
  }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    // Solo la capa de arriba de la pila reacciona a Esc; las de abajo (u otro
    // popup encima) ignoran el evento en vez de cerrarse en cascada.
    if (!isTopEscLayer(entry)) return;
    e.stopPropagation();
    close();
  }
  entry.close = close;
  escLayers.push(entry);
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  card.querySelector('.dlg-x').addEventListener('click', close);

  return {
    overlay, card,
    body: card.querySelector('.dlg-body'),
    close,
    setTitle(t) { card.querySelector('.dlg-title').textContent = t; },
  };
}

// Confirmación. danger=true pinta el botón principal en rojo.
export function confirmDialog({
  title = t('core.dialog.confirm', 'Confirmar'), message = '', confirmLabel = t('core.dialog.confirm', 'Confirmar'),
  cancelLabel = t('core.dialog.cancel', 'Cancelar'), danger = false,
} = {}) {
  return new Promise((resolve) => {
    const m = openModal({ title, width: 400, onClose: () => resolve(false) });
    const msg = document.createElement('p');
    msg.className = 'dlg-msg';
    msg.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'dlg-actions';
    const cancel = document.createElement('button');
    cancel.className = 'btn-ghost';
    cancel.textContent = cancelLabel;
    const ok = document.createElement('button');
    ok.className = danger ? 'btn btn--danger' : 'btn';
    ok.textContent = confirmLabel;
    actions.append(cancel, ok);
    m.body.append(msg, actions);
    cancel.addEventListener('click', () => m.close());
    ok.addEventListener('click', () => { resolve(true); m.close(); });
    ok.focus();
  });
}

// Confirmación ADAPTATIVA (pedido del usuario 2026-07-07 para el botón "Detener"
// del chat): en ESCRITORIO usa la ventana centrada de confirmDialog; en MÓVIL
// muestra un "menú de deslizamiento" (bottom sheet que sube desde abajo, con
// grip + swipe-down para cancelar). Devuelve Promise<boolean> igual que
// confirmDialog. confirmLabel es la acción (p.ej. "Parar"), cancelLabel aborta.
export function confirmSheet({
  title = t('core.dialog.confirm', 'Confirmar'), message = '', confirmLabel = t('core.dialog.confirm', 'Confirmar'),
  cancelLabel = t('core.dialog.cancel', 'Cancelar'), danger = false,
} = {}) {
  const mobile = window.matchMedia('(max-width: 768px)').matches;
  if (!mobile) return confirmDialog({ title, message, confirmLabel, cancelLabel, danger });

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'dlg-overlay dlg-overlay--sheet';
    const sheet = document.createElement('div');
    sheet.className = 'dlg-sheet';

    const grip = document.createElement('div');
    grip.className = 'dlg-sheet-grip';
    const head = document.createElement('div');
    head.className = 'dlg-sheet-head';
    head.textContent = title;
    sheet.append(grip, head);
    if (message) {
      const p = document.createElement('p');
      p.className = 'dlg-sheet-msg';
      p.textContent = message;
      sheet.appendChild(p);
    }
    const actions = document.createElement('div');
    actions.className = 'dlg-sheet-actions';
    const confirm = document.createElement('button');
    confirm.className = `btn${danger ? ' btn--danger' : ''} dlg-sheet-confirm`;
    confirm.textContent = confirmLabel;
    const cancel = document.createElement('button');
    cancel.className = 'btn-ghost dlg-sheet-cancel';
    cancel.textContent = cancelLabel;
    actions.append(confirm, cancel);
    sheet.appendChild(actions);
    overlay.appendChild(sheet);
    document.body.appendChild(overlay);

    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      // Salida deslizando hacia abajo (usa la transition base de .dlg-sheet).
      sheet.style.transform = 'translateY(100%)';
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 200);
      resolve(val);
    };
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(false); });
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));

    // Swipe-down para descartar (= Cancelar): arrastrar el sheet > 80px lo cierra.
    let startY = null, dy = 0;
    sheet.addEventListener('touchstart', (e) => {
      startY = e.touches[0].clientY; dy = 0; sheet.style.transition = 'none';
    }, { passive: true });
    sheet.addEventListener('touchmove', (e) => {
      if (startY == null) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    sheet.addEventListener('touchend', () => {
      sheet.style.transition = '';
      if (dy > 80) finish(false);
      else sheet.style.transform = '';
      startY = null;
    });
  });
}

// Entrada de texto. Devuelve el string o null si se cancela.
export function promptDialog({
  title = '', message = '', value = '', placeholder = '',
  confirmLabel = t('core.dialog.accept', 'Aceptar'), cancelLabel = t('core.dialog.cancel', 'Cancelar'),
} = {}) {
  return new Promise((resolve) => {
    const m = openModal({ title, width: 400, onClose: () => resolve(null) });
    if (message) {
      const msg = document.createElement('p');
      msg.className = 'dlg-msg';
      msg.textContent = message;
      m.body.appendChild(msg);
    }
    const input = document.createElement('input');
    input.className = 'dlg-input';
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder;
    input.autocapitalize = 'off';
    input.spellcheck = false;
    const actions = document.createElement('div');
    actions.className = 'dlg-actions';
    const cancel = document.createElement('button');
    cancel.className = 'btn-ghost';
    cancel.textContent = cancelLabel;
    const ok = document.createElement('button');
    ok.className = 'btn';
    ok.textContent = confirmLabel;
    actions.append(cancel, ok);
    m.body.append(input, actions);

    const submit = () => { resolve(input.value); m.close(); };
    cancel.addEventListener('click', () => m.close());
    ok.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    input.focus();
    input.select();
  });
}

// Aviso simple (reemplaza alert()).
export function alertDialog({ title = t('core.dialog.notice', 'Aviso'), message = '', okLabel = t('core.dialog.understood', 'Entendido') } = {}) {
  return new Promise((resolve) => {
    const m = openModal({ title, width: 420, onClose: () => resolve() });
    const msg = document.createElement('p');
    msg.className = 'dlg-msg';
    msg.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'dlg-actions';
    const ok = document.createElement('button');
    ok.className = 'btn';
    ok.textContent = okLabel;
    actions.append(ok);
    m.body.append(msg, actions);
    ok.addEventListener('click', () => m.close());
    ok.focus();
  });
}

// Editor de texto plano en modal (p.ej. los contextos editables de bugfixes).
// `onSave(texto)` puede ser async: si tira, el error se muestra en el propio
// modal sin cerrarlo; si resuelve, se cierra. Devuelve true si se guardó.
export function textEditorDialog({ title = t('core.dialog.edit', 'Editar'), hint = '', value = '', width = 640, saveLabel = t('core.dialog.save', 'Guardar'), onSave } = {}) {
  return new Promise((resolve) => {
    let saved = false;
    const m = openModal({ title, width, onClose: () => resolve(saved) });
    const box = document.createElement('div');
    box.innerHTML = `
      ${hint ? '<p class="dlg-editor-hint"></p>' : ''}
      <textarea class="dlg-editor-text" spellcheck="false"></textarea>
      <p class="dlg-editor-err" hidden></p>
      <div class="dlg-actions">
        <button class="btn-ghost btn--sm" data-ref="cancel">${t('core.dialog.cancel', 'Cancelar')}</button>
        <button class="btn btn--sm" data-ref="save"></button>
      </div>`;
    if (hint) box.querySelector('.dlg-editor-hint').textContent = hint;
    const ta = box.querySelector('.dlg-editor-text');
    ta.value = value;
    const err = box.querySelector('.dlg-editor-err');
    const save = box.querySelector('[data-ref="save"]');
    save.textContent = saveLabel;
    m.body.appendChild(box);
    box.querySelector('[data-ref="cancel"]').addEventListener('click', () => m.close());
    save.addEventListener('click', async () => {
      save.disabled = true;
      err.hidden = true;
      try {
        await onSave?.(ta.value);
        saved = true;
        m.close();
      } catch (e) {
        err.textContent = e?.message || t('core.dialog.saveError', 'No se pudo guardar.');
        err.hidden = false;
        save.disabled = false;
      }
    });
    ta.focus();
  });
}
