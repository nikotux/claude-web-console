// modules/system/users.js — panel de usuarios (pestaña del menú Sistema).
//
// Misma lógica CRUD contra /api/admin/*, con diálogos propios. Lo usa tanto
// la pestaña "Usuarios" del modal Sistema como la página /admin (admin.js).
import { icon } from '../../ui/icons.js';
import { helpBtn } from '../../ui/help.js';
import { alertDialog, confirmDialog, openModal, promptDialog } from '../../ui/dialog.js';
import { t } from '../../ui/i18n.js';

const API = '/api/admin';
const SPONSORSHIP_API = '/api/sponsorship/admin';
const CONNECTION_PROVIDERS = [
  // El proveedor de tickets sigue existiendo en el backend y el panel personal a propósito; solo desaparece de esta vista para sponsors.
  { id: 'microsoft', labelKey: 'system.users.microsoft', labelEs: 'Microsoft', emoji: '📅' },
  { id: 'zoho', labelKey: 'system.users.zoho', labelEs: 'Zoho', emoji: '🎫' },
];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `Error ${res.status}`);
  }
  return res.json();
}

async function sponsorshipApi(path, opts) {
  const res = await fetch(SPONSORSHIP_API + path, opts);
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `Error ${res.status}`);
  }
  return res.json();
}

