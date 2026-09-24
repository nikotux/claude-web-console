import { openZoomViewer } from '../ui/zoom-viewer.js';
import { icon } from '../ui/icons.js';
import { t } from '../ui/i18n.js';

const FILES_API = '/api/files';
const VIEW_STORAGE_KEY = 'cabina:files:view';
const SORT_STORAGE_KEY = 'cabina:files:sort';
const SORT_DIRECTION_STORAGE_KEY = 'cabina:files:sort-direction';
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'avif']);
const FILE_CATEGORIES = {
  image: new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'avif']),
  video: new Set(['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v']),
  audio: new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac']),
  archive: new Set(['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2', 'xz']),
  code: new Set(['js', 'mjs', 'ts', 'tsx', 'jsx', 'json', 'py', 'go', 'rs', 'c', 'cpp', 'h', 'java', 'rb', 'php', 'sh', 'html', 'css', 'scss', 'yml', 'yaml', 'toml', 'sql']),
  pdf: new Set(['pdf']),
  doc: new Set(['txt', 'md', 'doc', 'docx', 'rtf', 'csv', 'xls', 'xlsx', 'ppt', 'pptx']),
};

let host = null;
let context = null;
let listeners = null;
let currentPath = '';
let entries = [];
let selectedName = null;
let previewedEntry = null;
let menuEntryName = null;
let menuReturnFocus = null;
let loadSequence = 0;
let previewSequence = 0;
let viewMode = 'list';
let sortField = 'name';
let sortDirection = 'asc';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function joinPath(base, name) {
  return base ? `${base}/${name}` : name;
}

