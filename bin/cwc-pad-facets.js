#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { uidTarget } from '../src/core/arch-uid.js';

// Las lecturas REST de schema e ítems deben ser frescas. El cliente compartido
// lee esta variable al importarse, por eso su import es dinámico en main().
process.env.CWC_PAD_CACHE = '0';

const WORKSPACE = 'console';
const COLLECTION = 'arquitectura';
const PAD_OPTS = Object.freeze({ workspace: WORKSPACE });
const PAD_DB_PATH = path.join(os.homedir(), '.pad', 'pad.db');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_RATE_RETRIES = 8;
const REF_RE = /^ARQUI-\d+$/;
const KINDS = new Set(['raiz', 'subsistema', 'grupo', 'modulo', 'archivo', 'endpoint']);
const USER_SIGNAL_RE = /\b(resolveDataDir|userSpace|userDataDir|userFileRoot|userClaudeDir|userRunnerEnv|readUserPadToken|userPadWorkspace|principalOf|ownedChat|safeCwd|systemScopeFor|reqPadContext|padContextForUser|reqSharedPadContext)\b/;
const ROUTE_LINE_RE = /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*(['"`])([^'"`]+)\3/i;
const AUDIENCE_PRIORITY = ['todos', 'usuario', 'invitado', 'admin', 'super-admin'];
const FACET_KEYS = ['plano', 'audiencia', 'perfil', 'faceta_fuente'];
const SCHEMA_FRAGMENT = ',{"key":"plano","label":"Plano","type":"select","options":["central","usuario","mixto"]},{"key":"audiencia","label":"Audiencia","type":"select","options":["super-admin","admin","usuario","invitado","todos"]},{"key":"perfil","label":"Perfil","type":"text"},{"key":"faceta_fuente","label":"Origen de la faceta","type":"select","options":["derivada","heredada","manual"]}';

// Decisiones tomadas a mano para lo que el código no puede decir (TASK-2303).
// Clave = uid. Las entradas son PARCIALES: pisan SOLO los ejes que declaran y
// dejan que el resto se siga derivando del código, para que un refactor futuro
// no las deje mintiendo. Un uid presente acá marca faceta_fuente:'manual'.
//
// El vocabulario de `perfil` es ABIERTO (obligación 3 de CONVE-2279). Hoy tiene
// tres valores en uso: `general` (le sirve a cualquiera), `solo-tolkien` (solo a
// quien trabaja el repo del cliente) y `solo-consola` (solo a quien mantiene
// esta consola). Sumar un cuarto no requiere tocar el schema.
export const MANUAL_FACETS = {
  // ── Contenedores sin código propio ──────────────────────────────────────
  // La raíz y el bucket "Otros" no son código: son continentes de todo.
  'root:mi-consola': { plano: 'mixto', audiencia: 'todos', perfil: 'general' },
  'sub:otros': { plano: 'mixto', audiencia: 'todos', perfil: 'general' },

  // ── Núcleo: nodos conceptuales de src/core sin carpeta propia ───────────
  // Los que NO saben de usuarios son cimiento puro; los que resuelven algo
  // por usuario son material del edificio que sabe de apartamentos ⇒ mixto.
  'concepto:core-config': { plano: 'central', audiencia: 'admin', perfil: 'solo-consola' },
  'concepto:core-auth': { plano: 'central', audiencia: 'todos', perfil: 'general' },
  'concepto:core-red': { plano: 'central', audiencia: 'todos', perfil: 'general' },
  'concepto:core-inventory': { plano: 'central', audiencia: 'admin', perfil: 'solo-consola' },
  'concepto:core-bus': { plano: 'mixto', audiencia: 'todos', perfil: 'general' },
  'concepto:core-pad-client': { plano: 'mixto', audiencia: 'todos', perfil: 'general' },
  'concepto:core-tool-policy': { plano: 'mixto', audiencia: 'todos', perfil: 'general' },
  'concepto:core-model-router': { plano: 'mixto', audiencia: 'todos', perfil: 'general' },
  'concepto:retro-mejora-continua': { plano: 'mixto', audiencia: 'todos', perfil: 'general' },

  // ── Frontend: el código de la vista no nombra los helpers de backend, así
  // que sin tabla derivaría `central`. Una pantalla es la puerta del
  // apartamento, no el cimiento del edificio.
  'fe:audio': { plano: 'usuario', perfil: 'general' },
  'fe:chat': { plano: 'usuario', perfil: 'general' },
  'fe:launcher': { plano: 'usuario', perfil: 'general' },
  'fe:learning': { plano: 'usuario', perfil: 'general' },
  'fe:mobile': { plano: 'usuario', perfil: 'general' },
  'fe:plan-limits': { plano: 'usuario', perfil: 'general' },
  'fe:retro': { plano: 'usuario', perfil: 'general' },
  'fe:sessions': { plano: 'usuario', perfil: 'general' },
  'fe:tasks': { plano: 'usuario', perfil: 'general' },
  'fe:terminal': { plano: 'usuario', perfil: 'general' },
  'fe:usage': { plano: 'usuario', perfil: 'general' },
  // El menú Sistema mezcla paneles del edificio (backup, updates, usuarios)
  // con la config propia de quien mira ⇒ mixto. Audiencia por unión: `todos`
  // puede entrar a algo, y cada endpoint admin lleva su propia verdad.
  'fe:system': { plano: 'mixto', perfil: 'general' },
  'fe:tickets': { plano: 'usuario', perfil: 'solo-tolkien' },
  'fe:tolkien': { plano: 'usuario', perfil: 'solo-tolkien' },

  // ── Perfil de los módulos backend ───────────────────────────────────────
  // Solo se declara el eje sin señal: `plano` y `audiencia` los sigue
  // gobernando el código.
  'mod:tolkien': { perfil: 'solo-tolkien' },
  'mod:tickets': { perfil: 'solo-tolkien' },
  'mod:comms': { perfil: 'solo-tolkien' },
  'mod:backup': { perfil: 'solo-consola' },
  'mod:updates': { perfil: 'solo-consola' },
  'mod:health': { perfil: 'solo-consola' },
  'mod:admin': { perfil: 'solo-consola' },

  // `stats` resuelve datos por usuario, así que la señal lo daría como
  // `usuario`; pero la tabla de ejemplos de CONVE-2279 lo fija como central:
  // es un panel del edificio que INFORMA sobre los apartamentos, no un
  // apartamento. Manda la convención.
  // Telemetría del host: a un inquilino que solo trabaja Tolkien no le
  // aporta gran cosa, pero tampoco le estorba, y el perfil NO es una
  // cerradura. Ante la duda se elige el valor que no sub-sirve a nadie.
  'mod:stats': { plano: 'central', perfil: 'general' },

  // ── Perfil declarado del resto de los módulos ───────────────────────────
  // Declarar `general` NO es lo mismo que dejarlo en el default: la
  // obligación 6 de CONVE-2279 pide que un nodo sin faceta sea un hallazgo,
  // y un default silencioso es indistinguible de un olvido. Estos módulos
  // le sirven a cualquiera, sin importar si trabaja Tolkien o mantiene la
  // consola, y eso es una decisión tomada, no una omisión.
  'mod:chat': { perfil: 'general' },
  'mod:terminal': { perfil: 'general' },
  'mod:tmux': { perfil: 'general' },
  'mod:files': { perfil: 'general' },
  'mod:tokens': { perfil: 'general' },
  'mod:tasks': { perfil: 'general' },
  'mod:learning': { perfil: 'general' },
  'mod:audio': { perfil: 'general' },
  'mod:interfono': { perfil: 'general' },
  'mod:onboard': { perfil: 'general' },
  'mod:mcps': { perfil: 'general' },
  'mod:skills': { perfil: 'general' },
  'mod:connections': { perfil: 'general' },

  // `retro` destila lecciones de PROCESO y su pozo `comunidad` agrega la
  // recurrencia entre personas. Su sección "Feedback de Chris" sí es del
  // mundo externo, pero es una parte del módulo, no su razón de ser.
  'mod:retro': { perfil: 'general' },

  // `projects` edita el CLAUDE.md y las memorias REALES de CADA proyecto del
  // registro — Tolkien Y esta consola. Es literalmente de los dos perfiles.
  'mod:projects': { perfil: 'general' },

  // `seguimientos` es el primer habitante de Limbo (regla dura 13): mapea
  // datos de AMBOS mundos por definición. Marcarlo `solo-tolkien` negaría
  // la mitad de su razón de existir.
  'mod:seguimientos': { perfil: 'general' },

  // ── Los dos que NO son `general` ────────────────────────────────────────
  // `env-vars` es la capa de config de ESTA instancia (identidad + cliente):
  // le sirve a quien la administra, a nadie más.
  'mod:env-vars': { perfil: 'solo-consola' },

  // `unifi` es el puente solo-lectura al UDM Pro de la oficina. No es del
  // trabajo de Tolkien ni del mantenimiento del código, pero sí es una
  // herramienta de quien OPERA esta instalación; `solo-consola` es el
  // perfil existente que mejor lo describe, y evita inventar un cuarto
  // valor para un único módulo.
  'mod:unifi': { perfil: 'solo-consola' },
};

function usage() {
  return [
    'Uso: node bin/cwc-pad-facets.js [--apply] [--schema-only|--items-only] [opciones]',
    '',
    'Opciones:',
    '  --apply          Escribe el schema y/o las facetas (sin este flag no escribe nada)',
    '  --schema-only    Ejecuta solamente la expansión del schema',
    '  --items-only     Ejecuta solamente la clasificación de ítems',
    '  --json           Emite un único objeto JSON',
    '  --limit N        Limita los ítems mostrados/escritos después de clasificarlos',
    '  --ref ARQUI-n    Procesa solamente esa referencia',
    '  --kind TIPO      Filtra por raiz|subsistema|grupo|modulo|archivo|endpoint',
    '  --help, -h       Muestra esta ayuda',
    '',
    `El workspace está fijado por código a ${WORKSPACE}.`,
  ].join('\n');
}

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 1;
  return error;
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) throw usageError(`${flag} requiere un valor`);
  return value;
}

