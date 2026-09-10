// Cerebro del Pad — vista contemplativa y de solo lectura del banco local de
// conocimientos; espejo en espíritu de la Vista Raw, pero sobre sus relaciones.
// Los flags de diagnóstico por URL permiten aislar saturaciones en el navegador
// real del usuario: la verificación headless con SwiftShader no reproduce los
// fallos que sí pueden aparecer con aceleración por GPU.

import { bindHelp, helpBtn } from '../ui/help.js';
import { applyI18n, initI18n, t } from '../ui/i18n.js';
import { createOrbitalScene } from './orbits.js';
import { COLLECTION_LABEL, createPalette } from './palette.js';
import { createPulseEngine } from './pulses.js';

// Instrumentación temporal: el diagnóstico inline usa esta marca para distinguir
// "el módulo no cargó" de "el módulo cargó pero no llegó a dibujar".
window.__cerebroBooted = true;

// La librería 3D la monta el backend en server.js como estático desde
// node_modules (mismo patrón que xterm/marked/mermaid/chartjs). Si el mount
// real usa otra ruta, ESTA es la ÚNICA línea a tocar.
const FORCE_GRAPH_URL = '/vendor/3d-force-graph/3d-force-graph.min.js';
const API_GRAPH = '/api/cerebro/graph';
const API_STREAM = '/api/cerebro/stream';
const FORCE_CHARGE_STRENGTH = -160;
const FORCE_LINK_DISTANCE = 70;
const LAYOUT_SETTLE_TICKS = 220;
const INITIAL_CAMERA_DISTANCE = 900;
const LINK_TYPES = ['parent', 'implements', 'blocks', 'supersedes', 'split_from', 'wiki'];
const LINK_TYPE_SET = new Set(LINK_TYPES);
// La red es contexto subordinado: la protagonista es la corriente que viaja
// por ella; una arista demasiado gruesa u opaca esconde la partícula que pasa encima.
const LINK_WIDTH = {
  parent: 0.2,
  implements: 0.45,
  blocks: 0.55,
  supersedes: 0.55,
  split_from: 0.5,
  wiki: 0.45,
};
const GALAXY_MOON_MAX_DEGREE = 1;
const GALAXY_SUN_TOP_FRACTION = 0.04;
const GALAXY_MOON_LUMINANCE = 0.5;
const COMPLETED_NODE_LUMINANCE = 0.42;
const GALAXY_PLANET_LUMINANCE = 1.0;
const GALAXY_SUN_SATURATION = 1.25;
const GALAXY_SUN_WARM_WHITE_MIX = 0.35;
const GALAXY_WARM_WHITE_ACCENT_MIX = 0.1;
const GALAXY_NODE_REL_SIZE = 5;
const GALAXY_NODE_OPACITY = 0.95;
// El UMBRAL decide QUIÉNES florecen: pocos se ven sublimes; todos hacen que la
// pantalla parezca sucia. Se subió a 0.42 a propósito para que solo los soles
// irradien. Ese valor depende de su mezcla hacia blanco: si algún día se baja
// GALAXY_SUN_WARM_WHITE_MIX, hay que revisar el umbral o dejarán de florecer.
// El RADIO decide cuánto se DERRAMA la luz: un radio ancho genera niebla.
// La INTENSIDAD decide cuánto brillan los objetos que sí florecen.
const BLOOM_STRENGTH = 0.75;
const BLOOM_RADIUS = 0.04;
const BLOOM_MAX_RESOLUTION = 1280;
const WEBGL_CONTEXT_CHECK_DELAY_MS = 4000;
const WEBGL_PLAIN_RELOAD_DELAY_MS = 500;
const WEBGL_RECOVERY_SESSION_KEY = 'cerebro:webgl-plain-reload';
const ORBIT_SPEED_STORAGE_KEY = 'cerebro:orbit-speed';
const BLOOM_THRESHOLD = 0.42;

const diagnosticParams = new URLSearchParams(location.search);
const plainDiagnostics = diagnosticParams.get('plain') === '1';
const diagnosticFlags = Object.freeze({
  bloom: plainDiagnostics || diagnosticParams.get('nobloom') === '1',
  corona: plainDiagnostics || diagnosticParams.get('nocorona') === '1',
  stars: plainDiagnostics || diagnosticParams.get('nostars') === '1',
  orbits: plainDiagnostics || diagnosticParams.get('noorbits') === '1',
});
const effectParams = Object.freeze({
  bloom: 'nobloom',
  corona: 'nocorona',
  stars: 'nostars',
  orbits: 'noorbits',
});

const meForLang = await (async () => {
  try { return await (await fetch('/api/whoami')).json(); } catch { return null; }
})();
await initI18n(meForLang?.lang || 'es');
applyI18n(document);

const graphEl = document.getElementById('cer-graph');
const hudEl = document.getElementById('cer-hud');
const statsEl = document.getElementById('cer-stats');
const statusEl = document.getElementById('cer-status');
const controlsEl = document.getElementById('cer-controls');
const controlsSummaryEl = document.getElementById('cer-controls-summary');
const controlsBodyEl = document.getElementById('cer-controls-body');
const legendEl = document.getElementById('cer-legend');
const legendBodyEl = document.getElementById('cer-legend-body');
const feedEl = document.getElementById('cer-feed');
const msgEl = document.getElementById('cer-msg');
const closeBtn = document.getElementById('cer-close');
const palette = createPalette();

