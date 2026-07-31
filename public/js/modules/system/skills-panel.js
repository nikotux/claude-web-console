// modules/system/skills-panel.js — pestaña "Skills" de ⚙ Sistema: catálogo
// instalable por usuario + censo informativo de las skills de Claude Code
// (SKILL.md) cruzadas con los Playbooks de Pad. Reusa el look de tarjeta
// colapsable de health-review-modal (.hr-collapsible/.hr-finding/.hr-f-*).
import { alertDialog, confirmDialog } from '../../ui/dialog.js';
import { icon } from '../../ui/icons.js';
import { helpBtn } from '../../ui/help.js';
import { t } from '../../ui/i18n.js';
import { pacman } from '../../ui/pacman.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Borde de color de la tarjeta según qué tan "sincronizada" está con Pad —
// no es severidad, pero reusa la misma escala visual (ok/warn/neutro).
function syncClass(sk) {
  if (sk.padRef) return sk.pad ? 'hr-finding--linked' : 'hr-finding--orphan';
  return 'hr-finding--low'; // sin pie "Fuente de verdad": no se espera vínculo (ej. skill built-in)
}
function syncBadge(sk) {
  if (sk.pad) return `<span class="hr-sev hr-sev--linked" title="${t('system.skills.linkedTitle', 'Vinculado a {ref} en Pad (fuente de verdad del procedimiento)', { ref: esc(sk.pad.ref) })}">✅ ${esc(sk.pad.ref)}</span>`;
  if (sk.padRef) return `<span class="hr-sev hr-sev--orphan" title="${t('system.skills.brokenRefTitle', 'El SKILL.md referencia {ref} pero no se encontró (o no está) en Pad', { ref: esc(sk.padRef) })}">⚠ ${t('system.skills.brokenRef', 'ref rota')}</span>`;
  return `<span class="hr-kind">— ${t('system.skills.noPad', 'sin Pad')}</span>`;
}

function skillCard(sk, i) {
  const collapsed = ' hr-collapsed';
  const tools = sk.allowedTools?.length ? `<div class="hr-f-file">🔧 ${t('system.skills.toolsLabel', 'herramientas')}: ${sk.allowedTools.map(esc).join(', ')}</div>` : '';
  const hint = sk.argumentHint ? `<div class="hr-f-file">⌨ ${t('system.skills.argumentsLabel', 'argumentos')}: <code>${esc(sk.argumentHint)}</code></div>` : '';
  const padLine = sk.pad
    ? `<div class="hr-f-file">📘 ${esc(sk.pad.ref)} · ${t('system.skills.triggerLabel', 'trigger')} ${esc(sk.pad.trigger || '—')} · ${t('system.skills.scopeLabel', 'scope')} ${esc(sk.pad.scope || '—')}</div>`
    : '';
  return `
    <div class="hr-finding ${syncClass(sk)}${collapsed}" data-key="${esc(sk.key)}">
      <div class="hr-f-head" data-toggle="1">
        <span class="hr-chev">${icon('chevronDown', { size: 13 })}</span>
        ${syncBadge(sk)}
        <span class="hr-f-area">${esc(sk.name)}</span>
        <span class="hr-f-mod">${esc(sk.dirName)}</span>
      </div>
      <div class="hr-f-body">
        <p class="hr-f-detail">${esc(sk.description) || `<i>${t('system.skills.noDescription', 'sin descripción')}</i>`}</p>
        ${hint}${tools}${padLine}
        <div class="hr-f-file">📄 ${esc(sk.path)}</div>
      </div>
    </div>`;
}

function catalogClass(sk) {
  if (sk.outdated) return 'hr-finding--orphan';
  if (sk.installed) return 'hr-finding--linked';
  return 'hr-finding--low';
}

