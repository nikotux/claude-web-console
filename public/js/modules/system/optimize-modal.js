// modules/system/optimize-modal.js — sub-ventana de la OPTIMIZACIÓN IA de los
// motores (gemela de health-review-modal: la pestaña Salud muestra solo el
// resumen compacto + botón; el contenido completo vive acá).
//
// Adentro: censo determinístico de motores (GET /ai-census, 0 tokens), botón
// "Analizar con IA" (POST /optimize → runner desacoplado, CONSUME TOKENS,
// confirm) y las propuestas con Aplicar en chat (supervisado, acceptEdits) /
// Descartar. El flujo nuevo se explora en chat modo plan. NADA se auto-aplica.
import { icon } from '../../ui/icons.js';
import { t } from '../../ui/i18n.js';
import { pacman } from '../../ui/pacman.js';

const API = '/api/health';
const POLL_MS = 4000;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' · ' + new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '—');
const TIPO_ICON = { modelo: '🤖', turnos: '🔁', timeout: '⏱', flujo: '🕸', fusion: '🧩', paralelismo: '⚡', prompt: '📝', otro: '🔧' };
const engineName = (f) => String(f || '').split('/').pop().replace(/^cwc-|\.js$/g, '') || f;

function riskLabel(risk) {
  return {
    bajo: `🟢 ${t('system.optimize.riskLow', 'bajo')}`,
    medio: `🟡 ${t('system.optimize.riskMedium', 'medio')}`,
    alto: `🔴 ${t('system.optimize.riskHigh', 'alto')}`,
  }[risk];
}

function tipoLabel(tipo) {
  return {
    modelo: t('system.optimize.typeModel', 'Modelo'),
    turnos: t('system.optimize.typeTurns', 'Turnos'),
    timeout: t('system.optimize.typeTimeout', 'Timeout'),
    flujo: t('system.optimize.typeFlow', 'Flujo'),
    fusion: t('system.optimize.typeFusion', 'Fusión'),
    paralelismo: t('system.optimize.typeParallelism', 'Paralelismo'),
    prompt: t('system.optimize.typePrompt', 'Prompt'),
    otro: t('system.optimize.typeAdjustment', 'Ajuste'),
  }[tipo];
}