let graph = null;
let engine = null;
let orbitalScene = null;
let bloomPass = null;
let outputPass = null;
let nodeByRef = new Map();
let linksByRef = new Map();
let nodesByCollection = new Map();
let eventSource = null;
let streamStarted = false;
let streamOpened = false;
let stopped = false;
let rafId = 0;
let resizeTimer = 0;
let vendorRetryTimer = 0;
let graphRetryTimer = 0;
let webglCheckTimer = 0;
let webglReloadTimer = 0;
let webglContextLost = false;
let graphRetryMs = 3000;
let graphFetchInFlight = null;
let includeCompleted = false;
let completedCheckbox = null;
let controlsLoadingEl = null;
let orbitSpeedOutputEl = null;
let fullGraphData = { nodes: [], links: [] };
let layoutTickCount = 0;
let layoutFrozen = false;
let layoutChargeForce = null;
let layoutLinkForce = null;
const visibleLinkTypes = new Set(LINK_TYPES);

function readOrbitSpeed() {
  try {
    const rawStored = localStorage.getItem(ORBIT_SPEED_STORAGE_KEY);
    if (rawStored === null) return 1;
    const stored = Number(rawStored);
    return Number.isFinite(stored) && stored >= 0 && stored <= 3 ? stored : 1;
  } catch (error) {
    console.warn('[cerebro] No se pudo leer la velocidad orbital guardada.', error);
    return 1;
  }
}

let orbitSpeedMultiplier = readOrbitSpeed();

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}

function showMsg(title, subtitle) {
  const card = document.createElement('div');
  card.className = 'cer-msg-card';
  const titleEl = document.createElement('div');
  titleEl.textContent = title;
  const subEl = document.createElement('div');
  subEl.className = 'cer-msg-sub';
  subEl.textContent = subtitle;
  card.append(titleEl, subEl);
  msgEl.replaceChildren(card);
  msgEl.hidden = false;
}

function hideMsg() {
  msgEl.hidden = true;
  msgEl.replaceChildren();
}

function setControlsLoading(loading) {
  if (!completedCheckbox || !controlsLoadingEl) return;
  completedCheckbox.disabled = loading;
  controlsEl.setAttribute('aria-busy', String(loading));
  controlsLoadingEl.hidden = !loading;
  controlsLoadingEl.textContent = includeCompleted
    ? t(
        'cerebro.controls.completedLoading',
        'Cargando completados… El Pad hará 13 consultas; puede tardar.',
      )
    : t('cerebro.controls.graphLoading', 'Actualizando el grafo…');
}

function replaceWithEffectState(effect, enabled) {
  const nextUrl = new URL(window.location.href);
  if (plainDiagnostics) {
    // plain apaga todo; al salir se materializa ese estado en los cuatro flags
    // para que activar una sola casilla no encienda accidentalmente las demás.
    nextUrl.searchParams.delete('plain');
    for (const parameter of Object.values(effectParams)) {
      nextUrl.searchParams.set(parameter, '1');
    }
  }
  const parameter = effectParams[effect];
  if (enabled) nextUrl.searchParams.delete(parameter);
  else nextUrl.searchParams.set(parameter, '1');
  // Los efectos se configuran una vez al arrancar. Recargar reutiliza esa ruta
  // probada y evita duplicar la creación/destrucción de recursos WebGL en vivo.
  window.location.replace(nextUrl.href);
}

function updateOrbitSpeed(value, persist = true) {
  orbitSpeedMultiplier = Math.min(3, Math.max(0, Number(value) || 0));
  orbitalScene?.setSpeedMultiplier(orbitSpeedMultiplier);
  if (orbitSpeedOutputEl) {
    orbitSpeedOutputEl.textContent = t(
      'cerebro.controls.orbitSpeedValue',
      '{value}×',
      { value: orbitSpeedMultiplier },
    );
  }
  if (persist) {
    try {
      localStorage.setItem(ORBIT_SPEED_STORAGE_KEY, String(orbitSpeedMultiplier));
    } catch (error) {
      console.warn('[cerebro] No se pudo guardar la velocidad orbital.', error);
    }
  }
}

