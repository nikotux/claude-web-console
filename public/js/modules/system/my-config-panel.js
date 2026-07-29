// modules/system/my-config-panel.js — checklist personal de capacidades y
// provisioning. Nace plegado y deriva el detalle del catálogo del backend.
import { icon } from '../../ui/icons.js';
import { helpBtn } from '../../ui/help.js';
import { t } from '../../ui/i18n.js';

const API = '/api/onboard/my-config';
const PROVISION_STEPS = ['pad', 'workspace', 'skills', 'tolkien-mcp'];
const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]
));

function capabilityLabel(capability) {
  const labels = {
    claude: t('system.myconfig.capability.claude', 'Credencial de Claude'),
    account: t('system.myconfig.capability.account', 'Cuenta Claude completa'),
    codex: t('system.myconfig.capability.codex', 'Codex'),
    infisical: t('system.myconfig.capability.infisical', 'Infisical'),
    github: t('system.myconfig.capability.github', 'GitHub'),
  };
  return labels[capability.id]
    || t('system.myconfig.capability.unknown', 'Capacidad');
}

function provisionLabel(step) {
  const labels = {
    pad: t('system.myconfig.provision.pad', 'Pad personal'),
    workspace: t('system.myconfig.provision.workspace', 'Workspace'),
    skills: t('system.myconfig.provision.skills', 'Skills iniciales'),
    'tolkien-mcp': t('system.myconfig.provision.tolkienMcp', 'Tolkien MCP'),
  };
  return labels[step] || t('system.myconfig.provision.unknown', 'Paso de provisioning');
}

function statusMeta(status) {
  if (status === 'ok') {
    return {
      iconName: 'check',
      rowClass: 'hr-finding--linked',
      badgeClass: 'hr-sev--linked',
      label: t('system.myconfig.status.ready', 'Listo'),
    };
  }
  if (status === 'failed') {
    return {
      iconName: 'close',
      rowClass: 'hr-finding--high',
      badgeClass: 'hr-sev--high',
      label: t('system.myconfig.status.failed', 'Falló'),
    };
  }
  if (status === 'pending') {
    return {
      iconName: 'clock',
      rowClass: 'hr-finding--orphan',
      badgeClass: 'hr-sev--orphan',
      label: t('system.myconfig.status.pending', 'Pendiente'),
    };
  }
  return {
    iconName: 'clock',
    rowClass: 'hr-finding--low',
    badgeClass: 'hr-sev--low',
    label: t('system.myconfig.status.notStarted', 'Sin iniciar'),
  };
}

function capabilityRows(capabilities) {
  return capabilities.map((capability) => {
    const complete = !!capability.complete;
    const meta = statusMeta(complete ? 'ok' : 'pending');
    const requirement = capability.required
      ? t('system.myconfig.required', 'Obligatoria')
      : t('system.myconfig.optional', 'Opcional');
    return `
      <div class="hr-finding ${meta.rowClass}">
        <div class="hr-f-head">
          <span class="hr-sev ${meta.badgeClass}">
            ${icon(meta.iconName, { size: 12 })}
            <span>${complete ? t('system.myconfig.connected', 'Conectada') : meta.label}</span>
          </span>
          <span class="hr-f-area">${esc(capabilityLabel(capability))}</span>
          <span class="hr-f-mod">${requirement}</span>
          ${complete ? '' : `
            <button class="btn btn--sm" data-connect="${esc(capability.id)}">
              ${icon('externalLink', { size: 13 })}
              <span>${t('system.myconfig.connect', 'Conectar')}</span>
            </button>`}
        </div>
      </div>`;
  }).join('');
}

function provisionRows(provisioning) {
  const steps = provisioning?.steps || {};
  return PROVISION_STEPS.map((step) => {
    const state = steps[step] || { status: 'idle' };
    const meta = statusMeta(state.status);
    return `
      <div class="hr-finding ${meta.rowClass}">
        <div class="hr-f-head">
          <span class="hr-sev ${meta.badgeClass}">
            ${icon(meta.iconName, { size: 12 })}
            <span>${meta.label}</span>
          </span>
          <span class="hr-f-area">${esc(provisionLabel(step))}</span>
        </div>
        ${state.error ? `<p class="hr-f-detail">${esc(state.error)}</p>` : ''}
      </div>`;
  }).join('');
}

