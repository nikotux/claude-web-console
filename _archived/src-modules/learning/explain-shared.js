// modules/learning/explain-shared.js — "🎓 Explicame esto": persistencia del job
// + prompt + allowlist read-only del aprendizaje guiado por IA.
//
// REGLA DE ORO: consume tokens y puede tardar (NAVEGA el código real) ⇒ RUNNER
// DESACOPLADO (bin/cwc-learning-explain-runner.js, detached+unref). El endpoint
// POST solo escribe el job PENDIENTE acá y lo spawnea; el runner persiste el
// resultado en el MISMO archivo (por tema) y AUTO-GUARDA la explicación en el
// tema vía store.saveExplanation. El front encuesta el GET (0 tokens).
//
// REGLA 6 (blindaje read-only): a diferencia del análisis de tasks (0
// herramientas), acá la IA SÍ LEE el código para poder explicar cómo funciona
// algo de verdad — pero SOLO lectura: allowlist Read/Grep/Glob/TodoWrite en las
// DOS capas (hook PreToolUse que deniega ANTES de la evaluación de permisos +
// canUseTool). Bash/Edit/Write/git/MCP DENEGADO. settingSources: [] (cero MCP ni
// permisos pre-aprobados). NUNCA escribe código. Mismo blindaje que el auditor
// de Salud y el optimizador.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/atomic-write.js';
import { resolveDataDir } from '../../core/data-dir.js';
import {
  hostUser, readUserOauthToken, userDataDir, userRunnerEnv,
} from '../../core/user-space.js';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../../core/config.js';
import { normScope, contextoText } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..', '..'); // raíz del repo (la consola)

const RUNNER = path.join(ROOT, 'bin', 'cwc-learning-explain-runner.js');

export const EXPLAIN_MAX_TURNS = 24;
export const EXPLAIN_TIMEOUT_MS = 6 * 60 * 1000;
export const EXPLAIN_STALE_MS = EXPLAIN_TIMEOUT_MS + 30 * 1000;
export const EXPLAIN_MODEL = 'sonnet';

// cwd de la corrida según el alcance del tema: la consola o el repo de Tolkien.
export function cwdForScope(scope) {
  return normScope(scope) === 'tolkien' ? config.projectDir : ROOT;
}
export function scopeLabel(scope) {
  return normScope(scope) === 'tolkien' ? 'Tolkien (el producto de la empresa)' : 'Mi Consola (este proyecto)';
}

// Allowlist de herramientas: SOLO lecturas locales (dos capas — regla 6).
// TodoWrite es la lista interna del modelo (Agent SDK): no toca disco.
export function explainToolAllowed(name) {
  return ['Read', 'Grep', 'Glob', 'TodoWrite'].includes(name);
}

function dataDirFor(owner = null) {
  return owner ? userDataDir(owner) : resolveDataDir();
}
function ensureDir(owner = null) {
  fs.mkdirSync(dataDirFor(owner), { recursive: true, mode: 0o700 });
}
const ID_RE = /^TDA-\d+$/;
export function validId(id) {
  return ID_RE.test(String(id || ''));
}
function jobPath(id, owner = null) {
  return path.join(dataDirFor(owner), `learning-explain-${id}.json`);
}

export function readExplainJob(id, owner = null) {
  if (!validId(id)) return null;
  try { return JSON.parse(fs.readFileSync(jobPath(id, owner), 'utf8')); }
  catch { return null; }
}
export function writeExplainJob(id, data, owner = null) {
  ensureDir(owner);
  writeJsonAtomic(jobPath(id, owner), data); // tmp-por-PID (BUG-30)
}

export function isFreshRunning(job) {
  return !!job && job.status === 'running' && (Date.now() - job.startedAt) <= EXPLAIN_STALE_MS;
}
// Estado EFECTIVO: un 'running' pasado el corte se reporta error (runner muerto).
export function jobResult(job) {
  if (!job) return { status: 'idle', error: null };
  if (job.status === 'running' && !isFreshRunning(job)) {
    return { status: 'error', error: 'La explicación no respondió a tiempo (el runner se interrumpió). Reintentá.' };
  }
  return { status: job.status, error: job.error || null };
}