function renderControls() {
  controlsSummaryEl.textContent = t('cerebro.controls.summary', 'Controles');
  const fragment = document.createDocumentFragment();

  const completedLabel = document.createElement('label');
  completedLabel.className = 'cer-control-row';
  completedCheckbox = document.createElement('input');
  completedCheckbox.type = 'checkbox';
  completedCheckbox.checked = includeCompleted;
  completedCheckbox.addEventListener('change', () => {
    includeCompleted = completedCheckbox.checked;
    void refreshGraph();
  });
  const completedText = document.createElement('span');
  completedText.textContent = t('cerebro.controls.completed', '☑ Mostrar completados');
  completedLabel.append(completedCheckbox, completedText);

  const completedNote = document.createElement('div');
  completedNote.className = 'cer-control-note';
  completedNote.textContent = t(
    'cerebro.controls.completedWarning',
    'Suma ~1500 nodos y puede afectar la fluidez.',
  );

  controlsLoadingEl = document.createElement('div');
  controlsLoadingEl.className = 'cer-control-loading';
  controlsLoadingEl.hidden = true;

  const effectsTitle = document.createElement('strong');
  effectsTitle.textContent = t('cerebro.controls.effects', 'Efectos');
  const effects = document.createElement('div');
  effects.className = 'cer-effects';
  const effectLabels = {
    bloom: t('cerebro.controls.bloom', 'Resplandor'),
    corona: t('cerebro.controls.corona', 'Coronas'),
    stars: t('cerebro.controls.stars', 'Estrellas'),
    orbits: t('cerebro.controls.orbits', 'Órbitas'),
  };
  for (const [effect, labelText] of Object.entries(effectLabels)) {
    const label = document.createElement('label');
    label.className = 'cer-control-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !diagnosticFlags[effect];
    checkbox.addEventListener('change', () => replaceWithEffectState(effect, checkbox.checked));
    const text = document.createElement('span');
    text.textContent = labelText;
    label.append(checkbox, text);
    effects.appendChild(label);
  }

  const speedHead = document.createElement('div');
  speedHead.className = 'cer-speed-head';
  const speedLabel = document.createElement('strong');
  speedLabel.textContent = t('cerebro.controls.orbitSpeed', '🎚 Velocidad de órbita');
  orbitSpeedOutputEl = document.createElement('output');
  orbitSpeedOutputEl.className = 'cer-speed-value';
  speedHead.append(speedLabel, orbitSpeedOutputEl);
  const speedRange = document.createElement('input');
  speedRange.className = 'cer-speed-range';
  speedRange.type = 'range';
  speedRange.min = '0';
  speedRange.max = '3';
  speedRange.step = '0.1';
  speedRange.value = String(orbitSpeedMultiplier);
  speedRange.setAttribute('aria-label', t('cerebro.controls.orbitSpeed', '🎚 Velocidad de órbita'));
  speedRange.addEventListener('input', () => updateOrbitSpeed(speedRange.value));
  const speedScale = document.createElement('div');
  speedScale.className = 'cer-speed-scale';
  const stopped = document.createElement('span');
  stopped.textContent = t('cerebro.controls.orbitStopped', '0 · detenidas');
  const current = document.createElement('span');
  current.textContent = t('cerebro.controls.orbitCurrent', '1 · actual');
  const fast = document.createElement('span');
  fast.textContent = t('cerebro.controls.orbitFast', '3 · rápidas');
  speedScale.append(stopped, current, fast);

  fragment.append(
    completedLabel,
    completedNote,
    controlsLoadingEl,
    effectsTitle,
    effects,
    speedHead,
    speedRange,
    speedScale,
  );
  controlsBodyEl.replaceChildren(fragment);
  updateOrbitSpeed(orbitSpeedMultiplier, false);
}

function bloomResolution(width = window.innerWidth, height = window.innerHeight) {
  const largestSide = Math.max(1, width, height);
  const scale = Math.min(1, BLOOM_MAX_RESOLUTION / largestSide);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function plainModeWasAlreadyTried() {
  if (plainDiagnostics) return true;
  try {
    return sessionStorage.getItem(WEBGL_RECOVERY_SESSION_KEY) === '1';
  } catch (error) {
    console.warn('[cerebro] No se pudo consultar la marca de recuperación WebGL.', error);
    return false;
  }
}

function markPlainModeTried() {
  try {
    sessionStorage.setItem(WEBGL_RECOVERY_SESSION_KEY, '1');
  } catch (error) {
    // El propio ?plain=1 también corta el bucle si el navegador bloquea storage.
    console.warn('[cerebro] No se pudo guardar la marca de recuperación WebGL.', error);
  }
}

function handleWebglFailure() {
  webglContextLost = true;
  if (webglReloadTimer) {
    showMsg(
      t('cerebro.msg.webglLost', 'La tarjeta de video no pudo dibujar la escena.'),
      t('cerebro.msg.webglLostRetry', 'Se está reintentando en modo reducido para que puedas seguir usando el grafo.'),
    );
    return;
  }
  const alreadyReduced = plainModeWasAlreadyTried();
  showMsg(
    t('cerebro.msg.webglLost', 'La tarjeta de video no pudo dibujar la escena.'),
    alreadyReduced
      ? t('cerebro.msg.webglLostReduced', 'El modo reducido también falló; no se recargará otra vez para evitar un bucle.')
      : t('cerebro.msg.webglLostRetry', 'Se está reintentando en modo reducido para que puedas seguir usando el grafo.'),
  );

  if (alreadyReduced) return;
  markPlainModeTried();
  const reducedUrl = new URL(window.location.href);
  reducedUrl.searchParams.set('plain', '1');
  webglReloadTimer = window.setTimeout(() => {
    window.location.replace(reducedUrl.href);
  }, WEBGL_PLAIN_RELOAD_DELAY_MS);
}

function bindWebglRecovery() {
  let renderer = null;
  try {
    renderer = graph?.renderer?.();
  } catch (error) {
    console.warn('[cerebro] No se pudo obtener el renderer para vigilar WebGL.', error);
  }
  const canvas = renderer?.domElement;
  if (canvas?.addEventListener) {
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      handleWebglFailure();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      webglContextLost = false;
      graph?.refresh?.();
      startLoop();
      if (!webglReloadTimer) hideMsg();
    });
  }

  webglCheckTimer = window.setTimeout(() => {
    webglCheckTimer = 0;
    try {
      if (renderer?.getContext?.()?.isContextLost?.()) handleWebglFailure();
    } catch (error) {
      console.warn('[cerebro] No se pudo verificar el estado del contexto WebGL.', error);
    }
  }, WEBGL_CONTEXT_CHECK_DELAY_MS);
}

