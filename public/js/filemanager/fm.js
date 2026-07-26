// filemanager/fm.js — Explorador (gestor de archivos estilo Finder).
import { icon, hydrateIcons } from '../ui/icons.js';
import { confirmDialog, promptDialog, alertDialog } from '../ui/dialog.js';
import { dismissablePopup } from '../ui/popup.js';
import { bindHelp, helpBtn } from '../ui/help.js';

const API = '/api/files';

// ¿Estamos embebidos como ventana flotante dentro de la consola?
const EMBEDDED = window.parent !== window;

// Crea una sesión (Claude o terminal) en una carpeta y vuelve a la consola
// con esa pestaña enfocada. Resuelve el flujo "abrir Claude en carpeta nueva".
// Embebido: avisamos al shell por postMessage (cierra la ventana y enfoca la
// sesión). Página directa: navegamos con /?focus=<id> como siempre.
async function sessionHere(rel, runClaude) {
  try {
    const res = await fetch('/api/terminal/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: rel, runClaude }),
    });
    if (!res.ok) throw new Error('No se pudo crear la sesión.');
    const { session } = await res.json();
    if (EMBEDDED) window.parent.postMessage({ type: 'cwc-session', id: session.id }, location.origin);
    else location.href = `/?focus=${encodeURIComponent(session.id)}`;
  } catch (e) {
    alertDialog({ title: 'Nueva sesión', message: e.message });
  }
}

// Extensión -> lenguaje de highlight.js (para el resaltado del preview de texto).
const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  json: 'json', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini',
  md: 'markdown', html: 'xml', xml: 'xml', css: 'css', scss: 'scss',
  sql: 'sql', php: 'php', dockerfile: 'dockerfile',
};
function langFor(name) {
  const base = name.toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return EXT_LANG[ext] || null;
}

const state = {
  cwd: '',            // ruta relativa al home
  view: 'grid',       // 'grid' | 'list'
  mode: 'files',      // 'files' | 'trash'
  entries: [],
  _rendered: [],        // entries YA ordenadas, en el orden real que ve el usuario (grilla o lista)
  sort: { key: 'mtimeMs', dir: 'desc' }, // orden por defecto: más reciente primero
  selection: new Set(), // nombres seleccionados (multi)
  anchor: null,         // ancla para selección por rango (shift)
  projectRel: 'tolkien',
  projectName: 'tolkien',
};

const $ = (id) => document.getElementById(id);
const itemsEl = $('fm-items');
const crumbsEl = $('fm-crumbs');
const ctxEl = $('fm-ctx');
let ctxDismiss = null; // teardown del menú contextual activo (popup descartable)

