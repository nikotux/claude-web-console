// modules/system/health-review-modal.js — sub-ventana a pantalla completa de
// la REVISIÓN EXHAUSTIVA de salud.
//
// El backend corre un barrido módulo por módulo (runner desacoplado) y
// escribe progreso incremental; acá se encuesta GET /api/health/review y se
// muestra en vivo: barra de progreso + grilla de módulos con su estado +
// hallazgos que van apareciendo, agrupados por severidad. Cada hallazgo
// accionable abre un CHAT supervisado en la consola con el detalle
// precargado (la revisión NUNCA modifica código sola — regla 6).
import { icon } from '../../ui/icons.js';
import { t } from '../../ui/i18n.js';
import { pacman } from '../../ui/pacman.js';

const API = '/api/health';
const POLL_MS = 2500;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' ' + new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '—');

function verdictLabel(verdict) {
  return {
    ok: t('system.healthReview.verdictOk', 'Todo en orden'),
    atencion: t('system.healthReview.verdictAttention', 'Requiere atención'),
    critico: t('system.healthReview.verdictCritical', 'CRÍTICO'),
  }[verdict];
}

function severityLabel(severity) {
  return {
    critical: t('system.healthReview.severityCritical', 'crítico'),
    high: t('system.healthReview.severityHigh', 'alto'),
    medium: t('system.healthReview.severityMedium', 'medio'),
    low: t('system.healthReview.severityLow', 'bajo'),
  }[severity];
}

function kindLabel(kind) {
  return {
    bug: `🐛 ${t('system.healthReview.kindBug', 'bug')}`,
    regla: `📏 ${t('system.healthReview.kindRule', 'regla')}`,
    mejora: `✨ ${t('system.healthReview.kindImprovement', 'mejora')}`,
  }[kind];
}