function parseRgb(color) {
  const match = String(color).match(
    /^rgb\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)$/i,
  );
  return match ? match.slice(1).map(Number) : null;
}

function formatRgb(components) {
  const [red, green, blue] = components.map((component) => (
    Math.min(255, Math.max(0, Math.round(component)))
  ));
  return `rgb(${red}, ${green}, ${blue})`;
}

function mixRgb(from, to, amount) {
  const source = parseRgb(from);
  const target = parseRgb(to);
  if (!source || !target) return from;
  return formatRgb(source.map((component, index) => (
    component + (target[index] - component) * amount
  )));
}

function scaleRgb(color, factor) {
  const components = parseRgb(color);
  return components ? formatRgb(components.map((component) => component * factor)) : color;
}

function saturateRgb(color, factor) {
  const components = parseRgb(color);
  if (!components) return color;
  const luminance = components.reduce((sum, component) => sum + component, 0) / 3;
  return formatRgb(components.map((component) => luminance + (component - luminance) * factor));
}

function assignGalaxyTiers(nodes) {
  const sunCount = Math.max(1, Math.ceil(nodes.length * GALAXY_SUN_TOP_FRACTION));
  const solarDegrees = nodes
    .map((node) => node.degree)
    .filter((degree) => degree > GALAXY_MOON_MAX_DEGREE)
    .sort((a, b) => b - a);
  const sunDegreeThreshold = solarDegrees[Math.min(sunCount - 1, solarDegrees.length - 1)] ?? Infinity;

  for (const node of nodes) {
    if (node.degree <= GALAXY_MOON_MAX_DEGREE) node.galaxyTier = 'moon';
    else if (node.degree >= sunDegreeThreshold) node.galaxyTier = 'sun';
    else node.galaxyTier = 'planet';
  }
}

function galaxyNodeColor(node, warmWhite) {
  const collectionColor = palette.colorFor(node.collection);
  let color = scaleRgb(collectionColor, GALAXY_PLANET_LUMINANCE);
  if (node.galaxyTier === 'moon') color = scaleRgb(collectionColor, GALAXY_MOON_LUMINANCE);
  if (node.galaxyTier === 'sun') {
    const saturated = saturateRgb(collectionColor, GALAXY_SUN_SATURATION);
    color = mixRgb(saturated, warmWhite, GALAXY_SUN_WARM_WHITE_MIX);
  }
  return node.completed ? scaleRgb(color, COMPLETED_NODE_LUMINANCE) : color;
}

function setStatus(kind, text) {
  statusEl.classList.remove('cer-status--ok', 'cer-status--warn', 'cer-status--bad');
  if (kind) statusEl.classList.add(`cer-status--${kind}`);
  statusEl.textContent = text;
}

function loadVendor() {
  if (window.ForceGraph3D) return Promise.resolve(true);
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = FORCE_GRAPH_URL;
    script.onload = () => {
      const loaded = typeof window.ForceGraph3D === 'function';
      if (!loaded) script.remove();
      resolve(loaded);
    };
    script.onerror = () => {
      script.remove();
      resolve(false);
    };
    document.head.appendChild(script);
  });
}

async function fetchGraph() {
  try {
    const graphUrl = includeCompleted ? `${API_GRAPH}?completed=1` : API_GRAPH;
    const response = await fetch(graphUrl, { cache: 'no-store' });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true || !payload.graph) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }

    const nodes = Array.isArray(payload.graph.nodes) ? payload.graph.nodes : [];
    const edges = Array.isArray(payload.graph.edges) ? payload.graph.edges : [];
    const refs = new Set(nodes.map((node) => node.ref));
    const degree = new Map(nodes.map((node) => [node.ref, 0]));
    const links = [];
    let discarded = 0;

    for (const edge of edges) {
      const source = typeof edge.source === 'object' ? edge.source?.ref : edge.source;
      const target = typeof edge.target === 'object' ? edge.target?.ref : edge.target;
      if (!refs.has(source) || !refs.has(target)) {
        discarded++;
        continue;
      }
      links.push({ ...edge, source, target });
      degree.set(source, (degree.get(source) || 0) + 1);
      if (target !== source) degree.set(target, (degree.get(target) || 0) + 1);
    }

    for (const node of nodes) {
      node.degree = degree.get(node.ref) || 0;
      node.val = 1 + Math.sqrt(node.degree) * 1.4;
    }
    assignGalaxyTiers(nodes);
    console.debug(`[cerebro] ${discarded} aristas colgantes descartadas.`);
    return { nodes, links };
  } catch (error) {
    console.warn('[cerebro] No se pudo leer el grafo del Pad.', error);
    return null;
  }
}

function refOf(endpoint) {
  return typeof endpoint === 'object' ? endpoint?.ref : endpoint;
}