// ---------- categorías / iconos ----------
// Los colores viven en tokens.css (--cwc-cat-*); acá solo la key semántica.
// Estos dos SVG son miniaturas RELLENAS a dos tonos (carpeta/archivo), no
// íconos de trazo: por eso no salen de ui/icons.js. Los fills van por
// `style` con var() (los atributos de presentación SVG no aceptan var()).
const CATS = {
  image: { ext: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'avif'] },
  video: { ext: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v'] },
  audio: { ext: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'] },
  archive: { ext: ['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2', 'xz'] },
  code: { ext: ['js', 'mjs', 'ts', 'tsx', 'jsx', 'json', 'py', 'go', 'rs', 'c', 'cpp', 'h', 'java', 'rb', 'php', 'sh', 'html', 'css', 'scss', 'yml', 'yaml', 'toml', 'sql'] },
  pdf: { ext: ['pdf'] },
  doc: { ext: ['txt', 'md', 'doc', 'docx', 'rtf', 'csv', 'xls', 'xlsx', 'ppt', 'pptx'] },
};
function catOf(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  for (const [cat, def] of Object.entries(CATS)) if (def.ext.includes(ext)) return { cat, color: `var(--cwc-cat-${cat})`, ext };
  return { cat: 'file', color: 'var(--cwc-cat-file)', ext };
}
function folderSVG() {
  return `<svg viewBox="0 0 48 40" class="fm-ic"><path d="M3 9a4 4 0 0 1 4-4h11l4 4h19a4 4 0 0 1 4 4v20a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z" style="fill:var(--cwc-folder)"/><path d="M3 12h42v21a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z" style="fill:var(--cwc-folder-light)"/></svg>`;
}
function fileSVG(name) {
  const { color, ext } = catOf(name);
  return `<svg viewBox="0 0 40 48" class="fm-ic"><path d="M6 2h18l14 14v28a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" style="fill:${color}"/><path d="M24 2l14 14H26a2 2 0 0 1-2-2z" style="fill:color-mix(in srgb, var(--cwc-white) 30%, transparent)"/></svg>${ext ? `<span class="fm-ext">${ext.toUpperCase().slice(0, 4)}</span>` : ''}`;
}
function iconFor(entry) {
  return entry.type === 'dir' ? `<div class="fm-ic-wrap">${folderSVG()}</div>` : `<div class="fm-ic-wrap fm-ic-file">${fileSVG(entry.name)}</div>`;
}

// ---------- helpers ----------
function fmtSize(b) {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1; let n = b;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(1)} ${u[i]}`;
}
function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' ' + new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}
function kindOf(entry) {
  if (entry.type === 'dir') return 'Carpeta';
  const { ext } = catOf(entry.name);
  return ext ? `Documento ${ext.toUpperCase()}` : 'Archivo';
}
const join = (rel, name) => (rel ? `${rel}/${name}` : name);
const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

// ---------- orden ----------
// Carpetas siempre agrupadas arriba (convención de Explorador/Finder); dentro
// de cada grupo se aplica el criterio elegido por el usuario (o el de por
// defecto: más reciente primero). El mismo orden se usa en grilla Y lista.
function sortEntries(entries) {
  const { key, dir } = state.sort;
  const mul = dir === 'asc' ? 1 : -1;
  const val = (e) => {
    if (key === 'name') return e.name.toLowerCase();
    if (key === 'kind') return kindOf(e).toLowerCase();
    if (key === 'size') return e.size ?? -1;
    return e.mtimeMs || 0;
  };
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    const av = val(a); const bv = val(b);
    if (av < bv) return -1 * mul;
    if (av > bv) return 1 * mul;
    return a.name.localeCompare(b.name);
  });
}
function setSort(key) {
  if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  else { state.sort = { key, dir: key === 'name' ? 'asc' : 'desc' }; }
  render();
}
function sortArrow(key) {
  if (state.sort.key !== key) return '';
  return state.sort.dir === 'asc' ? ' ▲' : ' ▼';
}

// ---------- carga / render ----------
async function load() {
  hideCtx();
  state.selection.clear();
  state.anchor = null;
  if (state.mode === 'trash') return loadTrash();
  try {
    const res = await fetch(`${API}/list?path=${encodeURIComponent(state.cwd)}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    state.entries = data.entries;
    render();
  } catch {
    itemsEl.innerHTML = '<div class="fm-empty">No se pudo listar esta carpeta.</div>';
  }
}

function render() {
  renderCrumbs();
  itemsEl.className = state.view === 'grid' ? 'fm-grid' : 'fm-list';
  updateStatus();
  if (!state.entries.length) {
    itemsEl.innerHTML = '<div class="fm-empty">Carpeta vacía</div>';
    return;
  }
  const list = sortEntries(state.entries);
  state._rendered = list;
  itemsEl.innerHTML = state.view === 'grid' ? gridHTML(list) : listHTML(list);
  wireItems();
  wireSort();
}

function gridHTML(list) {
  return list.map((e) => `
    <div class="fm-item" data-name="${escAttr(e.name)}" data-type="${e.type}">
      ${iconFor(e)}
      <div class="fm-label">${escHtml(e.name)}</div>
    </div>`).join('');
}
const SORT_COLS = [['name', 'Nombre'], ['kind', 'Tipo'], ['size', 'Tamaño'], ['mtimeMs', 'Modificado']];
function listHTML(list) {
  const head = `<div class="fm-lrow fm-lhead">${SORT_COLS.map(([key, label]) =>
    `<span class="fm-sortable${state.sort.key === key ? ' fm-sort-active' : ''}" data-sort="${key}">${label}${sortArrow(key)}</span>`,
  ).join('')}</div>`;
  const rows = list.map((e) => `
    <div class="fm-lrow fm-item" data-name="${escAttr(e.name)}" data-type="${e.type}">
      <span class="fm-lname">${iconFor(e)}<span>${escHtml(e.name)}</span></span>
      <span>${kindOf(e)}</span>
      <span>${e.type === 'dir' ? '—' : fmtSize(e.size)}</span>
      <span>${fmtDate(e.mtimeMs)}</span>
    </div>`).join('');
  return head + rows;
}
function wireSort() {
  for (const el of itemsEl.querySelectorAll('.fm-sortable')) {
    el.addEventListener('click', () => setSort(el.dataset.sort));
  }
}

