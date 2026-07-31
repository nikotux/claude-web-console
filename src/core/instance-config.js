// core/instance-config.js — capa de CONFIG DE INSTANCIA (identidad + cliente).
//
// Separa del CÓDIGO lo que es específico de CADA instalación (quién sos, qué
// cliente/departamento Zoho/servidor MCP usás) para que otra persona pueda
// correr su propia consola sin heredar la identidad de Nico. Vive en
// ~/.cwc-data/instance.json — fuera del repo, NO se versiona, escritura
// atómica (mismo patrón que el resto del estado durable del proyecto).
//
// Precedencia: instance.json > DEFAULTS (= la identidad ACTUAL de Nico, así
// una instalación existente sin instance.json se comporta EXACTAMENTE igual
// que antes de este refactor — retrocompat total, ver TASK-402).
//
// Esto es la capa 2 de las "4 capas" de PEND-377 (config de instancia); NO
// incluye secretos (capa 4, ver .env / CWC_TOKEN) ni identidad de EQUIPO
// (capa 3, users.json — eso es multiusuario real, C3/PEND-382, fuera de
// alcance acá).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';

// Default EXCLUSIVO del HOST: core/config.js y bin/cwc-setup.js corren en el
// proceso del server/CLI del host y mantienen su comportamiento histórico.
// Todo caller que actúe en nombre de un principal DEBE pasar su dataDir resuelto.
const HOST_DATA_DIR = path.join(os.homedir(), '.cwc-data');

function fileFor(dataDir) {
  return path.join(dataDir || HOST_DATA_DIR, 'instance.json');
}

// Defaults GENÉRICOS (placeholders vacíos). Cada instalación fija sus valores
// reales en ~/.cwc-data/instance.json — desde el wizard (bin/cwc-setup.js) o
// el panel ⚙ Sistema → Variables de entorno. Los defaults solo se usan para
// poblar instance.json la PRIMERA vez y como piso del merge; una instalación
// ya configurada nunca los ve (su instance.json manda, ver deepMerge).
const DEFAULTS = {
  identity: {
    name: '',
    email: '',
    github: '',
    signature: '',
  },
  client: {
    // Nombre del server MCP que expone las tools desk_*/graph_* del proyecto
    // trackeado (ver el .mcp.json de ese proyecto). Vacío = sin integración.
    mcpServerId: '',
    // ID del proyecto Infisical (vault de secretos) que usa el MCP, si aplica.
    infisicalProjectId: '',
    // IDs de departamento de Zoho Desk que alimentan el tablero de tickets.
    // Claves libres por instancia (ej. { soporte: '...', clientes: '...' }).
    zohoDepartments: {},
    // Persona de referencia externa (reviewer de PRs / contacto seed del motor
    // Comunicaciones). 'contactId' es la clave interna usada por el tablero de
    // tickets; se puede dejar en 'reviewer'.
    reviewer: { name: '', github: '', contactId: 'reviewer' },
  },
};

function readRaw(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

// Merge profundo por UNION de claves: conserva tanto las de `base` (defaults)
// como las de `over` (instance.json). Iterar solo las de `base` perdería las
// claves que existen únicamente en instance.json (p.ej. departamentos Zoho
// propios de la instancia cuando los defaults están vacíos).
function deepMerge(base, over) {
  if (!isPlainObject(over)) return isPlainObject(base) ? { ...base } : base;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const k of new Set([...Object.keys(out), ...Object.keys(over)])) {
    out[k] = isPlainObject(out[k]) && isPlainObject(over[k])
      ? deepMerge(out[k], over[k])
      : (over[k] !== undefined ? over[k] : out[k]);
  }
  return out;
}

// La caché va por archivo (ruta absoluta), nunca global: una caché única haría
// que el instance.json de un inquilino pudiera contaminar el scope del host.
const cacheByFile = new Map();

// Lee instance.json mergeado sobre DEFAULTS. Se autogenera con los DEFAULTS
// al primer arranque si no existe (migración): una instalación existente
// queda byte-idéntica en comportamiento tras el deploy de este refactor.
export function loadInstance({ force, dataDir } = {}) {
  const file = fileFor(dataDir);
  if (cacheByFile.has(file) && !force) return cacheByFile.get(file);
  let raw = readRaw(file);
  if (!raw) {
    raw = DEFAULTS;
    try { writeJsonAtomic(file, raw, { space: 2 }); } catch { /* best-effort: si falla, sigue con DEFAULTS en memoria */ }
  }
  const instance = deepMerge(DEFAULTS, raw);
  cacheByFile.set(file, instance);
  return instance;
}

// Persiste un patch (deep-merge sobre lo existente) y refresca el caché en
// memoria. Lo usa el panel admin "Variables de entorno" — NUNCA toca
// secretos (esos viven en .env, capa aparte).
export function saveInstance(patch, { dataDir } = {}) {
  const file = fileFor(dataDir);
  const current = deepMerge(DEFAULTS, readRaw(file) || {});
  const next = deepMerge(current, patch);
  // zohoDepartments lo controla el panel por COMPLETO (envía el set entero):
  // un deep-merge nunca borra una clave quitada, así que si el patch lo trae
  // se reemplaza wholesale para que agregar Y quitar departamentos funcione.
  if (isPlainObject(patch?.client?.zohoDepartments)) {
    next.client.zohoDepartments = { ...patch.client.zohoDepartments };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, next, { space: 2 });
  cacheByFile.set(file, next);
  return next;
}

export function instanceFilePath(dataDir) { return fileFor(dataDir); }
export function instanceDefaults() { return DEFAULTS; }
