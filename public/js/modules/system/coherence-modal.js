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
import { pacman } from '../../ui/pacman.js';

const API = '/api/health';
const POLL_MS = 4000;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' · ' + new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '—');
const RISK_LABEL = { bajo: '🟢 bajo', medio: '🟡 medio', alto: '🔴 alto' };
// Severidad de un hallazgo determinístico → clase de riesgo reutilizada.
const SEV = { alto: { risk: 'alto', label: '🔴 alto' }, aviso: { risk: 'medio', label: '🟡 aviso' }, info: { risk: 'bajo', label: '🟢 info' } };
const TIPO_ICON = { cableado: '🔗', dedup: '♻️', 'fuente-unica': '🎯', 'regla-oro': '🏅', blindaje: '🔒', espejo: '🪞', adopcion: '⚡', convencion: '📐', otro: '🔧' };
const TIPO_LABEL = { cableado: 'Cableado', dedup: 'Deduplicar', 'fuente-unica': 'Fuente única', 'regla-oro': 'Regla de oro', blindaje: 'Blindaje', espejo: 'Espejo back↔front', adopcion: 'Adoptar patrón', convencion: 'Convención', otro: 'Ajuste' };
const CAT_ICON = { reuso: '🔗', 'fuente-unica': '🎯', 'regla-oro': '🏅', blindaje: '🔒', huerfano: '👻', registro: '🧩', adopcion: '⚡', convencion: '📐' };

