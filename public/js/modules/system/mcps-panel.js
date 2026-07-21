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
const LIGHT_DOT = { ok: '🟢', warn: '🟡', info: '🔵', danger: '🔴', neutral: '⚪' };
// Vocabulario ÚNICO de estados para TODA conexión (servidores MCP y cuentas).
// Misma palabra, mismo color y mismo tipo de acción en todo el panel.
const CONN_STATE = {
  connected: { light: 'ok', tagKey: 'system.conn.tagOk', tagEs: 'conectado' },
  inprogress: { light: 'info', tagKey: 'system.conn.tagRunning', tagEs: 'en curso' },
  action: { light: 'warn', tagKey: 'system.conn.tagAction', tagEs: 'requiere tu acción' },
  unset: { light: 'neutral', tagKey: 'system.conn.tagUnset', tagEs: 'sin configurar' },
  error: { light: 'danger', tagKey: 'system.conn.tagError', tagEs: 'error' },
};
// Estado unificado de un servidor MCP (a partir del code de classifyStatus).
function mcpState(s) {
  const c = s?.status?.code;
  if (c === 'connected') return 'connected';
  if (c === 'pending') return 'inprogress';
  if (c === 'needs-auth') return 'action';
  if (c === 'error') return 'error';
  return 'unset';
}
// Estado unificado de una cuenta conectada.
function acctState(p) {
  if (p.error) return 'error';
  if (p.connected) return 'connected';
  if (!p.configured) return 'unset';
  if (p.lastAttempt && (p.lastAttempt.error || p.lastAttempt.status === 'error')) return 'error';
  if (p.lastAttempt && p.lastAttempt.status !== 'connected') return 'inprogress';
  return 'action';
}
// "hace X" legible, para reforzar que un trámite está en curso.
function agoText(ts) {
  if (!ts) return '';
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return t('system.conn.agoMin', 'hace {n} min', { n: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return t('system.conn.agoHour', 'hace {n} h', { n: hrs });
  return t('system.conn.agoDay', 'hace {n} d', { n: Math.round(hrs / 24) });
}
const PROVIDER_META = {
  microsoft: { emoji: '📅', purposeKey: 'system.conn.purposeMicrosoft', purposeEs: 'Tu calendario: la consola lee tus eventos con TU cuenta, no con la de otro.' },
  zoho: { emoji: '🎫', purposeKey: 'system.conn.purposeZoho', purposeEs: 'Zoho Desk: que tus comentarios en los tickets salgan a TU nombre.' },
};
const SETUP_META = {
  microsoft: {
    url: 'https://portal.azure.com',
    linkKey: 'system.conn.openAzure', linkEs: 'Abrir Azure Portal',
    steps: [
      ['system.conn.msStep1', 'Entrá a Azure Portal → Microsoft Entra ID → App registrations → New registration.'],
      ['system.conn.msStep2', 'Ponele un nombre (ej. "Mi Consola") y registrala.'],
      ['system.conn.msStep3', '⚠️ En Authentication activá "Allow public client flows" = Yes. Sin esto el código de dispositivo NO funciona.'],
      ['system.conn.msStep4', 'En API permissions → Microsoft Graph → Delegated agregá: Calendars.ReadWrite, User.Read y offline_access.'],
      ['system.conn.msStep5', 'Copiá el Application (client) ID y el Directory (tenant) ID y pegalos acá abajo.'],
    ],
    fields: [
      { k: 'clientId', labelKey: 'system.conn.fClientId', labelEs: 'Client ID' },
      { k: 'tenantId', labelKey: 'system.conn.fTenantId', labelEs: 'Tenant ID', placeholder: 'common' },
    ],
  },
  zoho: {
    url: 'https://api-console.zoho.com',
    linkKey: 'system.conn.openZohoConsole', linkEs: 'Abrir Zoho API Console',
    steps: [
      ['system.conn.zhStep1', 'Entrá a la Zoho API Console → Add Client → Self Client.'],
      ['system.conn.zhStep2', 'Copiá el Client ID y el Client Secret y pegalos acá abajo.'],
      ['system.conn.zhStep3', 'Elegí tu data center (com, eu, in…): el mismo dominio por el que entrás a Zoho.'],
      ['system.conn.zhStep4', 'Al conectar te vamos a pedir un grant code con los scopes de Desk.'],
    ],
    fields: [
      { k: 'clientId', labelKey: 'system.conn.fClientId', labelEs: 'Client ID' },
      { k: 'clientSecret', labelKey: 'system.conn.fClientSecret', labelEs: 'Client Secret', type: 'password' },
      { k: 'dc', labelKey: 'system.conn.fDc', labelEs: 'Data center', placeholder: 'com' },
    ],
  },
};

// Borde de la tarjeta según severidad de conexión (reusa la escala visual de
// health-review: verde ok / ámbar warn / rojo danger / gris neutro).
function cardClass(s) {
  return { ok: 'hr-finding--linked', warn: 'hr-finding--orphan', info: 'hr-finding--running', danger: 'hr-finding--high', neutral: 'hr-finding--low' }[s.status.light] || 'hr-finding--low';
}

function serverCard(world, s, i) {
  const collapsed = i > 0 ? ' hr-collapsed' : '';
  const uKey = mcpState(s);
  const uTag = t(CONN_STATE[uKey].tagKey, CONN_STATE[uKey].tagEs);
  const dot = LIGHT_DOT[CONN_STATE[uKey].light] || '⚪';
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
        <span class="hr-f-mod">${esc(uTag)} · ${esc(s.transport)} · ${esc(s.scopeLabel)}</span>
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
  let connAdmin = false;
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
    const key = acctState(p);
    const light = CONN_STATE[key].light;
    if (key === 'error') return { key, light, label: t('system.conn.stError', 'Error: {e}', { e: p.error || p.lastAttempt?.error || '' }) };
    if (key === 'connected') return { key, light, label: t('system.conn.stConnected', 'Conectado como {acct}', { acct: p.account || '—' }) };
    if (key === 'unset') return { key, light, label: t('system.conn.stUnconfigured', 'No configurado — falta que un admin cargue las credenciales de la app.') };
    if (key === 'inprogress') return { key, light, label: t('system.conn.stRunning', 'Conexión en curso · esperando autorización') };
    return { key, light, label: t('system.conn.stDisconnected', 'Sin conectar — conectá tu cuenta para usarlo.') };
  }

  function connTag(p) {
    const k = acctState(p);
    return t(CONN_STATE[k].tagKey, CONN_STATE[k].tagEs);
  }

  function connCard(p, i) {
    const st = connStatus(p);
    const dot = LIGHT_DOT[st.light] || '⚪';
    const meta = PROVIDER_META[p.id] || { emoji: '🔗', purposeKey: 'system.conn.purposeGeneric', purposeEs: 'Cuenta personal conectada a la consola.' };
    const connectedAt = p.connectedAt ? `<div class="hr-f-file">🕑 ${esc(new Date(p.connectedAt).toLocaleString())}</div>` : '';
    const scopes = p.scopes?.length ? `<div class="hr-f-file">🔑 <code>${esc(p.scopes.join(' '))}</code></div>` : '';
    const stKey = st.key || acctState(p);
    const acts = [];
    if (stKey === 'connected') {
      acts.push(`<button class="btn-ghost btn--sm" data-cact="disconnect" data-prov="${esc(p.id)}">${t('system.conn.disconnect', 'Desconectar')}</button>`);
    } else if (stKey === 'inprogress') {
      acts.push(`<button class="btn btn--sm" data-cact="connect" data-prov="${esc(p.id)}">${icon('refresh', { size: 12 })}<span>${t('system.conn.verifyBtn', 'Verificar de nuevo')}</span></button>`);
      acts.push(`<button class="btn-ghost btn--sm" data-cact="cancel" data-prov="${esc(p.id)}">${t('system.conn.cancelBtn', 'Cancelar intento')}</button>`);
    } else if (stKey === 'error') {
      acts.push(`<button class="btn btn--sm" data-cact="connect" data-prov="${esc(p.id)}">${icon('refresh', { size: 12 })}<span>${t('system.conn.retryBtn', 'Reintentar')}</span></button>`);
    } else {
      acts.push(`<button class="btn btn--sm" data-cact="connect" data-prov="${esc(p.id)}">${icon('externalLink', { size: 12 })}<span>${t('system.conn.connectBtn', 'Conectar')}</span></button>`);
    }
    const actions = `<div class="mcp-acts">${acts.join('')}</div>`;
    const attemptNote = stKey === 'inprogress' ? `
          <div class="hr-f-file">ℹ️ ${t('system.conn.runningHint', 'Ya iniciaste la conexión. Si te pidió aprobación de un administrador, se completa cuando te aprueben — puede tardar. No hay nada roto de tu lado.')}</div>
          ${p.lastAttempt?.at ? `<div class="hr-f-file">🕓 ${t('system.conn.startedAgo', 'Iniciada {ago}', { ago: agoText(p.lastAttempt.at) })}</div>` : ''}` : '';

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
          ${attemptNote}
          ${actions}
        </div>
      </div>`;
  }

  function connTitle() {
    return `<h3 class="conn-h">🔗 ${t('system.conn.title', 'Cuentas conectadas')}</h3>`;
  }

  function renderConnections(d) {
    connAdmin = !!d.isAdmin;
    const providers = d.providers || [];
    const cards = providers.length
      ? providers.map((p, i) => connCard(p, i)).join('')
      : `<p class="hr-summary">${t('system.conn.empty', 'No hay proveedores de cuentas configurados.')}</p>`;
    const host = root.querySelector('[data-ref="conn"]');
    if (!host) return;
    host.innerHTML = `
      ${connTitle()}
      <p class="pj-hint">${t('system.conn.hint', 'Tus cuentas personales. Cada persona conecta las suyas: la consola actúa con TU identidad, no con la de otro.')}</p>
      <div class="hr-findings">${cards}</div>`;
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
        openConnect(prov, label, provider);
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
      } else if (b.dataset.cact === 'cancel') {
        const ok = await (dialog.confirmSheet || dialog.confirmDialog)?.({
          title: t('system.conn.cancelTitle', 'Cancelar intento'),
          message: t('system.conn.cancelMsg', '¿Descartar el intento de conexión de "{label}"? No pierde nada configurado: podés volver a conectar cuando quieras.', { label }),
        });
        if (!ok) return;
        try {
          const r = await fetch(`/api/connections/${encodeURIComponent(prov)}/cancel`, { method: 'POST' });
          if (!r.ok) throw new Error((await r.json()).error || r.status);
          loadConnections();
        } catch (err) {
          dialog.alertDialog?.({ title: t('system.mcps.errorTitle', 'Error'), message: String(err.message || err) });
        }
      }
    }));
  }

  function openConnect(prov, label, p) {
    const m = dialog.openModal({ title: t('system.conn.connectTitle', 'Conectar · {label}', { label }), width: 560 });
    let timer = null;
    let jobId = null;
    let phase = '';
    const mo = new MutationObserver(() => { if (!m.body.isConnected) { if (timer) clearInterval(timer); mo.disconnect(); } });
    mo.observe(document.body, { childList: true, subtree: true });

    const setBody = (html) => { m.body.innerHTML = `<div class="mcp-oauth">${html}</div>`; };

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
          ${j.scopes ? `<li>${t('system.conn.zohoStepScopes', 'Cuando te pida los scopes, pegá exactamente esto:')}<br>
            <code class="conn-scopes">${esc(j.scopes)}</code>
            <button class="btn-ghost btn--sm" data-ref="copyscopes">${t('system.conn.copyScopes', 'Copiar scopes')}</button></li>` : ''}
          <li>${t('system.conn.zohoStepPaste', 'Pegalo acá y envialo:')}<br>
            <input type="text" class="dlg-input" data-ref="code" placeholder="${esc(t('system.conn.grantPlaceholder', '1000.xxxxx…'))}">
            <button class="btn btn--sm" data-ref="send">${icon('check', { size: 12 })}<span>${t('system.conn.send', 'Enviar')}</span></button></li>
        </ol>
        <p class="hr-f-file" data-ref="msg"></p>`);
      const send = m.body.querySelector('[data-ref="send"]');
      const input = m.body.querySelector('[data-ref="code"]');
      const msg = m.body.querySelector('[data-ref="msg"]');
      m.body.querySelector('[data-ref="copyscopes"]')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(j.scopes);
          if (msg) msg.textContent = t('system.conn.scopesCopied', 'Scopes copiados.');
        } catch {
          if (msg) msg.textContent = t('system.conn.copyScopesFallback', 'No se pudo copiar automáticamente. Scopes: {scopes}', { scopes: j.scopes });
        }
      });
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

    const startConnect = async () => {
      setBody(`${pacman({ state: 'delegating', size: 'sm' })} ${t('system.conn.starting', 'Iniciando conexión…')}`);
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
    };

    // PASO 1 (solo admin, solo si la app no está configurada): instructivo +
    // credenciales de la app. Al guardar, sigue derecho al flujo de conexión.
    const renderSetup = async () => {
      const meta = SETUP_META[prov];
      if (!meta) { setBody(`<p class="hr-f-crit">${t('system.conn.noSetup', 'Este proveedor no tiene instructivo de configuración.')}</p>`); return; }
      let app = {};
      try { const r = await fetch('/api/connections/app'); if (r.ok) app = await r.json(); } catch { /* best effort */ }
      const cur = app[prov] || {};
      const fields = meta.fields.map((f) => `
        <label class="conn-flabel">${t(f.labelKey, f.labelEs)}</label>
        <input class="dlg-input" data-f="${esc(f.k)}"${f.type ? ` type="${esc(f.type)}"` : ''} placeholder="${esc(f.placeholder || '')}">`).join('');
      setBody(`
        <p class="mcp-oauth-wait">${pacman({ state: 'waiting', size: 'sm' })} <b>${t('system.conn.setupTitle', 'Paso 1 — registrar la app')}</b></p>
        <p class="hr-f-file">${t('system.conn.setupHint', 'Esto se hace UNA sola vez para toda la consola. Después cada persona conecta su propia cuenta.')}</p>
        <ol class="mcp-oauth-steps">${meta.steps.map(([k, es]) => `<li>${t(k, es)}</li>`).join('')}</ol>
        <a class="mcp-oauth-link" href="${esc(meta.url)}" target="_blank" rel="noopener">${icon('externalLink', { size: 13 })} ${t(meta.linkKey, meta.linkEs)}</a>
        <div class="conn-appform">${fields}</div>
        <div class="mcp-acts"><button class="btn btn--sm" data-ref="saveapp">${t('system.conn.saveAndContinue', 'Guardar y continuar')}</button></div>
        <p class="hr-f-file" data-ref="msg"></p>`);
      meta.fields.forEach((f) => {
        const input = m.body.querySelector(`[data-f="${f.k}"]`);
        if (!input) return;
        if (f.k === 'clientSecret') { if (cur.hasSecret) input.placeholder = t('system.conn.secretSavedPlaceholder', '•••• (guardado)'); return; }
        if (cur[f.k]) input.value = cur[f.k];
      });
      const btn = m.body.querySelector('[data-ref="saveapp"]');
      const msg = m.body.querySelector('[data-ref="msg"]');
      btn?.addEventListener('click', async () => {
        const body = { provider: prov };
        m.body.querySelectorAll('[data-f]').forEach((input) => { const v = input.value.trim(); if (v) body[input.dataset.f] = v; });
        btn.disabled = true;
        if (msg) msg.textContent = t('system.conn.saving', 'Guardando…');
        try {
          const r = await fetch('/api/connections/app', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          if (!r.ok) throw new Error((await r.json()).error || r.status);
          loadConnections();
          startConnect();
        } catch (err) {
          if (msg) msg.textContent = t('system.conn.inlineError', 'Error: {error}', { error: err.message || err });
          btn.disabled = false;
        }
      });
    };

    if (p && p.configured) startConnect();
    else if (connAdmin) renderSetup();
    else setBody(`<p class="hr-f-file">⚪ ${t('system.conn.needsAdminModal', 'Falta que un administrador cargue las credenciales de la app de este proveedor. Pedíselo y volvé a intentar.')}</p>`);
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
      // Las cuentas personales viven DENTRO de 🏠 Mi Consola: son conexiones de
      // la consola (no de Tolkien), así que se listan junto a sus MCP.
      const connHost = w.world === 'console' ? '<div class="conn-inline" data-ref="conn"></div>' : '';
      return `<details class="hr-collapsible" open>
        <summary>${esc(w.label)} <span class="hr-f-mod">${esc(w.cwd)}</span> (${w.servers.length})</summary>
        ${warn}
        <div class="hr-findings">${cards}</div>
        ${connHost}
      </details>`;
    }).join('');

    root.innerHTML = `
      <p class="pj-hint">${t('system.mcps.hintBeforeCommand', 'Servidores MCP de Claude Code por mundo, con estado en vivo. Estado vía')} <code>claude mcp list</code> — ${t('system.mcps.zeroTokens', '0 tokens')}.</p>
      ${globalActs}
      ${groups || `<p class="hr-summary">${t('system.mcps.noServers', 'No se encontraron servidores MCP.')}</p>`}
      ${(d.worlds || []).some((w) => w.world === 'console') ? '' : '<section class="conn-sec" data-ref="conn"></section>'}`;
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
