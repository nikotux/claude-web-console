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
import { pacman } from '../../ui/pacman.js';

const API = '/api/health';
const POLL_MS = 2500;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const VERDICT_LABEL = { ok: 'Todo en orden', atencion: 'Requiere atención', critico: 'CRÍTICO' };
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const SEV_LABEL = { critical: 'crítico', high: 'alto', medium: 'medio', low: 'bajo' };
const KIND_LABEL = { bug: '🐛 bug', regla: '📏 regla', mejora: '✨ mejora' };
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' ' + new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '—');

// Abre esta sub-ventana. `ctx` trae dialog + openChat (para trabajar un hallazgo).
export function openHealthReview(ctx, { isAdmin }) {
  const { dialog, openChat } = ctx;
  // En pantallas chicas todo nace COLAPSADO (vista general; detalle a demanda);
  // en desktop, expandido (hay lugar). Se evalúa una vez al abrir.
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const m = dialog.openModal({ title: 'Revisión exhaustiva de salud', width: 900 });
  m.card.classList.add('dlg-card--health');
  const wrap = document.createElement('div');
  wrap.className = 'hr-wrap';
  m.body.appendChild(wrap);

  let alive = true;
  let pollTimer = null;
  let solvedLog = []; // registro durable (GET /solved), refrescado en cada tick
  let batchState = null; // estado del batch de resolución (Fase B), polea GET /batch
  let proposals = []; // invariantes propuestos pendientes de aprobación (F5)
  let lastData = null; // último estado renderizado (para parches optimistas)
  const origOnClose = m.close;
  m.close = () => { alive = false; clearTimeout(pollTimer); origOnClose(); };
  m.overlay.addEventListener('mousedown', (e) => { if (e.target === m.overlay) m.close(); });

  // ¿El hallazgo está BLOQUEADO para auto-fix? Superficie crítica (pol.risk:
  // toca server/auth/registry/…) O severidad crítica del bug (los más delicados
  // van a chat supervisado). Espeja el gate REAL del backend (health/index.js).
  const isBlocked = (f) => f.policy?.risk === 'critical' || String(f.severity) === 'critical';
  const blockReason = (f) => (f.policy?.risk === 'critical' ? (f.policy.reason || 'superficie crítica') : 'severidad crítica del bug');
  // Item del batch (Fase B) correspondiente a este hallazgo, si hay batch vivo.
  const batchItemOf = (f) => (batchState?.items || []).find((x) => x.id === f.id);

  // Chip de PROGRESO por hallazgo dentro del batch: Pac-Man masticando =
  // resolviéndose AHORA (ves cuáles corren a la vez), dormido = en cola, ✅/🔴
  // terminales. Es lo que pediste para ver el estado de cada uno en vivo.
  function batchItemBadge(it) {
    if (!it) return '';
    switch (it.status) {
      case 'pending': return `<span class="hr-badge hr-badge--queue" title="En cola para resolver">${pacman({ working: false })}<span>en cola</span></span>`;
      case 'fixing': return `<span class="hr-badge hr-badge--fixing" title="Resolviendo ahora (en paralelo, en su sandbox aislado)">${pacman()}<span>resolviendo</span></span>`;
      case 'ready': return `<span class="hr-badge hr-badge--fixing" title="Fix listo en el sandbox — esperando la integración serial al código real">${pacman()}<span>listo p/ integrar</span></span>`;
      case 'integrated': return '<span class="hr-badge hr-badge--ok">✅ resuelto</span>';
      case 'conflict': return `<span class="hr-badge hr-badge--fail" title="Conflicto al integrar (quedó sin aplicar): ${esc(it.error || '')}">🔴 conflicto</span>`;
      case 'check-failed': return `<span class="hr-badge hr-badge--fail" title="No pasó node --check al integrar: ${esc(it.error || '')}">🔴 falló el check</span>`;
      case 'failed': return `<span class="hr-badge hr-badge--fail" title="${esc(it.error || 'error')}">🔴 error</span>`;
      default: return '';
    }
  }

  // Badge de estado en el header: bloqueo + recurrencia + estado de resolución.
  // Con batch vivo, el estado por-ítem (Pac-Man) manda sobre el fixStatus grueso.
  function statusBadge(f) {
    const parts = [];
    if (isBlocked(f)) parts.push(`<span class="hr-badge hr-badge--crit" title="No se auto-resuelve (${esc(blockReason(f))}) — solo chat supervisado">🔒 ${String(f.severity) === 'critical' ? 'crítico' : 'protegido'}</span>`);
    if (f.recurrent) parts.push(`<span class="hr-badge hr-badge--rec" title="Ya se había resuelto antes (${f.recurrent.times}×) y volvió a aparecer — candidato a análisis exhaustivo">🔁 recurrente${f.recurrent.times > 1 ? ` ×${f.recurrent.times}` : ''}</span>`);
    const it = batchItemOf(f);
    if (it) {
      parts.push(batchItemBadge(it)); // estado por-ítem del batch (Pac-Man en vivo)
    } else if (f.fixStatus === 'fixing') parts.push('<span class="hr-badge hr-badge--fixing">🔧 resolviendo…</span>');
    else if (f.fixStatus === 'resolved') parts.push('<span class="hr-badge hr-badge--ok">✅ resuelto</span>');
    else if (f.fixStatus === 'failed') parts.push('<span class="hr-badge hr-badge--fail">⚠ falló</span>');
    return parts.join(' ');
  }

  // Acciones del hallazgo según su estado de resolución:
  //  - resuelto  → sin botones (✅ + resumen del fix).
  //  - resolviendo → Pac-Man, sin botones.
  //  - abierto/falló → dos botones: 💬 En chat (supervisado) y ⚡ Automático
  //    (runner autónomo; la tarjeta se actualiza sola). Falló ⇒ + reintentar.
  function actions(f) {
    if (!(isAdmin && openChat)) return '';
    if (f.fixStatus === 'fixing') return `<div class="hr-f-actions hr-f-fixing">${pacman()}<span>resolviendo automáticamente…</span></div>`;
    if (f.fixStatus === 'resolved') return `<div class="hr-f-resolved">✅ Resuelto${f.fixSummary ? `: ${esc(f.fixSummary)}` : ''}</div>`;
    const failLine = f.fixStatus === 'failed' && f.fixError ? `<div class="hr-f-fail">⚠ Auto-fix falló: ${esc(f.fixError)}</div>` : '';
    // GATE de política: superficie crítica O severidad crítica bloquean
    // "Automático" (queda solo "En chat"). Espeja el gate del backend.
    const critical = isBlocked(f);
    const critNote = critical
      ? `<div class="hr-f-crit">⚠️ No se auto-resuelve (${esc(blockReason(f))}) — hacelo <b>En chat</b>, supervisado.</div>`
      : '';
    const autoBtn = critical
      ? `<button class="btn btn--sm" data-act="autofix" disabled title="No se auto-resuelve: ${esc(blockReason(f))}. Usá 'En chat'.">${icon('gear', { size: 13 })}<span>Automático 🔒</span></button>`
      : `<button class="btn btn--sm" data-act="autofix" title="Lo resuelve un runner autónomo: edita y verifica con node --check, sin supervisión; NO reinicia el servicio. La tarjeta se actualiza sola.">${icon('gear', { size: 13 })}<span>${f.fixStatus === 'failed' ? 'Reintentar auto' : 'Automático'}</span></button>`;
    return `${failLine}${critNote}<div class="hr-f-actions">
      <button class="btn-ghost btn--sm" data-act="chat" title="Abre un chat supervisado para resolverlo (acepta ediciones; frena y te avisa en alto riesgo)">${icon('sparkle', { size: 13 })}<span>En chat</span></button>
      ${autoBtn}
    </div>`;
  }

  // Tarjeta COLAPSABLE: header (severidad · tipo · área · módulo · estado)
  // siempre visible + chevron; el cuerpo (detalle, archivo, fix, acciones) se
  // pliega. `resolved` = viene de la sección "Resueltos" (nace colapsada).
  function findingCard(f) {
    const sev = f.severity || 'medium';
    const collapsed = (isMobile || f.fixStatus === 'resolved') ? ' hr-collapsed' : '';
    return `
      <div class="hr-finding hr-finding--${esc(sev)}${collapsed}" data-idx="${f._i}" data-id="${esc(f.id || '')}">
        <div class="hr-f-head" data-toggle="1">
          <span class="hr-chev">${icon('chevronDown', { size: 13 })}</span>
          <span class="hr-sev hr-sev--${esc(sev)}">${SEV_LABEL[sev] || sev}</span>
          <span class="hr-kind">${KIND_LABEL[f.kind] || f.kind || ''}</span>
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
      const tip = u.status === 'cached' ? ' · sin cambios (reusado)' : u.error ? ` · ${esc(u.error)}` : '';
      return `<span class="hr-unit ${cls}" title="${esc(u.label)}${tip}"><span class="hr-unit-dot"></span>${esc(u.label.replace(/^Módulo /, ''))}${n}</span>`;
    }).join('');

    const all = (d.findings || []).map((f, i) => ({ ...f, _i: i }));
    const bySev = (a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9);
    // Activos = todo lo que NO está resuelto (arriba, accionable). Resueltos =
    // abajo, en su propia sección colapsable.
    const activos = all.filter((f) => f.fixStatus !== 'resolved').sort(bySev);
    const resueltos = all.filter((f) => f.fixStatus === 'resolved')
      .sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0));
    const nFixing = all.filter((f) => f.fixStatus === 'fixing').length;
    const nOpen = activos.length - nFixing;
    // Auto-resolubles en batch: abiertos, NO bloqueados (ni superficie ni
    // severidad crítica), no en curso.
    const autoables = activos.filter((f) => !isBlocked(f) && f.fixStatus !== 'fixing');
    const nAuto = autoables.length;
    const resumen = [
      `${all.length} hallazgo(s)`,
      resueltos.length ? `✅ ${resueltos.length} resuelto(s)` : '',
      nFixing ? `🔧 ${nFixing} resolviendo` : '',
      `${nOpen} sin resolver`,
    ].filter(Boolean).join(' · ');

    wrap.innerHTML = `
      <div class="hr-progress">
        ${running ? pacman() : ''}
        <div class="hr-bar"><span class="hr-bar-fill" style="width:${pct}%"></span></div>
        <span class="hr-phase">${running ? `${done}/${total} · ${esc(d.phase || 'analizando…')}` : `${done}/${total} completado`}</span>
      </div>
      ${units ? `<details class="hr-collapsible"${(isMobile && !running) ? '' : ' open'}><summary>Módulos analizados (${d.units?.length || 0})</summary><div class="hr-units">${units}</div></details>` : ''}
      ${d.verdict ? `<div class="hr-verdict hr-verdict--${esc(d.verdict)}"><b>${VERDICT_LABEL[d.verdict] || d.verdict}</b><span class="hr-phase">${resumen}</span></div>` : ''}
      ${d.summary ? `<details class="hr-collapsible"${isMobile ? '' : ' open'}><summary>Resumen del análisis</summary><p class="hr-summary">${esc(d.summary)}</p></details>` : ''}
      ${d.error ? `<p class="hr-summary" style="color:var(--cwc-danger-strong)">⚠️ ${esc(d.error)}</p>` : ''}
      ${batchBannerHtml()}
      ${!running && !batchState?.running && isAdmin ? `<div class="hr-actions-row">
        <button class="btn btn--block" data-ref="start" title="Analiza SOLO los módulos que cambiaron desde la última revisión (los sin cambios se reusan). Rápido y barato.">${icon('gear', { size: 14 })}<span>${d.verdict || d.findings?.length ? 'Analizar cambios' : 'Iniciar análisis profundo'}</span></button>
        ${d.verdict || d.findings?.length ? `<button class="btn-ghost btn--block" data-ref="startfull" title="Re-analiza TODOS los módulos desde cero, ignorando la caché (más lento y más tokens)">${icon('refresh', { size: 14 })}<span>Completo</span></button>` : ''}
        ${nAuto ? `<button class="btn btn--block hr-resolve-auto" data-ref="resolveauto" title="Resuelve los ${nAuto} hallazgos NO críticos en PARALELO (sandboxes aislados) + integración serial con node --check. No reinicia. Los críticos van solo por chat.">${icon('gear', { size: 14 })}<span>Resolver seguros (${nAuto})</span></button>` : ''}
        ${nOpen ? `<button class="btn-ghost btn--block hr-resolve-all" data-ref="resolveall" title="Abre UN chat supervisado que trabaja todos los hallazgos sin resolver">${icon('sparkle', { size: 14 })}<span>Resolver todo en chat</span></button>` : ''}
      </div>` : ''}
      <div class="hr-findings">
        ${activos.length ? activos.map(findingCard).join('')
    : running ? '<div class="hr-empty">Analizando módulos…</div>'
      : all.length ? '<div class="hr-empty">Todo resuelto 🎉 (ver "Resueltos" abajo)</div>'
        : '<div class="hr-empty">Sin hallazgos: el sistema está sano ✅</div>'}
      </div>
      ${resueltos.length ? `<details class="hr-collapsible hr-resolved-sec"><summary>✅ Resueltos en esta revisión (${resueltos.length})</summary>${resueltos.map(findingCard).join('')}</details>` : ''}
      ${(isAdmin && proposals.length) ? `<details class="hr-collapsible hr-prop-sec" open><summary>🧠 Invariantes propuestos (${proposals.length}) — para aprobar</summary>
        <div class="hr-prop-list">${proposals.map((pr) => `
          <div class="hr-prop" data-prop="${esc(pr.id)}">
            <p class="hr-prop-text">${esc(pr.text)}</p>
            <div class="hr-prop-meta"><code>${esc(pr.match || '—')}</code>${pr.fromFinding?.module ? ` · de: ${esc(pr.fromFinding.module)}` : ''}</div>
            <div class="hr-prop-actions">
              <button class="btn-ghost btn--sm" data-prop-act="reject" title="Descartar la propuesta">${icon('close', { size: 13 })}<span>Descartar</span></button>
              <button class="btn btn--sm" data-prop-act="approve" title="Sumarlo a los invariantes verificados (invariants-learned.json)">${icon('check', { size: 13 })}<span>Aprobar</span></button>
            </div>
          </div>`).join('')}</div>
      </details>` : ''}
      ${solvedLog.length ? `<details class="hr-collapsible hr-solved-sec"><summary>📓 Registro de resueltos (${solvedLog.length})</summary>
        <div class="hr-solved-list">${solvedLog.map((s) => `
          <div class="hr-solved-item">
            <span class="hr-solved-area">${esc(s.area || s.file || '—')}</span>
            <span class="hr-solved-mod">${esc(s.module || '')}</span>
            ${s.count > 1 ? `<span class="hr-badge hr-badge--rec" title="Se resolvió ${s.count} veces (recurrente)">🔁 ×${s.count}</span>` : ''}
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
    }
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
      title: full ? 'Análisis completo' : 'Análisis de cambios',
      message: full
        ? 'Re-audita TODOS los módulos desde cero (ignora la caché). Módulo por módulo con Claude. Tarda varios minutos y CONSUME MÁS TOKENS. Solo lectura.'
        : 'Audita SOLO los módulos que cambiaron desde la última revisión (los sin cambios se reusan de la caché). Rápido y barato. Solo lectura.',
      confirmLabel: full ? 'Análisis completo' : 'Analizar cambios',
    });
    if (!ok) return;
    let d = {};
    try {
      d = await (await fetch(`${API}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ full }),
      })).json();
    } catch { /* el poll averigua */ }
    render({ ...d, running: true });
    poll();
  }

  // Cómo trabaja la resolución autónoma (mismo texto para un hallazgo o todos):
  // edita solo (acceptEdits), pero FRENA y pide confirmación en lo de alto
  // riesgo — ahí aparece la alerta (tarjeta de permiso) en el chat.
  const RESOLVE_RULES = [
    'Cómo resolver:',
    '1. Verificá leyendo el código citado que el hallazgo es REAL (la auditoría puede equivocarse). Si es falso positivo, avisame y no toques nada.',
    '2. Implementá el fix MÍNIMO. Podés editar archivos directamente (estás en modo Aceptar ediciones).',
    '3. FRENÁ y pedime confirmación ANTES de cualquier acción de ALTO RIESGO: borrar datos, git push, reiniciar servicios, comandos destructivos (rm, kill, systemctl…). No las ejecutes sin mi OK.',
    '4. Al terminar, resumí qué cambiaste, en qué archivos y cómo verificarlo.',
  ].join('\n');

  // Un hallazgo → chat autónomo con SU contexto.
  async function resolveInChat(f) {
    const prompt = [
      'Revisión de salud de la consola (Claude Web Console) detectó este hallazgo. Resolvelo de forma autónoma.',
      '',
      `Módulo: ${f.module || '—'}`,
      `Severidad: ${SEV_LABEL[f.severity] || f.severity} · Tipo: ${f.kind || '—'}`,
      `Qué falla: ${f.area}`,
      f.file ? `Archivo: ${f.file}` : '',
      '',
      `Detalle: ${f.detail}`,
      f.suggestedFix ? `Fix sugerido por la auditoría: ${f.suggestedFix}` : '',
      '',
      RESOLVE_RULES,
    ].filter((l) => l !== null && l !== undefined).join('\n');
    m.close();
    await openChat({ cwd: 'claude-web-console', mode: 'acceptEdits', prompt, title: `Resolver: ${f.area}`.slice(0, 40) });
  }

  // Todos los hallazgos → UN chat autónomo que los trabaja en orden.
  async function resolveAll(findings) {
    if (!findings.length) return;
    const ok = await dialog.confirmDialog({
      title: 'Resolver todo (autónomo)',
      message: `Se abre UN chat que va a resolver los ${findings.length} hallazgo(s) uno por uno, editando el código de la consola de forma autónoma (modo Aceptar ediciones). Frenará y te pedirá confirmación en cada decisión de alto riesgo.\n\nLo ves en vivo y podés detenerlo cuando quieras.`,
      confirmLabel: `Resolver ${findings.length} hallazgo(s)`,
    });
    if (!ok) return;
    const lista = findings.map((f, i) => `${i + 1}. [${SEV_LABEL[f.severity] || f.severity}] ${f.area}${f.module ? ` (${f.module})` : ''}${f.file ? ` — ${f.file}` : ''}\n   ${f.detail}${f.suggestedFix ? `\n   Fix sugerido: ${f.suggestedFix}` : ''}`).join('\n\n');
    const prompt = [
      `La revisión de salud de la consola (Claude Web Console) encontró ${findings.length} hallazgo(s). Resolvelos de forma autónoma, UNO POR UNO, en el orden de la lista (severidad de mayor a menor).`,
      '',
      lista,
      '',
      RESOLVE_RULES,
      '',
      'Trabajá secuencial: verificá, arreglá y pasá al siguiente. Avisá al terminar cada uno y hacé un resumen final con todo lo cambiado.',
    ].join('\n');
    m.close();
    await openChat({ cwd: 'claude-web-console', mode: 'acceptEdits', prompt, title: `Resolver ${findings.length} hallazgos de salud`.slice(0, 50) });
  }

  // Resolución AUTÓNOMA de UN hallazgo: dispara el runner detached y arranca a
  // polear para ver la tarjeta pasar fixing → resuelto/falló. NO cierra el
  // modal (a diferencia del chat): el objetivo es ver la actualización en vivo.
  async function autoFix(f) {
    try {
      const res = await fetch(`${API}/finding-fix`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: f.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo lanzar el auto-fix.');
      // Parche optimista: marca 'fixing' ya mismo (el runner lo confirma enseguida).
      if (lastData?.findings) {
        const t = lastData.findings.find((x) => x.id === f.id);
        if (t) { t.fixStatus = 'fixing'; render(lastData); }
      }
      clearTimeout(pollTimer);
      poll();
    } catch (err) {
      await dialog.alertDialog({ title: 'Resolver automático', message: err.message });
    }
  }

  // Banner del batch de resolución (Fase B): en curso o resumen del último.
  function batchBannerHtml() {
    const b = batchState;
    if (!b || !Array.isArray(b.items)) return '';
    const c = b.items.reduce((a, it) => { a[it.status] = (a[it.status] || 0) + 1; return a; }, {});
    const warn = (c.conflict || 0) + (c['check-failed'] || 0);
    if (b.running) {
      return `<div class="hr-batch hr-batch--run">${pacman()}<span>Resolviendo ${b.items.length} en paralelo (aislado)${b.phase ? ` · ${esc(b.phase)}` : ''} — ✅ ${c.integrated || 0}${warn ? ` · ⚠ ${warn}` : ''}${c.failed ? ` · ✗ ${c.failed}` : ''}</span></div>`;
    }
    if (b.finishedAt) {
      return `<div class="hr-batch">Último batch: ✅ ${c.integrated || 0} integrado(s)${c.conflict ? ` · ⚠ ${c.conflict} conflicto` : ''}${c['check-failed'] ? ` · ⚠ ${c['check-failed']} check` : ''}${c.failed ? ` · ✗ ${c.failed} fallo` : ''}. Los no integrados quedan abiertos (retry o "En chat").</div>`;
    }
    return '';
  }

  // Resolver en BATCH los hallazgos NO críticos (paralelo aislado + integración
  // serial). Dispara el orquestador desacoplado; el modal polea /batch y /review.
  async function batchResolve(findings) {
    if (!findings.length) return;
    const ok = await dialog.confirmDialog({
      title: `Resolver seguros (${findings.length})`,
      message: `Se resuelven los ${findings.length} hallazgos NO críticos de forma autónoma: cada uno en su propio sandbox aislado EN PARALELO, y después se integran al código UNO POR UNO con node --check (los que choquen quedan sin aplicar). NO reinicia el servicio — revisás con git y reiniciás vos.\n\nLos hallazgos críticos NO entran (van solo por "En chat").`,
      confirmLabel: `Resolver ${findings.length}`,
    });
    if (!ok) return;
    try {
      const res = await fetch(`${API}/finding-fix-batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: findings.map((f) => f.id) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo lanzar el batch.');
      clearTimeout(pollTimer);
      poll();
    } catch (err) {
      await dialog.alertDialog({ title: 'Resolver seguros', message: err.message });
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
      if (!res.ok) throw new Error(data.error || 'No se pudo procesar la propuesta.');
      const d = await fetchState();
      if (d) render(d);
    } catch (err) {
      await dialog.alertDialog({ title: 'Invariante propuesto', message: err.message });
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
}