function catalogBadge(sk) {
  if (sk.outdated) {
    return `<span class="hr-sev hr-sev--orphan">${t('system.skills.catalog.status.outdated', '⬆️ actualización disponible')}</span>`;
  }
  if (sk.installed) {
    return `<span class="hr-sev hr-sev--linked">${t('system.skills.catalog.status.installed', '✅ instalada')}</span>`;
  }
  return `<span class="hr-sev hr-sev--low">${t('system.skills.catalog.status.notInstalled', '⬜ no instalada')}</span>`;
}

function catalogActions(sk) {
  const remove = `
    <button class="btn-ghost btn--sm btn--danger" data-catalog-action="uninstall" title="${t('system.skills.catalog.removeTitle', 'Quita esta copia de tu espacio personal')}">
      ${icon('trash', { size: 13 })}<span>${t('system.skills.catalog.remove', 'Quitar')}</span>
    </button>`;
  const reinstall = `
    <button class="btn-ghost btn--sm" data-catalog-action="reinstall" title="${t('system.skills.catalog.reinstallTitle', 'Vuelve a copiar la versión del catálogo sobre tu copia local')}">
      ${icon('refresh', { size: 13 })}<span>${t('system.skills.catalog.reinstall', 'Reinstalar')}</span>
    </button>`;
  if (!sk.installed) {
    return `
      <button class="btn btn--sm" data-catalog-action="install" title="${t('system.skills.catalog.installTitle', 'Copia esta skill a tu espacio personal')}">
        ${icon('download', { size: 13 })}<span>${t('system.skills.catalog.install', 'Instalar')}</span>
      </button>`;
  }
  if (sk.outdated) {
    return `
      <button class="btn btn--sm" data-catalog-action="install" title="${t('system.skills.catalog.updateTitle', 'Reemplaza la copia del catálogo por la versión actual')}">
        ${icon('refresh', { size: 13 })}<span>${t('system.skills.catalog.update', 'Actualizar')}</span>
      </button>
      ${remove}`;
  }
  return `${reinstall}
      ${remove}`;
}

function catalogCard(sk) {
  const defaultMark = sk.isDefault
    ? `<span class="hr-kind" title="${t('system.skills.catalog.defaultTitle', 'Se instala automáticamente a los usuarios nuevos')}">${t('system.skills.catalog.defaultBadge', '⭐ predeterminada')}</span>`
    : '';
  return `
    <div class="hr-finding ${catalogClass(sk)} hr-collapsed" data-catalog-dir="${esc(sk.dirName)}">
      <div class="hr-f-head" data-toggle="1">
        <span class="hr-chev">${icon('chevronDown', { size: 13 })}</span>
        ${catalogBadge(sk)}
        <span class="hr-f-area">${esc(sk.name)}</span>
        ${defaultMark}
        <span class="hr-f-mod">${esc(sk.dirName)}</span>
      </div>
      <div class="hr-f-body">
        <p class="hr-f-detail">${esc(sk.description) || `<i>${t('system.skills.noDescription', 'sin descripción')}</i>`}</p>
        <div class="hr-f-actions">${catalogActions(sk)}</div>
      </div>
    </div>`;
}

function candidateRow(c) {
  return `
    <div class="hr-finding hr-finding--medium">
      <div class="hr-f-head">
        <span class="hr-sev hr-sev--medium">🆕</span>
        <span class="hr-f-area">${esc(c.title)}</span>
        <span class="hr-f-mod">${esc(c.ref)} · /${esc(c.invocationSlug)}</span>
      </div>
      <div class="hr-f-body">
        <p class="hr-f-detail">${esc(c.summary)}</p>
        <div class="hr-f-file">${t('system.skills.triggerLabel', 'trigger')} ${esc(c.trigger || '—')} · ${t('system.skills.scopeLabel', 'scope')} ${esc(c.scope || '—')} — ${t('system.skills.padOnlyDetail', 'playbook activo con invocation_slug, sin SKILL.md espejado todavía')}</div>
      </div>
    </div>`;
}