// Abre la sub-ventana. `ctx` trae dialog + openChat (para aplicar una propuesta).
export function openOptimize(ctx, { isAdmin }) {
  const { dialog, openChat } = ctx;
  // En desktop el censo nace abierto (hay lugar); en móvil, colapsado.
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const m = dialog.openModal({ title: `🧠 ${t('system.optimize.modalTitle', 'Optimización IA de los motores')}`, width: 900 });
  m.card.classList.add('dlg-card--health');
  const wrap = document.createElement('div');
  wrap.className = 'hp-opt';
  m.body.appendChild(wrap);

  let alive = true;
  let pollTimer = null;
  const origOnClose = m.close;
  m.close = () => { alive = false; clearTimeout(pollTimer); origOnClose(); };
  m.overlay.addEventListener('mousedown', (e) => { if (e.target === m.overlay) m.close(); });

  // ===== Censo en ÁRBOL: grupo padre colapsable → motores anidados =====
  // (convención "UI textual = colapsable + árbol", pedido del usuario
  // 2026-07-04: vista general primero, detalle a demanda).
  function censusRows(items) {
    return items.map((e) => {
      const model = e.models?.length ? e.models.join('/') : (e.modelDynamic ? t('system.optimize.dynamicModel', 'dinámico') : t('system.optimize.defaultModel', 'default'));
      const capas = (e.layers?.preToolUse ? 1 : 0) + (e.layers?.canUseTool ? 1 : 0);
      const blind = capas === 2 ? '🔒×2' : capas === 1 ? '🔓×1' : '—';
      return `<tr title="${esc(e.file)}${e.purpose ? ` — ${esc(e.purpose)}` : ''}">
        <td>${esc(engineName(e.file))}</td>
        <td><b>${esc(model)}</b></td>
        <td>${esc((e.maxTurns || []).join('/') || '—')}</td>
        <td>${blind}</td>
        <td>${esc(e.settingSources || '—')}</td>
      </tr>`;
    }).join('');
  }

  function censusHtml(census) {
    const engines = census?.engines || [];
    const groups = [
      { label: `🏃 ${t('system.optimize.detachedRunnersGroup', 'Runners desacoplados (bin/)')}`, items: engines.filter((e) => e.file.startsWith('bin/')) },
      { label: `🧩 ${t('system.optimize.inlineRunsGroup', 'Corridas inline de módulos (src/)')}`, items: engines.filter((e) => !e.file.startsWith('bin/')) },
    ].filter((g) => g.items.length);
    return `<details class="hp-opt-census">
      <summary>📊 ${t('system.optimize.censusSummary', 'Censo · {count} motor(es) IA · qué modelo usa cada uno', { count: engines.length })}</summary>
      ${groups.map((g) => `
        <details class="hp-opt-group" ${isMobile ? '' : 'open'}>
          <summary>${g.label} · ${g.items.length}</summary>
          <table class="hp-opt-table">
            <thead><tr><th>${t('system.optimize.engineHeader', 'Motor')}</th><th>${t('system.optimize.modelHeader', 'Modelo')}</th><th>${t('system.optimize.turnsHeader', 'Turnos')}</th><th>${t('system.optimize.layersHeader', 'Capas')}</th><th>${t('system.optimize.settingsHeader', 'Settings')}</th></tr></thead>
            <tbody>${censusRows(g.items)}</tbody>
          </table>
        </details>`).join('')}
    </details>`;
  }

  // ===== Propuestas: agrupadas por MOTOR (árbol) y cada una COLAPSABLE =====
  // Header siempre visible (tipo · síntesis · riesgo/estado); el cuerpo
  // (actual→propuesta, razón, acciones) se abre a demanda.
  function proposalHtml(p) {
    const decided = p.status === 'accepted' ? `<span class="hp-opt-done">✅ ${t('system.optimize.accepted', 'aceptada')}</span>` : '';
    const actions = isAdmin && p.status === 'pending' ? `
      <div class="hp-opt-actions">
        <button class="btn-ghost btn--sm" data-act="optreject" data-id="${esc(p.id)}">✕ ${t('system.optimize.discard', 'Descartar')}</button>
        <button class="btn btn--sm" data-act="optapply" data-id="${esc(p.id)}">💬 ${t('system.optimize.applyInChat', 'Aplicar en chat')}</button>
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
        <div class="hp-detail">${esc(p.razon)}${p.impacto ? ` · <b>${t('system.optimize.gainLabel', 'Gana:')}</b> ${esc(p.impacto)}` : ''}</div>
        ${actions}
      </div>
    </details>`;
  }

  function proposalsTreeHtml(list) {
    const byMotor = new Map();
    for (const p of list) {
      if (!byMotor.has(p.motor)) byMotor.set(p.motor, []);
      byMotor.get(p.motor).push(p);
    }
    return [...byMotor.entries()].map(([motor, ps]) => {
      const pend = ps.filter((p) => p.status === 'pending').length;
      return `<details class="hp-opt-group" open>
        <summary>⚙️ ${esc(motor)} · ${t('system.optimize.proposalsCount', '{count} propuesta(s)', { count: ps.length })}${pend ? ` · ${t('system.optimize.pendingCount', '{count} pendiente(s)', { count: pend })}` : ` · ${t('system.optimize.upToDate', 'al día')}`}</summary>
        ${ps.map(proposalHtml).join('')}
      </details>`;
    }).join('');
  }

  function render(census, d) {
    const parts = [censusHtml(census)];
    if (d.running) {
      // Sin fase todavía = reservó el lock y está arrancando (queued); con fase
      // = la IA ya está trabajando el análisis (delegating).
      const phase = d.progress?.phase;
      parts.push(`<p class="hp-running">${pacman({ state: phase ? 'delegating' : 'queued' })} ${phase ? `${t('system.optimize.analyzing', 'Analizando')} · ${esc(phase)}` : t('system.optimize.queuedStarting', 'En cola · arrancando el análisis…')}</p>`);
    } else if (d.error) {
      parts.push(`<p class="hp-error">${t('system.optimize.lastAnalysisFailed', 'El último análisis falló:')} ${esc(d.error)}</p>`);
    }
    if (d.updatedAt && d.resumen) {
      const pend = (d.propuestas || []).filter((p) => p.status === 'pending').length;
      parts.push(`<div class="hp-verdict hp-verdict--${pend ? 'atencion' : 'ok'}">
        <b>${pend ? t('system.optimize.pendingProposalsCount', '{count} propuesta(s) pendiente(s)', { count: pend }) : t('system.optimize.noPendingProposals', 'Sin propuestas pendientes')}</b>
        <span class="hp-when">${fmtDate(d.updatedAt)}</span>
      </div>`);
      // Resumen largo → colapsable (abierto en desktop, plegado en móvil).
      parts.push(`<details class="hp-opt-resumen-box" ${isMobile ? '' : 'open'}>
        <summary>📋 ${t('system.optimize.analysisSummary', 'Resumen del análisis')}</summary>
        <p class="hp-opt-resumen">${esc(d.resumen)}</p>
      </details>`);
      parts.push(proposalsTreeHtml((d.propuestas || []).filter((p) => p.status !== 'rejected')));
      if (d.flujoNuevo?.vale) {
        parts.push(`<details class="hp-opt-card hp-opt-card--flow">
          <summary class="hp-opt-head"><span>🕸</span><b>${t('system.optimize.newFlowProposed', 'Flujo nuevo propuesto')}</b><span class="hp-opt-snippet">${esc(d.flujoNuevo.titulo)}</span></summary>
          <div class="hp-opt-body">
            <div class="hp-detail">${esc(d.flujoNuevo.descripcion)}</div>
            <ul class="hp-opt-flow">${(d.flujoNuevo.diseno || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
            ${isAdmin ? `<div class="hp-opt-actions"><button class="btn-ghost btn--sm" data-act="optflow">💬 ${t('system.optimize.exploreInChatPlan', 'Explorar en chat (plan)')}</button></div>` : ''}
          </div>
        </details>`);
      }
    } else if (!d.running) {
      parts.push(`<p class="hp-empty">${t('system.optimize.notRun', 'Todavía no se corrió ningún análisis de optimización.')}</p>`);
    }
    if (isAdmin) {
      parts.push(`<button class="btn btn--block" data-act="optrun" ${d.running ? 'disabled' : ''}>${icon('gear', { size: 14 })}<span>${d.running ? t('system.optimize.analysisRunning', 'Análisis en curso…') : t('system.optimize.analyzeWithAi', 'Analizar con IA')}</span></button>`);
    }
    wrap.innerHTML = parts.join('');

    wrap.querySelector('[data-act="optrun"]')?.addEventListener('click', runOptimize);
    wrap.querySelector('[data-act="optflow"]')?.addEventListener('click', () => exploreFlow(d.flujoNuevo));
    for (const b of wrap.querySelectorAll('[data-act="optapply"]')) {
      b.addEventListener('click', () => {
        const p = (d.propuestas || []).find((x) => x.id === b.dataset.id);
        if (p) applyProposal(p);
      });
    }
    for (const b of wrap.querySelectorAll('[data-act="optreject"]')) {
      b.addEventListener('click', async () => {
        await decideProposal(b.dataset.id, 'reject');
        load();
      });
    }
  }

  async function load() {
    clearTimeout(pollTimer);
    try {
      const [census, d] = await Promise.all([
        fetch(`${API}/ai-census`).then((r) => r.json()),
        fetch(`${API}/optimization`).then((r) => r.json()),
      ]);
      if (!alive) return;
      render(census, d);
      if (d.running) pollTimer = setTimeout(load, POLL_MS);
    } catch {
      if (alive) wrap.innerHTML = `<p class="hp-empty">${t('system.optimize.readError', 'No se pudo leer la optimización.')}</p>`;
    }
  }

  async function runOptimize() {
    const ok = await dialog.confirmDialog({
      title: t('system.optimize.analysisDialogTitle', 'Optimización IA'),
      message: t('system.optimize.analysisDialogMessage', 'Analiza el flujo de TODOS los motores IA de la consola (censo + consumo real + lectura del código con Sonnet) y propone optimizaciones.\n\nCorre desacoplado (sobrevive reinicios) y CONSUME TOKENS. Nada se aplica solo: cada propuesta la aprobás vos.'),
      confirmLabel: t('system.optimize.analyzeUsesTokens', 'Analizar (usa tokens)'),
    });
    if (!ok) return;
    try {
      const res = await fetch(`${API}/optimize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || res.status);
    } catch (err) {
      await dialog.alertDialog({ title: t('system.optimize.analysisDialogTitle', 'Optimización IA'), message: t('system.optimize.launchError', 'No se pudo lanzar: {error}', { error: err.message || err }) });
    }
    load();
  }

  async function decideProposal(id, action) {
    try {
      const res = await fetch(`${API}/optimize-proposal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || res.status);
      return d.padRef || null;
    } catch (err) {
      await dialog.alertDialog({ title: t('system.optimize.analysisDialogTitle', 'Optimización IA'), message: t('system.optimize.saveDecisionError', 'No se pudo guardar la decisión: {error}', { error: err.message || err }) });
      return null;
    }
  }

  // Aprobar una propuesta = marcarla aceptada (crea la TAREA en Pad, ver
  // pad-writeback-shared.js) + abrir un chat SUPERVISADO (acceptEdits) con todo
  // el contexto para aplicarla. Nunca se aplica sola. Si Pad devolvió un ref, el
  // ÚLTIMO paso del chat cierra el circuito marcándola 'hecha' en Pad.
  async function applyProposal(p) {
    const padRef = await decideProposal(p.id, 'accept');
    const prompt = [
      t('system.optimize.applyPromptIntro', 'La Optimización IA de la consola (Claude Web Console) propuso esta mejora sobre un motor IA. Aplicala de forma supervisada.'),
      '',
      `${t('system.optimize.engineLabel', 'Motor:')} ${p.motor}${p.archivo ? ` (${p.archivo})` : ''}`,
      `${t('system.optimize.typeLabel', 'Tipo:')} ${p.tipo} · ${t('system.optimize.riskLabel', 'Riesgo:')} ${p.riesgo}`,
      `${t('system.optimize.currentLabel', 'Actual:')} ${p.actual}`,
      `${t('system.optimize.proposalLabel', 'Propuesta:')} ${p.propuesta}`,
      `${t('system.optimize.reasonLabel', 'Razón:')} ${p.razon}`,
      p.impacto ? `${t('system.optimize.expectedImpactLabel', 'Impacto esperado:')} ${p.impacto}` : '',
      p.archivos?.length ? `${t('system.optimize.filesToTouchLabel', 'Archivos a tocar:')} ${p.archivos.join(', ')}` : '',
      p.pasos?.length ? `${t('system.optimize.suggestedStepsLabel', 'Pasos sugeridos:')}\n${p.pasos.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` : '',
      '',
      t('system.optimize.strictRulesHeader', 'Reglas ESTRICTAS:'),
      t('system.optimize.applyRule1', '1. Leé el CLAUDE.md de la raíz ANTES de tocar nada: las reglas duras (1-9) son inviolables — en particular el blindaje read-only de dos capas de las corridas headless y los runners desacoplados.'),
      t('system.optimize.applyRule2', '2. Verificá leyendo el código que la propuesta sigue vigente y es correcta. Si no aplica, avisame y no toques nada.'),
      t('system.optimize.applyRule3', '3. Verificá cada archivo .js que edites con `node --check`.'),
      t('system.optimize.applyRule4', '4. FRENÁ y pedime confirmación ANTES de cualquier acción de alto riesgo (git push, reiniciar el servicio, borrar datos).'),
      t('system.optimize.applyRule5', '5. Al terminar, resumí qué cambiaste, en qué archivos y cómo verificarlo.'),
      padRef ? t('system.optimize.applyRule6', '6. Como ÚLTIMO paso, tras verificar el cambio, ejecutá:\n   node bin/cwc-health-proposal-done.js {padRef}', { padRef }) : '',
    ].filter(Boolean).join('\n');
    m.close();
    await openChat?.({ cwd: 'claude-web-console', mode: 'acceptEdits', prompt, title: `${t('system.optimize.chatTitleOptimize', 'Optimizar')}: ${p.motor}`.slice(0, 40) });
  }

  // El flujo nuevo se EXPLORA en modo plan (no toca nada hasta que apruebes).
  async function exploreFlow(fn) {
    const prompt = [
      t('system.optimize.flowPromptIntro', 'La Optimización IA de la consola (Claude Web Console) propuso este FLUJO NUEVO. Explorá el diseño en modo plan: evaluá si conviene, cómo encaja con la arquitectura (runners desacoplados, regla de oro, regla 6 de CLAUDE.md) y armá el plan de implementación. NO implementes nada todavía.'),
      '',
      `${t('system.optimize.titleLabel', 'Título:')} ${fn.titulo}`,
      `${t('system.optimize.descriptionLabel', 'Descripción:')} ${fn.descripcion}`,
      fn.diseno?.length ? `${t('system.optimize.proposedDesignLabel', 'Diseño propuesto:')}\n${fn.diseno.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
    m.close();
    await openChat?.({ cwd: 'claude-web-console', mode: 'plan', prompt, title: `${t('system.optimize.flowTitle', 'Flujo')}: ${fn.titulo}`.slice(0, 40) });
  }

  wrap.innerHTML = `<p class="hp-running">${pacman()} ${t('system.optimize.loading', 'cargando…')}</p>`;
  load();
}