function wireItems() {
  for (const el of itemsEl.querySelectorAll('.fm-item')) {
    const name = el.dataset.name;
    const entry = state.entries.find((e) => e.name === name);
    el.addEventListener('click', (ev) => { ev.stopPropagation(); select(name, ev); });
    el.addEventListener('dblclick', () => open(entry));
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (!state.selection.has(name)) select(name, {}); // si no estaba, seleccionar solo este
      showCtx(ev, entry);
    });
  }
}

// Selección con modificadores: Cmd/Ctrl = alternar; Shift = rango; normal = uno.
function select(name, ev = {}) {
  const names = (state._rendered.length ? state._rendered : state.entries).map((e) => e.name);
  if (ev.shiftKey && state.anchor) {
    const a = names.indexOf(state.anchor);
    const b = names.indexOf(name);
    if (a >= 0 && b >= 0) {
      state.selection.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.selection.add(names[i]);
    }
  } else if (ev.metaKey || ev.ctrlKey) {
    if (state.selection.has(name)) state.selection.delete(name);
    else state.selection.add(name);
    state.anchor = name;
  } else {
    state.selection.clear();
    state.selection.add(name);
    state.anchor = name;
  }
  for (const el of itemsEl.querySelectorAll('.fm-item')) el.classList.toggle('selected', state.selection.has(el.dataset.name));
  updateStatus();
}

function entryByName(name) { return state.entries.find((e) => e.name === name); }

function open(entry) {
  if (!entry) return;
  if (entry.type === 'dir') { state.cwd = join(state.cwd, entry.name); load(); }
  else preview(entry);
}

function renderCrumbs() {
  const parts = state.cwd ? state.cwd.split('/') : [];
  let acc = '';
  const home = `<button class="fm-crumb" data-rel="">${icon('home')} Home</button>`;
  const rest = parts.map((p) => {
    acc = join(acc, p);
    return `<span class="fm-sep">${icon('chevronRight', { size: 13 })}</span><button class="fm-crumb" data-rel="${escAttr(acc)}">${escHtml(p)}</button>`;
  }).join('');
  crumbsEl.innerHTML = (state.mode === 'trash')
    ? `<button class="fm-crumb" data-rel="">${icon('trash')} Papelera</button>`
    : home + rest;
  for (const b of crumbsEl.querySelectorAll('.fm-crumb')) {
    b.addEventListener('click', () => { state.mode = 'files'; state.cwd = b.dataset.rel; load(); });
  }
}

function updateStatus() {
  $('fm-count').textContent = state.mode === 'trash'
    ? `${state.entries.length} en papelera`
    : `${state.entries.length} ítem${state.entries.length === 1 ? '' : 's'}`;
  const n = state.selection.size;
  if (n === 0) $('fm-sel').textContent = '';
  else if (n === 1) {
    const sel = entryByName([...state.selection][0]);
    $('fm-sel').textContent = sel ? `· ${sel.name}${sel.type === 'file' ? ` (${fmtSize(sel.size)})` : ''}` : '';
  } else $('fm-sel').textContent = `· ${n} seleccionados`;
}

// ---------- acciones ----------
function download(entry) {
  const rel = join(state.cwd, entry.name);
  const url = entry.type === 'dir'
    ? `${API}/download-zip?path=${encodeURIComponent(rel)}`
    : `${API}/download?path=${encodeURIComponent(rel)}`;
  const a = document.createElement('a');
  a.href = url; a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
}

async function mkdir() {
  const name = await promptDialog({ title: 'Nueva carpeta', placeholder: 'Nombre de la carpeta' });
  if (!name) return;
  const res = await fetch(`${API}/mkdir`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: state.cwd, name }),
  });
  if (!res.ok) alertDialog({ title: 'Nueva carpeta', message: (await res.json().catch(() => ({}))).error || 'No se pudo crear.' });
  load();
}

async function rename(entry) {
  const name = await promptDialog({ title: 'Renombrar', value: entry.name });
  if (!name || name === entry.name) return;
  const res = await fetch(`${API}/rename`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: join(state.cwd, entry.name), newName: name }),
  });
  if (!res.ok) alertDialog({ title: 'Renombrar', message: (await res.json().catch(() => ({}))).error || 'No se pudo renombrar.' });
  load();
}

