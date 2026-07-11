// ui/markdown.js — render de markdown SEGURO para el chat.
//
// window.marked (bundle local) parsea; después sanitizamos por ALLOWLIST
// sobre un DOM desconectado (a prueba de HTML crudo del modelo, sin depender
// de los internals de marked ni de librerías extra). Los bloques de código se
// resaltan con window.hljs y ganan botón de copiar. Los bloques ```mermaid```
// se renderizan a SVG con window.mermaid (2026-07-11) — ver enhanceMermaidBlocks.
import { icon } from './icons.js';
import { openModal } from './dialog.js';

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

// Tope de líneas por diagrama: un ```mermaid``` gigante (o alucinado) puede
// generar un SVG desproporcionado que rompe el layout. Los diagramas reales
// (flowchart, secuencia, ER, gantt) rara vez pasan de unas pocas decenas.
const MERMAID_MAX_LINES = 400;
let mermaidSeq = 0;

// Detecta ```mermaid``` (ya pasó por sanitize: sigue siendo un <code
// class="language-mermaid"> dentro de un <pre>, envuelto en .md-codewrap por
// enhanceCodeBlocks) y lo renderiza a SVG con la instancia global de Mermaid.
// El SVG lo genera EL PROPIO PARSER de Mermaid (securityLevel:'strict'), no
// HTML crudo del modelo — no hace falta tocar el ALLOWLIST de sanitize().
// Async y best-effort: si mermaid no cargó, la sintaxis es inválida o el
// bloque es enorme, se deja el código fuente visible tal cual (ya lo dejó
// enhanceCodeBlocks) y no se rompe el resto del mensaje.
function enhanceMermaidBlocks(root) {
  const wraps = root.querySelectorAll('.md-codewrap');
  for (const wrap of wraps) {
    const code = wrap.querySelector('code.language-mermaid');
    if (!code) continue;
    const src = code.textContent || '';
    if (!src.trim() || src.split('\n').length > MERMAID_MAX_LINES) continue;

    const pre = wrap.querySelector('pre');
    const holder = document.createElement('div');
    holder.className = 'md-mermaid';
    holder.textContent = 'Generando diagrama…';
    wrap.before(holder);

    // El código fuente queda disponible pero colapsado bajo el diagrama
    // (convención del proyecto: contenido largo nace colapsado).
    const details = document.createElement('details');
    details.className = 'md-mermaid-src';
    const summary = document.createElement('summary');
    summary.textContent = 'Ver código Mermaid';
    details.appendChild(summary);
    wrap.replaceWith(details);
    details.appendChild(wrap);

    const ready = window.mermaidReady || Promise.resolve(window.mermaid || null);
    ready.then((mermaid) => {
      if (!mermaid) throw new Error('mermaid no disponible');
      mermaidSeq += 1;
      return mermaid.render(`md-mermaid-${Date.now()}-${mermaidSeq}`, src);
    }).then(({ svg }) => {
      // El SVG va en un canvas interno con scroll acotado (max-height en CSS):
      // un diagrama complejo se muestra como PREVIEW/miniatura (como la
      // miniatura de una imagen adjunta) en vez de un muro ilegible que ocupa
      // media pantalla — se lee entero al ampliarlo. El badge queda FUERA del
      // canvas (hijo directo del holder relativo) para no scrollear con él.
      holder.innerHTML = '';
      const canvas = document.createElement('div');
      canvas.className = 'md-mermaid-canvas';
      canvas.innerHTML = svg;
      holder.appendChild(canvas);
      // Click para ampliar: mismo patrón que el lightbox de imágenes del chat
      // (chat-tab.js `_lightbox` → openModal genérico) — el navegador ya deja
      // hacer zoom/pan nativo (pinch, Ctrl+scroll) sobre el contenido del
      // modal, así que no hace falta un visor propio.
      holder.classList.add('md-mermaid--zoomable');
      holder.title = 'Click para ampliar';
      // Badge "🔍 Ampliar" SIEMPRE visible (no depende de :hover ni del cursor
      // zoom-in): en móvil/touch no hay hover, así que sin esto la posibilidad
      // de ampliar era invisible — la raíz de que el diagrama "se viera chico".
      const zoomBtn = document.createElement('button');
      zoomBtn.type = 'button';
      zoomBtn.className = 'md-mermaid-zoom-btn';
      zoomBtn.innerHTML = `${icon('search', { size: 13 })}<span>Ampliar</span>`;
      zoomBtn.setAttribute('aria-label', 'Ampliar diagrama');
      // stopPropagation: el badge abre el zoom una sola vez (sin él, el click
      // burbujea al holder y se abrirían dos modales).
      zoomBtn.addEventListener('click', (e) => { e.stopPropagation(); openMermaidZoom(holder); });
      holder.appendChild(zoomBtn);
      holder.addEventListener('click', () => openMermaidZoom(holder));
      holder.dispatchEvent(new CustomEvent('cwc:mermaid-rendered', { bubbles: true }));
    }).catch(() => {
      holder.remove();
      details.open = false;
      const note = document.createElement('div');
      note.className = 'md-mermaid-error';
      note.textContent = '⚠ No se pudo interpretar este diagrama Mermaid — código fuente abajo.';
      details.before(note);
    });
  }
}

// Abre una copia grande del diagrama en el modal genérico (ui/dialog.js).
function openMermaidZoom(holder) {
  const svg = holder.querySelector('svg');
  if (!svg) return;
  const m = openModal({ title: 'Diagrama', width: 'min(94vw, 1100px)' });
  m.body.classList.add('md-mermaid-zoom-body');
  const clone = svg.cloneNode(true);
  // Mermaid deja un `style="max-width:NNNpx"` INLINE en el SVG (tamaño chico
  // para caber en la burbuja del chat). Un style inline le gana en
  // especificidad a la regla `.md-mermaid-zoom-body svg{max-width:none}` de
  // style.css, así que el diagrama quedaba diminuto arriba a la izquierda con
  // el modal casi vacío. Pisamos ese estilo inline DESPUÉS de clonar (un set
  // por JS también es inline, pero se aplica después → gana al de mermaid).
  clone.style.maxWidth = 'none';
  clone.style.width = '100%';
  clone.style.height = 'auto';
  m.body.appendChild(clone);
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
    enhanceMermaidBlocks(el);
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
