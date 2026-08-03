// Cola persistente de aprobaciones del dueño de salas Aduana.
import { openModal } from '../../ui/dialog.js';
import { helpBtn } from '../../ui/help.js';
import { icon } from '../../ui/icons.js';
import { t } from '../../ui/i18n.js';
import {
  aprobarPeticion, fetchPeticiones, rechazarPeticion,
} from './api.js';

const STATE_ORDER = [
  'pendiente', 'aprobada', 'ejecutando', 'ejecutada', 'fallida', 'rechazada', 'caducada', 'cancelada',
];

function stateMeta(state) {
  const states = {
    pendiente: [t('visado.estado.pendiente', 'Pendiente'), 'var(--cwc-warn)'],
    aprobada: [t('visado.estado.aprobada', 'Aprobada'), 'var(--cwc-info)'],
    ejecutando: [t('visado.estado.ejecutando', 'Ejecutando'), 'var(--cwc-accent)'],
    ejecutada: [t('visado.estado.ejecutada', 'Ejecutada'), 'var(--cwc-ok)'],
    fallida: [t('visado.estado.fallida', 'Fallida'), 'var(--cwc-danger-strong)'],
    rechazada: [t('visado.estado.rechazada', 'Rechazada'), 'var(--cwc-danger)'],
    caducada: [t('visado.estado.caducada', 'Caducada'), 'var(--cwc-text-dim)'],
    cancelada: [t('visado.estado.cancelada', 'Cancelada'), 'var(--cwc-text-dimmer)'],
  };
  const [label, color] = states[state] || [
    t('visado.estado.otro', 'Otro estado'),
    'var(--cwc-text-dim)',
  ];
  return { label, color };
}

function personOf(request) {
  return request.solicitante?.nombre
    || request.solicitante?.userId
    || t('visado.persona.desconocida', 'Persona desconocida');
}

