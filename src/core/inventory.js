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
  // Orden y nombres del array MODULES.
  const arrMatch = registry.match(/const MODULES = \[([^\]]+)\]/);
  const order = arrMatch ? arrMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  const modsDir = path.join(ROOT, 'src', 'modules');
  let dirs = [];
  try { dirs = fss.readdirSync(modsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* noop */ }
  // Ordena por el array de registry; los no listados van al final.
  dirs.sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  return dirs.map((name) => {
    const files = listJs(path.join(modsDir, name));
    const index = files.find((f) => f.endsWith(`${name}/index.js`)) || files[0];
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
    // Línea de registro en registry.js (import).
    const impLine = regLines.findIndex((l) => new RegExp(`import\\s+${name}\\s+from`).test(l));
    // ¿Runner detached asociado? (chat/health/triage… — 'bugs' usa 'triage')
    return {
      name, kind: 'backend',
      registryLine: impLine >= 0 ? impLine + 1 : null,
      registered: order.includes(name),
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
  const texts = new Map();
  for (const f of candidates) {
    const txt = readSafe(path.join(ROOT, f));
    texts.set(f, txt);
    for (const m of txt.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]+)\s*=\s*([0-9][\d_\s*+\-.]*?)\s*;/g)) {
      constMap[m[1]] = m[2].replace(/\s+/g, ' ').trim();
    }
  }
  const resolveConst = (name) => (/^\d+$/.test(name) ? name : (constMap[name] ? `${name} (${constMap[name]})` : name));

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
      maxTurns, timeouts, allowlists,
      layers: { preToolUse: /PreToolUse/.test(txt), canUseTool: /canUseTool/.test(txt) },
      settingSources, permissionModes,
      queryCalls: (txt.match(/\bquery\s*\(/g) || []).length,
      fingerprint: fingerprintOf([f]),
    });
  }
  return engines.sort((a, b) => a.file.localeCompare(b.file));
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
    L.push(`### ${m.name}${m.registered ? '' : ' ⚠️ NO registrado'}  \`${m.fingerprint}\``);
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
      const capas = [e.layers.preToolUse ? 'PreToolUse' : null, e.layers.canUseTool ? 'canUseTool' : null].filter(Boolean).join('+') || 'SIN capas';
      L.push(`- \`${e.file}\` — modelo **${model}** · maxTurns ${e.maxTurns.join('/') || '—'} · blindaje ${capas}${e.allowlists.length ? ` (${e.allowlists.join(', ')})` : ''} · settings ${e.settingSources}${e.purpose ? ` — ${e.purpose}` : ''}`);
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
