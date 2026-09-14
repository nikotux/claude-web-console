import { openZoomViewer } from '../ui/zoom-viewer.js';

const TEXT_PREVIEW_MAX = 512 * 1024;
// En la conversación c1897792-15, los adjuntos reales se agrupan bajo los 6 minutos
// y los archivos no-adjuntos aparecen recién a los 33: 10 minutos dejan 4,3 minutos
// de margen sobre el peor caso real y siguen a 23 minutos del primer falso positivo.
const ARTIFACT_EVENT_TIME_TOLERANCE_MS = 10 * 60 * 1000;

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']);
const CODE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'sh', 'bash', 'zsh', 'fish',
  'sql', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'r', 'lua',
  'pl', 'pm', 'ex', 'exs', 'erl', 'clj', 'cljs', 'scala', 'dart', 'tf', 'proto',
  'graphql', 'gql', 'diff', 'patch', 'gradle', 'make', 'dockerfile',
]);
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'mdx', 'rst', 'csv', 'tsv', 'json', 'jsonl', 'ndjson',
  'yaml', 'yml', 'xml', 'toml', 'ini', 'conf', 'cfg', 'properties', 'env', 'log',
  ...CODE_EXTENSIONS,
]);
const DOCUMENT_EXTENSIONS = new Set([
  'doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'pages',
]);

let host = null;
let context = null;
let eventsSnapshot = [];
let artifacts = [];
let selectedKey = null;
let previewController = null;
let attachmentEventCount = 0;
let listRequestGeneration = 0;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function extensionOf(name) {
  const value = String(name || '');
  const dot = value.lastIndexOf('.');
  return dot < 0 ? '' : value.slice(dot + 1).toLowerCase();
}

function categoryOf(attachment) {
  const name = String(attachment?.name || '');
  const extension = extensionOf(name);
  const mime = String(attachment?.mime || '').toLowerCase();
  const type = String(attachment?.type || '').toLowerCase();

  if (type === 'pdf' || mime === 'application/pdf' || extension === 'pdf') {
    return { id: 'pdf', label: 'PDF', color: 'var(--cwc-cat-pdf)' };
  }
  if (type === 'image' || mime.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) {
    return { id: 'image', label: 'Imagen', color: 'var(--cwc-cat-image)' };
  }
  if (mime.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) {
    return { id: 'video', label: 'Video', color: 'var(--cwc-cat-video)' };
  }
  if (mime.startsWith('audio/') || AUDIO_EXTENSIONS.has(extension)) {
    return { id: 'audio', label: 'Audio', color: 'var(--cwc-cat-audio)' };
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return { id: 'archive', label: 'Archivo comprimido', color: 'var(--cwc-cat-archive)' };
  }
  if (CODE_EXTENSIONS.has(extension)) {
    return { id: 'code', label: 'Código', color: 'var(--cwc-cat-code)' };
  }
  if (type === 'text' || mime.startsWith('text/') || TEXT_EXTENSIONS.has(extension)) {
    return { id: 'doc', label: 'Texto', color: 'var(--cwc-cat-doc)' };
  }
  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return { id: 'doc', label: 'Documento', color: 'var(--cwc-cat-doc)' };
  }
  return { id: 'file', label: 'Archivo', color: 'var(--cwc-cat-file)' };
}