function parseArgs(argv) {
  const options = {
    apply: false,
    help: false,
    itemsOnly: false,
    json: false,
    kind: null,
    limit: null,
    ref: null,
    schemaOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--schema-only') options.schemaOnly = true;
    else if (arg === '--items-only') options.itemsOnly = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--ref' || arg.startsWith('--ref=')) {
      if (options.ref !== null) throw usageError('--ref solo puede indicarse una vez');
      options.ref = arg === '--ref'
        ? valueAfter(argv, index++, '--ref')
        : arg.slice('--ref='.length);
    } else if (arg === '--kind' || arg.startsWith('--kind=')) {
      if (options.kind !== null) throw usageError('--kind solo puede indicarse una vez');
      options.kind = arg === '--kind'
        ? valueAfter(argv, index++, '--kind')
        : arg.slice('--kind='.length);
    } else if (arg === '--limit' || arg.startsWith('--limit=')) {
      if (options.limit !== null) throw usageError('--limit solo puede indicarse una vez');
      const raw = arg === '--limit'
        ? valueAfter(argv, index++, '--limit')
        : arg.slice('--limit='.length);
      if (!/^\d+$/.test(raw) || Number(raw) < 1) {
        throw usageError(`limit inválido: ${raw || '[vacío]'}`);
      }
      options.limit = Number(raw);
    } else {
      throw usageError(`argumento desconocido: ${arg}`);
    }
  }

  if (options.schemaOnly && options.itemsOnly) {
    throw usageError('--schema-only y --items-only son mutuamente excluyentes');
  }
  if (options.ref !== null && !REF_RE.test(options.ref)) {
    throw usageError(`ref inválido: ${options.ref || '[vacío]'}`);
  }
  if (options.kind !== null && !KINDS.has(options.kind)) {
    throw usageError(`kind inválido: ${options.kind || '[vacío]'}`);
  }
  if (process.env.CWC_PAD_WORKSPACE && process.env.CWC_PAD_WORKSPACE !== WORKSPACE) {
    throw usageError(
      `CWC_PAD_WORKSPACE=${process.env.CWC_PAD_WORKSPACE} no está permitido; `
      + `este CLI solo opera en ${WORKSPACE}`,
    );
  }
  return options;
}

