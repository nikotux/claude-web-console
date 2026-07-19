// modules/system/env-vars-panel.js — panel "Variables de entorno" (pestaña
// del menú Sistema). UI de la capa de CONFIG DE INSTANCIA (identidad +
// cliente) que separa quién sos (email/GitHub/firma) y los datos del
// cliente/proyecto (MCP, departamentos Zoho, reviewer de referencia) del
// código — para que otra persona pueda correr su propia instancia sin
// heredar la identidad de Nico (PLAN-476/PEND-377). NUNCA muestra secretos
// (CWC_TOKEN, credenciales) — esos siguen en .env, fuera de este panel.
//
// Patrón: GET abierto a cualquier autenticado (solo lectura si no es admin),
// POST admin (mismo criterio que project-context-panel.js).
import { icon } from '../../ui/icons.js';
import { t } from '../../ui/i18n.js';
import { pacman } from '../../ui/pacman.js';

const API = '/api/env-vars';

export function mountEnvVarsPanel(el, ctx) {
  const { isAdmin } = ctx;
  let data = null;

  el.innerHTML = `<p class="ev-msg" data-ref="loading">${pacman({ size: 'sm' })} ${t('system.envVars.loading', 'Cargando…')}</p>`;

  async function load() {
    try {
      const r = await fetch(API, { cache: 'no-store' });
      data = await r.json();
      if (!r.ok) throw new Error(data?.error || t('system.envVars.loadError', 'Error al cargar.'));
      render();
    } catch (e) {
      el.innerHTML = `<p class="ev-msg ev-msg--err">${String(e.message || e)}</p>`;
    }
  }

  function depRows(deps) {
    return Object.entries(deps || {}).map(([k, v]) => `
      <div class="ev-row" data-dep-row>
        <input type="text" class="ev-inp ev-inp--k" value="${esc(k)}" placeholder="${t('system.envVars.depKeyPlaceholder', 'clave')}" ${isAdmin ? '' : 'disabled'} />
        <input type="text" class="ev-inp ev-inp--v" value="${esc(v)}" placeholder="${t('system.envVars.depIdPlaceholder', 'ID de departamento')}" ${isAdmin ? '' : 'disabled'} />
        ${isAdmin ? `<button class="btn-ghost btn--icon btn--sm" data-act="rmdep" title="${t('system.envVars.remove', 'Quitar')}">${icon('trash', { size: 13 })}</button>` : ''}
      </div>`).join('');
  }

  function render() {
    const { identity, client } = data;
    el.innerHTML = `
      <p class="ev-hint">
        ${t('system.envVars.hintBeforePath', 'Config propia de ESTA instalación — identidad (email/GitHub/firma) y datos del cliente/proyecto (MCP, departamentos Zoho). Vive en')} <code>~/.cwc-data/instance.json</code>,
        ${t('system.envVars.hintAfterPath', 'fuera del repo. Los')} <b>${t('system.envVars.secretsWord', 'secretos')}</b> ${t('system.envVars.hintSecrets', '(token, credenciales) NO están acá: siguen en')} <code>.env</code>.
      </p>

      <div class="ev-sec">
        <div class="ev-sec-title">🪪 ${t('system.envVars.identityTitle', 'Identidad')}</div>
        <label class="ev-field">${t('system.envVars.nameLabel', 'Nombre')}<input type="text" class="ev-inp" data-f="identity.name" value="${esc(identity.name)}" ${dis()} /></label>
        <label class="ev-field">${t('system.envVars.emailLabel', 'Email')}<input type="text" class="ev-inp" data-f="identity.email" value="${esc(identity.email)}" ${dis()} /></label>
        <label class="ev-field">${t('system.envVars.githubLabel', 'GitHub')}<input type="text" class="ev-inp" data-f="identity.github" value="${esc(identity.github)}" ${dis()} /></label>
        <label class="ev-field">${t('system.envVars.signatureLabel', 'Firma (para notas publicadas con identidad ajena, ej. Desk)')}<input type="text" class="ev-inp" data-f="identity.signature" value="${esc(identity.signature)}" ${dis()} /></label>
      </div>

      <div class="ev-sec">
        <div class="ev-sec-title">🏢 ${t('system.envVars.clientProjectTitle', 'Cliente / proyecto')}</div>
        <label class="ev-field">${t('system.envVars.mcpServerLabel', 'Nombre del server MCP (tickets/Desk)')}<input type="text" class="ev-inp" data-f="client.mcpServerId" value="${esc(client.mcpServerId)}" ${dis()} /></label>
        <label class="ev-field">${t('system.envVars.infisicalProjectLabel', 'ID de proyecto Infisical (si aplica)')}<input type="text" class="ev-inp" data-f="client.infisicalProjectId" value="${esc(client.infisicalProjectId || '')}" ${dis()} /></label>
        <div class="ev-sub">${t('system.envVars.reviewerTitle', 'Reviewer / contacto de referencia')}</div>
        <label class="ev-field">${t('system.envVars.nameLabel', 'Nombre')}<input type="text" class="ev-inp" data-f="client.reviewer.name" value="${esc(client.reviewer?.name || '')}" ${dis()} /></label>
        <label class="ev-field">${t('system.envVars.githubLabel', 'GitHub')}<input type="text" class="ev-inp" data-f="client.reviewer.github" value="${esc(client.reviewer?.github || '')}" ${dis()} /></label>
        <div class="ev-sub">${t('system.envVars.zohoDepartmentsTitle', 'Departamentos de Zoho Desk (clave → ID)')}</div>
        <div data-ref="deps">${depRows(client.zohoDepartments)}</div>
        ${isAdmin ? `<button class="btn-ghost btn--sm" data-act="adddep">+ ${t('system.envVars.addDepartment', 'Agregar departamento')}</button>` : ''}
      </div>

      ${isAdmin ? `
        <div class="ev-actions">
          <button class="btn" data-ref="save">${icon('check', { size: 14 })}<span>${t('system.envVars.save', 'Guardar')}</span></button>
          <span class="ev-msg" data-ref="msg" hidden></span>
        </div>` : ''}
    `;

    if (!isAdmin) return;

    el.querySelector('[data-act="adddep"]')?.addEventListener('click', () => {
      const wrap = el.querySelector('[data-ref="deps"]');
      wrap.insertAdjacentHTML('beforeend', depRows({ '': '' }));
      wireDepRemovers();
    });
    wireDepRemovers();

    el.querySelector('[data-ref="save"]').addEventListener('click', save);
  }

  function wireDepRemovers() {
    el.querySelectorAll('[data-act="rmdep"]').forEach((b) => {
      b.onclick = () => b.closest('[data-dep-row]')?.remove();
    });
  }

  function dis() { return isAdmin ? '' : 'disabled'; }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function val(sel) { return el.querySelector(sel)?.value?.trim() || ''; }

  async function save() {
    const msg = el.querySelector('[data-ref="msg"]');
    const zohoDepartments = {};
    el.querySelectorAll('[data-dep-row]').forEach((row) => {
      const k = row.querySelector('.ev-inp--k')?.value?.trim();
      const v = row.querySelector('.ev-inp--v')?.value?.trim();
      if (k) zohoDepartments[k] = v || '';
    });
    const patch = {
      identity: {
        name: val('[data-f="identity.name"]'),
        email: val('[data-f="identity.email"]'),
        github: val('[data-f="identity.github"]'),
        signature: val('[data-f="identity.signature"]'),
      },
      client: {
        mcpServerId: val('[data-f="client.mcpServerId"]'),
        infisicalProjectId: val('[data-f="client.infisicalProjectId"]'),
        reviewer: {
          name: val('[data-f="client.reviewer.name"]'),
          github: val('[data-f="client.reviewer.github"]'),
        },
        zohoDepartments,
      },
    };
    msg.hidden = false;
    msg.textContent = t('system.envVars.saving', 'Guardando…');
    msg.className = 'ev-msg';
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || t('system.envVars.saveError', 'Error al guardar.'));
      data = { identity: j.identity, client: j.client };
      msg.textContent = j.needsRestart
        ? `✅ ${t('system.envVars.savedRestart', 'Guardado. Reiniciá el servicio para que algunos motores tomen el cambio.')}`
        : `✅ ${t('system.envVars.saved', 'Guardado.')}`;
      msg.className = 'ev-msg ev-msg--ok';
    } catch (e) {
      msg.textContent = String(e.message || e);
      msg.className = 'ev-msg ev-msg--err';
    }
  }

  load();
}