function rebuildIndexes(data) {
  nodeByRef = new Map(data.nodes.map((node) => [node.ref, node]));
  linksByRef = new Map();
  nodesByCollection = new Map();

  for (const node of data.nodes) {
    const slug = node.collection || '';
    if (!nodesByCollection.has(slug)) nodesByCollection.set(slug, []);
    nodesByCollection.get(slug).push(node);
  }
  for (const link of data.links) {
    const source = refOf(link.source);
    const target = refOf(link.target);
    if (!linksByRef.has(source)) linksByRef.set(source, []);
    if (!linksByRef.has(target)) linksByRef.set(target, []);
    linksByRef.get(source).push(link);
    if (target !== source) linksByRef.get(target).push(link);
  }

  if (engine) engine.setNodes(nodeByRef, linksByRef);
  else engine = createPulseEngine({ graph, nodeByRef, linksByRef, palette });
}

function collectionLabel(slug) {
  return t(`cerebro.collection.${slug}`, COLLECTION_LABEL[slug] || slug);
}

function linkTypeLabel(type) {
  switch (type) {
    case 'parent': return t('cerebro.legend.hideHierarchy', 'Ocultar jerarquía');
    case 'implements': return t('cerebro.legend.implements', 'Implementa');
    case 'blocks': return t('cerebro.legend.blocks', 'Bloquea');
    case 'supersedes': return t('cerebro.legend.supersedes', 'Reemplaza');
    case 'split_from': return t('cerebro.legend.splitFrom', 'Separada de');
    case 'wiki': return t('cerebro.legend.wiki', 'Wiki-link');
    default: return type;
  }
}

function linkTypeCounts() {
  const counts = new Map(LINK_TYPES.map((type) => [type, 0]));
  for (const link of fullGraphData.links) {
    if (counts.has(link.type)) counts.set(link.type, counts.get(link.type) + 1);
  }
  return counts;
}

function linkIsVisible(link) {
  return !LINK_TYPE_SET.has(link.type) || visibleLinkTypes.has(link.type);
}

function filteredGraphData() {
  return {
    nodes: fullGraphData.nodes,
    links: fullGraphData.links.filter(linkIsVisible),
  };
}

function prepareLayout(nodes) {
  layoutTickCount = 0;
  layoutFrozen = false;
  for (const node of nodes) {
    node.fx = null;
    node.fy = null;
    node.fz = null;
  }
  if (graph && layoutChargeForce) graph.d3Force('charge', layoutChargeForce);
  if (graph && layoutLinkForce) graph.d3Force('link', layoutLinkForce);
}

function freezeSettledLayout() {
  if (layoutFrozen || ++layoutTickCount < LAYOUT_SETTLE_TICKS) return;
  for (const node of graph?.graphData()?.nodes || []) {
    if (Number.isFinite(node.x)) node.fx = node.x;
    if (Number.isFinite(node.y)) node.fy = node.y;
    if (Number.isFinite(node.z)) node.fz = node.z;
  }
  layoutFrozen = true;
  // El motor debe seguir vivo: three-forcegraph sólo copia node.x/y/z a Three
  // y actualiza la geometría de las aristas dentro de su tick de layout. Una vez
  // fijados todos los nodos, retirar las fuerzas evita recalcular el layout sin
  // cortar esa sincronización visual que necesitan las lunas en movimiento.
  graph.d3Force('charge', null);
  graph.d3Force('link', null);
}

function renderLegend() {
  const ordered = [...nodesByCollection.entries()].sort((a, b) => b[1].length - a[1].length);
  const colors = palette.all(ordered.map(([slug]) => slug));
  const countsByType = linkTypeCounts();
  const fragment = document.createDocumentFragment();

  const relationTitle = document.createElement('strong');
  relationTitle.className = 'cer-leg-row';
  relationTitle.textContent = t('cerebro.legend.relations', 'Relaciones');
  fragment.appendChild(relationTitle);

  for (const type of LINK_TYPES) {
    const row = document.createElement('label');
    row.className = 'cer-leg-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.linkType = type;
    checkbox.checked = type === 'parent'
      ? !visibleLinkTypes.has(type)
      : visibleLinkTypes.has(type);
    checkbox.addEventListener('change', () => {
      const show = type === 'parent' ? !checkbox.checked : checkbox.checked;
      if (show) visibleLinkTypes.add(type);
      else visibleLinkTypes.delete(type);
      repaintVisibleLinks();
    });
    const line = document.createElement('span');
    line.className = 'cer-leg-dot';
    line.style.background = palette.colorForLinkType(type);
    line.style.width = '14px';
    line.style.height = type === 'parent' ? '1px' : '3px';
    line.style.borderRadius = '1px';
    const label = document.createElement('span');
    label.textContent = linkTypeLabel(type);
    const count = document.createElement('span');
    count.className = 'cer-leg-count';
    count.textContent = t('cerebro.legend.count', '{n}', { n: countsByType.get(type) || 0 });
    row.append(checkbox, line, label, count);
    fragment.appendChild(row);
  }

  const collectionTitle = document.createElement('strong');
  collectionTitle.className = 'cer-leg-row';
  collectionTitle.textContent = t('cerebro.legend.collections', 'Colecciones');
  fragment.appendChild(collectionTitle);

  for (const [slug, nodes] of ordered) {
    const row = document.createElement('div');
    row.className = 'cer-leg-row';
    const dot = document.createElement('span');
    dot.className = 'cer-leg-dot';
    dot.style.background = colors.get(slug);
    const label = document.createElement('span');
    label.textContent = collectionLabel(slug);
    const count = document.createElement('span');
    count.className = 'cer-leg-count';
    count.textContent = t('cerebro.legend.count', '{n}', { n: nodes.length });
    row.append(dot, label, count);
    fragment.appendChild(row);
  }
  legendBodyEl.replaceChildren(fragment);
}

