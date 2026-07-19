// modules/system/coherence-modal.js — sub-ventana del MÓDULO DE COHERENCIA
// (gemela de optimize-modal: la pestaña Salud muestra solo el resumen compacto
// + botón; el contenido completo vive acá).
//
// Adentro: censo determinístico de coherencia (GET /coherence-census, 0 tokens →
// servicios transversales + grafo de módulos + hallazgos de cableado), botón
// "Analizar con IA" (POST /coherence → runner desacoplado, CONSUME TOKENS,
// confirm) y las propuestas con Aplicar en chat (supervisado, acceptEdits) /
// Descartar. El flujo nuevo se explora en chat modo plan. NADA se auto-aplica.
import { icon } from '../../ui/icons.js';
import { t } from '../../ui/i18n.js';
import { pacman } from '../../ui/pacman.js';

const API = '/api/health';
const POLL_MS = 4000;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' · ' + new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '—');
// Severidad de un hallazgo determinístico → clase de riesgo reutilizada.
const TIPO_ICON = { cableado: '🔗', dedup: '♻️', 'fuente-unica': '🎯', 'regla-oro': '🏅', blindaje: '🔒', espejo: '🪞', adopcion: '⚡', convencion: '📐', otro: '🔧' };
const CAT_ICON = { reuso: '🔗', 'fuente-unica': '🎯', 'regla-oro': '🏅', blindaje: '🔒', huerfano: '👻', registro: '🧩', adopcion: '⚡', convencion: '📐' };

function riskLabel(risk) {
  return {
    bajo: `🟢 ${t('system.coherence.riskLow', 'bajo')}`,
    medio: `🟡 ${t('system.coherence.riskMedium', 'medio')}`,
    alto: `🔴 ${t('system.coherence.riskHigh', 'alto')}`,
  }[risk];
}

function severityMeta(severity) {
  return {
    alto: { risk: 'alto', label: `🔴 ${t('system.coherence.severityHigh', 'alto')}` },
    aviso: { risk: 'medio', label: `🟡 ${t('system.coherence.severityWarning', 'aviso')}` },
    info: { risk: 'bajo', label: `🟢 ${t('system.coherence.severityInfo', 'info')}` },
  }[severity] || { risk: 'bajo', label: `🟢 ${t('system.coherence.severityInfo', 'info')}` };
}

function tipoLabel(tipo) {
  return {
    cableado: t('system.coherence.typeWiring', 'Cableado'),
    dedup: t('system.coherence.typeDeduplicate', 'Deduplicar'),
    'fuente-unica': t('system.coherence.typeSingleSource', 'Fuente única'),
    'regla-oro': t('system.coherence.typeGoldenRule', 'Regla de oro'),
    blindaje: t('system.coherence.typeGuardrail', 'Blindaje'),
    espejo: t('system.coherence.typeMirror', 'Espejo back↔front'),
    adopcion: t('system.coherence.typeAdoptPattern', 'Adoptar patrón'),
    convencion: t('system.coherence.typeConvention', 'Convención'),
    otro: t('system.coherence.typeAdjustment', 'Ajuste'),
  }[tipo];
}

