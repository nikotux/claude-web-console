// ui/markdown.js — render de markdown SEGURO para el chat.
//
// window.marked (bundle local) parsea; después sanitizamos por ALLOWLIST
// sobre un DOM desconectado (a prueba de HTML crudo del modelo, sin depender
// de los internals de marked ni de librerías extra). Los bloques de código se
// resaltan con window.hljs y ganan botón de copiar.
import { icon } from './icons.js';

const ALLOWED = new Set([
  'P', 'BR', 'HR', 'STRONG', 'B', 'EM', 'I', 'DEL', 'S', 'CODE', 'PRE',
  'UL', 'OL', 'LI', 'BLOCKQUOTE', 'A',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
]);

function sanitize(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) continue;
    if (child.nodeType !== Node.ELEMENT_NODE || !ALLOWED.has(child.tagName)) {
      // Elemento no permitido: se reemplaza por su texto plano.
      child.replaceWith(document.createTextNode(child.textContent || ''));
      continue;
    }
    // Atributos: solo href seguro en <a> y class de lenguaje en <code>.
    for (const attr of [...child.attributes]) {
      const name = attr.name.toLowerCase();
      const keep =
        (child.tagName === 'A' && name === 'href' && /^https?:\/\//i.test(attr.value)) ||
        (child.tagName === 'CODE' && name === 'class' && /^language-[\w-]+$/.test(attr.value));
      if (!keep) child.removeAttribute(attr.name);
    }
    if (child.tagName === 'A') {
      child.setAttribute('target', '_blank');
      child.setAttribute('rel', 'noopener noreferrer');
    }
    sanitize(child);
  }
}

function enhanceCodeBlocks(root) {
  const hljs = window.hljs;
  for (const pre of root.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (!code) continue;
    // Resaltado solo con language-* explícito. Sin autodetección: adivinar
    // el lenguaje sobre texto no confiable mete falsos positivos (ver code.js).
    if (hljs) {
      try {
        const langMatch = (code.className || '').match(/language-([\w-]+)/);
        const lang = langMatch && hljs.getLanguage(langMatch[1]) ? langMatch[1] : null;
        if (lang) {
          const src = code.textContent;
          code.innerHTML = hljs.highlight(src, { language: lang }).value;
          code.classList.add('hljs');
        }
        // Sin lang confiable: se deja el texto plano tal cual (ya escapado).
      } catch { /* texto plano */ }
    }
    // Botón copiar.
    const wrap = document.createElement('div');
    wrap.className = 'md-codewrap';
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
    const btn = document.createElement('button');
    btn.className = 'md-copy';
    btn.title = 'Copiar código';
    btn.innerHTML = icon('clipboard', { size: 13 });
    let revertTimer = null; // clicks rápidos: un solo timeout vivo
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        btn.innerHTML = icon('check', { size: 13 });
        clearTimeout(revertTimer);
        revertTimer = setTimeout(() => { btn.innerHTML = icon('clipboard', { size: 13 }); }, 1200);
      } catch { /* clipboard no disponible */ }
    });
    wrap.appendChild(btn);
  }
}

// Tope duro de líneas de entrada: el markdown es la salida de texto libre
// del modelo, la fuente de contenido más grande e imprevisible de las tres
// (ver DOM_MAX_LINES en diff.js y HL_MAX_CHARS en code.js). Sin esto, una
// tabla o lista enorme generaría un número no acotado de nodos DOM.
const MD_MAX_LINES = 2000;

// Devuelve un elemento con el markdown renderizado, sanitizado y resaltado.
export function renderMarkdown(text) {
  const el = document.createElement('div');
  el.className = 'chat-md';
  const raw = String(text ?? '');
  const allLines = raw.split('\n');
  const truncated = allLines.length > MD_MAX_LINES;
  const src = truncated ? allLines.slice(0, MD_MAX_LINES).join('\n') : raw;
  const marked = window.marked;
  if (!marked?.parse) {
    el.textContent = src;
    if (truncated) {
      el.appendChild(document.createTextNode(
        `\n… (${allLines.length - MD_MAX_LINES} líneas más ocultas por límite de rendimiento)`
      ));
    }
    return el;
  }
  try {
    el.innerHTML = marked.parse(src, { breaks: true, gfm: true });
    sanitize(el);
    enhanceCodeBlocks(el);
    if (truncated) {
      const trunc = document.createElement('p');
      trunc.className = 'chat-md-truncated';
      trunc.textContent = `… (${allLines.length - MD_MAX_LINES} líneas más ocultas por límite de rendimiento)`;
      el.appendChild(trunc);
    }
  } catch {
    el.textContent = text;
  }
  return el;
}