function collectionArray(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.items) ? data.items : [];
}

function parseFields(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function isRateLimitError(result) {
  const message = String(result?.error || '').toLowerCase();
  return result?.status === 429
    || message.includes('429')
    || message.includes('too many')
    || message.includes('rate limit');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRateRetry(operation, label, log) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await operation();
    if (!isRateLimitError(result) || attempt >= MAX_RATE_RETRIES) return result;
    const waitMs = Math.min(3000 * (2 ** attempt), 30000);
    log(`[rate-limit] ${label}: reintento ${attempt + 1}/${MAX_RATE_RETRIES} en ${waitMs}ms`);
    await sleep(waitMs);
  }
}

function openDatabase() {
  const db = new DatabaseSync(PAD_DB_PATH, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return db;
}

function readTopology(db) {
  const items = db.prepare(`
    SELECT
      i.id,
      c.prefix || '-' || i.item_number AS ref,
      i.title,
      i.fields
    FROM items i
    JOIN collections c
      ON c.id = i.collection_id
      AND c.workspace_id = i.workspace_id
    JOIN workspaces w
      ON w.id = i.workspace_id
    WHERE w.slug = ?
      AND w.deleted_at IS NULL
      AND c.slug = ?
      AND c.deleted_at IS NULL
      AND i.deleted_at IS NULL
    ORDER BY i.item_number
  `).all(WORKSPACE, COLLECTION);

  const links = db.prepare(`
    SELECT l.source_id, l.target_id
    FROM item_links l
    JOIN items source_item
      ON source_item.id = l.source_id
      AND source_item.workspace_id = l.workspace_id
      AND source_item.deleted_at IS NULL
    JOIN collections source_collection
      ON source_collection.id = source_item.collection_id
      AND source_collection.workspace_id = source_item.workspace_id
      AND source_collection.deleted_at IS NULL
    JOIN items target_item
      ON target_item.id = l.target_id
      AND target_item.workspace_id = l.workspace_id
      AND target_item.deleted_at IS NULL
    JOIN collections target_collection
      ON target_collection.id = target_item.collection_id
      AND target_collection.workspace_id = target_item.workspace_id
      AND target_collection.deleted_at IS NULL
    JOIN workspaces w
      ON w.id = l.workspace_id
      AND w.deleted_at IS NULL
    WHERE w.slug = ?
      AND source_collection.slug = ?
      AND target_collection.slug = ?
      AND l.link_type = 'parent'
    ORDER BY l.created_at, l.id
  `).all(WORKSPACE, COLLECTION, COLLECTION);
  return { items, links };
}

function walkJsFiles(relativeDirectory) {
  const absoluteDirectory = path.join(REPO_ROOT, relativeDirectory);
  let entries;
  try {
    entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...walkJsFiles(relative));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(relative);
  }
  return files;
}

