// Cliente HTTP delgado del visado. La autorización viaja por la misma sesión
// que el resto de la consola; fetch conserva por defecto las credenciales del
// mismo origen.
import { t } from '../../ui/i18n.js';

const BASE = '/api/visado';

async function request(path, { method = 'GET', body } = {}) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${BASE}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error || t('visado.api.error', 'No se pudo completar la solicitud.'));
    error.code = data?.code || 'error_http';
    error.detail = data?.detail;
    error.status = response.status;
    throw error;
  }
  return data;
}

const salaQuery = (salaId) => `?sala=${encodeURIComponent(salaId)}`;
const peticionPath = (id, action) => `/peticiones/${encodeURIComponent(id)}/${action}`;

export const fetchCatalogo = (salaId) => request(`/catalogo${salaQuery(salaId)}`);

export const fetchPeticiones = (salaId) => request(
  `/peticiones${salaId === undefined ? '' : salaQuery(salaId)}`,
);

export const crearPeticion = ({ salaId, opId, params, motivo }) => request('/peticiones', {
  method: 'POST',
  body: { salaId, opId, params, motivo },
});

export const aprobarPeticion = (id, fingerprint) => request(peticionPath(id, 'aprobar'), {
  method: 'POST',
  body: { fingerprint },
});

export const rechazarPeticion = (id, motivo = '') => request(peticionPath(id, 'rechazar'), {
  method: 'POST',
  body: { motivo },
});

export const cancelarPeticion = (id) => request(peticionPath(id, 'cancelar'), {
  method: 'POST',
});

export const fetchEstado = (salaId) => request(`/lecturas/estado${salaQuery(salaId)}`);
export const fetchRefresh = (salaId) => request(`/lecturas/refresh${salaQuery(salaId)}`);
export const fetchEntornos = (salaId) => request(`/lecturas/entornos${salaQuery(salaId)}`);
export const fetchPreview = (salaId) => request(`/lecturas/preview${salaQuery(salaId)}`);
export const fetchRamas = (salaId) => request(`/lecturas/ramas${salaQuery(salaId)}`);