function renderStats(nodeCount, linkCount) {
  const stats = t('cerebro.stats', '{n} neuronas · {e} conexiones visibles', {
    n: nodeCount,
    e: linkCount,
  });
  const disabledEffects = [
    diagnosticFlags.bloom && t('cerebro.diagnostics.bloom', 'bloom'),
    diagnosticFlags.corona && t('cerebro.diagnostics.corona', 'corona'),
    diagnosticFlags.stars && t('cerebro.diagnostics.stars', 'estrellas'),
    diagnosticFlags.orbits && t('cerebro.diagnostics.orbits', 'órbitas'),
  ].filter(Boolean);
  const diagnostics = disabledEffects.length
    ? t('cerebro.diagnostics.disabled', 'sin: {effects}', { effects: disabledEffects.join(', ') })
    : '';
  statsEl.textContent = diagnostics ? `${stats} · ${diagnostics}` : stats;
}

function repaintVisibleLinks() {
  if (!graph) return;
  const visibleData = filteredGraphData();
  engine?.clear();
  prepareLayout(visibleData.nodes);
  graph.graphData(visibleData);
  rebuildIndexes(graph.graphData());
  renderLegend();
  renderStats(visibleData.nodes.length, visibleData.links.length);
}

function focusNode(node) {
  const distance = 40;
  const length = Math.hypot(node.x || 0, node.y || 0, node.z || 0);
  const position = length
    ? {
        x: node.x * (1 + distance / length),
        y: node.y * (1 + distance / length),
        z: node.z * (1 + distance / length),
      }
    : { x: 0, y: 0, z: distance };
  graph.cameraPosition(position, node, 900);
}

async function buildGraph(data) {
  fullGraphData = data;
  const visibleData = filteredGraphData();
  const graphColors = palette.all(['--cwc-white', '--cwc-accent']);
  const warmWhite = mixRgb(
    graphColors.get('--cwc-white'),
    graphColors.get('--cwc-accent'),
    GALAXY_WARM_WHITE_ACCENT_MIX,
  );
  graph = window.ForceGraph3D({
    controlType: 'orbit',              // OrbitControls: es el único que soporta autoRotate
  })(graphEl)
    .width(window.innerWidth)
    .height(window.innerHeight)
    .nodeId('ref')                     // los edges del Pad vienen por REF, no por uuid
    .backgroundColor(palette.bg())
    .nodeColor((node) => galaxyNodeColor(node, warmWhite))
    .nodeVal((node) => node.val)
    .nodeRelSize(GALAXY_NODE_REL_SIZE)
    .nodeResolution(6)                 // 1000 esferas: baja el costo sin que se note
    .nodeOpacity(GALAXY_NODE_OPACITY)
    .nodeLabel((node) => `<div class="cer-tip"><b>${esc(node.ref)}</b> ${esc(node.title || '')}</div>`)
    .linkColor((link) => palette.colorForLinkType(link.type))
    // La API expone una sola opacidad para todas las aristas. parent se mantiene
    // de fondo mediante su token neutro; el contraste vive en color y ancho.
    .linkOpacity(0.3)
    .linkWidth((link) => LINK_WIDTH[link.type] || 1)
    .linkDirectionalParticleWidth(3)
    .linkDirectionalParticleSpeed(0.02)
    .linkDirectionalParticleColor((link) => palette.colorForLinkType(link.type))
    .enableNodeDrag(false)             // vista contemplativa: mirar, no reacomodar
    .warmupTicks(20)
    .cooldownTicks(Infinity)
    .cooldownTime(Infinity)
    .onEngineTick(freezeSettledLayout)
    .onNodeClick(focusNode);
  bindWebglRecovery();
  // Cada sol ocupa ahora un radio orbital completo: la separación debe contemplar
  // el sistema entero, no solamente el tamaño de la esfera central.
  layoutChargeForce = graph.d3Force('charge').strength(FORCE_CHARGE_STRENGTH);
  layoutLinkForce = graph.d3Force('link').distance(FORCE_LINK_DISTANCE);
  prepareLayout(visibleData.nodes);
  graph.graphData(visibleData);
  graph.cameraPosition({ x: 0, y: 0, z: INITIAL_CAMERA_DISTANCE });
  graph.controls().autoRotate = true;
  graph.controls().autoRotateSpeed = 0.32;   // órbita lenta: el organismo "vive" solo

  rebuildIndexes(graph.graphData());
  orbitalScene = createOrbitalScene({
    scene: graph.scene(),
    palette,
    nodeRelSize: GALAXY_NODE_REL_SIZE,
    colorForNode: (node) => galaxyNodeColor(node, warmWhite),
    disableCorona: diagnosticFlags.corona,
    disableStars: diagnosticFlags.stars,
    disableOrbits: diagnosticFlags.orbits,
  });
  orbitalScene.setSpeedMultiplier(orbitSpeedMultiplier);
  const orbitingCount = orbitalScene.rebuild(fullGraphData);
  console.debug(`[cerebro] ${orbitingCount} satélites en órbita.`);
  renderLegend();
  renderStats(visibleData.nodes.length, visibleData.links.length);
  startLoop();

  try {
    const { EffectComposer } = await import('three/addons/postprocessing/EffectComposer.js');
    const { RenderPass } = await import('three/addons/postprocessing/RenderPass.js');
    const { OutputPass } = await import('three/addons/postprocessing/OutputPass.js');
    if (!EffectComposer || !RenderPass || !OutputPass) throw new Error('Post-procesado de Three.js incompleto.');

    const composer = graph.postProcessingComposer();
    if (!diagnosticFlags.bloom) {
      const { Vector2 } = await import('three');
      const { UnrealBloomPass } = await import('three/addons/postprocessing/UnrealBloomPass.js');
      const bloomSize = bloomResolution();
      // El bloom es difuso y no necesita resolución nativa; sus render targets
      // multiplican el consumo de VRAM, especialmente en pantallas HiDPI.
      bloomPass = new UnrealBloomPass(
        new Vector2(bloomSize.width, bloomSize.height),
        BLOOM_STRENGTH,
        BLOOM_RADIUS,
        BLOOM_THRESHOLD,
      );
      composer.addPass(bloomPass);
      // EffectComposer ajusta el pass al agregarlo; restauramos el límite.
      bloomPass.setSize(bloomSize.width, bloomSize.height);
    }
    // OutputPass debe cerrar la cadena: sin él, el composer no convierte a sRGB
    // y la escena se satura a blanco en hardware real, aunque parezca correcta
    // cuando se renderiza por software.
    outputPass = new OutputPass();
    composer.addPass(outputPass);
  } catch (error) {
    bloomPass = null;
    outputPass = null;
    console.warn('[cerebro] No se pudo activar el bloom; el grafo seguirá sin post-procesado.', error);
  }
}