export function mountUsersPanel(el) {
  el.innerHTML = `
    <div class="hp-head">
      <span class="hp-title">${t('system.help.users.title', 'Usuarios')}</span>
      ${helpBtn('sys-users')}
    </div>
    <form class="users-new" data-ref="form">
      <input data-ref="user" placeholder="${t('system.users.usernamePlaceholder', 'Usuario')}" autocapitalize="off" autocorrect="off" spellcheck="false" />
      <input data-ref="pass" type="password" placeholder="${t('system.users.passwordPlaceholder', 'Contraseña')}" />
      <label class="users-chk"><input data-ref="admin" type="checkbox" /> ${t('system.users.adminLabel', 'admin')}</label>
      <button type="submit" class="btn btn--sm">${t('system.users.create', 'Crear')}</button>
    </form>
    <p class="bk-msg" data-ref="msg" hidden></p>
    <div class="users-list" data-ref="list">
      <details class="users-sec" data-ref="adminssec">
        <summary><span>🛠️ ${t('system.users.administratorsTitle', 'Administradores')}</span><span class="users-sec-count" data-ref="adminscount">0</span></summary>
        <div data-ref="adminslist"></div>
      </details>
      <details class="users-sec users-sec--accent" data-ref="accesssec" open>
        <summary><span>🎫 ${t('system.users.accessSponsorshipTitle', 'Accesos y patrocinios')}</span></summary>
        <section class="users-sub">
          <h4 class="users-sub-h">${t('system.users.generateInviteTitle', 'Generar invitación')}</h4>
          <p class="users-invite-hint">${t('system.users.accessInvitesHintBeforePath', 'Generá un token de un solo uso. La persona lo usa en')} <code>/onboard</code> ${t('system.users.accessInvitesHintAfterPath', 'para crear su cuenta y conectar su propia cuenta de Claude. Vence en 24 h.')}</p>
          <form class="users-new" data-ref="invform">
            <label class="users-chk"><input data-ref="invadmin" type="checkbox" /> ${t('system.users.adminLabel', 'admin')}</label>
            <label class="users-chk"><input data-ref="invsponsored" type="checkbox" /> ${t('system.users.sponsoredLabel', 'patrocinado')}</label>
            <label class="users-chk users-invite-sponsor" data-ref="invsponsorwrap" hidden>
              <span>${t('system.users.inviteSponsor', 'Sponsor previsto')}</span>
              <select class="dlg-input users-select" data-ref="invsponsor" disabled></select>
            </label>
            <span class="bk-empty users-inline-empty" data-ref="invsponsornone" hidden>${t('system.users.noSponsorAvailable', 'no hay sponsor disponible')}</span>
            <button type="submit" class="btn btn--sm">${t('system.users.generateInvite', 'Generar invitación')}</button>
          </form>
          <div class="users-invite-token" data-ref="invtoken" hidden></div>
        </section>
        <section class="users-sub">
          <h4 class="users-sub-h">${t('system.users.pendingInvitesTitle', 'Invitaciones pendientes')}</h4>
          <div class="users-list" data-ref="invlist"></div>
        </section>
        <section class="users-sub">
          <h4 class="users-sub-h">🤝 ${t('system.users.sponsoredUsersTitle', 'Patrocinados')}</h4>
          <div class="users-cards" data-ref="sponsoredlist"></div>
        </section>
      </details>
      <details class="users-sec" data-ref="otherssec">
        <summary><span>👥 ${t('system.users.otherUsersTitle', 'Otros usuarios')}</span><span class="users-sec-count" data-ref="otherscount">0</span></summary>
        <div data-ref="otherslist"></div>
      </details>
    </div>`;

  const refs = {};
  for (const r of el.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;

  let host = null;
  let sponsorshipOverview = [];
  let usersSnapshot = [];
  let renderVersion = 0;
  const hostReady = fetch('/api/whoami', { cache: 'no-store' })
    .then((res) => res.ok ? res.json() : null)
    .then((me) => {
      host = me?.host || null;
    })
    .catch(() => {});

  async function onboardApi(path, opts) {
    const res = await fetch('/api/onboard' + path, opts);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `Error ${res.status}`);
    }
    return res.json();
  }

  function msg(text, ok = false) {
    refs.msg.textContent = text;
    refs.msg.hidden = !text;
    refs.msg.className = `bk-msg ${ok ? 'ok' : 'err'}`;
  }

  async function load() {
    try {
      const [{ users }, sponsorship] = await Promise.all([
        api('/users'),
        sponsorshipApi('/overview').catch((error) => ({ error })),
      ]);
      if (sponsorship?.error) {
        sponsorshipOverview = [];
      } else {
        sponsorshipOverview = Array.isArray(sponsorship?.users)
          ? sponsorship.users
          : Array.isArray(sponsorship?.overview) ? sponsorship.overview : [];
      }
      await hostReady;
      usersSnapshot = users;
      syncInviteSponsors();
      render(users);
      return users;
    } catch (e) {
      msg(e.message);
      return null;
    }
  }

  const sponsorNameOf = (item) => typeof item?.sponsor === 'string'
    ? item.sponsor
    : item?.sponsor?.username || '';

  function sponsorCandidatesFor(username = '') {
    return sponsorshipOverview.filter((item) => item.canSponsor === true && item.username !== username);
  }

  function syncInviteSponsors() {
    const candidates = sponsorCandidatesFor();
    const selected = refs.invsponsor.value;
    refs.invsponsor.innerHTML = `<option value="">${t('system.users.inviteWithoutSponsor', 'sin sponsor (lo adopta alguien después)')}</option>`;
    for (const candidate of candidates) {
      const option = document.createElement('option');
      option.value = candidate.username;
      option.textContent = candidate.username;
      refs.invsponsor.append(option);
    }
    if ([...refs.invsponsor.options].some((option) => option.value === selected)) refs.invsponsor.value = selected;
    const sponsored = refs.invsponsored.checked;
    refs.invsponsorwrap.hidden = !sponsored || !candidates.length;
    refs.invsponsor.disabled = !sponsored || !candidates.length;
    refs.invsponsornone.hidden = !sponsored || !!candidates.length;
    if (!sponsored) refs.invsponsor.value = '';
  }

  function render(users) {
    const version = ++renderVersion;
    const sponsorshipByUser = new Map(sponsorshipOverview.map((item) => [item.username, item]));
    const admins = users.filter((user) => user.admin);
    const sponsored = users.filter((user) => !user.admin && ['sponsored', 'awaiting-sponsor'].includes(sponsorshipByUser.get(user.username)?.sponsorshipState));
    const sponsoredNames = new Set(sponsored.map((user) => user.username));
    const others = users.filter((user) => !user.admin && !sponsoredNames.has(user.username));

    refs.adminscount.textContent = admins.length;
    refs.otherscount.textContent = others.length;
    refs.otherssec.hidden = !others.length;
    refs.adminslist.innerHTML = '';
    refs.otherslist.innerHTML = '';
    refs.sponsoredlist.innerHTML = '';

    if (!admins.length) refs.adminslist.innerHTML = `<p class="bk-empty">${t('system.users.noAdministrators', 'No hay administradores.')}</p>`;
    for (const user of admins) refs.adminslist.append(createAdminRow(user));
    for (const user of others) refs.otherslist.append(createOtherRow(user));
    if (!sponsored.length) {
      refs.sponsoredlist.innerHTML = `<p class="bk-empty">${t('system.users.noSponsoredUsers', 'Todavía no hay usuarios patrocinados.')}</p>`;
    } else {
      for (const user of sponsored) refs.sponsoredlist.append(createSponsoredCard(user, sponsorshipByUser.get(user.username)));
      void Promise.allSettled(sponsored.map((user) => loadConnectionSummary(user.username, version)));
    }
  }

  function createName(username, admin = false) {
    const name = document.createElement('span');
    name.className = 'users-name';
    name.textContent = username;
    if (admin) {
      const badge = document.createElement('span');
      badge.className = 'users-badge';
      badge.textContent = t('system.users.adminLabel', 'admin');
      name.append(' ', badge);
    }
    return name;
  }

  function createOversightButton(user, after = null) {
    const button = document.createElement('button');
    button.className = 'btn-ghost btn--sm';
    button.textContent = user.oversight
      ? t('system.users.removeOversight', 'dejar de ver contenido ajeno')
      : t('system.users.grantOversight', 'ver chats y terminales ajenos');
    button.title = t('system.users.oversightHelp', 'Permite ver los chats y terminales de otros usuarios; al adjuntarse a una terminal, también puede controlarla.');
    button.addEventListener('click', async () => {
      if (await update(user.username, { oversight: !user.oversight })) after?.();
    });
    return button;
  }

  function createPasswordButton(username, after = null) {
    const button = document.createElement('button');
    button.className = 'btn-ghost btn--sm';
    button.textContent = t('system.users.passwordAction', 'contraseña');
    button.addEventListener('click', async () => {
      const password = await promptDialog({
        title: t('system.users.passwordDialogTitle', 'Contraseña de {username}', { username }),
        placeholder: t('system.users.newPasswordPlaceholder', 'Nueva contraseña'),
      });
      if (password && await update(username, { password })) after?.();
    });
    return button;
  }

  function createDeleteButton(username, after = null) {
    const button = document.createElement('button');
    button.className = 'btn-ghost btn--sm btn--icon btn--danger';
    button.innerHTML = icon('trash', { size: 13 });
    button.title = t('system.users.deleteUserTitle', 'Eliminar usuario');
    button.addEventListener('click', () => remove(username, after));
    return button;
  }

  function createManageButton(username) {
    const button = document.createElement('button');
    button.className = 'btn btn--sm';
    button.textContent = t('system.users.manageAction', '⚙ Gestionar');
    button.addEventListener('click', () => openManageUser(username));
    return button;
  }

  function createAdminRow(user) {
    const row = document.createElement('div');
    row.className = 'users-row';
    const name = createName(user.username, true);
    const sponsoredCount = sponsorshipOverview.filter((item) => sponsorNameOf(item) === user.username).length;
    if (sponsoredCount) {
      const badge = document.createElement('span');
      badge.className = 'users-badge users-badge--ok';
      badge.textContent = t('system.users.sponsorsCount', 'patrocina a {count}', { count: sponsoredCount });
      name.append(' ', badge);
    }
    const actions = document.createElement('div');
    actions.className = 'users-actions';
    const admin = document.createElement('button');
    admin.className = 'btn-ghost btn--sm';
    admin.textContent = t('system.users.removeAdmin', 'quitar admin');
    admin.addEventListener('click', () => update(user.username, { admin: false }));
    actions.append(admin, createOversightButton(user), createPasswordButton(user.username));
    if (!host || user.username !== host) actions.append(createDeleteButton(user.username));
    row.append(name, actions);
    return row;
  }

  function createOtherRow(user) {
    const row = document.createElement('div');
    row.className = 'users-row';
    const actions = document.createElement('div');
    actions.className = 'users-actions';
    const admin = document.createElement('button');
    admin.className = 'btn-ghost btn--sm';
    admin.textContent = t('system.users.makeAdmin', 'hacer admin');
    admin.addEventListener('click', () => update(user.username, { admin: true }));
    actions.append(admin, createOversightButton(user), createPasswordButton(user.username), createManageButton(user.username));
    if (!host || user.username !== host) actions.append(createDeleteButton(user.username));
    row.append(createName(user.username), actions);
    return row;
  }

  function createSponsoredCard(user, sponsorship) {
    const card = document.createElement('article');
    card.className = 'users-card';
    const head = document.createElement('div');
    head.className = 'users-card-h';
    const name = document.createElement('strong');
    name.className = 'users-card-name';
    name.textContent = user.username;
    const sponsorName = sponsorNameOf(sponsorship);
    const state = document.createElement('span');
    state.className = `users-badge ${sponsorName ? 'users-badge--ok' : 'users-badge--warn'}`;
    state.textContent = sponsorName
      ? t('system.users.sponsoredStatus', '🟢 patrocinado por {sponsor}', { sponsor: sponsorName })
      : t('system.users.awaitingSponsorStatus', '🟠 esperando sponsor');
    const connections = document.createElement('span');
    connections.className = 'users-conn';
    connections.dataset.connectionsUser = user.username;
    updateConnectionSummary(connections, []);
    head.append(name, state, connections, createManageButton(user.username));
    card.append(head);
    return card;
  }

  function updateConnectionSummary(target, providers) {
    const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
    const items = CONNECTION_PROVIDERS.map((meta) => {
      const provider = { ...meta, ...(providerMap.get(meta.id) || {}) };
      const state = connectionState(provider);
      return { text: `${meta.emoji}${state.light}`, title: t('system.users.connectionSummaryItem', '{provider}: {state}', { provider: t(meta.labelKey, meta.labelEs), state: state.label }) };
    });
    target.textContent = items.map((item) => item.text).join(' ');
    target.title = items.map((item) => item.title).join('\n');
  }

  async function loadConnectionSummary(username, version) {
    try {
      const data = await connectionRequest('', { user: username });
      if (version !== renderVersion) return;
      const target = refs.sponsoredlist.querySelector(`[data-connections-user="${CSS.escape(username)}"]`);
      if (target) updateConnectionSummary(target, data.providers || []);
    } catch {
      // El resumen queda en blanco/⚪: una conexión caída nunca tumba el panel.
    }
  }

  function sponsorshipStatusText(sponsorship) {
    const sponsorName = sponsorNameOf(sponsorship);
    if (sponsorName) return t('system.users.sponsoredStatus', '🟢 patrocinado por {sponsor}', { sponsor: sponsorName });
    if (sponsorship?.sponsorshipState === 'awaiting-sponsor') return t('system.users.awaitingSponsorStatus', '🟠 esperando sponsor');
    return t('system.users.ownCredentialStatus', 'Cuenta con credencial propia');
  }

  function openManageUser(username) {
    const modal = openModal({ title: '⚙ ' + username, width: 680 });

    const repaint = () => {
      const openSections = new Set([...modal.body.querySelectorAll('[data-manage-section][open]')].map((details) => details.dataset.manageSection));
      const user = usersSnapshot.find((item) => item.username === username);
      const sponsorship = sponsorshipOverview.find((item) => item.username === username);
      if (!user) {
        modal.close();
        return;
      }
      modal.body.innerHTML = `
        <div class="users-manage-tree">
          <details class="users-manage-sec" data-manage-section="sponsorship" open>
            <summary>🤝 ${t('system.users.sponsorshipSection', 'Patrocinio')}</summary>
            <div data-ref="manage-sponsorship"></div>
          </details>
          <details class="users-manage-sec" data-manage-section="connections">
            <summary>🔌 ${t('system.users.connectionsSection', 'Conexiones')}</summary>
            <div data-ref="manage-connections"></div>
          </details>
          <details class="users-manage-sec" data-manage-section="account">
            <summary>🔑 ${t('system.users.accountSection', 'Cuenta')}</summary>
            <div class="users-actions users-manage-actions" data-ref="manage-account"></div>
          </details>
        </div>`;
      for (const details of modal.body.querySelectorAll('[data-manage-section]')) {
        details.open = openSections.size ? openSections.has(details.dataset.manageSection) : details.dataset.manageSection === 'sponsorship';
      }

      const sponsorshipBox = modal.body.querySelector('[data-ref="manage-sponsorship"]');
      const status = document.createElement('p');
      status.className = 'users-manage-status';
      status.textContent = sponsorshipStatusText(sponsorship);
      sponsorshipBox.append(status);
      const candidates = sponsorCandidatesFor(username);
      if (candidates.length) {
        const actions = document.createElement('div');
        actions.className = 'users-actions';
        const select = document.createElement('select');
        select.className = 'dlg-input users-select';
        select.title = t('system.users.chooseSponsor', 'Elegir sponsor para {username}', { username });
        for (const candidate of candidates) {
          const option = document.createElement('option');
          option.value = candidate.username;
          option.textContent = candidate.username;
          if (candidate.username === sponsorNameOf(sponsorship)) option.selected = true;
          select.append(option);
        }
        const assign = document.createElement('button');
        assign.className = 'btn btn--sm';
        const isSponsored = sponsorship?.sponsorshipState === 'sponsored';
        const isStandard = !['sponsored', 'awaiting-sponsor'].includes(sponsorship?.sponsorshipState);
        assign.textContent = isSponsored
          ? t('system.users.changeSponsorAction', 'Cambiar sponsor')
          : isStandard
            ? t('system.users.convertSponsoredAction', 'Convertir en patrocinado')
            : t('system.users.sponsorAction', 'Patrocinar');
        assign.addEventListener('click', async () => {
          if (await assignSponsorship(username, select.value, { convert: isStandard })) repaint();
        });
        actions.append(select, assign);
        sponsorshipBox.append(actions);
      } else {
        const none = document.createElement('p');
        none.className = 'bk-empty users-inline-empty';
        none.textContent = t('system.users.noSponsorAvailable', 'no hay sponsor disponible');
        sponsorshipBox.append(none);
      }
      if (sponsorNameOf(sponsorship)) {
        const release = document.createElement('button');
        release.className = 'btn btn--sm btn--danger';
        release.textContent = t('system.users.releaseSponsorship', 'Liberar patrocinio');
        release.addEventListener('click', async () => {
          if (await releaseSponsorship(username, sponsorNameOf(sponsorship))) repaint();
        });
        sponsorshipBox.append(release);
      }

      const connectionsDetails = modal.body.querySelector('[data-manage-section="connections"]');
      const connectionsBox = modal.body.querySelector('[data-ref="manage-connections"]');
      let connectionsLoaded = false;
      const loadConnections = () => {
        if (connectionsLoaded) return;
        connectionsLoaded = true;
        renderConnectionsInto(connectionsBox, username);
      };
      connectionsDetails.addEventListener('toggle', () => { if (connectionsDetails.open) loadConnections(); });
      if (connectionsDetails.open) loadConnections();

      const account = modal.body.querySelector('[data-ref="manage-account"]');
      account.append(createPasswordButton(username, repaint), createOversightButton(user, repaint));
      if (!host || username !== host) account.append(createDeleteButton(username, modal.close));
    };

    repaint();
  }

  async function assignSponsorship(username, sponsor, { convert = false } = {}) {
    const ok = await confirmDialog({
      title: convert
        ? t('system.users.convertConfirmTitle', 'Convertir en patrocinado')
        : t('system.users.sponsorConfirmTitle', 'Asignar patrocinio'),
      message: convert
        ? t(
          'system.users.convertConfirmMessage',
          'La cuenta de "{username}" pasará a perfil patrocinado y va a consumir la credencial de Claude de "{sponsor}". ¿Querés continuar?',
          { sponsor, username },
        )
        : t(
          'system.users.sponsorConfirmMessage',
          'Vas a asignar a "{sponsor}" como sponsor de "{username}". ¿Querés continuar?',
          { sponsor, username },
        ),
      confirmLabel: convert
        ? t('system.users.convertConfirm', 'Convertir y patrocinar')
        : t('system.users.sponsorConfirm', 'Patrocinar'),
    });
    if (!ok) return false;
    try {
      await sponsorshipApi('/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, sponsor }),
      });
      msg(t('system.users.sponsorshipAssigned', 'Patrocinio asignado.'), true);
      await load();
      return true;
    } catch (error) {
      msg(error.message);
      return false;
    }
  }

  async function releaseSponsorship(username, sponsor) {
    const ok = await confirmDialog({
      title: t('system.users.releaseConfirmTitle', 'Liberar patrocinio'),
      message: t(
        'system.users.releaseConfirmMessage',
        'Vas a quitar el patrocinio de "{sponsor}" sobre "{username}". El usuario quedará sin sponsor. ¿Querés continuar?',
        { sponsor, username },
      ),
      confirmLabel: t('system.users.releaseConfirm', 'Liberar'),
      danger: true,
    });
    if (!ok) return false;
    try {
      await sponsorshipApi('/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      msg(t('system.users.sponsorshipReleased', 'Patrocinio liberado.'), true);
      await load();
      return true;
    } catch (error) {
      msg(error.message);
      return false;
    }
  }

  async function connectionRequest(path, { method = 'GET', body = null, user, query = {} } = {}) {
    const params = new URLSearchParams(query);
    const opts = { method };
    if (method === 'GET') {
      params.set('user', user);
    } else {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify({ ...(body || {}), user });
    }
    const suffix = params.size ? `?${params}` : '';
    const res = await fetch(`/api/connections${path}${suffix}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }

  function connectionState(provider) {
    if (provider.error) return { light: '🔴', label: t('system.users.connectionError', 'error: {error}', { error: provider.error }) };
    if (provider.connected) {
      return {
        light: '🟢',
        label: provider.account
          ? t('system.users.connectionAccount', 'conectado como {account}', { account: provider.account })
          : t('system.users.connectionConnected', 'conectado'),
      };
    }
    if (provider.lastAttempt?.status && !['connected', 'error', 'cancelled'].includes(provider.lastAttempt.status)) {
      return { light: '🔵', label: t('system.users.connectionInProgress', 'conexión en curso') };
    }
    if (provider.lastAttempt?.error || provider.lastAttempt?.status === 'error') {
      return { light: '🔴', label: t('system.users.connectionError', 'error: {error}', { error: provider.lastAttempt.error || '' }) };
    }
    if (provider.configured === false) {
      return { light: '⚪', label: t('system.users.connectionUnconfigured', 'sin configurar') };
    }
    return { light: '⚪', label: t('system.users.connectionDisconnected', 'sin conectar') };
  }

  function openUserConnections(username) {
    const modal = openModal({
      title: t('system.users.connectionsTitle', 'Conexiones de {username}', { username }),
      width: 650,
    });
    renderConnectionsInto(modal.body, username);
  }

  function openConnectionGuide(username) {
    const zohoScopes = 'Desk.tickets.ALL,Desk.contacts.READ,Desk.contacts.CREATE,Desk.basic.READ,Desk.settings.READ,Desk.search.READ,ZohoCRM.modules.ALL,ZohoCRM.settings.READ,ZohoCRM.users.READ,ZohoProjects.projects.READ,ZohoProjects.tasks.READ,ZohoProjects.portals.READ';
    const modal = openModal({
      title: t('system.users.guide.title', '📖 Cómo conectar las cuentas de {username}', { username }),
      width: 720,
    });
    modal.body.innerHTML = `
      <p class="dlg-msg">${esc(t(
        'system.users.guide.intro',
        'Estás conectando cuentas DE OTRA PERSONA: todo lo que autorices queda guardado en el espacio privado de {username} y la consola va a actuar con SU identidad, nunca con la tuya. Regla de oro: en la pantalla de inicio de sesión tiene que aparecer el correo de esa persona, no el tuyo.',
        { username },
      ))}</p>
      <div class="users-manage-tree">
        <details class="users-manage-sec" data-guide-section open>
          <summary>${esc(t('system.users.guide.microsoft.summary', '📅 Microsoft 365 — correo, calendario, archivos, SharePoint y Teams'))}</summary>
          <div>
            <h4 class="conn-h">${esc(t('system.users.guide.microsoft.beforeTitle', 'Antes de empezar'))}</h4>
            <ul class="mcp-oauth-steps">
              <li>${esc(t('system.users.guide.microsoft.beforePassword', 'Tené a mano la contraseña de {username}, o que esté al lado para escribirla y aprobar el MFA.', { username }))}</li>
              <li>${esc(t('system.users.guide.microsoft.beforePublicClient', 'La app de Entra tiene que tener "Allow public client flows" en Sí; sin eso el código de dispositivo no funciona.'))}</li>
              <li>${esc(t('system.users.guide.microsoft.beforeConsent', 'Si el tenant no permite el consentimiento de usuario, un administrador de Microsoft 365 tiene que aprobar la app UNA vez. Los permisos de Teams, Contactos y Archivos (escritura) son los que suelen pedirlo.'))}</li>
            </ul>
            <h4 class="conn-h">${esc(t('system.users.guide.microsoft.stepsTitle', 'Paso a paso'))}</h4>
            <ol class="mcp-oauth-steps">
              <li>${esc(t('system.users.guide.microsoft.step1', 'Tocá "Conectar para {username}". La consola muestra un código corto.', { username }))}</li>
              <li>${esc(t('system.users.guide.microsoft.step2', 'Copiá el código con el botón "Copiar código".'))}</li>
              <li>${esc(t('system.users.guide.microsoft.step3Before', 'Abrí el enlace'))} <a class="mcp-oauth-link" href="https://microsoft.com/devicelogin" target="_blank" rel="noopener noreferrer">${esc(t('system.users.guide.microsoft.step3Link', '"Abrir Microsoft"'))}</a> ${esc(t('system.users.guide.microsoft.step3After', '(va a https://microsoft.com/devicelogin).'))}</li>
              <li>${esc(t('system.users.guide.microsoft.step4', 'Pegá el código y dale Siguiente.'))}</li>
              <li><b>${esc(t('system.users.guide.microsoft.step5', 'Iniciá sesión CON LA CUENTA DE {username}. Si aparece tu propia sesión, usá "Usar otra cuenta" o abrí el enlace en una ventana privada.', { username }))}</b></li>
              <li>${esc(t('system.users.guide.microsoft.step6', 'Aceptá la pantalla de permisos.'))}</li>
              <li>${esc(t('system.users.guide.microsoft.step7', 'Volvé a la consola: verifica sola cada pocos segundos y el semáforo pasa a 🟢 conectado.'))}</li>
            </ol>
            <h4 class="conn-h">${esc(t('system.users.guide.microsoft.permissionsTitle', 'Qué permisos queda dando'))}</h4>
            <p class="hr-f-detail">${esc(t('system.users.guide.microsoft.permissionsIntro', 'Son DELEGADOS, o sea que la consola solo ve lo que esa persona ya puede ver:'))}</p>
            <ul class="mcp-oauth-steps">
              <li>${esc(t('system.users.guide.microsoft.permissionMail', 'Correo: leer, redactar, enviar y leer buzones compartidos.'))}</li>
              <li>${esc(t('system.users.guide.microsoft.permissionFiles', 'Archivos y SharePoint: leer y escribir.'))}</li>
              <li>${esc(t('system.users.guide.microsoft.permissionCalendar', 'Calendario: leer y escribir.'))}</li>
              <li>${esc(t('system.users.guide.microsoft.permissionContactsTasks', 'Contactos: leer. · Tareas: leer y escribir.'))}</li>
              <li>${esc(t('system.users.guide.microsoft.permissionTeams', 'Teams: equipos, canales y mensajes de canal, y chats: solo lectura.'))}</li>
              <li>${esc(t('system.users.guide.microsoft.permissionProfile', 'Perfil y personas: solo lectura.'))}</li>
            </ul>
            <h4 class="conn-h">${esc(t('system.users.guide.microsoft.failuresTitle', 'Si algo falla'))}</h4>
            <ul class="mcp-oauth-steps">
              <li>${esc(t('system.users.guide.microsoft.failureConsent', '"AADSTS65001" o "hace falta consentimiento": un administrador del tenant tiene que aprobar la app una vez; después repetís el paso a paso.'))}</li>
              <li>${esc(t('system.users.guide.microsoft.failureExpired', 'El código venció (dura unos 15 minutos): tocá "Verificar de nuevo" o empezá otra vez.'))}</li>
              <li>${esc(t('system.users.guide.microsoft.failureWrongAccount', 'Conectaste la cuenta equivocada: "Desconectar" y repetir eligiendo "Usar otra cuenta".'))}</li>
              <li>${esc(t('system.users.guide.microsoft.failureNewPermission', 'Si más adelante la consola suma un permiso nuevo, hay que tocar "Renovar permisos": el refresco automático conserva los permisos con los que se conectó y no toma los nuevos.'))}</li>
            </ul>
          </div>
        </details>
        <details class="users-manage-sec" data-guide-section>
          <summary>${esc(t('system.users.guide.zoho.summary', '🎫 Zoho — Desk, CRM y Projects'))}</summary>
          <div>
            <h4 class="conn-h">${esc(t('system.users.guide.zoho.trapTitle', 'Lo primero, la trampa'))}</h4>
            <div class="hlp-note hlp-note--warn">${esc(t('system.users.guide.zoho.trap', 'Zoho no tiene login por código como Microsoft: el código lo genera la persona desde SU consola de API. Y un Self Client es PERSONAL — solo su dueño puede generar códigos para él. Si la app que usa la consola no es de {username}, Zoho responde invalid_code por más que todo lo demás esté bien.', { username }))}</div>
            <h4 class="conn-h">${esc(t('system.users.guide.zoho.beforeTitle', 'Antes de empezar'))}</h4>
            <ul class="mcp-oauth-steps">
              <li>${esc(t('system.users.guide.zoho.beforeCredentials', 'Que {username} cargue su propio Client ID y Secret en ⚙ Sistema → Conexiones (es todo o nada: no se puede mezclar el Client ID de una persona con el secret de la instancia).', { username }))}</li>
              <li>${esc(t('system.users.guide.zoho.beforeDataCenter', 'Saber en qué data center está su cuenta: .com, .eu, .in, .com.au, .jp o .ca. El enlace de abajo asume .com; cambiá el final si su cuenta es de otro.'))}</li>
            </ul>
            <h4 class="conn-h">${esc(t('system.users.guide.zoho.stepsTitle', 'Paso a paso'))}</h4>
            <ol class="mcp-oauth-steps">
              <li>${esc(t('system.users.guide.zoho.step1Before', 'Entrá a la'))} <a class="mcp-oauth-link" href="https://api-console.zoho.com" target="_blank" rel="noopener noreferrer">${esc(t('system.users.guide.zoho.step1Link', 'consola de API de Zoho'))}</a> ${esc(t('system.users.guide.zoho.step1After', 'con la cuenta de {username}.', { username }))}</li>
              <li>${esc(t('system.users.guide.zoho.step2', 'Abrí el Self Client. Si no existe, creá uno: Add Client → Self Client.'))}</li>
              <li>${esc(t('system.users.guide.zoho.step3', 'Entrá a la pestaña "Generate Code".'))}</li>
              <li>${esc(t('system.users.guide.zoho.step4', 'En "Scope" pegá exactamente esta lista:'))}<code class="conn-scopes">${zohoScopes}</code><button class="btn-ghost btn--sm" data-ref="guide-copy-scopes">${icon('clipboard', { size: 12 })}<span>${esc(t('system.users.guide.zoho.copyScopes', 'Copiar scopes'))}</span></button></li>
              <li>${esc(t('system.users.guide.zoho.step5', 'En "Time Duration" elegí 10 minutes y en "Scope Description" escribí cualquier texto, por ejemplo "Mi Consola".'))}</li>
              <li>${esc(t('system.users.guide.zoho.step6', 'Elegí el portal/organización correcto y tocá Create: Zoho muestra el código.'))}</li>
              <li>${esc(t('system.users.guide.zoho.step7', 'Volvé a la consola, pegalo en el campo de código y tocá "Enviar código" antes de que se venza.'))}</li>
            </ol>
            <p class="hr-f-file" data-ref="guide-copy-message" hidden></p>
            <h4 class="conn-h">${esc(t('system.users.guide.zoho.failuresTitle', 'Si algo falla'))}</h4>
            <p class="hr-f-detail"><b>${esc(t('system.users.guide.zoho.invalidCodeTitle', 'invalid_code tiene tres causas, siempre una de estas'))}</b></p>
            <ul class="mcp-oauth-steps">
              <li>${esc(t('system.users.guide.zoho.failureWrongApp', 'El código se generó en una app que no es la de {username}: cargá su propio Client ID y Secret.', { username }))}</li>
              <li>${esc(t('system.users.guide.zoho.failureUsed', 'El código ya se usó: son de un solo uso, generá otro.'))}</li>
              <li>${esc(t('system.users.guide.zoho.failureExpired', 'Pasó demasiado tiempo: duran entre 3 y 10 minutos. Generá el código y pegalo enseguida.'))}</li>
            </ul>
            <h4 class="conn-h">${esc(t('system.users.guide.zoho.permissionsTitle', 'Qué permisos queda dando'))}</h4>
            <ul class="mcp-oauth-steps">
              <li>${esc(t('system.users.guide.zoho.permissionDesk', 'Desk: tickets (completo), contactos (leer y crear), datos básicos, configuración y búsqueda.'))}</li>
              <li>${esc(t('system.users.guide.zoho.permissionCrm', 'CRM: módulos (completo), configuración y usuarios (lectura).'))}</li>
              <li>${esc(t('system.users.guide.zoho.permissionProjects', 'Projects: proyectos, tareas y portales (solo lectura).'))}</li>
            </ul>
          </div>
        </details>
      </div>
      <p class="dlg-msg">${esc(t('system.users.guide.footer', 'Cada cuenta queda guardada en el espacio privado de {username}. Si se va de la empresa, se desconecta desde acá mismo.', { username }))}</p>
      <div class="mcp-acts"><button class="btn btn--sm" data-ref="guide-close">${esc(t('system.users.guide.close', 'Cerrar'))}</button></div>`;

    const guideSections = [...modal.body.querySelectorAll('[data-guide-section]')];
    for (const section of guideSections) {
      section.addEventListener('toggle', () => {
        if (section.open) guideSections.filter((other) => other !== section).forEach((other) => { other.open = false; });
      });
    }
    const copyMessage = modal.body.querySelector('[data-ref="guide-copy-message"]');
    modal.body.querySelector('[data-ref="guide-copy-scopes"]')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(zohoScopes);
        copyMessage.textContent = t('system.users.guide.zoho.scopesCopied', 'Scopes copiados.');
      } catch {
        copyMessage.textContent = t('system.users.guide.zoho.copyScopesFallback', 'No se pudo copiar automáticamente. Scopes: {scopes}', { scopes: zohoScopes });
      }
      copyMessage.hidden = false;
    });
    modal.body.querySelector('[data-ref="guide-close"]')?.addEventListener('click', modal.close);
  }

  function renderConnectionsInto(container, username) {
    const target = document.createElement('p');
    target.className = 'dlg-msg';
    target.textContent = t(
      'system.users.connectionsTargetWarning',
      'Usuario destino: {username}. Toda cuenta que conectes acá quedará guardada en el espacio de este usuario.',
      { username },
    );
    const content = document.createElement('div');
    container.replaceChildren(target, content);

    const loadConnections = async () => {
      content.innerHTML = `<p class="hr-summary">${t('system.users.loadingConnections', 'Cargando conexiones…')}</p>`;
      try {
        const data = await connectionRequest('', { user: username });
        if (!content.isConnected) return;
        const providerMap = new Map((data.providers || []).map((provider) => [provider.id, provider]));
        const providers = CONNECTION_PROVIDERS.map((meta) => ({
          ...meta,
          label: t(meta.labelKey, meta.labelEs),
          ...(providerMap.get(meta.id) || {}),
        }));
        content.innerHTML = `<div class="hr-findings">${providers.map((provider) => {
          const state = connectionState(provider);
          const running = provider.lastAttempt?.status && !['connected', 'error', 'cancelled'].includes(provider.lastAttempt.status);
          const primaryLabel = provider.connected
            ? t('system.users.renewConnection', 'Renovar permisos')
            : running
              ? t('system.users.verifyConnection', 'Verificar de nuevo')
              : t('system.users.connectForUser', 'Conectar para {username}', { username });
          const controls = `<div class="mcp-acts">
            <button class="btn btn--sm" data-connection-action="connect">${icon(provider.connected || running ? 'refresh' : 'externalLink', { size: 12 })}<span>${esc(primaryLabel)}</span></button>
            ${provider.connected ? `<button class="btn-ghost btn--sm" data-connection-action="disconnect">${t('system.users.disconnectConnection', 'Desconectar')}</button>` : ''}
            ${running ? `<button class="btn-ghost btn--sm" data-connection-action="cancel">${t('system.users.cancelConnection', 'Cancelar intento')}</button>` : ''}
          </div>`;
          return `<div class="hr-finding" data-provider="${esc(provider.id)}">
            <div class="hr-f-head">
              <span class="mcp-dot">${state.light}</span>
              <span class="hr-f-area">${provider.emoji} ${esc(provider.label)}</span>
              <span class="hr-f-mod">${esc(state.label)}</span>
            </div>
            <div class="hr-f-body users-connections-body">
              <p class="hr-f-detail"><b>${state.light} ${esc(state.label)}</b></p>
              ${controls}
            </div>
          </div>`;
        }).join('')}</div>
        <div class="mcp-acts">
          <button class="btn-ghost btn--sm" data-ref="refresh">${icon('refresh', { size: 12 })}<span>${t('system.users.refreshConnections', 'Actualizar estados')}</span></button>
          <button class="btn-ghost btn--sm" data-ref="connection-guide">${icon('help', { size: 12 })}<span>${t('system.users.guide.open', '📖 Cómo conectar')}</span></button>
        </div>`;

        content.querySelector('[data-ref="refresh"]')?.addEventListener('click', loadConnections);
        content.querySelector('[data-ref="connection-guide"]')?.addEventListener('click', () => openConnectionGuide(username));
        content.querySelectorAll('[data-provider]').forEach((card) => {
          const provider = providers.find((item) => item.id === card.dataset.provider);
          card.querySelector('[data-connection-action="connect"]')?.addEventListener('click', async () => {
            const ok = await confirmDialog({
              title: t('system.users.connectAccountTitle', 'Conectar cuenta para {username}', { username }),
              message: t(
                'system.users.connectAccountMessage',
                'Vas a autorizar una cuenta real de {provider} dentro del espacio de "{username}". Verificá que la cuenta pertenezca a esa persona antes de continuar.',
                { provider: provider.label, username },
              ),
              confirmLabel: t('system.users.continueConnection', 'Continuar'),
            });
            if (ok) openUserProviderConnect(username, provider, loadConnections);
          });
          card.querySelector('[data-connection-action="disconnect"]')?.addEventListener('click', async () => {
            const ok = await confirmDialog({
              title: t('system.users.disconnectAccountTitle', 'Desconectar cuenta de {username}', { username }),
              message: t('system.users.disconnectAccountMessage', 'Vas a borrar la conexión de {provider} de "{username}". ¿Querés continuar?', { provider: provider.label, username }),
              confirmLabel: t('system.users.disconnectConnection', 'Desconectar'),
              danger: true,
            });
            if (!ok) return;
            try {
              await connectionRequest(`/${encodeURIComponent(provider.id)}/disconnect`, { method: 'POST', user: username });
              loadConnections();
            } catch (error) {
              alertDialog({ title: t('system.users.connectionErrorTitle', 'Error de conexión'), message: error.message });
            }
          });
          card.querySelector('[data-connection-action="cancel"]')?.addEventListener('click', async () => {
            const ok = await confirmDialog({
              title: t('system.users.cancelConnectionTitle', 'Cancelar conexión de {username}', { username }),
              message: t('system.users.cancelConnectionMessage', 'Vas a cancelar el intento de {provider} para "{username}".', { provider: provider.label, username }),
              confirmLabel: t('system.users.cancelConnection', 'Cancelar intento'),
            });
            if (!ok) return;
            try {
              await connectionRequest(`/${encodeURIComponent(provider.id)}/cancel`, { method: 'POST', user: username });
              loadConnections();
            } catch (error) {
              alertDialog({ title: t('system.users.connectionErrorTitle', 'Error de conexión'), message: error.message });
            }
          });
        });
      } catch (error) {
        if (content.isConnected) content.innerHTML = `<p class="hr-f-crit">🔴 ${esc(error.message)}</p>`;
      }
    };

    loadConnections();
  }

  // Replica mínima de `mcps-panel.js:openConnect`: ese asistente vive dentro
  // de mountMcpsPanel y no es importable. Mantener sincronizados device-code,
  // polling, cancelación y vencimiento hasta que se extraiga un helper común.
  function openUserProviderConnect(username, provider, refreshConnections) {
    const modal = openModal({
      title: t('system.users.connectProviderForUser', 'Conectar {provider} · usuario {username}', { provider: provider.label, username }),
      width: 560,
    });
    let jobId = null;
    let phase = '';
    let expiresAt = null;
    let pollTimer = null;
    let expiryTimer = null;
    let polling = false;

    const stop = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (expiryTimer) clearInterval(expiryTimer);
      pollTimer = null;
      expiryTimer = null;
    };
    const observer = new MutationObserver(() => {
      if (!modal.body.isConnected) {
        stop();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const setBody = (html) => {
      modal.body.innerHTML = `<div class="mcp-oauth">
        <p class="dlg-msg"><b>${esc(t('system.users.connectionTarget', 'Usuario destino: {username}', { username }))}</b><br>${t('system.users.connectionTargetReminder', 'La cuenta autorizada quedará vinculada a este usuario.')}</p>
        ${html}
      </div>`;
    };

    const wireClose = () => {
      modal.body.querySelector('[data-ref="close"]')?.addEventListener('click', () => {
        stop();
        modal.close();
        refreshConnections();
      });
    };

    const cancelAttempt = async () => {
      const ok = await confirmDialog({
        title: t('system.users.cancelConnectionTitle', 'Cancelar conexión de {username}', { username }),
        message: t('system.users.cancelProviderAttempt', 'Vas a cancelar el intento de {provider} para "{username}".', { provider: provider.label, username }),
        confirmLabel: t('system.users.cancelConnection', 'Cancelar intento'),
      });
      if (!ok) return;
      try {
        await connectionRequest(`/${encodeURIComponent(provider.id)}/cancel`, { method: 'POST', user: username, body: { jobId } });
        stop();
        modal.close();
        refreshConnections();
      } catch (error) {
        alertDialog({ title: t('system.users.connectionErrorTitle', 'Error de conexión'), message: error.message });
      }
    };

    const wireCancel = () => {
      modal.body.querySelector('[data-ref="cancel"]')?.addEventListener('click', cancelAttempt);
    };

    const renderError = (error, expired = false) => {
      phase = expired ? 'expired' : 'error';
      stop();
      setBody(`
        <p class="hr-f-crit">🔴 ${esc(expired
          ? t('system.users.deviceCodeExpired', 'El código venció. Iniciá uno nuevo y asegurate de autorizar la cuenta de {username}.', { username })
          : t('system.users.providerConnectionFailed', 'No se pudo conectar {provider} para {username}: {error}', { provider: provider.label, username, error }))}</p>
        <div class="mcp-acts">
          <button class="btn btn--sm" data-ref="retry">${t('system.users.retryConnection', 'Reintentar')}</button>
          <button class="btn-ghost btn--sm" data-ref="cancel">${t('system.users.cancelConnection', 'Cancelar intento')}</button>
        </div>`);
      modal.body.querySelector('[data-ref="retry"]')?.addEventListener('click', startConnect);
      wireCancel();
    };

    const renderConnected = (result) => {
      phase = 'connected';
      stop();
      setBody(`
        <p class="hr-f-detail">🟢 <b>${esc(t('system.users.providerConnected', '{provider} quedó conectado para {username}.', { provider: provider.label, username }))}</b></p>
        ${result.account ? `<p class="hr-f-file">👤 ${esc(result.account)}</p>` : ''}
        <div class="mcp-acts"><button class="btn btn--sm" data-ref="close">${t('system.users.close', 'Cerrar')}</button></div>`);
      wireClose();
    };

    const updateExpiry = () => {
      if (!expiresAt || phase !== 'device') return;
      const left = expiresAt - Date.now();
      if (left <= 0) {
        renderError('', true);
        return;
      }
      const expiry = modal.body.querySelector('[data-ref="expiry"]');
      if (expiry) expiry.textContent = t('system.users.deviceCodeTimeLeft', 'El código vence en {min}:{sec}.', {
        min: Math.floor(left / 60000),
        sec: String(Math.floor((left % 60000) / 1000)).padStart(2, '0'),
      });
    };

    const renderDevice = (result) => {
      phase = 'device';
      const absoluteExpiry = Number(result.expiresAt);
      expiresAt = Number.isFinite(absoluteExpiry) && absoluteExpiry > Date.now()
        ? absoluteExpiry
        : Date.now() + (Number(result.expiresIn) || 900) * 1000;
      setBody(`
        <p class="mcp-oauth-wait"><b>${esc(t('system.users.authorizeCorrectAccount', 'Autorizá la cuenta de {username}', { username }))}</b></p>
        <div class="conn-code" data-ref="code">${esc(result.userCode)}</div>
        <div class="mcp-acts">
          <button class="btn-ghost btn--sm" data-ref="copy-code">${icon('clipboard', { size: 12 })}<span>${t('system.users.copyCode', 'Copiar código')}</span></button>
          <a class="mcp-oauth-link" href="${esc(result.verificationUri)}" target="_blank" rel="noopener noreferrer">${icon('externalLink', { size: 13 })} ${t('system.users.openMicrosoft', 'Abrir Microsoft')}</a>
        </div>
        <ol class="mcp-oauth-steps">
          <li>${esc(t('system.users.microsoftStepOpen', 'Abrí Microsoft e ingresá el código.'))}</li>
          <li><b>${esc(t('system.users.microsoftStepIdentity', 'Antes de aceptar, comprobá que la cuenta sea la de {username}.', { username }))}</b></li>
          <li>${esc(t('system.users.microsoftStepWait', 'Volvé acá; la consola verifica la conexión automáticamente.'))}</li>
        </ol>
        <p class="hr-f-file" data-ref="expiry"></p>
        <p class="hr-f-file" data-ref="copy-message"></p>
        <div class="mcp-acts"><button class="btn-ghost btn--sm" data-ref="cancel">${t('system.users.cancelConnection', 'Cancelar intento')}</button></div>`);
      modal.body.querySelector('[data-ref="copy-code"]')?.addEventListener('click', async () => {
        const copyMessage = modal.body.querySelector('[data-ref="copy-message"]');
        try {
          await navigator.clipboard.writeText(result.userCode);
          copyMessage.textContent = t('system.users.codeCopied', 'Código copiado.');
        } catch {
          copyMessage.textContent = t('system.users.copyCodeFallback', 'No se pudo copiar automáticamente. Código: {code}', { code: result.userCode });
        }
      });
      wireCancel();
      updateExpiry();
      if (expiryTimer) clearInterval(expiryTimer);
      expiryTimer = setInterval(updateExpiry, 1000);
    };

    const renderPaste = (result) => {
      phase = 'paste';
      setBody(`
        <p class="mcp-oauth-wait"><b>${esc(t('system.users.authorizeCorrectAccount', 'Autorizá la cuenta de {username}', { username }))}</b></p>
        <ol class="mcp-oauth-steps">
          <li><a class="mcp-oauth-link" href="${esc(result.authUrl)}" target="_blank" rel="noopener noreferrer">${icon('externalLink', { size: 13 })} ${t('system.users.openZoho', 'Abrir Zoho')}</a></li>
          <li><b>${esc(t('system.users.zohoStepIdentity', 'Generá el grant code con la cuenta de {username}.', { username }))}</b></li>
          ${result.scopes ? `<li>${t('system.users.zohoScopes', 'Scopes requeridos:')} <code class="conn-scopes">${esc(result.scopes)}</code> <button class="btn-ghost btn--sm" data-ref="copy-scopes">${t('system.users.copyScopes', 'Copiar scopes')}</button></li>` : ''}
          <li><input type="text" class="dlg-input" data-ref="grant-code" placeholder="${esc(t('system.users.grantCodePlaceholder', '1000.xxxxx…'))}"> <button class="btn btn--sm" data-ref="send-code">${icon('check', { size: 12 })}<span>${t('system.users.sendCode', 'Enviar código')}</span></button></li>
        </ol>
        <p class="hr-f-file" data-ref="paste-message"></p>
        <div class="mcp-acts"><button class="btn-ghost btn--sm" data-ref="cancel">${t('system.users.cancelConnection', 'Cancelar intento')}</button></div>`);
      const pasteMessage = modal.body.querySelector('[data-ref="paste-message"]');
      modal.body.querySelector('[data-ref="copy-scopes"]')?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(result.scopes);
          pasteMessage.textContent = t('system.users.scopesCopied', 'Scopes copiados.');
        } catch {
          pasteMessage.textContent = t('system.users.copyScopesFallback', 'No se pudo copiar automáticamente. Scopes: {scopes}', { scopes: result.scopes });
        }
      });
      modal.body.querySelector('[data-ref="send-code"]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const value = modal.body.querySelector('[data-ref="grant-code"]')?.value.trim() || '';
        if (!value) return;
        button.disabled = true;
        pasteMessage.textContent = t('system.users.sendingCode', 'Enviando código…');
        try {
          await connectionRequest(`/${encodeURIComponent(provider.id)}/code`, {
            method: 'POST',
            user: username,
            body: { jobId, value },
          });
          pasteMessage.textContent = t('system.users.codeSent', 'Código enviado. Esperando confirmación…');
        } catch (error) {
          pasteMessage.textContent = t('system.users.connectionError', 'error: {error}', { error: error.message });
          button.disabled = false;
        }
      });
      wireCancel();
    };

    const pollOnce = async () => {
      if (!jobId || polling || !modal.body.isConnected) return;
      polling = true;
      try {
        const result = await connectionRequest(`/${encodeURIComponent(provider.id)}/status`, {
          user: username,
          query: { jobId },
        });
        if (result.status === 'connected') renderConnected(result);
        else if (result.status === 'expired') renderError('', true);
        else if (result.status === 'error') renderError(result.error || t('system.users.unknownError', 'error desconocido'));
        else if (result.status === 'cancelled') {
          phase = 'cancelled';
          stop();
          setBody(`<p class="hr-f-file">${esc(t('system.users.connectionCancelled', 'El intento de {provider} para {username} fue cancelado.', { provider: provider.label, username }))}</p><div class="mcp-acts"><button class="btn btn--sm" data-ref="close">${t('system.users.close', 'Cerrar')}</button></div>`);
          wireClose();
        }
      } catch {
        // Igual que mcps-panel.js: una falla transitoria de red no corta el polling.
      } finally {
        polling = false;
      }
    };

    async function startConnect() {
      stop();
      phase = 'starting';
      expiresAt = null;
      setBody(`<p class="mcp-oauth-wait">${esc(t('system.users.startingConnection', 'Iniciando {provider} para {username}…', { provider: provider.label, username }))}</p>`);
      try {
        const result = await connectionRequest(`/${encodeURIComponent(provider.id)}/connect`, { method: 'POST', user: username });
        jobId = result.jobId;
        if (result.mode === 'device') renderDevice(result);
        else if (result.mode === 'paste') renderPaste(result);
        else throw new Error(t('system.users.unknownConnectionMode', 'Modo de conexión desconocido.'));
        pollTimer = setInterval(pollOnce, 3000);
        await pollOnce();
      } catch (error) {
        renderError(error.message || String(error));
      }
    }

    startConnect();
  }

  function showInviteToken(invite) {
    const box = refs.invtoken;
    box.hidden = false;
    box.textContent = '';
    const url = location.origin + '/onboard';
    const p1 = document.createElement('p');
    p1.className = 'users-invite-label';
    p1.textContent = invite.sponsored
      ? t('system.users.sponsoredInviteShare', 'Invitación de PATROCINADO — pasale a la persona:')
      : invite.admin
        ? t('system.users.adminInviteShare', 'Invitación de ADMIN — pasale a la persona:')
        : t('system.users.inviteShare', 'Pasale a la persona:');
    const pre = document.createElement('div');
    pre.className = 'users-invite-message';
    const inviteSponsor = sponsorNameOf(invite);
    const message = invite.sponsored
      ? inviteSponsor
        ? t(
          'system.users.sponsoredInviteAssignedMessage',
          'Entrá a {url} y usá este token de invitación:\n{token}\n\nTe va a patrocinar {sponsor}: ya podés trabajar apenas entres.',
          { url, token: invite.token, sponsor: inviteSponsor },
        )
        : t(
          'system.users.sponsoredInviteMessage',
          'Entrá a {url} y usá este token de invitación:\n{token}\n\nAlguien va a tener que adoptarte para que puedas trabajar. Si nadie te adopta, vas a poder entrar, pero no vas a poder hacer nada.',
          { url, token: invite.token },
        )
      : t('system.users.inviteMessage', 'Entrá a {url} y usá este token de invitación:\n{token}', { url, token: invite.token });
    pre.textContent = message;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn--sm users-invite-copy';
    copy.textContent = t('system.users.copyInvite', 'Copiar invitación');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(message);
        copy.textContent = `✓ ${t('system.users.copied', 'Copiado')}`;
        setTimeout(() => { copy.textContent = t('system.users.copyInvite', 'Copiar invitación'); }, 1500);
      } catch {
        copy.textContent = t('system.users.copyManually', 'copiá a mano ↑');
      }
    });
    box.append(p1, pre, copy);
  }

  async function loadInvites() {
    try {
      const { invites } = await onboardApi('/admin/invites', {});
      renderInvites(invites || []);
    } catch (e) {
      /* Intento suave: no romper el panel de usuarios. */
    }
  }

  function fmtWhen(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderInvites(invites) {
    refs.invlist.innerHTML = '';
    const pend = invites.filter((i) => i.status === 'pending' || i.status === 'locked');
    if (!pend.length) {
      refs.invlist.innerHTML = `<p class="bk-empty users-empty--compact">${t('system.users.noPendingInvites', 'Sin invitaciones pendientes.')}</p>`;
      return;
    }
    for (const inv of pend) {
      const row = document.createElement('div');
      row.className = 'users-row';
      const name = document.createElement('span');
      name.className = 'users-name';
      const label = document.createElement('span');
      label.textContent = (inv.status === 'locked' ? t('system.users.inviteInUse', 'en uso · {lockedTo}', { lockedTo: inv.lockedTo || '' }) : t('system.users.invitePending', 'pendiente')) + (inv.admin || inv.sponsored ? '  ' : '');
      name.appendChild(label);
      if (inv.admin) {
        const b = document.createElement('span');
        b.className = 'users-badge';
        b.textContent = t('system.users.adminLabel', 'admin');
        name.appendChild(b);
      }
      if (inv.sponsored) {
        const b = document.createElement('span');
        b.className = 'users-badge';
        b.textContent = t('system.users.sponsoredLabel', 'patrocinado');
        name.appendChild(b);
      }
      const inviteSponsor = sponsorNameOf(inv);
      if (inviteSponsor) {
        const b = document.createElement('span');
        b.className = 'users-badge users-badge--ok';
        b.textContent = t('system.users.plannedSponsorBadge', '🤝 {sponsor}', { sponsor: inviteSponsor });
        name.appendChild(b);
      }
      const meta = document.createElement('span');
      meta.className = 'users-meta';
      meta.textContent = t('system.users.expiresAt', 'vence {when}', { when: fmtWhen(inv.expiresAt) });
      name.appendChild(meta);
      const actions = document.createElement('div');
      actions.className = 'users-actions';
      const rev = document.createElement('button');
      rev.className = 'btn-ghost btn--sm btn--danger';
      rev.textContent = t('system.users.revoke', 'revocar');
      rev.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: t('system.users.revokeInviteTitle', 'Revocar invitación'),
          message: t('system.users.revokeInviteMessage', 'El token dejará de servir.'),
          confirmLabel: t('system.users.revokeConfirm', 'Revocar'),
          danger: true,
        });
        if (!ok) return;
        try {
          await revokeInvite(inv.id);
        } catch (e) {
          msg(e.message);
        }
      });
      actions.appendChild(rev);
      row.append(name, actions);
      refs.invlist.append(row);
    }
  }

  async function revokeInvite(id) {
    await onboardApi('/admin/invite/' + encodeURIComponent(id) + '/revoke', { method: 'POST' });
    loadInvites();
  }

  async function update(username, body) {
    try {
      await api('/users/' + encodeURIComponent(username), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      msg(t('system.users.userUpdated', 'Usuario actualizado.'), true);
      await load();
      return true;
    } catch (e) {
      msg(e.message);
      return false;
    }
  }

  async function remove(username, afterDelete = null) {
    const ok = await confirmDialog({
      title: t('system.users.deleteUserTitle', 'Eliminar usuario'),
      message: t(
        'system.users.deleteUserMessage',
        'Se elimina la cuenta "{username}" y se cierran sus sesiones.\n\n' +
          'Su espacio de trabajo (workspace, clon del repo, chats y credenciales) se mueve a la papelera y se puede recuperar durante 30 días.\n\n' +
          'Su workspace de Pad "tenant-{username}" se borra. El Pad lo conserva como borrado y se puede restaurar desde ahí.\n\n' +
          '⚠️ Sus credenciales quedan dentro de la papelera durante esos 30 días.',
        { username },
      ),
      confirmLabel: t('system.users.deleteConfirm', 'Eliminar'),
      danger: true,
    });
    if (!ok) return false;
    try {
      const result = await api('/users/' + encodeURIComponent(username), { method: 'DELETE' });
      const cleanup = result?.cleanup ?? {};
      const lines = [t('system.users.cleanupLead', 'La cuenta se eliminó. Sobre la limpieza:')];
      let title = t('system.users.userDeleted', 'Usuario eliminado.');

      if (cleanup?.ok === false) {
        title = t('system.users.cleanupFailedTitle', 'Cuenta eliminada; limpieza fallida');
        lines.push(t(
          'system.users.cleanupFailed',
          '❌ Error de limpieza: {error}',
          { error: cleanup?.error ?? t('system.users.cleanupUnknownError', 'Error sin detalle.') },
        ));
      } else {
        const trashStatus = cleanup?.trash?.status ?? '';
        if (trashStatus === 'moved') {
          lines.push(t('system.users.cleanupTrashMoved', 'Espacio movido a la papelera (recuperable 30 días)'));
        } else if (trashStatus === 'absent') {
          lines.push(t('system.users.cleanupTrashAbsent', 'No tenía espacio en disco'));
        }

        const padStatus = cleanup?.pad?.status ?? '';
        const padSlug = cleanup?.pad?.slug ?? `tenant-${username}`;
        if (padStatus === 'deleted') {
          lines.push(t('system.users.cleanupPadDeleted', 'Workspace de Pad {slug} eliminado', { slug: padSlug }));
        } else if (padStatus === 'not-found') {
          lines.push(t('system.users.cleanupPadAbsent', 'No tenía workspace de Pad'));
        } else if (padStatus === 'no-token') {
          lines.push(t('system.users.cleanupPadNoToken', '⚠️ Sin credencial de Pad: su workspace {slug} sigue existiendo', { slug: padSlug }));
        } else if (padStatus === 'failed') {
          lines.push(t(
            'system.users.cleanupPadFailed',
            '⚠️ No se pudo borrar su workspace de Pad: {error}',
            { error: cleanup?.pad?.error ?? t('system.users.cleanupUnknownError', 'Error sin detalle.') },
          ));
        }

        const removedJobs = Array.isArray(cleanup?.jobs?.removed) ? cleanup.jobs.removed : [];
        if (removedJobs.length) {
          lines.push(t(
            'system.users.cleanupJobsRemoved',
            '{count} archivo(s) de trabajos eliminado(s)',
            { count: removedJobs.length },
          ));
        }

        const revokedInvites = Number.isFinite(cleanup?.invites?.revoked) ? cleanup.invites.revoked : 0;
        if (revokedInvites) {
          lines.push(t(
            'system.users.cleanupInvitesRevoked',
            '{count} invitación(es) revocada(s)',
            { count: revokedInvites },
          ));
        }

        const warnings = Array.isArray(cleanup?.warnings) ? cleanup.warnings : [];
        for (const warning of warnings) {
          lines.push(`⚠️ ${warning}`);
        }

        if (lines.length === 1) {
          lines.push(t('system.users.cleanupNoReport', '⚠️ El servidor no devolvió detalles de la limpieza.'));
        }
      }

      msg(t('system.users.userDeleted', 'Usuario eliminado.'), true);
      await load();
      afterDelete?.();
      await alertDialog({ title, message: lines.join('\n') });
      return true;
    } catch (e) {
      msg(e.message);
      return false;
    }
  }

  refs.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = refs.user.value.trim();
    const password = refs.pass.value;
    const admin = refs.admin.checked;
    if (!username || !password) return;
    try {
      await api('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, admin }),
      });
      msg(t('system.users.userCreated', 'Usuario creado.'), true);
      refs.form.reset();
      load();
    } catch (err) {
      msg(err.message);
    }
  });

  refs.invform.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const admin = refs.invadmin.checked;
      const sponsored = refs.invsponsored.checked;
      const payload = { admin, sponsored };
      if (sponsored && refs.invsponsor.value) payload.sponsor = refs.invsponsor.value;
      const { invite } = await onboardApi('/admin/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      showInviteToken(invite);
      refs.invadmin.checked = false;
      refs.invsponsored.checked = false;
      syncInviteSponsors();
      loadInvites();
    } catch (err) {
      msg(err.message);
    }
  });

  refs.invadmin.addEventListener('change', () => {
    if (refs.invadmin.checked) refs.invsponsored.checked = false;
    syncInviteSponsors();
  });
  refs.invsponsored.addEventListener('change', () => {
    if (refs.invsponsored.checked) refs.invadmin.checked = false;
    syncInviteSponsors();
  });

  load();
  loadInvites();
}
