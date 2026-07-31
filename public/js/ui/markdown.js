// ui/markdown.js — render de markdown SEGURO para el chat.
//
// window.marked (bundle local) parsea; después sanitizamos por ALLOWLIST
// sobre un DOM desconectado (a prueba de HTML crudo del modelo, sin depender
// de los internals de marked ni de librerías extra). Los bloques de código se
// resaltan con window.hljs y ganan botón de copiar. Los bloques ```chart``` y
// ```mermaid``` se enriquecen después sin confiar en HTML/config del modelo.
import { icon } from './icons.js';
import { openModal } from './dialog.js';
import { t } from './i18n.js';

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
    btn.title = t('core.markdown.copyCode', 'Copiar código');
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

const CHART_MAX_PER_MSG = 6;
const CHART_MAX_CHARS = 8000;
const CHART_TYPES = new Set(['doughnut', 'pie', 'bar', 'line', 'hbar']);
const CHART_PALETTE = [
  '--cwc-accent',
  '--cwc-accent-cool',
  '--cwc-warn',
  '--cwc-ok',
  '--cwc-cat-video',
  '--cwc-info',
  '--cwc-danger',
  '--cwc-cat-archive',
];
const liveCharts = new Set();

// Lee la paleta viva del documento porque un tema puede cambiar los tokens sin
// recargar el módulo; enhanceChartBlocks guarda una sola lectura por render.
function chartTheme() {
  const css = getComputedStyle(document.documentElement);
  const token = (name) => css.getPropertyValue(name).trim();
  return {
    palette: CHART_PALETTE.map(token),
    text: token('--cwc-text-secondary'),
    grid: token('--cwc-border-soft'),
    font: token('--cwc-font-ui'),
  };
}

function parseChartSpec(src) {
  if (src.length > CHART_MAX_CHARS) return null;
  let raw;
  try {
    raw = JSON.parse(src);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.type !== 'string' || !CHART_TYPES.has(raw.type)) return null;
  if (!Array.isArray(raw.labels) || !Array.isArray(raw.data)) return null;

  let labels = raw.labels.slice(0, 24).map((label) => String(label).slice(0, 40));
  let series;
  const numericData = raw.data.slice(0, 24);
  if (numericData.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    const length = Math.min(labels.length, numericData.length);
    if (!length) return null;
    labels = labels.slice(0, length);
    series = [{ label: '', data: numericData.slice(0, length) }];
  } else {
    const multiAllowed = raw.type === 'bar' || raw.type === 'hbar' || raw.type === 'line';
    if (!multiAllowed || !raw.data.length) return null;
    const candidates = raw.data.slice(0, 4);
    if (!candidates.every((item) =>
      item && typeof item === 'object' && !Array.isArray(item) &&
      typeof item.label === 'string' && Array.isArray(item.data) &&
      item.data.slice(0, 24).every((value) => typeof value === 'number' && Number.isFinite(value))
    )) return null;
    const length = Math.min(labels.length, ...candidates.map((item) => Math.min(item.data.length, 24)));
    if (!length) return null;
    labels = labels.slice(0, length);
    series = candidates.map((item) => ({
      label: item.label.slice(0, 40),
      data: item.data.slice(0, length),
    }));
  }

  return {
    type: raw.type === 'hbar' ? 'bar' : raw.type,
    indexAxis: raw.type === 'hbar' ? 'y' : 'x',
    title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : '',
    labels,
    series,
    unit: typeof raw.unit === 'string' ? raw.unit.slice(0, 8) : '',
    stacked: (raw.type === 'bar' || raw.type === 'hbar') && raw.stacked === true,
  };
}

function formatChartValue(value, unit) {
  return unit ? `${value}${unit === '%' ? '%' : ` ${unit}`}` : String(value);
}

