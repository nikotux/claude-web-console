// modules/mobile/auxbar.js — barra de teclas auxiliares + dictado (móvil).
//
// - Teclas: Esc, Tab, ⇧Tab, Ctrl (armado), flechas, ^C.
// - Ctrl "armado": el próximo carácter tipeado se convierte en Ctrl+<char>.
// - Pegar: navigator.clipboard.readText() -> PTY.
// - Dictado: campo de texto (con IME/composición) + Enviar. El teclado móvil
//   dicta mucho mejor sobre un input normal que inyectando en xterm.
import { alertDialog } from '../../ui/dialog.js';

const SEQ = {
  esc: '\x1b', tab: '\t', shifttab: '\x1b[Z',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  ctrlc: '\x03',
};

export function initAuxBar({ getActiveTab }) {
  const auxbar = document.getElementById('auxbar');
  const handle = document.getElementById('aux-handle');
  const keys = document.getElementById('auxkeys');
  const ctrlBtn = document.getElementById('aux-ctrl');
  const pasteBtn = document.getElementById('aux-paste');
  const dictateBtn = document.getElementById('aux-dictate');
  const dictation = document.getElementById('dictation');
  const input = document.getElementById('dictation-input');
  const enterToggle = document.getElementById('dictation-enter');
  const sendBtn = document.getElementById('dictation-send');

  let ctrlArmed = false;

  // sendData solo existe en pestañas PTY; en un chat la barra no aplica.
  const send = (data) => data && getActiveTab()?.sendData?.(data);
  const refocus = () => getActiveTab()?.focus();

  // Los botones NO deben robar el foco del terminal (mantiene el teclado abierto).
  const keepFocus = (el) => el.addEventListener('mousedown', (e) => e.preventDefault());
  keys.querySelectorAll('button').forEach(keepFocus);
  [enterToggle, sendBtn, handle].forEach(keepFocus);

  // Tirador ⌨: despliega/oculta las teclas (oculta por defecto).
  handle.addEventListener('click', () => {
    auxbar.classList.toggle('collapsed');
    if (!auxbar.classList.contains('collapsed')) refocus();
  });

  // Teclas con secuencia directa (Esc/Tab/⇧Tab/flechas/^C).
  keys.addEventListener('click', (e) => {
    const btn = e.target.closest('.aux-key');
    const seq = btn && btn.dataset.seq;
    if (!seq) return;
    send(SEQ[seq]);
    refocus();
  });

  // Ctrl armado: se resuelve en el próximo carácter (ver TerminalTab._applyCtrl).
  function setCtrl(on) {
    ctrlArmed = on;
    ctrlBtn.classList.toggle('active', on);
    const tab = getActiveTab();
    if (tab?.setCtrlArmed) {
      tab.setCtrlArmed(on);
      tab.onCtrlAutoClear = () => { ctrlArmed = false; ctrlBtn.classList.remove('active'); };
    }
  }
  ctrlBtn.addEventListener('click', () => { setCtrl(!ctrlArmed); refocus(); });

  // Pegar del portapapeles.
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) (getActiveTab()?.pasteText ? getActiveTab().pasteText(text) : send(text));
    } catch {
      alertDialog({ title: 'Portapapeles', message: 'No se pudo leer el portapapeles (permiso denegado o no disponible).' });
    }
    refocus();
  });

  // Alterna el modo dictado (campo de texto + enviar).
  dictateBtn.addEventListener('click', () => {
    const show = dictation.hidden;
    dictation.hidden = !show;
    dictateBtn.classList.toggle('active', show);
    if (show) input.focus();
    else refocus();
  });

  // Envío del dictado. Soporta IME: no envía durante composición.
  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });

  function sendDictation() {
    const withEnter = enterToggle.classList.contains('active');
    const text = input.value;
    if (!text && !withEnter) return;
    send(withEnter ? text + '\r' : text);
    input.value = '';
    input.focus();
  }
  sendBtn.addEventListener('click', sendDictation);
  enterToggle.addEventListener('click', () => enterToggle.classList.toggle('active'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && !composing) {
      e.preventDefault();
      sendDictation();
    }
  });
}
