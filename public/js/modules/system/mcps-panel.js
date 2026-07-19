// modules/system/mcps-panel.js — pestaña "Conexiones (MCP)" de ⚙ Sistema:
// censo + ESTADO EN VIVO de los servidores MCP, agrupado por mundo. Hermano de
// skills-panel.js (reusa el look de tarjeta colapsable .hr-*), pero además del
// detalle muestra un semáforo de conexión y ofrece acciones para (re)conectar
// DESDE LA VENTANA:
//   · 🔄 Re-verificar        · ♻️ Reciclar runners (global)
//   · 🔐 Reconectar (OAuth guiado, Fase 2) · ⏻ Desconectar · 📋 Copiar comando
// El backend es el módulo `mcps` (GET /api/mcps + acciones admin).
import { icon } from '../../ui/icons.js';
import { t } from '../../ui/i18n.js';
import { pacman } from '../../ui/pacman.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LIGHT_DOT = { ok: '🟢', warn: '🟡', info: '🟠', danger: '🔴', neutral: '⚪' };

// Borde de la tarjeta según severidad de conexión (reusa la escala visual de
// health-review: verde ok / ámbar warn / rojo danger / gris neutro).
function cardClass(s) {
  return { ok: 'hr-finding--linked', warn: 'hr-finding--orphan', info: 'hr-finding--medium', danger: 'hr-finding--high', neutral: 'hr-finding--low' }[s.status.light] || 'hr-finding--low';
}

function serverCard(world, s, i) {
  const collapsed = i > 0 ? ' hr-collapsed' : '';
  const dot = LIGHT_DOT[s.status.light] || '⚪';
  const role = s.role ? `<div class="hr-f-file">🎯 ${esc(s.role)}</div>` : '';
  const target = s.transport === 'stdio'
    ? `<div class="hr-f-file">⌨ <code>${esc(s.command || '')}${s.args ? ' ' + esc(s.args.join(' ')) : ''}</code></div>`
    : `<div class="hr-f-file">🌐 <code>${esc(s.url || s.endpoint)}</code>${s.hasHeaders ? ` · ${t('system.mcps.withAuthHeader', 'con auth header')}` : ''}</div>`;

  // Botones de acción según estado. reconnectable = HTTP/SSE con OAuth pendiente.
  const acts = [];
  if (s.reconnectable) acts.push(`<button class="btn btn--sm" data-act="reconnect" data-world="${esc(world)}" data-name="${esc(s.name)}">${icon('refresh', { size: 12 })}<span>${t('system.mcps.reconnect', 'Reconectar')}</span></button>`);
  if (s.status.code === 'connected') acts.push(`<button class="btn-ghost btn--sm" data-act="logout" data-world="${esc(world)}" data-name="${esc(s.name)}">${t('system.mcps.disconnect', 'Desconectar')}</button>`);
  acts.push(`<button class="btn-ghost btn--sm" data-act="copy" data-world="${esc(world)}" data-name="${esc(s.name)}">${icon('clipboard', { size: 12 })}<span>${t('system.mcps.copyCommand', 'Copiar comando')}</span></button>`);

  return `
    <div class="hr-finding ${cardClass(s)}${collapsed}" data-key="${esc(world)}:${esc(s.name)}">
      <div class="hr-f-head" data-toggle="1">
        <span class="hr-chev">${icon('chevronDown', { size: 13 })}</span>
        <span class="mcp-dot" title="${esc(s.status.label)}">${dot}</span>
        <span class="hr-f-area">${esc(s.name)}</span>
        <span class="hr-f-mod">${esc(s.transport)} · ${esc(s.scopeLabel)}</span>
      </div>
      <div class="hr-f-body">
        <p class="hr-f-detail"><b>${dot} ${esc(s.status.label)}</b></p>
        ${role}${target}
        <div class="mcp-acts">${acts.join('')}</div>
      </div>
    </div>`;
}