// ===== REGENERACIÓN INTELIGENTE =====
// Antes de gastar tokens, "Regenerar" evalúa si hace falta: huella de TEXTO
// (notes+question+contextoAdicional) + huella de CÓDIGO (mtime/size de los
// archivos que la última explicación citó, ver parseFiles). Sin cambios en
// ninguna de las dos ⇒ no-op (0 tokens); con cambios y ya había explicación ⇒
// modo 'adapt' (se le pasa la explicación anterior para actualizar, no
// arrancar de cero); sin explicación previa ⇒ modo 'full'. `force` en el POST
// ignora todo esto y fuerza 'full' (botón "Forzar regeneración completa").
export function textFingerprint(topic) {
  const t = topic || {};
  // El contexto puede venir ya concatenado (contextoText, en el snapshot del
  // job) o como lista (tema crudo). En AMBOS casos se serializa IGUAL que en el
  // guardado: contextoText() (con los prefijos [nota manual]/[charla…]). Antes
  // (fix B3 2026-07-11) la rama de lista NO ponía los prefijos → la huella nunca
  // coincidía con explainFingerprint (que se sella sobre contextoText) → el tema
  // salía SIEMPRE 'stale' y la regeneración inteligente (no-op 0 tokens) no
  // funcionaba para temas con contexto.
  const ctx = typeof t.contextoAdicional === 'string' ? t.contextoAdicional : contextoText(t);
  const s = `${t.notes || ''}\n${t.question || ''}\n${ctx}`;
  return crypto.createHash('sha1').update(s).digest('hex');
}

// Snapshot determinístico de un conjunto de rutas relativas al cwd del tema.
// Un archivo borrado/movido se representa igual (mtimeMs:0,size:-1) en ambas
// puntas, así que no dispara un falso "cambió" por sí solo.
export function fileSnapshot(paths, cwd) {
  return (paths || []).map((p) => {
    try {
      const st = fs.statSync(path.join(cwd, p));
      return { path: p, mtimeMs: Math.round(st.mtimeMs), size: st.size };
    } catch { return { path: p, mtimeMs: 0, size: -1 }; }
  });
}

export function codeFingerprint(snapshot) {
  return crypto.createHash('sha1').update(JSON.stringify(snapshot || [])).digest('hex');
}

// { stale, reason: 'none'|'context'|'code'|null }. 'none' = nunca se generó.
export function checkStaleness(topic) {
  const t = topic || {};
  if (!t.explanation) return { stale: true, reason: 'none' };
  if (textFingerprint(t) !== t.explainFingerprint) return { stale: true, reason: 'context' };
  if (Array.isArray(t.explainFiles) && t.explainFiles.length) {
    const cwd = cwdForScope(t.scope);
    const curSnap = fileSnapshot(t.explainFiles.map((f) => f.path), cwd);
    if (codeFingerprint(curSnap) !== codeFingerprint(t.explainFiles)) return { stale: true, reason: 'code' };
  }
  return { stale: false, reason: null };
}

export function spawnLearningExplainRunner(id, owner) {
  ensureDir(owner);
  const logFile = path.join(dataDirFor(owner), 'learning-explain.log');
  const oauthToken = owner && owner !== hostUser() ? readUserOauthToken(owner) : null;
  if (owner && owner !== hostUser() && !oauthToken) {
    const error = new Error('Necesitás conectar tu cuenta de Claude para generar una explicación.');
    error.conflict = true;
    throw error;
  }
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [RUNNER, id], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: owner && owner !== hostUser() ? userRunnerEnv(owner, { oauthToken }) : process.env,
  });
  child.unref();
  fs.closeSync(logFd);
}

