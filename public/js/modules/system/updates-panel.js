// modules/system/updates-panel.js — pestaña "🔄 Actualizaciones" de ⚙ Sistema →
// 🩺 Diagnóstico. Censo de versiones de terceros + BOTÓN ÚNICO de actualización
// orquestada (planea el orden → drena las sesiones por interfono → aplica npm/CLI/
// apt → verifica → reinicia → reanuda). Ver src/modules/updates/ para la lógica.
//
// Layout: cada ítem es de 2 columnas — una GRANDE con el texto y una CHICA con el
// estado/versión (pedido de Niko). El botón único reemplaza los updates manuales;
// los per-ítem quedan de respaldo en "modo avanzado".
import { icon } from '../../ui/icons.js';
import { pacman } from '../../ui/pacman.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const RISK_META = {
  core: { badge: '🧬', cls: 'hr-sev--medium', label: 'motor' },
  watch: { badge: '🔴', cls: 'hr-sev--high', label: 'vigilada' },
  lib: { badge: '📦', cls: 'hr-sev--low', label: 'librería' },
};
const SEV_META = {
  critical: { emoji: '🔴', cls: 'hr-sev--high', label: 'crítica' },
  high: { emoji: '🟠', cls: 'hr-sev--high', label: 'alta' },
  moderate: { emoji: '🟡', cls: 'hr-sev--medium', label: 'media' },
  low: { emoji: '🟢', cls: 'hr-sev--low', label: 'baja' },
  unknown: { emoji: '⚪', cls: 'hr-sev--low', label: '—' },
};
const PHASES = [
  { id: 'queued', emoji: '⏳', label: 'En cola' },
  { id: 'planning', emoji: '🧭', label: 'Planeando' },
  { id: 'draining', emoji: '📨', label: 'Drenando sesiones' },
  { id: 'applying', emoji: '⚙️', label: 'Aplicando' },
  { id: 'verifying', emoji: '🩺', label: 'Verificando' },
  { id: 'restarting', emoji: '🔁', label: 'Reiniciando' },
  { id: 'reverting', emoji: '↩️', label: 'Revirtiendo' },
  { id: 'resuming', emoji: '📨', label: 'Reanudando' },
  { id: 'done', emoji: '✅', label: 'Listo' },
];
const STEP_ICON = { pending: '○', running: '◔', ok: '✅', fail: '❌', skipped: '⤼' };

// Ítem de 2 columnas: main (texto grande) · side (estado/versión chica). Layout
// por CSS grid inline (px = layout, no color — respeta la convención de tokens).
function twoCol(main, side, { border = 'hr-finding--low' } = {}) {
  return `<div class="hr-finding ${border}" style="display:grid;grid-template-columns:1fr auto;gap:.6rem;align-items:start">
    <div class="hr-f-body" style="margin:0;min-width:0">${main}</div>
    <div style="text-align:right;white-space:nowrap;font-size:.82em">${side}</div>
  </div>`;
}

function collapsible(title, side, body, { border = 'hr-finding--low', open = false } = {}) {
  return `<div class="hr-finding ${border}${open ? '' : ' hr-collapsed'}">
    <div class="hr-f-head" data-toggle="1" style="display:grid;grid-template-columns:auto 1fr auto;gap:.5rem;align-items:center">
      <span class="hr-chev">${icon('chevronDown', { size: 13 })}</span>
      <span class="hr-f-area" style="min-width:0">${title}</span>
      <span style="text-align:right;white-space:nowrap;font-size:.82em">${side}</span>
    </div>
    <div class="hr-f-body">${body}</div>
  </div>`;
}

function infoBlock(info) {
  if (!info) return '';
  if (typeof info === 'string') return `<div class="hr-f-file">${esc(info)}</div>`;
  const what = info.what ? `<div class="hr-f-file"><b>Qué es:</b> ${esc(info.what)}</div>` : '';
  const role = info.role ? `<div class="hr-f-file"><b>Para qué lo usa la consola:</b> ${esc(info.role)}</div>` : '';
  const used = info.usedIn?.length ? `<div class="hr-f-file"><b>Dónde se usa:</b> <code>${info.usedIn.map(esc).join('</code>, <code>')}</code></div>` : '';
  return what + role + used;
}