function formatWhen(value) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return t('visado.fecha.desconocida', 'Fecha desconocida');
  return new Intl.DateTimeFormat(document.documentElement.lang || 'es', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function errorMessage(error) {
  const messages = {
    huella_no_coincide: t(
      'visado.error.huellaNoCoincide',
      'La petición cambió desde que la abriste. Cerrala y volvé a abrirla.',
    ),
    autoaprobacion: t('visado.error.autoaprobacion', 'No podés aprobar tu propia petición.'),
    sin_autoridad: t(
      'visado.error.sinAutoridad',
      'No tenés permiso para ejecutar esta operación.',
    ),
    opcion_desaparecida: t(
      'visado.error.opcionDesaparecida',
      'Lo que se eligió ya no existe. Hay que volver a pedirlo.',
    ),
    estado_invalido: t('visado.error.estadoInvalido', 'La petición ya fue decidida o cambió de estado.'),
    no_existe: t('visado.error.noExiste', 'La petición ya no existe.'),
  };
  return messages[error?.code]
    || error?.message
    || t('visado.error.generico', 'No se pudo completar la acción.');
}

function makeSection(title) {
  const section = document.createElement('section');
  section.className = 'tk-sec';
  const heading = document.createElement('div');
  heading.className = 'tk-sec-h';
  heading.textContent = title;
  const body = document.createElement('div');
  body.className = 'tk-sec-b';
  section.append(heading, body);
  return { section, body };
}

function askRejectReason() {
  return new Promise((resolve) => {
    let settled = false;
    const modal = openModal({
      title: t('visado.rechazo.titulo', 'Rechazar petición'),
      width: 480,
      onClose: () => {
        if (!settled) resolve(null);
      },
    });
    const message = document.createElement('p');
    message.className = 'dlg-msg';
    message.textContent = t('visado.rechazo.nota', 'Podés dejar un motivo; es opcional.');
    const reason = document.createElement('textarea');
    reason.className = 'dlg-editor-text';
    reason.maxLength = 2000;
    reason.rows = 4;
    reason.setAttribute('aria-label', t('visado.rechazo.motivo', 'Motivo del rechazo'));
    const actions = document.createElement('div');
    actions.className = 'dlg-actions';
    const cancel = document.createElement('button');
    cancel.className = 'btn-ghost';
    cancel.textContent = t('visado.rechazo.cancelar', 'Cancelar');
    const reject = document.createElement('button');
    reject.className = 'btn btn--danger';
    reject.innerHTML = `${icon('close', { size: 14 })}<span>${t('visado.rechazo.confirmar', 'Rechazar')}</span>`;
    actions.append(cancel, reject);
    modal.body.append(message, reason, actions);
    cancel.addEventListener('click', () => modal.close());
    reject.addEventListener('click', () => {
      settled = true;
      resolve(reason.value);
      modal.close();
    });
    reason.focus();
  });
}

function openApprovalDialog(request, { onChanged }) {
  const modal = openModal({
    title: t('visado.aprobacion.titulo', 'Revisar visado'),
    width: 720,
  });
  const content = document.createElement('div');
  content.className = 'tk-detail';

  const operation = request.operacion;
  const hasExactOperation = Boolean(
    operation
    && typeof operation.method === 'string'
    && typeof operation.path === 'string'
    && Object.hasOwn(operation, 'body'),
  );

  const exact = makeSection(t('visado.aprobacion.operacionExacta', 'La operación exacta'));
  const operationLabel = document.createElement('strong');
  operationLabel.textContent = request.label
    || t('visado.sidebar.operacionSinNombre', 'Operación sin nombre');
  exact.body.appendChild(operationLabel);

  if (hasExactOperation) {
    const endpoint = document.createElement('code');
    endpoint.textContent = `${operation.method} ${operation.path}`;
    exact.body.appendChild(endpoint);

    const bodyLabel = document.createElement('span');
    bodyLabel.className = 'bf-sub';
    bodyLabel.textContent = t('visado.aprobacion.body', 'Cuerpo enviado');
    const body = document.createElement('pre');
    body.className = 'dlg-editor-text';
    body.textContent = JSON.stringify(operation.body, null, 2);
    exact.body.append(bodyLabel, body);

    if (Array.isArray(operation.argv)) {
      const argvLabel = document.createElement('span');
      argvLabel.className = 'bf-sub';
      argvLabel.textContent = t('visado.aprobacion.argv', 'Argumentos, elemento por elemento');
      const argv = document.createElement('ol');
      for (const argument of operation.argv) {
        const item = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = String(argument);
        item.appendChild(code);
        argv.appendChild(item);
      }
      exact.body.append(argvLabel, argv);
    }
  } else {
    const missing = document.createElement('p');
    missing.className = 'hlp-note hlp-note--danger';
    missing.textContent = t(
      'visado.aprobacion.sinDetalle',
      'No se pudo determinar la operación exacta. No aprobés esta petición.',
    );
    exact.body.appendChild(missing);
  }
  content.appendChild(exact.section);

  const warnings = Array.isArray(request.advertencias) ? request.advertencias : [];
  if (warnings.length) {
    const warningSection = makeSection(t('visado.aprobacion.advertencias', 'Advertencias'));
    for (const warningText of warnings) {
      const warning = document.createElement('p');
      warning.className = 'hlp-note hlp-note--warn';
      warning.textContent = warningText;
      warningSection.body.appendChild(warning);
    }
    content.appendChild(warningSection.section);
  }

  const fingerprintSection = makeSection(t('visado.aprobacion.huella', 'Huella'));
  const fingerprint = document.createElement('code');
  fingerprint.textContent = request.fingerprint || t('visado.aprobacion.sinHuella', 'Sin huella');
  fingerprintSection.body.appendChild(fingerprint);
  content.appendChild(fingerprintSection.section);

  // La explicación humana queda deliberadamente separada de la orden: si se
  // mezclaran visualmente, quien aprueba podría leer como parte de la operación
  // algo que nadie va a ejecutar.
  const person = personOf(request);
  const reasonSection = makeSection(t('visado.aprobacion.dichoPor', 'Dicho por {persona}', { persona: person }));
  const reasonLabel = document.createElement('strong');
  reasonLabel.textContent = t(
    'visado.aprobacion.motivoRotulo',
    'Esto lo escribió {persona}. Es su explicación, no parte de la operación.',
    { persona: person },
  );
  const reason = document.createElement('p');
  reason.className = 'dlg-msg';
  reason.textContent = request.motivo || t('visado.aprobacion.sinMotivo', 'No dejó una explicación.');
  reasonSection.body.append(reasonLabel, reason);
  content.appendChild(reasonSection.section);

  const error = document.createElement('p');
  error.className = 'bf-err';
  error.hidden = true;
  const actions = document.createElement('div');
  actions.className = 'dlg-actions';
  const reject = document.createElement('button');
  reject.className = 'btn-ghost btn--danger';
  reject.innerHTML = `${icon('close', { size: 14 })}<span>${t('visado.aprobacion.rechazar', 'Rechazar')}</span>`;
  const approve = document.createElement('button');
  approve.className = 'btn';
  approve.disabled = !hasExactOperation;
  approve.innerHTML = `${icon('check', { size: 14 })}<span>${t('visado.aprobacion.aprobar', 'Aprobar')}</span>`;
  if (!hasExactOperation) {
    approve.title = t('visado.aprobacion.aprobarBloqueado', 'Falta el detalle exacto de la operación.');
  }
  actions.append(reject, approve);
  content.append(error, actions);
  modal.body.appendChild(content);

  const setBusy = (busy) => {
    approve.disabled = busy || !hasExactOperation;
    reject.disabled = busy;
  };
  const showActionError = (requestError) => {
    error.textContent = errorMessage(requestError);
    error.hidden = false;
  };

  approve.addEventListener('click', async () => {
    error.hidden = true;
    setBusy(true);
    try {
      await aprobarPeticion(request.id, request.fingerprint);
      modal.close();
      onChanged?.();
    } catch (requestError) {
      showActionError(requestError);
      setBusy(false);
    }
  });

  reject.addEventListener('click', async () => {
    const reasonText = await askRejectReason();
    if (reasonText === null || !modal.overlay.isConnected) return;
    error.hidden = true;
    setBusy(true);
    try {
      await rechazarPeticion(request.id, reasonText);
      modal.close();
      onChanged?.();
    } catch (requestError) {
      showActionError(requestError);
      setBusy(false);
    }
  });
}

export default {
  name: 'visado',

  mount(el, ctx) {
    el.innerHTML = `
      <header class="sec-head" data-ref="header" role="button" tabindex="0" aria-expanded="false">
        <button class="btn-ghost btn--sm btn--icon" data-ref="toggle" type="button" title="${t('visado.sidebar.desplegar', 'Mostrar u ocultar visados')}">${icon('chevronRight', { size: 13 })}</button>
        <span class="sec-title">${t('visado.sidebar.titulo', '🛂 Visados')}</span>
        <span class="side-count" data-ref="count">0</span>
        <span class="bf-sub" data-ref="status">${t('visado.sidebar.sinCargar', 'sin cargar')}</span>
        ${helpBtn('visado')}
      </header>
      <div class="tk-card" data-ref="body" hidden>
        <div class="bf-sub" data-ref="loading">${t('visado.sidebar.cargando', 'cargando…')}</div>
        <div data-ref="groups"></div>
        <p class="bf-err" data-ref="error" hidden></p>
      </div>`;

    const refs = {};
    for (const ref of el.querySelectorAll('[data-ref]')) refs[ref.dataset.ref] = ref;

    let open = false;
    let loading = false;
    let timer = null;
    let requests = [];

    const labelFor = (request) => request.label
      || t('visado.sidebar.operacionSinNombre', 'Operación sin nombre');

    function render() {
      refs.groups.replaceChildren();
      const pending = requests.filter((request) => request.estado === 'pendiente').length;
      refs.count.textContent = String(pending);
      el.classList.toggle('visado--pendientes', pending > 0);
      refs.count.style.color = pending > 0 ? 'var(--cwc-warn)' : '';
      if (pending > 0) {
        const pendingAria = t(
          'visado.sidebar.pendientesAria',
          '{count} petición(es) esperando tu decisión',
          { count: pending },
        );
        refs.header.title = pendingAria;
        refs.header.setAttribute('aria-label', pendingAria);
      } else {
        refs.header.removeAttribute('title');
        refs.header.removeAttribute('aria-label');
      }
      refs.status.textContent = pending
        ? t('visado.sidebar.pendientes', '{n} pendiente(s)', { n: pending })
        : t('visado.sidebar.sinPendientes', 'sin pendientes');

      if (!requests.length) {
        const empty = document.createElement('p');
        empty.className = 'bf-sub';
        empty.textContent = t('visado.sidebar.vacia', 'No hay peticiones de visado.');
        refs.groups.appendChild(empty);
        return;
      }

      const grouped = new Map();
      for (const request of requests) {
        if (!grouped.has(request.estado)) grouped.set(request.estado, []);
        grouped.get(request.estado).push(request);
      }
      const orderedStates = [...grouped.keys()].sort((a, b) => {
        const ai = STATE_ORDER.indexOf(a);
        const bi = STATE_ORDER.indexOf(b);
        return (ai === -1 ? STATE_ORDER.length : ai) - (bi === -1 ? STATE_ORDER.length : bi);
      });

      for (const state of orderedStates) {
        const meta = stateMeta(state);
        const group = document.createElement('details');
        group.className = 'tk-sec';
        group.open = state === 'pendiente';
        const summary = document.createElement('summary');
        summary.className = 'tk-sec-h';
        summary.textContent = t('visado.sidebar.grupo', '{estado} · {n}', {
          estado: meta.label,
          n: grouped.get(state).length,
        });
        const rows = document.createElement('div');
        rows.className = 'tk-sec-b';

        for (const request of grouped.get(state)) {
          const row = document.createElement('div');
          row.className = 'task-item';
          row.style.borderLeftColor = meta.color;
          const top = document.createElement('div');
          top.className = 'task-item-top';
          const title = document.createElement('span');
          title.className = 'task-item-title';
          title.textContent = labelFor(request);
          const badge = document.createElement('span');
          badge.className = 'bb-chip';
          badge.style.color = meta.color;
          badge.style.borderColor = meta.color;
          badge.textContent = meta.label;
          top.append(title, badge);
          const detail = document.createElement('div');
          detail.className = 'task-desc';
          detail.textContent = t('visado.sidebar.solicitud', 'Pedido por {persona} · {cuando}', {
            persona: personOf(request),
            cuando: formatWhen(request.creadoAt),
          });
          row.append(top, detail);

          if (state === 'pendiente') {
            row.setAttribute('role', 'button');
            row.tabIndex = 0;
            row.title = t('visado.sidebar.abrir', 'Abrir petición para decidir');
            const openRequest = () => openApprovalDialog(request, {
              onChanged: load,
            });
            row.addEventListener('click', openRequest);
            row.addEventListener('keydown', (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              openRequest();
            });
          }
          rows.appendChild(row);
        }
        group.append(summary, rows);
        refs.groups.appendChild(group);
      }
    }

    async function load() {
      if (loading) return;
      loading = true;
      refs.error.hidden = true;
      if (!requests.length) refs.loading.hidden = false;
      try {
        const next = await fetchPeticiones();
        requests = Array.isArray(next) ? next : [];
        render();
      } catch (requestError) {
        refs.error.textContent = requestError?.message
          || t('visado.sidebar.error', 'No se pudo cargar la cola de visados.');
        refs.error.hidden = false;
        refs.status.textContent = t('visado.sidebar.errorEstado', 'error al cargar');
      } finally {
        loading = false;
        refs.loading.hidden = true;
      }
    }

    function stopPolling() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    }

    function startPolling(everyMs) {
      stopPolling();
      timer = window.setInterval(() => {
        if (!document.hidden) load();
      }, everyMs);
    }

    function setOpen(nextOpen) {
      open = nextOpen;
      refs.body.hidden = !open;
      refs.header.setAttribute('aria-expanded', String(open));
      refs.toggle.innerHTML = icon(open ? 'chevronDown' : 'chevronRight', { size: 13 });
      if (open) {
        load();
        startPolling(15_000);
      } else {
        // El polling NO se apaga al plegar el panel: el contador del header ES el aviso.
        // Si se detuviera, una petición que llega con el panel cerrado sería invisible
        // hasta que alguien lo abriera a mano — y caducaría a las 24 h sin que nadie la viera.
        startPolling(60_000);
      }
    }

    refs.header.addEventListener('click', () => setOpen(!open));
    refs.header.addEventListener('keydown', (event) => {
      if (event.target !== refs.header) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      setOpen(!open);
    });

    // Carga inicial para que el contador del header sea útil aun cuando el cuerpo nace plegado.
    load();
    startPolling(60_000);
  },
};