// ===== Prompt del aprendizaje guiado =====
// El tema viaja como snapshot en el job (title/area/notes/question/scope/
// contextoAdicional/previousExplanation/reason/mode). La IA NAVEGA el código
// real (cwd = consola o Tolkien) y redacta una explicación didáctica en
// MARKDOWN, cerrada en un bloque ```markdown para poder aislarla, seguida de
// un bloque ```files``` con lo que realmente citó (sostiene la huella de
// código de checkStaleness). En modo 'adapt' se le pasa la explicación
// anterior para que la ACTUALICE en vez de arrancar de cero.
export function explainPrompt(topic, opts = {}) {
  const t = topic || {};
  const mode = opts.mode === 'adapt' ? 'adapt' : 'full';
  const focus = t.question
    ? `El usuario quiere entender puntualmente: "${t.question}".`
    : 'El usuario quiere entender este tema a fondo para poder aplicarlo.';
  const notes = t.notes ? `\nNOTAS/CONTEXTO que ya tiene el usuario (instrucciones de Chris, detalles previos):\n${t.notes}\n` : '';
  const ctxBlock = t.contextoAdicional ? `\nCONTEXTO ADICIONAL (transcripciones/charlas ya interpretadas):\n${t.contextoAdicional}\n` : '';
  const adaptBlock = mode === 'adapt' ? [
    '',
    'YA EXISTE una explicación anterior de este tema (más abajo). Se detectó que',
    opts.reason === 'code'
      ? 'el CÓDIGO relevante cambió desde la última vez.'
      : 'hay NOTAS/CONTEXTO nuevos desde la última vez.',
    'NO arranques de cero: releé la explicación anterior, verificá si sigue siendo',
    'correcta releyendo el código real, y ACTUALIZÁ/AMPLIÁ solo lo que haga falta —',
    'conservá lo que sigue siendo válido. En "Para reforzar" mencioná brevemente',
    'qué se actualizó respecto de la versión anterior.',
    '',
    '=== EXPLICACIÓN ANTERIOR ===',
    String(opts.previousExplanation || '').slice(0, 20000),
    '=== FIN EXPLICACIÓN ANTERIOR ===',
    '',
  ].join('\n') : '';
  return [
    'Sos un MENTOR TÉCNICO que le enseña a un desarrollador cómo funcionan las',
    'cosas, con un estilo de APRENDIZAJE GUIADO: claro, concreto y accionable.',
    `TEMA A EXPLICAR: "${t.title}".`,
    t.area ? `ÁREA: ${t.area}.` : '',
    `ALCANCE: estás parado en el repositorio de ${scopeLabel(t.scope)} (tu cwd).`,
    focus,
    notes,
    ctxBlock,
    adaptBlock,
    'INSTRUCCIONES:',
    '  1. NAVEGÁ el código REAL para basar la explicación en cómo funciona DE',
    '     VERDAD (herramientas de SOLO LECTURA: Read, Grep, Glob). No inventes:',
    '     citá archivos/funciones concretas que abriste.',
    '  2. Si el tema es un concepto/herramienta externa (ej. GetPad, GitHub, un',
    '     proceso de PR) más que un archivo, explicá el concepto Y conectalo con',
    '     dónde/cómo aparece en este código si aplica.',
    '  3. Enseñá para APLICAR: que después el usuario pueda resolver problemas,',
    '     exponer un PR o hacer una implementación mejor gracias a esto. Incluí',
    '     un PASO A PASO accionable, no solo teoría.',
    '  4. LLENÁ TODAS las secciones de una sola pasada — es material de estudio',
    '     completo, no un resumen corto. Ninguna queda vacía.',
    'FORMATO DE SALIDA: primero investigá con las herramientas; al final entregá',
    'la explicación COMPLETA en ESPAÑOL dentro de UN ÚNICO bloque ```markdown con',
    'esta estructura (usá encabezados ##, listas y `code` cuando ayude):',
    '```markdown',
    '## En una línea',
    '<qué es, en una frase>',
    '## Cómo funciona por dentro',
    '<el mecanismo real, paso a paso, citando archivos/funciones concretas>',
    '## Piezas clave',
    '<- archivo/función: qué hace>',
    '## Cómo se conecta',
    '<con qué otras partes se relaciona / de dónde viene y a dónde va>',
    '## Paso a paso',
    '<pasos numerados y accionables para aplicar/resolver algo con este tema>',
    '## Errores comunes',
    '<2-4 errores típicos o confusiones frecuentes, y cómo evitarlos>',
    '## Para tu caso',
    '<cómo aplicar esto a resolver problemas / exponer PRs / implementar>',
    '## Para reforzar',
    '<2-4 puntos para afianzar o próximos pasos de estudio>',
    '```',
    'Inmediatamente DESPUÉS de ese bloque, agregá OTRO bloque ```files``` con UNA',
    'ruta relativa por línea de cada archivo REAL que abriste/citaste (relativas',
    'a tu cwd, sin texto adicional ni viñetas):',
    '```files',
    'src/ejemplo/archivo.js',
    '```',
    'Sé riguroso y didáctico. Si algo no lo pudiste verificar en el código, decilo',
    'explícitamente en vez de inventar.',
  ].filter(Boolean).join('\n');
}

// La explicación es PROSA en markdown: aislamos el último bloque ```markdown; si
// no hay fence, tomamos el texto entero (defensivo). Devuelve string o ''.
export function parseExplanation(text) {
  const s = String(text || '');
  const fences = [...s.matchAll(/```markdown\s*([\s\S]*?)```/gi)];
  const raw = fences.length ? fences[fences.length - 1][1] : s;
  return raw.replace(/\r/g, '').trim().slice(0, 40000);
}

// Archivos que la IA reportó haber citado (bloque ```files```, ver prompt).
// Sostiene la huella de código de checkStaleness. Defensivo: sin bloque -> [].
export function parseFiles(text) {
  const s = String(text || '');
  const fences = [...s.matchAll(/```files\s*([\s\S]*?)```/gi)];
  if (!fences.length) return [];
  const raw = fences[fences.length - 1][1];
  return raw.split('\n')
    .map((l) => l.replace(/\0/g, '').trim())
    .filter(Boolean)
    // BUG-28: solo rutas RELATIVAS seguras (sin absolutas ni '..'). La huella solo
    // usa mtime/size, pero no seguimos rutas fuera del repo aunque el modelo las cite.
    .filter((l) => !path.isAbsolute(l) && !l.split(/[\\/]/).includes('..'))
    .slice(0, 40)
    .map((l) => l.slice(0, 300));
}
