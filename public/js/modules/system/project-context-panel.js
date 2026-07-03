// modules/system/project-context-panel.js — pestaña "Proyectos" del menú
// Sistema.
//
// TODOS los contextos editables de la app en un solo lugar, con navegación
// en DOS NIVELES (lista → detalle, pensada para móvil): la vista inicial es
// una lista de TARJETAS agrupadas y visualmente diferenciadas (ícono +
// nombre + qué contiene cada una); tocar una abre su DETALLE con botón
// "‹ Proyectos" para volver. Antes el selector eran 4 pills idénticas al
// lado del contenido — confuso para navegar (feedback del usuario).
//
// Dos clases de entrada:
//   - Proyectos completos (GET /api/projects: Tolkien y esta consola):
//     contexto CLAUDE.md + memorias (índice MEMORY.md + notas).
//   - Contextos de bugfixes (kind=work|pr de /api/bugfixes/context): SOLO
//     texto libre, sin memorias (la sección Memorias no existe en su detalle).
//
// No son copias: son los mismos archivos que Claude Code (o el prompt de
// "Trabajar en Chat") lee de verdad — guardar acá cambia comportamiento
// real. Edición gateada por isAdmin (frontend Y backend); textEditorDialog
// para editar.
import { icon } from '../../ui/icons.js';

const PROJECTS_API = '/api/projects';
const BUGFIX_API = '/api/bugfixes/context';

// Presentación por key de proyecto completo (ícono + descripción corta).
const PROJECT_META = {
  tolkien: { ico: 'gitBranch', desc: 'Contexto CLAUDE.md + memorias del proyecto Tolkien' },
  console: { ico: 'terminal', desc: 'Contexto CLAUDE.md + memorias de esta consola' },
};

// "Sub-proyectos" de bugfixes: solo contexto (texto libre), sin memorias.
const BUGFIX_ENTRIES = [
  {
    key: 'bugfix-work', kind: 'bugfix', bfKind: 'work', name: 'Bugfixes: Trabajo',
    ico: 'edit', desc: 'Cómo se trabaja un bug (se inyecta en cada "Trabajar en Chat")',
    title: 'Contexto de trabajo de bugs',
    hint: 'Define CÓMO se trabaja un bug (verificación previa del ticket y de PRs de Chris, proceso de resolución, no enviar el PR desde el chat). Se inyecta en cada "Trabajar en Chat".',
  },
  {
    key: 'bugfix-pr', kind: 'bugfix', bfKind: 'pr', name: 'Bugfixes: PR',
    ico: 'gitBranch', desc: 'Cómo se redactan las notas del PR (formato del cierre del chat)',
    title: 'Contexto de redacción del PR',
    hint: 'Define CÓMO se redactan los cambios que van a las notas del PR (el formato del cierre del chat). Se inyecta en cada "Trabajar en Chat".',
  },
];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const fmtWhen = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' · ' +
    d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
};
const homeShort = (dir) => String(dir || '').replace(/^\/home\/[^/]+/, '~');