function directRoutesForUid(uid) {
  const target = uidTarget(uid);
  if (!target) return [];
  if (target.kind === 'dir') return walkJsFiles(target.rel);
  return [target.rel];
}

function makeFileReader() {
  const cache = new Map();
  return {
    cache,
    read(relativePath) {
      const normalized = path.normalize(relativePath);
      if (cache.has(normalized)) return cache.get(normalized);
      const absolute = path.resolve(REPO_ROOT, normalized);
      let content = null;
      if (absolute === REPO_ROOT || absolute.startsWith(`${REPO_ROOT}${path.sep}`)) {
        try {
          content = fs.readFileSync(absolute, 'utf8');
        } catch {
          content = null;
        }
      }
      cache.set(normalized, content);
      return content;
    },
  };
}

function routeContents(node, fileReader) {
  return node.routes
    .map((relativePath) => ({ relativePath, content: fileReader.read(relativePath) }))
    .filter((entry) => entry.content !== null);
}

function hasRequireAdminUse(entries) {
  return entries.some(({ content }) => /\.use\s*\([^;]{0,500}\brequireAdmin\b/s.test(content));
}

function routeRegistrations(entries) {
  const registrations = [];
  for (const entry of entries) {
    const lines = entry.content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const match = lines[lineIndex].match(ROUTE_LINE_RE);
      if (!match) continue;
      registrations.push({
        file: entry.relativePath,
        lines,
        lineIndex,
        lineText: lines[lineIndex],
        router: match[1],
        verb: match[2].toLowerCase(),
        route: match[4],
      });
    }
  }
  return registrations;
}

function endpointParts(uid) {
  const match = typeof uid === 'string'
    ? uid.match(/^endpoint:(GET|POST|PUT|PATCH|DELETE|ALL)\s+(.+)$/i)
    : null;
  return match ? { verb: match[1].toLowerCase(), route: match[2] } : null;
}

function matchingRegistration(node, entries) {
  const endpoint = endpointParts(node.uid);
  if (!endpoint) return null;
  return routeRegistrations(entries)
    .filter((registration) => registration.verb === endpoint.verb)
    .filter((registration) => (
      endpoint.route === registration.route || endpoint.route.endsWith(registration.route)
    ))
    .sort((a, b) => b.route.length - a.route.length)[0] || null;
}

