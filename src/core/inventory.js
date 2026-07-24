// core/inventory.js — generador DETERMINÍSTICO del INVENTARIO del proyecto.
//
// FASE 1 del "sistema nervioso": el CLAUDE.md son las REGLAS/receta (humano,
// estable, en git); este inventario es el CENSO VIVO (qué existe AHORA:
// módulos, runners, frontend, y el vocabulario del proyecto). Sin LLM: parsea
// el repo con regex, corre inline en el server (es cuestión de ms). Salida:
// ~/.cwc-data/inventory.json (máquina) + inventory.md (legible por humanos y,
// más adelante, por los chats). Regeneración ON-DEMAND: solo se rehace si
// cambió algún mtime desde la última generación.
//
// Lo consumen (fases siguientes): el motor de salud (auditoría INCREMENTAL por
// fingerprint) y cada chat nuevo (contexto para crear/modificar sin errores).
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..'); // raíz del repo
const DATA_DIR = path.join(os.homedir(), '.cwc-data');
export const INVENTORY_JSON = path.join(DATA_DIR, 'inventory.json');
export const INVENTORY_MD = path.join(DATA_DIR, 'inventory.md');

const sha12 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const readSafe = (abs) => { try { return fss.readFileSync(abs, 'utf8'); } catch { return ''; } };
const rel = (abs) => path.relative(ROOT, abs);

// Lista .js/.mjs de un directorio (recursivo), relativos a ROOT, sin node_modules/.git.
function listJs(absDir) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fss.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e.name)) out.push(rel(p));
    }
  };
  walk(absDir);
  return out.sort();
}

// Fingerprint de un conjunto de archivos (relativos a ROOT): hash del CONTENIDO
// → cambia si el código cambia (base de la auditoría incremental, Fase 2).
function fingerprintOf(relFiles) {
  const h = crypto.createHash('sha1');
  for (const f of relFiles) h.update(f).update('\0').update(readSafe(path.join(ROOT, f)));
  return h.digest('hex').slice(0, 12);
}

// mtime más nuevo de un set de archivos (para el gate de frescura on-demand).
function maxMtime(relFiles) {
  let mx = 0;
  for (const f of relFiles) {
    try { mx = Math.max(mx, fss.statSync(path.join(ROOT, f)).mtimeMs); } catch { /* noop */ }
  }
  return mx;
}