function previewKind(artifact) {
  const extension = extensionOf(artifact.name);
  const mime = String(artifact.mime || '').toLowerCase();
  const type = String(artifact.type || '').toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (type === 'pdf' || mime === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (type === 'text' || mime.startsWith('text/') || TEXT_EXTENSIONS.has(extension)) return 'text';
  return null;
}

function formatSize(value) {
  if (value == null || value === '') return '';
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = bytes;
  let unit = -1;
  do {
    amount /= 1024;
    unit += 1;
  } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount < 10 ? 1 : 0)} ${units[unit]}`;
}

function attachmentUrl(artifact) {
  return `/api/chat/attachment?id=${encodeURIComponent(context.chatId)}&name=${encodeURIComponent(artifact.name)}`;
}

function attachmentCount(events) {
  return events.reduce((total, event) => (
    total + (Array.isArray(event?.attachments) ? event.attachments.length : 0)
  ), 0);
}

function eventTimestampMs(event) {
  const value = event?.ts;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function eventIndexForArtifact(artifact) {
  const name = String(artifact?.name || '').trim();
  for (let eventIndex = eventsSnapshot.length - 1; eventIndex >= 0; eventIndex -= 1) {
    const attachments = Array.isArray(eventsSnapshot[eventIndex]?.attachments)
      ? eventsSnapshot[eventIndex].attachments
      : [];
    if (attachments.some((attachment) => String(attachment?.name || '').trim() === name)) {
      return eventIndex;
    }
  }

  // El historial actual conserva los adjuntos como bloques genéricos sin su
  // nombre. En ese caso vinculamos por la cercanía entre el mtime del archivo y
  // el ts del mensaje del usuario que se envía inmediatamente después.
  const mtimeMs = Number(artifact?.mtimeMs);
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return null;
  const userEvents = eventsSnapshot.flatMap((event, eventIndex) => {
    if (event?.type !== 'user') return [];
    const timestamp = eventTimestampMs(event);
    return timestamp === null ? [] : [{ eventIndex, timestamp }];
  });

  const firstAfter = userEvents.find(({ timestamp }) => timestamp >= mtimeMs);
  if (firstAfter && firstAfter.timestamp - mtimeMs <= ARTIFACT_EVENT_TIME_TOLERANCE_MS) {
    return firstAfter.eventIndex;
  }

  let nearest = null;
  for (const candidate of userEvents) {
    const distance = Math.abs(candidate.timestamp - mtimeMs);
    if (!nearest || distance < nearest.distance) nearest = { ...candidate, distance };
  }
  if (nearest && nearest.distance <= ARTIFACT_EVENT_TIME_TOLERANCE_MS) return nearest.eventIndex;
  return null;
}

function normalizeArtifacts(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((artifact) => typeof artifact?.name === 'string' && artifact.name.trim())
    .map((artifact) => {
      const name = artifact.name.trim();
      return {
        ...artifact,
        name,
        category: categoryOf(artifact),
        eventIndex: eventIndexForArtifact({ ...artifact, name }),
        key: `name:${name}`,
      };
    })
    .sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
}

async function refreshArtifacts() {
  if (!host || !context?.api || !context?.chatId) return;
  const mountedHost = host;
  const chatId = context.chatId;
  const generation = ++listRequestGeneration;
  try {
    const data = await context.api.get(`/api/chat/attachments?id=${encodeURIComponent(chatId)}`);
    if (host !== mountedHost || context?.chatId !== chatId || generation !== listRequestGeneration) return;
    artifacts = normalizeArtifacts(data?.attachments);
    renderList();
  } catch {
    if (host !== mountedHost || context?.chatId !== chatId || generation !== listRequestGeneration) return;
    context?.toast?.('No se pudieron cargar los artefactos de esta conversación.');
    renderList();
  }
}

function artifactMeta(artifact) {
  const parts = [artifact.category.label];
  const size = formatSize(artifact.size);
  if (size) parts.push(size);
  if (artifact.mtimeMs && context?.fmtDate) {
    try {
      const date = context.fmtDate(artifact.mtimeMs);
      if (date) parts.push(date);
    } catch {
      // La fecha es opcional; nombre y tipo siguen disponibles.
    }
  }
  if (!artifact.name) parts.push('Sin nombre disponible');
  return parts.join(' · ');
}

function renderList() {
  const list = host?.querySelector('[data-artifact-list]');
  if (!list) return;
  host.querySelector(':scope > .cab-side')?.classList.toggle('cab-side--empty', !artifacts.length);

  if (!artifacts.length) {
    list.innerHTML = '<div class="cab-side-empty">Los archivos de este chat aparecerán acá.</div>';
    closePreview();
    return;
  }

  if (selectedKey && !artifacts.some((artifact) => artifact.key === selectedKey)) closePreview();
  list.innerHTML = artifacts.map((artifact, index) => {
    const canPreview = Boolean(previewKind(artifact));
    const displayName = artifact.name;
    const active = artifact.key === selectedKey ? ' cab-side-item--active' : '';
    const previewButton = canPreview
      ? `<button type="button" data-action="preview" data-index="${index}" title="Previsualizar ${escapeHtml(displayName)}" style="min-width:0;flex:1;padding:0;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer">`
      : '<span style="min-width:0;flex:1">';
    const previewClose = canPreview ? '</button>' : '</span>';
    const locateButton = Number.isInteger(artifact.eventIndex)
      ? `<button type="button" data-action="locate" data-index="${index}" title="Ir al mensaje donde apareció" style="padding:0;border:0;background:transparent;color:var(--cwc-text-secondary);font:inherit;font-size:var(--cwc-fs-xs);cursor:pointer">Ir al mensaje</button>`
      : '';
    const actions = `<span style="display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin-top:7px;padding-left:18px">
          <a href="${escapeHtml(attachmentUrl(artifact))}" download="${escapeHtml(artifact.name)}" title="Descargar ${escapeHtml(displayName)}" style="color:var(--cwc-text-secondary);font-size:var(--cwc-fs-xs);text-decoration:none">Descargar</a>
          ${locateButton}
        </span>`;
    return `
      <div class="cab-side-item${active}" data-artifact-key="${escapeHtml(artifact.key)}" style="display:block">
        <div style="display:flex;align-items:flex-start;gap:10px">
          <span aria-hidden="true" title="${escapeHtml(artifact.category.label)}" style="flex:0 0 auto;width:8px;height:8px;margin-top:6px;border-radius:50%;background:${artifact.category.color}"></span>
          ${previewButton}
            <span class="cab-side-label" title="${escapeHtml(displayName)}" style="color:var(--cwc-text)">${escapeHtml(displayName)}</span>
            <span class="cab-side-meta" style="display:block;margin-top:3px">${escapeHtml(artifactMeta(artifact))}</span>
          ${previewClose}
        </div>
        ${actions}
      </div>`;
  }).join('');
}

function closePreview() {
  previewController?.abort();
  previewController = null;
  selectedKey = null;
  const preview = host?.querySelector('[data-artifact-preview]');
  if (preview) {
    preview.hidden = true;
    preview.innerHTML = '';
  }
  host?.closest('.cab-floating-panel')?.classList.remove('cab-floating-panel--wide');
  host?.querySelectorAll('.cab-side-item--active').forEach((item) => item.classList.remove('cab-side-item--active'));
}

function previewShell(artifact, message) {
  const preview = host.querySelector('[data-artifact-preview]');
  const locateButton = Number.isInteger(artifact.eventIndex)
    ? `<button type="button" data-action="locate" data-artifact-key="${escapeHtml(artifact.key)}" title="Ir al mensaje donde apareció" style="padding:0;border:0;background:transparent;color:var(--cwc-text-secondary);font:inherit;font-size:var(--cwc-fs-sm);text-decoration:none;cursor:pointer">Ir al mensaje</button>`
    : '';
  preview.hidden = false;
  host.closest('.cab-floating-panel')?.classList.add('cab-floating-panel--wide');
  preview.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
      <div style="min-width:0">
        <h3 class="cab-side-title" style="overflow-wrap:anywhere">${escapeHtml(artifact.name)}</h3>
        <div class="cab-side-meta">${escapeHtml(artifactMeta(artifact))}</div>
      </div>
      <button type="button" data-action="close-preview" aria-label="Cerrar vista previa" title="Cerrar" style="flex:0 0 auto;padding:2px 5px;border:0;background:transparent;color:var(--cwc-text-secondary);font:inherit;cursor:pointer">×</button>
    </div>
    <div data-artifact-preview-body role="status" style="margin-top:12px;overflow:auto">${escapeHtml(message)}</div>
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin-top:12px">
      <a href="${escapeHtml(attachmentUrl(artifact))}" download="${escapeHtml(artifact.name)}" style="color:var(--cwc-text-secondary);font-size:var(--cwc-fs-sm);text-decoration:none">Descargar archivo</a>
      ${locateButton}
    </div>`;
  return preview.querySelector('[data-artifact-preview-body]');
}

