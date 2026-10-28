// modules/updates/shared.js — CENSO determinístico de versiones de terceros
// (0 tokens IA, subprocess CLI/lectura de archivos, mismo espíritu que
// core/inventory.js y modules/mcps). Contesta la pregunta que hoy nadie mira:
// "¿qué de lo que la consola depende de AFUERA quedó viejo o con CVE?".
//
// Fuentes, todas SOLO LECTURA (ningún comando muta el sistema):
//   · npm outdated --json      → librerías npm current→wanted→latest
//   · npm audit --json         → vulnerabilidades conocidas (severidad)
//   · npm view <pkg> version   → última del Claude Code CLI (npm global)
//   · claude --version         → versión instalada del CLI
//   · codex/npm view           → versión instalada/última del Codex CLI
//   · ~/.codex/models_cache    → modelos que el Codex CLI ya ofrece
//   · claude mcp list          → estado informativo de los MCP de la consola
//   · apt list --upgradable    → paquetes del SO con update (INFORMATIVO)
//   · apt-cache policy gh       → gh (informativo, resaltado)
//   · pad --version            → Pad local self-hosted (sin auto-check upstream)
//   · node/tmux/zerotier -v    → versión actual (sin "latest" — solo referencia)
//
// El APLICADO (npm install <pkg>@<v>, claude update) vive en index.js con
// admin-gating + whitelist. Acá solo se CENSA.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VALID_MODELS } from '../../core/claude-model.js';
import { CODEX_MODEL_EFFORTS } from '../chat/codex-models.js';
import { runMcpList } from '../mcps/login-shared.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const CENSUS_VERSION = 2;

// La lectura persistida vive en index.js. Se exporta este guard para que ese
// consumidor invalide snapshots de una forma anterior cuando lo pueda cablear.
export function isCensusStale(cached) {
  return !cached || cached.version !== CENSUS_VERSION;
}

// exec que NUNCA lanza: devuelve {ok, stdout, stderr, code}. Muchos de estos
// comandos (npm outdated, npm audit) salen con código ≠0 CUANDO ENCUENTRAN algo
// —no es un error—, así que jamás tratamos el exit code como fallo por sí solo.
function run(cmd, args, { cwd = ROOT, timeout = 60_000, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, env: env || process.env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        failed: !!err && (err.killed || !!err.signal || typeof err.code !== 'number'),
      });
    });
  });
}

function safeJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function readPackageJson() {
  try { return safeJson(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) || {}; }
  catch { return {}; }
}