async function trash(entry) {
  const ok = await confirmDialog({
    title: 'Mover a la papelera',
    message: `"${entry.name}" se conserva 30 días y se puede restaurar.`,
    confirmLabel: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  const res = await fetch(`${API}/trash`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: join(state.cwd, entry.name) }),
  });
  if (!res.ok) alertDialog({ title: 'Papelera', message: (await res.json().catch(() => ({}))).error || 'No se pudo eliminar.' });
  load(); refreshTrashCount();
}

async function uploadFiles(fileList) {
  if (!fileList || !fileList.length) return;
  const fd = new FormData();
  for (const f of fileList) fd.append('files', f);
  itemsEl.classList.add('fm-uploading');
  try {
    const res = await fetch(`${API}/upload?path=${encodeURIComponent(state.cwd)}`, { method: 'POST', body: fd });
    if (!res.ok) alertDialog({ title: 'Subida', message: (await res.json().catch(() => ({}))).error || 'Falló la subida.' });
  } catch { alertDialog({ title: 'Subida', message: 'Falló la subida.' }); }
  itemsEl.classList.remove('fm-uploading');
  load();
}

// ---------- selección múltiple ----------
async function downloadSelected() {
  const names = [...state.selection];
  if (!names.length) return;
  if (names.length === 1) return download(entryByName(names[0]));
  const paths = names.map((n) => join(state.cwd, n));
  try {
    const res = await fetch(`${API}/zip`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }),
    });
    if (!res.ok) return alertDialog({ title: 'Descarga', message: 'No se pudo generar el zip.' });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'archivos.zip';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch { alertDialog({ title: 'Descarga', message: 'No se pudo descargar la selección.' }); }
}

async function trashSelected() {
  const names = [...state.selection];
  if (!names.length) return;
  const ok = await confirmDialog({
    title: 'Mover a la papelera',
    message: `${names.length} ítem(s) se conservan 30 días y se pueden restaurar.`,
    confirmLabel: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  for (const n of names) {
    await fetch(`${API}/trash`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: join(state.cwd, n) }),
    });
  }
  load(); refreshTrashCount();
}

// ---------- previsualización ----------
let pvEntry = null;
function preview(entry) {
  const rel = join(state.cwd, entry.name);
  const raw = `${API}/raw?path=${encodeURIComponent(rel)}`;
  const { cat, ext } = catOf(entry.name);
  pvEntry = entry;
  $('fm-pv-title').textContent = entry.name;
  const body = $('fm-pv-body');
  $('fm-preview').hidden = false;

  if (cat === 'image') { body.innerHTML = `<img class="fm-pv-img" src="${raw}" alt="">`; return; }
  if (cat === 'video') { body.innerHTML = `<video class="fm-pv-media" src="${raw}" controls autoplay></video>`; return; }
  if (cat === 'audio') { body.innerHTML = `<audio class="fm-pv-audio" src="${raw}" controls autoplay></audio>`; return; }
  if (ext === 'pdf') { body.innerHTML = `<iframe class="fm-pv-frame" src="${raw}"></iframe>`; return; }

  // Resto: intentamos como texto, con resaltado de sintaxis (highlight.js).
  body.innerHTML = '<div class="cwc-loading"><span class="cwc-spinner"></span>cargando…</div>';
  fetch(`${API}/read?path=${encodeURIComponent(rel)}`)
    .then((r) => r.json())
    .then((data) => {
      if (data.binary) { body.innerHTML = '<div class="fm-pv-msg">Archivo binario — usá Descargar.</div>'; return; }
      if (data.tooLarge) { body.innerHTML = '<div class="fm-pv-msg">Archivo muy grande para previsualizar — usá Descargar.</div>'; return; }
      const pre = document.createElement('pre');
      pre.className = 'fm-pv-text';
      const hljs = window.hljs;
      const lang = langFor(entry.name);
      let html = null;
      if (hljs) {
        try {
          html = (lang && hljs.getLanguage(lang))
            ? hljs.highlight(data.content, { language: lang }).value
            : hljs.highlightAuto(data.content).value;
        } catch { /* caemos a texto plano */ }
      }
      if (html != null) { pre.classList.add('hljs'); pre.innerHTML = html; }
      else pre.textContent = data.content;
      body.innerHTML = '';
      body.appendChild(pre);
    })
    .catch(() => { body.innerHTML = '<div class="fm-pv-msg">No se pudo abrir.</div>'; });
}
function closePreview() {
  $('fm-preview').hidden = true;
  $('fm-pv-body').innerHTML = ''; // corta reproducción de video/audio
  pvEntry = null;
}