export function mountMyConfigPanel(el, ctx) {
  let data = null;
  let busy = false;

  el.innerHTML = `
    <div class="hp-opt">
      <details class="hp-opt-card" data-ref="panel">
        <summary class="hp-opt-head">
          ${icon('checklist', { size: 15 })}
          <strong>${t('system.myconfig.title', 'Mi configuración')}</strong>
          <span class="hp-opt-snippet" data-ref="summary">${t('system.myconfig.loading', 'cargando…')}</span>
          <span class="hr-sev hr-sev--low" data-ref="overall">${t('system.myconfig.status.loading', 'Cargando')}</span>
          ${helpBtn('sys-my-config')}
        </summary>
        <div class="hp-opt-body" data-ref="body">
          <p class="ev-hint">${t('system.myconfig.loading', 'cargando…')}</p>
        </div>
      </details>
    </div>`;

  const summary = el.querySelector('[data-ref="summary"]');
  const overall = el.querySelector('[data-ref="overall"]');
  const body = el.querySelector('[data-ref="body"]');

  function paint() {
    if (!data) return;
    const capabilities = data.capabilities || [];
    const complete = capabilities.filter((capability) => capability.complete).length;
    const provisionStatus = data.provisioning?.status || 'idle';
    const needsAttention = (data.blocking || []).length > 0 || provisionStatus !== 'ok';
    const overallMeta = statusMeta(needsAttention ? 'pending' : 'ok');
    const provisionMeta = statusMeta(provisionStatus);

    summary.textContent = t(
      'system.myconfig.summary',
      '{complete}/{total} capacidades · provisioning {provision}',
      {
        complete,
        total: capabilities.length,
        provision: provisionMeta.label.toLocaleLowerCase(),
      },
    );
    overall.className = `hr-sev ${overallMeta.badgeClass}`;
    overall.textContent = needsAttention
      ? t('system.myconfig.status.attention', 'Requiere atención')
      : t('system.myconfig.status.complete', 'Completa');

    body.innerHTML = `
      <p class="ev-hint">${t('system.myconfig.intro', 'Este estado pertenece solo a tu cuenta. Las capacidades se detectan en vivo y el provisioning se lee de su estado persistido.')}</p>
      <details class="hp-opt-group">
        <summary>${icon('checklist', { size: 13 })} ${t('system.myconfig.capabilitiesTitle', 'Capacidades')} · ${complete}/${capabilities.length}</summary>
        <div class="hr-findings">
          ${capabilityRows(capabilities)}
        </div>
      </details>
      <details class="hp-opt-group">
        <summary>${icon('gear', { size: 13 })} ${t('system.myconfig.provisioningTitle', 'Provisioning')} · ${esc(statusMeta(provisionStatus).label)}</summary>
        <p class="hr-f-detail">${t('system.myconfig.provisioningHint', 'Estos pasos preparan tu Pad, workspace, skills y Tolkien MCP. Reintentar es idempotente y no consume tokens.')}</p>
        <div class="hr-findings">
          ${provisionRows(data.provisioning)}
        </div>
        <div class="hr-f-actions">
          <button class="btn btn--sm" data-action="retry" ${busy ? 'disabled' : ''}>
            ${icon('refresh', { size: 13 })}
            <span>${busy ? t('system.myconfig.retrying', 'Reintentando…') : t('system.myconfig.retry', 'Reintentar')}</span>
          </button>
        </div>
      </details>
      <p class="ev-msg" data-ref="message" hidden></p>`;

    body.querySelectorAll('[data-connect]').forEach((button) => {
      button.addEventListener('click', () => openOnboarding());
    });
    body.querySelector('[data-action="retry"]')?.addEventListener('click', retryProvisioning);
  }

  function message(text, kind = '') {
    const target = body.querySelector('[data-ref="message"]');
    if (!target) return;
    target.className = `ev-msg${kind ? ` ev-msg--${kind}` : ''}`;
    target.textContent = text;
    target.hidden = !text;
  }

  async function openOnboarding() {
    const ok = await ctx.dialog.confirmDialog({
      title: t('system.myconfig.inviteTitle', 'Conectar una capacidad'),
      message: t('system.myconfig.inviteMessage', 'El asistente público te va a pedir el token de invitación y verificará que habilite tu cuenta. Si no conservás uno, pedile una invitación al administrador.'),
      confirmLabel: t('system.myconfig.haveInvite', 'Tengo una invitación'),
    });
    if (ok) window.location.href = '/onboard';
  }

  async function retryProvisioning() {
    if (busy) return;
    busy = true;
    paint();
    try {
      const response = await fetch(`${API}/retry`, { method: 'POST' });
      const next = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error('retry');
      data = next;
      busy = false;
      paint();
      message(t('system.myconfig.retryStarted', 'Provisioning relanzado. Los pasos se actualizarán cuando vuelvas a abrir el panel.'), 'ok');
    } catch {
      busy = false;
      paint();
      message(t('system.myconfig.retryError', 'No se pudo reintentar el provisioning.'), 'err');
    }
  }

  async function load() {
    try {
      const response = await fetch(API);
      const next = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error('load');
      data = next;
      paint();
    } catch {
      summary.textContent = t('system.myconfig.loadErrorSummary', 'No se pudo leer el estado');
      overall.className = 'hr-sev hr-sev--high';
      overall.textContent = t('system.myconfig.status.error', 'Error');
      body.innerHTML = `<p class="ev-msg ev-msg--err">${t('system.myconfig.loadError', 'No se pudo cargar tu configuración.')}</p>`;
    }
  }

  void load();
}