// --- Catálogo "¿qué es esto?" (hand-authored, español) ---------------------
// Para que un ítem del panel se pueda desplegar y explique QUÉ es y PARA QUÉ lo
// usa ESTA consola (pedido de Niko 2026-07-21). Lo no catalogado cae al
// `description` oficial del package.json en node_modules (instantáneo, sin red).
export const PKG_INFO = {
  '@anthropic-ai/claude-agent-sdk': { what: 'El SDK oficial de Anthropic que habla con Claude.', role: 'Es el MOTOR de la consola: cada chat, cada runner y cada análisis IA corre a través de él. Si falla, no funciona nada que use IA.' },
  '@xterm/xterm': { what: 'Emulador de terminal para el navegador.', role: 'Dibuja las terminales que ves en la consola (las sesiones tmux y las TUI de Claude).' },
  '@xterm/addon-fit': { what: 'Complemento de xterm que ajusta el tamaño.', role: 'Hace que la terminal se adapte sola al tamaño de la ventana o del celular.' },
  '@xterm/addon-web-links': { what: 'Complemento de xterm que detecta URLs.', role: 'Convierte los links que aparecen en la terminal en enlaces clickeables.' },
  '@xterm/addon-clipboard': { what: 'Complemento de xterm para copiar/pegar.', role: 'Permite copiar texto desde la terminal del navegador.' },
  archiver: { what: 'Librería para crear archivos comprimidos (.zip/.tar.gz).', role: 'Arma el tar.gz del backup completo cuando apretás "Backup" en el menú Sistema.' },
  baileys: { what: 'Cliente NO oficial de WhatsApp (habla su protocolo por WebSocket).', role: 'Es el puente de WhatsApp: recibe y envía mensajes/adjuntos del daemon. FIJADO a propósito — su versión nueva es un release candidate y ya rompió una vez.' },
  'chart.js': { what: 'Librería de gráficos para el navegador.', role: 'Dibuja las gráficas de consumo de tokens del modal "Uso" (tendencia por día/semana/mes).' },
  compression: { what: 'Middleware de Express que comprime las respuestas HTTP (gzip).', role: 'Hace que la consola cargue más rápido, sobre todo desde el celular por ZeroTier.' },
  cookie: { what: 'Librería para leer y escribir cookies HTTP.', role: 'Parte del login: mantiene tu sesión iniciada en el navegador.' },
  dotenv: { what: 'Carga variables de entorno desde el archivo .env.', role: 'Lee tu configuración privada (token maestro, puerto, rutas) al arrancar el server.' },
  express: { what: 'El framework web sobre el que corre el servidor.', role: 'Es la base de TODA la consola: sirve las páginas y los endpoints de la API. El más delicado de actualizar.' },
  'highlight.js': { what: 'Resaltador de sintaxis de código.', role: 'Pinta con colores los bloques de código en el chat y los diffs de las herramientas.' },
  marked: { what: 'Convertidor de Markdown a HTML.', role: 'Renderiza las respuestas del chat, las notas de tareas y la documentación en pantalla.' },
  mermaid: { what: 'Genera diagramas a partir de texto (flujos, secuencias).', role: 'Convierte los bloques ```mermaid``` que escribe el modelo en diagramas visuales dentro del chat.' },
  multer: { what: 'Middleware de Express para recibir archivos subidos.', role: 'Maneja los adjuntos que arrastrás o pegás en el chat (imágenes, PDFs, documentos).' },
  'node-pty': { what: 'Crea terminales reales (pseudo-terminales) desde Node.', role: 'Es lo que permite que las sesiones tmux y las TUI de Claude funcionen de verdad en el navegador. Se compila al instalar.' },
  pino: { what: 'Librería de logging rápido.', role: 'Escribe los registros del servidor (lo que ves con journalctl).' },
  qrcode: { what: 'Generador de códigos QR.', role: 'Dibuja el QR para emparejar la cuenta de WhatsApp la primera vez.' },
  ws: { what: 'Implementación de WebSockets para Node.', role: 'Es el canal en vivo entre el navegador y el server: por acá viajan los mensajes del chat, la terminal y los avisos en tiempo real.' },
  'playwright-core': { what: 'Navegador automatizable (Chromium sin interfaz).', role: 'Herramienta de desarrollo: verifica que la interfaz funciona tras un cambio. No corre en producción.' },
};

// Servicios/runtime (no son paquetes npm).
export const SERVICE_INFO = {
  'Pad local (self-hosted)': { what: 'El tracker de proyectos (issues, planes, convenciones) que corre en tu propio server.', role: 'Es la columna vertebral donde se registran tareas, bugs y decisiones de la consola. Vive como servicio systemd aparte, en el puerto 7777.' },
  'Node.js': { what: 'El motor de JavaScript sobre el que corre todo.', role: 'Ejecuta el servidor de la consola y todos los runners. Cambiarlo de versión mayor es delicado: hay que probar todo.' },
  tmux: { what: 'Multiplexor de terminales.', role: 'Mantiene vivas las sesiones de terminal aunque cierres el navegador o se reinicie la web. Es la clave de la resiliencia.' },
  ZeroTier: { what: 'Red privada virtual (VPN peer-to-peer).', role: 'Es la red por la que accedés a la consola de forma segura. El server escucha SOLO en esta red — si falla, no hay acceso.' },
};

