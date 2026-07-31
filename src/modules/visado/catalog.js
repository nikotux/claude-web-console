// Este archivo define el conjunto CERRADO de operaciones pedibles desde una sala
// 🛃 Aduana. Un `opId` que no esté acá NO existe y no hay forma de pedirlo.
// Los parámetros se ELIGEN de listas que genera el servidor, nunca se escriben.
// El campo `gate` es la MISMA referencia de función que protege el endpoint HTTP
// correspondiente: nunca una copia de la condición, porque dos copias divergen
// (convención CONVE-2085 del repo).
import { isAdmin } from '../../core/auth.js';
import { isHostAdmin } from '../tolkien/gates.js';
import {
  opRefreshData, opProvisionEnv, opTeardownEnv, opFetch, opUpdate, opRebaseBranch, status,
} from '../tolkien/index.js';
import { listEnvs, isEnvAlive } from '../tolkien/env-store.js';

export const CATALOG_CONTRACT_VERSION = 1;

// La rama actual es el ÚNICO valor válido para rebasar: el endpoint ya rechaza
// cualquier otra (solo rebasa la rama en la que estás parado) y main no se
// rebasa sobre sí misma. Por eso la lista tiene 0 o 1 elementos, nunca más.
async function currentBranchOptions() {
  try {
    const st = await status();
    const b = st?.branch;
    if (!b || b === 'main' || b === 'HEAD') return [];
    return [{ value: b, label: b }];
  } catch {
    return [];
  }
}

// Base desde la que se crea el worktree de un entorno efímero.
async function envBaseOptions() {
  try {
    const st = await status();
    const opts = [{ value: 'main', label: 'main' }];
    const b = st?.branch;
    if (b && b !== 'main' && b !== 'HEAD') opts.push({ value: b, label: `${b} (rama actual del anfitrión)` });
    return opts;
  } catch {
    return [{ value: 'main', label: 'main' }];
  }
}

// Entornos que existen y están vivos: son los únicos que tiene sentido destruir.
async function liveEnvOptions() {
  try {
    return listEnvs()
      .filter((rec) => rec && isEnvAlive(rec))
      .map((rec) => ({ value: rec.id, label: `${rec.id} · puerto ${rec.port ?? '?'} · ${rec.status ?? 'desconocido'}` }));
  } catch {
    return [];
  }
}

// Booleano explícito: el invitado elige entre dos opciones ROTULADAS, no marca
// un checkbox. La consecuencia de `force` viaja en el propio `warn`, para que
// quien aprueba la lea sin tener que saber qué significa la palabra.
async function forceOptions() {
  return [
    { value: false, label: 'No — cancelar si el entorno tiene cambios sin commitear' },
    { value: true, label: 'Sí — descartar los cambios sin commitear', warn: 'Descarta cambios sin commitear del entorno. No se pueden recuperar.' },
  ];
}