// ---------- papelera ----------
async function loadTrash() {
  renderCrumbs();
  try {
    const { items } = await (await fetch(`${API}/trash`)).json();
    state.entries = items;
    itemsEl.className = 'fm-list';
    updateStatus();
    if (!items.length) { itemsEl.innerHTML = '<div class="fm-empty">La papelera está vacía</div>'; return; }
    itemsEl.innerHTML =
      `<div class="fm-lrow fm-lhead"><span>Nombre</span><span>Eliminado</span><span>Se borra en</span><span></span></div>` +
      items.map((it) => `
        <div class="fm-lrow">
          <span class="fm-lname">${it.isDir ? folderSVG() : fileSVG(it.name)}<span>${escHtml(it.name)}</span></span>
          <span>${fmtDate(it.deletedAt)}</span>
          <span>${it.daysLeft} día${it.daysLeft === 1 ? '' : 's'}</span>
          <span class="fm-trash-actions">
            <button class="btn-ghost btn--sm" data-restore="${it.id}">Restaurar</button>
            <button class="btn-ghost btn--sm btn--danger" data-purge="${it.id}">Eliminar</button>
          </span>
        </div>`).join('');
    for (const b of itemsEl.querySelectorAll('[data-restore]')) b.addEventListener('click', () => restore(b.dataset.restore));
    for (const b of itemsEl.querySelectorAll('[data-purge]')) b.addEventListener('click', () => purge(b.dataset.purge));
  } catch { itemsEl.innerHTML = '<div class="fm-empty">No se pudo leer la papelera.</div>'; }
}
async function restore(id) {
  await fetch(`${API}/trash/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  loadTrash(); refreshTrashCount();
}
async function purge(id) {
  const ok = await confirmDialog({
    title: 'Eliminar definitivamente',
    message: 'Esto NO se puede deshacer.',
    confirmLabel: 'Eliminar',
    danger: true,
  });
  if (!ok) return;
  await fetch(`${API}/trash/purge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  loadTrash(); refreshTrashCount();
}
async function refreshTrashCount() {
  try {
    const { items } = await (await fetch(`${API}/trash`)).json();
    $('fm-trash-count').textContent = items.length || '';
  } catch { /* noop */ }
}

// ---------- menú contextual ----------
function showCtx(ev, entry) {
  const items = [];
  const multi = state.selection.size > 1;
  if (multi) {
    items.push([`Descargar ${state.selection.size} (.zip)`, downloadSelected]);
    items.push([`Eliminar ${state.selection.size}`, trashSelected, 'danger']);
  } else {
    if (entry.type === 'dir') {
      items.push(['Abrir', () => open(entry)]);
      items.push(['Nueva sesión de Claude aquí', () => sessionHere(join(state.cwd, entry.name), true)]);
      items.push(['Abrir terminal aquí', () => sessionHere(join(state.cwd, entry.name), false)]);
      items.push(['Descargar .zip', () => download(entry)]);
    } else {
      items.push(['Previsualizar', () => preview(entry)]);
      items.push(['Descargar', () => download(entry)]);
    }
    items.push(['Renombrar', () => rename(entry)]);
    items.push(['Eliminar', () => trash(entry), 'danger']);
  }
  ctxEl.innerHTML = items.map(([label, , cls]) => `<button class="${cls || ''}">${label}</button>`).join('');
  [...ctxEl.children].forEach((b, i) => b.addEventListener('click', () => { hideCtx(); items[i][1](); }));
  ctxEl.style.left = `${Math.min(ev.clientX, window.innerWidth - 180)}px`;
  ctxEl.style.top = `${Math.min(ev.clientY, window.innerHeight - 160)}px`;
  hideCtx(); // cierra un menú previo si lo había
  ctxEl.hidden = false;
  // Descartable ante pointerdown fuera / Esc / scroll / blur / resize.
  ctxDismiss = dismissablePopup(ctxEl, { onDismiss: () => { ctxEl.hidden = true; ctxDismiss = null; } });
}
function hideCtx() {
  if (ctxDismiss) { const d = ctxDismiss; ctxDismiss = null; d(); }
  ctxEl.hidden = true;
}

// ---------- escape ----------
function escHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function escAttr(s) { return escHtml(s).replace(/'/g, '&#39;'); }

// ---------- init / eventos ----------
function goPlace(place) {
  hideCtx();
  if (place === 'home') { state.mode = 'files'; state.cwd = ''; load(); }
  else if (place === 'project') { state.mode = 'files'; state.cwd = state.projectRel; load(); }
  else if (place === 'trash') { state.mode = 'trash'; load(); }
  for (const b of document.querySelectorAll('.fm-place')) b.classList.toggle('active', b.dataset.place === place);
}

function setView(v) {
  state.view = v;
  $('fm-view-grid').classList.toggle('active', v === 'grid');
  $('fm-view-list').classList.toggle('active', v === 'list');
  if (state.mode === 'files') render();
}

$('fm-back').addEventListener('click', () => { if (state.mode === 'files' && state.cwd) { state.cwd = parentOf(state.cwd); load(); } });
$('fm-refresh').addEventListener('click', () => load());
$('fm-view-grid').addEventListener('click', () => setView('grid'));
$('fm-view-list').addEventListener('click', () => setView('list'));
$('fm-mkdir').addEventListener('click', mkdir);
// Sesiones en la carpeta ACTUAL (la que se está viendo). No aplican en papelera.
$('fm-claude').addEventListener('click', () => { if (state.mode === 'files') sessionHere(state.cwd, true); });
$('fm-term').addEventListener('click', () => { if (state.mode === 'files') sessionHere(state.cwd, false); });
$('fm-upload').addEventListener('click', () => $('fm-file-input').click());
$('fm-file-input').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });
for (const b of document.querySelectorAll('.fm-place')) b.addEventListener('click', () => goPlace(b.dataset.place));

// Previsualización: cerrar (botón, click en el fondo, Escape) y descargar.
$('fm-pv-close').addEventListener('click', closePreview);
$('fm-pv-download').addEventListener('click', () => pvEntry && download(pvEntry));
$('fm-preview').addEventListener('click', (e) => { if (e.target.id === 'fm-preview') closePreview(); });

// Atajos de teclado.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const hadCtx = !ctxEl.hidden;
    const hadPreview = !$('fm-preview').hidden;
    hideCtx();
    if (hadPreview) closePreview();
    // Embebido y sin nada abierto: Esc cierra la ventana flotante del shell.
    if (EMBEDDED && !hadCtx && !hadPreview) window.parent.postMessage({ type: 'cwc-explorer-close' }, location.origin);
    return;
  }
  if (e.target.tagName === 'INPUT') return;
  if (state.mode !== 'files') return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection.size) { e.preventDefault(); trashSelected(); }
  else if (e.key === 'Enter' && state.selection.size === 1) open(entryByName([...state.selection][0]));
});

