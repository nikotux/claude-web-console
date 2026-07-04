// ui/dialog.js — diálogos y modales PROPIOS de la app.
//
// Reemplazan por completo a confirm()/prompt()/alert() nativos (prohibidos).
// Estilos en public/css/ui.css. Tres niveles:
//   openModal({...})    → cáscara genérica (la usan Lanzador/Uso/Sistema)
//   confirmDialog({...}) → Promise<boolean>
//   promptDialog({...})  → Promise<string|null>
//   alertDialog({...})   → Promise<void> (aviso con un solo botón)
import { icon } from './icons.js';

// Pila global de modales abiertos (los que crea openModal). Esc solo debe
// cerrar el que está arriba: stopPropagation() no evita que OTROS listeners
// registrados en el mismo nodo (document) y misma fase (capture) se disparen,
// así que sin esta pila, un Esc cierra en cascada todos los modales apilados.
const modalStack = [];

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
      <button class="btn-ghost btn--sm btn--icon dlg-x" title="Cerrar">${icon('close', { size: 15 })}</button>
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
    const idx = modalStack.indexOf(entry);
    if (idx !== -1) modalStack.splice(idx, 1);
    onClose?.();
  }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    // Solo el modal de arriba de la pila reacciona a Esc; los de abajo
    // ignoran el evento en vez de cerrarse en cascada.
    if (modalStack[modalStack.length - 1] !== entry) return;
    e.stopPropagation();
    close();
  }
  entry.close = close;
  modalStack.push(entry);
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
  title = 'Confirmar', message = '', confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar', danger = false,
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

// Entrada de texto. Devuelve el string o null si se cancela.
export function promptDialog({
  title = '', message = '', value = '', placeholder = '',
  confirmLabel = 'Aceptar', cancelLabel = 'Cancelar',
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
export function alertDialog({ title = 'Aviso', message = '', okLabel = 'Entendido' } = {}) {
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
export function textEditorDialog({ title = 'Editar', hint = '', value = '', width = 640, saveLabel = 'Guardar', onSave } = {}) {
  return new Promise((resolve) => {
    let saved = false;
    const m = openModal({ title, width, onClose: () => resolve(saved) });
    const box = document.createElement('div');
    box.innerHTML = `
      ${hint ? '<p class="dlg-editor-hint"></p>' : ''}
      <textarea class="dlg-editor-text" spellcheck="false"></textarea>
      <p class="dlg-editor-err" hidden></p>
      <div class="dlg-actions">
        <button class="btn-ghost btn--sm" data-ref="cancel">Cancelar</button>
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
        err.textContent = e?.message || 'No se pudo guardar.';
        err.hidden = false;
        save.disabled = false;
      }
    });
    ta.focus();
  });
}