export function mountSkillsPanel(el) {
  el.innerHTML = `
    <div class="hp-head">
      <span class="hp-title">${t('system.help.skills.title', 'Skills')}</span>
      ${helpBtn('sys-skills')}
    </div>
    <div data-ref="root">${pacman({ size: 'sm' })} <span class="hr-summary">${t('system.skills.loading', 'Cargando skills…')}</span></div>`;
  const root = el.querySelector('[data-ref="root"]');

  let alive = true;
  const obs = new MutationObserver(() => { if (!el.isConnected) { alive = false; obs.disconnect(); } });
  obs.observe(document.body, { childList: true, subtree: true });

  function wireToggles() {
    root.querySelectorAll('[data-toggle]').forEach((head) => {
      head.addEventListener('click', () => head.closest('.hr-finding')?.classList.toggle('hr-collapsed'));
    });
  }

  async function requestCatalog(action, dirName) {
    const res = await fetch(`/api/skills/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dirName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const fallback = action === 'install'
        ? t('system.skills.catalog.installError', 'No se pudo instalar la skill.')
        : t('system.skills.catalog.uninstallError', 'No se pudo quitar la skill.');
      const error = new Error(data.error || fallback);
      error.code = data.code || 'catalog_action_failed';
      throw error;
    }
    return data;
  }

  async function runCatalogAction(card, sk, action) {
    if (action === 'uninstall') {
      const confirmed = await confirmDialog({
        title: t('system.skills.catalog.removeConfirmTitle', 'Quitar skill'),
        message: t('system.skills.catalog.removeConfirmMessage', '¿Quitar “{name}” de tu espacio? La copia del catálogo se borra solo para tu usuario.', { name: sk.name }),
        confirmLabel: t('system.skills.catalog.remove', 'Quitar'),
        danger: true,
      });
      if (!confirmed || !alive) return;
    }
    if (action === 'reinstall') {
      const confirmed = await confirmDialog({
        title: t('system.skills.catalog.reinstallConfirmTitle', 'Reinstalar skill'),
        message: t('system.skills.catalog.reinstallConfirmMessage', '¿Volver a copiar “{name}” desde el catálogo? Reemplaza tu copia local: si la editaste a mano, ese cambio se pierde.', { name: sk.name }),
        confirmLabel: t('system.skills.catalog.reinstall', 'Reinstalar'),
      });
      if (!confirmed || !alive) return;
    }

    const buttons = [...card.querySelectorAll('[data-catalog-action]')];
    buttons.forEach((button) => { button.disabled = true; });
    const actions = card.querySelector('.hr-f-actions');
    const busyText = action === 'uninstall'
      ? t('system.skills.catalog.removing', 'Quitando…')
      : (action === 'reinstall'
          ? t('system.skills.catalog.reinstalling', 'Reinstalando…')
          : (sk.outdated
              ? t('system.skills.catalog.updating', 'Actualizando…')
              : t('system.skills.catalog.installing', 'Instalando…')));
    actions?.insertAdjacentHTML('afterbegin', `<span class="hr-f-fixing">${pacman({ size: 'sm' })}<span>${busyText}</span></span>`);

    let error = null;
    const endpoint = action === 'reinstall' ? 'install' : action;
    try {
      await requestCatalog(endpoint, sk.dirName);
    } catch (err) {
      error = err;
    }

    await load();
    if (!alive) return;

    if (error) {
      const userOwned = error.code === 'user_owned';
      await alertDialog({
        title: userOwned
          ? t('system.skills.catalog.ownSkillTitle', 'Skill propia protegida')
          : t('system.skills.catalog.actionErrorTitle', 'No se pudo cambiar la skill'),
        message: userOwned
          ? t('system.skills.catalog.ownSkillMessage', 'Ya existe una skill propia con ese nombre en tu espacio. Mi Consola no pisa ni borra skills que no instaló desde el catálogo.')
          : error.message,
      });
      return;
    }

    if (action === 'install' || action === 'reinstall') {
      await alertDialog({
        title: action === 'reinstall'
          ? t('system.skills.catalog.reinstalledTitle', 'Skill reinstalada')
          : (sk.outdated
              ? t('system.skills.catalog.updatedTitle', 'Skill actualizada')
              : t('system.skills.catalog.installedTitle', 'Skill instalada')),
        message: t('system.skills.catalog.restartNotice', 'La skill ya está en tu espacio. Una sesión de chat que ya estaba abierta no la carga hasta reiniciarse, porque cada runner toma sus skills al nacer.'),
      });
    }
  }

  function wireCatalogActions(catalog) {
    const byDir = new Map(catalog.map((sk) => [sk.dirName, sk]));
    root.querySelectorAll('[data-catalog-dir]').forEach((card) => {
      const sk = byDir.get(card.dataset.catalogDir);
      if (!sk) return;
      card.querySelectorAll('[data-catalog-action]').forEach((button) => {
        button.addEventListener('click', () => runCatalogAction(card, sk, button.dataset.catalogAction));
      });
    });
  }

  function render(d) {
    const byWorld = new Map();
    for (const sk of d.skills || []) {
      const world = sk.world || 'unknown';
      if (!byWorld.has(world)) byWorld.set(world, { label: sk.worldLabel || world, skills: [] });
      byWorld.get(world).skills.push(sk);
    }

    const groups = [...byWorld.values()].map((group) => {
      return `<details class="hr-collapsible">
        <summary>${esc(group.label)} (${group.skills.length})</summary>
        <div class="hr-findings">${group.skills.map(skillCard).join('')}</div>
      </details>`;
    }).join('');

    const candidates = d.padOnly || [];
    const candSec = candidates.length
      ? `<details class="hr-collapsible"><summary>🆕 ${t('system.skills.padCandidatesTitle', 'Candidatos de Pad sin SKILL.md')} (${candidates.length})</summary>
          <div class="hr-findings">${candidates.map(candidateRow).join('')}</div>
        </details>`
      : '';

    const warn = d.padAvailable === false
      ? `<p class="hr-f-crit">⚠️ ${t('system.skills.padUnavailable', 'Pad local no respondió — se muestran solo los SKILL.md, sin estado de sincronía.')}</p>`
      : '';

    const catalog = d.catalog || [];
    const installed = catalog.filter((sk) => sk.installed).length;
    const outdated = catalog.filter((sk) => sk.outdated).length;
    const catalogSummary = t(
      'system.skills.catalog.summary',
      '📦 Catálogo · {available} disponibles · {installed} instaladas · {outdated} con actualización',
      { available: catalog.length, installed, outdated },
    );
    const catalogSection = `
      <details class="hr-collapsible">
        <summary>${catalogSummary}</summary>
        <div class="hr-findings">
          ${catalog.length
            ? catalog.map(catalogCard).join('')
            : `<p class="hr-summary">${t('system.skills.catalog.empty', 'No hay skills compartibles en el catálogo.')}</p>`}
        </div>
      </details>`;

    root.innerHTML = `
      ${catalogSection}
      <p class="pj-hint">${t('system.skills.hint', 'Censo informativo de skills de Claude Code (SKILL.md) cruzadas con los Playbooks de Pad local.')}</p>
      ${warn}
      ${groups || `<p class="hr-summary">${t('system.skills.noneFound', 'No se encontraron skills.')}</p>`}
      ${candSec}
    `;
    wireToggles();
    wireCatalogActions(catalog);
  }

  async function load() {
    root.innerHTML = `${pacman({ size: 'sm' })} <span class="hr-summary">${t('system.skills.loading', 'Cargando skills…')}</span>`;
    let d;
    try {
      const res = await fetch('/api/skills');
      d = await res.json();
      if (!res.ok) d = null;
    } catch {
      d = null;
    }
    if (!alive) return;
    if (!d) { root.innerHTML = `<p class="hr-summary">${t('system.skills.loadError', 'No se pudo cargar el censo de skills.')}</p>`; return; }
    render(d);
  }

  load();
}