function setActiveItem(key) {
  host.querySelectorAll('[data-artifact-key]').forEach((item) => {
    item.classList.toggle('cab-side-item--active', item.dataset.artifactKey === key);
  });
}

async function showPreview(artifact) {
  previewController?.abort();
  previewController = null;
  selectedKey = artifact.key;
  setActiveItem(selectedKey);
  const body = previewShell(artifact, 'Preparando vista previa…');
  const kind = previewKind(artifact);
  const url = attachmentUrl(artifact);

  if (kind === 'image') {
    const image = document.createElement('img');
    image.src = url;
    image.alt = artifact.name;
    image.loading = 'lazy';
    image.style.cssText = 'display:block;max-width:100%;max-height:420px;border:1px solid var(--cwc-border);background:var(--cwc-bg-panel);object-fit:contain;cursor:zoom-in';
    const zoomButton = document.createElement('button');
    zoomButton.type = 'button';
    zoomButton.title = `Ampliar imagen ${artifact.name}`;
    zoomButton.setAttribute('aria-label', `Ampliar imagen ${artifact.name}`);
    zoomButton.style.cssText = 'display:block;max-width:100%;margin:auto;padding:0;border:0;background:transparent;cursor:zoom-in';
    zoomButton.appendChild(image);
    zoomButton.addEventListener('click', () => {
      const zoomImage = image.cloneNode(true);
      zoomImage.loading = 'eager';
      zoomImage.style.cssText = '';
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        zoomImage.width = image.naturalWidth;
        zoomImage.height = image.naturalHeight;
      }
      openZoomViewer({ title: artifact.name, node: zoomImage });
    });
    image.addEventListener('error', () => {
      body.textContent = 'No se pudo mostrar la imagen. Podés descargarla.';
    }, { once: true });
    body.replaceChildren(zoomButton);
    body.removeAttribute('role');
    return;
  }

  if (kind === 'pdf') {
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.title = `Vista previa de ${artifact.name}`;
    frame.loading = 'lazy';
    frame.style.cssText = 'display:block;width:100%;height:420px;border:1px solid var(--cwc-border);background:var(--cwc-bg-panel)';
    body.replaceChildren(frame);
    return;
  }

  if (kind !== 'text') {
    body.textContent = 'Este tipo de archivo no tiene vista previa. Podés descargarlo.';
    return;
  }

  const knownSize = Number(artifact.size);
  if (Number.isFinite(knownSize) && knownSize > TEXT_PREVIEW_MAX) {
    body.textContent = 'El texto es demasiado grande para mostrarlo acá. Podés descargarlo.';
    return;
  }

  const controller = new AbortController();
  previewController = controller;
  try {
    const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > TEXT_PREVIEW_MAX) {
      body.textContent = 'El texto es demasiado grande para mostrarlo acá. Podés descargarlo.';
      return;
    }
    const text = await response.text();
    if (controller.signal.aborted || selectedKey !== artifact.key) return;
    if (new Blob([text]).size > TEXT_PREVIEW_MAX) {
      body.textContent = 'El texto es demasiado grande para mostrarlo acá. Podés descargarlo.';
      return;
    }
    const pre = document.createElement('pre');
    pre.textContent = text;
    pre.style.cssText = 'max-height:420px;margin:0;padding:10px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--cwc-border);background:var(--cwc-bg-panel);color:var(--cwc-text);font:var(--cwc-fs-sm) var(--cwc-font-mono)';
    body.replaceChildren(pre);
    body.removeAttribute('role');
  } catch (error) {
    if (error.name === 'AbortError' || selectedKey !== artifact.key) return;
    body.textContent = 'No se pudo mostrar el texto. Podés descargarlo.';
    context?.toast?.(`No se pudo previsualizar “${artifact.name}”.`);
  } finally {
    if (previewController === controller) previewController = null;
  }
}

