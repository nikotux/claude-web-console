// modules/system/skills-panel.js — pestaña "Skills" de ⚙ Sistema: censo
// READ-ONLY de las skills de Claude Code (SKILL.md) cruzadas con los
// Playbooks de Pad local, agrupadas por mundo (🏠 Mi Consola / 🌳 Tolkien /
// 🌐 Global). Reusa el look de tarjeta colapsable de health-review-modal
// (.hr-collapsible/.hr-finding/.hr-f-*) — casi sin CSS nuevo, solo 2
// modificadores de color para el estado de sincronía con Pad.
//
// Solo lectura a propósito (decisión explícita 2026-07-19): sin crear/editar
// SKILL.md ni playbooks desde acá todavía.
import { icon } from '../../ui/icons.js';

const WORLD_ORDER = ['console', 'tolkien', 'global'];
const WORLD_META = {
  console: { label: '🏠 Mi Consola', open: true },
  tolkien: { label: '🌳 Tolkien', open: false },
  global: { label: '🌐 Global (usuario)', open: false },
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Borde de color de la tarjeta según qué tan "sincronizada" está con Pad —
// no es severidad, pero reusa la misma escala visual (ok/warn/neutro).
function syncClass(sk) {
  if (sk.padRef) return sk.pad ? 'hr-finding--linked' : 'hr-finding--orphan';
  return 'hr-finding--low'; // sin pie "Fuente de verdad": no se espera vínculo (ej. skill built-in)
}
function syncBadge(sk) {
  if (sk.pad) return `<span class="hr-sev hr-sev--linked" title="Vinculado a ${esc(sk.pad.ref)} en Pad (fuente de verdad del procedimiento)">✅ ${esc(sk.pad.ref)}</span>`;
  if (sk.padRef) return `<span class="hr-sev hr-sev--orphan" title="El SKILL.md referencia ${esc(sk.padRef)} pero no se encontró (o no está) en Pad">⚠ ref rota</span>`;
  return `<span class="hr-kind">— sin Pad</span>`;
}

function skillCard(sk, i) {
  const collapsed = i > 0 ? ' hr-collapsed' : '';
  const tools = sk.allowedTools?.length ? `<div class="hr-f-file">🔧 herramientas: ${sk.allowedTools.map(esc).join(', ')}</div>` : '';
  const hint = sk.argumentHint ? `<div class="hr-f-file">⌨ argumentos: <code>${esc(sk.argumentHint)}</code></div>` : '';
  const padLine = sk.pad
    ? `<div class="hr-f-file">📘 ${esc(sk.pad.ref)} · trigger ${esc(sk.pad.trigger || '—')} · scope ${esc(sk.pad.scope || '—')}</div>`
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
        <p class="hr-f-detail">${esc(sk.description) || '<i>sin descripción</i>'}</p>
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
        <div class="hr-f-file">trigger ${esc(c.trigger || '—')} · scope ${esc(c.scope || '—')} — playbook activo con invocation_slug, sin SKILL.md espejado todavía</div>
      </div>
    </div>`;
}

export function mountSkillsPanel(el) {
  el.innerHTML = '<div data-ref="root"><span class="cwc-spinner"></span></div>';
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
    const byWorld = new Map(WORLD_ORDER.map((w) => [w, []]));
    for (const sk of d.skills || []) (byWorld.get(sk.world) || byWorld.get('global')).push(sk);

    const groups = WORLD_ORDER.map((w) => {
      const list = byWorld.get(w);
      if (!list.length) return '';
      const meta = WORLD_META[w];
      return `<details class="hr-collapsible"${meta.open ? ' open' : ''}>
        <summary>${meta.label} (${list.length})</summary>
        <div class="hr-findings">${list.map(skillCard).join('')}</div>
      </details>`;
    }).join('');

    const candidates = d.padOnly || [];
    const candSec = candidates.length
      ? `<details class="hr-collapsible"><summary>🆕 Candidatos de Pad sin SKILL.md (${candidates.length})</summary>
          <div class="hr-findings">${candidates.map(candidateRow).join('')}</div>
        </details>`
      : '';

    const warn = d.padAvailable === false
      ? '<p class="hr-f-crit">⚠️ Pad local no respondió — se muestran solo los SKILL.md, sin estado de sincronía.</p>'
      : '';

    root.innerHTML = `
      <p class="pj-hint">Skills de Claude Code (SKILL.md) cruzadas con los Playbooks de Pad local — solo lectura.</p>
      ${warn}
      ${groups || '<p class="hr-summary">No se encontraron skills.</p>'}
      ${candSec}
    `;
    wireToggles();
  }

  async function load() {
    root.innerHTML = '<span class="cwc-spinner"></span>';
    let d;
    try {
      const res = await fetch('/api/skills');
      d = await res.json();
    } catch {
      d = null;
    }
    if (!alive) return;
    if (!d) { root.innerHTML = '<p class="hr-summary">No se pudo cargar el censo de skills.</p>'; return; }
    render(d);
  }

  load();
}