function sameRefs(data) {
  if (data.nodes.length !== nodeByRef.size) return false;
  return data.nodes.every((node) => nodeByRef.has(node.ref));
}

async function repaintGraph(data) {
  if (!graph) {
    await buildGraph(data);
    return;
  }

  if (sameRefs(data)) {
    for (const fresh of data.nodes) Object.assign(nodeByRef.get(fresh.ref), fresh);
    fullGraphData = { nodes: [...nodeByRef.values()], links: data.links };
    repaintVisibleLinks();
    const orbitingCount = orbitalScene?.rebuild(fullGraphData) || 0;
    console.debug(`[cerebro] ${orbitingCount} satélites en órbita tras el repintado.`);
    return;
  }

  const positionKeys = ['x', 'y', 'z', 'vx', 'vy', 'vz'];
  for (const node of data.nodes) {
    const previous = nodeByRef.get(node.ref);
    if (!previous) continue;
    for (const key of positionKeys) {
      if (Number.isFinite(previous[key])) node[key] = previous[key];
    }
  }

  engine?.clear();
  fullGraphData = data;
  const visibleData = filteredGraphData();
  prepareLayout(visibleData.nodes);
  graph.graphData(visibleData);
  rebuildIndexes(graph.graphData());
  const orbitingCount = orbitalScene?.rebuild(fullGraphData) || 0;
  console.debug(`[cerebro] ${orbitingCount} satélites en órbita tras el repintado.`);
  renderLegend();
  renderStats(visibleData.nodes.length, visibleData.links.length);
}

function scheduleGraphRetry() {
  if (stopped || graphRetryTimer) return;
  const delay = graphRetryMs;
  graphRetryMs = Math.min(30000, Math.round(graphRetryMs * 1.6));
  graphRetryTimer = window.setTimeout(() => {
    graphRetryTimer = 0;
    void refreshGraph();
  }, delay);
}

function refreshGraph() {
  if (stopped) return Promise.resolve(false);
  if (graphFetchInFlight) return graphFetchInFlight;
  setControlsLoading(true);
  graphFetchInFlight = (async () => {
    const data = await fetchGraph();
    if (!data) {
      showMsg(
        t('cerebro.msg.padDown', 'El Pad no está respondiendo.'),
        t('cerebro.msg.padDownSub', 'La vista se reintentará automáticamente.'),
      );
      setStatus('warn', t('cerebro.status.padDown', 'Pad sin responder'));
      scheduleGraphRetry();
      return false;
    }

    try {
      await repaintGraph(data);
    } catch (error) {
      console.error('[cerebro] No se pudo pintar el grafo.', error);
      showMsg(
        t('cerebro.msg.drawError', 'No se pudo dibujar el Cerebro del Pad.'),
        t('cerebro.msg.drawErrorSub', 'La vista se reintentará automáticamente.'),
      );
      scheduleGraphRetry();
      return false;
    }

    graphRetryMs = 3000;
    if (graphRetryTimer) {
      clearTimeout(graphRetryTimer);
      graphRetryTimer = 0;
    }
    if (!webglContextLost && !webglReloadTimer) hideMsg();
    if (!streamStarted) connect();
    return true;
  })().finally(() => {
    graphFetchInFlight = null;
    setControlsLoading(false);
  });
  return graphFetchInFlight;
}

