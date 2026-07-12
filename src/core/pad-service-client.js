// core/pad-service-client.js — cliente REST HTTP reusable al Pad LOCAL self-hosted
// (workspace `console`). Distinto de src/modules/tickets/pad-client.js (que habla con
// el Pad CLOUD de Tolkien vía MCP+OAuth de Claude Code, sin cambios, ver CLAUDE.md).
//
// MECANISMO (investigado 2026-07-12, Fase 0 de ROAD-110): el binario local del Pad
// expone una API REST propia en /api/v1/... (la misma que usa su web UI/CLI), NO
// requiere el protocolo MCP para operaciones simples. Auth por Bearer con el token
// de SESIÓN del CLI (`padsess_...`), leído FRESCO de ~/.pad/credentials.json en cada
// llamada — es un token propio del server local (creado por `pad auth login`,
// aprobado por Niko en su navegador), INDEPENDIENTE del OAuth de Claude Code que
// usa pad-client.js (ese vence cada ~1h y depende de que Claude Code esté corriendo;
// éste no tiene ninguna de las dos limitaciones).
//
// RESILIENCIA (regla de oro / patrón best-effort de todo el proyecto): si el Pad
// local está caído o el token no existe/es inválido, las funciones devuelven
// { ok:false, error } en vez de tirar una excepción sin control — un módulo que
// use este cliente debe degradar con gracia (cache/último estado bueno), nunca
// tumbar el resto de Consola.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CREDS = path.join(os.homedir(), '.pad', 'credentials.json');
const DEFAULT_URL = process.env.CWC_PAD_URL || 'http://10.213.222.62:7777';
const DEFAULT_WORKSPACE = process.env.CWC_PAD_WORKSPACE || 'console';
const REQUEST_TIMEOUT_MS = 10_000;

function readSessionToken(serverUrl) {
  try {
    const raw = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
    const entry = raw?.credentials?.[serverUrl];
    if (!entry?.token) return null;
    return entry.token;
  } catch {
    return null;
  }
}