// Paquetes de sistema (apt) más notables. El resto cae a un texto genérico.
export const APT_INFO = {
  gh: 'Cliente oficial de GitHub por línea de comandos. La consola lo usa para leer PRs, releases y changelogs.',
  'docker-ce': 'Motor de contenedores Docker. No lo usa la consola directamente, pero corre otros servicios de la máquina.',
  'docker-ce-cli': 'Cliente de línea de comandos de Docker.',
  'containerd.io': 'Runtime de contenedores que usa Docker por debajo.',
  'docker-compose-plugin': 'Complemento de Docker para orquestar varios contenedores.',
  'docker-model-plugin': 'Complemento de Docker para modelos.',
  'docker-ce-rootless-extras': 'Extras para correr Docker sin privilegios de root.',
  infisical: 'Gestor de secretos/credenciales por línea de comandos (lo usa el refresh de la base de Tolkien).',
  apport: 'Sistema de reportes de errores de Ubuntu.',
  'apport-core-dump-handler': 'Manejador de volcados de memoria de Ubuntu.',
  'python3-apport': 'Componente Python del sistema de reportes de Ubuntu.',
  'python3-problem-report': 'Componente Python del sistema de reportes de Ubuntu.',
  iproute2: 'Herramientas de red del sistema (comandos ip, ss). La consola las usa para detectar la IP de ZeroTier.',
  plymouth: 'Pantalla gráfica de arranque del sistema.',
  'plymouth-theme-ubuntu-text': 'Tema de la pantalla de arranque.',
  libplymouth5: 'Librería de la pantalla de arranque.',
  'multipath-tools': 'Herramientas de almacenamiento con múltiples rutas.',
  kpartx: 'Utilidad de particiones de disco.',
  libxmlb2: 'Librería de manejo de XML binario.',
};

// Descripción oficial del paquete leída del node_modules local (sin red).
function npmDescription(name) {
  try {
    const p = path.join(ROOT, 'node_modules', ...name.split('/'), 'package.json');
    const d = safeJson(fs.readFileSync(p, 'utf8'));
    return d?.description ? String(d.description).slice(0, 200) : null;
  } catch { return null; }
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); }

