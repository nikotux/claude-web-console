// ui/diff.js — mini-render de diffs propio (sin librerías).
//
// Para Edit: bloque rojo (old_string, líneas −) + bloque verde (new_string,
// líneas +). Para Write: solo el bloque verde con el contenido nuevo.
// Se usa en las tool calls del chat y en las tarjetas de permiso.

export function renderDiff({ file, old: oldStr, new: newStr } = {}) {
  const el = document.createElement('div');
  el.className = 'cwc-diff';

  if (file) {
    const head = document.createElement('div');
    head.className = 'cwc-diff-file';
    head.textContent = file;
    el.appendChild(head);
  }

  const block = (text, cls, sign) => {
    if (!text) return;
    const b = document.createElement('div');
    b.className = `cwc-diff-block ${cls}`;
    for (const line of String(text).split('\n')) {
      const ln = document.createElement('div');
      ln.className = 'cwc-diff-line';
      ln.textContent = sign + line;
      b.appendChild(ln);
    }
    el.appendChild(b);
  };
  block(oldStr, 'df-del', '− ');
  block(newStr, 'df-add', '+ ');
  return el;
}