async function request(method, urlPath, { body, url = DEFAULT_URL } = {}) {
  const token = readSessionToken(url);
  if (!token) return { ok: false, error: 'Pad local: sin token de sesión (correr `pad auth login` contra el server local).' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
      return { ok: false, error: msg, status: res.status };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

// --- API de alto nivel (colección/ítem), workspace por defecto = 'console' ---

export async function listCollections(workspace = DEFAULT_WORKSPACE) {
  return request('GET', `/api/v1/workspaces/${workspace}/collections`);
}

// OJO verificado 2026-07-12 (migración tasks/store.js): `all=true` NO es "incluir
// archivados/terminados" — en pruebas reales devolvió MENOS resultados (a veces 0)
// que el default. El default (`all=false`, es decir NO mandar el query param) SÍ
// trae todo lo vivo, incluidos los items en estado terminal (ej. `hecha`/`done`) —
// solo excluye los soft-deleted (`deleted_at` seteado). Para un listado completo
// de una colección, USAR EL DEFAULT (no pasar `all: true`) hasta que se entienda
// mejor la semántica real de ese flag en el server.
export async function listItems(collectionSlug, { workspace = DEFAULT_WORKSPACE, all = false } = {}) {
  const qs = all ? '?all=true' : '';
  return request('GET', `/api/v1/workspaces/${workspace}/collections/${collectionSlug}/items${qs}`);
}

export async function getItem(ref, { workspace = DEFAULT_WORKSPACE } = {}) {
  return request('GET', `/api/v1/workspaces/${workspace}/items/${ref}`);
}

// Buscar UN item de una colección por su TÍTULO EXACTO — para módulos cuya
// "clave" no es un ref humano de Pad sino un string arbitrario preexistente
// (ej. tickets/meta-store.js: ticketNumber '123' / 'pr:<n>'). No hay
// (todavía) un endpoint de búsqueda por custom field en el server, así que
// esto trae TODOS los items de la colección (listItems, ya cacheable a
// futuro) y filtra en memoria por `title`. Aceptable para volúmenes bajos
// (decenas/pocas centenas de items) — si un consumidor futuro crece mucho,
// conviene pedir un endpoint de filtro server-side en vez de escalar esto.
// Devuelve null si no hay match O si Pad falla (best-effort, nunca tira).
export async function findItemByTitle(collectionSlug, title, opts = {}) {
  const r = await listItems(collectionSlug, opts);
  if (!r.ok) return null;
  return r.data.find((it) => it.title === title) || null;
}

// CAMPOS CUSTOM (schema-declared: status/priority/owner/etc.) — OJO CRÍTICO
// verificado 2026-07-12 con pruebas reales contra el server: van SIEMPRE anidados
// bajo una clave `fields: {...}` dentro del objeto que se pasa acá. Si se mandan
// "planos" (ej. `{title, status:'alta', owner:'nico'}` en vez de
// `{title, fields:{status:'alta', owner:'nico'}}`) el server los IGNORA
// silenciosamente y aplica los defaults del schema — sin error, sin pista. Los
// únicos campos que SÍ van planos (no dentro de `fields`) son los nativos del
// item: `title`, `content` (cuerpo markdown) y `tags` (array de strings).
export async function createItem(collectionSlug, fields, { workspace = DEFAULT_WORKSPACE } = {}) {
  return request('POST', `/api/v1/workspaces/${workspace}/collections/${collectionSlug}/items`, { body: fields });
}

// OJO CRÍTICO #2 (verificado 2026-07-12): a diferencia de `title`/`content`/`tags`
// (que si se omiten del body quedan TAL CUAL estaban), el objeto `fields` en un
// PATCH NO se mergea con el existente — lo REEMPLAZA ENTERO. Mandar
// `{fields:{owner:'x'}}` borra silenciosamente status/priority/etc. que no se
// repitan (vuelven al default del schema). Todo caller que actualice `fields`
// debe hacer read-modify-write: leer el item con `getItem`, mergear sus `fields`
// actuales con el patch, y mandar el objeto COMPLETO de vuelta.
export async function updateItem(ref, fields, { workspace = DEFAULT_WORKSPACE } = {}) {
  return request('PATCH', `/api/v1/workspaces/${workspace}/items/${ref}`, { body: fields });
}

export async function deleteItem(ref, { workspace = DEFAULT_WORKSPACE } = {}) {
  return request('DELETE', `/api/v1/workspaces/${workspace}/items/${ref}`);
}

// --- Comentarios (usados por el timeline de un ítem) ---

export async function listComments(ref, { workspace = DEFAULT_WORKSPACE } = {}) {
  return request('GET', `/api/v1/workspaces/${workspace}/items/${ref}/comments`);
}

export async function addComment(ref, text, { workspace = DEFAULT_WORKSPACE } = {}) {
  return request('POST', `/api/v1/workspaces/${workspace}/items/${ref}/comments`, { body: { body: text } });
}

// Borrar un comentario. OJO verificado 2026-07-12: el endpoint NO cuelga del item
// (no es /items/:ref/comments/:cid, eso da 404) — es un recurso propio del
// workspace direccionado por el UUID del comentario: /workspaces/:ws/comments/:cid.
export async function deleteComment(commentId, { workspace = DEFAULT_WORKSPACE } = {}) {
  return request('DELETE', `/api/v1/workspaces/${workspace}/comments/${commentId}`);
}

// --- Relaciones (blocks/blocked-by/parent — reemplaza el array `blocks[]`/`planId`
// a mano). OJO verificado 2026-07-12: el endpoint /links exige el UUID INTERNO del
// item destino (`target_id`), NO el ref humano (`PEND-4`) — y el `parent` mandado
// en el body de creación/edición NO se persiste (se probó y no aparece en el GET
// posterior). El único camino real para "parent" también es este mismo endpoint de
// links con link_type='parent'. resolveId() hace la traducción ref→UUID una vez,
// para que el resto del código siga hablando en refs humanos.
const idCache = new Map(); // ref -> uuid, cache chica en memoria (los ids no cambian)
async function resolveId(ref, opts) {
  if (idCache.has(ref)) return idCache.get(ref);
  const r = await getItem(ref, opts);
  if (!r.ok || !r.data?.id) return null;
  idCache.set(ref, r.data.id);
  return r.data.id;
}

export async function listLinks(ref, { workspace = DEFAULT_WORKSPACE } = {}) {
  return request('GET', `/api/v1/workspaces/${workspace}/items/${ref}/links`);
}

// targetRef y ref van como REFS HUMANOS (ej. 'PLAN-3', 'PEND-9') — se resuelven a
// UUID acá adentro. linkType: 'blocks' | 'blocked-by' | 'parent' | etc (igual que
// el MCP de Pad).
export async function addLink(ref, targetRef, linkType = 'blocks', opts = {}) {
  const targetId = await resolveId(targetRef, opts);
  if (!targetId) return { ok: false, error: `Pad: no se encontró el item destino ${targetRef}` };
  const { workspace = DEFAULT_WORKSPACE } = opts;
  return request('POST', `/api/v1/workspaces/${workspace}/items/${ref}/links`, {
    body: { target_id: targetId, link_type: linkType },
  });
}

// Conveniencia: fijar el padre de un item (plan de una tarea, etc.) — es un link
// con link_type='parent', mismo mecanismo que blocks. Verificado 2026-07-12: fijar
// un parent NUEVO reemplaza el anterior automáticamente (no hace falta unlink previo).
export async function setParent(ref, parentRef, opts = {}) {
  return addLink(ref, parentRef, 'parent', opts);
}

// Quitar un link (blocks o parent) por su id (el `id` que devuelve addLink/listLinks,
// NO un ref humano). Igual patrón que deleteComment: recurso propio del workspace.
export async function deleteLink(linkId, { workspace = DEFAULT_WORKSPACE } = {}) {
  return request('DELETE', `/api/v1/workspaces/${workspace}/links/${linkId}`);
}

// Chequeo barato de disponibilidad (para decidir fallback sin pagar el timeout completo
// en cada operación real — usarlo en un healthcheck periódico, no en el hot path).
export async function isAvailable(workspace = DEFAULT_WORKSPACE) {
  const r = await listCollections(workspace);
  return r.ok;
}