export function mountUpdatesPanel(el, ctx = {}) {
  const isAdmin = !!ctx.isAdmin;
  const dialog = ctx.dialog;
  el.innerHTML = `<div data-ref="root">${pacman({ size: 'sm' })} <span class="hr-summary">Escaneando versiones de terceros…</span></div>`;
  const root = el.querySelector('[data-ref="root"]');

  let alive = true;
  let pollTimer = null;
  let riskTimer = null;
  const state = { census: null, risk: null }; // cache para re-render sin re-fetch
  const obs = new MutationObserver(() => { if (!el.isConnected) { alive = false; obs.disconnect(); if (pollTimer) clearTimeout(pollTimer); if (riskTimer) clearTimeout(riskTimer); } });
  obs.observe(document.body, { childList: true, subtree: true });

  const api = {
    async census(fresh) { return (await fetch('/api/updates' + (fresh ? '?fresh=1' : ''))).json(); },
    async refresh() { return (await fetch('/api/updates/refresh', { method: 'POST' })).json(); },
    async run(includeMajors = []) { return (await fetch('/api/updates/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ includeMajors }) })).json(); },
    async runStatus() { return (await fetch('/api/updates/run-status')).json(); },
    async updateNpm(pkg, version) { return (await fetch('/api/updates/npm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pkg, version }) })).json(); },
    async healthChecks() { try { return (await fetch('/api/health/checks')).json(); } catch { return null; } },
    async analyze() { return (await fetch('/api/updates/analyze', { method: 'POST' })).json(); },
    async risk() { try { return (await fetch('/api/updates/risk')).json(); } catch { return null; } },
    async auditFix() { return (await fetch('/api/updates/audit-fix', { method: 'POST' })).json(); },
  };
  const riskKey = (name, from, to) => `${name}@${from || '?'}->${to || '?'}`;
  const LEVEL_META = {
    seguro: { emoji: '🟢', cls: 'hr-sev--low', label: 'seguro' },
    riesgoso: { emoji: '🟡', cls: 'hr-sev--medium', label: 'riesgoso' },
    rompe: { emoji: '🔴', cls: 'hr-sev--high', label: 'rompe' },
  };
  function blockedMajorReason(verdict) {
    if (!verdict) return 'sin veredicto IA';
    if (verdict.level === 'rompe') return 'veredicto IA: rompe';
    if (verdict.level === 'riesgoso' && verdict.confidence === 'baja') return 'riesgoso con confianza baja';
    return null;
  }

  async function notify(text) {
    if (dialog?.alertDialog) return dialog.alertDialog({ title: 'Actualizaciones', message: text });
    console.error('[updates] diálogo no disponible; aviso no mostrado:', text); // sin fallback a alert() nativo (convención del proyecto)
  }
  async function confirm(text) {
    if (dialog?.confirmDialog) return dialog.confirmDialog({ title: 'Confirmar actualización', message: text, danger: true, confirmLabel: 'Actualizar todo' });
    // Sin diálogo no se puede confirmar una acción destructiva: fail-safe = NO proceder.
    console.error('[updates] diálogo no disponible; se cancela la acción por seguridad.');
    return false;
  }

  function wireToggles() {
    root.querySelectorAll('[data-toggle]').forEach((head) => {
      head.addEventListener('click', (e) => { if (e.target.closest('button, input, label')) return; head.closest('.hr-finding,details')?.classList.toggle('hr-collapsed'); });
    });
  }

  // ───────── Vista de PROGRESO del job orquestado ─────────
  function renderProgress(job) {
    const curIdx = PHASES.findIndex((p) => p.id === job.phase);
    const isErr = job.phase === 'error';
    const phaseBar = PHASES.map((p, i) => {
      const done = !isErr && curIdx >= 0 && i < curIdx;
      const active = !isErr && p.id === job.phase;
      const mark = done ? '✅' : active ? (job.running ? '⏳' : p.emoji) : p.emoji;
      const style = active ? 'font-weight:700' : done ? 'opacity:.7' : 'opacity:.4';
      return `<span style="${style}">${mark} ${esc(p.label)}</span>`;
    }).join(' <span style="opacity:.3">›</span> ');

    const steps = (job.steps || []).map((s) => `<div class="hr-f-file">${STEP_ICON[s.status] || '○'} ${esc(s.label)}${s.detail && s.status === 'fail' ? ' — <span style="color:var(--cwc-danger)">' + esc(s.detail) + '</span>' : ''}</div>`).join('');
    const active = (job.activeWork || []).length
      ? `<div class="hr-f-file">📨 Esperando/avisado: ${(job.activeWork || []).map((a) => esc(a.label || a.key)).join(', ')}</div>` : '';
    const logTail = (job.log || []).slice(-8).map((l) => esc(l)).join('\n');
    const applyNames = new Set((job.plan?.majorsToApply || []).map((m) => m.name));
    const blocked = job.plan?.majorsBlocked || [];
    const blockedNames = new Set(blocked.map((m) => m.name));
    const appliedMajors = (job.plan?.majorsToApply || []);
    const notApplied = (job.plan?.majors || []).filter((m) => !applyNames.has(m.name) && !blockedNames.has(m.name));
    const majors = [
      appliedMajors.length ? `<div class="hr-f-file">⚠ ${appliedMajors.length} salto(s) mayor(es) aplicados: ${appliedMajors.map((m) => esc(m.name) + ' ' + esc(m.from) + '→' + esc(m.to)).join(', ')}</div>` : '',
      blocked.length ? `<div class="hr-f-file">🔒 ${blocked.length} salto(s) mayor(es) bloqueados: ${blocked.map((m) => esc(m.name) + ' — ' + esc(m.reason || 'bloqueado')).join(', ')}</div>` : '',
      notApplied.length ? `<div class="hr-f-file">🟡 ${notApplied.length} salto(s) mayor(es) NO aplicados (quedan para tu OK): ${notApplied.map((m) => esc(m.name) + ' ' + esc(m.wanted) + '→' + esc(m.latest)).join(', ')}</div>` : '',
    ].join('');

    const head = isErr
      ? `<p class="hr-f-crit">❌ ${esc(job.error || 'La actualización falló.')}</p>`
      : job.running
        ? `<p class="pj-hint">${pacman({ size: 'sm' })} <b>Actualización en curso</b> — no cierres la consola; sobrevive el reinicio.</p>`
        : `<p class="pj-hint">✅ <b>${esc(job.result?.message || 'Actualización completa.')}</b></p>`;

    // Nada de nag de reboot de máquina (regla de Niko: jamás sudo reboot). Solo
    // un dato neutro si algún cambio del SO quedó pendiente de activarse.
    const rebootWarn = job.rebootRequired ? `<p class="hr-f-file">ℹ️ Algunos cambios del SO se activan en un futuro reinicio de la máquina (no es necesario hacerlo ahora).</p>` : '';

    return `
      ${head}
      ${rebootWarn}
      <div class="hr-finding hr-finding--medium">
        <div class="hr-f-body" style="margin:0">
          <div style="font-size:.82em;line-height:1.9">${phaseBar}</div>
          ${majors}
          ${active}
          ${steps ? `<div style="margin-top:.4rem">${steps}</div>` : ''}
          ${logTail ? `<details class="hr-collapsible" style="margin-top:.4rem"><summary>📜 Registro</summary><pre style="white-space:pre-wrap;font-size:.78em;opacity:.85;margin:.3rem 0">${logTail}</pre></details>` : ''}
        </div>
      </div>
      ${!job.running ? `<div class="hr-f-actions" style="margin-top:.5rem"><button class="btn btn--sm btn-ghost" data-act="dismiss-progress">Cerrar y ver estado</button></div>` : ''}
    `;
  }

  function startPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    const tick = async () => {
      if (!alive) return;
      let job = null;
      try { job = await api.runStatus(); } catch { /* server reiniciándose: reintentar */ }
      if (!alive) return;
      if (job && (job.phase || job.running)) {
        root.innerHTML = renderProgress(job);
        wireActions();
      }
      if (job && job.running) {
        pollTimer = setTimeout(tick, 2000); // resiliente al reinicio (fetch falla → reintenta)
      } else {
        // Terminó: refrescar el censo para mostrar todo al día.
        setTimeout(() => { if (alive) load(true); }, 1200);
      }
    };
    tick();
  }

  // ───────── Vista de CENSO ─────────
  function coreItem(lib) {
    const m = RISK_META[lib.risk] || RISK_META.lib;
    const title = `${m.badge} <b>${esc(lib.name)}</b>`;
    const body = `${infoBlock(lib.info)}
      <div class="hr-f-file">Instalada ${esc(lib.current || '—')} · estable ${esc(lib.wanted || '—')} · última ${esc(lib.latest || '—')}</div>
      <div class="hr-f-file">Motor del SDK — el reinicio para tomar el cambio va incluido en "Actualizar todo".</div>`;
    const side = `<div><span class="hr-sev ${m.cls}">${m.badge} ${esc(m.label)}</span></div>
      <div style="margin-top:.3rem">${lib.upToDate ? '✅ al día' : `${esc(lib.current || '—')} → ${esc(lib.latest || '—')}`}</div>`;
    return collapsible(title, side, body, { border: 'hr-finding--medium', open: true });
  }

  function libItem(lib) {
    const m = RISK_META[lib.risk] || RISK_META.lib;
    const advBtn = isAdmin && lib.risk !== 'watch' && lib.wanted && lib.wanted !== lib.current
      ? `<div style="margin-top:.3rem"><button class="btn btn--sm btn-ghost" data-act="npm" data-pkg="${esc(lib.name)}" data-ver="${esc(lib.wanted)}">→ ${esc(lib.wanted)}</button></div>` : '';
    const title = `${m.badge} <b>${esc(lib.name)}</b>${lib.major ? ' <span class="hr-sev hr-sev--medium">⚠ major fuera de rango</span>' : ''}`;
    const body = `${infoBlock(lib.info)}
      <div class="hr-f-file">Instalada ${esc(lib.current || '—')} · estable ${esc(lib.wanted || '—')} · última ${esc(lib.latest || '—')} · declarada <code>${esc(lib.declared || '—')}</code></div>`;
    const side = `<div>${lib.upToDate ? '✅ al día' : `${esc(lib.current || '—')} → ${esc(lib.wanted || lib.latest || '—')}`}</div>${lib.risk === 'watch' ? '<div style="margin-top:.3rem">🔒 vigilada</div>' : advBtn}`;
    return collapsible(title, side, body, { border: lib.major ? 'hr-finding--medium' : 'hr-finding--low' });
  }

  function vulnItem(v) {
    const m = SEV_META[v.severity] || SEV_META.unknown;
    const body = `<div class="hr-f-file">Rango: <code>${esc(v.range || '—')}</code>${v.via?.length ? ' · vía ' + v.via.map(esc).join(', ') : ''}</div>
      <div class="hr-f-file">Se corrige con <code>npm audit fix</code> o actualizando el paquete raíz.</div>`;
    const side = `<span class="hr-sev ${m.cls}">${m.emoji} ${esc(m.label)}</span><div style="margin-top:.3rem">${v.fixAvailable ? 'fix disponible' : 'sin fix'}</div>`;
    return collapsible(`<b>${esc(v.name)}</b>`, side, body, { border: m.cls === 'hr-sev--high' ? 'hr-finding--high' : 'hr-finding--medium' });
  }

  function aptItem(p) {
    const title = `${p.highlight ? '⭐' : '🐧'} <b>${esc(p.name)}</b>`;
    const body = `${infoBlock(p.info)}
      <div class="hr-f-file">Comando manual (SSH): <code>sudo apt-get install --only-upgrade ${esc(p.name)}</code></div>`;
    const side = `${esc(p.current || '—')} → ${esc(p.latest || '—')}`;
    return collapsible(title, side, body);
  }

  function svcItem(s) {
    const side = s.latest && s.upToDate === false
      ? `<span class="hr-sev hr-sev--medium">⬆</span><div style="margin-top:.3rem">${esc(s.current)} → ${esc(s.latest)}</div>`
      : (s.upToDate ? `✅ ${esc(s.current)}` : esc(s.current));
    const body = `${infoBlock(s.info)}<div class="hr-f-file">${esc(s.note)}</div>`;
    return collapsible(`⚙️ <b>${esc(s.name)}</b>`, side, body, { border: s.upToDate === false ? 'hr-finding--medium' : 'hr-finding--low' });
  }
  function watchItem(w) {
    return collapsible(`🔴 <b>${esc(w.name)}</b>`, 'sin botón', `<div class="hr-f-file">${esc(w.note)}</div>`, { border: 'hr-finding--medium' });
  }
  // Veredicto IA de un major (o null si aún no se analizó). Un 🟢 seguro+alta se
  // AUTO-aplica sin checkbox; los bloqueados no son tildables; el resto lo
  // tildás vos (bajo tu riesgo).
  function majorItem(l, verdict) {
    const autoSafe = verdict && verdict.level === 'seguro' && verdict.confidence === 'alta';
    const blockedReason = blockedMajorReason(verdict);
    let verdictHtml;
    if (verdict) {
      const vm = LEVEL_META[verdict.level] || LEVEL_META.riesgoso;
      const bc = verdict.breakingChanges?.length ? `<div class="hr-f-file">Cambios: ${verdict.breakingChanges.slice(0, 3).map(esc).join('; ')}</div>` : '';
      verdictHtml = `<div class="hr-f-file"><span class="hr-sev ${vm.cls}">${vm.emoji} ${vm.label}</span> · confianza ${esc(verdict.confidence)} — ${esc(verdict.why || '')}</div>${bc}`;
    } else {
      verdictHtml = `<div class="hr-f-file">Sin analizar todavía — apretá "🧠 Analizar riesgo" para que la IA lea el changelog + tu código.</div>`;
    }
    const blockedHtml = blockedReason
      ? `<div class="hr-f-file">🔒 Bloqueado: ${esc(blockedReason)}</div>
         <div class="hr-f-file">🔒 Bloqueado: la IA no pudo verificar que sea seguro. Para aplicarlo, hacelo en una sesión de trabajo con pruebas.</div>`
      : '';
    const chk = isAdmin && !autoSafe && !blockedReason
      ? `<label style="display:inline-flex;align-items:center;gap:.35rem;margin-top:.35rem;cursor:pointer">
           <input type="checkbox" data-major="${esc(l.name)}"> <span class="hr-f-file" style="margin:0">incluir igual en "Actualizar todo" (bajo tu riesgo)</span>
         </label>` : '';
    const autoTag = autoSafe ? `<div class="hr-f-file">✅ La IA lo considera seguro (confianza alta) → se aplica solo en "Actualizar todo".</div>` : '';
    const title = `${blockedReason ? '🔒 ' : ''}<b>${esc(l.name)}</b> <span class="hr-f-file" style="display:inline">salto mayor</span>`;
    const body = `${infoBlock(l.info)}${verdictHtml}${autoTag}${blockedHtml}${chk}`;
    return collapsible(title, `${esc(l.current || l.wanted || '—')} → ${esc(l.latest || '—')}`, body, { border: autoSafe ? 'hr-finding--low' : 'hr-finding--medium' });
  }

  function render() {
    const d = state.census; if (!d) return;
    const risk = state.risk || {};
    const verdicts = risk.verdicts || {};
    const riskRunning = !!risk.running;
    const npm = d.npm || {};
    const libs = npm.libs || [];
    const core = libs.filter((l) => l.risk === 'core');
    const rest = libs.filter((l) => l.risk !== 'core');
    const vulns = npm.vulns || [];
    const counts = npm.vulnCounts || {};
    const totalVuln = (counts.critical || 0) + (counts.high || 0) + (counts.moderate || 0) + (counts.low || 0);
    const hasHigh = (counts.critical || 0) + (counts.high || 0) > 0;
    const fixableVuln = vulns.some((v) => v.fixAvailable);
    // Majors = una versión fuera del rango estable (latest !== wanted).
    const majors = libs.filter((l) => l.latest && l.wanted && l.latest !== l.wanted && l.risk !== 'watch');
    const vFor = (l) => verdicts[riskKey(l.name, l.current, l.latest)] || null;
    const autoMajors = majors.filter((l) => { const v = vFor(l); return v && v.level === 'seguro' && v.confidence === 'alta'; });
    const blockedMajors = majors.filter((l) => blockedMajorReason(vFor(l)));
    const tildableMajors = Math.max(0, majors.length - autoMajors.length - blockedMajors.length);
    const inRangeN = libs.filter((l) => l.risk !== 'watch' && l.wanted && l.current && l.wanted !== l.current).length;
    const cliOutdated = d.claudeCli && !d.claudeCli.upToDate && d.claudeCli.manageable !== false;
    const aptN = d.apt?.count || 0;
    const totalActions = inRangeN + autoMajors.length + (cliOutdated ? 1 : 0) + (aptN ? 1 : 0) + (fixableVuln ? 1 : 0);

    const headline = hasHigh
      ? `🟠 ${totalVuln} vulnerabilidad(es) — ${(counts.critical || 0) + (counts.high || 0)} alta/crítica · ${totalActions} acción(es) de update`
      : (totalActions ? `🟡 ${totalActions} acción(es) de update disponibles` : '🟢 Todo al día');

    const runBtn = isAdmin
      ? `<button class="btn btn--sm" data-act="run" ${totalActions ? '' : 'disabled'} title="Planea, drena sesiones, aplica, verifica, reinicia y reanuda">🚀 Actualizar todo (orquestado)${totalActions ? ` · ${totalActions}` : ''}</button>`
      : '';
    const analyzeBtn = isAdmin && majors.length
      ? `<button class="btn btn--sm btn-ghost" data-act="analyze" ${riskRunning ? 'disabled' : ''}>${riskRunning ? pacman({ size: 'sm' }) + ' analizando…' : '🧠 Analizar riesgo (majors)'}</button>`
      : '';
    const adminBar = isAdmin
      ? `<div class="hr-f-actions" style="margin:.5rem 0;flex-wrap:wrap">
          ${runBtn}
          ${analyzeBtn}
          <button class="btn btn--sm btn-ghost" data-act="refresh">🔄 Re-escanear</button>
          <button class="btn btn--sm btn-ghost" data-act="verify">🩺 Verificar salud</button>
        </div>` : '';

    const section = (title, items, open) => `<details class="hr-collapsible"${open ? ' open' : ''}>
      <summary>${title}</summary><div class="hr-findings">${items || '<p class="hr-summary">—</p>'}</div></details>`;

    const secHint = riskRunning ? '<p class="hr-f-file">🧠 Analizando el riesgo de cada salto mayor…</p>' : '';
    const vulnFixBtn = isAdmin && fixableVuln ? `<div class="hr-f-actions" style="margin-bottom:.4rem"><button class="btn btn--sm" data-act="audit-fix">🔐 Arreglar vulnerabilidades ahora</button></div>` : '';

    const when = d.generatedAt ? new Date(d.generatedAt).toLocaleString() : '';
    root.innerHTML = `
      <p class="pj-hint"><b>${headline}</b></p>
      <p class="hr-f-file" style="margin-top:-.3rem">Escaneado: ${esc(when)} · el botón único arregla vulnerabilidades + actualiza lo estable (in-range) + los majors que la IA marcó 🟢 seguros + Claude CLI + SO, drena por interfono y reinicia. Betas nunca.</p>
      ${adminBar}
      ${section('🧬 Motor (crítico)', core.map(coreItem).join('') + coreItem2(d.claudeCli), true)}
      ${section(`🔐 Seguridad — ${totalVuln} vulnerabilidad(es) ${hasHigh ? '⚠️' : ''}`, vulnFixBtn + (vulns.length ? vulns.map(vulnItem).join('') : '<p class="hr-summary">✅ Sin vulnerabilidades conocidas.</p>'), hasHigh)}
      ${majors.length ? section(`🟡 Saltos mayores (${majors.length}) — ${autoMajors.length} 🟢 auto · ${tildableMajors} para tu OK · ${blockedMajors.length} 🔒 bloqueado(s)`, secHint + majors.map((l) => majorItem(l, vFor(l))).join(''), false) : ''}
      ${section(`📚 Librerías npm (${rest.length})`, rest.map(libItem).join(''), false)}
      ${section(`🐧 Sistema operativo (${aptN})`, `<p class="hr-f-file">Incluido en "Actualizar todo". Manual: <code>sudo apt update &amp;&amp; sudo apt upgrade</code></p>` + (d.apt?.pkgs || []).map(aptItem).join(''), false)}
      ${section('⚙️ Servicios y runtime (referencia)', (d.services || []).map(svcItem).join(''), false)}
      ${section(`⚠️ Vigiladas — no actualizar a ciegas (${(d.watched || []).length})`, (d.watched || []).map(watchItem).join(''), false)}
    `;
    wireToggles();
    wireActions();
  }

  // Claude CLI como ítem del bloque Motor (misma forma de 2 columnas).
  function coreItem2(cli) {
    if (!cli) return '';
    const info = { what: 'La herramienta de línea de comandos de Claude Code.', role: 'Es el programa que corre las sesiones de Claude; la consola lo invoca para las terminales y hereda su login.' };
    const unmanaged = cli.manageable === false;
    const body = `${infoBlock(info)}
      ${cli.resolvedPath ? `<div class="hr-f-file">Ruta: <code>${esc(cli.resolvedPath)}</code></div>` : ''}
      <div class="hr-f-file">${unmanaged ? esc(cli.note || '') : 'Updater propio (<code>claude update</code>). No toca el repo. Va incluido en "Actualizar todo".'}</div>`;
    const side = unmanaged
      ? `<div>🔒 instalación de sistema</div><div style="margin-top:.3rem">${esc(cli.current || '—')} → ${esc(cli.latest || '—')}</div>`
      : (cli.upToDate ? '✅ al día' : `${esc(cli.current || '—')} → ${esc(cli.latest || '—')}`);
    return collapsible('⌨️ <b>Claude Code CLI</b>', side, body, { border: 'hr-finding--medium', open: true });
  }

  function wireActions() {
    root.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === 'run') {
          const majors = [...root.querySelectorAll('[data-major]:checked')].map((c) => c.dataset.major);
          // Auto-seguros que el backend aplicará solo (IA 🟢 seguro+alta).
          const verdicts = state.risk?.verdicts || {};
          const autoNames = (state.census?.npm?.libs || [])
            .filter((l) => l.latest && l.wanted && l.latest !== l.wanted && l.risk !== 'watch')
            .filter((l) => { const v = verdicts[riskKey(l.name, l.current, l.latest)]; return v && v.level === 'seguro' && v.confidence === 'alta'; })
            .map((l) => l.name);
          const autoLine = autoNames.length ? `\n\n🟢 La IA aplicará solos (seguros): ${autoNames.join(', ')}.` : '';
          const majorLine = majors.length
            ? `\n\n⚠️ ADEMÁS forzás ${majors.length} salto(s) MAYOR(es) bajo tu riesgo: ${majors.join(', ')}.\nPueden romper en runtime — probá la consola después.`
            : '';
          if (!(await confirm(`Se va a:\n\n1. Planear el orden (vulnerabilidades y reversibles primero).\n2. Avisar a las sesiones por interfono y esperar que el fondo repose.\n3. Arreglar vulnerabilidades + actualizar npm estable + Claude CLI + Sistema operativo (apt).\n4. Verificar con node --check.\n5. Reiniciar el servicio (corta un momento; el trabajo sobrevive).\n6. Mandar "continuar" por interfono.${autoLine}${majorLine}\n\nBetas: nunca.\n\n¿Arrancar?`))) return;
          const r = await api.run(majors);
          if (r.error) { await notify(`❌ ${esc(r.error)}`); return; }
          startPolling();
        }
        if (act === 'dismiss-progress') { load(true); }
        if (act === 'refresh') { root.innerHTML = `${pacman({ size: 'sm' })} <span class="hr-summary">Re-escaneando…</span>`; const d = await api.refresh(); if (!alive) return; state.census = d; render(); }
        if (act === 'analyze') {
          const r = await api.analyze();
          if (r?.error && !r.risk) { await notify(`❌ ${esc(r.error)}`); return; }
          pollRisk();
        }
        if (act === 'audit-fix') {
          if (!(await confirm('¿Arreglar las vulnerabilidades ahora? Corre `npm audit fix` (seguro, dentro de rango, reversible con git) + node --check. No reinicia.'))) return;
          btn.disabled = true; btn.innerHTML = `${pacman({ size: 'sm' })} arreglando…`;
          const r = await api.auditFix();
          if (!alive) return;
          if (r?.error) await notify(`❌ ${esc(r.error)}`);
          else await notify(`✅ Vulnerabilidades procesadas.\n\nSintaxis: ${r.syntax?.ok ? 'OK ✅' : 'FALLÓ ❌'}\n\n${esc((r.detail || '').slice(-200))}`);
          load(true);
        }
        if (act === 'verify') {
          btn.disabled = true;
          const checks = await api.healthChecks();
          if (!alive) return;
          const list = Array.isArray(checks?.checks) ? checks.checks : (Array.isArray(checks) ? checks : []);
          const bad = list.filter((c) => c.status !== 'ok');
          await notify(bad.length ? `⚠️ ${bad.length} chequeo(s) no OK:\n\n${bad.map((c) => `• ${c.label || c.id}: ${c.detail || c.status}`).join('\n')}` : `✅ Salud OK — ${list.filter((c) => c.status === 'ok').length} chequeos en verde.`);
          btn.disabled = false;
        }
        if (act === 'npm') {
          if (!(await confirm(`¿Actualizar ${btn.dataset.pkg} a ${btn.dataset.ver}? (npm install + node --check, reversible con git)`))) return;
          btn.disabled = true; btn.innerHTML = `${pacman({ size: 'sm' })}`;
          const r = await api.updateNpm(btn.dataset.pkg, btn.dataset.ver);
          if (!alive) return;
          if (r?.error) await notify(`❌ ${esc(r.error)}`);
          else await notify(`✅ ${esc(btn.dataset.pkg)} actualizado. Sintaxis: ${r.syntax?.ok ? 'OK ✅' : 'FALLÓ ❌'}${r.needsRestart ? '\n\n⚠️ Reiniciá para que tome efecto.' : ''}`);
          load(true);
        }
      });
    });
  }

  // Poll del análisis de riesgo (Fase B): re-renderiza los majors a medida que
  // llegan veredictos, sin re-escanear el censo (que ya está en state).
  function pollRisk() {
    if (riskTimer) clearTimeout(riskTimer);
    const tick = async () => {
      if (!alive) return;
      const risk = await api.risk();
      if (!alive) return;
      state.risk = risk;
      if (state.census) render();
      if (risk && risk.running) riskTimer = setTimeout(tick, 3000);
    };
    tick();
  }

  async function load(fresh = false) {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (riskTimer) { clearTimeout(riskTimer); riskTimer = null; }
    root.innerHTML = `${pacman({ size: 'sm' })} <span class="hr-summary">Escaneando versiones de terceros…</span>`;
    // Si hay un job orquestado en curso, mostrar el progreso en vez del censo.
    let job = null;
    try {
      job = await api.runStatus();
      if (alive && job && job.running) { startPolling(); return; }
    } catch { /* noop */ }
    let d; let risk;
    try { [d, risk] = await Promise.all([api.census(fresh), api.risk()]); } catch { d = null; }
    if (!alive) return;
    if (job?.finishedAt && job.finishedAt > (d?.generatedAt || 0)) {
      try { d = await api.census(true); } catch { /* conservar error original si falla */ }
      if (!alive) return;
    }
    if (!d || d.error) { root.innerHTML = `<p class="hr-summary">No se pudo cargar el censo. ${esc(d?.error || '')}</p>`; return; }
    state.census = d; state.risk = risk || null;
    render();
    // Si el análisis quedó corriendo (de una corrida anterior), seguí el poll.
    if (risk && risk.running) pollRisk();
  }

  load();
}