function handlerHasAdminGate(registration) {
  const registrations = [];
  for (
    let lineIndex = registration.lineIndex + 1;
    lineIndex < registration.lines.length;
    lineIndex += 1
  ) {
    if (ROUTE_LINE_RE.test(registration.lines[lineIndex])) registrations.push(lineIndex);
  }
  const nextRegistration = registrations[0] ?? registration.lines.length;
  const end = Math.min(registration.lineIndex + 60, nextRegistration - 1);
  for (let lineIndex = registration.lineIndex; lineIndex <= end; lineIndex += 1) {
    if (!/!\s*isAdmin\s*\(|!\s*admin\b/.test(registration.lines[lineIndex])) continue;
    const statusWindow = registration.lines
      .slice(lineIndex, Math.min(lineIndex + 4, end + 1))
      .join('\n');
    if (/\b(?:403|404)\b/.test(statusWindow)) return true;
  }
  return false;
}

function derivePlano(entries) {
  const hasUserSignal = entries.some(({ content }) => USER_SIGNAL_RE.test(content));
  if (!hasUserSignal) return { value: 'central', reason: 'sin señal de usuario' };
  const allCore = entries.length > 0
    && entries.every(({ relativePath }) => relativePath.split(path.sep).join('/').startsWith('src/core/'));
  if (allCore) return { value: 'mixto', reason: 'señal de usuario en src/core' };
  return { value: 'usuario', reason: 'señal de usuario fuera de src/core' };
}

function isProfileLeaf(node) {
  return /^(?:file|endpoint|run):/.test(node.uid || '');
}

function isModuleLevel(node) {
  return /^(?:mod|fe):/.test(node.uid || '');
}

function isContainer(node) {
  return /^(?:root|sub|concepto|grupo):/.test(node.uid || '');
}

function deriveAudience(node, entries, nodesById) {
  if (hasRequireAdminUse(entries)) {
    return { value: 'admin', reason: 'requireAdmin en .use()', inherited: false };
  }

  if (node.kind === 'endpoint') {
    const registration = matchingRegistration(node, entries);
    if (!registration) {
      const parent = nodesById.get(node.parentId);
      return {
        value: parent?.facets?.audiencia || null,
        reason: `heredada de ${parent?.uid || parent?.ref || 'padre sin clasificar'}`,
        inherited: true,
      };
    }
    if (/\brequireAdmin\b/.test(registration.lineText)) {
      return { value: 'admin', reason: 'requireAdmin en registro', inherited: false };
    }
    if (handlerHasAdminGate(registration)) {
      return { value: 'admin', reason: 'gate admin con 403/404', inherited: false };
    }
    if (registration.router === 'publicRouter') {
      return { value: 'invitado', reason: 'registro en publicRouter', inherited: false };
    }
    return { value: 'todos', reason: 'registro sin gate admin', inherited: false };
  }

  // La audiencia del contenedor es una unión: tener algunos endpoints admin no
  // vuelve admin-only a un módulo que también expone rutas para todo el mundo.
  return { value: 'todos', reason: 'contenedor sin gate global', inherited: false };
}

function classifyRoutedNode(node, nodesById, fileReader) {
  const entries = routeContents(node, fileReader);
  if (entries.length === 0) return;
  const plano = derivePlano(entries);
  const audiencia = deriveAudience(node, entries, nodesById);
  if (!audiencia.value) return;
  node.facets = {
    plano: plano.value,
    audiencia: audiencia.value,
    faceta_fuente: audiencia.inherited ? 'heredada' : 'derivada',
  };
  node.motivo = audiencia.inherited
    ? `${audiencia.reason}; ${plano.reason}`
    : `${plano.reason}; ${audiencia.reason}`;
}

function aggregateNode(node, nodesById) {
  const currentChildren = node.childIds
    .map((id) => nodesById.get(id))
    .filter((child) => child && child.status !== 'retirado');
  if (currentChildren.length === 0 || currentChildren.some((child) => !child.facets)) return;
  const planos = new Set(currentChildren.map((child) => child.facets.plano));
  const audiences = currentChildren.map((child) => child.facets.audiencia);
  node.facets = {
    plano: planos.size === 1 ? currentChildren[0].facets.plano : 'mixto',
    audiencia: AUDIENCE_PRIORITY.find((value) => audiences.includes(value)) || 'todos',
    faceta_fuente: 'heredada',
  };
  node.motivo = `heredada de ${currentChildren.length} hijos vigentes`;
}

function inheritEmptyContainer(node, nodesById) {
  if (node.facets || !isContainer(node)) return;
  const currentChildren = node.childIds
    .map((id) => nodesById.get(id))
    .filter((child) => child && child.status !== 'retirado');
  if (currentChildren.length > 0) return;
  const parent = nodesById.get(node.parentId);
  if (!parent?.facets) return;
  node.facets = {
    plano: parent.facets.plano,
    audiencia: parent.facets.audiencia,
    faceta_fuente: 'heredada',
  };
  node.motivo = `heredada de ${parent.uid || parent.ref}`;
}

function depthOf(node, nodesById, visiting = new Set()) {
  if (node.depth !== null) return node.depth;
  if (!node.parentId || visiting.has(node.id)) {
    node.depth = 0;
    return node.depth;
  }
  const parent = nodesById.get(node.parentId);
  if (!parent) {
    node.depth = 0;
    return node.depth;
  }
  visiting.add(node.id);
  node.depth = depthOf(parent, nodesById, visiting) + 1;
  visiting.delete(node.id);
  return node.depth;
}

function manualOverride(node) {
  const manual = node.uid ? MANUAL_FACETS[node.uid] : null;
  if (!manual) return;
  const plano = manual.plano ?? node.facets?.plano;
  const audiencia = manual.audiencia ?? node.facets?.audiencia;
  if (!plano || !audiencia) return;
  node.facets = {
    ...node.facets,
    ...manual,
    plano,
    audiencia,
    // Fijar solo el perfil no le quita al código el gobierno de los otros dos ejes.
    faceta_fuente: Object.hasOwn(manual, 'plano') || Object.hasOwn(manual, 'audiencia')
      ? 'manual'
      : node.facets.faceta_fuente,
  };
  node.motivo = 'decisión manual TASK-2303';
}

function assignProfiles(nodes, nodesById) {
  for (const node of [...nodes].sort((a, b) => a.depth - b.depth)) {
    if (node.status === 'retirado' || !node.facets) continue;
    const manualProfile = node.uid ? MANUAL_FACETS[node.uid]?.perfil : null;
    if (isProfileLeaf(node)) {
      const parent = nodesById.get(node.parentId);
      if (!parent?.facets?.perfil) {
        node.facets = null;
        node.motivo = 'padre sin perfil para heredar';
        continue;
      }
      node.facets.perfil = parent.facets.perfil;
      // Heredar `perfil` no degrada faceta_fuente: la fuente describe solo
      // los ejes con señal en código (`plano` y `audiencia`).
      continue;
    }
    node.facets.perfil = manualProfile || 'general';
    node.profileDefault = isModuleLevel(node) && !manualProfile;
  }
}

function buildNodes(topology, errors) {
  const nodes = [];
  const nodesById = new Map();
  for (const item of topology.items) {
    let fields = {};
    try {
      fields = parseFields(item.fields);
    } catch (error) {
      errors.push({
        phase: 'items',
        ref: item.ref,
        error: `fields JSON inválido: ${error.message}`,
      });
    }
    const node = {
      id: item.id,
      ref: item.ref,
      title: item.title,
      fields,
      uid: fields.uid || null,
      kind: fields.kind || null,
      status: fields.status || null,
      parentId: null,
      childIds: [],
      routes: [],
      facets: null,
      motivo: 'sin rutas ni hijos vigentes',
      depth: null,
      profileDefault: false,
    };
    nodes.push(node);
    nodesById.set(node.id, node);
  }
  for (const link of topology.links) {
    const child = nodesById.get(link.source_id);
    const parent = nodesById.get(link.target_id);
    if (!child || !parent) continue;
    if (child.parentId && child.parentId !== parent.id) {
      errors.push({
        phase: 'items',
        ref: child.ref,
        error: 'más de un link parent; se usa el primero',
      });
      continue;
    }
    child.parentId = parent.id;
    parent.childIds.push(child.id);
  }
  return { nodes, nodesById };
}

function classifyAll(topology, errors) {
  const { nodes, nodesById } = buildNodes(topology, errors);
  const fileReader = makeFileReader();

  for (const node of nodes) {
    if (node.status === 'retirado' || node.kind === 'endpoint') continue;
    node.routes = directRoutesForUid(node.uid);
    classifyRoutedNode(node, nodesById, fileReader);
  }
  for (const node of nodes) {
    if (node.status === 'retirado' || node.kind !== 'endpoint') continue;
    node.routes = nodesById.get(node.parentId)?.routes || [];
    classifyRoutedNode(node, nodesById, fileReader);
  }
  for (const node of nodes) {
    if (node.status !== 'retirado') manualOverride(node);
    depthOf(node, nodesById);
  }
  for (const node of [...nodes].sort((a, b) => b.depth - a.depth)) {
    if (node.status === 'retirado' || node.facets) continue;
    aggregateNode(node, nodesById);
    manualOverride(node);
  }
  for (const node of [...nodes].sort((a, b) => a.depth - b.depth)) {
    if (node.status === 'retirado' || node.facets) continue;
    inheritEmptyContainer(node, nodesById);
    manualOverride(node);
  }
  assignProfiles(nodes, nodesById);
  for (const node of nodes) {
    if (node.status === 'retirado' || node.facets) continue;
    const currentChildren = node.childIds
      .map((id) => nodesById.get(id))
      .filter((child) => child && child.status !== 'retirado');
    if (node.routes.length > 0) node.motivo = 'rutas sin archivos legibles';
    else if (currentChildren.length === 0) node.motivo = 'sin rutas ni hijos vigentes';
    else {
      const pending = currentChildren.filter((child) => !child.facets).length;
      node.motivo = `${pending} hijos vigentes sin faceta`;
    }
  }
  return { nodes, filesRead: fileReader.cache.size };
}

function facetChanged(node) {
  if (!node.facets) return false;
  return FACET_KEYS.some((key) => node.fields[key] !== node.facets[key]);
}

function resultForNode(node) {
  return {
    ref: node.ref,
    uid: node.uid,
    kind: node.kind,
    title: node.title,
    plano: node.facets?.plano || null,
    audiencia: node.facets?.audiencia || null,
    perfil: node.facets?.perfil || null,
    faceta_fuente: node.facets?.faceta_fuente || null,
    motivo: node.motivo,
    cambia: facetChanged(node),
  };
}

function distribution(results, key) {
  const counts = {};
  for (const result of results) {
    const value = result[key];
    if (value !== null) counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function makeSummary(allNodes, selectedNodes, results, residue, errors, writes, filesRead) {
  return {
    total_nodos: allNodes.length,
    seleccionados: results.length,
    retirados_saltados: allNodes.filter((node) => node.status === 'retirado').length,
    clasificados: results.filter((result) => result.plano !== null).length,
    cambiarian: results.filter((result) => result.cambia).length,
    escritos: writes,
    archivos_leidos: filesRead,
    perfil_por_defecto: selectedNodes.filter((node) => node.profileDefault).length,
    distribucion: {
      plano: distribution(results, 'plano'),
      audiencia: distribution(results, 'audiencia'),
      perfil: distribution(results, 'perfil'),
      faceta_fuente: distribution(results, 'faceta_fuente'),
    },
    residuo: residue.length,
    errores: errors.length,
  };
}

async function runSchemaPhase(options, deps, log, errors) {
  const info = {
    status: 'omitido',
    oldLength: null,
    newLength: null,
    addedKeys: FACET_KEYS,
    cambia: false,
  };
  const listed = await withRateRetry(
    () => deps.listCollections(PAD_OPTS),
    `listCollections ${WORKSPACE}`,
    log,
  );
  if (!listed?.ok) {
    throw new Error(listed?.error || 'no se pudieron listar las colecciones');
  }
  const collection = collectionArray(listed.data).find((entry) => entry?.slug === COLLECTION);
  if (!collection) throw new Error(`no existe la colección ${COLLECTION}`);
  const oldSchema = collection.schema;
  if (typeof oldSchema !== 'string') {
    throw new Error('schema de arquitectura no es un string JSON crudo');
  }

  info.oldLength = oldSchema.length;
  if (oldSchema.includes('"key":"plano"')) {
    info.status = 'ya-expandido';
    info.newLength = oldSchema.length;
    return info;
  }
  if (!oldSchema.endsWith(']}')) {
    throw new Error('schema de arquitectura no termina exactamente en ]}');
  }

  const oldPrefix = oldSchema.slice(0, -2);
  const newSchema = oldPrefix + SCHEMA_FRAGMENT + ']}';
  info.newLength = newSchema.length;
  if (!newSchema.startsWith(oldPrefix)) {
    throw new Error('validación de schema falló: el prefijo crudo no se conservó');
  }
  let parsedOld;
  let parsedNew;
  try {
    parsedOld = JSON.parse(oldSchema);
    parsedNew = JSON.parse(newSchema);
  } catch (error) {
    throw new Error(`validación de schema falló: JSON inválido (${error.message})`);
  }
  const fields = parsedNew?.fields;
  if (!Array.isArray(fields)
    || fields.length !== 7
    || fields.slice(0, 3).map((field) => field?.key).join(',') !== 'kind,status,uid') {
    throw new Error('validación de schema falló: se esperaban 7 fields y prefijo kind,status,uid');
  }
  if (!Array.isArray(parsedOld?.fields)
    || !isDeepStrictEqual(fields.slice(0, 3), parsedOld.fields)) {
    throw new Error('validación de schema falló: los tres fields originales cambiaron');
  }

  info.cambia = true;
  if (!options.apply) {
    info.status = 'cambiaría';
    return info;
  }
  const updated = await withRateRetry(
    () => deps.updateCollection(COLLECTION, { schema: newSchema }, PAD_OPTS),
    `updateCollection ${COLLECTION}`,
    log,
  );
  if (!updated?.ok) throw new Error(updated?.error || 'no se pudo expandir el schema');
  const reread = await withRateRetry(
    () => deps.listCollections(PAD_OPTS),
    `releer collection ${COLLECTION}`,
    log,
  );
  if (!reread?.ok) throw new Error(reread?.error || 'no se pudo releer el schema');
  const confirmed = collectionArray(reread.data).find((entry) => entry?.slug === COLLECTION);
  if (confirmed?.schema !== newSchema) {
    throw new Error('el schema releído no coincide byte a byte con el enviado');
  }
  info.status = 'expandido';
  return info;
}

async function writeItems(nodes, options, deps, log, errors) {
  let writes = 0;
  if (!options.apply) return writes;
  for (const node of nodes) {
    if (!node.facets || !facetChanged(node)) continue;
    const fresh = await withRateRetry(
      () => deps.getItem(node.ref, PAD_OPTS),
      `getItem ${node.ref}`,
      log,
    );
    if (!fresh?.ok) {
      errors.push({
        phase: 'items',
        ref: node.ref,
        error: fresh?.error || 'no se pudo releer el ítem',
      });
      continue;
    }
    let freshFields;
    try {
      freshFields = parseFields(fresh.data?.fields);
    } catch (error) {
      errors.push({
        phase: 'items',
        ref: node.ref,
        error: `fields REST inválido: ${error.message}`,
      });
      continue;
    }
    if (FACET_KEYS.every((key) => freshFields[key] === node.facets[key])) continue;
    const merged = { ...freshFields, ...node.facets };
    const updated = await withRateRetry(
      () => deps.updateItem(node.ref, { fields: merged }, PAD_OPTS),
      `updateItem ${node.ref}`,
      log,
    );
    if (updated?.ok) writes += 1;
    else {
      errors.push({
        phase: 'items',
        ref: node.ref,
        error: updated?.error || 'no se pudieron escribir las facetas',
      });
    }
  }
  return writes;
}

function printDistribution(label, values) {
  const text = Object.entries(values).map(([key, value]) => `${key}=${value}`).join(' · ');
  console.log(`${label}: ${text || '[vacía]'}`);
}

function printHuman(output, options) {
  const scope = [
    `MODO ${output.mode.toUpperCase()}`,
    `workspace=${WORKSPACE}`,
    `escrituras=${options.apply ? 'habilitadas' : '0'}`,
    `total-nodos=${output.summary.total_nodos}`,
    `seleccionados=${output.summary.seleccionados}`,
  ];
  if (options.ref) scope.push(`ref=${options.ref}`);
  if (options.kind) scope.push(`kind=${options.kind}`);
  if (options.limit) scope.push(`limit=${options.limit}`);
  console.log(scope.join(' · '));
  console.log(
    `schema=${output.schema.status}`
    + (output.schema.oldLength === null
      ? ''
      : ` · largo-viejo=${output.schema.oldLength} · largo-nuevo=${output.schema.newLength}`)
    + (output.schema.cambia ? ` · agrega=${output.schema.addedKeys.join(',')}` : ''),
  );
  console.log(`retirados-saltados=${output.summary.retirados_saltados}`);
  printDistribution('plano', output.summary.distribucion.plano);
  printDistribution('audiencia', output.summary.distribucion.audiencia);
  printDistribution('perfil', output.summary.distribucion.perfil);
  console.log(
    `perfil-por-defecto=${output.summary.perfil_por_defecto} (general, no declarado)`,
  );
  printDistribution('faceta_fuente', output.summary.distribucion.faceta_fuente);
  console.log(
    `cambiarían=${output.summary.cambiarian} · escritos=${output.summary.escritos}`
    + ` · residuo=${output.summary.residuo} · errores=${output.summary.errores}`,
  );
  if (output.residuo.length > 0) {
    console.log('RESIDUO SIN CLASIFICAR');
    for (const item of output.residuo.slice(0, 60)) {
      console.log(`  ${item.uid || '[sin uid]'} · ${item.title}`);
    }
  }
  if (output.errors.length > 0) {
    console.log('ERRORES PARCIALES');
    for (const error of output.errors) {
      console.log(`  ${error.ref || `[${error.phase}]`}: ${error.error}`);
    }
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const jsonRequested = rawArgs.includes('--json');
  let options;
  try {
    options = parseArgs(rawArgs);
  } catch (error) {
    if (jsonRequested) {
      console.log(JSON.stringify({ ok: false, error: error.message, usage: usage() }, null, 2));
    } else {
      console.error(`${error.message}\n${usage()}`);
    }
    return error.exitCode || 1;
  }

  if (options.help) {
    if (options.json) console.log(JSON.stringify({ ok: true, usage: usage() }, null, 2));
    else console.log(usage());
    return 0;
  }

  const mode = options.apply ? 'apply' : 'dry-run';
  const log = options.json ? () => {} : (message) => console.log(message);
  const {
    getItem,
    listCollections,
    updateCollection,
    updateItem,
  } = await import('../src/core/pad-service-client.js');
  const deps = { getItem, listCollections, updateCollection, updateItem };
  const errors = [];
  let schema = {
    status: options.itemsOnly ? 'omitido' : 'pendiente',
    oldLength: null,
    newLength: null,
    addedKeys: FACET_KEYS,
    cambia: false,
  };
  let haltItems = false;

  if (!options.itemsOnly) {
    try {
      schema = await runSchemaPhase(options, deps, log, errors);
    } catch (error) {
      schema.status = 'error';
      errors.push({ phase: 'schema', ref: null, error: error?.message || String(error) });
      if (options.apply) haltItems = true;
    }
  }

  let allNodes = [];
  let selectedNodes = [];
  let filesRead = 0;
  if (!options.schemaOnly && !haltItems) {
    let db = null;
    try {
      db = openDatabase();
      const topology = readTopology(db);
      const classified = classifyAll(topology, errors);
      allNodes = classified.nodes;
      filesRead = classified.filesRead;
      selectedNodes = allNodes
        .filter((node) => node.status !== 'retirado')
        .filter((node) => !options.ref || node.ref === options.ref)
        .filter((node) => !options.kind || node.kind === options.kind)
        .sort((a, b) => Number(a.ref.slice(6)) - Number(b.ref.slice(6)));
      if (options.limit !== null) selectedNodes = selectedNodes.slice(0, options.limit);
      if (options.ref && !allNodes.some((node) => node.ref === options.ref)) {
        errors.push({
          phase: 'items',
          ref: options.ref,
          error: `no existe como ítem vivo de ${COLLECTION}`,
        });
      }
    } catch (error) {
      errors.push({ phase: 'items', ref: null, error: error?.message || String(error) });
    } finally {
      if (db) db.close();
    }
  }

  const writes = await writeItems(selectedNodes, options, deps, log, errors);
  const results = selectedNodes.map(resultForNode);
  const residue = selectedNodes
    .filter((node) => !node.facets)
    .map((node) => ({ ref: node.ref, uid: node.uid, title: node.title }));
  const summary = makeSummary(
    allNodes,
    selectedNodes,
    results,
    residue,
    errors,
    writes,
    filesRead,
  );
  const output = {
    ok: errors.length === 0,
    mode,
    workspace: WORKSPACE,
    schema,
    items: results,
    summary,
    residuo: residue,
    errors,
  };
  if (options.json) console.log(JSON.stringify(output, null, 2));
  else printHuman(output, options);
  return output.ok ? 0 : 2;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