// Abre la sub-ventana. `ctx` trae dialog + openChat (para aplicar una propuesta).
export function openCoherence(ctx, { isAdmin }) {
  const { dialog, openChat } = ctx;
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  const m = dialog.openModal({ title: '🔗 Coherencia de motores y módulos', width: 900 });
  m.card.classList.add('dlg-card--health');
  const wrap = document.createElement('div');
  wrap.className = 'hp-opt';
  m.body.appendChild(wrap);

  let alive = true;
  let pollTimer = null;
  const origOnClose = m.close;
  m.close = () => { alive = false; clearTimeout(pollTimer); origOnClose(); };
  m.overlay.addEventListener('mousedown', (e) => { if (e.target === m.overlay) m.close(); });

  // ===== Censo: servicios transversales + grafo de módulos (árbol) =====
  function servicesHtml(census) {
    const services = census?.services || [];
    const rows = services.map((s) => {
      const n = (s.consumerModules || []).length;
      const warn = !s.exists ? '<span class="hp-opt-risk hp-opt-risk--medio">no existe</span>'
        : (n === 0 ? '<span class="hp-opt-risk hp-opt-risk--alto">👻 sin consumidores</span>' : '');
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
        : (cand ? `<span class="hp-opt-risk hp-opt-risk--medio">⚡ ${cand} candidato(s)</span>` : '<span class="hp-opt-snippet">al día</span>');
      return `<tr title="${esc(pt.label)}">
        <td>${esc(pt.label)}</td>
        <td>${(pt.adopters || []).length}</td>
        <td>${flag}</td>
      </tr>`;
    }).join('');
    const convRows = (census?.conventions || []).map((c) => {
      const n = (c.violations || []).length;
      const flag = !c.mechanical ? '<span class="hp-opt-snippet">criterio IA</span>'
        : (n ? `<span class="hp-opt-risk hp-opt-risk--medio">⚠ ${n} lead(s)</span>` : '<span class="hp-opt-snippet">al día</span>');
      return `<tr title="${esc(c.label)}">
        <td>${esc(c.label)}</td>
        <td>${c.scopedCount ?? 0}</td>
        <td>${flag}</td>
      </tr>`;
    }).join('');
    return `<details class="hp-opt-census" ${isMobile ? '' : 'open'}>
      <summary>🕸 Grafo · ${(census?.counts?.modules) || 0} módulos · ${(census?.counts?.edges) || 0} aristas</summary>
      <details class="hp-opt-group" ${isMobile ? '' : 'open'}>
        <summary>🔌 Servicios transversales · ${services.length}</summary>
        <table class="hp-opt-table">
          <thead><tr><th>Servicio</th><th>Qué es</th><th>Consumido por</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </details>
      <details class="hp-opt-group" ${isMobile ? '' : 'open'}>
        <summary>⚡ Patrones canónicos · adopción</summary>
        <table class="hp-opt-table">
          <thead><tr><th>Patrón</th><th>Adoptan</th><th>Estado</th></tr></thead>
          <tbody>${patRows || '<tr><td colspan="3">—</td></tr>'}</tbody>
        </table>
      </details>
      <details class="hp-opt-group" ${isMobile ? '' : 'open'}>
        <summary>📐 Convenciones · CLAUDE.md</summary>
        <table class="hp-opt-table">
          <thead><tr><th>Convención</th><th>Alcance</th><th>Estado</th></tr></thead>
          <tbody>${convRows || '<tr><td colspan="3">—</td></tr>'}</tbody>
        </table>
      </details>
      <details class="hp-opt-group">
        <summary>🧩 Quién usa a quién (por módulo)</summary>
        <table class="hp-opt-table">
          <thead><tr><th>Módulo</th><th>Usa</th></tr></thead>
          <tbody>${modRows || '<tr><td colspan="2">—</td></tr>'}</tbody>
        </table>
      </details>
    </details>`;
  }

  // ===== Hallazgos determinísticos (0 tokens): la semilla que verifica la IA =====
  // Cada uno muestra detalle + PROCEDIMIENTO (pasos) y, para admin, un botón
  // "Resolver en chat" (supervisado, acceptEdits) — accionable SIN gastar la IA.
  function findingHtml(f) {
    const sev = SEV[f.severidad] || SEV.info;
    const pasos = (f.pasos || []).length
      ? `<div class="hp-detail"><b>Procedimiento:</b></div><ol class="hp-opt-flow">${f.pasos.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : '';
    const resolve = isAdmin
      ? `<div class="hp-opt-actions"><button class="btn-ghost btn--sm" data-act="cohresolve" data-id="${esc(f.id)}">💬 Resolver en chat</button></div>` : '';
    return `<details class="hp-opt-card">
      <summary class="hp-opt-head">
        <span>${CAT_ICON[f.categoria] || '🔗'}</span>
        <b>${esc(f.foco)}</b>
        <span class="hp-opt-snippet">${esc(f.detalle)}</span>
        <span class="hp-opt-risk hp-opt-risk--${sev.risk}">${sev.label}</span>
      </summary>
      <div class="hp-opt-body">
        <div class="hp-detail">${esc(f.detalle)}</div>
        <div class="hp-detail"><b>Sugerencia:</b> ${esc(f.sugerencia)}</div>
        ${pasos}
        ${resolve}
      </div>
    </details>`;
  }

  function findingsHtml(findings) {
    if (!findings?.length) return '<p class="hp-empty">✅ El censo determinístico no encontró incoherencias evidentes.</p>';
    const order = { alto: 0, aviso: 1, info: 2 };
    const sorted = [...findings].sort((a, b) => (order[a.severidad] ?? 3) - (order[b.severidad] ?? 3));
    return `<details class="hp-opt-group" open>
      <summary>🧪 Hallazgos determinísticos · ${findings.length} (0 tokens — con procedimiento; verificables con IA)</summary>
      ${sorted.map(findingHtml).join('')}
    </details>`;
  }

  // ===== Propuestas IA: agrupadas por FOCO (árbol), cada una colapsable =====
  function proposalHtml(p) {
    const decided = p.status === 'accepted' ? '<span class="hp-opt-done">✅ aceptada</span>' : '';
    const actions = isAdmin && p.status === 'pending' ? `
      <div class="hp-opt-actions">
        <button class="btn-ghost btn--sm" data-act="cohreject" data-id="${esc(p.id)}">✕ Descartar</button>
        <button class="btn btn--sm" data-act="cohapply" data-id="${esc(p.id)}">💬 Aplicar en chat</button>
      </div>` : '';
    const state = p.status === 'accepted' ? decided : `<span class="hp-opt-risk hp-opt-risk--${esc(p.riesgo)}">${RISK_LABEL[p.riesgo] || esc(p.riesgo)}</span>`;
    return `<details class="hp-opt-card">
      <summary class="hp-opt-head">
        <span>${TIPO_ICON[p.tipo] || '🔧'}</span>
        <b>${esc(TIPO_LABEL[p.tipo] || p.tipo)}</b>
        <span class="hp-opt-snippet">${esc(p.propuesta)}</span>
        ${state}
      </summary>
      <div class="hp-opt-body">
        <div class="hp-opt-diff"><s>${esc(p.actual)}</s> → <b>${esc(p.propuesta)}</b></div>
        <div class="hp-detail">${esc(p.razon)}${p.impacto ? ` · <b>Gana:</b> ${esc(p.impacto)}` : ''}</div>
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
        <summary>⚙️ ${esc(foco)} · ${ps.length} propuesta(s)${pend ? ` · ${pend} pendiente(s)` : ' · al día'}</summary>
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
      parts.push(`<p class="hp-running">${pacman({ state: 'delegating' })} Analizando · ${esc(d.progress?.phase || '…')}</p>`);
    } else if (d.error) {
      parts.push(`<p class="hp-error">El último análisis falló: ${esc(d.error)}</p>`);
    }
    if (d.updatedAt && d.resumen) {
      const pend = (d.propuestas || []).filter((p) => p.status === 'pending').length;
      parts.push(`<div class="hp-verdict hp-verdict--${pend ? 'atencion' : 'ok'}">
        <b>${pend ? `${pend} propuesta(s) pendiente(s)` : 'Sin propuestas pendientes'}</b>
        <span class="hp-when">${fmtDate(d.updatedAt)}</span>
      </div>`);
      parts.push(`<details class="hp-opt-resumen-box" ${isMobile ? '' : 'open'}>
        <summary>📋 Resumen del análisis</summary>
        <p class="hp-opt-resumen">${esc(d.resumen)}</p>
      </details>`);
      parts.push(proposalsTreeHtml((d.propuestas || []).filter((p) => p.status !== 'rejected')));
      if (d.flujoNuevo?.vale) {
        parts.push(`<details class="hp-opt-card hp-opt-card--flow">
          <summary class="hp-opt-head"><span>🕸</span><b>Flujo nuevo propuesto</b><span class="hp-opt-snippet">${esc(d.flujoNuevo.titulo)}</span></summary>
          <div class="hp-opt-body">
            <div class="hp-detail">${esc(d.flujoNuevo.descripcion)}</div>
            <ul class="hp-opt-flow">${(d.flujoNuevo.diseno || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
            ${isAdmin ? '<div class="hp-opt-actions"><button class="btn-ghost btn--sm" data-act="cohflow">💬 Explorar en chat (plan)</button></div>' : ''}
          </div>
        </details>`);
      }
    } else if (!d.running) {
      parts.push('<p class="hp-empty">Todavía no se corrió ningún análisis de coherencia con IA (arriba están los hallazgos determinísticos, gratis).</p>');
    }
    if (isAdmin) {
      parts.push(`<button class="btn btn--block" data-act="cohrun" ${d.running ? 'disabled' : ''}>${icon('gear', { size: 14 })}<span>${d.running ? 'Análisis en curso…' : 'Analizar con IA'}</span></button>`);
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
      if (alive) wrap.innerHTML = '<p class="hp-empty">No se pudo leer la coherencia.</p>';
    }
  }

  async function runCoherence() {
    const ok = await dialog.confirmDialog({
      title: 'Análisis de Coherencia',
      message: 'Analiza si los motores y módulos de la consola se usan entre sí de forma coherente (grafo de dependencias + lectura del código con Sonnet) y propone cableados/deduplicaciones.\n\nCorre desacoplado (sobrevive reinicios) y CONSUME TOKENS. Nada se aplica solo: cada propuesta la aprobás vos.',
      confirmLabel: 'Analizar (usa tokens)',
    });
    if (!ok) return;
    try {
      const res = await fetch(`${API}/coherence`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || res.status);
    } catch (err) {
      await dialog.alertDialog({ title: 'Coherencia', message: `No se pudo lanzar: ${err.message || err}` });
    }
    load();
  }

  async function decideProposal(id, action) {
    try {
      const res = await fetch(`${API}/coherence-proposal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.status);
    } catch (err) {
      await dialog.alertDialog({ title: 'Coherencia', message: `No se pudo guardar la decisión: ${err.message || err}` });
    }
  }

  // Aprobar = marcar aceptada + abrir un chat SUPERVISADO (acceptEdits) con todo
  // el contexto para aplicar el cableado. Nunca se aplica sola.
  async function applyProposal(p) {
    const prompt = [
      'El Módulo de Coherencia de la consola (Claude Web Console) detectó que dos partes del sistema no se están usando entre sí de forma óptima y propuso este cableado. Aplicalo de forma supervisada.',
      '',
      `Foco: ${p.foco}${p.archivo ? ` (${p.archivo})` : ''}`,
      `Tipo: ${p.tipo} · Riesgo: ${p.riesgo}`,
      `Actual: ${p.actual}`,
      `Propuesta: ${p.propuesta}`,
      `Razón: ${p.razon}`,
      p.impacto ? `Impacto esperado: ${p.impacto}` : '',
      p.archivos?.length ? `Archivos a tocar: ${p.archivos.join(', ')}` : '',
      p.pasos?.length ? `Pasos sugeridos:\n${p.pasos.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` : '',
      '',
      'Reglas ESTRICTAS:',
      '1. Leé el CLAUDE.md de la raíz ANTES de tocar nada: las reglas duras (1-9) son inviolables — en particular el blindaje read-only de dos capas de las corridas headless y los runners desacoplados (regla de oro).',
      '2. Verificá leyendo el código que la incoherencia sigue vigente y que el cableado propuesto es correcto y no rompe otra cosa. Si no aplica, avisame y no toques nada.',
      '3. Preferí SIEMPRE reusar la fuente/servicio canónico existente en vez de duplicar lógica.',
      '4. Verificá cada archivo .js que edites con `node --check`.',
      '5. FRENÁ y pedime confirmación ANTES de cualquier acción de alto riesgo (git push, reiniciar el servicio, borrar datos).',
      '6. Al terminar, resumí qué cableaste, en qué archivos y cómo verificarlo.',
    ].filter(Boolean).join('\n');
    await decideProposal(p.id, 'accept');
    m.close();
    await openChat?.({ cwd: 'claude-web-console', mode: 'acceptEdits', prompt, title: `Coherencia: ${p.foco}`.slice(0, 40) });
  }

  // Resolver un hallazgo DETERMINÍSTICO en un chat supervisado (acceptEdits) con
  // su detalle + procedimiento. No gasta la corrida IA: acciona el lead directo.
  async function resolveFinding(f) {
    const prompt = [
      'El Módulo de Coherencia de la consola (Claude Web Console) detectó esta incoherencia estructural (censo determinístico). Resolvela de forma supervisada.',
      '',
      `Categoría: ${f.categoria} · Severidad: ${f.severidad}`,
      `Foco: ${f.foco}`,
      `Detalle: ${f.detalle}`,
      `Sugerencia: ${f.sugerencia}`,
      f.pasos?.length ? `Procedimiento sugerido:\n${f.pasos.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` : '',
      '',
      'Reglas ESTRICTAS:',
      '1. Leé el CLAUDE.md de la raíz ANTES de tocar nada: las reglas duras (1-9) son inviolables (blindaje read-only de dos capas, runners desacoplados, bind ZeroTier…).',
      '2. Verificá leyendo el código que la incoherencia sigue vigente. Si es un FALSO POSITIVO (p.ej. un módulo helper que no debe montarse, o un runner referenciado dinámicamente), avisame y no toques nada.',
      '3. Preferí SIEMPRE reusar la fuente/servicio canónico existente en vez de duplicar lógica.',
      '4. Verificá cada archivo .js que edites con `node --check`.',
      '5. FRENÁ y pedime confirmación ANTES de cualquier acción de alto riesgo (git push, reiniciar el servicio, borrar datos).',
      '6. Al terminar, resumí qué cambiaste, en qué archivos y cómo verificarlo.',
    ].filter(Boolean).join('\n');
    m.close();
    await openChat?.({ cwd: 'claude-web-console', mode: 'acceptEdits', prompt, title: `Coherencia: ${f.foco}`.slice(0, 40) });
  }

  async function exploreFlow(fn) {
    const prompt = [
      'El Módulo de Coherencia de la consola (Claude Web Console) propuso este FLUJO NUEVO para mejorar cómo se aprovechan los motores/módulos entre sí. Explorá el diseño en modo plan: evaluá si conviene, cómo encaja con la arquitectura (runners desacoplados, regla de oro, regla 6 de CLAUDE.md) y armá el plan de implementación. NO implementes nada todavía.',
      '',
      `Título: ${fn.titulo}`,
      `Descripción: ${fn.descripcion}`,
      fn.diseno?.length ? `Diseño propuesto:\n${fn.diseno.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
    m.close();
    await openChat?.({ cwd: 'claude-web-console', mode: 'plan', prompt, title: `Flujo: ${fn.titulo}`.slice(0, 40) });
  }

  wrap.innerHTML = `<p class="hp-running">${pacman()} cargando…</p>`;
  load();
}