// Archivos del proyecto que importan cada paquete — para poder "indagar más
// adelante". UN solo grep para todos (barato) y luego se atribuye por archivo.
async function buildUsageMap(names) {
  const map = {};
  for (const n of names) map[n] = [];
  if (!names.length) return map;
  const pattern = `(from ['"]|require\\(['"])(${names.map(escapeRe).join('|')})`;
  const r = await run('grep', ['-rlE', pattern, 'src', 'bin', 'public/js'], { timeout: 20_000 });
  const files = r.stdout.split('\n').filter(Boolean).slice(0, 300);
  for (const file of files) {
    let content = '';
    try { content = fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { continue; }
    for (const n of names) {
      if (map[n].length >= 6) continue;
      if (new RegExp(`(from ['"]|require\\(['"])${escapeRe(n)}`).test(content)) map[n].push(file);
    }
  }
  return map;
}

// --- Clasificación de riesgo de cada paquete npm ---------------------------
// 🧬 core  = motor productivo, actualizar con cuidado + reinicio (Agent SDK).
// 🔴 watch = actualización peligrosa/silenciosa, NO botón (Baileys: rompió una
//            vez con la librería anterior; su "latest" es un RC 7.x breaking).
// 🟢 lib   = librería normal, reversible con git, botón directo.
const CORE_PKGS = new Set(['@anthropic-ai/claude-agent-sdk']);
const WATCH_PKGS = new Set(['baileys']); // fijado a propósito, ver CLAUDE.md comms/
function npmRisk(name) {
  if (CORE_PKGS.has(name)) return 'core';
  if (WATCH_PKGS.has(name)) return 'watch';
  return 'lib';
}

// Un salto de MAJOR (primer número distinto) es potencialmente breaking → lo
// marcamos para que el front lo muestre en ámbar aunque tenga botón.
function isMajorBump(current, latest) {
  const a = String(current || '').split('.')[0];
  const b = String(latest || '').split('.')[0];
  return a && b && a !== b;
}

// --- npm outdated + audit → librerías --------------------------------------
// Versión REALMENTE instalada de un paquete (lee node_modules/.../package.json,
// instantáneo). Es la fuente de verdad de "qué corre hoy" — más confiable que el
// `current` de npm outdated, que además OMITE los paquetes ya al día.
export function installedVersion(name) {
  try {
    const p = path.join(ROOT, 'node_modules', ...name.split('/'), 'package.json');
    return safeJson(fs.readFileSync(p, 'utf8'))?.version || null;
  } catch { return null; }
}

async function censusNpm() {
  const [outdated, audit] = await Promise.all([
    run('npm', ['outdated', '--json'], { timeout: 90_000 }),
    run('npm', ['audit', '--json', '--omit=dev'], { timeout: 90_000 }),
  ]);

  const parsedOutdated = safeJson(outdated.stdout);
  const parsedAudit = safeJson(audit.stdout);
  const od = parsedOutdated || {};
  const pkg = readPackageJson();
  const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  const libs = Object.entries(od).map(([name, info]) => {
    // `current` de outdated puede venir vacío; caemos a lo instalado en disco.
    const current = info.current || installedVersion(name) || null;
    const latest = info.latest || null;
    const wanted = info.wanted || null;
    return {
      name,
      current,
      wanted,
      latest,
      declared: declared[name] || null,
      risk: npmRisk(name),
      major: isMajorBump(current, latest),
      // "Actualizar" apunta a `wanted` por defecto (respeta el rango de
      // package.json = lo estable), pero exponemos `latest` para decidir.
      upToDate: current && latest && current === latest,
    };
  });

  // Los paquetes CORE (motor) SIEMPRE aparecen, aunque estén al día — npm
  // outdated los omite cuando no hay nada que actualizar, y entonces el Motor
  // "desaparecía" de la vista (confuso: parecía que no se aplicó el update).
  // Para los que falten, leemos la versión instalada (fs) + la última (npm view)
  // y los mostramos como "al día".
  for (const name of CORE_PKGS) {
    if (libs.some((l) => l.name === name)) continue;
    const current = installedVersion(name);
    if (!current) continue;
    const view = await run('npm', ['view', name, 'version'], { timeout: 30_000 });
    const latest = view.stdout.trim().match(/^\d+\.\d+\.\d+/) ? view.stdout.trim() : current;
    libs.push({
      name, current, wanted: current, latest,
      declared: declared[name] || null,
      risk: 'core', major: isMajorBump(current, latest),
      upToDate: current === latest,
    });
  }

  const usage = await buildUsageMap(libs.map((l) => l.name));
  for (const l of libs) {
    const cat = PKG_INFO[l.name];
    l.info = {
      what: cat?.what || npmDescription(l.name) || null,
      role: cat?.role || null,
      usedIn: usage[l.name] || [],
    };
  }

  libs.sort((a, b) => {
    // core arriba, luego watch, luego el resto alfabético.
    const order = { core: 0, watch: 1, lib: 2 };
    return (order[a.risk] - order[b.risk]) || a.name.localeCompare(b.name);
  });

  // Vulnerabilidades: npm audit --json v2 → .vulnerabilities{name:{severity,...}}
  const av = parsedAudit || {};
  const vulns = [];
  const vObj = av.vulnerabilities || {};
  for (const [name, v] of Object.entries(vObj)) {
    // Solo las entradas "raíz" (las que son dependencia directa o tienen fix).
    if (!v || typeof v !== 'object') continue;
    vulns.push({
      name,
      severity: v.severity || 'unknown',            // low|moderate|high|critical
      range: v.range || '',
      fixAvailable: v.fixAvailable === true || (v.fixAvailable && typeof v.fixAvailable === 'object'),
      via: Array.isArray(v.via) ? v.via.filter((x) => typeof x === 'string' || (x && x.title)).map((x) => (typeof x === 'string' ? x : x.title)).slice(0, 3) : [],
    });
  }
  const sevRank = { critical: 0, high: 1, moderate: 2, low: 3, unknown: 4 };
  vulns.sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9));

  const meta = av.metadata?.vulnerabilities || {};
  const errors = [];
  if (outdated.failed || (!outdated.ok && !parsedOutdated)) errors.push('npm outdated falló');
  if (audit.failed || (!audit.ok && !parsedAudit)) errors.push('npm audit falló');
  return { libs, vulns, vulnCounts: meta, error: errors.join('; ') || null };
}