function chartDataTable(spec) {
  const table = document.createElement('table');
  table.className = 'md-chart-data';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const labelHead = document.createElement('th');
  labelHead.scope = 'col';
  labelHead.textContent = t('core.markdown.chartLabel', 'Categoría');
  headRow.appendChild(labelHead);
  if (spec.series.length === 1) {
    const valueHead = document.createElement('th');
    valueHead.scope = 'col';
    valueHead.textContent = spec.series[0].label || t('core.markdown.chartValue', 'Valor');
    headRow.appendChild(valueHead);
  } else {
    for (const item of spec.series) {
      const seriesHead = document.createElement('th');
      seriesHead.scope = 'col';
      seriesHead.textContent = item.label;
      headRow.appendChild(seriesHead);
    }
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  spec.labels.forEach((label, index) => {
    const row = document.createElement('tr');
    const rowHead = document.createElement('th');
    rowHead.scope = 'row';
    rowHead.textContent = label;
    row.appendChild(rowHead);
    for (const item of spec.series) {
      const value = document.createElement('td');
      value.textContent = formatChartValue(item.data[index], spec.unit);
      row.appendChild(value);
    }
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  return table;
}

function chartConfig(spec, theme) {
  const round = spec.type === 'doughnut' || spec.type === 'pie';
  const multi = spec.series.length > 1;
  const datasets = spec.series.map((item, seriesIndex) => {
    const color = theme.palette[seriesIndex % theme.palette.length];
    const dataset = {
      label: item.label,
      data: item.data.slice(),
    };
    if (round) {
      dataset.backgroundColor = spec.labels.map((_, index) => theme.palette[index % theme.palette.length]);
      dataset.borderWidth = 0;
    } else if (spec.type === 'line') {
      dataset.borderColor = color;
      dataset.backgroundColor = color;
      dataset.tension = 0.3;
      dataset.pointRadius = 2;
      dataset.borderWidth = 2;
      dataset.fill = false;
    } else {
      dataset.backgroundColor = multi
        ? color
        : spec.labels.map((_, index) => theme.palette[index % theme.palette.length]);
      dataset.borderRadius = 3;
      dataset.borderWidth = 0;
    }
    return dataset;
  });

  const legend = {
    display: round || multi,
    position: round
      ? (window.matchMedia?.('(max-width: 768px)').matches ? 'top' : 'right')
      : 'top',
    labels: {
      color: theme.text,
      font: { family: theme.font, size: 11 },
    },
  };
  const plugins = {
    legend,
    title: { display: false },
  };
  if (spec.unit) {
    plugins.tooltip = {
      callbacks: {
        label: (ctx) => {
          const parsed = round ? ctx.parsed : (spec.indexAxis === 'y' ? ctx.parsed.x : ctx.parsed.y);
          const label = round ? ctx.label : ctx.dataset.label;
          const prefix = label ? `${label}: ` : '';
          return `${prefix}${formatChartValue(parsed, spec.unit)}`;
        },
      },
    };
  }

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    indexAxis: spec.indexAxis,
    plugins,
  };
  if (spec.type === 'doughnut') options.cutout = '58%';
  if (!round) {
    const numericAxis = spec.indexAxis === 'y' ? 'x' : 'y';
    options.scales = {
      x: {
        stacked: spec.stacked,
        beginAtZero: numericAxis === 'x',
        grid: { display: false },
        ticks: {
          color: theme.text,
          font: { family: theme.font, size: 11 },
          ...(spec.unit && numericAxis === 'x'
            ? { callback: (value) => formatChartValue(value, spec.unit) }
            : {}),
        },
      },
      y: {
        stacked: spec.stacked,
        beginAtZero: numericAxis === 'y',
        grid: { color: theme.grid },
        ticks: {
          color: theme.text,
          font: { family: theme.font, size: 11 },
          ...(spec.unit && numericAxis === 'y'
            ? { callback: (value) => formatChartValue(value, spec.unit) }
            : {}),
        },
      },
    };
  }
  return { type: spec.type, data: { labels: spec.labels.slice(), datasets }, options };
}

function showChartError(wrap) {
  const note = document.createElement('div');
  note.className = 'md-chart-error';
  note.textContent = t('core.markdown.chartError', '⚠ No se pudo interpretar este gráfico — datos abajo.');
  wrap.before(note);
}

function enhanceChartBlocks(root) {
  // Chart.js conserva canvas y listeners de resize aunque el chat descarte sus
  // nodos; barrer los desconectados en cada render evita que esa retención crezca.
  for (const inst of [...liveCharts]) {
    if (inst.canvas?.isConnected) continue;
    try { inst.destroy(); } catch { /* la instancia ya podía estar destruida */ }
    liveCharts.delete(inst);
  }

  let rendered = 0;
  let theme = null; // una lectura de computed styles alcanza para todo el mensaje
  for (const wrap of root.querySelectorAll('.md-codewrap')) {
    const code = wrap.querySelector('code.language-chart');
    if (!code || rendered >= CHART_MAX_PER_MSG) continue;
    const spec = parseChartSpec(code.textContent || '');
    const ChartCtor = window.Chart;
    if (!spec || typeof ChartCtor !== 'function') {
      showChartError(wrap);
      continue;
    }

    const figure = document.createElement('figure');
    figure.className = `md-chart${spec.type === 'doughnut' || spec.type === 'pie' ? ' md-chart--round' : ''}`;
    if (spec.title) {
      const caption = document.createElement('figcaption');
      caption.className = 'md-chart-title';
      caption.textContent = spec.title;
      figure.appendChild(caption);
    }
    const box = document.createElement('div');
    box.className = 'md-chart-box';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    box.appendChild(canvas);
    figure.appendChild(box);
    figure.appendChild(chartDataTable(spec));

    const details = document.createElement('details');
    details.className = 'md-chart-src';
    const summary = document.createElement('summary');
    summary.textContent = t('core.markdown.viewChartData', 'Ver datos del gráfico');
    details.appendChild(summary);
    wrap.replaceWith(figure, details);
    details.appendChild(wrap);

    let inst = null;
    try {
      theme ||= chartTheme();
      // La config se reconstruye desde la allowlist; el objeto JSON del modelo
      // nunca llega a Chart.js ni se mezcla con sus opciones ejecutables.
      inst = new ChartCtor(canvas, chartConfig(spec, theme));
      liveCharts.add(inst);
      rendered += 1;
    } catch {
      try { inst?.destroy(); } catch { /* constructor incompleto */ }
      try { ChartCtor.getChart?.(canvas)?.destroy(); } catch { /* sin registro */ }
      figure.remove();
      details.before(wrap);
      details.remove();
      showChartError(wrap);
    }
  }
}

function enhanceInlineBars(root) {
  // Corre DESPUÉS de sanitize() y crea nodos propios con createElement: por eso
  // SPAN no necesita entrar al ALLOWLIST que protege el HTML crudo del modelo.
  const pattern = /^\{bar:(\d{1,3}(?:\.\d+)?)\}$/;
  for (const cell of root.querySelectorAll('td, th')) {
    if (cell.children.length) continue;
    const match = cell.textContent.trim().match(pattern);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    const clamped = Math.min(100, Math.max(0, value));
    const formatted = Number.isInteger(clamped) ? String(clamped) : clamped.toFixed(1);

    const bar = document.createElement('span');
    bar.className = 'md-bar';
    bar.title = `${formatted}%`;
    const fill = document.createElement('span');
    fill.className = 'md-bar-fill';
    fill.style.width = `${clamped}%`;
    bar.appendChild(fill);
    const number = document.createElement('span');
    number.className = 'md-bar-num';
    number.textContent = `${formatted}%`;
    cell.replaceChildren(bar, number);
  }
}

// Tope de líneas por diagrama: un ```mermaid``` gigante (o alucinado) puede
// generar un SVG desproporcionado que rompe el layout. Los diagramas reales
// (flowchart, secuencia, ER, gantt) rara vez pasan de unas pocas decenas.
const MERMAID_MAX_LINES = 400;
// Al ser vectorial se puede ampliar sin pixelar, pero sin este tope un
// diagrama de tres nodos podría convertirse en un cartel desproporcionado.
// 1.5 no es arbitrario: es el techo que ya exhiben los diagramas normales en
// desktop (medidos 1.23-1.50, limitados por alto o ancho disponible), así que
// bajarlo de 2.2 a 1.5 NO cambia ningún diagrama real — solo deja de inflar a
// los chicos (mindmaps de pocos nodos), que era el caso que se veía de cartel.
const MERMAID_MAX_SCALE = 1.5;
// El modal "Ampliar" conserva el tope viejo A PROPÓSITO: ahí el diagrama es el
// contenido principal de una ventana dedicada, no una figura embebida en el
// mensaje. Antes ambos casos compartían constante y bajar la inline habría
// achicado también el zoom, que es exactamente lo contrario de lo que se pide.
const MERMAID_ZOOM_MAX_SCALE = 2.2;
// Por debajo de ~0.85 el texto de los nodos (15px) baja de ~13px y deja de
// leerse cómodo en un teléfono; preferimos scroll horizontal antes que un
// diagrama ilegible.
const MERMAID_MIN_SCALE = 0.85;
const mermaidObservers = new Set();
let mermaidSeq = 0;

// Clases semánticas de la paleta (`A:::ok`) sin obligar a escribir el classDef
// en CADA diagrama: si el source no lo define, se lo anexamos con los colores
// ya resueltos por index.html. Solo en flowchart/graph — en mindmap las clases
// las resuelve el themeCSS, y un classDef ahí ROMPE la sintaxis.
function withMermaidPrelude(src) {
  const pal = window.__cwcMermaidPalette;
  if (!pal || !pal.roles) return src;
  const head = src.split('\n').find((l) => l.trim() && !l.trim().startsWith('%%')) || '';
  if (!/^\s*(flowchart|graph)\b/.test(head)) return src;
  const defs = Object.entries(pal.roles)
    .filter(([name]) => !new RegExp(`classDef\\s+${name}\\b`).test(src))
    .map(([name, r]) => `classDef ${name} fill:${r.fill},stroke:${r.stroke},color:${r.color},stroke-width:1.5px`);
  return defs.length ? `${src}\n${defs.join('\n')}\n` : src;
}

// `:::clase` NO existe en mindmap ni sequenceDiagram: Mermaid no falla, pero
// dibuja el texto literal dentro del nodo (`Permisos:::warn` visible en pantalla).
// Se limpia SIEMPRE, antes del primer intento de render.
function normalizeMermaid(src) {
  const head = src.split('\n').find((l) => l.trim() && !l.trim().startsWith('%%')) || '';
  if (!/^\s*(mindmap|sequenceDiagram)\b/.test(head)) return src;
  return src.replace(/:::[A-Za-z_][\w-]*/g, '');
}

// Reparación de TECLEO, aplicada SOLO tras un fallo de parseo (nunca en el
// primer intento): un `::: ok` con espacio rompe el diagrama entero, y es el
// error real medido en producción. Como solo corre cuando Mermaid ya rechazó
// el source, tocar un `:::` que fuera texto legítimo no puede empeorar nada.
function repairMermaid(src) {
  return src.replace(/:::[ \t]+([A-Za-z_][\w-]*)/g, ':::$1');
}

// `width:100%` deformaba el encuadre al escalar siempre por ancho; con viewBox
// hay que encajar por el eje que MÁS sobresale, como `object-fit: contain`.
function fitMermaidSvg(canvasEl) {
  const svg = canvasEl.querySelector('svg');
  if (!svg) return;

  const vb = svg.viewBox?.baseVal;
  let naturalW = Number(vb?.width);
  let naturalH = Number(vb?.height);
  if (!Number.isFinite(naturalW) || naturalW <= 0 ||
      !Number.isFinite(naturalH) || naturalH <= 0) {
    try {
      const bbox = svg.getBBox();
      naturalW = Number(bbox.width);
      naturalH = Number(bbox.height);
    } catch {
      return;
    }
  }
  if (!Number.isFinite(naturalW) || naturalW <= 0 ||
      !Number.isFinite(naturalH) || naturalH <= 0) return;

  const availW = canvasEl.clientWidth || canvasEl.getBoundingClientRect().width;
  if (!availW) return;

  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.style.maxWidth = '';
  svg.style.minWidth = '';

  // El límite de altura vive en CSS (`.md-mermaid-canvas`), que ya distingue
  // desktop/móvil; duplicarlo en JS lo desincroniza en silencio (70% vs 62vh).
  const fallbackMaxH = Math.max(220, window.innerHeight * 0.70);
  const cs = getComputedStyle(canvasEl);
  const cssMaxH = parseFloat(cs.maxHeight);
  const paddingTop = parseFloat(cs.paddingTop);
  const paddingBottom = parseFloat(cs.paddingBottom);
  const verticalPadding =
    (Number.isFinite(paddingTop) ? paddingTop : 0) +
    (Number.isFinite(paddingBottom) ? paddingBottom : 0);
  const contentMaxH = cssMaxH - verticalPadding;
  const maxH = Number.isFinite(cssMaxH) && cssMaxH > 0 && contentMaxH > 0
    ? contentMaxH
    : fallbackMaxH;
  const fitScale = Math.min(availW / naturalW, maxH / naturalH, MERMAID_MAX_SCALE);
  // Piso de legibilidad: si el encaje exacto obligaría a achicar demasiado,
  // preferimos el tamaño mínimo legible y que el canvas scrollee en horizontal.
  // Limitar el piso por maxH / naturalH es deliberado: nunca debe superar el
  // alto máximo; un diagrama muy alto sí puede bajar de 0.85 para entrar.
  const scale = Math.max(fitScale, Math.min(MERMAID_MIN_SCALE, maxH / naturalH));
  const svgWidth = Math.round(naturalW * scale);
  svg.style.width = `${svgWidth}px`;
  svg.style.height = `${Math.round(naturalH * scale)}px`;

  const holder = canvasEl.closest('.md-mermaid');
  if (holder) {
    const overflows = svgWidth > canvasEl.clientWidth + 2;
    holder.classList.toggle('md-mermaid--pan', overflows);
    canvasEl.title = overflows
      ? t('core.markdown.panHint', 'Deslizá para ver el resto — o tocá Ampliar')
      : '';
  }
}

// Detecta ```mermaid``` (ya pasó por sanitize: sigue siendo un <code
// class="language-mermaid"> dentro de un <pre>, envuelto en .md-codewrap por
// enhanceCodeBlocks) y lo renderiza a SVG con la instancia global de Mermaid.
// El SVG lo genera EL PROPIO PARSER de Mermaid (securityLevel:'strict'), no
// HTML crudo del modelo — no hace falta tocar el ALLOWLIST de sanitize().
// Async y best-effort: si mermaid no cargó, la sintaxis es inválida o el
// bloque es enorme, se deja el código fuente visible tal cual (ya lo dejó
// enhanceCodeBlocks) y no se rompe el resto del mensaje.
function enhanceMermaidBlocks(root) {
  for (const entry of [...mermaidObservers]) {
    if (entry.target.isConnected) continue;
    entry.obs.disconnect();
    mermaidObservers.delete(entry);
  }

  const wraps = root.querySelectorAll('.md-codewrap');
  for (const wrap of wraps) {
    const code = wrap.querySelector('code.language-mermaid');
    if (!code) continue;
    const src = code.textContent || '';
    if (!src.trim() || src.split('\n').length > MERMAID_MAX_LINES) continue;

    const pre = wrap.querySelector('pre');
    const holder = document.createElement('div');
    holder.className = 'md-mermaid';
    holder.textContent = t('core.markdown.generatingDiagram', 'Generando diagrama…');
    wrap.before(holder);

    // El código fuente queda disponible pero colapsado bajo el diagrama
    // (convención del proyecto: contenido largo nace colapsado).
    const details = document.createElement('details');
    details.className = 'md-mermaid-src';
    const summary = document.createElement('summary');
    summary.textContent = t('core.markdown.viewMermaid', 'Ver código Mermaid');
    details.appendChild(summary);
    wrap.replaceWith(details);
    details.appendChild(wrap);

    // Dispara la carga LAZY de Mermaid recién ahora que hay un bloque real
    // (PEND-621). Fallback al comportamiento viejo si el loader no existe.
    const ready = window.__loadMermaid ? window.__loadMermaid() : (window.mermaidReady || Promise.resolve(window.mermaid || null));
    const renderIds = [];
    const attempt = (mermaid, source) => {
      mermaidSeq += 1;
      const id = `md-mermaid-${Date.now()}-${mermaidSeq}`;
      renderIds.push(id);
      return mermaid.render(id, withMermaidPrelude(source));
    };
    let failMsg = '';
    ready.then((mermaid) => {
      if (!mermaid) throw new Error('mermaid no disponible');
      const base = normalizeMermaid(src);
      return attempt(mermaid, base).catch((err) => {
        failMsg = String(err && err.message || err);
        const repaired = repairMermaid(base);
        // Sin cambio real que reintentar, el error es del diagrama, no del tecleo.
        if (repaired === base) throw err;
        return attempt(mermaid, repaired);
      });
    }).then(({ svg }) => {
      // El SVG vive inline con encaje proporcional para leerse como parte del
      // mensaje; "Ampliar" queda como ayuda extra. El badge va fuera del canvas
      // y en su propia fila del flujo para no tapar contenido.
      holder.innerHTML = '';
      const canvas = document.createElement('div');
      canvas.className = 'md-mermaid-canvas';
      canvas.innerHTML = svg;
      holder.appendChild(canvas);
      fitMermaidSvg(canvas);
      requestAnimationFrame(() => fitMermaidSvg(canvas));
      if (typeof ResizeObserver === 'function') {
        const obs = new ResizeObserver(() => fitMermaidSvg(canvas));
        obs.observe(canvas);
        mermaidObservers.add({ obs, target: canvas });
      }
      // Click para ampliar: mismo patrón que el lightbox de imágenes del chat
      // (chat-tab.js `_lightbox` → openModal genérico) — el navegador ya deja
      // hacer zoom/pan nativo (pinch, Ctrl+scroll) sobre el contenido del
      // modal, así que no hace falta un visor propio.
      holder.classList.add('md-mermaid--zoomable');
      holder.title = t('core.markdown.clickToZoom', 'Click para ampliar');
      // Badge "🔍 Ampliar" SIEMPRE visible (no depende de :hover ni del cursor
      // zoom-in): en móvil/touch no hay hover, así que sin esto la posibilidad
      // de ampliar era invisible — la raíz de que el diagrama "se viera chico".
      const zoomBtn = document.createElement('button');
      zoomBtn.type = 'button';
      zoomBtn.className = 'md-mermaid-zoom-btn';
      zoomBtn.innerHTML = `${icon('search', { size: 13 })}<span>${t('core.markdown.zoom', 'Ampliar')}</span>`;
      zoomBtn.setAttribute('aria-label', t('core.markdown.zoomDiagram', 'Ampliar diagrama'));
      // stopPropagation: el badge abre el zoom una sola vez (sin él, el click
      // burbujea al holder y se abrirían dos modales).
      zoomBtn.addEventListener('click', (e) => { e.stopPropagation(); openMermaidZoom(holder); });
      holder.insertBefore(zoomBtn, canvas);
      holder.addEventListener('click', () => openMermaidZoom(holder));
      holder.dispatchEvent(new CustomEvent('cwc:mermaid-rendered', { bubbles: true }));
    }).catch((err) => {
      // Cinturón + tirantes sobre `suppressErrorRendering` (index.html): si una
      // versión futura de Mermaid vuelve a dejar su div temporal colgado de
      // <body> al fallar, lo barremos acá. `d<id>` es el div de render y
      // `i<id>` el iframe del modo sandbox.
      for (const id of renderIds) {
        document.getElementById(`d${id}`)?.remove();
        document.getElementById(`i${id}`)?.remove();
      }
      holder.remove();
      details.open = true;
      const note = document.createElement('div');
      note.className = 'md-mermaid-error';
      const head = document.createElement('span');
      head.textContent = t('core.markdown.mermaidError', '⚠ No se pudo interpretar este diagrama Mermaid — código fuente abajo.');
      note.appendChild(head);
      const raw = failMsg || String(err && err.message || err || '');
      // Primera línea del error de Mermaid: trae el "Parse error on line N" que dice
      // DÓNDE está el problema. El resto es el diagrama ASCII del parser, ruido acá.
      const why = raw.split('\n')[0].trim().slice(0, 180);
      if (why) {
        const reason = document.createElement('code');
        reason.className = 'md-mermaid-why';
        reason.textContent = why;
        note.appendChild(reason);
      }
      details.before(note);
    });
  }
}

// Abre una copia grande del diagrama en el modal genérico (ui/dialog.js).
function openMermaidZoom(holder) {
  const svg = holder.querySelector('svg');
  if (!svg) return;
  const m = openModal({ title: t('core.markdown.diagram', 'Diagrama'), width: 'min(94vw, 1100px)' });
  m.body.classList.add('md-mermaid-zoom-body');
  const clone = svg.cloneNode(true);
  clone.removeAttribute('width');
  clone.removeAttribute('height');
  clone.style.maxWidth = '';
  clone.style.minWidth = '';
  const vb = clone.viewBox?.baseVal;
  if (Number.isFinite(vb?.width) && vb.width > 0 &&
      Number.isFinite(vb?.height) && vb.height > 0) {
    if (vb.width >= vb.height) {
      clone.style.width = '100%';
      clone.style.height = 'auto';
    } else {
      clone.style.height = `min(86vh, ${Math.round(vb.height * MERMAID_ZOOM_MAX_SCALE)}px)`;
      clone.style.width = 'auto';
    }
  } else {
    clone.style.width = 'auto';
    clone.style.height = 'auto';
  }
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
        `\n${t('core.trunc.linesHidden', '… ({n} líneas más ocultas por límite de rendimiento)', { n: allLines.length - MD_MAX_LINES })}`
      ));
    }
    return el;
  }
  try {
    el.innerHTML = marked.parse(src, { breaks: true, gfm: true });
    sanitize(el);
    enhanceInlineBars(el);
    enhanceCodeBlocks(el);
    enhanceChartBlocks(el);
    enhanceMermaidBlocks(el);
    if (truncated) {
      const trunc = document.createElement('p');
      trunc.className = 'chat-md-truncated';
      trunc.textContent = t('core.trunc.linesHidden', '… ({n} líneas más ocultas por límite de rendimiento)', { n: allLines.length - MD_MAX_LINES });
      el.appendChild(trunc);
    }
  } catch {
    el.textContent = text;
  }
  return el;
}
