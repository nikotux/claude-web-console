// ui/diff.js — mini-render de diffs propio (sin librerías).
//
// Para Edit: bloque rojo (old_string, líneas −) + bloque verde (new_string,
// líneas +). Para Write: solo el bloque verde con el contenido nuevo.
// Se usa en las tool calls del chat y en las tarjetas de permiso.
// Con extensión de archivo conocida, cada línea lleva además resaltado de
// sintaxis (ui/code.js, línea a línea: markup balanceado por línea); el
// tinte de fondo +/− sigue marcando el cambio, como en un editor.
import { langForPath, highlightLine } from './code.js';
import { t } from './i18n.js';

const HL_MAX_LINES = 400; // diffs enormes: sin sintaxis (perf)
const DOM_MAX_LINES = 1000; // tope duro de nodos DOM por bloque (perf/memoria)

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
    const allLines = String(text).split('\n');
    const truncated = allLines.length > DOM_MAX_LINES;
    const lines = truncated ? allLines.slice(0, DOM_MAX_LINES) : allLines;
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
    if (truncated) {
      const trunc = document.createElement('div');
      trunc.className = 'cwc-diff-line cwc-diff-truncated';
      trunc.textContent = t('core.trunc.linesHidden', '… ({n} líneas más ocultas por límite de rendimiento)', { n: allLines.length - DOM_MAX_LINES });
      b.appendChild(trunc);
    }
    el.appendChild(b);
  };
  block(oldStr, 'df-del', '− ');
  block(newStr, 'df-add', '+ ');
  return el;
}
