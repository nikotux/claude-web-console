// Formulario de petición para participantes invitados de una sala Aduana.
import { openModal } from '../../ui/dialog.js';
import { icon } from '../../ui/icons.js';
import { t } from '../../ui/i18n.js';
import { crearPeticion, fetchCatalogo } from './api.js';

function makeField(labelText) {
  const field = document.createElement('label');
  field.className = 'task-fld';
  const label = document.createElement('span');
  label.textContent = labelText;
  field.appendChild(label);
  return field;
}

function showError(el, error) {
  el.textContent = error?.message || t('visado.peticion.error', 'No se pudo enviar la petición.');
  el.hidden = false;
}

export function openPeticionDialog({ salaId, onDone } = {}) {
  const modal = openModal({
    title: t('visado.peticion.titulo', 'Pedir una operación'),
    width: 620,
  });

  const form = document.createElement('form');
  form.className = 'task-form';

  const operationField = makeField(t('visado.peticion.operacion', 'Operación'));
  const loading = document.createElement('span');
  loading.className = 'bf-sub';
  loading.innerHTML = `${icon('clock', { size: 12 })}<span>${t('visado.peticion.cargando', 'Cargando operaciones…')}</span>`;
  const operationSelect = document.createElement('select');
  operationSelect.disabled = true;
  operationField.append(loading, operationSelect);

  const paramsHost = document.createElement('div');
  paramsHost.className = 'task-form';

  const reasonSection = document.createElement('section');
  reasonSection.className = 'tk-sec';
  const reasonTitle = document.createElement('div');
  reasonTitle.className = 'tk-sec-h';
  reasonTitle.textContent = t('visado.peticion.motivoTitulo', '¿Por qué lo pedís?');
  const reasonBody = document.createElement('div');
  reasonBody.className = 'tk-sec-b';
  const reasonNote = document.createElement('p');
  reasonNote.className = 'dlg-editor-hint';
  reasonNote.textContent = t(
    'visado.peticion.motivoNota',
    'Esto lo lee la persona que aprueba; no forma parte de la operación.',
  );
  const reason = document.createElement('textarea');
  reason.className = 'dlg-editor-text';
  reason.maxLength = 2000;
  reason.rows = 4;
  reason.setAttribute('aria-label', t('visado.peticion.motivoAria', 'Motivo de la petición'));
  reasonBody.append(reasonNote, reason);
  reasonSection.append(reasonTitle, reasonBody);

  const error = document.createElement('p');
  error.className = 'bf-err';
  error.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'dlg-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn-ghost';
  cancel.textContent = t('visado.peticion.cancelar', 'Cancelar');
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn';
  submit.disabled = true;
  submit.innerHTML = `${icon('check', { size: 14 })}<span>${t('visado.peticion.pedir', 'Pedir')}</span>`;
  actions.append(cancel, submit);

  form.append(operationField, paramsHost, reasonSection, error, actions);
  modal.body.appendChild(form);

  let operations = [];

  // Propiedad central del visado: cada parámetro se ELIGE de una lista
  // entregada por el servidor; jamás se crea un campo de texto para parámetros.
  function renderParams() {
    paramsHost.replaceChildren();
    const operation = operations.find((item) => item.opId === operationSelect.value);
    submit.disabled = !operation?.pedible;
    if (!operation) return;

    if (!operation.params?.length) {
      const empty = document.createElement('p');
      empty.className = 'bf-sub';
      empty.textContent = t('visado.peticion.sinParametros', 'Esta operación no tiene parámetros para elegir.');
      paramsHost.appendChild(empty);
      return;
    }

    for (const param of operation.params) {
      const field = makeField(param.label);
      const select = document.createElement('select');
      select.dataset.param = param.name;
      const warning = document.createElement('p');
      warning.className = 'hlp-note hlp-note--warn';
      warning.hidden = true;

      (param.options || []).forEach((option, index) => {
        const label = option.warn
          ? t('visado.peticion.opcionConAviso', '{opcion} — advertencia: {aviso}', {
            opcion: option.label,
            aviso: option.warn,
          })
          : option.label;
        select.add(new Option(label, String(index)));
      });

      const updateWarning = () => {
        const selected = param.options?.[Number(select.value)];
        warning.textContent = selected?.warn || '';
        warning.hidden = !selected?.warn;
      };
      select.addEventListener('change', updateWarning);
      updateWarning();
      field.append(select, warning);
      paramsHost.appendChild(field);
    }
  }

  operationSelect.addEventListener('change', renderParams);
  cancel.addEventListener('click', () => modal.close());

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    const operation = operations.find((item) => item.opId === operationSelect.value);
    if (!operation?.pedible) return;

    const params = {};
    for (const param of operation.params || []) {
      const select = paramsHost.querySelector(`[data-param="${CSS.escape(param.name)}"]`);
      const selected = param.options?.[Number(select?.value)];
      if (!selected) {
        showError(error, new Error(t('visado.peticion.parametroFaltante', 'Elegí una opción para cada parámetro.')));
        return;
      }
      // Se conserva el tipo original (boolean, número o string) de la opción;
      // el value textual del <select> es solo su índice en la lista recibida.
      params[param.name] = selected.value;
    }

    submit.disabled = true;
    cancel.disabled = true;
    try {
      const created = await crearPeticion({
        salaId,
        opId: operation.opId,
        params,
        motivo: reason.value,
      });
      modal.close();
      onDone?.(created);
    } catch (requestError) {
      showError(error, requestError);
      submit.disabled = false;
      cancel.disabled = false;
    }
  });

  fetchCatalogo(salaId)
    .then((catalog) => {
      if (!modal.overlay.isConnected) return;
      operations = Array.isArray(catalog?.ops) ? catalog.ops : [];
      operationSelect.replaceChildren();
      const placeholder = new Option(t('visado.peticion.elegirOperacion', 'Elegí una operación'), '');
      placeholder.disabled = true;
      placeholder.selected = true;
      operationSelect.add(placeholder);

      for (const operation of operations) {
        const label = operation.pedible
          ? operation.label
          : t(
            'visado.peticion.operacionNoDisponible',
            '{operacion} — no se puede pedir ahora: no hay opciones disponibles',
            { operacion: operation.label },
          );
        const option = new Option(label, operation.opId);
        option.disabled = !operation.pedible;
        operationSelect.add(option);
      }
      loading.remove();
      operationSelect.disabled = false;

      if (!operations.some((operation) => operation.pedible)) {
        const unavailable = document.createElement('p');
        unavailable.className = 'hlp-note hlp-note--warn';
        unavailable.textContent = t(
          'visado.peticion.nadaDisponible',
          'No hay operaciones que se puedan pedir ahora.',
        );
        operationField.appendChild(unavailable);
      }
    })
    .catch((requestError) => {
      if (!modal.overlay.isConnected) return;
      loading.remove();
      showError(error, requestError);
    });

  return modal;
}
