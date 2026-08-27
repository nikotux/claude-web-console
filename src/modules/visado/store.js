// modules/visado/store.js — registro persistente y máquina de estados de los
// visados. Los expedientes viven en <dataDir>/visados/<id>.json, con escritura
// atómica, y NUNCA bajo ~/.cwc-aduana/salas/: esa raíz es escribible desde la
// propia sala y permitiría que un proceso alterara su expediente para aprobarse.
//
// Este módulo NO importa core/user-space.js ni core/config.js. Lo consumen tanto
// el server como un runner desacoplado con entorno limpio, y esos imports
// arrastrarían la exigencia de CWC_TOKEN. Por la convención console:PLAN-2186,
// toda función pública recibe primero el dataDir ya resuelto por su caller.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic } from '../../core/atomic-write.js';

export const ESTADOS = Object.freeze({
  PENDIENTE: 'pendiente',
  APROBADA: 'aprobada',
  EJECUTANDO: 'ejecutando',
  EJECUTADA: 'ejecutada',
  FALLIDA: 'fallida',
  RECHAZADA: 'rechazada',
  CADUCADA: 'caducada',
  CANCELADA: 'cancelada',
});

// Transiciones válidas. Lo que no está acá, no pasa: ningún estado llega a
// ejecución sin una aprobación explícita registrada y los terminales no salen.
export const TRANSICIONES = Object.freeze({
  pendiente: Object.freeze(['aprobada', 'rechazada', 'cancelada', 'caducada']),
  aprobada: Object.freeze(['ejecutando', 'caducada']),
  ejecutando: Object.freeze(['ejecutada', 'fallida']),
  ejecutada: Object.freeze([]),
  fallida: Object.freeze([]),
  rechazada: Object.freeze([]),
  caducada: Object.freeze([]),
  cancelada: Object.freeze([]),
});

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function visadosDir(dataDir) {
  return path.join(dataDir, 'visados');
}

function peticionFile(dataDir, id) {
  return path.join(visadosDir(dataDir), `${id}.json`);
}

// Canonicalización exacta del contrato v1: pares ordenados (no un objeto),
// valores escalares únicamente y params ya validados contra el catálogo.
export function computeFingerprint(opId, params) {
  const pares = Object.keys(params || {})
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((k) => {
      const v = params[k];
      const t = typeof v;
      if (t !== 'string' && t !== 'number' && t !== 'boolean') {
        throw new Error(`visado: tipo no permitido en el parámetro "${k}": ${t}`);
      }
      return [k, v];
    });
  return crypto.createHash('sha256').update(JSON.stringify([opId, pares])).digest('hex');
}

export function crearPeticion(dataDir, {
  salaId,
  opId,
  params,
  motivo,
  solicitante,
  opcionesMostradas,
  v,
}) {
  const id = crypto.randomUUID();
  const peticion = {
    v,
    id,
    salaId,
    opId,
    params,
    fingerprint: computeFingerprint(opId, params),
    motivo,
    solicitante,
    aprobador: null,
    estado: ESTADOS.PENDIENTE,
    opcionesMostradas,
    resultado: null,
    error: null,
    creadoAt: Date.now(),
    decididoAt: null,
    iniciadoAt: null,
    terminadoAt: null,
  };
  writeJsonAtomic(peticionFile(dataDir, id), peticion, { mode: 0o600 });
  return peticion;
}

export function leerPeticion(dataDir, id) {
  // Validar antes de construir la ruta evita que un id hostil llegue al disco.
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(peticionFile(dataDir, id), 'utf8'));
  } catch {
    return null;
  }
}

export function listarPeticiones(dataDir, { salaId, estado } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(visadosDir(dataDir), { withFileTypes: true });
  } catch {
    return [];
  }

  const peticiones = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);
    const peticion = leerPeticion(dataDir, id);
    if (!peticion) continue;
    if (salaId !== undefined && peticion.salaId !== salaId) continue;
    if (estado !== undefined && peticion.estado !== estado) continue;
    peticiones.push(peticion);
  }

  return peticiones.sort((a, b) => (Number(b.creadoAt) || 0) - (Number(a.creadoAt) || 0));
}