// Monta el contenido de Coherencia en un contenedor `host` (reusable: lo usa el
// Escaneo de Salud unificado como sección inline, y openCoherence como modal
// standalone). `onClose` cierra el modal contenedor al aplicar/resolver.
// Devuelve { stop } para frenar el poll.
export function mountCoherence(host, ctx, { isAdmin, onClose } = {}) {
  const { dialog, openChat } = ctx;
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const wrap = document.createElement('div');
  wrap.className = 'hp-opt';
  host.innerHTML = '';
  host.appendChild(wrap);

  let alive = true;
  let pollTimer = null;
  function stop() { alive = false; clearTimeout(pollTimer); obs.disconnect(); }
  const obs = new MutationObserver(() => { if (!host.isConnected) stop(); });
  obs.observe(document.body, { childList: true, subtree: true });

  // ===== Censo: servicios transversales + grafo de módulos (árbol) =====
  function servicesHtml(census) {
    const services = census?.services || [];
    const rows = services.map((s) => {
      const n = (s.consumerModules || []).length;
      const warn = !s.exists ? `<span class="hp-opt-risk hp-opt-risk--medio">${t('system.coherence.missingService', 'no existe')}</span>`
        : (n === 0 ? `<span class="hp-opt-risk hp-opt-risk--alto">👻 ${t('system.coherence.noConsumers', 'sin consumidores')}</span>` : '');
      return `<tr title="${esc(s.label)}">
        <td><b>${esc(s.key)}</b></td>
        <td>${esc(s.label)}</td>
        <td>${n ? esc((s.consumerModules || []).join(', ')) : '—'} ${warn}</td>
      </tr>`;
    }).join('');
    const modRows = (census?.modules || []).filter((g) => g.uses.length).map((g) => `
      <tr><td><b>${esc(g.module)}</b></td><td>${esc(g.uses.join(', '))}</td></tr>`).join('');
    const patRows = (census?.patterns || []).map((pt) => {
      const cand = (pt.candidates || []).length;
      const flag = !pt.providerExists ? '—'
        : (cand ? `<span class="hp-opt-risk hp-opt-risk--medio">⚡ ${t('system.coherence.candidatesCount', '{count} candidato(s)', { count: cand })}</span>` : `<span class="hp-opt-snippet">${t('system.coherence.upToDate', 'al día')}</span>`);
      return `<tr title="${esc(pt.label)}">
        <td>${esc(pt.label)}</td>
        <td>${(pt.adopters || []).length}</td>
        <td>${flag}</td>
      </tr>`;
    }).join('');
    const convRows = (census?.conventions || []).map((c) => {
      const n = (c.violations || []).length;
      const flag = !c.mechanical ? `<span class="hp-opt-snippet">${t('system.coherence.aiJudgment', 'criterio IA')}</span>`
        : (n ? `<span class="hp-opt-risk hp-opt-risk--medio">⚠ ${t('system.coherence.leadsCount', '{count} lead(s)', { count: n })}</span>` : `<span class="hp-opt-snippet">${t('system.coherence.upToDate', 'al día')}</span>`);
      return `<tr title="${esc(c.label)}">
        <td>${esc(c.label)}</td>
        <td>${c.scopedCount ?? 0}</td>
        <td>${flag}</td>
      </tr>`;
    }).join('');
    return `<details class="hp-opt-census" ${isMobile ? '' : 'open'}>
      <summary>🕸 ${t('system.coherence.graphSummary', 'Grafo · {modules} módulos · {edges} aristas', { modules: (census?.counts?.modules) || 0, edges: (census?.counts?.edges) || 0 })}</summary>
      <details class="hp-opt-group" ${isMobile ? '' : 'open'}>
        <summary>🔌 ${t('system.coherence.crossServicesSummary', 'Servicios transversales · {count}', { count: services.length })}</summary>
        <table class="hp-opt-table">
          <thead><tr><th>${t('system.coherence.serviceHeader', 'Servicio')}</th><th>${t('system.coherence.whatIsHeader', 'Qué es')}</th><th>${t('system.coherence.consumedByHeader', 'Consumido por')}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </details>
      <details class="hp-opt-group" ${isMobile ? '' : 'open'}>
        <summary>⚡ ${t('system.coherence.canonicalPatternsSummary', 'Patrones canónicos · adopción')}</summary>
        <table class="hp-opt-table">
          <thead><tr><th>${t('system.coherence.patternHeader', 'Patrón')}</th><th>${t('system.coherence.adoptersHeader', 'Adoptan')}</th><th>${t('system.coherence.statusHeader', 'Estado')}</th></tr></thead>
          <tbody>${patRows || '<tr><td colspan="3">—</td></tr>'}</tbody>
        </table>
      </details>
      <details class="hp-opt-group" ${isMobile ? '' : 'open'}>
        <summary>📐 ${t('system.coherence.conventionsSummary', 'Convenciones · CLAUDE.md')}</summary>
        <table class="hp-opt-table">
          <thead><tr><th>${t('system.coherence.conventionHeader', 'Convención')}</th><th>${t('system.coherence.scopeHeader', 'Alcance')}</th><th>${t('system.coherence.statusHeader', 'Estado')}</th></tr></thead>
          <tbody>${convRows || '<tr><td colspan="3">—</td></tr>'}</tbody>
        </table>
      </details>
      <details class="hp-opt-group">
        <summary>🧩 ${t('system.coherence.moduleUsageSummary', 'Quién usa a quién (por módulo)')}</summary>
        <table class="hp-opt-table">
          <thead><tr><th>${t('system.coherence.moduleHeader', 'Módulo')}</th><th>${t('system.coherence.usesHeader', 'Usa')}</th></tr></thead>
          <tbody>${modRows || '<tr><td colspan="2">—</td></tr>'}</tbody>
        </table>
      </details>
    </details>`;
  }

  // ===== Hallazgos determinísticos (0 tokens): la semilla que verifica la IA =====
  // Cada uno muestra detalle + PROCEDIMIENTO (pasos) y, para admin, un botón
  // "Resolver en chat" (supervisado, acceptEdits) — accionable SIN gastar la IA.
  function findingHtml(f) {
    const sev = severityMeta(f.severidad);
    const pasos = (f.pasos || []).length
      ? `<div class="hp-detail"><b>${t('system.coherence.procedureLabel', 'Procedimiento:')}</b></div><ol class="hp-opt-flow">${f.pasos.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : '';
    const resolve = isAdmin
      ? `<div class="hp-opt-actions"><button class="btn-ghost btn--sm" data-act="cohresolve" data-id="${esc(f.id)}">💬 ${t('system.coherence.resolveInChat', 'Resolver en chat')}</button></div>` : '';
    return `<details class="hp-opt-card">
      <summary class="hp-opt-head">
        <span>${CAT_ICON[f.categoria] || '🔗'}</span>
        <b>${esc(f.foco)}</b>
        <span class="hp-opt-snippet">${esc(f.detalle)}</span>
        <span class="hp-opt-risk hp-opt-risk--${sev.risk}">${sev.label}</span>
      </summary>
      <div class="hp-opt-body">
        <div class="hp-detail">${esc(f.detalle)}</div>
        <div class="hp-detail"><b>${t('system.coherence.suggestionLabel', 'Sugerencia:')}</b> ${esc(f.sugerencia)}</div>
        ${pasos}
        ${resolve}
      </div>
    </details>`;
  }

  function findingsHtml(findings) {
    if (!findings?.length) return `<p class="hp-empty">✅ ${t('system.coherence.noFindings', 'El censo determinístico no encontró incoherencias evidentes.')}</p>`;
    const order = { alto: 0, aviso: 1, info: 2 };
    const sorted = [...findings].sort((a, b) => (order[a.severidad] ?? 3) - (order[b.severidad] ?? 3));
    return `<details class="hp-opt-group" open>
      <summary>🧪 ${t('system.coherence.deterministicFindingsSummary', 'Hallazgos determinísticos · {count} (0 tokens — con procedimiento; verificables con IA)', { count: findings.length })}</summary>
      ${sorted.map(findingHtml).join('')}
    </details>`;
  }

  // ===== Propuestas IA: agrupadas por FOCO (árbol), cada una colapsable =====
  function proposalHtml(p) {
    const decided = p.status === 'accepted' ? `<span class="hp-opt-done">✅ ${t('system.coherence.accepted', 'aceptada')}</span>` : '';
    const actions = isAdmin && p.status === 'pending' ? `
      <div class="hp-opt-actions">
        <button class="btn-ghost btn--sm" data-act="cohreject" data-id="${esc(p.id)}">✕ ${t('system.coherence.discard', 'Descartar')}</button>
        <button class="btn btn--sm" data-act="cohapply" data-id="${esc(p.id)}">💬 ${t('system.coherence.applyInChat', 'Aplicar en chat')}</button>
      </div>` : '';
    const state = p.status === 'accepted' ? decided : `<span class="hp-opt-risk hp-opt-risk--${esc(p.riesgo)}">${riskLabel(p.riesgo) || esc(p.riesgo)}</span>`;
    return `<details class="hp-opt-card">
      <summary class="hp-opt-head">
        <span>${TIPO_ICON[p.tipo] || '🔧'}</span>
        <b>${esc(tipoLabel(p.tipo) || p.tipo)}</b>
        <span class="hp-opt-snippet">${esc(p.propuesta)}</span>
        ${state}
      </summary>
      <div class="hp-opt-body">
        <div class="hp-opt-diff"><s>${esc(p.actual)}</s> → <b>${esc(p.propuesta)}</b></div>
        <div class="hp-detail">${esc(p.razon)}${p.impacto ? ` · <b>${t('system.coherence.gainLabel', 'Gana:')}</b> ${esc(p.impacto)}` : ''}</div>
        ${actions}
      </div>
    </details>`;
  }

  function proposalsTreeHtml(list) {
    const byFoco = new Map();
    for (const p of list) {
      if (!byFoco.has(p.foco)) byFoco.set(p.foco, []);
      byFoco.get(p.foco).push(p);
    }
    return [...byFoco.entries()].map(([foco, ps]) => {
      const pend = ps.filter((p) => p.status === 'pending').length;
      return `<details class="hp-opt-group" open>
        <summary>⚙️ ${esc(foco)} · ${t('system.coherence.proposalsCount', '{count} propuesta(s)', { count: ps.length })}${pend ? ` · ${t('system.coherence.pendingCount', '{count} pendiente(s)', { count: pend })}` : ` · ${t('system.coherence.upToDate', 'al día')}`}</summary>
        ${ps.map(proposalHtml).join('')}
      </details>`;
    }).join('');
  }

  function render(censusResp, d) {
    const census = censusResp?.census;
    // Hallazgos determinísticos: SIEMPRE los frescos del censo en vivo (0 tokens,
    // actuales). Los persistidos en coherence.json son la foto de cuando corrió
    // la IA (pueden estar viejos: reglas nuevas, cosas ya resueltas) — no se usan
    // para mostrar, solo quedan en el registro del análisis.
    const curFindings = censusResp?.findings || [];
    const parts = [servicesHtml(census)];
    parts.push(findingsHtml(curFindings));
    if (d.running) {
      // Sin fase todavía = reservó el lock y está arrancando (queued); con fase
      // = la IA ya está trabajando el análisis (delegating).
      const phase = d.progress?.phase;
      parts.push(`<p class="hp-running">${pacman({ state: phase ? 'delegating' : 'queued' })} ${phase ? `${t('system.coherence.analyzing', 'Analizando')} · ${esc(phase)}` : t('system.coherence.queuedStarting', 'En cola · arrancando el análisis…')}</p>`);
    } else if (d.error) {
      parts.push(`<p class="hp-error">${t('system.coherence.lastAnalysisFailed', 'El último análisis falló:')} ${esc(d.error)}</p>`);
    }
    if (d.updatedAt && d.resumen) {
      const pend = (d.propuestas || []).filter((p) => p.status === 'pending').length;
      parts.push(`<div class="hp-verdict hp-verdict--${pend ? 'atencion' : 'ok'}">
        <b>${pend ? t('system.coherence.pendingProposalsCount', '{count} propuesta(s) pendiente(s)', { count: pend }) : t('system.coherence.noPendingProposals', 'Sin propuestas pendientes')}</b>
        <span class="hp-when">${fmtDate(d.updatedAt)}</span>
      </div>`);
      parts.push(`<details class="hp-opt-resumen-box" ${isMobile ? '' : 'open'}>
        <summary>📋 ${t('system.coherence.analysisSummary', 'Resumen del análisis')}</summary>
        <p class="hp-opt-resumen">${esc(d.resumen)}</p>
      </details>`);
      parts.push(proposalsTreeHtml((d.propuestas || []).filter((p) => p.status !== 'rejected')));
      if (d.flujoNuevo?.vale) {
        parts.push(`<details class="hp-opt-card hp-opt-card--flow">
          <summary class="hp-opt-head"><span>🕸</span><b>${t('system.coherence.newFlowProposed', 'Flujo nuevo propuesto')}</b><span class="hp-opt-snippet">${esc(d.flujoNuevo.titulo)}</span></summary>
          <div class="hp-opt-body">
            <div class="hp-detail">${esc(d.flujoNuevo.descripcion)}</div>
            <ul class="hp-opt-flow">${(d.flujoNuevo.diseno || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
            ${isAdmin ? `<div class="hp-opt-actions"><button class="btn-ghost btn--sm" data-act="cohflow">💬 ${t('system.coherence.exploreInChatPlan', 'Explorar en chat (plan)')}</button></div>` : ''}
          </div>
        </details>`);
      }
    } else if (!d.running) {
      parts.push(`<p class="hp-empty">${t('system.coherence.notRun', 'Todavía no se corrió ningún análisis de coherencia con IA (arriba están los hallazgos determinísticos, gratis).')}</p>`);
    }
    if (isAdmin) {
      parts.push(`<button class="btn btn--block" data-act="cohrun" ${d.running ? 'disabled' : ''}>${icon('gear', { size: 14 })}<span>${d.running ? t('system.coherence.analysisRunning', 'Análisis en curso…') : t('system.coherence.analyzeWithAi', 'Analizar con IA')}</span></button>`);
    }
    wrap.innerHTML = parts.join('');

    wrap.querySelector('[data-act="cohrun"]')?.addEventListener('click', runCoherence);
    wrap.querySelector('[data-act="cohflow"]')?.addEventListener('click', () => exploreFlow(d.flujoNuevo));
    for (const b of wrap.querySelectorAll('[data-act="cohapply"]')) {
      b.addEventListener('click', () => {
        const p = (d.propuestas || []).find((x) => x.id === b.dataset.id);
        if (p) applyProposal(p);
      });
    }
    for (const b of wrap.querySelectorAll('[data-act="cohreject"]')) {
      b.addEventListener('click', async () => {
        await decideProposal(b.dataset.id, 'reject');
        load();
      });
    }
    for (const b of wrap.querySelectorAll('[data-act="cohresolve"]')) {
      b.addEventListener('click', () => {
        const f = curFindings.find((x) => x.id === b.dataset.id);
        if (f) resolveFinding(f);
      });
    }
  }

  async function load() {
    clearTimeout(pollTimer);
    try {
      const [census, d] = await Promise.all([
        fetch(`${API}/coherence-census`).then((r) => r.json()),
        fetch(`${API}/coherence`).then((r) => r.json()),
      ]);
      if (!alive) return;
      render(census, d);
      if (d.running) pollTimer = setTimeout(load, POLL_MS);
    } catch {
      if (alive) wrap.innerHTML = `<p class="hp-empty">${t('system.coherence.readError', 'No se pudo leer la coherencia.')}</p>`;
    }
  }

  async function runCoherence() {
    const ok = await dialog.confirmDialog({
      title: t('system.coherence.analysisDialogTitle', 'Análisis de Coherencia'),
      message: t('system.coherence.analysisDialogMessage', 'Analiza si los motores y módulos de la consola se usan entre sí de forma coherente (grafo de dependencias + lectura del código con Sonnet) y propone cableados/deduplicaciones.\n\nCorre desacoplado (sobrevive reinicios) y CONSUME TOKENS. Nada se aplica solo: cada propuesta la aprobás vos.'),
      confirmLabel: t('system.coherence.analyzeUsesTokens', 'Analizar (usa tokens)'),
    });
    if (!ok) return;
    try {
      const res = await fetch(`${API}/coherence`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || res.status);
    } catch (err) {
      await dialog.alertDialog({ title: t('system.coherence.shortTitle', 'Coherencia'), message: t('system.coherence.launchError', 'No se pudo lanzar: {error}', { error: err.message || err }) });
    }
    load();
  }

  async function decideProposal(id, action) {
    try {
      const res = await fetch(`${API}/coherence-proposal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || res.status);
      return d.padRef || null;
    } catch (err) {
      await dialog.alertDialog({ title: t('system.coherence.shortTitle', 'Coherencia'), message: t('system.coherence.saveDecisionError', 'No se pudo guardar la decisión: {error}', { error: err.message || err }) });
      return null;
    }
  }

  // Aprobar = marcar aceptada (crea la TAREA en Pad, ver pad-writeback-shared.js)
  // + abrir un chat SUPERVISADO (acceptEdits) con todo el contexto para aplicar
  // el cableado. Nunca se aplica sola. Si Pad devolvió un ref, el ÚLTIMO paso
  // del chat cierra el circuito marcándola 'hecha' en Pad.
  async function applyProposal(p) {
    const padRef = await decideProposal(p.id, 'accept');
    const prompt = [
      t('system.coherence.applyPromptIntro', 'El Módulo de Coherencia de la consola (Claude Web Console) detectó que dos partes del sistema no se están usando entre sí de forma óptima y propuso este cableado. Aplicalo de forma supervisada.'),
      '',
      `${t('system.coherence.focusLabel', 'Foco:')} ${p.foco}${p.archivo ? ` (${p.archivo})` : ''}`,
      `${t('system.coherence.typeLabel', 'Tipo:')} ${p.tipo} · ${t('system.coherence.riskLabel', 'Riesgo:')} ${p.riesgo}`,
      `${t('system.coherence.currentLabel', 'Actual:')} ${p.actual}`,
      `${t('system.coherence.proposalLabel', 'Propuesta:')} ${p.propuesta}`,
      `${t('system.coherence.reasonLabel', 'Razón:')} ${p.razon}`,
      p.impacto ? `${t('system.coherence.expectedImpactLabel', 'Impacto esperado:')} ${p.impacto}` : '',
      p.archivos?.length ? `${t('system.coherence.filesToTouchLabel', 'Archivos a tocar:')} ${p.archivos.join(', ')}` : '',
      p.pasos?.length ? `${t('system.coherence.suggestedStepsLabel', 'Pasos sugeridos:')}\n${p.pasos.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` : '',
      '',
      t('system.coherence.strictRulesHeader', 'Reglas ESTRICTAS:'),
      t('system.coherence.applyRule1', '1. Leé el CLAUDE.md de la raíz ANTES de tocar nada: las reglas duras (1-9) son inviolables — en particular el blindaje read-only de dos capas de las corridas headless y los runners desacoplados (regla de oro).'),
      t('system.coherence.applyRule2', '2. Verificá leyendo el código que la incoherencia sigue vigente y que el cableado propuesto es correcto y no rompe otra cosa. Si no aplica, avisame y no toques nada.'),
      t('system.coherence.applyRule3', '3. Preferí SIEMPRE reusar la fuente/servicio canónico existente en vez de duplicar lógica.'),
      t('system.coherence.applyRule4', '4. Verificá cada archivo .js que edites con `node --check`.'),
      t('system.coherence.applyRule5', '5. FRENÁ y pedime confirmación ANTES de cualquier acción de alto riesgo (git push, reiniciar el servicio, borrar datos).'),
      t('system.coherence.applyRule6', '6. Al terminar, resumí qué cableaste, en qué archivos y cómo verificarlo.'),
      padRef ? t('system.coherence.applyRule7', '7. Como ÚLTIMO paso, tras verificar el cambio, ejecutá:\n   node bin/cwc-health-proposal-done.js {padRef}', { padRef }) : '',
    ].filter(Boolean).join('\n');
    onClose?.();
    await openChat?.({ cwd: 'claude-web-console', mode: 'acceptEdits', prompt, title: `${t('system.coherence.shortTitle', 'Coherencia')}: ${p.foco}`.slice(0, 40) });
  }

  // Resolver un hallazgo DETERMINÍSTICO en un chat supervisado (acceptEdits) con
  // su detalle + procedimiento. No gasta la corrida IA: acciona el lead directo.
  async function resolveFinding(f) {
    const prompt = [
      t('system.coherence.resolvePromptIntro', 'El Módulo de Coherencia de la consola (Claude Web Console) detectó esta incoherencia estructural (censo determinístico). Resolvela de forma supervisada.'),
      '',
      `${t('system.coherence.categoryLabel', 'Categoría:')} ${f.categoria} · ${t('system.coherence.severityLabel', 'Severidad:')} ${f.severidad}`,
      `${t('system.coherence.focusLabel', 'Foco:')} ${f.foco}`,
      `${t('system.coherence.detailLabel', 'Detalle:')} ${f.detalle}`,
      `${t('system.coherence.suggestionPlainLabel', 'Sugerencia:')} ${f.sugerencia}`,
      f.pasos?.length ? `${t('system.coherence.suggestedProcedureLabel', 'Procedimiento sugerido:')}\n${f.pasos.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` : '',
      '',
      t('system.coherence.strictRulesHeader', 'Reglas ESTRICTAS:'),
      t('system.coherence.resolveRule1', '1. Leé el CLAUDE.md de la raíz ANTES de tocar nada: las reglas duras (1-9) son inviolables (blindaje read-only de dos capas, runners desacoplados, bind ZeroTier…).'),
      t('system.coherence.resolveRule2', '2. Verificá leyendo el código que la incoherencia sigue vigente. Si es un FALSO POSITIVO (p.ej. un módulo helper que no debe montarse, o un runner referenciado dinámicamente), avisame y no toques nada.'),
      t('system.coherence.applyRule3', '3. Preferí SIEMPRE reusar la fuente/servicio canónico existente en vez de duplicar lógica.'),
      t('system.coherence.applyRule4', '4. Verificá cada archivo .js que edites con `node --check`.'),
      t('system.coherence.applyRule5', '5. FRENÁ y pedime confirmación ANTES de cualquier acción de alto riesgo (git push, reiniciar el servicio, borrar datos).'),
      t('system.coherence.resolveRule6', '6. Al terminar, resumí qué cambiaste, en qué archivos y cómo verificarlo.'),
    ].filter(Boolean).join('\n');
    onClose?.();
    await openChat?.({ cwd: 'claude-web-console', mode: 'acceptEdits', prompt, title: `${t('system.coherence.shortTitle', 'Coherencia')}: ${f.foco}`.slice(0, 40) });
  }

  async function exploreFlow(fn) {
    const prompt = [
      t('system.coherence.flowPromptIntro', 'El Módulo de Coherencia de la consola (Claude Web Console) propuso este FLUJO NUEVO para mejorar cómo se aprovechan los motores/módulos entre sí. Explorá el diseño en modo plan: evaluá si conviene, cómo encaja con la arquitectura (runners desacoplados, regla de oro, regla 6 de CLAUDE.md) y armá el plan de implementación. NO implementes nada todavía.'),
      '',
      `${t('system.coherence.titleLabel', 'Título:')} ${fn.titulo}`,
      `${t('system.coherence.descriptionLabel', 'Descripción:')} ${fn.descripcion}`,
      fn.diseno?.length ? `${t('system.coherence.proposedDesignLabel', 'Diseño propuesto:')}\n${fn.diseno.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
    onClose?.();
    await openChat?.({ cwd: 'claude-web-console', mode: 'plan', prompt, title: `${t('system.coherence.flowTitle', 'Flujo')}: ${fn.titulo}`.slice(0, 40) });
  }

  wrap.innerHTML = `<p class="hp-running">${pacman()} ${t('system.coherence.loading', 'cargando…')}</p>`;
  load();
  return { stop };
}

// Wrapper standalone: monta Coherencia en su propio modal (uso directo).
export function openCoherence(ctx, { isAdmin }) {
  const { dialog } = ctx;
  const m = dialog.openModal({ title: `🔗 ${t('system.coherence.modalTitle', 'Coherencia de motores y módulos')}`, width: 900 });
  m.card.classList.add('dlg-card--health');
  const inst = mountCoherence(m.body, ctx, { isAdmin, onClose: () => m.close() });
  const origClose = m.close;
  m.close = () => { inst.stop(); origClose(); };
  m.overlay.addEventListener('mousedown', (e) => { if (e.target === m.overlay) m.close(); });
}