// Abre esta sub-ventana. `ctx` trae dialog + openChat (para trabajar un hallazgo).
// Monta el contenido de la Revisión en un contenedor `host` (reusable: lo usa
// el Escaneo de Salud unificado como sección inline, y openHealthReview como
// modal standalone). `onClose` cierra el modal contenedor al resolver en chat.
// Devuelve { stop } para frenar el poll.
export function mountHealthReview(host, ctx, { isAdmin, onClose } = {}) {
  const { dialog, openChat } = ctx;
  // En pantallas chicas todo nace COLAPSADO (vista general; detalle a demanda);
  // en desktop, expandido (hay lugar). Se evalúa una vez al abrir.
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const wrap = document.createElement('div');
  wrap.className = 'hr-wrap';
  host.innerHTML = '';
  host.appendChild(wrap);

  let alive = true;
  let pollTimer = null;
  let solvedLog = []; // registro durable (GET /solved), refrescado en cada tick
  let batchState = null; // estado del batch de resolución (Fase B), polea GET /batch
  let proposals = []; // invariantes propuestos pendientes de aprobación (F5)
  let lastData = null; // último estado renderizado (para parches optimistas)
  // TÁNDEM opt-in (2026-07-19): toggle persistido SOLO en memoria de esta
  // sub-ventana (se resetea al reabrir, a propósito — es una elección puntual,
  // no una config global). Afecta SOLO al "Automático" de a UNO (autoFix): el
  // batch/"Resolver seguros" sigue con su orquestador de siempre (fuera de
  // alcance de este cambio).
  let useTandem = false;
  function stop() { alive = false; clearTimeout(pollTimer); obs.disconnect(); }
  const obs = new MutationObserver(() => { if (!host.isConnected) stop(); });
  obs.observe(document.body, { childList: true, subtree: true });

  // ¿El hallazgo está BLOQUEADO para auto-fix? Superficie crítica (pol.risk:
  // toca server/auth/registry/…) O severidad crítica del bug (los más delicados
  // van a chat supervisado). Espeja el gate REAL del backend (health/index.js).
  const isBlocked = (f) => f.policy?.risk === 'critical' || String(f.severity) === 'critical';
  const blockReason = (f) => (f.policy?.risk === 'critical' ? (f.policy.reason || t('system.healthReview.criticalSurface', 'superficie crítica')) : t('system.healthReview.criticalBugSeverity', 'severidad crítica del bug'));
  // Item del batch (Fase B) correspondiente a este hallazgo, si hay batch vivo.
  const batchItemOf = (f) => (batchState?.items || []).find((x) => x.id === f.id);

  // Chip de PROGRESO por hallazgo dentro del batch: Pac-Man masticando =
  // resolviéndose AHORA (ves cuáles corren a la vez), dormido = en cola, ✅/🔴
  // terminales. Es lo que pediste para ver el estado de cada uno en vivo.
  function batchItemBadge(it) {
    if (!it) return '';
    // Retrocompat: corridas viejas marcaban el falso positivo como 'failed' con
    // "falso positivo" en el error. Se muestra como descartado, no como error.
    const status = (it.status === 'failed' && /falso positivo/i.test(it.error || '')) ? 'dismissed' : it.status;
    switch (status) {
      case 'pending': return `<span class="hr-badge hr-badge--queue" title="${t('system.healthReview.queueTitle', 'En cola para resolver')}">${pacman({ state: 'queued' })}<span>${t('system.healthReview.queued', 'en cola')}</span></span>`;
      case 'fixing': return `<span class="hr-badge hr-badge--fixing" title="${t('system.healthReview.fixingTitle', 'Resolviendo ahora (delegado a su propio sandbox aislado)')}">${pacman({ state: 'delegating' })}<span>${t('system.healthReview.fixing', 'resolviendo')}</span></span>`;
      case 'ready': return `<span class="hr-badge hr-badge--fixing" title="${t('system.healthReview.readyTitle', 'Fix listo en el sandbox — en cola para la integración serial al código real')}">${pacman({ state: 'queued' })}<span>${t('system.healthReview.readyToIntegrate', 'listo p/ integrar')}</span></span>`;
      case 'integrated': return `<span class="hr-badge hr-badge--ok">✅ ${t('system.healthReview.resolvedLower', 'resuelto')}</span>`;
      case 'conflict': return `<span class="hr-badge hr-badge--fail" title="${t('system.healthReview.conflictTitle', 'Conflicto al integrar (quedó sin aplicar): {error}', { error: esc(it.error || '') })}">🔴 ${t('system.healthReview.conflict', 'conflicto')}</span>`;
      case 'check-failed': return `<span class="hr-badge hr-badge--fail" title="${t('system.healthReview.checkFailedTitle', 'No pasó node --check al integrar: {error}', { error: esc(it.error || '') })}">🔴 ${t('system.healthReview.checkFailed', 'falló el check')}</span>`;
      case 'dismissed': return `<span class="hr-badge hr-badge--dismiss" title="${t('system.healthReview.dismissedTitle', 'El modelo revisó el código y NO era un bug (falso positivo): {error}', { error: esc(it.error || '') })}">⊘ ${t('system.healthReview.notABug', 'no era bug')}</span>`;
      case 'failed': return `<span class="hr-badge hr-badge--fail" title="${t('system.healthReview.failedTitle', 'Era real pero no se pudo arreglar: {error}', { error: esc(it.error || t('system.healthReview.genericError', 'error')) })}">🔴 ${t('system.healthReview.genericError', 'error')}</span>`;
      default: return '';
    }
  }

  // Badge de estado en el header: bloqueo + recurrencia + estado de resolución.
  // Con batch vivo, el estado por-ítem (Pac-Man) manda sobre el fixStatus grueso.
  function statusBadge(f) {
    const parts = [];
    if (isBlocked(f)) parts.push(`<span class="hr-badge hr-badge--crit" title="${t('system.healthReview.noAutoResolveTitle', 'No se auto-resuelve ({reason}) — solo chat supervisado', { reason: esc(blockReason(f)) })}">🔒 ${String(f.severity) === 'critical' ? t('system.healthReview.severityCritical', 'crítico') : t('system.healthReview.protected', 'protegido')}</span>`);
    if (f.recurrent) parts.push(`<span class="hr-badge hr-badge--rec" title="${t('system.healthReview.recurrentTitle', 'Ya se había resuelto antes ({times}×) y volvió a aparecer — candidato a análisis exhaustivo', { times: f.recurrent.times })}">🔁 ${t('system.healthReview.recurrent', 'recurrente')}${f.recurrent.times > 1 ? ` ×${f.recurrent.times}` : ''}</span>`);
    const it = batchItemOf(f);
    if (it) {
      parts.push(batchItemBadge(it)); // estado por-ítem del batch (Pac-Man en vivo)
    } else if (f.fixStatus === 'fixing') parts.push(`<span class="hr-badge hr-badge--fixing">🔧 ${t('system.healthReview.resolvingEllipsis', 'resolviendo…')}</span>`);
    else if (f.fixStatus === 'resolved') parts.push(`<span class="hr-badge hr-badge--ok">✅ ${t('system.healthReview.resolvedLower', 'resuelto')}</span>`);
    else if (f.fixStatus === 'dismissed') parts.push(`<span class="hr-badge hr-badge--dismiss" title="${t('system.healthReview.reviewedDismissedTitle', 'Revisado y descartado: no era un bug (falso positivo)')}${f.knownFalsePositive ? ` · ${t('system.healthReview.knownBefore', 'ya conocido de antes')}` : ''}">⊘ ${t('system.healthReview.notABug', 'no era bug')}</span>`);
    else if (f.fixStatus === 'failed') parts.push(`<span class="hr-badge hr-badge--fail">⚠ ${t('system.healthReview.failed', 'falló')}</span>`);
    return parts.join(' ');
  }

  // Acciones del hallazgo según su estado de resolución:
  //  - resuelto  → sin botones (✅ + resumen del fix).
  //  - resolviendo → Pac-Man, sin botones.
  //  - abierto/falló → dos botones: 💬 En chat (supervisado) y ⚡ Automático
  //    (runner autónomo; la tarjeta se actualiza sola). Falló ⇒ + reintentar.
  function actions(f) {
    if (!(isAdmin && openChat)) return '';
    if (f.fixStatus === 'fixing') return `<div class="hr-f-actions hr-f-fixing">${pacman({ state: 'delegating' })}<span>${t('system.healthReview.resolvingAutomatically', 'resolviendo automáticamente…')}</span></div>`;
    if (f.fixStatus === 'resolved') return `<div class="hr-f-resolved">✅ ${t('system.healthReview.resolved', 'Resuelto')}${f.fixSummary ? `: ${esc(f.fixSummary)}` : ''}</div>`;
    if (f.fixStatus === 'dismissed') {
      return `<div class="hr-f-dismiss">⊘ ${t('system.healthReview.notABugFalsePositive', 'No era un bug (falso positivo)')}${f.dismissReason ? `: ${esc(f.dismissReason)}` : ''}</div>
        <div class="hr-f-actions"><button class="btn-ghost btn--sm" data-act="restore" title="${t('system.healthReview.restoreTitle', 'Se descartó mal: sacalo del registro de falsos positivos y volvé a ponerlo en la cola por resolver')}">${icon('refresh', { size: 13 })}<span>${t('system.healthReview.restoreToQueue', 'Restaurar a la cola')}</span></button></div>`;
    }
    const failLine = f.fixStatus === 'failed' && f.fixError ? `<div class="hr-f-fail">⚠ ${t('system.healthReview.autoFixFailed', 'Auto-fix falló:')} ${esc(f.fixError)}</div>` : '';
    // GATE de política: superficie crítica O severidad crítica bloquean
    // "Automático" (queda solo "En chat"). Espeja el gate del backend.
    const critical = isBlocked(f);
    const critNote = critical
      ? `<div class="hr-f-crit">⚠️ ${t('system.healthReview.noAutoResolveNote', 'No se auto-resuelve ({reason}) — hacelo', { reason: esc(blockReason(f)) })} <b>${t('system.healthReview.inChat', 'En chat')}</b>, ${t('system.healthReview.supervised', 'supervisado')}.</div>`
      : '';
    const autoBtn = critical
      ? `<button class="btn btn--sm" data-act="autofix" disabled title="${t('system.healthReview.noAutoResolveUseChatTitle', "No se auto-resuelve: {reason}. Usá 'En chat'.", { reason: esc(blockReason(f)) })}">${icon('gear', { size: 13 })}<span>${t('system.healthReview.automaticLocked', 'Automático 🔒')}</span></button>`
      : `<button class="btn btn--sm" data-act="autofix" title="${t('system.healthReview.autoFixTitle', 'Lo resuelve un runner autónomo: edita y verifica con node --check, sin supervisión; NO reinicia el servicio. La tarjeta se actualiza sola.')}">${icon('gear', { size: 13 })}<span>${f.fixStatus === 'failed' ? t('system.healthReview.retryAuto', 'Reintentar auto') : t('system.healthReview.automatic', 'Automático')}</span></button>`;
    return `${failLine}${critNote}<div class="hr-f-actions">
      <button class="btn-ghost btn--sm" data-act="chat" title="${t('system.healthReview.chatTitle', 'Abre un chat supervisado para resolverlo (acepta ediciones; frena y te avisa en alto riesgo)')}">${icon('sparkle', { size: 13 })}<span>${t('system.healthReview.inChat', 'En chat')}</span></button>
      ${autoBtn}
      <button class="btn-ghost btn--sm" data-act="markresolved" title="${t('system.healthReview.markResolvedTitle', 'Marcalo como resuelto en el tablero SIN tocar código (red de seguridad: si ya lo arreglaste en un chat, dejá la lista al día)')}">${icon('check', { size: 13 })}<span>${t('system.healthReview.markResolved', 'Marcar resuelto')}</span></button>
    </div>`;
  }

  // Tarjeta COLAPSABLE: header (severidad · tipo · área · módulo · estado)
  // siempre visible + chevron; el cuerpo (detalle, archivo, fix, acciones) se
  // pliega. `resolved` = viene de la sección "Resueltos" (nace colapsada).
  function findingCard(f) {
    const sev = f.severity || 'medium';
    const collapsed = (isMobile || f.fixStatus === 'resolved' || f.fixStatus === 'dismissed') ? ' hr-collapsed' : '';
    return `
      <div class="hr-finding hr-finding--${esc(sev)}${collapsed}" data-idx="${f._i}" data-id="${esc(f.id || '')}">
        <div class="hr-f-head" data-toggle="1">
          <span class="hr-chev">${icon('chevronDown', { size: 13 })}</span>
          <span class="hr-sev hr-sev--${esc(sev)}">${severityLabel(sev) || sev}</span>
          <span class="hr-kind">${kindLabel(f.kind) || f.kind || ''}</span>
          <span class="hr-f-area">${esc(f.area)}</span>
          <span class="hr-f-mod">${esc(f.module || '')}</span>
          ${statusBadge(f)}
        </div>
        <div class="hr-f-body">
          <p class="hr-f-detail">${esc(f.detail)}</p>
          ${f.file ? `<div class="hr-f-file">📄 ${esc(f.file)}</div>` : ''}
          ${f.suggestedFix ? `<p class="hr-f-fix">🔧 ${esc(f.suggestedFix)}</p>` : ''}
          ${actions(f)}
        </div>
      </div>`;
  }

  function render(d) {
    lastData = d;
    const running = !!d.running;
    const total = d.total || (d.units?.length || 0) + 1;
    const done = d.done || 0;
    const pct = total ? Math.round((done / total) * 100) : 0;

    const units = (d.units || []).map((u) => {
      const cls = u.status === 'running' ? 'hr-unit--running'
        : u.status === 'cached' ? 'hr-unit--cached'
          : u.status === 'done' ? 'hr-unit--done'
            : u.status === 'error' ? 'hr-unit--error' : '';
      const n = (u.status === 'done' || u.status === 'cached') && u.findings ? `<span class="hr-unit-n">${u.findings}</span>` : '';
      const tip = u.status === 'cached' ? ` · ${t('system.healthReview.unchangedReused', 'sin cambios (reusado)')}` : u.error ? ` · ${esc(u.error)}` : '';
      return `<span class="hr-unit ${cls}" title="${esc(u.label)}${tip}"><span class="hr-unit-dot"></span>${esc(u.label.replace(/^Módulo /, ''))}${n}</span>`;
    }).join('');

    const all = (d.findings || []).map((f, i) => ({ ...f, _i: i }));
    const bySev = (a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9);
    // Activos = todo lo que NO está resuelto (arriba, accionable). Resueltos =
    // abajo, en su propia sección colapsable.
    // Activos = ni resueltos ni descartados (falsos positivos). Los descartados
    // salen de la cola "por resolver" y van a su propia sección.
    const activos = all.filter((f) => f.fixStatus !== 'resolved' && f.fixStatus !== 'dismissed').sort(bySev);
    const resueltos = all.filter((f) => f.fixStatus === 'resolved')
      .sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0));
    const descartados = all.filter((f) => f.fixStatus === 'dismissed')
      .sort((a, b) => (b.dismissedAt || 0) - (a.dismissedAt || 0));
    const nFixing = all.filter((f) => f.fixStatus === 'fixing').length;
    const nOpen = activos.length - nFixing;
    // Auto-resolubles en batch: abiertos, NO bloqueados (ni superficie ni
    // severidad crítica), no en curso.
    const autoables = activos.filter((f) => !isBlocked(f) && f.fixStatus !== 'fixing');
    const nAuto = autoables.length;
    const resumen = [
      t('system.healthReview.findingsCount', '{count} hallazgo(s)', { count: all.length }),
      resueltos.length ? `✅ ${t('system.healthReview.resolvedCount', '{count} resuelto(s)', { count: resueltos.length })}` : '',
      descartados.length ? `⊘ ${t('system.healthReview.notBugCount', '{count} no eran bug', { count: descartados.length })}` : '',
      nFixing ? `🔧 ${t('system.healthReview.resolvingCount', '{count} resolviendo', { count: nFixing })}` : '',
      t('system.healthReview.unresolvedCount', '{count} sin resolver', { count: nOpen }),
    ].filter(Boolean).join(' · ');

    wrap.innerHTML = `
      <div class="hr-progress">
        ${running ? pacman({ state: 'delegating' }) : ''}
        <div class="hr-bar"><span class="hr-bar-fill" style="width:${pct}%"></span></div>
        <span class="hr-phase">${running ? `${done}/${total} · ${esc(d.phase || t('system.healthReview.analyzingEllipsis', 'analizando…'))}` : t('system.healthReview.completedProgress', '{done}/{total} completado', { done, total })}</span>
      </div>
      ${units ? `<details class="hr-collapsible"${(isMobile && !running) ? '' : ' open'}><summary>${t('system.healthReview.analyzedModules', 'Módulos analizados ({count})', { count: d.units?.length || 0 })}</summary><div class="hr-units">${units}</div></details>` : ''}
      ${d.verdict ? `<div class="hr-verdict hr-verdict--${esc(d.liveVerdict || d.verdict)}"><b>${verdictLabel(d.liveVerdict || d.verdict) || d.liveVerdict || d.verdict}</b><span class="hr-phase">${resumen}</span></div>` : ''}
      ${d.summary ? `<details class="hr-collapsible"${isMobile ? '' : ' open'}><summary>${t('system.healthReview.analysisSummary', 'Resumen del análisis')}</summary><p class="hr-summary">${esc(d.summary)}</p></details>` : ''}
      ${d.error ? `<p class="hr-summary" style="color:var(--cwc-danger-strong)">⚠️ ${esc(d.error)}</p>` : ''}
      ${batchBannerHtml()}
      ${!running && !batchState?.running && isAdmin && nAuto ? `<label class="hr-tandem-toggle" title="${t('system.healthReview.tandemTitle', 'Con Tándem activo, el botón «Automático» de cada hallazgo ya no edita el código él mismo: delega la escritura del fix a Codex (GPT-5.6 Sol, esfuerzo alto) y Claude solo diagnostica/verifica. No afecta a «Resolver seguros» (batch).')}">
        <input type="checkbox" id="hr-tandem-chk"${useTandem ? ' checked' : ''}> 🤝 ${t('system.healthReview.tandemLabel', '«Automático» usa Tándem (Codex ejecuta el fix)')}
      </label>` : ''}
      ${!running && !batchState?.running && isAdmin ? `<div class="hr-actions-row">
        <button class="btn btn--block" data-ref="start" title="${t('system.healthReview.analyzeChangesTitle', 'Analiza SOLO los módulos que cambiaron desde la última revisión (los sin cambios se reusan). Rápido y barato.')}">${icon('gear', { size: 14 })}<span>${d.verdict || d.findings?.length ? t('system.healthReview.analyzeChanges', 'Analizar cambios') : t('system.healthReview.startDeepAnalysis', 'Iniciar análisis profundo')}</span></button>
        ${d.verdict || d.findings?.length ? `<button class="btn-ghost btn--block" data-ref="startfull" title="${t('system.healthReview.fullAnalysisTitle', 'Re-analiza TODOS los módulos desde cero, ignorando la caché (más lento y más tokens)')}">${icon('refresh', { size: 14 })}<span>${t('system.healthReview.full', 'Completo')}</span></button>` : ''}
        ${nAuto ? `<button class="btn btn--block hr-resolve-auto" data-ref="resolveauto" title="${t('system.healthReview.resolveSafeTitle', 'Resuelve los {count} hallazgos NO críticos en PARALELO (sandboxes aislados) + integración serial con node --check. No reinicia. Los críticos van solo por chat.', { count: nAuto })}">${icon('gear', { size: 14 })}<span>${t('system.healthReview.resolveSafeCount', 'Resolver seguros ({count})', { count: nAuto })}</span></button>` : ''}
        ${nOpen ? `<button class="btn-ghost btn--block hr-resolve-all" data-ref="resolveall" title="${t('system.healthReview.resolveAllTitle', 'Abre UN chat supervisado que trabaja todos los hallazgos sin resolver')}">${icon('sparkle', { size: 14 })}<span>${t('system.healthReview.resolveAllInChat', 'Resolver todo en chat')}</span></button>` : ''}
      </div>` : ''}
      <div class="hr-findings">
        ${activos.length ? activos.map(findingCard).join('')
    : running ? `<div class="hr-empty">${t('system.healthReview.analyzingModules', 'Analizando módulos…')}</div>`
      : all.length ? `<div class="hr-empty">${t('system.healthReview.allResolved', 'Todo resuelto 🎉 (ver "Resueltos" abajo)')}</div>`
        : `<div class="hr-empty">${t('system.healthReview.noFindingsHealthy', 'Sin hallazgos: el sistema está sano ✅')}</div>`}
      </div>
      ${resueltos.length ? `<details class="hr-collapsible hr-resolved-sec"><summary>✅ ${t('system.healthReview.resolvedInReview', 'Resueltos en esta revisión ({count})', { count: resueltos.length })}</summary>${resueltos.map(findingCard).join('')}</details>` : ''}
      ${descartados.length ? `<details class="hr-collapsible hr-dismiss-sec"><summary>⊘ ${t('system.healthReview.dismissedFalsePositives', 'Descartados · falsos positivos ({count}) — no se vuelven a escanear', { count: descartados.length })}</summary>${descartados.map(findingCard).join('')}</details>` : ''}
      ${(isAdmin && proposals.length) ? `<details class="hr-collapsible hr-prop-sec" open><summary>🧠 ${t('system.healthReview.proposedInvariants', 'Invariantes propuestos ({count}) — para aprobar', { count: proposals.length })}</summary>
        <div class="hr-prop-list">${proposals.map((pr) => `
          <div class="hr-prop" data-prop="${esc(pr.id)}">
            <p class="hr-prop-text">${esc(pr.text)}</p>
            <div class="hr-prop-meta"><code>${esc(pr.match || '—')}</code>${pr.fromFinding?.module ? ` · ${t('system.healthReview.fromLabel', 'de:')} ${esc(pr.fromFinding.module)}` : ''}</div>
            <div class="hr-prop-actions">
              <button class="btn-ghost btn--sm" data-prop-act="reject" title="${t('system.healthReview.discardProposalTitle', 'Descartar la propuesta')}">${icon('close', { size: 13 })}<span>${t('system.healthReview.discard', 'Descartar')}</span></button>
              <button class="btn btn--sm" data-prop-act="approve" title="${t('system.healthReview.approveInvariantTitle', 'Sumarlo a los invariantes verificados (invariants-learned.json)')}">${icon('check', { size: 13 })}<span>${t('system.healthReview.approve', 'Aprobar')}</span></button>
            </div>
          </div>`).join('')}</div>
      </details>` : ''}
      ${solvedLog.length ? `<details class="hr-collapsible hr-solved-sec"><summary>📓 ${t('system.healthReview.solvedLog', 'Registro de resueltos ({count})', { count: solvedLog.length })}</summary>
        <div class="hr-solved-list">${solvedLog.map((s) => `
          <div class="hr-solved-item">
            <span class="hr-solved-area">${esc(s.area || s.file || '—')}</span>
            <span class="hr-solved-mod">${esc(s.module || '')}</span>
            ${s.count > 1 ? `<span class="hr-badge hr-badge--rec" title="${t('system.healthReview.resolvedTimesTitle', 'Se resolvió {count} veces (recurrente)', { count: s.count })}">🔁 ×${s.count}</span>` : ''}
            <span class="hr-solved-date">${fmtDate(s.lastResolvedAt)}</span>
          </div>`).join('')}</div>
      </details>` : ''}`;

    for (const card of wrap.querySelectorAll('.hr-finding')) {
      // Tap en el header = plegar/desplegar (salvo si tocás un botón de acción).
      card.querySelector('[data-toggle]')?.addEventListener('click', (e) => {
        if (e.target.closest('[data-act]')) return;
        card.classList.toggle('hr-collapsed');
      });
      const f = all.find((x) => String(x._i) === card.dataset.idx);
      card.querySelector('[data-act="chat"]')?.addEventListener('click', (e) => { e.stopPropagation(); if (f) resolveInChat(f); });
      card.querySelector('[data-act="autofix"]')?.addEventListener('click', (e) => { e.stopPropagation(); if (f) autoFix(f); });
      card.querySelector('[data-act="markresolved"]')?.addEventListener('click', (e) => { e.stopPropagation(); if (f) markResolved(f); });
      card.querySelector('[data-act="restore"]')?.addEventListener('click', (e) => { e.stopPropagation(); if (f) restoreDismiss(f); });
    }
    wrap.querySelector('#hr-tandem-chk')?.addEventListener('change', (e) => { useTandem = e.target.checked; });
    wrap.querySelector('[data-ref="start"]')?.addEventListener('click', () => startReview(false));
    wrap.querySelector('[data-ref="startfull"]')?.addEventListener('click', () => startReview(true));
    wrap.querySelector('[data-ref="resolveauto"]')?.addEventListener('click', () => batchResolve(autoables));
    wrap.querySelector('[data-ref="resolveall"]')?.addEventListener('click', () => resolveAll(activos.filter((f) => f.fixStatus !== 'fixing')));
    for (const el of wrap.querySelectorAll('.hr-prop')) {
      el.querySelector('[data-prop-act="approve"]')?.addEventListener('click', () => decideProposal(el.dataset.prop, 'approve'));
      el.querySelector('[data-prop-act="reject"]')?.addEventListener('click', () => decideProposal(el.dataset.prop, 'reject'));
    }
  }

  // Lanza la revisión (el ÚNICO punto que gasta tokens). `full` = ignorar la
  // caché y re-auditar TODO; default = INCREMENTAL (solo lo que cambió).
  async function startReview(full = false) {
    const ok = await dialog.confirmDialog({
      title: full ? t('system.healthReview.fullAnalysis', 'Análisis completo') : t('system.healthReview.changeAnalysis', 'Análisis de cambios'),
      message: full
        ? t('system.healthReview.fullAnalysisMessage', 'Re-audita TODOS los módulos desde cero (ignora la caché). Módulo por módulo con Claude. Tarda varios minutos y CONSUME MÁS TOKENS. Solo lectura.')
        : t('system.healthReview.changeAnalysisMessage', 'Audita SOLO los módulos que cambiaron desde la última revisión (los sin cambios se reusan de la caché). Rápido y barato. Solo lectura.'),
      confirmLabel: full ? t('system.healthReview.fullAnalysis', 'Análisis completo') : t('system.healthReview.analyzeChanges', 'Analizar cambios'),
    });
    if (!ok) return;
    let d = {};
    try {
      const res = await fetch(`${API}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ full }),
      });
      d = await res.json().catch(() => ({}));
      if (!res.ok) {
        await dialog.alertDialog({
          title: full ? t('system.healthReview.fullAnalysis', 'Análisis completo') : t('system.healthReview.changeAnalysis', 'Análisis de cambios'),
          message: d.error || t('system.healthReview.reviewLaunchError', 'No se pudo lanzar la revisión.'),
        });
        return;
      }
    } catch { /* el poll averigua */ }
    render({ ...d, running: true });
    poll();
  }

  // Cómo trabaja la resolución autónoma (mismo texto para un hallazgo o todos):
  // edita solo (acceptEdits), pero FRENA y pide confirmación en lo de alto
  // riesgo — ahí aparece la alerta (tarjeta de permiso) en el chat.
  const RESOLVE_RULES = [
    t('system.healthReview.resolveRulesHeader', 'Cómo resolver:'),
    t('system.healthReview.resolveRule1', '1. Verificá leyendo el código citado que el hallazgo es REAL (la auditoría puede equivocarse). Si es falso positivo, avisame y no toques nada.'),
    t('system.healthReview.resolveRule2', '2. Implementá el fix MÍNIMO. Podés editar archivos directamente (estás en modo Aceptar ediciones).'),
    t('system.healthReview.resolveRule3', '3. FRENÁ y pedime confirmación ANTES de cualquier acción de ALTO RIESGO: borrar datos, git push, reiniciar servicios, comandos destructivos (rm, kill, systemctl…). No las ejecutes sin mi OK.'),
    t('system.healthReview.resolveRule4', '4. Al terminar, resumí qué cambiaste, en qué archivos y cómo verificarlo.'),
  ].join('\n');

  // Un hallazgo → chat autónomo con SU contexto.
  async function resolveInChat(f) {
    const prompt = [
      t('system.healthReview.resolvePromptIntro', 'Revisión de salud de la consola (Claude Web Console) detectó este hallazgo. Resolvelo de forma autónoma.'),
      '',
      `${t('system.healthReview.moduleLabel', 'Módulo:')} ${f.module || '—'}`,
      `${t('system.healthReview.severityLabel', 'Severidad:')} ${severityLabel(f.severity) || f.severity} · ${t('system.healthReview.typeLabel', 'Tipo:')} ${f.kind || '—'}`,
      `${t('system.healthReview.whatFailsLabel', 'Qué falla:')} ${f.area}`,
      f.file ? `${t('system.healthReview.fileLabel', 'Archivo:')} ${f.file}` : '',
      '',
      `${t('system.healthReview.detailLabel', 'Detalle:')} ${f.detail}`,
      f.suggestedFix ? `${t('system.healthReview.suggestedAuditFixLabel', 'Fix sugerido por la auditoría:')} ${f.suggestedFix}` : '',
      '',
      RESOLVE_RULES,
      '',
      t('system.healthReview.resolveRule5Important', '5. IMPORTANTE — cuando hayas terminado y VERIFICADO el fix, marcá este hallazgo como resuelto en el tablero de Salud ejecutando EXACTAMENTE (te pediré OK para el comando):'),
      t('system.healthReview.resolveCommand', '   node bin/cwc-health-resolve.js {id} "<resumen corto de qué arreglaste>"', { id: f.id }),
      t('system.healthReview.resolveCommandCaution', '   Hacelo SOLO si de verdad lo resolviste. Si resultó un falso positivo o no lo pudiste arreglar, NO ejecutes ese comando y avisame.'),
    ].filter((l) => l !== null && l !== undefined).join('\n');
    onClose?.();
    await openChat({ cwd: 'claude-web-console', mode: 'acceptEdits', prompt, title: `${t('system.healthReview.resolveTitle', 'Resolver')}: ${f.area}`.slice(0, 40) });
  }

  // Todos los hallazgos → UN chat autónomo que los trabaja en orden.
  async function resolveAll(findings) {
    if (!findings.length) return;
    const ok = await dialog.confirmDialog({
      title: t('system.healthReview.resolveAllDialogTitle', 'Resolver todo (autónomo)'),
      message: t('system.healthReview.resolveAllDialogMessage', 'Se abre UN chat que va a resolver los {count} hallazgo(s) uno por uno, editando el código de la consola de forma autónoma (modo Aceptar ediciones). Frenará y te pedirá confirmación en cada decisión de alto riesgo.\n\nLo ves en vivo y podés detenerlo cuando quieras.', { count: findings.length }),
      confirmLabel: t('system.healthReview.resolveFindingsCount', 'Resolver {count} hallazgo(s)', { count: findings.length }),
    });
    if (!ok) return;
    const lista = findings.map((f, i) => `${i + 1}. [${severityLabel(f.severity) || f.severity}] ${f.area}${f.module ? ` (${f.module})` : ''}${f.file ? ` — ${f.file}` : ''}  (id=${f.id})\n   ${f.detail}${f.suggestedFix ? `\n   ${t('system.healthReview.suggestedFixLabel', 'Fix sugerido:')} ${f.suggestedFix}` : ''}`).join('\n\n');
    const prompt = [
      t('system.healthReview.resolveAllPromptIntro', 'La revisión de salud de la consola (Claude Web Console) encontró {count} hallazgo(s). Resolvelos de forma autónoma, UNO POR UNO, en el orden de la lista (severidad de mayor a menor).', { count: findings.length }),
      '',
      lista,
      '',
      RESOLVE_RULES,
      '',
      t('system.healthReview.resolveAllSequential', 'Trabajá secuencial: verificá, arreglá y pasá al siguiente. Avisá al terminar cada uno y hacé un resumen final con todo lo cambiado.'),
      '',
      t('system.healthReview.resolveAllImportant', 'IMPORTANTE — apenas termines y VERIFIQUES cada hallazgo, marcalo como resuelto en el tablero de Salud ejecutando EXACTAMENTE (te pediré OK para el comando), usando el id que figura en la lista de arriba:'),
      t('system.healthReview.resolveAllCommand', '   node bin/cwc-health-resolve.js <id> "<resumen corto de qué arreglaste>"'),
      t('system.healthReview.resolveAllCaution', 'Hacelo por CADA hallazgo que de verdad resolviste. Si alguno es falso positivo o no lo pudiste arreglar, NO lo marques y avisame.'),
    ].join('\n');
    onClose?.();
    await openChat({ cwd: 'claude-web-console', mode: 'acceptEdits', prompt, title: t('system.healthReview.resolveHealthFindingsTitle', 'Resolver {count} hallazgos de salud', { count: findings.length }).slice(0, 50) });
  }

  // Resolución AUTÓNOMA de UN hallazgo: dispara el runner detached y arranca a
  // polear para ver la tarjeta pasar fixing → resuelto/falló. NO cierra el
  // modal (a diferencia del chat): el objetivo es ver la actualización en vivo.
  async function autoFix(f) {
    try {
      const res = await fetch(`${API}/finding-fix`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: f.id, tandem: useTandem }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('system.healthReview.autoFixLaunchError', 'No se pudo lanzar el auto-fix.'));
      // Parche optimista: marca 'fixing' ya mismo (el runner lo confirma enseguida).
      if (lastData?.findings) {
        const t = lastData.findings.find((x) => x.id === f.id);
        if (t) { t.fixStatus = 'fixing'; render(lastData); }
      }
      clearTimeout(pollTimer);
      poll();
    } catch (err) {
      await dialog.alertDialog({ title: t('system.healthReview.autoResolveTitle', 'Resolver automático'), message: err.message });
    }
  }

  // Marcar resuelto MANUALMENTE (red de seguridad del camino "En chat"): no toca
  // código, solo marca el estado en el tablero para dejar la lista al día. Útil
  // si ya lo arreglaste en un chat y querés reflejarlo sin esperar otra revisión.
  async function markResolved(f) {
    const ok = await dialog.confirmDialog({
      title: t('system.healthReview.markResolved', 'Marcar resuelto'),
      message: t('system.healthReview.markResolvedMessage', '¿Marcar "{area}" como resuelto? No toca código: solo lo saca de la lista de "sin resolver" y lo registra como resuelto. Usalo si ya lo arreglaste (p. ej. en un chat).', { area: f.area }),
      confirmLabel: t('system.healthReview.markResolved', 'Marcar resuelto'),
    });
    if (!ok) return;
    try {
      const res = await fetch(`${API}/finding-resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: f.id, summary: t('system.healthReview.manualResolvedSummary', 'Marcado como resuelto a mano (resuelto en chat).') }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('system.healthReview.markResolvedError', 'No se pudo marcar como resuelto.'));
      // Parche optimista: baja a "Resueltos" ya mismo; el poll/refresh lo confirma.
      if (lastData?.findings) {
        const t = lastData.findings.find((x) => x.id === f.id);
        if (t) { t.fixStatus = 'resolved'; t.resolvedAt = Date.now(); render(lastData); }
      }
    } catch (err) {
      await dialog.alertDialog({ title: t('system.healthReview.markResolved', 'Marcar resuelto'), message: err.message });
    }
  }

  // Restaurar un falso positivo: lo saca del registro durable y lo devuelve a
  // la cola "por resolver" (por si se descartó mal).
  async function restoreDismiss(f) {
    try {
      const res = await fetch(`${API}/dismiss-restore`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: f.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('system.healthReview.restoreError', 'No se pudo restaurar.'));
      if (lastData?.findings) {
        const t = lastData.findings.find((x) => x.id === f.id);
        if (t) { delete t.fixStatus; delete t.knownFalsePositive; delete t.dismissReason; render(lastData); }
      }
      clearTimeout(pollTimer);
      fetchState().then(() => render(lastData));
    } catch (err) {
      await dialog.alertDialog({ title: t('system.healthReview.restore', 'Restaurar'), message: err.message });
    }
  }

  // Banner del batch de resolución (Fase B): en curso o resumen del último.
  function batchBannerHtml() {
    const b = batchState;
    if (!b || !Array.isArray(b.items)) return '';
    const c = b.items.reduce((a, it) => { a[it.status] = (a[it.status] || 0) + 1; return a; }, {});
    const warn = (c.conflict || 0) + (c['check-failed'] || 0);
    if (b.running) {
      return `<div class="hr-batch hr-batch--run">${pacman({ state: 'delegating' })}<span>${t('system.healthReview.batchRunning', 'Resolviendo {count} en paralelo (aislado)', { count: b.items.length })}${b.phase ? ` · ${esc(b.phase)}` : ''} — ✅ ${c.integrated || 0}${warn ? ` · ⚠ ${warn}` : ''}${c.failed ? ` · ✗ ${c.failed}` : ''}</span></div>`;
    }
    if (b.finishedAt) {
      return `<div class="hr-batch">${t('system.healthReview.lastBatch', 'Último batch:')} ✅ ${t('system.healthReview.integratedCount', '{count} integrado(s)', { count: c.integrated || 0 })}${c.conflict ? ` · ⚠ ${t('system.healthReview.conflictCount', '{count} conflicto', { count: c.conflict })}` : ''}${c['check-failed'] ? ` · ⚠ ${t('system.healthReview.checkCount', '{count} check', { count: c['check-failed'] })}` : ''}${c.failed ? ` · ✗ ${t('system.healthReview.failureCount', '{count} fallo', { count: c.failed })}` : ''}. ${t('system.healthReview.unintegratedRemainOpen', 'Los no integrados quedan abiertos (retry o "En chat").')}</div>`;
    }
    return '';
  }

  // Resolver en BATCH los hallazgos NO críticos (paralelo aislado + integración
  // serial). Dispara el orquestador desacoplado; el modal polea /batch y /review.
  async function batchResolve(findings) {
    if (!findings.length) return;
    const ok = await dialog.confirmDialog({
      title: t('system.healthReview.resolveSafeCount', 'Resolver seguros ({count})', { count: findings.length }),
      message: t('system.healthReview.resolveSafeMessage', 'Se resuelven los {count} hallazgos NO críticos de forma autónoma: cada uno en su propio sandbox aislado EN PARALELO, y después se integran al código UNO POR UNO con node --check (los que choquen quedan sin aplicar). NO reinicia el servicio — revisás con git y reiniciás vos.\n\nLos hallazgos críticos NO entran (van solo por "En chat").', { count: findings.length }),
      confirmLabel: t('system.healthReview.resolveCount', 'Resolver {count}', { count: findings.length }),
    });
    if (!ok) return;
    try {
      const res = await fetch(`${API}/finding-fix-batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: findings.map((f) => f.id) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('system.healthReview.batchLaunchError', 'No se pudo lanzar el batch.'));
      clearTimeout(pollTimer);
      poll();
    } catch (err) {
      await dialog.alertDialog({ title: t('system.healthReview.resolveSafe', 'Resolver seguros'), message: err.message });
    }
  }

  // Trae review + resueltos + propuestas + estado del batch; refresca cachés.
  async function fetchState() {
    const [rev, sol, prop, bat] = await Promise.all([
      fetch(`${API}/review`).then((r) => r.json()).catch(() => null),
      fetch(`${API}/solved`).then((r) => r.json()).catch(() => null),
      fetch(`${API}/invariant-proposals`).then((r) => r.json()).catch(() => null),
      fetch(`${API}/batch`).then((r) => r.json()).catch(() => null),
    ]);
    if (sol && Array.isArray(sol.solved)) solvedLog = sol.solved;
    if (prop && Array.isArray(prop.proposals)) proposals = prop.proposals;
    if (bat) batchState = bat.batch ? { ...bat.batch, running: bat.running } : null;
    return rev;
  }

  // Aprobar/descartar un invariante propuesto (F5). Aprobar lo suma a los
  // invariantes verificados (invariants-learned.json).
  async function decideProposal(id, action) {
    try {
      const res = await fetch(`${API}/invariant-proposals/${encodeURIComponent(id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('system.healthReview.proposalProcessError', 'No se pudo procesar la propuesta.'));
      const d = await fetchState();
      if (d) render(d);
    } catch (err) {
      await dialog.alertDialog({ title: t('system.healthReview.proposedInvariantTitle', 'Invariante propuesto'), message: err.message });
    }
  }
  // Hay que seguir poleando si corre la revisión O hay un auto-fix en curso.
  const needsPoll = (d) => (!!d && (d.running || d.fixing || (d.findings || []).some((f) => f.fixStatus === 'fixing'))) || !!batchState?.running;

  async function poll() {
    if (!alive) return;
    try {
      const d = await fetchState();
      if (!alive) return;
      if (d) render(d);
      if (needsPoll(d)) pollTimer = setTimeout(poll, POLL_MS);
    } catch {
      if (alive) pollTimer = setTimeout(poll, POLL_MS);
    }
  }

  // Arranque: abrir la sub-ventana NO dispara nada pesado — solo MUESTRA el
  // último estado (resultado cacheado, o vacío con el botón "Iniciar"). Si ya
  // hay un barrido o un auto-fix corriendo, se engancha al vivo.
  (async () => {
    const d = await fetchState();
    if (!alive) return;
    render(d || {});
    if (needsPoll(d)) poll();
  })();

  return { stop };
}

// Wrapper standalone: monta la Revisión en su propio modal (uso directo).
export function openHealthReview(ctx, { isAdmin }) {
  const { dialog } = ctx;
  const m = dialog.openModal({ title: t('system.healthReview.modalTitle', 'Revisión exhaustiva de salud'), width: 900 });
  m.card.classList.add('dlg-card--health');
  const inst = mountHealthReview(m.body, ctx, { isAdmin, onClose: () => m.close() });
  const origClose = m.close;
  m.close = () => { inst.stop(); origClose(); };
  m.overlay.addEventListener('mousedown', (e) => { if (e.target === m.overlay) m.close(); });
}