function pushFeed(event) {
  const collection = event.collection || nodeByRef.get(event.ref)?.collection || '';
  const rawRef = event.ref || (collection ? collectionLabel(collection) : t('cerebro.feed.pad', 'Pad'));
  const fallback = event.kind === 'write'
    ? t('cerebro.feed.write', 'escritura')
    : t('cerebro.feed.read', 'lectura');
  const rawWhat = [event.action, event.title].filter(Boolean).join(' · ') || fallback;

  const line = document.createElement('div');
  line.className = 'cer-feed-line';
  const bullet = document.createElement('span');
  bullet.style.color = palette.colorFor(collection);
  bullet.textContent = t('cerebro.feed.bullet', '● ');
  const ref = document.createElement('span');
  ref.className = 'cer-feed-ref';
  ref.textContent = t('cerebro.feed.ref', '{ref}', { ref: rawRef });
  const what = document.createElement('span');
  what.className = 'cer-feed-what';
  what.textContent = t('cerebro.feed.what', ' · {what}', { what: rawWhat });
  line.append(bullet, ref, what);
  feedEl.prepend(line);

  window.setTimeout(() => line.classList.add('cer-feed-line--out'), 7000);
  window.setTimeout(() => line.remove(), 7600);
  while (feedEl.children.length > 8) feedEl.removeChild(feedEl.lastChild);
}

function setLive() {
  setStatus('ok', t('cerebro.status.live', 'en vivo'));
}

function connect() {
  if (stopped || streamStarted) return;
  streamStarted = true;
  setStatus('bad', t('cerebro.status.reconnecting', 'reconectando…'));

  if (!('EventSource' in window)) {
    showMsg(
      t('cerebro.msg.noStream', 'Este navegador no puede abrir el flujo en vivo.'),
      t('cerebro.msg.noStreamSub', 'El grafo queda disponible sin pulsos de actividad.'),
    );
    return;
  }

  eventSource = new EventSource(API_STREAM);
  eventSource.addEventListener('hello', setLive);
  eventSource.addEventListener('pulse', (message) => {
    try {
      const event = JSON.parse(message.data);
      if (event.ref) engine?.pulseNode(event.ref, { strong: event.kind === 'write' });
      else if (event.collection) engine?.pulseCollection(event.collection);
      pushFeed(event);
    } catch (error) {
      console.warn('[cerebro] Pulso SSE inválido.', error);
    }
  });
  eventSource.addEventListener('status', (message) => {
    try {
      const status = JSON.parse(message.data);
      if (status.padOk === false) {
        setStatus('warn', t('cerebro.status.padDown', 'Pad sin responder'));
      } else if (status.padOk === true) {
        setLive();
      }
    } catch (error) {
      console.warn('[cerebro] Estado SSE inválido.', error);
    }
  });
  eventSource.onopen = () => {
    if (streamOpened) void refreshGraph();
    streamOpened = true;
  };
  eventSource.onerror = () => {
    setStatus('bad', t('cerebro.status.reconnecting', 'reconectando…'));
    // EventSource conserva su propio backoff; cerrarlo impediría la reconexión.
  };
}

function loop(now) {
  if (stopped) return;
  orbitalScene?.tick(now);
  engine.tick(now);
  rafId = requestAnimationFrame(loop);
}

function startLoop() {
  if (!rafId && !stopped) rafId = requestAnimationFrame(loop);
}

function stop() {
  stopped = true;
  eventSource?.close();
  if (rafId) cancelAnimationFrame(rafId);
  if (resizeTimer) clearTimeout(resizeTimer);
  if (vendorRetryTimer) clearTimeout(vendorRetryTimer);
  if (graphRetryTimer) clearTimeout(graphRetryTimer);
  if (webglCheckTimer) clearTimeout(webglCheckTimer);
  if (webglReloadTimer) clearTimeout(webglReloadTimer);
  engine?.clear();
  orbitalScene?.dispose();
  orbitalScene = null;
  window.close();
}

async function boot() {
  const loaded = await loadVendor();
  if (stopped) return;
  if (!loaded) {
    showMsg(
      t('cerebro.msg.noLib', 'No se pudo cargar la librería 3D.'),
      t('cerebro.msg.noLibSub', 'Revisá que el servidor esté sirviendo /vendor/3d-force-graph. Reintento automático en 10 s.'),
    );
    vendorRetryTimer = window.setTimeout(() => {
      vendorRetryTimer = 0;
      void boot();
    }, 10000);
    return;
  }
  void refreshGraph();
}

hudEl.insertAdjacentHTML('beforeend', helpBtn('cerebro', { size: 13, cls: 'cer-help' }));
bindHelp();
closeBtn.addEventListener('click', stop);
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') stop(); });
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    graph?.width(window.innerWidth).height(window.innerHeight);
    const bloomSize = bloomResolution();
    bloomPass?.setSize(bloomSize.width, bloomSize.height);
  }, 150);
});

legendEl.open = false;
controlsEl.open = false;
renderControls();
setStatus('bad', t('cerebro.status.loading', 'cargando…'));
void boot();
