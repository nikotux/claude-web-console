// modules/publish/shared.js — lógica COMPARTIDA del "Publicar a la consola"
// (PLAN-488): server (index.js) + runner desacoplado (bin/cwc-publish-runner.js).
//
// Publica el repo INTERNO al repo LIMPIO (la-consola) aplicando un TRANSFORM DE
// LIMPIEZA declarativo + GATES BLOQUEANTES (secretos + identidad). Dirección
// ÚNICA: interno → limpio, nunca al revés (el limpio es un mirror generado,
// read-only para consumidores). Ver la decisión de arquitectura en PLAN-488.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../../core/atomic-write.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = path.resolve(__dirname, '..', '..', '..'); // repo interno (raíz)
const DATA_DIR = path.join(os.homedir(), '.cwc-data');
export const MIRROR_DIR = path.join(DATA_DIR, 'la-consola-mirror');
export const STATE_FILE = path.join(DATA_DIR, 'publish.json');
export const LOG_FILE = path.join(DATA_DIR, 'publish.log');

// Destino de publicación (mirror generado). Read-only para consumidores.
export const CLEAN_REPO_URL = 'https://github.com/nmosqueramordor/la-consola.git';
export const CLEAN_BRANCH = 'main';

const STALE_MS = 120_000; // una corrida "viva" refresca updatedAt más seguido que esto

// Secretos/runtime que NUNCA viajan al mirror (excludes de rsync). Alineado con
// SECRET_PATHS/SECRET_DIRS del módulo backup. Además se excluye el TOOLING DE
// PUBLICACIÓN en sí (rutas ancladas con "/"): es interno de la instancia que
// publica — el compañero no debe tener un botón que apunte a este repo, y el
// propio shared.js contiene los strings de identidad que el gate busca (se
// auto-bloquearía). registry.js/system.js del mirror se parchean en el transform.
export const RSYNC_EXCLUDES = [
  '.git', 'node_modules',
  '.env', '*.bak',
  'users.json', 'sessions.json', 'recents.json', 'titles.json',
  'certs', '*.log',
  '/_archived',
  '/src/modules/publish',
  '/bin/cwc-publish-runner.js',
  '/public/js/modules/system/publish-panel.js',
  '/CLAUDE.generic.md',
];

// docs/ que SÍ se publican; el resto (análisis/planes internos) se podan.
export const DOCS_WHITELIST = ['INSTALL.md', 'frontend-modules.md'];

// Paths que SIEMPRE deben estar AUSENTES del mirror. Se excluyen del rsync (no
// se copian del interno) Y se purgan explícitamente acá: un `rsync --exclude`
// protege el path de ser BORRADO, así que una versión vieja que ya estaba en el
// mirror (de un push anterior) persistiría — por eso el rm explícito.
export const MIRROR_PURGE = [
  '_archived',                                          // código archivado interno
  'src/modules/publish',                               // tooling de publicación (interno)
  'bin/cwc-publish-runner.js',
  'public/js/modules/system/publish-panel.js',
  'CLAUDE.generic.md',                                 // fuente del CLAUDE genérico
];

// GATE de identidad: PII que NUNCA debe aparecer en el mirror. Preciso a
// propósito — el email y la firma solo aparecen si se hardcodeó identidad de
// runtime (el nombre "Nico" está en cientos de comentarios y NO es PII
// sensible; el handle de GitHub aparece en la URL del propio repo). Bloqueante.
export const IDENTITY_FORBIDDEN = [
  'nmosquera@mordorstaffing.com',
  '— Nicolás (dev team)',
];

// ===== Estado (publish.json) =====
export function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return null; }
}
export function writeState(patch) {
  const prev = readState() || {};
  const next = { ...prev, ...patch, updatedAt: Date.now() };
  writeJsonAtomic(STATE_FILE, next, { space: 2 });
  return next;
}
export function isRunning(state = readState()) {
  return !!state && state.status === 'running' && (Date.now() - (state.updatedAt || 0)) < STALE_MS;
}

