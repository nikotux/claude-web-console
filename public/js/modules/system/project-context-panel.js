// modules/system/project-context-panel.js — pestaña "Proyectos" del menú
// Sistema.
//
// Selector arriba con TODOS los contextos editables de la app en un solo
// lugar: los proyectos completos (GET /api/projects: Tolkien y esta propia
// consola — contexto CLAUDE.md + memorias) y los "sub-proyectos" de
// bugfixes (contexto de trabajo y de redacción del PR — solo texto libre,
// SIN memorias, vía /api/bugfixes/context). Antes estos dos últimos tenían
// botones "Contexto" propios en el panel de Bugs y en el modal Enviar PR;
// se sacaron de ahí y viven acá para no repetir el patrón de edición en
// tres lugares distintos.
//
// No son copias: son los mismos archivos que Claude Code (o el prompt de
// "Trabajar en Chat") lee de verdad — guardar acá cambia comportamiento
// real. Reutiliza .bk-row/.hp-* (mismo look que Backup/Salud) y
// textEditorDialog para la edición.
import { icon } from '../../ui/icons.js';

const PROJECTS_API = '/api/projects';
const BUGFIX_API = '/api/bugfixes/context';

// "Sub-proyectos" de bugfixes: solo contexto (texto libre), sin memorias.
const BUGFIX_ENTRIES = [
  {
    key: 'bugfix-work', kind: 'bugfix', bfKind: 'work', name: 'Bugfixes: Trabajo',
    title: 'Contexto de trabajo de bugs',
    hint: 'Define CÓMO se trabaja un bug (verificación previa del ticket y de PRs de Chris, proceso de resolución, no enviar el PR desde el chat). Se inyecta en cada "Trabajar en Chat".',
  },
  {
    key: 'bugfix-pr', kind: 'bugfix', bfKind: 'pr', name: 'Bugfixes: PR',
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

export function mountProjectContextPanel(el, ctx) {
  const { dialog, isAdmin } = ctx;

  el.innerHTML = `
    <div class="bk-actions tk-switcher" data-ref="switcher"></div>

    <div class="hp-head">
      <span class="hp-title" data-ref="ctxTitle">Contexto</span>
    </div>
    <div class="bk-row" data-ref="ctxRow"><span class="hp-empty">cargando…</span></div>

    <div data-ref="memSection">
      <div class="hp-head hp-head--review">
        <span class="hp-title">Memorias</span>
        ${isAdmin ? `<button class="btn-ghost btn--sm btn--icon" data-ref="idxEdit" title="Editar índice (MEMORY.md)">${icon('edit', { size: 13 })}</button>` : ''}
      </div>
      <div class="bk-list" data-ref="notes"><span class="cwc-spinner"></span></div>
    </div>`;

  const refs = {};
  for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;
  let alive = true;
  const obs = new MutationObserver(() => { if (!el.isConnected) { alive = false; obs.disconnect(); } });
  obs.observe(document.body, { childList: true, subtree: true });

  let entries = []; // proyectos completos + sub-proyectos de bugfixes
  let current = null; // key de la entrada activa
  let ctxContent = '';
  let indexContent = '';

  const currentEntry = () => entries.find((e) => e.key === current);
  const projectApi = (suffix) => `${PROJECTS_API}/${encodeURIComponent(current)}${suffix}`;

  // ===== Contexto: proyecto completo (CLAUDE.md) =====
  async function editContext() {
    const entry = currentEntry();
    await dialog.textEditorDialog({
      title: `Contexto — CLAUDE.md (${entry?.name || current})`,
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
    if (!alive) return;
    refs.ctxTitle.textContent = 'Contexto (CLAUDE.md)';
    refs.ctxRow.innerHTML = '<span class="hp-empty">cargando…</span>';
    try {
      const { content } = await (await fetch(projectApi('/context'))).json();
      if (!alive) return;
      ctxContent = content || '';
      const firstLine = (ctxContent.split('\n').find((l) => l.trim()) || '(vacío)').replace(/^#+\s*/, '');
      const lineCount = ctxContent ? ctxContent.split('\n').length : 0;
      refs.ctxRow.innerHTML = `
        <span class="hp-detail"><b>${esc(firstLine)}</b><br>${lineCount} líneas · ${fmtSize(ctxContent.length)}</span>
        ${isAdmin ? `<span class="bk-actions"><button class="btn-ghost btn--sm btn--icon" data-ref="ctxEdit" title="Editar contexto">${icon('edit', { size: 13 })}</button></span>` : ''}`;
      refs.ctxRow.querySelector('[data-ref="ctxEdit"]')?.addEventListener('click', editContext);
    } catch {
      if (alive) refs.ctxRow.innerHTML = '<span class="hp-empty">No se pudo leer el contexto.</span>';
    }
  }

  // ===== Contexto: sub-proyecto de bugfixes (texto libre, sin memorias) =====
  let bfContext = '';

  async function editBugfixContext() {
    const entry = currentEntry();
    await dialog.textEditorDialog({
      title: entry.title,
      hint: `${entry.hint} Es texto libre (sin memorias asociadas).`,
      value: bfContext,
      width: 640,
      saveLabel: 'Guardar',
      onSave: async (text) => {
        const res = await fetch(BUGFIX_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: entry.bfKind, context: text }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'No se pudo guardar.');
        bfContext = text;
      },
    });
    loadBugfixContext();
  }

  async function loadBugfixContext() {
    if (!alive) return;
    const entry = currentEntry();
    refs.ctxTitle.textContent = 'Contexto';
    refs.ctxRow.innerHTML = '<span class="hp-empty">cargando…</span>';
    try {
      const data = await (await fetch(`${BUGFIX_API}?kind=${entry.bfKind}`)).json();
      if (!alive) return;
      bfContext = data.context || '';
      const firstLine = (bfContext.split('\n').find((l) => l.trim()) || '(vacío)').slice(0, 90);
      refs.ctxRow.innerHTML = `
        <span class="hp-detail"><b>${esc(firstLine)}</b><br>${fmtSize(bfContext.length)}${data.isDefault ? ' · viendo el valor por defecto' : ''}</span>
        ${isAdmin ? `<span class="bk-actions"><button class="btn-ghost btn--sm btn--icon" data-ref="ctxEdit" title="Editar contexto">${icon('edit', { size: 13 })}</button></span>` : ''}`;
      refs.ctxRow.querySelector('[data-ref="ctxEdit"]')?.addEventListener('click', editBugfixContext);
    } catch {
      if (alive) refs.ctxRow.innerHTML = '<span class="hp-empty">No se pudo leer el contexto.</span>';
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
    if (!alive) return;
    refs.notes.innerHTML = '<span class="cwc-spinner"></span>';
    try {
      const data = await (await fetch(projectApi('/memory'))).json();
      if (!alive) return;
      indexContent = data.index || '';
      if (!data.files.length) {
        refs.notes.innerHTML = '<div class="bk-empty">Todavía no hay memorias registradas para este proyecto.</div>';
        return;
      }
      refs.notes.innerHTML = data.files.map((f) => `
        <div class="bk-row" data-file="${esc(f.file)}">
          <span class="hp-detail">
            <b>${esc(f.title)}</b>${f.orphan ? ' <span class="hp-sev" title="No está listada en el índice MEMORY.md">(huérfana)</span>' : ''}<br>
            ${esc(f.description)}${f.updatedAt ? ` <span class="hp-sev">· ${fmtWhen(f.updatedAt)}</span>` : ''}
          </span>
          ${isAdmin ? `<span class="bk-actions"><button class="btn-ghost btn--sm btn--icon" data-act="edit" title="Editar nota">${icon('edit', { size: 13 })}</button></span>` : ''}
        </div>`).join('');
      for (const row of refs.notes.querySelectorAll('[data-file]')) {
        row.querySelector('[data-act="edit"]')?.addEventListener('click', () => editNote(row.dataset.file, row.querySelector('b')?.textContent));
      }
    } catch {
      if (alive) refs.notes.innerHTML = '<div class="bk-empty">No se pudo leer la memoria.</div>';
    }
  }

  // ===== Selector =====
  function loadCurrent() {
    const entry = currentEntry();
    refs.memSection.hidden = entry.kind === 'bugfix';
    if (entry.kind === 'bugfix') loadBugfixContext();
    else { loadContext(); loadNotes(); }
  }

  function renderSwitcher() {
    refs.switcher.innerHTML = entries.map((e) => `
      <button class="btn-ghost btn--sm${e.key === current ? ' active' : ''}" data-key="${esc(e.key)}">${esc(e.name)}</button>
    `).join('');
    for (const b of refs.switcher.querySelectorAll('[data-key]')) {
      b.addEventListener('click', () => {
        if (b.dataset.key === current) return;
        current = b.dataset.key;
        renderSwitcher();
        loadCurrent();
      });
    }
  }

  async function init() {
    let projects = [];
    try { projects = await (await fetch(PROJECTS_API)).json(); }
    catch { projects = []; }
    entries = [...projects.map((p) => ({ ...p, kind: 'project' })), ...BUGFIX_ENTRIES];
    if (!entries.length) {
      refs.switcher.innerHTML = '';
      refs.ctxRow.innerHTML = '<span class="hp-empty">No se pudo leer la lista de proyectos.</span>';
      refs.memSection.hidden = true;
      return;
    }
    current = entries[0].key;
    renderSwitcher();
    loadCurrent();
  }

  refs.idxEdit?.addEventListener('click', editIndex);
  init();
}