export function mountProjectContextPanel(el, ctx) {
  const { dialog, isAdmin } = ctx;

  el.innerHTML = '<div data-ref="root"><span class="cwc-spinner"></span></div>';
  const root = el.querySelector('[data-ref="root"]');

  let alive = true;
  const obs = new MutationObserver(() => { if (!el.isConnected) { alive = false; obs.disconnect(); } });
  obs.observe(document.body, { childList: true, subtree: true });

  let entries = []; // proyectos completos + sub-proyectos de bugfixes
  let current = null; // entrada abierta en el detalle (null = vista lista)
  let ctxContent = '';
  let bfContent = '';
  let indexContent = '';

  const projectApi = (suffix) => `${PROJECTS_API}/${encodeURIComponent(current.key)}${suffix}`;

  // ===== Vista LISTA: tarjetas agrupadas =====
  function card(e) {
    return `
      <button class="pj-card${e.kind === 'bugfix' ? ' pj-card--bf' : ''}" data-key="${esc(e.key)}">
        <span class="pj-ico">${icon(e.ico, { size: 16 })}</span>
        <span class="pj-body">
          <span class="pj-name">${esc(e.name)}</span>
          <span class="pj-sub">${esc(e.desc)}</span>
        </span>
        ${icon('chevronRight', { size: 15 })}
      </button>`;
  }

  function renderList() {
    current = null;
    const projects = entries.filter((e) => e.kind === 'project');
    const bugfixes = entries.filter((e) => e.kind === 'bugfix');
    root.innerHTML = `
      <div class="hp-head"><span class="hp-title">Proyectos · contexto y memorias</span></div>
      <div class="pj-list">${projects.map(card).join('')}</div>
      <div class="hp-head hp-head--review"><span class="hp-title">Bugfixes · solo contexto</span></div>
      <div class="pj-list">${bugfixes.map(card).join('')}</div>
      <p class="pj-hint">Son los archivos REALES que lee Claude en cada proyecto: guardar acá cambia el comportamiento de la próxima sesión.</p>`;
    for (const b of root.querySelectorAll('.pj-card')) {
      b.addEventListener('click', () => {
        const e = entries.find((x) => x.key === b.dataset.key);
        if (e) renderDetail(e);
      });
    }
  }

  // ===== Vista DETALLE: volver + contexto (+ memorias si aplica) =====
  function renderDetail(entry) {
    current = entry;
    const isProject = entry.kind === 'project';
    root.innerHTML = `
      <div class="pj-head">
        <button class="btn-ghost btn--sm" data-ref="back">${icon('chevronLeft', { size: 14 })}<span>Proyectos</span></button>
        <span class="pj-head-ico">${icon(entry.ico, { size: 15 })}</span>
        <span class="pj-head-name">${esc(entry.name)}</span>
      </div>
      ${isProject ? `<p class="pj-dir"><code>${esc(homeShort(entry.dir))}</code></p>` : ''}

      <div class="hp-head">
        <span class="hp-title">${isProject ? 'Contexto (CLAUDE.md)' : 'Contexto'}</span>
      </div>
      <div class="bk-row" data-ref="ctxRow"><span class="hp-empty">cargando…</span></div>

      ${isProject ? `
        <div class="hp-head hp-head--review">
          <span class="hp-title">Memorias</span>
          ${isAdmin ? `<button class="btn-ghost btn--sm btn--icon" data-ref="idxEdit" title="Editar índice (MEMORY.md)">${icon('edit', { size: 13 })}</button>` : ''}
        </div>
        <div class="bk-list" data-ref="notes"><span class="cwc-spinner"></span></div>` : ''}`;

    root.querySelector('[data-ref="back"]').addEventListener('click', renderList);
    root.querySelector('[data-ref="idxEdit"]')?.addEventListener('click', editIndex);
    if (isProject) { loadContext(); loadNotes(); } else { loadBugfixContext(); }
  }

  const ctxRow = () => root.querySelector('[data-ref="ctxRow"]');
  const notesEl = () => root.querySelector('[data-ref="notes"]');

  // ===== Contexto: proyecto completo (CLAUDE.md) =====
  async function editContext() {
    await dialog.textEditorDialog({
      title: `Contexto — CLAUDE.md (${current.name})`,
      hint: 'Es el CLAUDE.md real del proyecto: lo lee la próxima sesión de Claude Code ahí.',
      value: ctxContent,
      width: 760,
      saveLabel: 'Guardar',
      onSave: async (text) => {
        const res = await fetch(projectApi('/context'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo guardar.');
        ctxContent = text;
      },
    });
    loadContext();
  }

  async function loadContext() {
    if (!alive || !current) return;
    const row = ctxRow();
    if (!row) return;
    row.innerHTML = '<span class="hp-empty">cargando…</span>';
    try {
      const { content } = await (await fetch(projectApi('/context'))).json();
      if (!alive || !ctxRow()) return;
      ctxContent = content || '';
      const firstLine = (ctxContent.split('\n').find((l) => l.trim()) || '(vacío)').replace(/^#+\s*/, '');
      const lineCount = ctxContent ? ctxContent.split('\n').length : 0;
      ctxRow().innerHTML = `
        <span class="hp-detail"><b>${esc(firstLine)}</b><br>${lineCount} líneas · ${fmtSize(ctxContent.length)}</span>
        ${isAdmin ? `<span class="bk-actions"><button class="btn-ghost btn--sm btn--icon" data-ref="ctxEdit" title="Editar contexto">${icon('edit', { size: 13 })}</button></span>` : ''}`;
      ctxRow().querySelector('[data-ref="ctxEdit"]')?.addEventListener('click', editContext);
    } catch {
      if (alive && ctxRow()) ctxRow().innerHTML = '<span class="hp-empty">No se pudo leer el contexto.</span>';
    }
  }

  // ===== Contexto: sub-proyecto de bugfixes (texto libre, sin memorias) =====
  async function editBugfixContext() {
    await dialog.textEditorDialog({
      title: current.title,
      hint: `${current.hint} Es texto libre (sin memorias asociadas).`,
      value: bfContent,
      width: 640,
      saveLabel: 'Guardar',
      onSave: async (text) => {
        const res = await fetch(BUGFIX_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: current.bfKind, context: text }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo guardar.');
        bfContent = text;
      },
    });
    loadBugfixContext();
  }

  async function loadBugfixContext() {
    if (!alive || !current) return;
    const row = ctxRow();
    if (!row) return;
    row.innerHTML = '<span class="hp-empty">cargando…</span>';
    try {
      const data = await (await fetch(`${BUGFIX_API}?kind=${current.bfKind}`)).json();
      if (!alive || !ctxRow()) return;
      bfContent = data.context || '';
      const firstLine = (bfContent.split('\n').find((l) => l.trim()) || '(vacío)').slice(0, 90);
      ctxRow().innerHTML = `
        <span class="hp-detail"><b>${esc(firstLine)}</b><br>${fmtSize(bfContent.length)}${data.isDefault ? ' · viendo el valor por defecto' : ''}</span>
        ${isAdmin ? `<span class="bk-actions"><button class="btn-ghost btn--sm btn--icon" data-ref="ctxEdit" title="Editar contexto">${icon('edit', { size: 13 })}</button></span>` : ''}`;
      ctxRow().querySelector('[data-ref="ctxEdit"]')?.addEventListener('click', editBugfixContext);
    } catch {
      if (alive && ctxRow()) ctxRow().innerHTML = '<span class="hp-empty">No se pudo leer el contexto.</span>';
    }
  }

  // ===== Memorias (solo proyectos completos) =====
  async function editNote(file, title) {
    let content = '';
    try {
      const data = await (await fetch(projectApi(`/memory/note/${encodeURIComponent(file)}`))).json();
      content = data.content || '';
    } catch { /* arranca vacío si falló la lectura */ }
    await dialog.textEditorDialog({
      title: `Memoria — ${title || file}`,
      hint: `Archivo: ${file}`,
      value: content,
      width: 640,
      saveLabel: 'Guardar',
      onSave: async (text) => {
        const res = await fetch(projectApi(`/memory/note/${encodeURIComponent(file)}`), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo guardar.');
      },
    });
    loadNotes();
  }

  async function editIndex() {
    await dialog.textEditorDialog({
      title: 'Índice de memorias — MEMORY.md',
      hint: 'Una línea por nota: "- [Título](archivo.md) — descripción corta".',
      value: indexContent,
      width: 640,
      saveLabel: 'Guardar',
      onSave: async (text) => {
        const res = await fetch(projectApi('/memory/index'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo guardar.');
        indexContent = text;
      },
    });
    loadNotes();
  }

  async function loadNotes() {
    if (!alive || !current) return;
    const box = notesEl();
    if (!box) return;
    box.innerHTML = '<span class="cwc-spinner"></span>';
    try {
      const data = await (await fetch(projectApi('/memory'))).json();
      if (!alive || !notesEl()) return;
      indexContent = data.index || '';
      if (!data.files.length) {
        notesEl().innerHTML = '<div class="bk-empty">Todavía no hay memorias registradas para este proyecto.</div>';
        return;
      }
      notesEl().innerHTML = data.files.map((f) => `
        <div class="bk-row" data-file="${esc(f.file)}">
          <span class="hp-detail">
            <b>${esc(f.title)}</b>${f.orphan ? ' <span class="hp-sev" title="No está listada en el índice MEMORY.md">(huérfana)</span>' : ''}<br>
            ${esc(f.description)}${f.updatedAt ? ` <span class="hp-sev">· ${fmtWhen(f.updatedAt)}</span>` : ''}
          </span>
          ${isAdmin ? `<span class="bk-actions"><button class="btn-ghost btn--sm btn--icon" data-act="edit" title="Editar nota">${icon('edit', { size: 13 })}</button></span>` : ''}
        </div>`).join('');
      for (const row of notesEl().querySelectorAll('[data-file]')) {
        row.querySelector('[data-act="edit"]')?.addEventListener('click', () => editNote(row.dataset.file, row.querySelector('b')?.textContent));
      }
    } catch {
      if (alive && notesEl()) notesEl().innerHTML = '<div class="bk-empty">No se pudo leer la memoria.</div>';
    }
  }

  async function init() {
    let projects = [];
    try { projects = await (await fetch(PROJECTS_API)).json(); }
    catch { projects = []; }
    entries = [
      ...projects.map((p) => ({
        ...p,
        kind: 'project',
        ico: PROJECT_META[p.key]?.ico || 'folder',
        desc: PROJECT_META[p.key]?.desc || homeShort(p.dir),
      })),
      ...BUGFIX_ENTRIES,
    ];
    if (!alive) return;
    if (!entries.length) {
      root.innerHTML = '<span class="hp-empty">No se pudo leer la lista de proyectos.</span>';
      return;
    }
    renderList();
  }

  init();
}
