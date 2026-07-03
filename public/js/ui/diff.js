// ui/diff.js — mini-render de diffs propio (sin librerías).
//
// Para Edit: bloque rojo (old_string, líneas −) + bloque verde (new_string,
// líneas +). Para Write: solo el bloque verde con el contenido nuevo.
// Se usa en las tool calls del chat y en las tarjetas de permiso.
// Con extensión de archivo conocida, cada línea lleva además resaltado de
// sintaxis (ui/code.js, línea a línea: markup balanceado por línea); el
// tinte de fondo +/− sigue marcando el cambio, como en un editor.
import { langForPath, highlightLine } from './code.js';

const HL_MAX_LINES = 400; // diffs enormes: sin sintaxis (perf)

export function renderDiff({ file, old: oldStr, new: newStr } = {}) {
  const el = document.createElement('div');
  el.className = 'cwc-diff';

  if (file) {
    const head = document.createElement('div');
    head.className = 'cwc-diff-file';
    head.textContent = file;
    el.appendChild(head);
  }

  const lang = langForPath(file);
  const block = (text, cls, sign) => {
    if (!text) return;
    const b = document.createElement('div');
    b.className = `cwc-diff-block ${cls}`;
    const lines = String(text).split('\n');
    const hl = lang && lines.length <= HL_MAX_LINES;
    for (const line of lines) {
      const ln = document.createElement('div');
      ln.className = 'cwc-diff-line';
      const html = hl ? highlightLine(line, lang) : null;
      if (html != null) {
        ln.classList.add('hl');
        ln.innerHTML = `<span class="df-sign"></span>${html}`; // hljs escapa el input
        ln.querySelector('.df-sign').textContent = sign;
      } else {
        ln.textContent = sign + line;
      }
      b.appendChild(ln);
    }
    el.appendChild(b);
  };
  block(oldStr, 'df-del', '− ');
  block(newStr, 'df-add', '+ ');
  return el;
}