// Drag & drop para subir.
const main = $('fm-main');
['dragenter', 'dragover'].forEach((ev) => main.addEventListener(ev, (e) => {
  e.preventDefault();
  if (state.mode === 'files') main.classList.add('fm-dragging');
}));
['dragleave', 'drop'].forEach((ev) => main.addEventListener(ev, (e) => {
  e.preventDefault();
  if (ev === 'dragleave' && main.contains(e.relatedTarget)) return;
  main.classList.remove('fm-dragging');
}));
main.addEventListener('drop', (e) => { if (state.mode === 'files' && e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files); });

// Proyecto principal para el atajo del sidebar.
(async () => {
  try {
    const st = await (await fetch('/api/tolkien/status')).json();
    if (st?.rel != null) { state.projectRel = st.rel; state.projectName = st.name || 'proyecto'; $('fm-project-name').textContent = st.name || 'proyecto'; }
  } catch { /* noop */ }
})();

document.querySelector('.fm-tb-right')?.insertAdjacentHTML('beforeend', helpBtn('files'));
bindHelp();
hydrateIcons(); // rellena los [data-icon] estáticos del HTML

// Deep-link: /archivos?path=<rel> arranca en esa carpeta (si no, en el home).
const deepPath = new URLSearchParams(location.search).get('path');
if (deepPath) {
  state.mode = 'files';
  state.cwd = deepPath.replace(/^\/+/, '');
  load();
  for (const b of document.querySelectorAll('.fm-place')) b.classList.remove('active');
} else {
  goPlace('home');
}
refreshTrashCount();