function artifactFromTrigger(trigger) {
  const key = trigger.dataset.artifactKey;
  if (key) return artifacts.find((artifact) => artifact.key === key) || null;
  const index = Number(trigger.dataset.index);
  return Number.isInteger(index) ? artifacts[index] : null;
}

function handleClick(event) {
  const trigger = event.target.closest('[data-action]');
  if (!trigger || !host?.contains(trigger)) return;
  const action = trigger.dataset.action;
  const artifact = artifactFromTrigger(trigger);
  if (action === 'preview' && artifact) showPreview(artifact);
  else if (action === 'locate' && artifact && typeof context.goToEvent === 'function') {
    context.goToEvent(artifact.eventIndex);
  } else if (action === 'close-preview') closePreview();
}

const panel = {
  name: 'artefactos',

  async mount(el, ctx) {
    host = el;
    context = ctx;
    artifacts = [];
    selectedKey = null;
    host.innerHTML = `
      <section class="cab-side cab-side--artifacts" aria-labelledby="cab-artifacts-title">
        <div class="cab-side-block cab-artifacts-list-column">
          <h2 class="cab-side-title" id="cab-artifacts-title">Artefactos</h2>
          <div class="cab-side-meta" style="margin-bottom:10px">Adjuntos y archivos generados en esta conversación.</div>
          <div data-artifact-list aria-live="polite"></div>
        </div>
        <div class="cab-side-block cab-artifacts-preview-column" data-artifact-preview hidden></div>
      </section>`;
    host.addEventListener('click', handleClick);
    renderList();
    await refreshArtifacts();
  },

  update(events) {
    const nextEvents = Array.isArray(events) ? events : [];
    const nextAttachmentCount = attachmentCount(nextEvents);
    const shouldRefresh = nextAttachmentCount !== attachmentEventCount;
    eventsSnapshot = nextEvents;
    attachmentEventCount = nextAttachmentCount;
    artifacts = normalizeArtifacts(artifacts);
    if (host) {
      renderList();
      if (shouldRefresh) refreshArtifacts();
    }
  },

  unmount() {
    previewController?.abort();
    previewController = null;
    host?.closest('.cab-floating-panel')?.classList.remove('cab-floating-panel--wide');
    host?.removeEventListener('click', handleClick);
    host = null;
    context = null;
    eventsSnapshot = [];
    artifacts = [];
    attachmentEventCount = 0;
    listRequestGeneration += 1;
    selectedKey = null;
  },
};

export default panel;