function parentPath(path) {
  const separator = path.lastIndexOf('/');
  return separator < 0 ? '' : path.slice(0, separator);
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function categoryOf(name) {
  const extension = extensionOf(name);
  for (const [category, extensions] of Object.entries(FILE_CATEGORIES)) {
    if (extensions.has(extension)) return category;
  }
  return 'file';
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return t('cabina.archivos.unknownSize', 'Tamaño desconocido');
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function formatDate(timestamp) {
  if (!timestamp) return t('cabina.archivos.noDate', 'Sin fecha');
  try {
    return context.fmtDate(timestamp);
  } catch {
    return new Date(timestamp).toLocaleString('es');
  }
}

function storedPreference(key, allowed, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function storePreference(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // La vista sigue funcionando aunque el navegador bloquee el almacenamiento.
  }
}

function directoryCount(entry) {
  return Number.isInteger(entry.childCount) && entry.childCount >= 0 ? entry.childCount : null;
}

function directoryCountLabel(entry) {
  const count = directoryCount(entry);
  if (count === null) return '';
  if (entry.childCountCapped) return t('cabina.archivos.childCountCapped', '{count} o más elementos', { count });
  return count === 1
    ? t('cabina.archivos.childCountOne', '{count} elemento', { count })
    : t('cabina.archivos.childCountMany', '{count} elementos', { count });
}

function typeLabel(entry) {
  if (entry.type === 'dir') return t('cabina.archivos.folderType', 'Carpeta');
  if (entry.type !== 'file') return t('cabina.archivos.unavailableType', 'Elemento no disponible');
  const category = categoryOf(entry.name);
  return {
    image: t('cabina.archivos.imageType', 'Imagen'),
    video: t('cabina.archivos.videoType', 'Video'),
    audio: t('cabina.archivos.audioType', 'Audio'),
    archive: t('cabina.archivos.archiveType', 'Archivo comprimido'),
    code: t('cabina.archivos.codeType', 'Código'),
    pdf: t('cabina.archivos.pdfType', 'PDF'),
    doc: t('cabina.archivos.documentType', 'Documento'),
    file: t('cabina.archivos.fileType', 'Archivo'),
  }[category];
}

function propertyParts(entry) {
  const parts = [typeLabel(entry)];
  const count = entry.type === 'dir' ? directoryCountLabel(entry) : '';
  if (count) parts.push(count);
  if (entry.type === 'file') parts.push(formatSize(entry.size));
  parts.push(formatDate(entry.mtimeMs));
  if (entry.symlink === true) parts.push(t('cabina.archivos.linkType', 'Enlace'));
  return parts;
}

function breadcrumbs() {
  const parts = currentPath ? currentPath.split('/') : [];
  const crumbs = [{ label: t('cabina.archivos.home', 'Inicio'), path: '' }];
  let accumulated = '';
  for (const part of parts) {
    accumulated = joinPath(accumulated, part);
    crumbs.push({ label: part, path: accumulated });
  }
  const back = `<button class="cab-btn cab-btn--cold" type="button" data-action="back"${currentPath ? '' : ' disabled'}>${icon('chevronLeft')} ${t('cabina.archivos.back', 'Volver')}</button>`;
  return back + crumbs.map((crumb, index) => {
    const separator = index ? `<span aria-hidden="true">${icon('chevronRight')}</span>` : '';
    const current = index === crumbs.length - 1 ? ' aria-current="location"' : '';
    return `${separator}<button class="cab-btn cab-btn--cold" type="button" data-action="navigate" data-path="${escapeHtml(crumb.path)}"${current}>${index ? icon('folder') : icon('home')} ${escapeHtml(crumb.label)}</button>`;
  }).join('');
}

function renderFrame() {
  host.innerHTML = `
    <section class="cab-fs-files" aria-labelledby="cab-files-title">
      <header class="cab-page-header">
        <div>
          <h1 class="cab-title" id="cab-files-title">${t('cabina.archivos.title', 'La Forja · tus archivos')}</h1>
          <p class="cab-subtitle">${t('cabina.archivos.subtitle', 'Organizá carpetas, revisá documentos y subí archivos sin salir de la cabina.')}</p>
        </div>
        <div class="cab-composer-actions cab-fs-page-actions">
          <button class="cab-btn cab-btn--cold" type="button" data-action="mkdir">${icon('plus')} ${t('cabina.archivos.newFolder', 'Nueva carpeta')}</button>
          <button class="cab-btn cab-btn--hot" type="button" data-action="choose-upload">${icon('upload')} ${t('cabina.archivos.uploadFiles', 'Subir archivos')}</button>
          <input type="file" data-upload-input multiple hidden>
        </div>
        <button class="cab-help-btn" type="button" data-cabina-help title="${t('cabina.archivos.screenHelp', 'Cómo se usa esta pantalla')}" aria-label="${t('cabina.archivos.screenHelp', 'Cómo se usa esta pantalla')}">${icon('help', { size: 16 })}</button>
      </header>
      <nav class="cab-composer-actions" data-breadcrumbs aria-label="${t('cabina.archivos.currentFolder', 'Carpeta actual')}"></nav>
      <div class="cab-section-divider">
        <span data-location>${t('cabina.archivos.content', 'Contenido')}</span>
        <span class="cab-section-divider-line"></span>
        <span class="cab-status-chip" data-count>${t('cabina.archivos.initialCount', '0 elementos')}</span>
      </div>
      <div class="cab-fs-files-toolbar" aria-label="${t('cabina.archivos.explorerOptions', 'Opciones del explorador')}">
        <label class="cab-fs-files-sort-label" for="cab-files-sort">${t('cabina.archivos.sortBy', 'Ordenar por')}</label>
        <select class="cab-fs-files-sort" id="cab-files-sort" data-sort-field>
          <option value="name">${t('cabina.archivos.nameSort', 'Nombre')}</option>
          <option value="size">${t('cabina.archivos.sizeSort', 'Tamaño')}</option>
          <option value="date">${t('cabina.archivos.dateSort', 'Fecha')}</option>
        </select>
        <button class="cab-btn cab-btn--cold cab-fs-files-direction" type="button" data-action="toggle-sort-direction"></button>
        <span class="cab-fs-files-toolbar-spacer"></span>
        <div class="cab-fs-files-view-toggle" role="group" aria-label="${t('cabina.archivos.view', 'Vista')}">
          <button class="cab-btn cab-btn--cold" type="button" data-action="set-view" data-view="list" title="${t('cabina.archivos.listView', 'Vista de lista')}" aria-label="${t('cabina.archivos.listView', 'Vista de lista')}">${icon('list')}</button>
          <button class="cab-btn cab-btn--cold" type="button" data-action="set-view" data-view="grid" title="${t('cabina.archivos.gridView', 'Vista de cuadrícula')}" aria-label="${t('cabina.archivos.gridView', 'Vista de cuadrícula')}">${icon('grid')}</button>
        </div>
      </div>
      <div class="cab-composer-actions cab-fs-page-actions" data-selection-actions aria-live="polite" hidden style="display:none;"></div>
      <div class="cab-fs-empty" data-drop-message role="status" hidden
        style="margin-bottom:var(--lite-space-y);border:1px dashed var(--cwc-accent);color:var(--cwc-text);">
        ${t('cabina.archivos.dropInFolder', 'Soltá los archivos para subirlos a esta carpeta.')}
      </div>
      <div class="cab-fs-files-workspace">
        <div class="cab-fs-tree cab-fs-root-drop" data-file-list aria-live="polite"></div>
        <aside class="cab-fs-files-preview" data-preview aria-live="polite">
          <div class="cab-fs-files-preview-placeholder">
            ${icon('eye')}
            <span>${t('cabina.archivos.selectForPreview', 'Seleccioná un elemento para ver sus propiedades y su vista previa.')}</span>
          </div>
        </aside>
      </div>
      <div class="cab-fs-menu" data-file-menu role="menu" aria-label="${t('cabina.archivos.fileActions', 'Acciones del archivo')}" hidden style="display:none;"></div>
    </section>`;
  renderLocation();
  renderToolbar();
  renderSelectionActions();
}

function renderLocation() {
  const breadcrumbHost = host?.querySelector('[data-breadcrumbs]');
  const location = host?.querySelector('[data-location]');
  if (breadcrumbHost) breadcrumbHost.innerHTML = breadcrumbs();
  if (location) location.textContent = currentPath || t('cabina.archivos.home', 'Inicio');
}

function entryMeta(entry) {
  return propertyParts(entry).join(' · ');
}

function renderToolbar() {
  if (!host) return;
  const field = host.querySelector('[data-sort-field]');
  if (field) field.value = sortField;
  const direction = host.querySelector('[data-action="toggle-sort-direction"]');
  if (direction) {
    const ascending = sortDirection === 'asc';
    direction.innerHTML = `${icon('chevronDown')} ${ascending
      ? t('cabina.archivos.ascending', 'Ascendente')
      : t('cabina.archivos.descending', 'Descendente')}`;
    direction.classList.toggle('cab-fs-files-direction--desc', !ascending);
    direction.title = ascending
      ? t('cabina.archivos.switchDescending', 'Cambiar a descendente')
      : t('cabina.archivos.switchAscending', 'Cambiar a ascendente');
    direction.setAttribute('aria-label', direction.title);
  }
  for (const button of host.querySelectorAll('[data-action="set-view"]')) {
    const active = button.dataset.view === viewMode;
    button.classList.toggle('cab-fs-files-view-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function selectedEntry() {
  return selectedName ? entries.find((entry) => entry.name === selectedName) || null : null;
}

function renderSelectionActions() {
  const actions = host?.querySelector('[data-selection-actions]');
  if (!actions) return;
  const entry = selectedEntry();
  if (!entry) {
    selectedName = null;
    actions.hidden = true;
    actions.style.display = 'none';
    actions.innerHTML = '';
    return;
  }
  const downloadLabel = entry.type === 'dir'
    ? t('cabina.archivos.downloadZip', 'Descargar .zip')
    : t('cabina.archivos.download', 'Descargar');
  actions.hidden = false;
  actions.style.removeProperty('display');
  actions.innerHTML = `
    <span class="cab-status-chip">${escapeHtml(t('cabina.archivos.selected', 'Seleccionado: {name}', { name: entry.name }))}</span>
    <button class="cab-btn cab-btn--cold" type="button" data-action="open-entry">${icon(entry.type === 'dir' ? 'folder' : 'eye')} ${t('cabina.archivos.open', 'Abrir')}</button>
    <button class="cab-btn cab-btn--cold" type="button" data-action="download-entry">${icon('download')} ${downloadLabel}</button>
    <button class="cab-btn cab-btn--cold" type="button" data-action="rename-entry">${icon('edit')} ${t('cabina.archivos.rename', 'Cambiar el nombre')}</button>
    <button class="cab-btn cab-btn--cold" type="button" data-action="trash-entry" style="color:var(--cwc-danger);">${icon('trash')} ${t('cabina.archivos.moveToTrash', 'Mover a la papelera')}</button>`;
}

function entryIcon(entry) {
  const color = entry.type === 'dir' ? 'var(--cwc-folder)' : `var(--cwc-cat-${categoryOf(entry.name)})`;
  const category = categoryOf(entry.name);
  const iconName = entry.type === 'dir'
    ? 'folder'
    : category === 'archive'
      ? 'archive'
      : ['code', 'pdf', 'doc'].includes(category) ? 'docMode' : 'fileGeneric';
  const empty = entry.type === 'dir' && directoryCount(entry) === 0 ? ' cab-fs-files-icon--empty' : '';
  return `<span class="cab-fs-icon cab-fs-files-icon cab-fs-files-icon--${entry.type === 'dir' ? 'folder' : category}${empty}" aria-hidden="true" style="color:${color};">${icon(iconName)}</span>`;
}

function rowHtml(entry, index) {
  const active = entry.name === selectedName ? ' cab-fs-item--active' : '';
  const count = entry.type === 'dir' ? directoryCountLabel(entry) : '';
  const kind = typeLabel(entry);
  const size = entry.type === 'file' ? formatSize(entry.size) : (count || '');
  const link = entry.symlink === true
    ? `<span class="cab-fs-files-link" title="${t('cabina.archivos.linkDescription', 'Este elemento es un enlace')}">${icon('externalLink')} ${t('cabina.archivos.linkType', 'Enlace')}</span>`
    : '';
  return `
    <div class="cab-fs-item${active}" data-entry-row data-index="${index}"
      aria-selected="${entry.name === selectedName}" tabindex="-1" title="${escapeHtml(entryMeta(entry))}">
      <button class="cab-fs-item-main" type="button" data-select-entry
        aria-label="${escapeHtml(t('cabina.archivos.selectEntry', 'Seleccionar {name}. {meta}', { name: entry.name, meta: entryMeta(entry) }))}">
        ${entryIcon(entry)}
        <span class="cab-fs-item-copy">
          <span class="cab-fs-item-name">${escapeHtml(entry.name)}</span>
          <span class="cab-fs-item-meta">${escapeHtml(kind)}${link}</span>
        </span>
        <span class="cab-fs-files-property cab-fs-files-property--size">${escapeHtml(size)}</span>
        <span class="cab-fs-files-property cab-fs-files-property--date">${escapeHtml(formatDate(entry.mtimeMs))}</span>
      </button>
      <button class="cab-fs-more" type="button" data-action="show-menu" data-index="${index}"
        aria-label="${escapeHtml(t('cabina.archivos.moreActionsFor', 'Más acciones para {name}', { name: entry.name }))}" aria-haspopup="menu" aria-expanded="false" title="${t('cabina.archivos.moreActions', 'Más acciones')}">${icon('more')}</button>
    </div>`;
}

function renderList() {
  const list = host.querySelector('[data-file-list]');
  const count = host.querySelector('[data-count]');
  count.textContent = entries.length === 1
    ? t('cabina.archivos.itemCountOne', '{count} elemento', { count: entries.length })
    : t('cabina.archivos.itemCountMany', '{count} elementos', { count: entries.length });
  renderLocation();
  renderToolbar();
  renderSelectionActions();
  list.classList.toggle('cab-fs-files-list', viewMode === 'list');
  list.classList.toggle('cab-fs-files-grid', viewMode === 'grid');

  if (!entries.length) {
    list.innerHTML = `
      <div class="cab-fs-empty">
        <span class="cab-summary-title">${t('cabina.archivos.emptyFolder', 'Esta carpeta está vacía')}</span>
        <span class="cab-summary-meta">${t('cabina.archivos.emptyFolderHint', 'Podés arrastrar archivos acá, subirlos con el botón o crear una carpeta.')}</span>
      </div>`;
    return;
  }

  const header = viewMode === 'list' ? `
    <div class="cab-fs-files-list-head" aria-hidden="true">
      <span>${t('cabina.archivos.nameColumn', 'Nombre')}</span><span>${t('cabina.archivos.sizeOrContentColumn', 'Tamaño o contenido')}</span><span>${t('cabina.archivos.modifiedColumn', 'Modificación')}</span><span></span>
    </div>` : '';
  list.innerHTML = header + entries.map(rowHtml).join('');
}

function renderLoading() {
  host.querySelector('[data-file-list]').innerHTML = `
    <div class="cab-fs-empty" role="status">
      <span class="cab-summary-title">${t('cabina.archivos.loadingFiles', 'Cargando archivos…')}</span>
      <span class="cab-summary-meta">${t('cabina.archivos.waitMoment', 'Un momento.')}</span>
    </div>`;
}

function renderError(message) {
  host.querySelector('[data-file-list]').innerHTML = `
    <div class="cab-fs-empty" role="alert">
      <span class="cab-summary-title">${t('cabina.archivos.openFolderError', 'No pudimos abrir esta carpeta')}</span>
      <span class="cab-summary-meta">${escapeHtml(message)}</span>
      <div class="cab-composer-actions">
        <button class="cab-btn cab-btn--cold" type="button" data-action="refresh">${icon('refresh')} ${t('cabina.archivos.tryAgain', 'Intentar de nuevo')}</button>
      </div>
    </div>`;
}

function sortEntries(list) {
  return [...list].sort((left, right) => {
    const leftDirectory = left.type === 'dir';
    const rightDirectory = right.type === 'dir';
    if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
    let comparison = 0;
    if (sortField === 'size') {
      const leftSize = left.type === 'dir' ? directoryCount(left) : left.size;
      const rightSize = right.type === 'dir' ? directoryCount(right) : right.size;
      if (Number.isFinite(leftSize) && Number.isFinite(rightSize)) comparison = leftSize - rightSize;
      else if (Number.isFinite(leftSize)) comparison = -1;
      else if (Number.isFinite(rightSize)) comparison = 1;
    } else if (sortField === 'date') {
      comparison = (Number(left.mtimeMs) || 0) - (Number(right.mtimeMs) || 0);
    }
    if (comparison === 0) comparison = left.name.localeCompare(right.name, 'es', { sensitivity: 'base' });
    return sortDirection === 'asc' ? comparison : -comparison;
  });
}

async function load(path = currentPath) {
  const sequence = ++loadSequence;
  currentPath = path;
  selectedName = null;
  previewSequence += 1;
  closeMenu();
  clearDropTarget();
  renderLocation();
  renderSelectionActions();
  closePreview();
  renderLoading();
  try {
    const data = await context.api.get(`${FILES_API}/list?path=${encodeURIComponent(currentPath)}`);
    if (!host || sequence !== loadSequence) return;
    currentPath = typeof data.path === 'string' ? data.path : currentPath;
    entries = sortEntries(Array.isArray(data.entries) ? data.entries : []);
    renderList();
  } catch (error) {
    if (!host || sequence !== loadSequence) return;
    entries = [];
    renderError(error.message || t('cabina.archivos.unexpectedError', 'Ocurrió un error inesperado.'));
  }
}

function previewShell(entry, message) {
  const preview = host.querySelector('[data-preview]');
  const downloadLabel = entry.type === 'dir'
    ? t('cabina.archivos.downloadZip', 'Descargar .zip')
    : t('cabina.archivos.download', 'Descargar');
  const openLabel = entry.type === 'dir'
    ? t('cabina.archivos.openFolder', 'Abrir carpeta')
    : t('cabina.archivos.open', 'Abrir');
  preview.innerHTML = `
    <section class="cab-fs-files-preview-card" aria-labelledby="cab-preview-title">
      <header class="cab-fs-files-preview-head">
        ${entryIcon(entry)}
        <div class="cab-fs-files-preview-heading">
          <span class="cab-summary-title" id="cab-preview-title">${escapeHtml(entry.name)}</span>
          <span class="cab-summary-meta">${escapeHtml(typeLabel(entry))}</span>
        </div>
        <button class="cab-btn cab-btn--cold cab-fs-files-preview-close" type="button" data-action="close-preview" aria-label="${t('cabina.archivos.closePanel', 'Cerrar panel')}" title="${t('cabina.archivos.close', 'Cerrar')}">${icon('close')}</button>
      </header>
      <dl class="cab-fs-files-details">
        ${entry.type === 'file' ? `<div><dt>${t('cabina.archivos.size', 'Tamaño')}</dt><dd>${escapeHtml(formatSize(entry.size))}</dd></div>` : ''}
        ${entry.type === 'dir' && directoryCountLabel(entry) ? `<div><dt>${t('cabina.archivos.content', 'Contenido')}</dt><dd>${escapeHtml(directoryCountLabel(entry))}</dd></div>` : ''}
        <div><dt>${t('cabina.archivos.modified', 'Modificación')}</dt><dd>${escapeHtml(formatDate(entry.mtimeMs))}</dd></div>
        ${entry.symlink === true ? `<div><dt>${t('cabina.archivos.type', 'Tipo')}</dt><dd>${icon('externalLink')} ${t('cabina.archivos.linkType', 'Enlace')}</dd></div>` : ''}
      </dl>
      <div class="cab-fs-files-preview-actions">
        <button class="cab-btn cab-btn--cold" type="button" data-action="open-preview">${icon(entry.type === 'dir' ? 'folder' : 'externalLink')} ${openLabel}</button>
        <button class="cab-btn cab-btn--cold" type="button" data-action="download-preview">${icon('download')} ${downloadLabel}</button>
      </div>
      <div class="cab-fs-files-preview-body" data-preview-body role="status">${escapeHtml(message)}</div>
    </section>`;
}

function closePreview() {
  const preview = host?.querySelector('[data-preview]');
  if (preview) {
    preview.innerHTML = `
      <div class="cab-fs-files-preview-placeholder">
        ${icon('eye')}
        <span>${t('cabina.archivos.selectForPreview', 'Seleccioná un elemento para ver sus propiedades y su vista previa.')}</span>
      </div>`;
  }
  previewedEntry = null;
}

async function previewEntry(entry) {
  const sequence = ++previewSequence;
  const path = joinPath(currentPath, entry.name);
  previewedEntry = entry;
  const isDirectory = entry.type === 'dir';
  previewShell(entry, isDirectory
    ? t('cabina.archivos.openFolderForContent', 'Abrí la carpeta para ver su contenido.')
    : t('cabina.archivos.preparingPreview', 'Preparando vista previa…'));
  const body = host.querySelector('[data-preview-body]');

  if (isDirectory || entry.type !== 'file') return;

  const extension = extensionOf(entry.name);
  if (IMAGE_EXTENSIONS.has(extension)) {
    const button = document.createElement('button');
    button.className = 'cab-fs-files-image-button';
    button.type = 'button';
    button.dataset.action = 'zoom-preview';
    button.title = t('cabina.archivos.enlargeImage', 'Ampliar imagen');
    button.setAttribute('aria-label', t('cabina.archivos.enlargeNamed', 'Ampliar {name}', { name: entry.name }));
    const image = document.createElement('img');
    image.className = 'cab-fs-files-preview-image';
    image.src = `${FILES_API}/raw?path=${encodeURIComponent(path)}`;
    image.alt = t('cabina.archivos.previewOf', 'Vista previa de {name}', { name: entry.name });
    image.loading = 'lazy';
    image.addEventListener('error', () => {
      if (button.isConnected) body.textContent = t('cabina.archivos.imagePreviewError', 'No se pudo mostrar la imagen. Podés descargarla.');
    }, { once: true });
    button.appendChild(image);
    body.replaceChildren(button);
    return;
  }

  if (extension === 'pdf') {
    const frame = document.createElement('iframe');
    frame.src = `${FILES_API}/raw?path=${encodeURIComponent(path)}`;
    frame.title = t('cabina.archivos.previewOf', 'Vista previa de {name}', { name: entry.name });
    frame.className = 'cab-fs-files-preview-frame';
    frame.loading = 'lazy';
    body.replaceChildren(frame);
    return;
  }

  try {
    const data = await context.api.get(`${FILES_API}/read?path=${encodeURIComponent(path)}`);
    if (!host || sequence !== previewSequence) return;
    body.replaceChildren();
    if (data.binary) {
      body.textContent = t('cabina.archivos.binaryPreviewUnavailable', 'Este archivo no se puede mostrar acá. Podés descargarlo.');
      return;
    }
    if (data.tooLarge) {
      body.textContent = t('cabina.archivos.fileTooLarge', 'Este archivo es demasiado grande para mostrarlo acá. Podés descargarlo.');
      return;
    }
    const text = document.createElement('pre');
    text.className = 'cab-fs-files-preview-text';
    text.setAttribute('aria-label', t('cabina.archivos.contentOf', 'Contenido de {name}', { name: entry.name }));
    text.textContent = typeof data.content === 'string' ? data.content : '';
    body.appendChild(text);
  } catch (error) {
    if (!host || sequence !== previewSequence) return;
    const message = error.message || t('cabina.archivos.filePreviewError', 'No se pudo mostrar el archivo.');
    body.textContent = t('cabina.archivos.downloadSuggestion', '{message} Podés descargarlo.', { message });
  }
}

function openRawEntry(entry) {
  if (!entry) return;
  if (entry.type === 'dir') {
    load(joinPath(currentPath, entry.name));
    return;
  }
  const path = joinPath(currentPath, entry.name);
  window.open(`${FILES_API}/raw?path=${encodeURIComponent(path)}`, '_blank', 'noopener');
}

function zoomPreviewImage() {
  const image = host?.querySelector('.cab-fs-files-preview-image');
  if (!image || !previewedEntry) return;
  const zoomImage = image.cloneNode();
  zoomImage.className = 'cab-chat-zoom-image';
  zoomImage.alt = image.alt;
  zoomImage.loading = 'eager';
  if (image.naturalWidth > 0 && image.naturalHeight > 0) {
    zoomImage.width = image.naturalWidth;
    zoomImage.height = image.naturalHeight;
  }
  openZoomViewer({ title: previewedEntry.name, node: zoomImage });
}

function openEntry(entry) {
  if (!entry) return;
  if (entry.type === 'dir') load(joinPath(currentPath, entry.name));
  else if (entry.type === 'file') previewEntry(entry);
}

function downloadEntry(entry) {
  if (!entry) return;
  const path = joinPath(currentPath, entry.name);
  const endpoint = entry.type === 'dir' ? 'download-zip' : 'download';
  const link = document.createElement('a');
  link.href = `${FILES_API}/${endpoint}?path=${encodeURIComponent(path)}`;
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function createFolder() {
  const mountedContext = context;
  const destination = currentPath;
  const requested = window.prompt(t('cabina.archivos.newFolderPrompt', 'Nombre de la nueva carpeta:'));
  if (requested === null) return;
  const name = requested.trim();
  if (!name) {
    mountedContext.toast(t('cabina.archivos.folderNameRequired', 'Escribí un nombre para la carpeta.'));
    return;
  }
  try {
    await mountedContext.api.post(`${FILES_API}/mkdir`, { path: destination, name });
    mountedContext.toast(t('cabina.archivos.folderCreated', 'Carpeta “{name}” creada.', { name }));
    if (context === mountedContext && currentPath === destination) await load();
  } catch (error) {
    mountedContext.toast(error.message || t('cabina.archivos.createFolderError', 'No se pudo crear la carpeta.'));
  }
}

async function renameEntry(entry) {
  if (!entry) return;
  const mountedContext = context;
  const sourceFolder = currentPath;
  const requested = window.prompt(t('cabina.archivos.renamePrompt', 'Nuevo nombre para “{name}”:', { name: entry.name }), entry.name);
  if (requested === null) return;
  const newName = requested.trim();
  if (!newName) {
    mountedContext.toast(t('cabina.archivos.nameRequired', 'Escribí un nombre.'));
    return;
  }
  if (newName === entry.name) return;
  try {
    await mountedContext.api.post(`${FILES_API}/rename`, {
      path: joinPath(sourceFolder, entry.name),
      newName,
    });
    mountedContext.toast(t('cabina.archivos.renamed', '“{oldName}” ahora se llama “{newName}”.', { oldName: entry.name, newName }));
    if (context === mountedContext && currentPath === sourceFolder) await load();
  } catch (error) {
    mountedContext.toast(error.message || t('cabina.archivos.renameError', 'No se pudo cambiar el nombre.'));
  }
}

async function trashEntry(entry) {
  if (!entry) return;
  const confirmed = window.confirm(t('cabina.archivos.trashConfirm', '¿Mandar “{name}” a la papelera?', { name: entry.name }));
  if (!confirmed) return;
  const mountedContext = context;
  const sourceFolder = currentPath;
  try {
    await mountedContext.api.post(`${FILES_API}/trash`, { path: joinPath(sourceFolder, entry.name) });
    mountedContext.toast(t('cabina.archivos.trashed', '“{name}” está en la papelera.', { name: entry.name }));
    if (context === mountedContext && currentPath === sourceFolder) await load();
  } catch (error) {
    mountedContext.toast(error.message || t('cabina.archivos.trashError', 'No se pudo mandar a la papelera.'));
  }
}

async function uploadFiles(fileList, destination = currentPath, destinationLabel = '') {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const mountedContext = context;
  const viewedPath = currentPath;
  const form = new FormData();
  for (const file of files) form.append('files', file);
  try {
    const response = await fetch(`${FILES_API}/upload?path=${encodeURIComponent(destination)}`, {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      // El error HTTP de respaldo se muestra debajo.
    }
    if (!response.ok) throw new Error(data.error || t('cabina.archivos.uploadHttpError', 'No se pudieron subir los archivos (HTTP {status}).', { status: response.status }));
    const count = Number(data.count) || files.length;
    const where = destinationLabel
      ? t('cabina.archivos.uploadDestination', ' a “{destination}”', { destination: destinationLabel })
      : '';
    mountedContext.toast(count === 1
      ? t('cabina.archivos.uploadedOne', '{count} archivo subido{where}.', { count, where })
      : t('cabina.archivos.uploadedMany', '{count} archivos subidos{where}.', { count, where }));
    if (context === mountedContext && currentPath === viewedPath) await load();
  } catch (error) {
    mountedContext.toast(error.message || t('cabina.archivos.uploadError', 'No se pudieron subir los archivos.'));
  }
}

function entryFromTarget(target) {
  const indexed = target.closest('[data-index]');
  if (!indexed) return null;
  const index = Number(indexed.dataset.index);
  return Number.isInteger(index) ? entries[index] || null : null;
}

function selectEntry(entry) {
  selectedName = entry?.name || null;
  closeMenu();
  for (const row of host.querySelectorAll('[data-entry-row]')) {
    const rowEntry = entryFromTarget(row);
    const active = rowEntry?.name === selectedName;
    row.classList.toggle('cab-fs-item--active', active);
    row.setAttribute('aria-selected', String(active));
  }
  renderSelectionActions();
  if (entry) previewEntry(entry);
  else closePreview();
}

function entryForAction(trigger) {
  const indexedEntry = entryFromTarget(trigger);
  if (indexedEntry) return indexedEntry;
  if (trigger.closest('[data-file-menu]') && menuEntryName) {
    return entries.find((entry) => entry.name === menuEntryName) || null;
  }
  return selectedEntry();
}

function closeMenu(restoreFocus = false) {
  const menu = host?.querySelector('[data-file-menu]');
  if (menu) {
    menu.hidden = true;
    menu.style.display = 'none';
    menu.innerHTML = '';
  }
  for (const button of host?.querySelectorAll('[data-action="show-menu"]') || []) {
    button.setAttribute('aria-expanded', 'false');
  }
  const focusTarget = menuReturnFocus;
  menuEntryName = null;
  menuReturnFocus = null;
  if (restoreFocus && focusTarget?.isConnected) focusTarget.focus();
}

function menuItems(entry) {
  const downloadLabel = entry.type === 'dir'
    ? t('cabina.archivos.downloadAsZip', 'Descargar como .zip')
    : t('cabina.archivos.download', 'Descargar');
  return `
    <button class="cab-fs-menu-item" type="button" role="menuitem" data-action="open-entry">${icon(entry.type === 'dir' ? 'folder' : 'eye')} ${t('cabina.archivos.open', 'Abrir')}</button>
    <button class="cab-fs-menu-item" type="button" role="menuitem" data-action="download-entry">${icon('download')} ${downloadLabel}</button>
    <button class="cab-fs-menu-item" type="button" role="menuitem" data-action="rename-entry">${icon('edit')} ${t('cabina.archivos.rename', 'Cambiar el nombre')}</button>
    <button class="cab-fs-menu-item cab-fs-menu-item--danger" type="button" role="menuitem" data-action="trash-entry">${icon('trash')} ${t('cabina.archivos.moveToTrash', 'Mover a la papelera')}</button>`;
}

function showMenu(entry, point, returnFocus = null) {
  if (!entry) return;
  closeMenu();
  const menu = host.querySelector('[data-file-menu]');
  menuEntryName = entry.name;
  menuReturnFocus = returnFocus;
  menu.innerHTML = menuItems(entry);
  menu.hidden = false;
  menu.style.removeProperty('display');
  const bounds = menu.getBoundingClientRect();
  const gutter = 8;
  const left = Math.max(gutter, Math.min(point.x, window.innerWidth - bounds.width - gutter));
  const top = Math.max(gutter, Math.min(point.y, window.innerHeight - bounds.height - gutter));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  if (returnFocus?.matches('[data-action="show-menu"]')) returnFocus.setAttribute('aria-expanded', 'true');
  menu.querySelector('[role="menuitem"]')?.focus();
}

function showMenuFromButton(button, entry) {
  const bounds = button.getBoundingClientRect();
  showMenu(entry, { x: bounds.right - 210, y: bounds.bottom + 4 }, button);
}

function handleClick(event) {
  const trigger = event.target.closest('[data-action]');
  if (trigger && host.contains(trigger)) {
    const action = trigger.dataset.action;
    const entry = entryForAction(trigger);

    if (action === 'navigate') load(trigger.dataset.path || '');
    else if (action === 'back') load(parentPath(currentPath));
    else if (action === 'refresh') load();
    else if (action === 'mkdir') createFolder();
    else if (action === 'choose-upload') host.querySelector('[data-upload-input]').click();
    else if (action === 'set-view') {
      viewMode = trigger.dataset.view === 'grid' ? 'grid' : 'list';
      storePreference(VIEW_STORAGE_KEY, viewMode);
      renderList();
    } else if (action === 'toggle-sort-direction') {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      storePreference(SORT_DIRECTION_STORAGE_KEY, sortDirection);
      entries = sortEntries(entries);
      renderList();
    } else if (action === 'show-menu' && entry) {
      selectEntry(entry);
      showMenuFromButton(trigger, entry);
    } else if (action === 'open-entry' && entry) {
      closeMenu();
      openEntry(entry);
    } else if (action === 'download-entry' && entry) {
      closeMenu();
      downloadEntry(entry);
    } else if (action === 'rename-entry' && entry) {
      closeMenu();
      renameEntry(entry);
    } else if (action === 'trash-entry' && entry) {
      closeMenu();
      trashEntry(entry);
    } else if (action === 'download-preview') {
      if (previewedEntry) downloadEntry(previewedEntry);
    } else if (action === 'open-preview') {
      if (previewedEntry) openRawEntry(previewedEntry);
    } else if (action === 'zoom-preview') {
      zoomPreviewImage();
    } else if (action === 'close-preview') {
      previewSequence += 1;
      closePreview();
    }
    return;
  }

  const row = event.target.closest('[data-entry-row]');
  if (row && host.contains(row)) selectEntry(entryFromTarget(row));
}

function handleDoubleClick(event) {
  if (event.target.closest('[data-action="show-menu"]')) return;
  const row = event.target.closest('[data-entry-row]');
  if (!row || !host.contains(row)) return;
  const entry = entryFromTarget(row);
  if (entry?.type === 'dir') openEntry(entry);
  else selectEntry(entry);
}

function handleContextMenu(event) {
  const row = event.target.closest('[data-entry-row]');
  if (!row || !host.contains(row)) return;
  event.preventDefault();
  const entry = entryFromTarget(row);
  selectEntry(entry);
  showMenu(entry, { x: event.clientX, y: event.clientY }, row);
}

function handleKeydown(event) {
  if (event.key === 'Escape' && menuEntryName) {
    event.preventDefault();
    closeMenu(true);
    return;
  }
  const row = event.target.closest('[data-entry-row]');
  if (!row || !host.contains(row)) return;
  const entry = entryFromTarget(row);
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault();
    selectEntry(entry);
    const bounds = row.getBoundingClientRect();
    showMenu(entry, { x: bounds.left + 24, y: bounds.top + 24 }, event.target);
  } else if (event.target.closest('button')) {
    return;
  } else if (event.key === 'Enter') {
    event.preventDefault();
    selectEntry(entry);
    openEntry(entry);
  } else if (event.key === ' ') {
    event.preventDefault();
    selectEntry(entry);
  }
}

function handleViewportChange() {
  closeMenu();
}

function handleChange(event) {
  if (event.target.matches('[data-upload-input]')) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    uploadFiles(files);
    return;
  }
  if (event.target.matches('[data-sort-field]')) {
    sortField = ['name', 'size', 'date'].includes(event.target.value) ? event.target.value : 'name';
    storePreference(SORT_STORAGE_KEY, sortField);
    entries = sortEntries(entries);
    renderList();
  }
}

function dragHasFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}

function dropFolderFromEvent(event) {
  const row = event.target.closest('[data-entry-row]');
  if (!row || !host.contains(row)) return null;
  const entry = entryFromTarget(row);
  return entry?.type === 'dir' ? { row, entry } : null;
}

function clearDropTarget() {
  if (!host) return;
  for (const element of host.querySelectorAll('.cab-fs-dragover')) {
    element.classList.remove('cab-fs-dragover');
  }
  const message = host.querySelector('[data-drop-message]');
  if (message) message.hidden = true;
}

function markDropTarget(folderTarget) {
  clearDropTarget();
  const list = host.querySelector('[data-file-list]');
  const message = host.querySelector('[data-drop-message]');
  const target = folderTarget?.row || list;
  target?.classList.add('cab-fs-dragover');
  if (message) {
    message.hidden = false;
    message.textContent = folderTarget
      ? t('cabina.archivos.dropInNamedFolder', 'Soltá los archivos para subirlos a “{name}”.', { name: folderTarget.entry.name })
      : t('cabina.archivos.dropInFolder', 'Soltá los archivos para subirlos a esta carpeta.');
  }
}

function handleDragEnter(event) {
  if (!dragHasFiles(event)) return;
  event.preventDefault();
  markDropTarget(dropFolderFromEvent(event));
}

function handleDragOver(event) {
  if (!dragHasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  markDropTarget(dropFolderFromEvent(event));
}

function handleDragLeave(event) {
  if (event.relatedTarget && host.contains(event.relatedTarget)) return;
  clearDropTarget();
}

function handleDrop(event) {
  if (!dragHasFiles(event)) return;
  event.preventDefault();
  const folderTarget = dropFolderFromEvent(event);
  const files = event.dataTransfer?.files;
  const destination = folderTarget ? joinPath(currentPath, folderTarget.entry.name) : currentPath;
  const destinationLabel = folderTarget?.entry.name || '';
  clearDropTarget();
  uploadFiles(files, destination, destinationLabel);
}

function handleDocumentPointerDown(event) {
  if (!menuEntryName || !host) return;
  if (event.target.closest('[data-file-menu], [data-action="show-menu"]')) return;
  closeMenu();
}

function teardown() {
  listeners?.abort();
  listeners = null;
  loadSequence += 1;
  previewSequence += 1;
  closeMenu();
  host = null;
  context = null;
  entries = [];
  selectedName = null;
  previewedEntry = null;
  menuEntryName = null;
  menuReturnFocus = null;
  currentPath = '';
}

export default {
  name: 'archivos',

  async mount(el, ctx) {
    teardown();
    host = el;
    context = ctx;
    currentPath = '';
    entries = [];
    viewMode = storedPreference(VIEW_STORAGE_KEY, ['list', 'grid'], 'list');
    sortField = storedPreference(SORT_STORAGE_KEY, ['name', 'size', 'date'], 'name');
    sortDirection = storedPreference(SORT_DIRECTION_STORAGE_KEY, ['asc', 'desc'], 'asc');
    listeners = new AbortController();
    const options = { signal: listeners.signal };
    host.addEventListener('click', handleClick, options);
    host.addEventListener('dblclick', handleDoubleClick, options);
    host.addEventListener('contextmenu', handleContextMenu, options);
    host.addEventListener('keydown', handleKeydown, options);
    host.addEventListener('change', handleChange, options);
    host.addEventListener('dragenter', handleDragEnter, options);
    host.addEventListener('dragover', handleDragOver, options);
    host.addEventListener('dragleave', handleDragLeave, options);
    host.addEventListener('drop', handleDrop, options);
    document.addEventListener('pointerdown', handleDocumentPointerDown, { capture: true, signal: listeners.signal });
    window.addEventListener('resize', handleViewportChange, options);
    window.addEventListener('scroll', handleViewportChange, { capture: true, signal: listeners.signal });
    renderFrame();
    await load();
  },

  unmount() {
    teardown();
  },
};
