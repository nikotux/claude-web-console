// modules/system/mcps-panel.js — pestaña "Conexiones (MCP)" de ⚙ Sistema:
// censo + ESTADO EN VIVO de los servidores MCP, agrupado por mundo. Hermano de
// skills-panel.js (reusa el look de tarjeta colapsable .hr-*), pero además del
// detalle muestra un semáforo de conexión y ofrece acciones para (re)conectar
// DESDE LA VENTANA:
//   · 🔄 Re-verificar        · ♻️ Reciclar runners (global)
//   · 🔐 Reconectar (OAuth guiado, Fase 2) · ⏻ Desconectar · 📋 Copiar comando
// El backend es el módulo `mcps` (GET /api/mcps + acciones admin).
//
// Segunda sección "🔗 Cuentas conectadas" (PLAN-781): conexiones por-USUARIO
// para que Microsoft use el calendario de esa persona y Zoho Desk publique
// comentarios a su nombre. A diferencia de los MCP, que son configuración de
// la máquina, esta sección reusa el mismo look .hr-* y el mismo patrón
// modal+poll de openReconnect. Es tolerante a fallos: si /api/connections aún
// no existe (404), muestra un estado neutro y no rompe el resto del panel.
import { icon } from '../../ui/icons.js';
import { t } from '../../ui/i18n.js';
import { pacman } from '../../ui/pacman.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LIGHT_DOT = { ok: '🟢', warn: '🟡', info: '🟠', danger: '🔴', neutral: '⚪' };
const PROVIDER_META = {
  microsoft: { emoji: '📅', purposeKey: 'system.conn.purposeMicrosoft', purposeEs: 'Tu calendario: la consola lee tus eventos con TU cuenta, no con la de otro.' },
  zoho: { emoji: '🎫', purposeKey: 'system.conn.purposeZoho', purposeEs: 'Zoho Desk: que tus comentarios en los tickets salgan a TU nombre.' },
};

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

  function connStatus(p) {
    if (p.error) return { light: 'danger', label: t('system.conn.stError', 'Error: {e}', { e: p.error }) };
    if (!p.configured) return { light: 'neutral', label: t('system.conn.stUnconfigured', 'No configurado — falta que un admin cargue las credenciales de la app.') };
    if (p.connected) return { light: 'ok', label: t('system.conn.stConnected', 'Conectado como {acct}', { acct: p.account || '—' }) };
    return { light: 'warn', label: t('system.conn.stDisconnected', 'Sin conectar — conectá tu cuenta para usarlo.') };
  }

  function connTag(p) {
    if (!p.configured) return t('system.conn.tagUnconfigured', 'sin configurar');
    if (p.connected) return t('system.conn.tagConnected', 'conectada');
    return t('system.conn.tagPending', 'sin conectar');
  }

  function connCard(p, i) {
    const st = connStatus(p);
    const dot = LIGHT_DOT[st.light] || '⚪';
    const meta = PROVIDER_META[p.id] || { emoji: '🔗', purposeKey: 'system.conn.purposeGeneric', purposeEs: 'Cuenta personal conectada a la consola.' };
    const connectedAt = p.connectedAt ? `<div class="hr-f-file">🕑 ${esc(new Date(p.connectedAt).toLocaleString())}</div>` : '';
    const scopes = p.scopes?.length ? `<div class="hr-f-file">🔑 <code>${esc(p.scopes.join(' '))}</code></div>` : '';
    const acts = [];
    if (p.configured && !p.connected) {
      acts.push(`<button class="btn btn--sm" data-cact="connect" data-prov="${esc(p.id)}">${icon('externalLink', { size: 12 })}<span>${t('system.conn.connect', 'Conectar mi cuenta')}</span></button>`);
    }
    if (p.connected) {
      acts.push(`<button class="btn-ghost btn--sm" data-cact="disconnect" data-prov="${esc(p.id)}">${t('system.conn.disconnect', 'Desconectar')}</button>`);
    }
    const actions = p.configured
      ? `<div class="mcp-acts">${acts.join('')}</div>`
      : `<p class="hr-f-file">${t('system.conn.needsAdmin', 'Un admin tiene que cargar las credenciales de la app abajo antes de que puedas conectar tu cuenta.')}</p>`;

    return `
      <div class="hr-finding ${cardClass({ status: st })}${i > 0 ? ' hr-collapsed' : ''}" data-conn="${esc(p.id)}">
        <div class="hr-f-head" data-toggle="1">
          <span class="hr-chev">${icon('chevronDown', { size: 13 })}</span>
          <span class="mcp-dot" title="${esc(st.label)}">${dot}</span>
          <span class="hr-f-area">${meta.emoji} ${esc(p.label)}</span>
          <span class="hr-f-mod">${esc(connTag(p))}</span>
        </div>
        <div class="hr-f-body">
          <p class="hr-f-detail"><b>${dot} ${esc(st.label)}</b></p>
          <div class="hr-f-file">${t(meta.purposeKey, meta.purposeEs)}</div>
          ${connectedAt}
          ${scopes}
          ${actions}
        </div>
      </div>`;
  }

  function connAdminBlock(d) {
    if (!d.isAdmin) return '';
    const labels = new Map((d.providers || []).map((p) => [p.id, p.label]));
    const providerLabel = (prov) => esc(labels.get(prov) || (prov === 'microsoft' ? t('system.conn.providerMicrosoft', 'Microsoft') : t('system.conn.providerZoho', 'Zoho')));
    return `
      <details class="hr-collapsible">
        <summary>⚙️ ${t('system.conn.appCredsTitle', 'Credenciales de la app (admin)')}</summary>
        <p class="pj-hint">${t('system.conn.appCredsHint', 'Esto se configura UNA sola vez para toda la consola. Después cada persona conecta su propia cuenta con el botón de arriba.')}</p>
        <div class="conn-appform" data-appform="microsoft">
          <h4 class="conn-fh">${providerLabel('microsoft')}</h4>
          <label class="conn-flabel">${t('system.conn.fClientId', 'Client ID')}</label>
          <input class="dlg-input" data-f="clientId">
          <label class="conn-flabel">${t('system.conn.fTenantId', 'Tenant ID')}</label>
          <input class="dlg-input" data-f="tenantId">
          <button class="btn btn--sm" data-cact="saveapp" data-prov="microsoft">${t('system.conn.save', 'Guardar')}</button>
          <p class="hr-f-file" data-appmsg="microsoft"></p>
        </div>
        <div class="conn-appform" data-appform="zoho">
          <h4 class="conn-fh">${providerLabel('zoho')}</h4>
          <label class="conn-flabel">${t('system.conn.fClientId', 'Client ID')}</label>
          <input class="dlg-input" data-f="clientId">
          <label class="conn-flabel">${t('system.conn.fClientSecret', 'Client Secret')}</label>
          <input class="dlg-input" data-f="clientSecret" type="password">
          <label class="conn-flabel">${t('system.conn.fDc', 'Data center (ej. com, eu, in)')}</label>
          <input class="dlg-input" data-f="dc">
          <button class="btn btn--sm" data-cact="saveapp" data-prov="zoho">${t('system.conn.save', 'Guardar')}</button>
          <p class="hr-f-file" data-appmsg="zoho"></p>
        </div>
      </details>`;
  }

  function connTitle() {
    return `<h3 class="conn-h">🔗 ${t('system.conn.title', 'Cuentas conectadas')}</h3>`;
  }

  function renderConnections(d) {
    const providers = d.providers || [];
    const cards = providers.length
      ? providers.map((p, i) => connCard(p, i)).join('')
      : `<p class="hr-summary">${t('system.conn.empty', 'No hay proveedores de cuentas configurados.')}</p>`;
    const host = root.querySelector('[data-ref="conn"]');
    if (!host) return;
    host.innerHTML = `
      ${connTitle()}
      <p class="pj-hint">${t('system.conn.hint', 'Tus cuentas personales. Cada persona conecta las suyas: la consola actúa con TU identidad, no con la de otro.')}</p>
      <div class="hr-findings">${cards}</div>
      ${connAdminBlock(d)}`;
  }

  async function loadConnections() {
    try {
      const host = root.querySelector('[data-ref="conn"]');
      if (!host) return;
      host.innerHTML = `${pacman({ size: 'sm' })} <span class="hr-summary">${t('system.conn.loading', 'Cargando cuentas…')}</span>`;
      let d = null;
      let unavailable = false;
      try {
        const res = await fetch('/api/connections');
        if (res.status === 404) unavailable = true;
        else if (!res.ok) throw new Error(res.status);
        else d = await res.json();
      } catch { unavailable = true; }
      if (!alive) return;
      if (unavailable || !d || !Array.isArray(d.providers)) {
        host.innerHTML = `${connTitle()}<p class="hr-summary">⚪ ${t('system.conn.unavailable', 'No disponible todavía. La conexión de cuentas personales se está terminando de instalar; probá de nuevo más tarde.')}</p>`;
        return;
      }
      renderConnections(d);
      wireConnections(d);
    } catch { /* la sección de cuentas nunca debe romper el panel MCP */ }
  }

  function wireConnections(d) {
    const host = root.querySelector('[data-ref="conn"]');
    if (!host) return;
    host.querySelectorAll('[data-toggle]').forEach((head) => {
      head.addEventListener('click', () => head.closest('.hr-finding')?.classList.toggle('hr-collapsed'));
    });
    host.querySelectorAll('[data-cact]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const prov = b.dataset.prov;
      const provider = (d.providers || []).find((p) => p.id === prov);
      const label = provider?.label || prov;
      if (b.dataset.cact === 'connect') {
        openConnect(prov, label);
      } else if (b.dataset.cact === 'disconnect') {
        const ok = await (dialog.confirmSheet || dialog.confirmDialog)?.({
          title: t('system.conn.disconnectTitle', 'Desconectar cuenta'),
          message: t('system.conn.disconnectMsg', '¿Desconectar tu cuenta de {label}? Vas a tener que volver a autorizarla.', { label }),
          danger: true,
        });
        if (!ok) return;
        try {
          const r = await fetch(`/api/connections/${encodeURIComponent(prov)}/disconnect`, { method: 'POST' });
          if (!r.ok) throw new Error((await r.json()).error || r.status);
          loadConnections();
        } catch (err) {
          dialog.alertDialog?.({ title: t('system.mcps.errorTitle', 'Error'), message: String(err.message || err) });
        }
      } else if (b.dataset.cact === 'saveapp') {
        const form = host.querySelector(`[data-appform="${prov}"]`);
        const msg = host.querySelector(`[data-appmsg="${prov}"]`);
        if (!form) return;
        const body = { provider: prov };
        form.querySelectorAll('[data-f]').forEach((input) => {
          const value = input.value.trim();
          if (value) body[input.dataset.f] = value;
        });
        b.disabled = true;
        if (msg) msg.textContent = t('system.conn.saving', 'Guardando…');
        try {
          const r = await fetch('/api/connections/app', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          if (!r.ok) throw new Error((await r.json()).error || r.status);
          if (msg) msg.textContent = t('system.conn.saved', 'Guardado.');
          loadConnections();
        } catch (err) {
          if (msg) msg.textContent = t('system.conn.inlineError', 'Error: {error}', { error: err.message || err });
        } finally {
          b.disabled = false;
        }
      }
    }));
    if (d.isAdmin) fillConnectionAppForms(host);
  }

  async function fillConnectionAppForms(host) {
    try {
      const r = await fetch('/api/connections/app');
      if (!r.ok) return;
      const app = await r.json();
      const set = (prov, field, value) => {
        const input = host.querySelector(`[data-appform="${prov}"] [data-f="${field}"]`);
        if (input && value != null) input.value = value;
      };
      set('microsoft', 'clientId', app.microsoft?.clientId || '');
      set('microsoft', 'tenantId', app.microsoft?.tenantId || '');
      set('zoho', 'clientId', app.zoho?.clientId || '');
      set('zoho', 'dc', app.zoho?.dc || '');
      const secret = host.querySelector('[data-appform="zoho"] [data-f="clientSecret"]');
      if (secret && app.zoho?.hasSecret) secret.placeholder = t('system.conn.secretSavedPlaceholder', '•••• (guardado)');
    } catch { /* best effort */ }
  }

  function openConnect(prov, label) {
    const m = dialog.openModal({ title: t('system.conn.connectTitle', 'Conectar · {label}', { label }), width: 560 });
    let timer = null;
    let jobId = null;
    let phase = '';
    const mo = new MutationObserver(() => { if (!m.body.isConnected) { if (timer) clearInterval(timer); mo.disconnect(); } });
    mo.observe(document.body, { childList: true, subtree: true });

    const setBody = (html) => { m.body.innerHTML = `<div class="mcp-oauth">${html}</div>`; };
    setBody(`${pacman({ state: 'delegating', size: 'sm' })} ${t('system.conn.starting', 'Iniciando conexión…')}`);

    const poll = () => {
      timer = setInterval(async () => {
        if (!jobId) return;
        try {
          const r = await fetch(`/api/connections/${encodeURIComponent(prov)}/status?jobId=${encodeURIComponent(jobId)}`);
          if (!r.ok) return;
          const j = await r.json();
          if (j.status === 'connected' && phase !== 'connected') {
            phase = 'connected';
            clearInterval(timer);
            const account = j.account ? ` ${esc(j.account)}` : '';
            setBody(`
              <p class="hr-f-detail">🟢 <b>${t('system.conn.doneTitle', 'Cuenta conectada.')}</b>${account}</p>
              <div class="mcp-acts"><button class="btn btn--sm" data-ref="close2">${t('system.mcps.close', 'Cerrar')}</button></div>`);
            m.body.querySelector('[data-ref="close2"]')?.addEventListener('click', () => { m.close?.(); loadConnections(); });
          } else if (j.status === 'error' && phase !== 'error') {
            phase = 'error';
            clearInterval(timer);
            setBody(`<p class="hr-f-crit">🔴 ${t('system.conn.pollError', 'No se pudo conectar: {error}', { error: esc(j.error || t('system.mcps.unknownError', 'error desconocido')) })}</p>`);
          }
        } catch { /* red intermitente, sigue */ }
      }, 3000);
    };

    const renderDevice = (j) => {
      phase = 'device';
      const expires = Number.isFinite(j.expiresIn) ? `<p class="hr-f-file">${t('system.conn.expiresIn', 'El código vence en {min} min.', { min: Math.round(j.expiresIn / 60) })}</p>` : '';
      setBody(`
        <p class="mcp-oauth-wait">${pacman({ state: 'waiting', size: 'sm' })} <b>${t('system.conn.yourTurn', 'Tu turno:')}</b> ${t('system.conn.deviceIntro', 'abrí el link, pegá el código y autorizá con tu cuenta.')}</p>
        <div class="conn-code" data-ref="code">${esc(j.userCode)}</div>
        <div class="mcp-acts">
          <button class="btn-ghost btn--sm" data-ref="copycode">${icon('clipboard', { size: 12 })}<span>${t('system.conn.copyCode', 'Copiar código')}</span></button>
          <a class="mcp-oauth-link" href="${esc(j.verificationUri)}" target="_blank" rel="noopener">${icon('externalLink', { size: 13 })} ${t('system.conn.openMs', 'Abrir Microsoft')}</a>
        </div>
        <ol class="mcp-oauth-steps">
          <li>${t('system.conn.deviceStepOpen', 'Abrí el link de Microsoft.')}</li>
          <li>${t('system.conn.deviceStepPaste', 'Pegá el código mostrado arriba.')}</li>
          <li>${t('system.conn.deviceStepAuthorize', 'Autorizá con tu cuenta y volvé acá.')}</li>
        </ol>
        ${expires}
        <p class="hr-f-file" data-ref="msg"></p>`);
      m.body.querySelector('[data-ref="copycode"]')?.addEventListener('click', async () => {
        const msg = m.body.querySelector('[data-ref="msg"]');
        try {
          await navigator.clipboard.writeText(j.userCode);
          if (msg) msg.textContent = t('system.conn.codeCopied', 'Código copiado.');
        } catch {
          if (msg) msg.textContent = t('system.conn.copyCodeFallback', 'No se pudo copiar automáticamente. Código: {code}', { code: j.userCode });
        }
      });
    };

    const renderPaste = (j) => {
      phase = 'paste';
      setBody(`
        <p class="mcp-oauth-wait">${pacman({ state: 'waiting', size: 'sm' })} <b>${t('system.conn.yourTurn', 'Tu turno:')}</b> ${t('system.conn.zohoIntro', 'abrí Zoho, generá el grant code y pegalo acá.')}</p>
        <ol class="mcp-oauth-steps">
          <li>${t('system.conn.zohoStepOpen', 'Abrí la consola de autorización de Zoho:')}<br>
            <a class="mcp-oauth-link" href="${esc(j.authUrl)}" target="_blank" rel="noopener">${icon('externalLink', { size: 13 })} ${t('system.conn.openZoho', 'Abrir Zoho')}</a></li>
          <li>${t('system.conn.zohoStepGrant', 'Generá el grant code con tu cuenta.')}</li>
          <li>${t('system.conn.zohoStepPaste', 'Pegalo acá y envialo:')}<br>
            <input type="text" class="dlg-input" data-ref="code" placeholder="${esc(t('system.conn.grantPlaceholder', '1000.xxxxx…'))}">
            <button class="btn btn--sm" data-ref="send">${icon('check', { size: 12 })}<span>${t('system.conn.send', 'Enviar')}</span></button></li>
        </ol>
        <p class="hr-f-file" data-ref="msg"></p>`);
      const send = m.body.querySelector('[data-ref="send"]');
      const input = m.body.querySelector('[data-ref="code"]');
      const msg = m.body.querySelector('[data-ref="msg"]');
      send?.addEventListener('click', async () => {
        const value = input.value.trim();
        if (!value) return;
        send.disabled = true;
        if (msg) msg.textContent = t('system.conn.sending', 'Enviando…');
        try {
          const r = await fetch(`/api/connections/${encodeURIComponent(prov)}/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId, value }) });
          if (!r.ok) throw new Error((await r.json()).error || r.status);
          if (msg) msg.textContent = t('system.conn.sent', 'Código enviado. Esperando confirmación…');
        } catch (err) {
          if (msg) msg.textContent = t('system.conn.inlineError', 'Error: {error}', { error: err.message || err });
          send.disabled = false;
        }
      });
    };

    (async () => {
      try {
        const r = await fetch(`/api/connections/${encodeURIComponent(prov)}/connect`, { method: 'POST' });
        if (!r.ok) throw new Error((await r.json()).error || r.status);
        const j = await r.json();
        jobId = j.jobId;
        if (j.mode === 'device') renderDevice(j);
        else if (j.mode === 'paste') renderPaste(j);
        else throw new Error(t('system.conn.unknownMode', 'Modo de conexión desconocido.'));
        poll();
      } catch (err) {
        setBody(`<p class="hr-f-crit">${t('system.conn.startError', 'No se pudo iniciar: {error}', { error: esc(err.message || err) })}</p>`);
      }
    })();
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
      ${groups || `<p class="hr-summary">${t('system.mcps.noServers', 'No se encontraron servidores MCP.')}</p>`}
      <section class="conn-sec" data-ref="conn"></section>`;
    wire();
    loadConnections();
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