// --- Claude Code CLI (npm global, tiene su propio updater) -----------------
async function censusClaudeCli() {
  const [ver, latest, which] = await Promise.all([
    run('claude', ['--version'], { timeout: 15_000 }),
    run('npm', ['view', '@anthropic-ai/claude-code', 'version'], { timeout: 30_000 }),
    run('which', ['claude'], { timeout: 10_000 }),
  ]);
  const current = (ver.stdout.match(/(\d+\.\d+\.\d+)/) || [])[1] || null;
  const newest = latest.stdout.trim().match(/^\d+\.\d+\.\d+$/) ? latest.stdout.trim() : null;
  const whichPath = which.stdout.trim().split('\n')[0] || null;
  const real = whichPath ? await run('readlink', ['-f', whichPath], { timeout: 10_000 }) : null;
  const resolvedPath = real?.stdout?.trim().split('\n')[0] || whichPath;
  const home = path.resolve(process.env.HOME || '');
  const manageable = resolvedPath
    ? (() => {
        const rel = path.relative(home, path.resolve(resolvedPath));
        return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
      })()
    : null;
  return {
    name: '@anthropic-ai/claude-code',
    current,
    latest: newest,
    upToDate: current && newest && current === newest,
    resolvedPath,
    manageable,
    note: manageable === false
      ? 'Instalación de sistema (root) — `claude update` no puede actualizarla. Requiere sudo/npm global del sistema.'
      : null,
    // el CLI trae `claude update` incorporado → botón directo (reversible: su
    // propio updater, no toca el repo).
    updatable: manageable !== false,
  };
}

// --- Codex CLI (npm global del usuario, ejecutor del Modo Tándem) ----------
async function censusCodexCli() {
  const [ver, latest, which] = await Promise.all([
    run('codex', ['--version'], { timeout: 15_000 }),
    run('npm', ['view', '@openai/codex', 'version'], { timeout: 30_000 }),
    run('which', ['codex'], { timeout: 10_000 }),
  ]);
  const current = (ver.stdout.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/) || [])[1] || null;
  const newest = (latest.stdout.trim().match(/^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/) || [])[1] || null;
  const whichPath = which.stdout.trim().split('\n')[0] || null;
  if (!whichPath && !current) return { installed: false };

  const real = whichPath ? await run('readlink', ['-f', whichPath], { timeout: 10_000 }) : null;
  const resolvedPath = real?.stdout?.trim().split('\n')[0] || whichPath;
  const home = path.resolve(process.env.HOME || '');
  const manageable = resolvedPath
    ? (() => {
        const rel = path.relative(home, path.resolve(resolvedPath));
        return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
      })()
    : null;
  return {
    current,
    latest: newest,
    upToDate: current && newest && current === newest,
    manageable,
    path: resolvedPath,
    updateCmd: manageable === false ? null : 'npm install -g @openai/codex@latest',
    note: manageable === false
      ? 'Instalación de sistema (root) — npm global del usuario no puede actualizarla. Requiere sudo/npm global del sistema.'
      : null,
    info: {
      what: 'CLI de OpenAI que corre los modelos GPT/Codex.',
      role: 'Es el ejecutor del Modo Tándem: Claude planea y Codex implementa el código; también alimenta el medidor de consumo de Codex.',
    },
  };
}

