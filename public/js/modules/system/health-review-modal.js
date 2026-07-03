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

  function findingCard(f) {
    const sev = f.severity || 'medium';
    return `
      <div class="hr-finding hr-finding--${esc(sev)}" data-idx="${f._i}">
        <div class="hr-f-head">
          <span class="hr-sev hr-sev--${esc(sev)}">${SEV_LABEL[sev] || sev}</span>
          <span class="hr-kind">${KIND_LABEL[f.kind] || f.kind || ''}</span>
          <span class="hr-f-area">${esc(f.area)}</span>
          <span class="hr-f-mod">${esc(f.module || '')}</span>
        </div>
        <p class="hr-f-detail">${esc(f.detail)}</p>
        ${f.file ? `<div class="hr-f-file">📄 ${esc(f.file)}</div>` : ''}
        ${f.suggestedFix ? `<p class="hr-f-fix">🔧 ${esc(f.suggestedFix)}</p>` : ''}
        ${isAdmin && openChat ? `<div class="hr-f-actions"><button class="btn btn--sm" data-act="chat">${icon('sparkle', { size: 13 })}<span>Trabajar en chat</span></button></div>` : ''}
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
      <div class="hr-units">${units}</div>
      ${d.verdict ? `<div class="hr-verdict hr-verdict--${esc(d.verdict)}"><b>${VERDICT_LABEL[d.verdict] || d.verdict}</b><span class="hr-phase">${findings.length} hallazgo(s) · ${countLine}</span></div>` : ''}
      ${d.summary ? `<p class="hr-summary">${esc(d.summary)}</p>` : ''}
      ${d.error ? `<p class="hr-summary" style="color:var(--cwc-danger-strong)">⚠️ ${esc(d.error)}</p>` : ''}
      ${!running && isAdmin ? `<button class="btn btn--block" data-ref="start">${icon('gear', { size: 14 })}<span>${d.verdict || d.findings?.length ? 'Volver a analizar en profundidad' : 'Iniciar análisis profundo'}</span></button>` : ''}
      <div class="hr-findings">
        ${findings.length ? findings.map(findingCard).join('')
    : running ? '<div class="hr-empty">Analizando módulos…</div>'
      : '<div class="hr-empty">Sin hallazgos: el sistema está sano ✅</div>'}
      </div>`;

    for (const card of wrap.querySelectorAll('.hr-finding')) {
      card.querySelector('[data-act="chat"]')?.addEventListener('click', () => {
        const f = findings.find((x) => String(x._i) === card.dataset.idx);
        if (f) workInChat(f);
      });
    }
    wrap.querySelector('[data-ref="start"]')?.addEventListener('click', startReview);
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

  // Abre un chat en la RAÍZ de la consola con el hallazgo precargado. El
  // modo (plan vs aceptar ediciones) lo elige el usuario en el chat; acá se
  // arranca en 'plan' para investigar/decidir juntos (nunca escribe solo).
  async function workInChat(f) {
    const prompt = [
      `Revisión de salud detectó este hallazgo en la consola (Claude Web Console). Analicémoslo juntos y decidamos el fix ANTES de tocar nada.`,
      '',
      `Módulo: ${f.module || '—'}`,
      `Severidad: ${SEV_LABEL[f.severity] || f.severity} · Tipo: ${f.kind || '—'}`,
      `Qué falla: ${f.area}`,
      f.file ? `Archivo: ${f.file}` : '',
      '',
      `Detalle: ${f.detail}`,
      f.suggestedFix ? `Fix sugerido por la auditoría: ${f.suggestedFix}` : '',
      '',
      'Verificá primero leyendo el código citado que el hallazgo es real (la auditoría puede equivocarse), explicame la causa y proponé el cambio mínimo. No edites nada hasta que aprobemos juntos.',
    ].filter((l) => l !== null && l !== undefined).join('\n');
    m.close();
    await openChat({ cwd: 'claude-web-console', mode: 'plan', prompt, title: `Salud: ${f.area}`.slice(0, 40) });
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