// Primera línea de propósito del archivo: "// ruta — <propósito>" o el 1er
// comentario con guion largo.
function purposeOf(relFile) {
  const txt = readSafe(path.join(ROOT, relFile)).split('\n').slice(0, 6);
  for (const l of txt) {
    const m = l.match(/^\s*(?:\/\/|#!?\/?\S*|\*)?\s*[^—-]*[—-]\s*(.+?)\s*$/);
    if (m && m[1] && /[a-zA-Z]/.test(m[1]) && !/usr\/bin\/env/.test(l)) return m[1].slice(0, 120);
  }
  return '';
}

// ===== Backend: módulos registrados =====
function parseBackendModules() {
  const registry = readSafe(path.join(ROOT, 'src', 'core', 'registry.js'));
  const regLines = registry.split('\n');
  // Orden y nombres del array MODULES: son los IDENTIFICADORES de import
  // (camelCase, p.ej. `envVars`), que NO siempre coinciden con el nombre de
  // CARPETA (kebab, `env-vars`). Sin mapear carpeta↔identificador, `env-vars`
  // jamás matchea `envVars` en MODULES → falso "no registrado" en cada corrida.
  const arrMatch = registry.match(/const MODULES = \[([^\]]+)\]/);
  const order = arrMatch ? arrMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  // Mapa carpeta → { identificador de import, línea 1-based } leyendo cada
  // `import <id> from '../modules/<carpeta>/index.js'`.
  const importOf = {}; // carpeta -> identificador
  const importLine = {}; // carpeta -> nº de línea (1-based)
  regLines.forEach((l, i) => {
    const m = l.match(/import\s+(\w+)\s+from\s+['"][^'"]*\/modules\/([^/'"]+)\/index\.js['"]/);
    if (m) { importOf[m[2]] = m[1]; importLine[m[2]] = i + 1; }
  });
  const modsDir = path.join(ROOT, 'src', 'modules');
  let dirs = [];
  try { dirs = fss.readdirSync(modsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* noop */ }
  // Ordena por el array de registry (vía el identificador de cada carpeta); los
  // no listados van al final.
  dirs.sort((a, b) => {
    const ia = order.indexOf(importOf[a]); const ib = order.indexOf(importOf[b]);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  return dirs.map((name) => {
    const files = listJs(path.join(modsDir, name));
    const indexRel = files.find((f) => f.endsWith(`${name}/index.js`)) || null;
    // hasIndex: una carpeta SIN index.js no es un módulo backend registrable
    // (p.ej. `comms`, que quedó como librerías shared tras archivar su módulo
    // 2026-07-14) — no debe contar como "sin registrar".
    const hasIndex = !!indexRel;
    const index = indexRel || files[0];
    const idxTxt = index ? readSafe(path.join(ROOT, index)) : '';
    // Base HTTP: router.use('/base', r)
    const base = (idxTxt.match(/router\.use\(\s*['"](\/[^'"]+)['"]/) || [])[1] || null;
    // Rutas: r.get/post/... ('/x') y router.get/... directas
    const routes = [];
    for (const m of idxTxt.matchAll(/\b(?:r|router)\.(get|post|put|delete|patch)\(\s*['"]([^'"]*)['"]/g)) {
      const method = m[1].toUpperCase();
      const sub = m[2] || '';
      const full = base ? `/api${base}${sub === '/' ? '' : sub}` : `/api${sub}`;
      routes.push(`${method} ${full}`);
    }
    const importId = importOf[name] || null;
    return {
      name, kind: 'backend',
      hasIndex,
      registryLine: importLine[name] || null,
      registered: !!(importId && order.includes(importId)),
      purpose: purposeOf(index || ''),
      files,
      endpoints: [...new Set(routes)],
      fingerprint: fingerprintOf(files),
    };
  });
}

// ===== Runners detached (bin/) =====
function parseRunners() {
  let bin = [];
  try { bin = fss.readdirSync(path.join(ROOT, 'bin')).filter((f) => f.endsWith('.js')); } catch { /* noop */ }
  return bin.filter((f) => /runner|observe/.test(f)).sort().map((f) => ({
    file: `bin/${f}`,
    purpose: purposeOf(`bin/${f}`),
    fingerprint: fingerprintOf([`bin/${f}`]),
  }));
}

// ===== Frontend: módulos { name, mount } =====
function parseFrontend() {
  const html = readSafe(path.join(ROOT, 'public', 'index.html'));
  const mounted = new Set([...html.matchAll(/data-module="([a-z-]+)"/g)].map((m) => m[1]));
  const modsDir = path.join(ROOT, 'public', 'js', 'modules');
  let dirs = [];
  try { dirs = fss.readdirSync(modsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* noop */ }
  return dirs.sort().map((dir) => {
    const files = listJs(path.join(modsDir, dir));
    // El archivo con `export default { name, ... mount(` define el módulo.
    let name = dir;
    for (const f of files) {
      const t = readSafe(path.join(ROOT, f));
      if (/export default\s*\{/.test(t) && /\bmount\s*\(/.test(t)) {
        const nm = t.match(/name:\s*['"]([^'"]+)['"]/);
        if (nm) { name = nm[1]; break; }
      }
    }
    return { name, dir: rel(path.join(modsDir, dir)), files, mounted: mounted.has(name), fingerprint: fingerprintOf(files) };
  });
}

// ===== Vocabulario del proyecto (los "registries") =====
function parseVocabulary() {
  const tokensCss = readSafe(path.join(ROOT, 'public', 'css', 'tokens.css'));
  const cssTokens = [...new Set([...tokensCss.matchAll(/(--cwc-[a-z0-9-]+)\s*:/g)].map((m) => m[1]))].sort();
  const configTxt = readSafe(path.join(ROOT, 'src', 'core', 'config.js'));
  const envVars = [...new Set([...configTxt.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
  const modelTxt = readSafe(path.join(ROOT, 'src', 'core', 'claude-model.js'));
  const models = (modelTxt.match(/VALID_MODELS\s*=\s*new Set\(\[([^\]]+)\]/) || [, ''])[1]
    .split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  const sharedTxt = readSafe(path.join(ROOT, 'src', 'modules', 'chat', 'shared.js'));
  const permissionModes = (sharedTxt.match(/PERMISSION_MODES\s*=\s*new Set\(\[([^\]]+)\]/) || [, ''])[1]
    .split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  return { cssTokens, envVars, models, permissionModes };
}

// ===== Motores IA (censo de corridas del Agent SDK) =====
// Detecta TODO archivo que importa el SDK y llama a query(): cada uno es un
// "motor IA" de la consola. Extrae su configuración REAL con regex (0 tokens):
// modelo(s), maxTurns, timeouts, allowlists (blindaje regla 6), settingSources
// y modos de permiso. Es la base del botón "🧠 Optimización IA" de Salud: el
// censo es la FOTO determinística; el análisis (runner cwc-optimize-runner.js)
// la interpreta. Determinístico como el resto del inventario — sin LLM.
export function aiEnginesCensus() {
  const candidates = [...new Set([
    ...listJs(path.join(ROOT, 'src')),
    ...listJs(path.join(ROOT, 'bin')),
  ])];
  // Mapa global de constantes numéricas (const X = 20, const Y = 4 * 60000…)
  // para resolver maxTurns/timeouts definidos como const (propios o importados).
  const constMap = {};
  // Mapa global de constantes STRING (EXPLAIN_MODEL = 'sonnet'…) para resolver
  // `model:` definido como CONSTANTE exportada (p.ej. CONTEXT_MODEL/EXPLAIN_MODEL
  // de los *-shared.js de learning) — mismo criterio que constMap pero string.
  // OJO: NO escribir la-palabra-const seguida de MAYÚSCULA='str' en un comentario
  // acá dentro: esta misma regex lo parsearía como una constante real (falso
  // positivo que pineó de más al chat-runner en la 1ª versión). mismo criterio:
  // sin esto esos motores quedaban 'models:[]' + modelDynamic y cada corrida de
  // Salud/Optimización tenía que abrir el shared.js a mano para descartar riesgo.
  const constMapStr = {};
  const texts = new Map();
  for (const f of candidates) {
    const txt = readSafe(path.join(ROOT, f));
    texts.set(f, txt);
    for (const m of txt.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]+)\s*=\s*([0-9][\d_\s*+\-.]*?)\s*;/g)) {
      constMap[m[1]] = m[2].replace(/\s+/g, ' ').trim();
    }
    for (const m of txt.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*['"]([\w.-]+)['"]/g)) {
      constMapStr[m[1]] = { model: m[2], file: f };
    }
  }
  const resolveConst = (name) => (/^\d+$/.test(name) ? name : (constMap[name] ? `${name} (${constMap[name]})` : name));
  // Funciones auxiliares que PINEAN el modelo (optimización IA 2026-07-05):
  // si `model:` no es literal pero lo provee una función de un solo
  // `return 'literal'` (p.ej. auditModelFor() de health/shared.js → 'sonnet'),
  // el modelo está FIJO de facto. Antes esos motores quedaban 'models:[]' +
  // modelDynamic a secas y un futuro corredor de Optimización gastaba turnos
  // investigando (o proponiendo "pinear") un modelo que YA está pineado.
  // Busca la definición en cualquier archivo del censo (propia o importada).
  const resolveModelFn = (name) => {
    for (const [file, t] of texts) {
      const m = t.match(new RegExp(
        `(?:function\\s+${name}\\s*\\([^)]*\\)\\s*\\{\\s*return\\s+|(?:const|let)\\s+${name}\\s*=\\s*(?:\\([^)]*\\)|[\\w$]+)\\s*=>\\s*)['"]([\\w.-]+)['"]`,
      ));
      if (m) return { model: m[1], via: `${name}() en ${file}` };
    }
    return null;
  };

  const engines = [];
  for (const f of candidates) {
    const txt = texts.get(f) || '';
    // Motor = archivo que IMPORTA el SDK y llama a query(). Exigir el import
    // real (no solo la mención) evita auto-detectar archivos que hablan DEL
    // SDK (este mismo, health/index.js con checkDeps, docs inline…).
    if (!/from\s+['"]@anthropic-ai\/claude-agent-sdk['"]/.test(txt) || !/\bquery\s*\(\s*\{/.test(txt)) continue;
    const models = [...new Set([...txt.matchAll(/\bmodel:\s*['"]([\w.-]+)['"]/g)].map((m) => m[1]))];
    // model: IDENTIFICADOR (no literal) o shorthand `{ model, … }` = el modelo
    // lo decide el llamador/usuario en runtime (dinámico).
    const modelDynamic = /\bmodel:\s*(?!['"])[A-Za-z_$][\w$.]*\s*[,}\n]/.test(txt) || /[{,]\s*model\s*[,}]/.test(txt);
    // model no-literal: ¿lo resuelve una función identificable de un solo return?
    // (setModel()/modelForCwd() y demás no matchean la definición → siguen dinámicos)
    let modelResolvedVia = null;
    if (!models.length && modelDynamic) {
      // (a) model: es una CONSTANTE string (CONTEXT_MODEL, EXPLAIN_MODEL…):
      // resolverla contra el mapa global de consts string antes que la función.
      const idMatch = txt.match(/\bmodel:\s*([A-Z][A-Z0-9_]*)\s*[,}\n]/);
      if (idMatch && constMapStr[idMatch[1]]) {
        const c = constMapStr[idMatch[1]];
        models.push(c.model);
        modelResolvedVia = `${idMatch[1]} en ${c.file}`;
      }
      // (b) model: lo pinea una función de un solo return (auditModelFor()…).
      if (!models.length) {
        for (const fn of new Set([...txt.matchAll(/\b([A-Za-z_$][\w$]*[Mm]odel[\w$]*)\s*\(/g)].map((m) => m[1]))) {
          const r = resolveModelFn(fn);
          if (r) { models.push(r.model); modelResolvedVia = r.via; break; }
        }
      }
    }
    const maxTurns = [...new Set([...txt.matchAll(/\bmaxTurns:\s*([\w$]+)/g)].map((m) => resolveConst(m[1])))];
    const timeouts = [...new Set([...txt.matchAll(/\b([A-Z][A-Z0-9_]*TIMEOUT[A-Z0-9_]*)\b/g)].map((m) => resolveConst(m[1])))];
    const allowlists = [...new Set([...txt.matchAll(/\b([a-zA-Z][\w]*Allowed)\b/g)].map((m) => m[1]))];
    const settingSources = (txt.match(/settingSourcesFor\(\s*['"](\w+)['"]/) || [])[1]
      || (/settingSources:\s*\[\s*\]/.test(txt) ? 'ninguno' : (/settingSources/.test(txt) ? 'custom' : 'default (user+project)'));
    const permissionModes = [...new Set([...txt.matchAll(/\bpermissionMode:\s*['"](\w+)['"]/g)].map((m) => m[1]))];
    engines.push({
      file: f,
      purpose: purposeOf(f),
      models: models.length ? models : (modelDynamic ? [] : ['default']),
      modelDynamic,
      modelResolvedVia,
      maxTurns, timeouts, allowlists,
      layers: { preToolUse: /PreToolUse/.test(txt), canUseTool: /canUseTool/.test(txt) },
      settingSources, permissionModes,
      queryCalls: (txt.match(/\bquery\s*\(\s*\{/g) || []).length,
      fingerprint: fingerprintOf([f]),
    });
  }
  return engines.sort((a, b) => a.file.localeCompare(b.file));
}

// ===== Coherencia: grafo de dependencias + uso de servicios transversales =====
// FASE de COHERENCIA del "sistema nervioso" (gemela del censo de motores IA):
// determinístico (0 tokens), parsea los imports/require RELATIVOS entre los
// archivos de src/ y bin/ para saber QUIÉN USA A QUIÉN, detecta el consumo de
// los servicios transversales canónicos (comms, bus/interfono, inventory,
// tokens, paths, sdk-settings) y marca señales crudas (llamadas a `gh`, motores
// del SDK, runners y si respetan la regla de oro). Es la FOTO que interpreta el
// runner de Coherencia (bin/cwc-coherence-runner.js): el censo dice "qué se
// usa"; el análisis IA propone "qué debería usarse". A diferencia de la
// Revisión de Salud (audita NODOS: cada módulo por dentro), esto mira las
// ARISTAS (cómo se relacionan los módulos entre sí).
const CANON_SERVICES = [
  { key: 'comms', label: 'Comunicaciones (contexto de contactos/Chris)', match: (f) => f.startsWith('src/modules/comms/') },
  { key: 'bus', label: 'Interfono / bus entre sesiones', match: (f) => f === 'src/core/bus.js' },
  { key: 'inventory', label: 'Inventario / censo del proyecto', match: (f) => f === 'src/core/inventory.js' },
  { key: 'tokens', label: 'Uso de tokens (buildSummary)', match: (f) => f === 'src/modules/tokens/index.js' },
  { key: 'paths', label: 'Validación de rutas (resolveWithinHome/clampToHome)', match: (f) => f === 'src/core/paths.js' },
  { key: 'sdk-settings', label: 'settingSources (fuente única headless/chat)', match: (f) => f === 'src/core/sdk-settings.js' },
];

// Patrones CANÓNICOS del proyecto (3ª dimensión de coherencia: propagación).
// Cada patrón probado (paralelismo, caché incremental, runner desacoplado…)
// DEBERÍA adoptarse donde aplique. El censo detecta: ¿existe el proveedor? ¿quién
// lo adopta? ¿qué sitios parecen reinventarlo? El `candidate` es una heurística
// de LEAD (la IA/humano confirma si de verdad se puede adoptar — para
// paralelismo rige "paralelo lo que LEE, serial lo que ESCRIBE"); cuando es
// demasiado semántico para un regex, queda en null y lo caza la capa IA.
const CANONICAL_PATTERNS = [
  {
    key: 'parallel-pool',
    label: 'Pool paralelo adaptativo (core/pool.js · runAdaptivePool)',
    // El proveedor se movió a core/pool.js (transversal, 2026-07-12);
    // health/pool.js queda re-exportando, así que ambos cuentan como proveedor.
    provider: (f) => f === 'src/core/pool.js' || f === 'src/modules/health/pool.js',
    adopts: (t) => /runAdaptivePool/.test(t),
    // Candidato: bucle for-of con await sobre I/O (NO el for-await de streams del
    // SDK), en un archivo que hace trabajo de red/SDK y no usa el pool.
    candidate: (f, t) => /for\s*\(\s*(?:const|let|var)\s+[\w[\]{}, ]+\s+of\s+[^)]+\)\s*\{[\s\S]{0,300}?\bawait\b/.test(t)
      && /\b(?:query|fetch|execFile|spawnSync|execFileSync)\s*\(/.test(t),
    // Falsos positivos VERIFICADOS a mano (2026-07-06, hallazgo de Coherencia
    // resuelto en chat): seriales POR DISEÑO — no volver a marcarlos.
    //  · backup/index.js: `git add` por archivo ESCRIBE el índice (paralelo
    //    colisiona en index.lock).
    //  · chat/index.js y cwc-chat-runner.js: for-await de streams del SDK
    //    (seriales por naturaleza) + bucles de boot que mutan estado
    //    compartido (rehydrate/cleanup de huérfanos = escritura).
    // Si se les agrega un bucle de LECTURA paralelizable de verdad, sacar la
    // entrada de acá para que el censo lo vuelva a proponer.
    exclude: [
      'src/modules/backup/index.js',
      'src/modules/chat/index.js',
      'bin/cwc-chat-runner.js',
      // Seriales POR DISEÑO (verificado 2026-07-12, hallazgo de Coherencia):
      //  · refresh-shared.js: los importers corren en ORDEN de dependencia
      //    (clients→employees→employee-client-links); paralelizarlos rompería las FK.
      //  · cwc-retro-runner.js: persist() ESCRIBE lecciones en Pad una por una
      //    (regla de oro "serial lo que ESCRIBE").
      'src/modules/tolkien/refresh-shared.js',
      'bin/cwc-retro-runner.js',
      // Falsos positivos VERIFICADOS (2026-07-24, resolución del hallazgo de
      // Coherencia Coh#2): seriales POR DISEÑO — su bucle NO es paralelizable.
      //  · pad-provision.js: provisioning por pasos con `await sleep(SLEEP_MS)`
      //    entre cada uno (pacing deliberado del registro/workspace/colecciones).
      //  · pad-service-client.js: el bucle flageado es un retry/backoff
      //    (for(;;) attempt), no una iteración de items paralelizable.
      //  · zoho-desk-client.js: paginación secuencial [1,101,201] contra la API
      //    de Zoho, que es rate-limited (paralelizar dispararía 429).
      //  · cwc-retro-teams-runner.js: persist() hace upsertLesson en ORDEN
      //    (regla de oro "serial lo que ESCRIBE"; el dedup por fingerprint lo exige).
      'src/core/pad-provision.js',
      'src/core/pad-service-client.js',
      'src/core/zoho-desk-client.js',
      'bin/cwc-retro-teams-runner.js',
      //  · updates/shared.js: los 2 bucles con await sobre subprocesos iteran
      //    colecciones de UN elemento (CORE_PKGS=[agent-sdk], targets=[server.js]);
      //    el resto de sus for-of son síncronos (readFileSync/lookups). Su
      //    concurrencia real ya va por Promise.all (npm outdated+audit, versiones).
      'src/modules/updates/shared.js',
    ],
  },
  {
    key: 'incremental-cache',
    label: 'Caché incremental por fingerprint (inventory · *-cache.json)',
    provider: (f) => f === 'src/core/inventory.js',
    adopts: (t) => /fingerprint/i.test(t) && /cache/i.test(t),
    candidate: null, // demasiado semántico para regex: lo caza la IA
  },
  {
    key: 'detached-runner',
    label: 'Runner desacoplado + lock/heartbeat (regla de oro)',
    provider: (f) => f === 'src/modules/health/optimize-shared.js',
    adopts: (t) => /writeLock|heartbeat|\.lock/i.test(t),
    candidate: null,
  },
];

// Convenciones CANÓNICAS del proyecto (4ª dimensión de coherencia, 2026-07-06).
// A diferencia de CANONICAL_PATTERNS (idiomas de código con UN proveedor
// concreto), estas son reglas TRANSVERSALES de la sección "## Convenciones" de
// CLAUDE.md: aplican a CUALQUIER módulo nuevo/cambiado, no a un archivo puntual
// (eso son los invariantes de Salud, health/invariants.js). Las mecánicamente
// chequeables por regex tienen `violates` (0 tokens, es un LEAD — puede tener
// falsos positivos, la capa IA los descarta leyendo el código); las que
// requieren criterio (¿"nuevo"? ¿"mucho texto"?) quedan con `violates: null` y
// las caza la capa IA del análisis de Coherencia, que recibe el texto de
// "## Convenciones" inyectado en el prompt (coherencePrompt, coherence-shared.js).
// Semilla hand-authored, como CANONICAL_PATTERNS/SEED_INVARIANTS — sumar acá
// cuando una convención nueva merezca chequeo automático. `exclude` (opcional,
// mismo mecanismo que en CANONICAL_PATTERNS) lista archivos con EXCEPCIÓN
// deliberada documentada EN SU PROPIO CÓDIGO: el lead regex los saltea para no
// repetir el mismo falso positivo en cada censo.
const CANONICAL_CONVENTIONS = [
  {
    key: 'colores-tokens',
    label: 'Colores/espaciado solo desde tokens.css (o color-mix sobre ellos)',
    scope: (f) => /^public\/css\/.*\.css$/.test(f) && f !== 'public/css/tokens.css',
    violates: (t) => /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/.test(t),
    // Falso positivo VERIFICADO: public/css/raw.css es la paleta propia de la
    // Vista Raw (easter-egg temático verde-fósforo/negro), DELIBERADAMENTE
    // fuera de tokens.css — la excepción está documentada en la cabecera del
    // propio raw.css y en CLAUDE.md (PLAN-544). Sus colores son HSL de mundo/
    // sesión calculados en JS, no hex sueltos en un CSS compartido.
    exclude: ['public/css/raw.css'],
  },
  {
    key: 'sin-dialogos-nativos',
    label: 'Nunca alert()/confirm()/prompt() nativos — siempre ui/dialog.js',
    scope: (f) => /^public\/js\/.*\.js$/.test(f) && f !== 'public/js/ui/dialog.js',
    violates: (t) => /\b(?:window\.)?(?:alert|confirm|prompt)\s*\(/.test(t),
  },
  {
    key: 'iconos-centralizados',
    label: 'Íconos nuevos solo en ui/icons.js — nunca SVG inline',
    scope: (f) => /^public\/js\/.*\.js$/.test(f) && f !== 'public/js/ui/icons.js',
    violates: (t) => /<svg[\s>]/i.test(t),
    // Falso positivo VERIFICADO a mano (2026-07-06, hallazgo de Coherencia
    // resuelto en chat): las miniaturas del Explorador (folderSVG/fileSVG de
    // fm.js) son SVG RELLENOS a dos tonos (carpeta/archivo), no íconos de
    // trazo — la excepción está documentada en el propio fm.js y los fills
    // usan tokens (var(--cwc-folder), --cwc-cat-*). No pertenecen al set de
    // ui/icons.js; si fm.js suma un ícono de TRAZO inline, sacarlo de acá.
    exclude: ['public/js/filemanager/fm.js'],
  },
  {
    key: 'colapsable-arbol',
    label: 'UI con mucho texto nace COLAPSADA + agrupada en árbol',
    scope: (f) => /^public\/js\/modules\//.test(f),
    violates: null, // semántico ("¿es nuevo? ¿tiene mucho texto?"): lo caza la capa IA
  },
  {
    key: 'subida-archivos-sandbox',
    label: 'Subida de archivos del usuario SIEMPRE por carpeta validada (resolveWithinHome/attachPath/multer) — nunca fs directo con ruta del cliente',
    // Disparador: los adjuntos del chat (chat/attachments.js) y el gestor
    // (files/) escriben archivos del cliente a disco. La regla: el destino
    // sale SIEMPRE de un helper de sandboxing (resolveWithinHome, clampToHome,
    // chatAttachDir/attachPath) + basename saneado; NUNCA se concatena una
    // ruta cruda del request a fs.writeFile/createWriteStream. Semántico
    // (¿la ruta de destino vino de un helper de sandbox?): lo verifica la capa
    // IA de Coherencia sobre los módulos que escriben archivos del usuario.
    scope: (f) => /^src\/modules\/(files|chat)\//.test(f),
    violates: null,
  },
];

// Módulo lógico de un archivo rel-ROOT (agrupa el grafo por módulo).
function moduleOfRel(f) {
  const mm = f.match(/^src\/modules\/([^/]+)\//);
  if (mm) return mm[1];
  if (f.startsWith('src/core/')) return 'core';
  if (f.startsWith('bin/')) return 'bin';
  return 'src';
}

// Resuelve un specifier relativo (./ ../) a una ruta rel-ROOT existente,
// probando .js / .mjs / /index.js. Devuelve null si es paquete externo o no
// existe (así el grafo solo tiene aristas internas reales).
function resolveImport(fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  const baseAbs = path.join(ROOT, path.dirname(fromRel));
  const cand = path.normalize(path.join(baseAbs, spec));
  for (const t of [cand, `${cand}.js`, `${cand}.mjs`, path.join(cand, 'index.js')]) {
    try { if (fss.statSync(t).isFile()) return rel(t); } catch { /* noop */ }
  }
  return null;
}

export function coherenceCensus() {
  const files = [...new Set([...listJs(path.join(ROOT, 'src')), ...listJs(path.join(ROOT, 'bin'))])];
  const texts = new Map(files.map((f) => [f, readSafe(path.join(ROOT, f))]));
  // Llamadas a la CLI `gh` (scraping de GitHub). Dos formas:
  //  · execFile/spawn('gh', ...) — llamada REAL (cualquier verbo).
  //  · string/template `gh pr …` — SOLO el verbo `pr` (lectura de PRs, el único
  //    concern de dedup contra comms/pr-read-shared.js). Antes matcheaba TODOS
  //    los verbos y flageaba strings de comando documentados (p.ej. 'gh auth
  //    login' en keyring-shared.js) como si fueran llamadas — falso positivo.
  const ghRe = /(?:execFile|execFileSync|spawn|spawnSync|exec)\(\s*['"]gh['"]|[`'"]gh\s+pr\b/;

  const nodes = files.map((f) => {
    const t = texts.get(f) || '';
    return {
      file: f,
      module: moduleOfRel(f),
      isRunner: /^bin\/.*(?:runner|orchestrator)/.test(f),
      importsSdk: /from\s+['"]@anthropic-ai\/claude-agent-sdk['"]/.test(t),
      callsQuery: /\bquery\s*\(\s*\{/.test(t),
      // Excluye este mismo archivo: su texto contiene el regex `ghRe` como
      // literal y se auto-matchearía (falso positivo del censor).
      callsGh: f !== 'src/core/inventory.js' && ghRe.test(t),
    };
  });

  // Aristas internas archivo→archivo (imports/require relativos RESUELTOS).
  const edges = [];
  for (const f of files) {
    const t = texts.get(f) || '';
    const specs = new Set([...t.matchAll(/(?:import[^'"]*from\s*|import\s*|require\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]));
    for (const spec of specs) {
      const to = resolveImport(f, spec);
      if (to && to !== f) edges.push({ from: f, to, moduleFrom: moduleOfRel(f), moduleTo: moduleOfRel(to) });
    }
  }

  // Grafo por módulo (uses / usedBy), ignorando aristas dentro del mismo módulo.
  const modUses = new Map();
  const modUsedBy = new Map();
  for (const e of edges) {
    if (e.moduleFrom === e.moduleTo) continue;
    if (!modUses.has(e.moduleFrom)) modUses.set(e.moduleFrom, new Set());
    modUses.get(e.moduleFrom).add(e.moduleTo);
    if (!modUsedBy.has(e.moduleTo)) modUsedBy.set(e.moduleTo, new Set());
    modUsedBy.get(e.moduleTo).add(e.moduleFrom);
  }
  const modules = [...new Set(nodes.map((n) => n.module))].sort().map((m) => ({
    module: m,
    uses: [...(modUses.get(m) || [])].sort(),
    usedBy: [...(modUsedBy.get(m) || [])].sort(),
  }));

  // Servicios transversales: quién los consume (por aristas resueltas, excluyendo
  // los archivos del propio servicio).
  const services = CANON_SERVICES.map((svc) => {
    const providerFiles = files.filter((f) => svc.match(f));
    const consumers = [...new Set(edges.filter((e) => svc.match(e.to) && !svc.match(e.from)).map((e) => e.from))].sort();
    return {
      key: svc.key, label: svc.label, exists: providerFiles.length > 0,
      consumers, consumerModules: [...new Set(consumers.map(moduleOfRel))].sort(),
    };
  });

  // Motores IA (reusa el censo del SDK) — solo lo que necesita la coherencia.
  const engines = aiEnginesCensus().map((e) => ({
    file: e.file, models: e.models, modelDynamic: e.modelDynamic, layers: e.layers, settingSources: e.settingSources, purpose: e.purpose,
  }));

  // Runners: ¿respetan la regla de oro? (lock/heartbeat + estado en ~/.cwc-data).
  // Muchos runners DELEGAN el lock/estado a su `*-shared.js` (patrón del repo):
  // si importan un shared, la persistencia vive ahí — no es un incumplimiento.
  const runners = nodes.filter((n) => n.isRunner).map((n) => {
    const t = texts.get(n.file) || '';
    const hasLock = /Lock\b|\.lock|writeLock|readLock/.test(t);
    const hasHeartbeat = /heartbeat|setInterval\s*\(\s*beat/i.test(t);
    const writesData = /\.cwc-data|DATA_DIR/.test(t);
    const delegatesShared = /from\s+['"][^'"]*-shared(?:\.js)?['"]/.test(t) || /from\s+['"][^'"]*\/shared\.js['"]/.test(t);
    return {
      file: n.file,
      hasLock, hasHeartbeat, writesData, delegatesShared,
      goldenRule: hasLock || hasHeartbeat || writesData || delegatesShared,
    };
  });

  // ===== Completitud del inventario: ¿todo lo nuevo está CABLEADO? =====
  // Reusa los parsers del inventario (registered/mounted ya calculados) + el
  // grafo para detectar lo suelto: módulo backend sin registrar, frontend sin
  // montar, runner o motor SDK huérfano (nadie lo importa ni lo referencia por
  // nombre). Un archivo se considera "referenciado" si otro archivo lo importa
  // (arista) o menciona su basename (los runners se spawnean por string, no por
  // import — de ahí el chequeo por basename).
  const importedFiles = new Set(edges.map((e) => e.to));
  const basenameReferenced = (relFile) => {
    const bn = relFile.split('/').pop();
    for (const [f, t] of texts) { if (f !== relFile && t.includes(bn)) return true; }
    return false;
  };
  const backendMods = parseBackendModules();
  const frontendMods = parseFrontend();
  // Un módulo frontend puede montarse por vista (per-tab, initAuxBar) en vez de
  // por [data-module]; sigue estando CABLEADO si algún otro archivo de public/js
  // lo importa. Solo es "suelto" si NO se monta por data-module NI lo importa
  // nadie (evita marcar chat/terminal/mobile, que main.js monta a mano).
  const frontFiles = listJs(path.join(ROOT, 'public', 'js'));
  const frontText = new Map(frontFiles.map((f) => [f, readSafe(path.join(ROOT, f))]));
  const frontWired = (fm) => {
    if (fm.mounted) return true;
    const bns = fm.files.map((f) => f.split('/').pop());
    for (const [ff, t] of frontText) {
      if (ff.startsWith(fm.dir)) continue;
      if (bns.some((bn) => t.includes(bn))) return true;
    }
    return false;
  };
  const completeness = {
    // Solo una carpeta CON index.js que no esté en MODULES es un módulo backend
    // sin registrar de verdad; una carpeta de librerías shared sin index.js
    // (p.ej. `comms`) no cuenta (evita el falso positivo recurrente).
    unregistered: backendMods.filter((m) => m.hasIndex && !m.registered).map((m) => m.name),
    unmounted: frontendMods.filter((f) => !frontWired(f)).map((f) => f.name),
    orphanRunners: runners.filter((r) => !basenameReferenced(r.file)).map((r) => r.file),
    orphanEngines: engines.filter((e) => !importedFiles.has(e.file) && !basenameReferenced(e.file)).map((e) => e.file),
  };

  // ===== Propagación de patrones canónicos (3ª dimensión) =====
  // Excluye este archivo (define CANONICAL_PATTERNS: su texto contiene los
  // literales de detección y se auto-matchearía como adopter/candidato).
  const SELF = 'src/core/inventory.js';
  const patterns = CANONICAL_PATTERNS.map((pat) => {
    const providerExists = files.some((f) => pat.provider(f));
    const adopters = files.filter((f) => f !== SELF && !pat.provider(f) && pat.adopts(texts.get(f) || ''));
    const candidates = pat.candidate
      ? files.filter((f) => f !== SELF && !pat.provider(f) && !adopters.includes(f)
        && !pat.exclude?.includes(f) && pat.candidate(f, texts.get(f) || ''))
      : [];
    return { key: pat.key, label: pat.label, providerExists, adopters, candidates };
  });

  // ===== Convenciones transversales (4ª dimensión) =====
  // Escanea public/js (ya listado arriba como frontFiles/frontText, para la
  // completitud) + public/css (listado acá, plano — no hay lector genérico de
  // .css en este archivo). `violates` es un LEAD determinístico; las entradas
  // con `violates: null` quedan en scopedCount para que la IA las verifique
  // contra el texto real de "## Convenciones" (coherence-shared.js).
  const cssDir = path.join(ROOT, 'public', 'css');
  let cssFiles = [];
  try { cssFiles = fss.readdirSync(cssDir).filter((f) => f.endsWith('.css')).map((f) => `public/css/${f}`); } catch { /* noop */ }
  const cssText = new Map(cssFiles.map((f) => [f, readSafe(path.join(ROOT, f))]));
  const webFiles = [...frontFiles, ...cssFiles];
  const webText = (f) => frontText.get(f) ?? cssText.get(f) ?? '';
  const conventions = CANONICAL_CONVENTIONS.map((c) => {
    const scoped = webFiles.filter((f) => c.scope(f));
    // `exclude`: excepciones deliberadas documentadas en su propio archivo
    // (falsos positivos verificados del lead) — se saltean SOLO en el chequeo
    // mecánico; el archivo sigue en scope para la capa IA.
    const violations = c.violates
      ? scoped.filter((f) => !c.exclude?.includes(f) && c.violates(webText(f)))
      : [];
    return { key: c.key, label: c.label, mechanical: !!c.violates, scopedCount: scoped.length, violations };
  });

  return {
    counts: { files: files.length, edges: edges.length, modules: modules.length },
    modules, services, engines, runners, completeness, patterns, conventions,
    ghCallers: nodes.filter((n) => n.callsGh).map((n) => ({ file: n.file, module: n.module })),
  };
}

// Arma el inventario completo. `stamp` = timestamp (el server pasa Date.now();
// nunca lo llamamos acá para no romper entornos sin reloj).
export function buildInventory(stamp) {
  const modules = parseBackendModules();
  const runners = parseRunners();
  const frontend = parseFrontend();
  const vocabulary = parseVocabulary();
  const aiEngines = aiEnginesCensus();
  // Todos los archivos rastreados → mtime máx (gate de frescura) + fingerprint global.
  const allFiles = [
    ...modules.flatMap((m) => m.files),
    ...runners.map((r) => r.file),
    ...frontend.flatMap((f) => f.files),
    'src/core/registry.js', 'public/index.html', 'public/css/tokens.css',
    'src/core/config.js', 'src/core/claude-model.js', 'src/modules/chat/shared.js',
  ];
  return {
    generatedAt: stamp || null,
    sourceMaxMtime: maxMtime([...new Set(allFiles)]),
    fingerprint: fingerprintOf([...new Set(allFiles)].sort()),
    counts: { modules: modules.length, runners: runners.length, frontend: frontend.length, aiEngines: aiEngines.length },
    modules, runners, frontend, vocabulary, aiEngines,
  };
}

// Vista legible (la que consultan humanos y, en la Fase 3, los chats).
export function inventoryMarkdown(inv) {
  const L = [];
  L.push('# Inventario del proyecto — Claude Web Console');
  L.push('');
  L.push('> CENSO VIVO generado por `src/core/inventory.js` (Fase 1 del sistema');
  L.push('> nervioso). Las REGLAS/receta viven en `CLAUDE.md`; esto es "qué');
  L.push('> existe AHORA". NO editar a mano: se regenera solo.');
  L.push('');
  L.push(`Generado: ${inv.generatedAt ? new Date(inv.generatedAt).toISOString() : '—'} · fingerprint \`${inv.fingerprint}\``);
  L.push(`Módulos: ${inv.counts.modules} · Runners: ${inv.counts.runners} · Frontend: ${inv.counts.frontend}`);
  L.push('');
  L.push('## Módulos backend (`src/modules/*`, montados en `registry.js`)');
  for (const m of inv.modules) {
    // Una carpeta sin index.js es librería shared (no un módulo registrable):
    // se marca aparte, no como "NO registrado" (que implicaría un olvido).
    const regTag = m.registered ? '' : (m.hasIndex ? ' ⚠️ NO registrado' : ' · librerías shared (sin index.js)');
    L.push(`### ${m.name}${regTag}  \`${m.fingerprint}\``);
    if (m.purpose) L.push(`- ${m.purpose}`);
    L.push(`- registro: registry.js${m.registryLine ? `:${m.registryLine}` : ' (no encontrado)'}`);
    if (m.endpoints.length) L.push(`- endpoints: ${m.endpoints.join(' · ')}`);
    L.push(`- archivos: ${m.files.join(', ') || '—'}`);
  }
  L.push('');
  L.push('## Runners desacoplados (`bin/`)');
  for (const r of inv.runners) L.push(`- \`${r.file}\` — ${r.purpose || 'sin descripción'}`);
  L.push('');
  L.push('## Frontend (`public/js/modules/*`, montados por `[data-module]`)');
  for (const f of inv.frontend) L.push(`- **${f.name}** (${f.dir})${f.mounted ? '' : ' · no montado directo'} — ${f.files.length} archivo(s)`);
  L.push('');
  if (inv.aiEngines?.length) {
    L.push('## Motores IA (corridas del Agent SDK: qué modelo usa cada uno)');
    for (const e of inv.aiEngines) {
      const model = e.models.length ? e.models.join('/') : (e.modelDynamic ? 'dinámico (lo elige el llamador)' : 'default');
      const via = e.modelResolvedVia ? ` (vía ${e.modelResolvedVia})` : '';
      const capas = [e.layers.preToolUse ? 'PreToolUse' : null, e.layers.canUseTool ? 'canUseTool' : null].filter(Boolean).join('+') || 'SIN capas';
      L.push(`- \`${e.file}\` — modelo **${model}**${via} · maxTurns ${e.maxTurns.join('/') || '—'} · blindaje ${capas}${e.allowlists.length ? ` (${e.allowlists.join(', ')})` : ''} · settings ${e.settingSources}${e.purpose ? ` — ${e.purpose}` : ''}`);
    }
    L.push('');
  }
  L.push('## Vocabulario del proyecto (usar ESTO, no reinventar)');
  L.push(`- **Tokens CSS** (${inv.vocabulary.cssTokens.length}): \`${inv.vocabulary.cssTokens.join('`, `')}\``);
  L.push(`- **Env vars**: \`${inv.vocabulary.envVars.join('`, `')}\``);
  L.push(`- **Modelos** (VALID_MODELS): \`${inv.vocabulary.models.join('`, `')}\``);
  L.push(`- **Modos de permiso**: \`${inv.vocabulary.permissionModes.join('`, `')}\``);
  L.push('');
  return L.join('\n');
}

// Lee el inventario cacheado (o null).
export function readInventory() {
  try { return JSON.parse(fss.readFileSync(INVENTORY_JSON, 'utf8')); } catch { return null; }
}

// Genera y persiste (json + md). Con `force=false` (default) es ON-DEMAND: si
// el inventario cacheado sigue fresco (ningún archivo cambió su mtime), NO
// re-parsea — devuelve el cacheado con { regenerated:false }.
export function generateInventory({ force = false, stamp = Date.now() } = {}) {
  const cached = readInventory();
  if (!force && cached) {
    const now = buildInventory(stamp); // barato: parsear es ms
    if (now.sourceMaxMtime <= (cached.sourceMaxMtime || 0) && now.fingerprint === cached.fingerprint) {
      return { inventory: cached, regenerated: false };
    }
  }
  const inv = buildInventory(stamp);
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(INVENTORY_JSON, JSON.stringify(inv, null, 2), { mode: 0o600 });
    fss.writeFileSync(INVENTORY_MD, inventoryMarkdown(inv), { mode: 0o600 });
  } catch (err) { console.error('[inventory] no pude escribir:', err?.message); }
  return { inventory: inv, regenerated: true };
}