// --- Catálogos de modelos ofrecidos por los CLIs --------------------------
// Señala el hueco entre lo que el CLI ya conoce y lo que la consola permite.
// No ofrece update: cerrar un `missing` exige editar la whitelist indicada.
async function censusModels() {
  const codexHint = 'src/modules/chat/codex-models.js';
  const claudeHint = 'src/core/claude-model.js';
  const codexFile = path.join(process.env.HOME || '', '.codex', 'models_cache.json');
  let codex;
  try {
    const cache = JSON.parse(fs.readFileSync(codexFile, 'utf8'));
    if (!Array.isArray(cache.models)) throw new Error('la clave models no es un array');
    const known = Object.keys(CODEX_MODEL_EFFORTS);
    // Un modelo `hide` no se puede sumar a la whitelist ni sacar del cache:
    // reportarlo como `missing` crea un aviso imposible de cerrar (BUG-2817).
    // Si `visibility` no viene, conservamos la entrada por compatibilidad futura.
    const available = [...new Set(cache.models
      .filter((model) => (
        !model
        || typeof model !== 'object'
        || model.visibility === undefined
        || model.visibility === 'list'
      ))
      .map((model) => {
        if (typeof model === 'string') return model;
        if (!model || typeof model !== 'object') return null;
        return model.id || model.slug || model.name || null;
      })
      .filter(Boolean)
      .map(String))];
    const hidden = [...new Set(cache.models
      .filter((model) => (
        model
        && typeof model === 'object'
        && model.visibility !== undefined
        && model.visibility !== 'list'
      ))
      .map((model) => model.id || model.slug || model.name || null)
      .filter(Boolean)
      .map(String))];
    const knownSet = new Set(known);
    codex = {
      known,
      available,
      hidden,
      missing: available.filter((model) => !knownSet.has(model)),
      fetchedAt: cache.fetched_at || null,
      clientVersion: cache.client_version || null,
      file: codexFile,
      hint: codexHint,
    };
  } catch (err) {
    codex = {
      error: `No se pudo leer el catálogo de modelos de Codex: ${String(err?.message || err).slice(0, 240)}`,
      hint: codexHint,
    };
  }

  const claude = {
    known: [...VALID_MODELS],
    source: 'hardcoded',
    note: 'El CLI de Claude no expone un catálogo de modelos en disco; esta lista se mantiene a mano en src/core/claude-model.js. Revisala tras actualizar el CLI.',
    hint: claudeHint,
  };
  return { codex, claude };
}