export function mountMcpsPanel(el, ctx = {}) {
  const { dialog, isAdmin } = ctx;
  el.innerHTML = `<div data-ref="root">${pacman({ size: 'sm' })} <span class="hr-summary">${t('system.mcps.loadingConnections', 'Cargando conexiones…')}</span></div>`;
  const root = el.querySelector('[data-ref="root"]');

  let alive = true;
  const obs = new MutationObserver(() => { if (!el.isConnected) { alive = false; obs.disconnect(); } });
  obs.observe(document.body, { childList: true, subtree: true });

  function wire() {
    root.querySelectorAll('[data-toggle]').forEach((head) => {
      head.addEventListener('click', () => head.closest('.hr-finding')?.classList.toggle('hr-collapsed'));
    });
    root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      onAction(b.dataset.act, b.dataset.world, b.dataset.name);
    }));
    const rev = root.querySelector('[data-ref="reverify"]');
    if (rev) rev.addEventListener('click', () => load(true));
    const rec = root.querySelector('[data-ref="recycle"]');
    if (rec) rec.addEventListener('click', recycleRunners);
  }

  async function onAction(act, world, name) {
    if (act === 'copy') {
      const cmd = `cd ${world === 'tolkien' ? '~/tolkien' : '~/claude-web-console'} && claude mcp login ${name}`;
      try { await navigator.clipboard.writeText(cmd); dialog.alertDialog?.({ title: t('system.mcps.copiedTitle', 'Copiado'), message: t('system.mcps.copyTerminalMessage', 'Pegá en una terminal interactiva:\n\n{cmd}', { cmd }) }); }
      catch { dialog.alertDialog?.({ title: t('system.mcps.commandTitle', 'Comando'), message: cmd }); }
      return;
    }
    if (act === 'logout') {
      const ok = await (dialog.confirmSheet || dialog.confirmDialog)?.({ title: t('system.mcps.disconnectTitle', 'Desconectar'), message: t('system.mcps.disconnectMessage', '¿Limpiar las credenciales OAuth de "{name}"? Vas a tener que reconectarlo.', { name }), danger: true });
      if (!ok) return;
      try {
        const r = await fetch('/api/mcps/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ world, name }) });
        if (!r.ok) throw new Error((await r.json()).error || r.status);
        load(true);
      } catch (e) { dialog.alertDialog?.({ title: t('system.mcps.errorTitle', 'Error'), message: String(e.message || e) }); }
      return;
    }
    if (act === 'reconnect') openReconnect(world, name);
  }

  async function recycleRunners() {
    const ok = await (dialog.confirmSheet || dialog.confirmDialog)?.({ title: t('system.mcps.recycleRunnersTitle', 'Reciclar runners'), message: t('system.mcps.recycleRunnersMessage', 'Recicla los motores de chat para que re-lean las credenciales/MCP frescas. Los chats vivos se re-enganchan solos (0 historial perdido). ¿Seguir?') });
    if (!ok) return;
    try {
      const r = await fetch('/api/admin/restart-runners', { method: 'POST' });
      const d = await r.json();
      dialog.alertDialog?.({ title: t('system.mcps.runnersRecycledTitle', 'Runners reciclados'), message: t('system.mcps.runnersRecycledMessage', 'Se reiniciaron {count} runner(s). Se re-conectan en la próxima interacción.', { count: d.killed ?? 0 }) });
    } catch (e) { dialog.alertDialog?.({ title: t('system.mcps.errorTitle', 'Error'), message: String(e.message || e) }); }
  }

  // --- Fase 2: reconexión OAuth guiada ---
  function openReconnect(world, name) {
    const m = dialog.openModal({ title: t('system.mcps.reconnectModalTitle', 'Reconectar · {name}', { name }), width: 560 });
    let timer = null;
    const mo = new MutationObserver(() => { if (!m.body.isConnected) { if (timer) clearInterval(timer); mo.disconnect(); } });
    mo.observe(document.body, { childList: true, subtree: true });

    const setBody = (html) => { m.body.innerHTML = `<div class="mcp-oauth">${html}</div>`; };
    // Fase 1: delegando al server, que arranca el runner de login (pty).
    setBody(`${pacman({ state: 'delegating', size: 'sm' })} ${t('system.mcps.startingAuth', 'Iniciando autenticación…')}`);

    let id = null;
    let phase = '';

    function render(job) {
      if (job.status === 'awaiting-url' && phase !== 'awaiting') {
        phase = 'awaiting';
        // Fase 2: la pelota es TUYA — hay que autorizar y pegar la URL. Pac-Man
        // en 'waiting' (verde, tu turno), no 'delegating'.
        setBody(`
          <p class="mcp-oauth-wait">${pacman({ state: 'waiting', size: 'sm' })} <b>${t('system.mcps.yourTurn', 'Tu turno:')}</b> ${t('system.mcps.authorizeAndPaste', 'autorizá y pegá la URL de vuelta.')}</p>
          <ol class="mcp-oauth-steps">
            <li>${t('system.mcps.openAuthorizeStep', 'Abrí este enlace y autorizá el acceso:')}<br>
              <a href="${esc(job.url)}" target="_blank" rel="noopener" class="mcp-oauth-link">${icon('externalLink', { size: 13 })} ${t('system.mcps.openAuthorization', 'Abrir autorización')}</a></li>
            <li>${t('system.mcps.redirectStepBeforeCode', 'Te va a redirigir a una URL que arranca con')} <code>http://localhost…/callback</code> ${t('system.mcps.redirectStepAfterCode', '(no carga, es normal).')} <b>${t('system.mcps.copyFullUrl', 'Copiá esa URL completa')}</b> ${t('system.mcps.fromBrowserBar', 'de la barra del navegador.')}</li>
            <li>${t('system.mcps.pasteHere', 'Pegala acá:')}<br>
              <input type="text" class="dlg-input" data-ref="code" placeholder="http://localhost:3118/callback?code=…" />
              <button class="btn btn--sm" data-ref="send">${icon('check', { size: 12 })}<span>${t('system.mcps.send', 'Enviar')}</span></button></li>
          </ol>
          <p class="hr-f-file" data-ref="msg"></p>`);
        const send = m.body.querySelector('[data-ref="send"]');
        const input = m.body.querySelector('[data-ref="code"]');
        send.addEventListener('click', async () => {
          const value = input.value.trim();
          if (!value) return;
          send.disabled = true;
          m.body.querySelector('[data-ref="msg"]').textContent = t('system.mcps.completing', 'Completando…');
          try {
            const r = await fetch('/api/mcps/login-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, value }) });
            if (!r.ok) throw new Error((await r.json()).error || r.status);
          } catch (e) { m.body.querySelector('[data-ref="msg"]').textContent = t('system.mcps.inlineError', 'Error: {error}', { error: e.message || e }); send.disabled = false; }
        });
      } else if (job.status === 'exchanging' && phase !== 'exchanging') {
        phase = 'exchanging';
        // Fase 3: de vuelta el server, intercambiando el code por credenciales.
        setBody(`${pacman({ state: 'delegating', size: 'sm' })} ${t('system.mcps.exchangingCredentials', 'Intercambiando credenciales…')}`);
      } else if (job.status === 'done') {
        if (timer) clearInterval(timer);
        setBody(`
          <p class="hr-f-detail">🟢 <b>${t('system.mcps.reconnected', 'Reconectado.')}</b> ${t('system.mcps.authenticatedMessage', '"{name}" quedó autenticado.', { name: esc(name) })}</p>
          <p class="hr-f-file">${t('system.mcps.recycleAfterReconnect', 'Para que los chats vivos tomen la credencial fresca, reciclá los runners.')}</p>
          <div class="mcp-acts">
            <button class="btn btn--sm" data-ref="recycle2">♻️ ${t('system.mcps.recycleRunnersTitle', 'Reciclar runners')}</button>
            <button class="btn-ghost btn--sm" data-ref="close2">${t('system.mcps.close', 'Cerrar')}</button>
          </div>`);
        m.body.querySelector('[data-ref="recycle2"]').addEventListener('click', () => { recycleRunners(); });
        m.body.querySelector('[data-ref="close2"]').addEventListener('click', () => { m.close?.(); load(true); });
      } else if (job.status === 'error') {
        if (timer) clearInterval(timer);
        setBody(`<p class="hr-f-crit">🔴 ${t('system.mcps.reconnectError', 'No se pudo reconectar: {error}', { error: esc(job.error || t('system.mcps.unknownError', 'error desconocido')) })}</p>
          <p class="hr-f-file">${t('system.mcps.manualAlternativeBeforeCommand', 'Alternativa: copiá el comando y corré')} <code>claude mcp login ${esc(name)}</code> ${t('system.mcps.manualAlternativeAfterCommand', 'en una terminal interactiva.')}</p>`);
      }
    }

    (async () => {
      try {
        const r = await fetch('/api/mcps/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ world, name }) });
        if (!r.ok) throw new Error((await r.json()).error || r.status);
        id = (await r.json()).id;
        timer = setInterval(async () => {
          try {
            const jr = await fetch('/api/mcps/login/' + encodeURIComponent(id));
            if (jr.ok) render(await jr.json());
          } catch { /* red intermitente, sigue */ }
        }, 1500);
      } catch (e) {
        setBody(`<p class="hr-f-crit">${t('system.mcps.startError', 'No se pudo iniciar: {error}', { error: esc(e.message || e) })}</p>`);
      }
    })();
  }

  function render(d) {
    const globalActs = `
      <div class="mcp-topbar">
        <button class="btn-ghost btn--sm" data-ref="reverify">${icon('refresh', { size: 13 })}<span>${t('system.mcps.reverify', 'Re-verificar')}</span></button>
        ${isAdmin ? `<button class="btn-ghost btn--sm" data-ref="recycle">♻️<span>${t('system.mcps.recycleRunnersTitle', 'Reciclar runners')}</span></button>` : ''}
      </div>`;

    const groups = (d.worlds || []).map((w) => {
      const warn = w.error
        ? `<p class="hr-f-crit">⚠️ ${t('system.mcps.worldReadError', 'No se pudo leer: {error}', { error: esc(w.error) })}</p>`
        : w.hasWarnings ? `<p class="hr-f-file">⚠️ ${t('system.mcps.configWarnings', 'Claude reportó avisos de config en este mundo (p.ej. un server en dos scopes). Revisalos con')} <code>claude mcp list</code>.</p>` : '';
      const cards = w.servers.length
        ? w.servers.map((s, i) => serverCard(w.world, s, i)).join('')
        : `<p class="hr-summary">${t('system.mcps.noWorldServers', 'Sin servidores MCP en este mundo.')}</p>`;
      return `<details class="hr-collapsible" open>
        <summary>${esc(w.label)} <span class="hr-f-mod">${esc(w.cwd)}</span> (${w.servers.length})</summary>
        ${warn}
        <div class="hr-findings">${cards}</div>
      </details>`;
    }).join('');

    root.innerHTML = `
      <p class="pj-hint">${t('system.mcps.hintBeforeCommand', 'Servidores MCP de Claude Code por mundo, con estado en vivo. Estado vía')} <code>claude mcp list</code> — ${t('system.mcps.zeroTokens', '0 tokens')}.</p>
      ${globalActs}
      ${groups || `<p class="hr-summary">${t('system.mcps.noServers', 'No se encontraron servidores MCP.')}</p>`}`;
    wire();
  }

  async function load(fresh) {
    root.innerHTML = `${pacman({ size: 'sm' })} <span class="hr-summary">${t('system.mcps.verifyingConnections', 'Verificando conexiones…')}</span>`;
    let d;
    try {
      const res = await fetch('/api/mcps' + (fresh ? '?fresh=1' : ''));
      d = await res.json();
    } catch { d = null; }
    if (!alive) return;
    if (!d || d.error) { root.innerHTML = `<p class="hr-summary">${t('system.mcps.loadStateError', 'No se pudo cargar el estado de los MCP.')}${d?.error ? ' ' + esc(d.error) : ''}</p>`; return; }
    render(d);
  }

  load(false);
}
