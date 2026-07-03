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
  const origOnClose = m.close;
  m.close = () => { alive = false; clearTimeout(pollTimer); origOnClose(); };
  m.overlay.addEventListener('mousedown', (e) => { if (e.target === m.overlay) m.close(); });

  // Tarjeta COLAPSABLE: header (severidad · tipo · área · módulo) siempre
  // visible + chevron; el cuerpo (detalle, archivo, fix, acción) se pliega.
  // Un único botón "Resolver" abre el chat autónomo (acceptEdits) con el
  // contexto del hallazgo — las decisiones de alto riesgo alertan ahí.
  function findingCard(f) {
    const sev = f.severity || 'medium';
    return `
      <div class="hr-finding hr-finding--${esc(sev)}${isMobile ? ' hr-collapsed' : ''}" data-idx="${f._i}">
        <div class="hr-f-head" data-toggle="1">
          <span class="hr-chev">${icon('chevronDown', { size: 13 })}</span>
          <span class="hr-sev hr-sev--${esc(sev)}">${SEV_LABEL[sev] || sev}</span>
          <span class="hr-kind">${KIND_LABEL[f.kind] || f.kind || ''}</span>
          <span class="hr-f-area">${esc(f.area)}</span>
          <span class="hr-f-mod">${esc(f.module || '')}</span>
        </div>
        <div class="hr-f-body">
          <p class="hr-f-detail">${esc(f.detail)}</p>
          ${f.file ? `<div class="hr-f-file">📄 ${esc(f.file)}</div>` : ''}
          ${f.suggestedFix ? `<p class="hr-f-fix">🔧 ${esc(f.suggestedFix)}</p>` : ''}
          ${isAdmin && openChat ? `<div class="hr-f-actions"><button class="btn btn--sm" data-act="resolve" title="Abre un chat que resuelve este hallazgo de forma autónoma (edita solo; frena y te avisa en decisiones de alto riesgo)">${icon('sparkle', { size: 13 })}<span>Resolver</span></button></div>` : ''}
        </div>
      </div>`;
  }

  function render(d) {
    const running = !!d.running;
    const total = d.total || (d.units?.length || 0) + 1;
    const done = d.done || 0;
    const pct = total ? Math.round((done / total) * 100) : 0;

    const units = (d.units || []).map((u) => {
      const cls = u.status === 'running' ? 'hr-unit--running'
        : u.status === 'done' ? 'hr-unit--done'
          : u.status === 'error' ? 'hr-unit--error' : '';
      const n = u.status === 'done' && u.findings ? `<span class="hr-unit-n">${u.findings}</span>` : '';
      return `<span class="hr-unit ${cls}" title="${esc(u.label)}${u.error ? ` · ${esc(u.error)}` : ''}"><span class="hr-unit-dot"></span>${esc(u.label.replace(/^Módulo /, ''))}${n}</span>`;
    }).join('');

    const findings = (d.findings || [])
      .map((f, i) => ({ ...f, _i: i }))
      .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
    const counts = findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {});
    const countLine = ['critical', 'high', 'medium', 'low']
      .filter((s) => counts[s]).map((s) => `${counts[s]} ${SEV_LABEL[s]}`).join(' · ') || 'sin hallazgos';

    wrap.innerHTML = `
      <div class="hr-progress">
        ${running ? pacman() : ''}
        <div class="hr-bar"><span class="hr-bar-fill" style="width:${pct}%"></span></div>
        <span class="hr-phase">${running ? `${done}/${total} · ${esc(d.phase || 'analizando…')}` : `${done}/${total} completado`}</span>
      </div>
      ${units ? `<details class="hr-collapsible"${isMobile ? '' : ' open'}><summary>Módulos analizados (${d.units?.length || 0})</summary><div class="hr-units">${units}</div></details>` : ''}
      ${d.verdict ? `<div class="hr-verdict hr-verdict--${esc(d.verdict)}"><b>${VERDICT_LABEL[d.verdict] || d.verdict}</b><span class="hr-phase">${findings.length} hallazgo(s) · ${countLine}</span></div>` : ''}
      ${d.summary ? `<details class="hr-collapsible"${isMobile ? '' : ' open'}><summary>Resumen del análisis</summary><p class="hr-summary">${esc(d.summary)}</p></details>` : ''}
      ${d.error ? `<p class="hr-summary" style="color:var(--cwc-danger-strong)">⚠️ ${esc(d.error)}</p>` : ''}
      ${!running && isAdmin ? `<div class="hr-actions-row">
        <button class="btn btn--block" data-ref="start">${icon('gear', { size: 14 })}<span>${d.verdict || d.findings?.length ? 'Volver a analizar' : 'Iniciar análisis profundo'}</span></button>
        ${findings.length ? `<button class="btn btn--block hr-resolve-all" data-ref="resolveall" title="Abre UN chat que resuelve todos los hallazgos de forma autónoma (edita solo; frena en decisiones de alto riesgo)">${icon('sparkle', { size: 14 })}<span>Resolver todo (autónomo)</span></button>` : ''}
      </div>` : ''}
      <div class="hr-findings">
        ${findings.length ? findings.map(findingCard).join('')
    : running ? '<div class="hr-empty">Analizando módulos…</div>'
      : '<div class="hr-empty">Sin hallazgos: el sistema está sano ✅</div>'}
      </div>`;

    for (const card of wrap.querySelectorAll('.hr-finding')) {
      // Tap en el header = plegar/desplegar el detalle (vista general ↔ detalle).
      card.querySelector('[data-toggle]')?.addEventListener('click', () => card.classList.toggle('hr-collapsed'));
      card.querySelector('[data-act="resolve"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const f = findings.find((x) => String(x._i) === card.dataset.idx);
        if (f) resolveInChat(f);
      });
    }
    wrap.querySelector('[data-ref="start"]')?.addEventListener('click', startReview);
    wrap.querySelector('[data-ref="resolveall"]')?.addEventListener('click', () => resolveAll(findings));
  }

  // Lanza la revisión (el ÚNICO punto que gasta tokens). Confirmación con
  // aviso de costo; nunca se dispara sola al abrir la sub-ventana.
  async function startReview() {
    const ok = await dialog.confirmDialog({
      title: 'Análisis profundo con Claude',
      message: 'Audita el proyecto MÓDULO POR MÓDULO con Claude (haiku por módulo + síntesis final), buscando bugs y violaciones de reglas.\n\nTarda varios minutos y CONSUME TOKENS. Es de solo lectura: no modifica nada.',
      confirmLabel: 'Iniciar',
    });
    if (!ok) return;
    let d = {};
    try { d = await (await fetch(`${API}/review`, { method: 'POST' })).json(); } catch { /* el poll averigua */ }
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

  async function poll() {
    if (!alive) return;
    try {
      const d = await (await fetch(`${API}/review`)).json();
      if (!alive) return;
      render(d);
      if (d.running) pollTimer = setTimeout(poll, POLL_MS);
    } catch {
      if (alive) pollTimer = setTimeout(poll, POLL_MS);
    }
  }

  // Arranque: abrir la sub-ventana NO dispara nada pesado — solo MUESTRA el
  // último estado (resultado cacheado, o vacío con el botón "Iniciar"). Si ya
  // hay un barrido corriendo (otra pestaña / recarga), se engancha al vivo.
  (async () => {
    let d = {};
    try { d = await (await fetch(`${API}/review`)).json(); } catch { /* noop */ }
    if (!alive) return;
    render(d);
    if (d.running) poll();
  })();
}