export function transicionar(dataDir, id, desde, hacia, patch = {}) {
  const peticion = leerPeticion(dataDir, id);
  if (!peticion) return { ok: false, code: 'no_existe' };

  const actual = peticion.estado;
  // Los chequeos son deliberadamente redundantes: `desde` expresa lo que el
  // call-site cree y TRANSICIONES lo que el modelo permite. Si divergen, gana
  // siempre el más restrictivo y el código de error deja visible cuál falló.
  if (!Array.isArray(desde) || !desde.includes(actual)) {
    return { ok: false, code: 'estado_invalido', detail: actual };
  }
  if (!TRANSICIONES[actual]?.includes(hacia)) {
    return { ok: false, code: 'transicion_invalida', detail: `${actual}→${hacia}` };
  }

  const siguiente = { ...peticion, ...patch, estado: hacia };
  if (hacia === ESTADOS.APROBADA) {
    const aprobador = siguiente.aprobador;
    if (
      !aprobador
      || typeof aprobador !== 'object'
      || Array.isArray(aprobador)
      || typeof aprobador.userId !== 'string'
      || !aprobador.userId
      || typeof aprobador.nombre !== 'string'
      || !aprobador.nombre
    ) {
      return { ok: false, code: 'aprobador_requerido' };
    }
  }

  writeJsonAtomic(peticionFile(dataDir, id), siguiente, { mode: 0o600 });
  return { ok: true, peticion: siguiente };
}

export function caducarVencidas(dataDir, {
  ttlMs = 24 * 60 * 60 * 1000,
  now = Date.now(),
} = {}) {
  const caducadas = [];
  const pendientes = listarPeticiones(dataDir, { estado: ESTADOS.PENDIENTE });
  for (const peticion of pendientes) {
    if (Number(peticion.creadoAt) + ttlMs >= now) continue;
    const resultado = transicionar(
      dataDir,
      peticion.id,
      [ESTADOS.PENDIENTE],
      ESTADOS.CADUCADA,
    );
    if (resultado.ok) caducadas.push(peticion.id);
  }
  return caducadas;
}

// Gemela de caducarVencidas para el OTRO lado del ciclo: una petición que entró
// en EJECUTANDO y nunca reportó fin. El candado de estado aprobada→ejecutando
// funciona como lock, pero sin heartbeat ni PID persistido nada detecta que el
// runner murió a mitad de op.run() (kill -9, restart del servicio, reboot). La
// regla dura 2 exige que todo lo que corre en el tiempo sea recuperable: este es
// el equivalente al lockIsStale de los runners con heartbeat.
export function caducarEjecutandoVencidas(dataDir, {
  maxMs = 20 * 60 * 1000,
  now = Date.now(),
} = {}) {
  const fallidas = [];
  const ejecutando = listarPeticiones(dataDir, { estado: ESTADOS.EJECUTANDO });
  for (const peticion of ejecutando) {
    // Los expedientes anteriores pueden no tener iniciadoAt: decididoAt y
    // creadoAt permiten recuperarlos sin interpretar un timestamp inválido.
    const inicio = [peticion.iniciadoAt, peticion.decididoAt, peticion.creadoAt]
      .map(Number)
      .find((timestamp) => Number.isFinite(timestamp) && timestamp > 0);
    // Es preferible dejarla ejecutando antes que cerrar una operación vigente
    // cuando el momento de inicio no se puede determinar con seguridad.
    if (inicio === undefined || inicio + maxMs >= now) continue;
    const resultado = transicionar(
      dataDir,
      peticion.id,
      [ESTADOS.EJECUTANDO],
      ESTADOS.FALLIDA,
      {
        error: 'El runner no reportó fin a tiempo (posible caída a mitad de la operación).',
        decididoAt: now,
      },
    );
    if (resultado.ok) fallidas.push(peticion.id);
  }
  return fallidas;
}
