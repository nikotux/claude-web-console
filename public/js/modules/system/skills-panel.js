// modules/system/skills-panel.js — pestaña "Skills" de ⚙ Sistema: censo
// READ-ONLY de las skills de Claude Code (SKILL.md) cruzadas con los
// Playbooks de Pad del usuario, agrupadas según los mundos que devuelve el
// backend. Reusa el look de tarjeta colapsable de health-review-modal
// (.hr-collapsible/.hr-finding/.hr-f-*) — casi sin CSS nuevo, solo 2
// modificadores de color para el estado de sincronía con Pad.
//
// Solo lectura a propósito (decisión explícita 2026-07-19): sin crear/editar
// SKILL.md ni playbooks desde acá todavía.
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
  const collapsed = i > 0 ? ' hr-collapsed' : '';
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

  function render(d) {
    const byWorld = new Map();
    for (const sk of d.skills || []) {
      const world = sk.world || 'unknown';
      if (!byWorld.has(world)) byWorld.set(world, { label: sk.worldLabel || world, skills: [] });
      byWorld.get(world).skills.push(sk);
    }

    const groups = [...byWorld.values()].map((group, i) => {
      return `<details class="hr-collapsible"${i === 0 ? ' open' : ''}>
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

    root.innerHTML = `
      <p class="pj-hint">${t('system.skills.hint', 'Skills de Claude Code (SKILL.md) cruzadas con los Playbooks de Pad local — solo lectura.')}</p>
      ${warn}
      ${groups || `<p class="hr-summary">${t('system.skills.noneFound', 'No se encontraron skills.')}</p>`}
      ${candSec}
    `;
    wireToggles();
  }

  async function load() {
    root.innerHTML = `${pacman({ size: 'sm' })} <span class="hr-summary">${t('system.skills.loading', 'Cargando skills…')}</span>`;
    let d;
    try {
      const res = await fetch('/api/skills');
      d = await res.json();
    } catch {
      d = null;
    }
    if (!alive) return;
    if (!d) { root.innerHTML = `<p class="hr-summary">${t('system.skills.loadError', 'No se pudo cargar el censo de skills.')}</p>`; return; }
    render(d);
  }

  load();
}
