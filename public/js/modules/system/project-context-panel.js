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
//   - Contextos de "Tickets & Features" (kind=work|pr de /api/tickets/context):
//     SOLO texto libre, sin memorias (la sección Memorias no existe en su detalle).
//     Se inyectan en cada "Continuar en el chat" de un ticket/feature/PR de la v2.
//
// No son copias: son los mismos archivos que Claude Code (o el prompt de
// "Trabajar en Chat") lee de verdad — guardar acá cambia comportamiento
// real. Los contextos work/pr son propios del usuario autenticado y editables
// por su dueño; los demás permisos admin de este panel se mantienen.
import { icon } from '../../ui/icons.js';
import { helpBtn } from '../../ui/help.js';
import { t } from '../../ui/i18n.js';
import { pacman } from '../../ui/pacman.js';
import { renderDiff } from '../../ui/diff.js';
import { CHAT_MODEL_OPTIONS, EFFORT_OPTIONS } from '../../ui/models.js';

const PROJECTS_API = '/api/projects';
const BUGFIX_API = '/api/tickets/context'; // migrado de v1 a Tickets & Features

// Presentación por key de proyecto completo (ícono + descripción corta).
const PROJECT_META = {
  tolkien: { ico: 'gitBranch', descKey: 'system.projectContext.tolkienDesc', desc: 'Contexto CLAUDE.md + memorias del proyecto Tolkien' },
  // Ícono de identidad de "Mi Consola" (ui/icons.js `console`, ver ui/places.js).
  console: { ico: 'console', descKey: 'system.projectContext.consoleDesc', desc: 'Contexto CLAUDE.md + memorias de Mi Consola (esta web)' },
};

// Contextos de "Tickets & Features": solo contexto (texto libre), sin memorias.
// Se inyectan en cada "Continuar en el chat" de un ticket/feature/PR de la v2.
// (Las keys internas conservan el prefijo `bugfix-` — no cambian el endpoint.)
const BUGFIX_ENTRIES = [
  {
    key: 'bugfix-work', kind: 'bugfix', bfKind: 'work',
    nameKey: 'system.projectContext.bugfixWorkName', name: 'Tickets & Features: Trabajo',
    ico: 'edit',
    descKey: 'system.projectContext.bugfixWorkDesc', desc: 'Cómo se trabaja un ticket (Pensamiento Profundo, triage, gate de push)',
    titleKey: 'system.projectContext.bugfixWorkTitle', title: 'Contexto de trabajo de tickets',
    hintKey: 'system.projectContext.bugfixWorkHint', hint: 'Define CÓMO se trabaja un ticket: el "Pensamiento Profundo" (paso 0 antes del plan), la verificación previa del ticket y de PRs de Chris, el triage BUG/FR/EXTERNA y el gate de push. Se inyecta en cada "Continuar en el chat" de un ticket/feature/PR.',
  },
  {
    key: 'bugfix-pr', kind: 'bugfix', bfKind: 'pr',
    nameKey: 'system.projectContext.bugfixPrName', name: 'Tickets & Features: PR',
    ico: 'gitBranch',
    descKey: 'system.projectContext.bugfixPrDesc', desc: 'Cómo se redacta la descripción del PR (house style)',
    titleKey: 'system.projectContext.bugfixPrTitle', title: 'Contexto de redacción del PR',
    hintKey: 'system.projectContext.bugfixPrHint', hint: 'Define CÓMO se redacta la descripción del PR (house style: Summary con las tres preguntas, causa raíz, verificación, variantes feature/external). Se inyecta en cada "Continuar en el chat" de un ticket/feature/PR.',
  },
];

// Tarjetas del panel de personalización per-user (SP8, PLAN-594). Cada una
// consume /api/projects/me/*. `persoKind` selecciona su detalle.
const PERSO_ENTRIES = [
  {
    key: 'perso-global', kind: 'perso', persoKind: 'global',
    nameKey: 'system.projectContext.persoGlobalName', name: 'Comportamiento', ico: 'sparkle',
    descKey: 'system.projectContext.persoGlobalDesc', desc: 'Tu CLAUDE.md GLOBAL: cómo reacciona la IA (visual, Relato Anclado, la pelota)',
  },
  {
    key: 'perso-hooks', kind: 'perso', persoKind: 'hooks',
    nameKey: 'system.projectContext.persoHooksName', name: 'Hooks', ico: 'gear',
    descKey: 'system.projectContext.persoHooksDesc', desc: 'Activá/desactivá observador, interfono y la pelota (settings.json)',
  },
  {
    key: 'perso-prefs', kind: 'perso', persoKind: 'prefs',
    nameKey: 'system.projectContext.persoPrefsName', name: 'Defaults de modelo', ico: 'console',
    descKey: 'system.projectContext.persoPrefsDesc', desc: 'Modelo/AutoTux, esfuerzo y modo de permisos por defecto de tus chats nuevos',
  },
  {
    key: 'perso-identity', kind: 'perso', persoKind: 'identity',
    nameKey: 'system.projectContext.persoIdentityName', name: 'Identidad', ico: 'edit',
    descKey: 'system.projectContext.persoIdentityDesc', desc: 'Tu nombre, email, GitHub y firma',
  },
];