export const CATALOG = Object.freeze({
  'tolkien.data.refresh': Object.freeze({
    label: 'Refrescar los datos locales de Tolkien',
    world: 'tolkien-host',
    gate: isHostAdmin,
    params: Object.freeze([]),
    render: () => ({
      method: 'POST',
      path: '/api/tolkien/refresh-data',
      body: {},
    }),
    run: () => opRefreshData(),
  }),
  'tolkien.git.fetch': Object.freeze({
    label: 'Traer cambios del remoto (fetch)',
    world: 'tolkien-host',
    gate: isAdmin,
    params: Object.freeze([]),
    render: () => ({
      method: 'POST',
      path: '/api/tolkien/fetch',
      body: {},
    }),
    run: () => opFetch(),
  }),
  'tolkien.git.update': Object.freeze({
    label: 'Actualizar el repo local',
    world: 'tolkien-host',
    gate: isAdmin,
    params: Object.freeze([]),
    render: () => ({
      method: 'POST',
      path: '/api/tolkien/update',
      body: {},
    }),
    run: () => opUpdate(),
  }),
  'tolkien.git.rebaseBranch': Object.freeze({
    label: 'Rebasar la rama actual sobre main',
    world: 'tolkien-host',
    gate: isAdmin,
    params: Object.freeze([
      Object.freeze({ name: 'branch', label: 'Rama', options: currentBranchOptions }),
    ]),
    render: (p) => ({
      method: 'POST',
      path: '/api/tolkien/rebase-branch',
      body: { branch: p.branch },
      argv: ['git', '-C', '<repo de Tolkien>', 'rebase', 'origin/main'],
    }),
    run: (p) => opRebaseBranch(p.branch),
  }),
  'tolkien.env.provision': Object.freeze({
    label: 'Crear un entorno de prueba',
    world: 'tolkien-host',
    gate: isHostAdmin,
    // `chatId` no es un parámetro: el servidor lo fija con `ctx.salaId`.
    // En la versión 1, `packageRef` también queda fijado en `null`.
    params: Object.freeze([
      Object.freeze({ name: 'base', label: 'Base', options: envBaseOptions }),
    ]),
    render: (p) => ({
      method: 'POST',
      path: '/api/tolkien/envs/provision',
      body: { chatId: p.chatId ?? '(lo fija el servidor)', base: p.base },
    }),
    run: (p, ctx) => opProvisionEnv({ chatId: ctx.salaId, base: p.base, packageRef: null }),
  }),
  'tolkien.env.teardown': Object.freeze({
    label: 'Destruir un entorno de prueba',
    world: 'tolkien-host',
    gate: isHostAdmin,
    params: Object.freeze([
      Object.freeze({ name: 'id', label: 'Entorno', options: liveEnvOptions }),
      Object.freeze({ name: 'force', label: '¿Descartar cambios sin commitear?', options: forceOptions }),
    ]),
    render: (p) => ({
      method: 'POST',
      path: `/api/tolkien/envs/${p.id}/teardown`,
      body: { force: p.force },
    }),
    run: (p) => opTeardownEnv(p.id, p.force),
  }),
});

// Resolución por PERTENENCIA sobre el objeto congelado. Nunca se indexa el
// catálogo con un id sin pasar por acá: un opId que no esté declarado no
// existe, y no hay despacho dinámico que pueda inventarlo.
export function getOp(opId) {
  if (typeof opId !== 'string') return null;
  if (!Object.hasOwn(CATALOG, opId)) return null;
  return CATALOG[opId];
}

export function listOpIds() {
  return Object.keys(CATALOG);
}

// Resuelve las opciones VIGENTES de cada parámetro de una operación.
// Se llama en los tres momentos (emitir, aprobar, ejecutar): nunca se
// valida contra una lista guardada, porque una lista guardada es una foto
// vieja y el entorno que el invitado eligió pudo desaparecer entretanto.
export async function resolveOptions(opId, ctx = {}) {
  const op = getOp(opId);
  if (!op) return null;
  const out = {};
  for (const spec of op.params) {
    out[spec.name] = await spec.options(ctx);
  }
  return out;
}

// Valida un juego de params contra las opciones VIGENTES. Devuelve
// { ok: true, params } con los valores tomados de la lista del servidor
// (no los del cliente), o { ok: false, code, detail }.
export async function validateParams(opId, raw, ctx = {}) {
  const op = getOp(opId);
  if (!op) return { ok: false, code: 'op_desconocida', detail: String(opId) };
  const input = raw && typeof raw === 'object' ? raw : {};
  const params = {};
  for (const spec of op.params) {
    if (!Object.hasOwn(input, spec.name)) {
      return { ok: false, code: 'param_faltante', detail: spec.name };
    }
  }
  for (const spec of op.params) {
    const options = await spec.options(ctx);
    // La comparación es estricta a propósito: por ejemplo, el string `'true'`
    // enviado por un formulario no coincide con el booleano `true` del servidor.
    const match = options.find((o) => o.value === input[spec.name]);
    if (!match) {
      return { ok: false, code: 'param_fuera_de_catalogo', detail: spec.name };
    }
    // Se conserva el valor de la lista del servidor, nunca el valor del cliente.
    params[spec.name] = match.value;
  }
  return { ok: true, params };
}