// --- MCP configurados para el cwd de esta consola (solo informativo) -------
async function censusMcps() {
  let timer;
  try {
    const listed = await Promise.race([
      runMcpList(ROOT).catch(() => ({ servers: [], error: 'mcp list falló' })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({
          servers: [],
          error: 'claude mcp list excedió el timeout de 15 s',
        }), 15_000);
      }),
    ]);
    return {
      items: (listed.servers || []).map(({ name, status }) => ({ name, status })),
      error: listed.error || null,
      note: 'Censo informativo: los MCP se administran y reconectan por separado; esta sección no ofrece actualizarlos.',
    };
  } catch (err) {
    return {
      items: [],
      error: String(err?.message || err).slice(0, 300),
      note: 'Censo informativo: los MCP se administran y reconectan por separado; esta sección no ofrece actualizarlos.',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- Sistema operativo (apt) — INFORMATIVO, sin botón ----------------------
async function censusApt() {
  const up = await run('apt', ['list', '--upgradable'], { timeout: 30_000 });
  const lines = up.stdout.split('\n').filter((l) => l.includes('/') && l.includes('upgradable from'));
  const pkgs = lines.map((l) => {
    // formato: name/repo cand-version arch [upgradable from: cur-version]
    const name = l.split('/')[0].trim();
    const cand = (l.match(/\s(\S+)\s+\w+\s+\[upgradable/) || [])[1] || '';
    const from = (l.match(/upgradable from:\s*([^\]]+)\]/) || [])[1]?.trim() || '';
    return { name, current: from, latest: cand, highlight: name === 'gh' || name.startsWith('docker'), info: APT_INFO[name] || 'Paquete del sistema operativo (Ubuntu).' };
  }).sort((a, b) => (Number(b.highlight) - Number(a.highlight)) || a.name.localeCompare(b.name));
  return { count: pkgs.length, pkgs };
}

// Última versión ESTABLE de Pad self-hosted desde su repo de GitHub
// (PerpetualSoftware/pad) con `gh` — determinístico, 0 tokens. Ignora los
// pre-release (v0.10.0-rc.1). Best-effort: si gh falla, devuelve null.
async function padLatest() {
  try {
    const r = await run('gh', ['api', 'repos/PerpetualSoftware/pad/releases/latest', '--jq', '.tag_name'], { timeout: 30_000 });
    const tag = r.stdout.trim().replace(/^v/, '');
    return /^\d+\.\d+\.\d+$/.test(tag) ? tag : null;
  } catch { return null; }
}

// --- Piezas con versión actual pero sin canal simple de "latest" -----------
async function censusServices() {
  const [pad, node, tmux, zt, padNew] = await Promise.all([
    run(path.join(process.env.HOME || '', '.local/bin/pad'), ['--version'], { timeout: 10_000 }),
    run('node', ['--version'], { timeout: 10_000 }),
    run('tmux', ['-V'], { timeout: 10_000 }),
    run('zerotier-cli', ['-v'], { timeout: 10_000 }),
    padLatest(),
  ]);
  const clean = (s) => String(s || '').trim().split('\n')[0];
  // `pad --version` = "pad version 0.9.2 (hash ts)" → extraer el semver.
  const padRaw = clean(pad.stdout) || clean(pad.stderr) || '';
  const padCur = (padRaw.match(/\d+\.\d+\.\d+/) || [])[0] || null;
  const padUpToDate = padCur && padNew ? padCur === padNew : null;
  return [
    {
      name: 'Pad local (self-hosted)',
      current: padCur || padRaw || '—',
      latest: padNew,
      upToDate: padUpToDate,
      note: padNew
        ? (padUpToDate ? 'al día (última estable en GitHub)' : `hay una versión nueva (${padNew}) — el binario se cambia a mano por SSH, no desde el botón (es un servicio systemd aparte)`)
        : 'revisá releases en github.com/PerpetualSoftware/pad — no se pudo consultar automáticamente',
      info: SERVICE_INFO['Pad local (self-hosted)'] || null,
    },
    { name: 'Node.js', current: clean(node.stdout) || '—', note: 'runtime — cambio mayor solo con prueba', info: SERVICE_INFO['Node.js'] || null },
    { name: 'tmux', current: clean(tmux.stdout) || '—', note: 'estable, apt lo mantiene', info: SERVICE_INFO.tmux || null },
    { name: 'ZeroTier', current: clean(zt.stdout) || '—', note: 'red — no tocar sin necesidad', info: SERVICE_INFO.ZeroTier || null },
  ];
}

// Endpoints/librerías VIGILADAS: dependen de terceros no versionables o
// documentados como best-effort a propósito. Sin botón — solo aviso.
const WATCHED = [
  {
    name: 'Baileys (WhatsApp)',
    kind: 'npm-watch',
    note: 'Fijado a 6.7.23 a propósito. "latest" es un RC 7.x con breaking changes; ya rompió una vez la migración (whatsapp-web.js). NO actualizar a ciegas.',
  },
  {
    name: 'Medidor de uso de Codex (ChatGPT)',
    kind: 'endpoint',
    note: 'Endpoint interno no documentado de OpenAI (chatgpt.com/backend-api/wham/usage). Puede cambiar de forma sin aviso — best-effort: si falla, la sección de Codex simplemente no aparece.',
  },
  {
    name: 'Medidor de límites de Claude (OAuth usage)',
    kind: 'endpoint',
    note: 'Endpoint OAuth de uso de Anthropic. Mismo perfil best-effort: si falla, se sirve el último snapshot guardado.',
  },
];

// Censo completo — corre todo en paralelo (todo es lectura, sin colisión).
export async function buildUpdatesCensus() {
  const [npm, claudeCli, codexCli, models, mcps, apt, services] = await Promise.all([
    censusNpm(),
    censusClaudeCli(),
    censusCodexCli(),
    censusModels(),
    censusMcps(),
    censusApt(),
    censusServices(),
  ]);
  return {
    version: CENSUS_VERSION,
    npm,
    claudeCli,
    codexCli,
    models,
    mcps,
    apt,
    services,
    watched: WATCHED,
    generatedAt: Date.now(),
  };
}

// --- Verificación tras un update (reusable por el endpoint /verify) --------
// node --check sobre los entrypoints principales del repo. NO reinicia nada.
export async function syntaxCheck() {
  const targets = ['src/server.js'];
  // server.js importa el árbol de módulos. Los runners de bin/ quedan sueltos,
  // así que se enumeran explícitamente para no dejar entrypoints sin revisar.
  try {
    for (const file of fs.readdirSync(path.join(ROOT, 'bin'))) {
      if (file.endsWith('.js')) targets.push(path.join('bin', file));
    }
  } catch { /* best-effort */ }
  const results = [];
  for (const t of targets) {
    const r = await run('node', ['--check', t], { timeout: 20_000 });
    results.push({ file: t, ok: r.ok, error: r.ok ? null : (r.stderr || '').trim().slice(0, 400) });
  }
  return { ok: results.every((r) => r.ok), results };
}

export { run, readPackageJson, ROOT };