const PERM_LABELS = [
  ['default', 'system.projectContext.permissionAsk', 'Preguntar'],
  ['acceptEdits', 'system.projectContext.permissionAcceptEdits', 'Aceptar ediciones'],
  ['bypassPermissions', 'system.projectContext.permissionBypass', 'Todo (sin preguntar)'],
  ['plan', 'system.projectContext.permissionPlan', 'Solo plan'],
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
const entryName = (e) => e.nameKey ? t(e.nameKey, e.name) : e.name;
const entryDesc = (e) => e.descKey ? t(e.descKey, e.desc) : e.desc;
const entryTitle = (e) => e.titleKey ? t(e.titleKey, e.title) : e.title;
const entryHint = (e) => e.hintKey ? t(e.hintKey, e.hint) : e.hint;

export function mountProjectContextPanel(el, ctx) {
  const { dialog, isAdmin } = ctx;

  el.innerHTML = `
    <div class="hp-head">
      <span class="hp-title">${t('system.help.projects.title', 'Proyectos')}</span>
      ${helpBtn('sys-projects')}
    </div>
    <div data-ref="root"><span class="cwc-spinner"></span></div>`;
  const root = el.querySelector('[data-ref="root"]');

  let alive = true;
  const obs = new MutationObserver(() => { if (!el.isConnected) { alive = false; obs.disconnect(); } });
  obs.observe(document.body, { childList: true, subtree: true });

  let entries = []; // proyectos completos + sub-proyectos de bugfixes
  let current = null; // entrada abierta en el detalle (null = vista lista)
  let bfContent = '';
  let indexContent = '';
  // Hash de lo último leído de MEMORY.md: viaja en el guardado para que el
  // server detecte si una sesión de Claude Code lo tocó en el medio (mismo
  // patrón que el hash por sección del contexto) y devuelva 409 en vez de
  // pisarlo en silencio.
  let indexHash = '';

  const projectApi = (suffix) => `${PROJECTS_API}/${encodeURIComponent(current.key)}${suffix}`;
  // Base de la API de secciones: proyecto → /api/projects/<key>/context ;
  // personalización 'global' → /api/projects/me/global. Misma forma de sub-rutas
  // (/sections, /section/:i, /section/:i/analyze[/:id]).
  const sectionsBase = () => (current?.kind === 'perso'
    ? `${PROJECTS_API}/me/global`
    : `${PROJECTS_API}/${encodeURIComponent(current.key)}/context`);
  const sectionsUrl = (suffix) => sectionsBase() + suffix;

  // ===== Vista LISTA: tarjetas agrupadas =====
  function card(e) {
    return `
      <button class="pj-card${e.kind === 'bugfix' ? ' pj-card--bf' : ''}" data-key="${esc(e.key)}">
          <span class="pj-ico">${icon(e.ico, { size: 16 })}</span>
        <span class="pj-body">
          <span class="pj-name">${esc(entryName(e))}</span>
          <span class="pj-sub">${esc(entryDesc(e))}</span>
        </span>
        ${icon('chevronRight', { size: 15 })}
      </button>`;
  }

  function renderList() {
    current = null;
    const projects = entries.filter((e) => e.kind === 'project');
    const bugfixes = entries.filter((e) => e.kind === 'bugfix');
    const perso = entries.filter((e) => e.kind === 'perso');
    root.innerHTML = `
      <div class="hp-head"><span class="hp-title">${t('system.projectContext.projectsContextMemoriesTitle', 'Proyectos · contexto y memorias')}</span></div>
      <div class="pj-list">${projects.map(card).join('')}</div>
      <div class="hp-head hp-head--review"><span class="hp-title">${t('system.projectContext.ticketsWorkContextTitle', 'Tickets &amp; Features · contexto de trabajo')}</span></div>
      <div class="pj-list">${bugfixes.map(card).join('')}</div>
      <div class="hp-head hp-head--review"><span class="hp-title">🎛️ ${t('system.projectContext.personalizationTitle', 'Personalización (tu espacio)')}</span></div>
      <div class="pj-list">${perso.map(card).join('')}</div>
      <p class="pj-hint">${t('system.projectContext.realFilesHint', 'Son los archivos REALES que lee Claude en cada proyecto: guardar acá cambia el comportamiento de la próxima sesión.')}</p>`;
    for (const b of root.querySelectorAll('.pj-card')) {
      b.addEventListener('click', () => {
        const e = entries.find((x) => x.key === b.dataset.key);
        if (e) renderDetail(e);
      });
    }
  }

  // ===== Vista DETALLE: volver + contexto (+ memorias si aplica) =====
  function renderDetail(entry) {
    if (entry.kind === 'perso') {
      renderPersoDetail(entry);
      return;
    }
    current = entry;
    const isProject = entry.kind === 'project';
    root.innerHTML = `
      <div class="pj-head">
        <button class="btn-ghost btn--sm" data-ref="back">${icon('chevronLeft', { size: 14 })}<span>${t('system.projectContext.projectsBack', 'Proyectos')}</span></button>
        <span class="pj-head-ico">${icon(entry.ico, { size: 15 })}</span>
        <span class="pj-head-name">${esc(entryName(entry))}</span>
      </div>
      ${isProject ? `<p class="pj-dir"><code>${esc(homeShort(entry.dir))}</code></p>` : ''}
      ${!isProject ? `<div class="pj-sync" data-ref="syncBox"><span class="hp-empty">${t('system.projectContext.checkingTolkienMirror', 'verificando espejo con Tolkien…')}</span></div>` : ''}

      <div class="hp-head">
        <span class="hp-title">${isProject ? t('system.projectContext.claudeContextTitle', 'Contexto (CLAUDE.md)') : t('system.projectContext.contextTitle', 'Contexto')}</span>
        ${isProject ? '<span class="pj-total" data-ref="ctxTotal"></span>' : ''}
      </div>
      ${isProject
    ? '<div class="bk-list" data-ref="ctxSections"><span class="cwc-spinner"></span></div>'
    : `<div class="bk-row" data-ref="ctxRow"><span class="hp-empty">${t('system.projectContext.loading', 'cargando…')}</span></div>`}

      ${isProject ? `
        <div class="hp-head hp-head--review">
          <span class="hp-title">${t('system.projectContext.memoriesTitle', 'Memorias')}</span>
          ${isAdmin ? `<button class="btn-ghost btn--sm btn--icon" data-ref="idxEdit" title="${t('system.projectContext.editIndexTooltip', 'Editar índice (MEMORY.md)')}">${icon('edit', { size: 13 })}</button>` : ''}
        </div>
        <div class="bk-list" data-ref="notes"><span class="cwc-spinner"></span></div>` : ''}`;

    root.querySelector('[data-ref="back"]').addEventListener('click', renderList);
    root.querySelector('[data-ref="idxEdit"]')?.addEventListener('click', editIndex);
    if (isProject) { loadContext(); loadNotes(); } else { loadBugfixContext(); loadSync(); }
  }

  function renderPersoDetail(entry) {
    current = entry;
    root.innerHTML = `
      <div class="pj-head">
        <button class="btn-ghost btn--sm" data-ref="back">${icon('chevronLeft', { size: 14 })}<span>${t('system.projectContext.personalizationBack', 'Personalización')}</span></button>
        <span class="pj-head-ico">${icon(entry.ico, { size: 15 })}</span>
        <span class="pj-head-name">${esc(entryName(entry))}</span>
      </div>
      <div data-ref="persoBody"><span class="cwc-spinner"></span></div>`;
    root.querySelector('[data-ref="back"]').addEventListener('click', renderList);
    const bodyEl = root.querySelector('[data-ref="persoBody"]');
    if (entry.persoKind === 'global') renderGlobalDetail(bodyEl);
    else if (entry.persoKind === 'hooks') renderHooksDetail(bodyEl);
    else if (entry.persoKind === 'prefs') renderPrefsDetail(bodyEl);
    else renderIdentityDetail(bodyEl);
  }

  function renderGlobalDetail(bodyEl) {
    bodyEl.innerHTML = `
      <p class="pj-hint">${t('system.projectContext.globalHint', 'Es tu <code>~/.claude/CLAUDE.md</code> GLOBAL — auto-cargado en TODA sesión. Editás por secciones; al guardar, una revisión con IA te muestra qué cambia.')}</p>
      <div class="hp-head"><span class="hp-title">${t('system.projectContext.globalBehaviorTitle', 'Comportamiento (CLAUDE.md global)')}</span><span class="pj-total" data-ref="ctxTotal"></span></div>
      <div class="bk-list" data-ref="ctxSections"><span class="cwc-spinner"></span></div>`;
    loadContext(); // usa sectionsBase()/sectionsUrl() → /api/projects/me/global
  }

  async function renderHooksDetail(bodyEl) {
    bodyEl.innerHTML = '<span class="cwc-spinner"></span>';
    let hooks = [];
    try { hooks = (await (await fetch(`${PROJECTS_API}/me/hooks`)).json()).hooks || []; }
    catch { bodyEl.innerHTML = `<div class="bk-empty">${t('system.projectContext.hooksReadError', 'No se pudo leer los hooks.')}</div>`; return; }
    if (!alive) return;
    bodyEl.innerHTML = `
      <p class="pj-hint">${t('system.projectContext.hooksHint', 'Activá/desactivá comportamientos de Claude Code. <b>Ojo:</b> una sesión ya abierta toma el cambio al reabrirla.')}</p>
      <div class="bk-list">${hooks.map((h) => `
        <div class="bk-row" data-hook="${esc(h.id)}">
          <span class="hp-detail"><b>${esc(h.name)}</b><br><span class="hp-sev">${h.enabled ? t('system.projectContext.enabled', 'Activado') : t('system.projectContext.disabled', 'Desactivado')}</span></span>
          <span class="bk-actions"><button class="btn${h.enabled ? '' : '-ghost'} btn--sm" data-act="toggle">${h.enabled ? t('system.projectContext.disable', 'Desactivar') : t('system.projectContext.enable', 'Activar')}</button></span>
        </div>`).join('')}</div>`;
    for (const row of bodyEl.querySelectorAll('[data-hook]')) {
      row.querySelector('[data-act="toggle"]').addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.disabled = true;
        const id = row.dataset.hook;
        const cur = hooks.find((x) => x.id === id);
        try {
          const res = await fetch(`${PROJECTS_API}/me/hooks/${encodeURIComponent(id)}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !cur.enabled }),
          });
          const d = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(d.error || t('system.projectContext.changeFailed', 'No se pudo cambiar.'));
        } catch (err) { await dialog.alertDialog({ title: t('system.projectContext.hooksDialogTitle', 'Hooks'), message: err.message || t('system.projectContext.changeFailed', 'No se pudo cambiar.') }); }
        renderHooksDetail(bodyEl); // recargar estado
      });
    }
  }

  async function renderPrefsDetail(bodyEl) {
    bodyEl.innerHTML = '<span class="cwc-spinner"></span>';
    let prefs = {};
    try { prefs = (await (await fetch(`${PROJECTS_API}/me/prefs`)).json()).prefs || {}; }
    catch { bodyEl.innerHTML = `<div class="bk-empty">${t('system.projectContext.prefsReadError', 'No se pudo leer las preferencias.')}</div>`; return; }
    if (!alive) return;
    const opt = (pairs, sel, emptyLabel) =>
      `<option value="">${esc(emptyLabel)}</option>` +
      pairs.map(([v, keyOrLabel, label]) => {
        const shown = label === undefined ? keyOrLabel : t(keyOrLabel, label);
        return `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(shown)}</option>`;
      }).join('');
    const chatModelOptions = CHAT_MODEL_OPTIONS.map(([v, label]) => {
      const labels = {
        auto: t('system.projectContext.chatModelAutoTux', 'AutoTux'),
        tandem: t('system.projectContext.chatModelTandem', 'Tándem (Opus 5.5 + Codex)'),
        opusplan: t('system.projectContext.chatModelOpusPlan', 'Opus plan'),
        fable: t('system.projectContext.chatModelFable', 'Fable'),
        opus: t('system.projectContext.chatModelOpus', 'Opus 5.5'),
        sonnet: t('system.projectContext.chatModelSonnet', 'Sonnet'),
        haiku: t('system.projectContext.chatModelHaiku', 'Haiku'),
        default: t('system.projectContext.chatModelAccountDefault', 'Default de la cuenta'),
      };
      return [v, labels[v] || label];
    });
    const effortOptions = EFFORT_OPTIONS.map(([v, label]) => {
      const labels = {
        auto: t('system.projectContext.effortAutoByModel', 'Auto · según modelo'),
        low: t('system.projectContext.effortLow', 'Bajo'),
        medium: t('system.projectContext.effortMedium', 'Medio'),
        high: t('system.projectContext.effortHigh', 'Alto'),
        xhigh: t('system.projectContext.effortVeryHigh', 'Muy alto'),
        max: t('system.projectContext.effortMax', 'Máximo'),
      };
      return [v, labels[v] || label];
    });
    bodyEl.innerHTML = `
      <p class="pj-hint">${t('system.projectContext.prefsHint', 'Defaults de tus chats NUEVOS. Un chat que elija modelo explícito igual manda. Vacío = default del sistema.')}</p>
      <div class="bk-list">
        <div class="bk-row"><span class="hp-detail"><b>${t('system.projectContext.modelAutotuxLabel', 'Modelo / AutoTux')}</b></span><span class="bk-actions"><select class="dlg-input" data-pref="defaultModelChoice">${opt(chatModelOptions, prefs.defaultModelChoice, t('system.projectContext.systemAutotuxOption', '— sistema (AutoTux) —'))}</select></span></div>
        <div class="bk-row"><span class="hp-detail"><b>${t('system.projectContext.effortLabel', 'Esfuerzo')}</b></span><span class="bk-actions"><select class="dlg-input" data-pref="defaultEffort">${opt(effortOptions, prefs.defaultEffort, t('system.projectContext.byModelOption', '— según modelo —'))}</select></span></div>
        <div class="bk-row"><span class="hp-detail"><b>${t('system.projectContext.permissionModeLabel', 'Modo de permisos')}</b></span><span class="bk-actions"><select class="dlg-input" data-pref="defaultPermissionMode">${opt(PERM_LABELS, prefs.defaultPermissionMode, t('system.projectContext.systemAskOption', '— sistema (Preguntar) —'))}</select></span></div>
      </div>
      <div class="dlg-actions"><button class="btn" data-ref="savePrefs">${t('system.projectContext.savePrefs', 'Guardar preferencias')}</button></div>
      <p class="hp-empty" data-ref="prefsMsg"></p>`;
    bodyEl.querySelector('[data-ref="savePrefs"]').addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      const patch = {};
      for (const s of bodyEl.querySelectorAll('[data-pref]')) patch[s.dataset.pref] = s.value; // '' = borrar (backend lo interpreta)
      try {
        const res = await fetch(`${PROJECTS_API}/me/prefs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || t('system.projectContext.saveFailed', 'No se pudo guardar.'));
        bodyEl.querySelector('[data-ref="prefsMsg"]').textContent = t('system.projectContext.saved', 'Guardado ✅');
      } catch (err) { bodyEl.querySelector('[data-ref="prefsMsg"]').textContent = err.message || t('system.projectContext.saveFailed', 'No se pudo guardar.'); }
      btn.disabled = false;
    });
  }

  async function renderIdentityDetail(bodyEl) {
    bodyEl.innerHTML = '<span class="cwc-spinner"></span>';
    let data = {};
    try { data = await (await fetch(`${PROJECTS_API}/me/identity`)).json(); }
    catch { bodyEl.innerHTML = `<div class="bk-empty">${t('system.projectContext.identityReadError', 'No se pudo leer la identidad.')}</div>`; return; }
    if (!alive) return;
    const id = data.identity || {};
    const row = (label, val) => `<div class="bk-row"><span class="hp-detail"><b>${esc(label)}</b><br><span class="hp-sev">${esc(val || t('system.projectContext.emptyValue', '(vacío)'))}</span></span></div>`;
    bodyEl.innerHTML = `
      ${data.editable ? '' : `<p class="pj-hint">⚠️ ${t('system.projectContext.identityReadOnlyHint', 'Mostrando la identidad del sistema en modo LECTURA. La edición per-user la habilita SP2 (identidad por-usuario).')}</p>`}
      <div class="bk-list">
        ${row(t('system.projectContext.nameLabel', 'Nombre'), id.name)}
        ${row(t('system.projectContext.emailLabel', 'Email'), id.email)}
        ${row(t('system.projectContext.githubLabel', 'GitHub'), id.github)}
        ${row(t('system.projectContext.signatureLabel', 'Firma'), id.signature)}
      </div>`;
  }

  const ctxRow = () => root.querySelector('[data-ref="ctxRow"]');
  const syncBox = () => root.querySelector('[data-ref="syncBox"]');
  const ctxSectionsEl = () => root.querySelector('[data-ref="ctxSections"]');
  const notesEl = () => root.querySelector('[data-ref="notes"]');

  // ===== Contexto de proyecto: POR SECCIONES (integridad) =====
  // El CLAUDE.md nunca se edita entero desde acá: la lista muestra sus
  // secciones (por encabezados # a ###) y el editor abre SOLO el fragmento
  // elegido — un descuido (select-all + borrar) arruina una sección como
  // mucho. El guardado viaja con el hash de lo que abriste: si otra sesión
  // tocó el archivo en el medio, el server responde 409 y no pisa nada.
  // Modal de REVISIÓN FORZADA del cambio (guardián del CLAUDE.md): analiza
  // viejo vs nuevo con IA (qué se elimina/agrega/modifica + riesgo) y recién
  // el botón "Confirmar y guardar" escribe el archivo. Si el análisis IA
  // falla, cae a un diff local — la revisión consciente sigue siendo
  // obligatoria, nunca se guarda a ciegas. Devuelve true si el usuario
  // confirmó.
  function reviewChange(sec, newText, saveFn) {
    return new Promise((resolve) => {
      let closed = false;
      const m = dialog.openModal({ title: t('system.projectContext.reviewChangeTitle', 'Revisión del cambio'), width: 560, onClose: () => { closed = true; resolve(false); } });
      m.body.innerHTML = `
        <p class="dlg-msg">${t('system.projectContext.sectionProjectMessage', 'Sección <b>{section}</b> — {project}', { section: esc(sec.title), project: esc(entryName(current)) })}</p>
        <div class="cr-body" data-ref="body">
          <p class="hp-running">${pacman({ state: 'delegating' })} ${t('system.projectContext.aiAnalyzingChange', 'La IA está analizando el cambio…')}</p>
        </div>`;
      const body = m.body.querySelector('[data-ref="body"]');

      const list = (items, cls, label) => (items.length ? `
        <div class="cr-group cr-group--${cls}">
          <div class="cr-label">${label}</div>
          <ul class="cr-items">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        </div>` : '');

      const buttons = () => {
        const box = document.createElement('div');
        box.className = 'dlg-actions';
        box.innerHTML = `
          <button class="btn-ghost" data-ref="again">${t('system.projectContext.keepEditing', 'Seguir editando')}</button>
          <button class="btn" data-ref="confirm">${t('system.projectContext.confirmAndSave', 'Confirmar y guardar')}</button>`;
        box.querySelector('[data-ref="again"]').addEventListener('click', () => { resolve(false); m.close(); });
        box.querySelector('[data-ref="confirm"]').addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.innerHTML = `${pacman()}<span>${t('system.projectContext.saving', 'Guardando…')}</span>`;
          try {
            await saveFn();
            resolve(true);
            m.close();
          } catch (err) {
            btn.disabled = false;
            btn.textContent = t('system.projectContext.confirmAndSave', 'Confirmar y guardar');
            const p = document.createElement('p');
            p.className = 'hp-error';
            p.textContent = err.message || t('system.projectContext.saveFailed', 'No se pudo guardar.');
            body.appendChild(p);
          }
        });
        return box;
      };

      const RISK_LABEL = {
        ok: t('system.projectContext.riskOk', 'Sin pérdidas'),
        atencion: t('system.projectContext.riskAttention', 'Requiere atención'),
        critico: t('system.projectContext.riskCritical', 'CRÍTICO'),
      };

      (async () => {
        try {
          // El POST solo LANZA la corrida (runner desacoplado, regla de oro) y
          // devuelve {id, status}; acá se encuesta el resultado persistido en
          // disco — un reinicio del server a mitad del análisis ya no lo
          // pierde. Se toleran fetch fallidos consecutivos (deploy en el
          // medio) antes de caer al diff local.
          const res = await fetch(sectionsUrl(`/section/${sec.i}/analyze`), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: newText, hash: sec.hash }),
          });
          let data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || t('system.projectContext.analysisFailed', 'Falló el análisis.'));
          const jobId = data.id;
          let misses = 0;
          while (data.status === 'running') {
            if (closed) return; // el usuario cerró el modal: dejar de encuestar
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const poll = await fetch(sectionsUrl(`/section/${sec.i}/analyze/${jobId}`));
              const pd = await poll.json().catch(() => ({}));
              if (!poll.ok) throw new Error(pd.error || t('system.projectContext.analysisFailed', 'Falló el análisis.'));
              data = pd;
              misses = 0;
            } catch (err) {
              if (++misses >= 5) throw err; // ~10 s sin respuesta: fallback a diff
            }
          }
          if (closed) return;
          if (data.status !== 'done' || !data.analysis) throw new Error(data.error || t('system.projectContext.analysisFailed', 'Falló el análisis.'));
          const a = data.analysis;
          body.innerHTML = `
            <div class="hp-verdict hp-verdict--${esc(a.risk)}"><b>${RISK_LABEL[a.risk] || a.risk}</b></div>
            ${a.riskWhy ? `<p class="cr-why">${esc(a.riskWhy)}</p>` : ''}
            ${a.summary ? `<p class="cr-summary">${esc(a.summary)}</p>` : ''}
            ${list(a.removed, 'del', t('system.projectContext.removedLabel', '− Se elimina'))}
            ${list(a.added, 'add', t('system.projectContext.addedLabel', '+ Se agrega'))}
            ${list(a.modified, 'mod', t('system.projectContext.modifiedLabel', '~ Se modifica'))}
            ${!a.removed.length && !a.added.length && !a.modified.length ? `<p class="hp-empty">${t('system.projectContext.noContentChangesDetected', 'La IA no detectó cambios de contenido.')}</p>` : ''}`;
          body.appendChild(buttons());
        } catch (e) {
          // Fallback: diff local. La confirmación consciente sigue siendo forzada.
          body.innerHTML = `
            <p class="hp-error">${t('system.projectContext.aiAnalysisErrorReviewDiff', 'No se pudo analizar con IA ({message}). Revisá el diff a mano:', { message: esc(e.message) })}</p>`;
          body.appendChild(renderDiff({ old: sec.text, new: newText }));
          body.appendChild(buttons());
        }
      })();
    });
  }

  function showManagedSection(sec) {
    const m = dialog.openModal({
      title: t('system.projectContext.sectionEditorTitle', 'Sección — {title}', { title: sec.title }),
      width: 760,
    });
    const box = document.createElement('div');
    box.innerHTML = `
      <p class="pj-sync pj-sync--warn">⚙️ ${t('projects.section.managed', 'Generada automáticamente — editá el origen, no este texto.')}</p>
      <textarea class="dlg-editor-text" spellcheck="false" readonly aria-readonly="true"></textarea>
      <div class="dlg-actions">
        <button class="btn-ghost btn--sm" data-ref="close">${t('system.projectContext.close', 'Cerrar')}</button>
      </div>`;
    box.querySelector('.dlg-editor-text').value = sec.text;
    box.querySelector('[data-ref="close"]').addEventListener('click', m.close);
    m.body.appendChild(box);
  }

  async function editSection(section) {
    const i = section.i;
    let sec;
    try {
      const res = await fetch(sectionsUrl(`/section/${i}`));
      sec = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(sec.error || t('system.projectContext.sectionReadError', 'No se pudo leer la sección.'));
    } catch (e) {
      dialog.alertDialog({ title: t('system.projectContext.contextTitle', 'Contexto'), message: e.message });
      return;
    }
    if (section.managed) {
      showManagedSection(sec);
      return;
    }
    await dialog.textEditorDialog({
      title: t('system.projectContext.sectionEditorTitle', 'Sección — {title}', { title: sec.title }),
      hint: t('system.projectContext.sectionEditorHint', 'Editás SOLO esta sección del CLAUDE.md de {project} (el resto del archivo no se toca). Al guardar, una revisión con IA te muestra qué se elimina/agrega/modifica ANTES de escribir.', { project: entryName(current) }),
      value: sec.text,
      width: 760,
      saveLabel: t('system.projectContext.saveSection', 'Guardar sección'),
      onSave: async (text) => {
        if (text === sec.text) return; // sin cambios: cerrar sin gastar análisis
        const confirmed = await reviewChange(sec, text, async () => {
          const res = await fetch(sectionsUrl(`/section/${i}`), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: text, hash: sec.hash }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || t('system.projectContext.saveFailed', 'No se pudo guardar.'));
        });
        if (!confirmed) throw new Error(t('system.projectContext.notSavedReviewAgain', 'No se guardó: revisá el cambio y guardá de nuevo cuando estés conforme.'));
      },
    });
    loadContext();
  }

  async function loadContext() {
    if (!alive || !current) return;
    const box = ctxSectionsEl();
    if (!box) return;
    box.innerHTML = '<span class="cwc-spinner"></span>';
    try {
      const data = await (await fetch(sectionsUrl('/sections'))).json();
      if (!alive || !ctxSectionsEl()) return;
      const totalEl = root.querySelector('[data-ref="ctxTotal"]');
      if (totalEl) totalEl.textContent = `${t('system.projectContext.linesCount', '{count} líneas', { count: data.totalLines })} · ${fmtSize(data.totalSize)}`;
      if (!data.sections.length) {
        ctxSectionsEl().innerHTML = `<div class="bk-empty">${t('system.projectContext.contextEmpty', 'El contexto está vacío.')}</div>`;
        return;
      }
      ctxSectionsEl().innerHTML = data.sections.map((s) => `
        <div class="bk-row pj-sec pj-sec--l${s.level}" data-i="${s.i}">
          <span class="hp-detail">
            <b>${esc(s.title)}</b><br>
            <span class="hp-sev">${t('system.projectContext.linesCount', '{count} líneas', { count: s.lines })} · ${fmtSize(s.size)}</span>
          </span>
          ${isAdmin || current?.kind === 'perso' ? `<span class="bk-actions"><button class="btn-ghost btn--sm btn--icon" data-act="edit" title="${s.managed ? t('projects.section.managed', 'Generada automáticamente — editá el origen, no este texto.') : t('system.projectContext.editOnlyThisSectionTooltip', 'Editar SOLO esta sección')}">${icon(s.managed ? 'eye' : 'edit', { size: 13 })}</button></span>` : ''}
        </div>`).join('');
      for (const row of ctxSectionsEl().querySelectorAll('[data-i]')) {
        const section = data.sections.find((s) => String(s.i) === row.dataset.i);
        row.querySelector('[data-act="edit"]')?.addEventListener('click', () => editSection(section));
      }
    } catch {
      if (alive && ctxSectionsEl()) ctxSectionsEl().innerHTML = `<div class="bk-empty">${t('system.projectContext.contextReadError', 'No se pudo leer el contexto.')}</div>`;
    }
  }

  // ===== Contexto: sub-proyecto de bugfixes (texto libre, sin memorias) =====
  async function editBugfixContext() {
    await dialog.textEditorDialog({
      title: entryTitle(current),
      hint: `${entryHint(current)} ${t('system.projectContext.freeTextNoMemoriesHint', 'Es texto libre (sin memorias asociadas).')}`,
      value: bfContent,
      width: 640,
      saveLabel: t('system.projectContext.save', 'Guardar'),
      onSave: async (text) => {
        const res = await fetch(BUGFIX_API, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: current.bfKind, context: text }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || t('system.projectContext.saveFailed', 'No se pudo guardar.'));
        bfContent = text;
      },
    });
    loadBugfixContext();
    loadSync(); // el guardado re-espejó a Tolkien → refrescar el badge
  }

  async function loadBugfixContext() {
    if (!alive || !current) return;
    const row = ctxRow();
    if (!row) return;
    row.innerHTML = `<span class="hp-empty">${t('system.projectContext.loading', 'cargando…')}</span>`;
    try {
      const data = await (await fetch(`${BUGFIX_API}?kind=${current.bfKind}`)).json();
      if (!alive || !ctxRow()) return;
      bfContent = data.context || '';
      const firstLine = (bfContent.split('\n').find((l) => l.trim()) || t('system.projectContext.emptyValue', '(vacío)')).slice(0, 90);
      ctxRow().innerHTML = `
        <span class="hp-detail"><b>${esc(firstLine)}</b><br>${fmtSize(bfContent.length)}${data.isDefault ? ` · ${t('system.projectContext.viewingDefaultValue', 'viendo el valor por defecto')}` : ''}</span>
        <span class="bk-actions"><button class="btn-ghost btn--sm btn--icon" data-ref="ctxEdit" title="${t('system.projectContext.editContextTooltip', 'Editar contexto')}">${icon('edit', { size: 13 })}</button></span>`;
      ctxRow().querySelector('[data-ref="ctxEdit"]')?.addEventListener('click', editBugfixContext);
    } catch {
      if (alive && ctxRow()) ctxRow().innerHTML = `<span class="hp-empty">${t('system.projectContext.contextReadError', 'No se pudo leer el contexto.')}</span>`;
    }
  }

  // ===== Verificador del ESPEJO a Tolkien (solo sub-proyectos de Tickets&Feat) =====
  // El subset work+pr se espeja al CLAUDE.local.md del clon propio del usuario
  // (local, no versionado), que auto-carga en TODA sesión de Tolkien. Este bloque
  // muestra si está al día y ofrece re-sincronizar a mano.
  const SYNC_UI = {
    ok: { cls: 'pj-sync--ok', ico: '✅', msgKey: 'system.projectContext.syncOkForUser', msg: 'Espejo al día en {file}.' },
    stale: { cls: 'pj-sync--warn', ico: '⚠️', msgKey: 'system.projectContext.syncStaleForUser', msg: 'El espejo en {file} quedó <b>desactualizado</b> — re-sincronizá.' },
    missing: { cls: 'pj-sync--warn', ico: '⚠️', msgKey: 'system.projectContext.syncMissingForUser', msg: 'Falta la sección gestionada en {file} — re-sincronizá.' },
    unavailable: { cls: 'pj-sync--warn', ico: '❓', msgKey: 'system.projectContext.syncUnavailableForUser', msg: 'No pude leer {file} (¿Tolkien presente?).' },
  };
  async function loadSync() {
    const box = syncBox();
    if (!box) return;
    box.innerHTML = `<span class="hp-empty">${t('system.projectContext.checkingTolkienMirror', 'verificando espejo con Tolkien…')}</span>`;
    let s = { status: 'unavailable' };
    try { s = await (await fetch('/api/tickets/context-sync')).json(); } catch { /* red caída */ }
    if (!alive || !syncBox()) return;
    const u = SYNC_UI[s.status] || SYNC_UI.unavailable;
    const mirrorFile = `<code>${esc(s.file || 'CLAUDE.local.md')}</code>`;
    const statusMessage = t(u.msgKey, u.msg, { file: mirrorFile });
    const resyncBtn = s.status !== 'ok'
      ? `<button class="btn-ghost btn--sm" data-ref="resync">${t('system.projectContext.resync', 'Re-sincronizar')}</button>` : '';
    syncBox().className = `pj-sync ${u.cls}`;
    syncBox().innerHTML = `
      <div class="pj-sync-line"><span class="pj-sync-ico">${u.ico}</span><span>${statusMessage}</span>${resyncBtn}</div>
      <p class="pj-sync-note">${t('system.projectContext.syncNoteForUser', 'Al guardar acá, tu contexto se publica como texto físico en {file} (archivo <b>local, NO versionado</b>) para que <b>toda</b> sesión de Tolkien lo cargue sola. Tu fuente completa vive en esta consola.', { file: mirrorFile })}</p>`;
    syncBox().querySelector('[data-ref="resync"]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = t('system.projectContext.syncing', 'Sincronizando…');
      try {
        const res = await fetch('/api/tickets/context-sync', { method: 'POST' });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || t('system.projectContext.syncFailed', 'No se pudo sincronizar.'));
      } catch (err) { await dialog.alertDialog({ title: t('system.projectContext.errorTitle', 'Error'), message: err.message || t('system.projectContext.syncFailed', 'No se pudo sincronizar.') }); }
      loadSync();
    });
  }

  // ===== Memorias (solo proyectos completos) =====
  async function editNote(file, title) {
    let content = '';
    let hash = '';
    try {
      const data = await (await fetch(projectApi(`/memory/note/${encodeURIComponent(file)}`))).json();
      content = data.content || '';
      hash = data.hash || '';
    } catch { /* arranca vacío si falló la lectura */ }
    await dialog.textEditorDialog({
      title: t('system.projectContext.memoryEditorTitle', 'Memoria — {title}', { title: title || file }),
      hint: t('system.projectContext.fileHint', 'Archivo: {file}', { file }),
      value: content,
      width: 640,
      saveLabel: t('system.projectContext.save', 'Guardar'),
      onSave: async (text) => {
        // El hash de lo que se abrió viaja en el guardado: si Claude Code
        // (o un admin desde otra pestaña) tocó la nota en el medio, el
        // server devuelve 409 en vez de pisarla en silencio.
        const res = await fetch(projectApi(`/memory/note/${encodeURIComponent(file)}`), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text, hash }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(res.status === 409
          ? t('system.projectContext.noteConflictReload', '{error} Recargá esta nota para ver el cambio ajeno antes de reintentar.', { error: data.error })
          : (data.error || t('system.projectContext.saveFailed', 'No se pudo guardar.')));
      },
    });
    loadNotes();
  }

  async function editIndex() {
    await dialog.textEditorDialog({
      title: t('system.projectContext.memoryIndexTitle', 'Índice de memorias — MEMORY.md'),
      hint: t('system.projectContext.memoryIndexHint', 'Una línea por nota: "- [Título](archivo.md) — descripción corta".'),
      value: indexContent,
      width: 640,
      saveLabel: t('system.projectContext.save', 'Guardar'),
      onSave: async (text) => {
        // Mismo chequeo de hash que las notas: MEMORY.md lo escribe Claude
        // Code en vivo a partir de feedback real de las conversaciones.
        const res = await fetch(projectApi('/memory/index'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text, hash: indexHash }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(res.status === 409
          ? t('system.projectContext.indexConflictReload', '{error} Recargá el índice para ver el cambio ajeno antes de reintentar.', { error: data.error })
          : (data.error || t('system.projectContext.saveFailed', 'No se pudo guardar.')));
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
      indexHash = data.indexHash || '';
      if (!data.files.length) {
        notesEl().innerHTML = `<div class="bk-empty">${t('system.projectContext.noMemoriesYet', 'Todavía no hay memorias registradas para este proyecto.')}</div>`;
        return;
      }
      notesEl().innerHTML = data.files.map((f) => `
        <div class="bk-row" data-file="${esc(f.file)}">
          <span class="hp-detail">
            <b>${esc(f.title)}</b>${f.orphan ? ` <span class="hp-sev" title="${t('system.projectContext.orphanTooltip', 'No está listada en el índice MEMORY.md')}">${t('system.projectContext.orphanLabel', '(huérfana)')}</span>` : ''}<br>
            ${esc(f.description)}${f.updatedAt ? ` <span class="hp-sev">· ${fmtWhen(f.updatedAt)}</span>` : ''}
          </span>
          ${isAdmin ? `<span class="bk-actions"><button class="btn-ghost btn--sm btn--icon" data-act="edit" title="${t('system.projectContext.editNoteTooltip', 'Editar nota')}">${icon('edit', { size: 13 })}</button></span>` : ''}
        </div>`).join('');
      for (const row of notesEl().querySelectorAll('[data-file]')) {
        row.querySelector('[data-act="edit"]')?.addEventListener('click', () => editNote(row.dataset.file, row.querySelector('b')?.textContent));
      }
    } catch {
      if (alive && notesEl()) notesEl().innerHTML = `<div class="bk-empty">${t('system.projectContext.memoryReadError', 'No se pudo leer la memoria.')}</div>`;
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
        descKey: PROJECT_META[p.key]?.descKey,
        desc: PROJECT_META[p.key]?.desc || homeShort(p.dir),
      })),
      ...BUGFIX_ENTRIES,
      ...PERSO_ENTRIES,
    ];
    if (!alive) return;
    if (!entries.length) {
      root.innerHTML = `<span class="hp-empty">${t('system.projectContext.projectListReadError', 'No se pudo leer la lista de proyectos.')}</span>`;
      return;
    }
    renderList();
  }

  init();
}