// ===== Transform de limpieza (opera sobre el árbol del mirror) =====
// Devuelve la lista de acciones aplicadas (para el reporte). NO toca git.
export function applyTransforms(mirrorDir, repoDir) {
  const done = [];
  // 0) Purgar del mirror lo interno que nunca debe existir ahí (ver MIRROR_PURGE).
  for (const rel of MIRROR_PURGE) {
    const p = path.join(mirrorDir, rel);
    if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); done.push(`purgado: ${rel}`); }
  }
  // 1) CLAUDE.md ← contenido de CLAUDE.generic.md (la fuente versionada);
  //    y se borra CLAUDE.generic.md del mirror (no se publica la fuente en sí).
  const genericSrc = path.join(repoDir, 'CLAUDE.generic.md');
  if (fs.existsSync(genericSrc)) {
    fs.writeFileSync(path.join(mirrorDir, 'CLAUDE.md'), fs.readFileSync(genericSrc, 'utf8'));
    done.push('CLAUDE.md ← CLAUDE.generic.md');
  }
  fs.rmSync(path.join(mirrorDir, 'CLAUDE.generic.md'), { force: true });

  // 2) README: quitar la sección interna "## Changelog" (hasta el próximo "## ").
  const readme = path.join(mirrorDir, 'README.md');
  if (fs.existsSync(readme)) {
    const lines = fs.readFileSync(readme, 'utf8').split('\n');
    const start = lines.findIndex((l) => l.trim() === '## Changelog');
    if (start >= 0) {
      let end = -1;
      for (let i = start + 1; i < lines.length; i += 1) {
        if (/^## (?!Changelog)/.test(lines[i])) { end = i; break; }
      }
      if (end > start) { lines.splice(start, end - start); fs.writeFileSync(readme, lines.join('\n')); done.push(`README: changelog interno removido (${end - start} líneas)`); }
    }
  }

  // 3) docs/: conservar solo la whitelist, podar el resto.
  const docsDir = path.join(mirrorDir, 'docs');
  if (fs.existsSync(docsDir)) {
    for (const entry of fs.readdirSync(docsDir)) {
      if (!DOCS_WHITELIST.includes(entry)) {
        fs.rmSync(path.join(docsDir, entry), { recursive: true, force: true });
        done.push(`docs/: podado ${entry}`);
      }
    }
  }

  // 4) Quitar del mirror las referencias al módulo `publish` (excluido del
  //    rsync): registry.js (import + array) y system.js (import + pestaña). Fail-
  //    soft: si el string no está, no rompe (el mirror pudo no tenerlo nunca).
  const strip = (file, replacements) => {
    const p = path.join(mirrorDir, file);
    if (!fs.existsSync(p)) return;
    let s = fs.readFileSync(p, 'utf8');
    let changed = false;
    for (const [from, to] of replacements) { if (s.includes(from)) { s = s.replace(from, to); changed = true; } }
    if (changed) { fs.writeFileSync(p, s); done.push(`${file}: referencias a publish removidas`); }
  };
  strip('src/core/registry.js', [
    ["import publish from '../modules/publish/index.js';\n", ''],
    [', envVars, publish]', ', envVars]'],
  ]);
  strip('public/js/modules/system/system.js', [
    ["import { mountPublishPanel } from './publish-panel.js';\n", ''],
    ["      { label: 'Publicar a la consola', mount: (c) => mountPublishPanel(c, { ...ctx, isAdmin }) },\n", ''],
  ]);
  return done;
}

// ===== Gates bloqueantes (secretos + identidad) sobre el árbol del mirror =====
// Devuelve [] si está limpio, o una lista de problemas (cada uno ABORTA el push).
function grepPresent(dir, fixedStr) {
  try {
    // -rlF: fixed-string, lista archivos; excluye .git. Exit 1 (sin match) => throw.
    execFileSync('grep', ['-rlF', '--exclude-dir=.git', '--', fixedStr, dir], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch { return false; }
}
function grepPresentRe(dir, regex) {
  try {
    execFileSync('grep', ['-rlE', '--exclude-dir=.git', '--', regex, dir], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch { return false; }
}

export function runGates(mirrorDir, { masterToken } = {}) {
  const problems = [];
  // Secret gate: archivos de secreto presentes (no deberían por los excludes).
  for (const p of ['.env', 'users.json', 'sessions.json', 'recents.json', 'titles.json', 'certs']) {
    if (fs.existsSync(path.join(mirrorDir, p))) problems.push(`archivo de secreto presente: ${p}`);
  }
  // Token maestro en cualquier archivo.
  if (masterToken && masterToken.length >= 16 && grepPresent(mirrorDir, masterToken)) {
    problems.push('el token maestro aparece en el árbol');
  }
  // Material de clave privada.
  if (grepPresentRe(mirrorDir, 'BEGIN (RSA|EC|OPENSSH|PRIVATE) ')) {
    problems.push('material de clave privada en el árbol');
  }
  // Identity gate: PII que no debe filtrarse.
  for (const s of IDENTITY_FORBIDDEN) {
    if (grepPresent(mirrorDir, s)) problems.push(`identidad hardcodeada: "${s}"`);
  }
  return problems;
}

// Token maestro del .env interno (para el gate de secretos). Lectura directa,
// sin importar config.js (el runner no debe depender de esa validación).
export function readMasterToken() {
  try {
    const env = fs.readFileSync(path.join(REPO_DIR, '.env'), 'utf8');
    const m = env.match(/^CWC_TOKEN=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}
