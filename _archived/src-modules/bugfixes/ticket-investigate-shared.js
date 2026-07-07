// modules/bugfixes/ticket-investigate-shared.js — lógica COMPARTIDA entre el
// módulo server y el runner desacoplado de la "investigación de contexto" de un
// ticket SIN PR (bin/cwc-ticket-investigate-runner.js).
//
// QUÉ hace: un ticket sin PR no tiene diff que leer. Para responder "¿por qué NO
// se resolvió todavía?" hay que ENTRAR a leer el código de Tolkien. El runner
// hace una lectura read-only del repo (Read/Grep/Glob), formula una hipótesis de
// causa raíz y explica qué falta → veredicto {porQueNoResuelto, causaRaiz,
// archivos[], complejidad, pasos[], riesgo, confianza, titular}.
//
// RESILIENCIA (regla 2): corre en un RUNNER DETACHED cuyo resultado se PERSISTE
// en ~/.cwc-data/ticket-investigations/<ticket>.json → sobrevive al cambio de
// pestaña y al reinicio del server. El front dispara (POST) y encuesta (GET).
//
// SEGURIDAD (regla 6): read-only blindada por las DOS capas (hook PreToolUse +
// canUseTool). A DIFERENCIA de la investigación de PR (que NO usa herramientas),
// esta SÍ usa lecturas locales — EXACTAMENTE la misma allowlist que el auditor de
// Salud: Read/Grep/Glob/TodoWrite y NADA más (Bash, Edit/Write, git, MCP →
// denegado en las dos capas). Nunca escribe. cwd = Tolkien (config.projectDir).
import { execFile } from 'node:child_process';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = path.join(os.homedir(), '.cwc-data');
export const TKTINV_DIR = path.join(DATA_DIR, 'ticket-investigations'); // resultado + request por ticket
export const TKTINV_LOCK = path.join(DATA_DIR, 'ticket-investigate.lock'); // heartbeat
export const TKTINV_LOG = path.join(DATA_DIR, 'ticket-investigate.log');

export const TKTINV_TIMEOUT_MS = 5 * 60000;
export const TKTINV_TTL_MS = 60000;            // "fresco": no re-investigar si es más nuevo
export const TKTINV_HEARTBEAT_MS = 3000;
export const TKTINV_LOCK_FRESH_MS = 20000;     // lock más viejo = runner muerto
export const TKTINV_MAX_TURNS = 16;            // con candidatos precargados alcanza (lee pocos y responde)

// Allowlist read-only (idéntica al auditor de Salud): SOLO lecturas locales.
// TodoWrite es la lista de tareas INTERNA del modelo (no toca disco).
export function ticketInvToolAllowed(name) {
  return ['Read', 'Grep', 'Glob', 'TodoWrite'].includes(name);
}

// ===== Prompt de la investigación de contexto =====
// `candidates` (paths relativos) y `snippets` ([{file, head}]) los junta el
// runner EN NODE (grep determinístico) para acotar la exploración — así el modelo
// no se queda sin turnos buscando a ciegas por todo el repo.
export function ticketInvestigatePrompt(p, { candidates = [], snippets = [] } = {}) {
  const cap = (s, n) => String(s || '').slice(0, n);
  const candBlock = candidates.length
    ? `Archivos CANDIDATOS que ya localicé por vos (relativos a la raíz de Tolkien):\n${candidates.map((f) => `- ${f}`).join('\n')}`
    : '(no encontré candidatos automáticos; buscá vos con Grep/Glob)';
  const snipBlock = snippets.length
    ? ['', 'Fragmentos iniciales de los candidatos más probables (para arrancar sin leer todo):',
      ...snippets.map((s) => `\n=== ${s.file} ===\n${s.head}`)].join('\n')
    : '';
  return [
    'Sos un desarrollador senior del proyecto Tolkien. Estás parado en su código (cwd).',
    'Te doy un ticket/bug reportado que TODAVÍA NO está resuelto. Tu tarea: entender el',
    'problema y explicar, en español rioplatense claro y directo, POR QUÉ sigue sin',
    'resolverse y cuál es la causa raíz.',
    '',
    'CÓMO TRABAJAR (importante para no quedarte sin turnos):',
    '- NO tenés Bash ni terminal (deshabilitados; si los intentás perdés el turno). Solo Grep/Glob/Read.',
    '- YA te dejé abajo los archivos candidatos y algunos fragmentos. Empezá por ahí.',
    '- Leé como MUCHO 3 o 4 archivos con Read. NO hagas más de ~6 acciones en total.',
    '- Podés responder incluso sin leer nada más si los fragmentos ya te alcanzan.',
    '- SIEMPRE terminá con el bloque JSON. Si te faltó cerrar, respondé igual con confianza=baja y necesitaMasInfo=true.',
    '',
    `Ticket #${cap(p.ticket, 20)}: ${cap(p.title, 300) || '(sin título)'}`,
    p.whatBroke ? `Qué se rompió: ${cap(p.whatBroke, 800)}` : '',
    p.route ? `Ruta/pantalla afectada: ${cap(p.route, 200)}` : '',
    p.reporter ? `Reportó: ${cap(p.reporter, 120)}` : '',
    p.severity ? `Severidad reportada: ${cap(p.severity, 40)}` : '',
    p.context ? `Contexto del triage: ${cap(p.context, 1200)}` : '',
    p.summary ? `Resumen del trabajo previo (si hubo): ${cap(p.summary, 1200)}` : '',
    Array.isArray(p.files) && p.files.length ? `Archivos que ya se tocaron antes: ${p.files.slice(0, 20).join(', ')}` : '',
    '',
    candBlock,
    snipBlock,
    '',
    'Analizá el flujo, formulá una hipótesis de causa raíz FUNDADA en el código, y explicá',
    'por qué el ticket sigue abierto (qué falta, qué lo bloquea, si es complejo o si falta info).',
    '',
    'Respondé ÚNICAMENTE con un bloque JSON (nada de texto fuera de él):',
    '```json',
    '{"porQueNoResuelto":"1-3 frases claras","causaRaiz":"hipótesis fundada en el código","archivos":["ruta/relativa.js"],"complejidad":"baja|media|alta","pasos":["acción concreta en imperativo citando el archivo"],"riesgo":"qué podría romperse al tocarlo","confianza":"alta|media|baja","titular":"<=60 chars para un badge","necesitaMasInfo":true|false}',
    '```',
    'Reglas:',
    '- Basá TODO en el código que realmente leíste. NO inventes archivos: listá solo los que abriste.',
    '- Si no encontrás el área afectada, decilo con honestidad: confianza=baja y necesitaMasInfo=true.',
    '- pasos: en imperativo, citando el archivo cuando puedas. Vacío si todavía no hay una acción clara.',
    '- titular: corto, para el tablero. Ej: "Falta validar la ruta en fm.js", "No reproduce · falta info del cliente".',
  ].filter((l) => l !== '').join('\n');
}

// ===== Recolección de candidatos EN NODE (determinístico, como gh en el runner
// de PR) — acota la exploración del modelo para que no gaste turnos buscando =====
function sh(cmd, args, cwd) {
  return new Promise((res) => {
    execFile(cmd, args, { cwd, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (e, out) => res(e ? '' : String(out || '')));
  });
}
// Keywords "buenas": ≥5 chars, no puro número; prioriza las que parecen
// nombre de archivo/símbolo (con . o _) y las más largas.
function keywordsFrom(problem) {
  const words = new Set();
  const add = (s) => String(s || '').split(/[^A-Za-z0-9_.-]+/).forEach((w) => {
    const t = w.trim();
    if (t.length >= 5 && !/^\d+$/.test(t)) words.add(t);
  });
  add(problem.title); add(problem.whatBroke); add(problem.route);
  return [...words]
    .sort((a, b) => (/[._]/.test(b) ? 1 : 0) - (/[._]/.test(a) ? 1 : 0) || b.length - a.length)
    .slice(0, 6);
}
// Solo archivos de CÓDIGO (nada de docs/data/snapshots/lock/pdf que ensucian).
const CODE_EXT = 'ts,tsx,js,jsx,mjs,cjs,vue,svelte,py,rb,go,php,java,cs,html,css,scss,sql,prisma,json';
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|rb|go|php|java|cs|html|css|scss|sql|prisma)$/i;
// Ranking (menor = mejor): premia código de apps/packages/src, castiga docs/data/config.
function rankCandidate(f) {
  let s = f.split('/').length; // más profundo, un poco peor
  if (/^(apps|packages)\//.test(f)) s -= 4;
  if (/(^|\/)(src|components|routes|pages|controllers|services|handlers)\//.test(f)) s -= 3;
  if (/(^|\/)(docs|data|dist|build|coverage|fixtures|__snapshots__|snapshots|test|tests|__tests__)\//.test(f)) s += 8;
  if (/\.(json|md|lock|pdf|snap|yaml|yml)$/i.test(f)) s += 5;
  if (CODE_RE.test(f)) s -= 2;
  return s;
}
export async function gatherCandidates(projectDir, problem, { maxFiles = 12, maxSnippets = 3, snippetLines = 60 } = {}) {
  const rels = new Set();
  // 1) rutas del ticket que son archivos reales (señal fuerte).
  for (const r of String(problem.route || '').split(/[\s,]+/).filter(Boolean)) {
    try { if (fss.statSync(path.join(projectDir, r)).isFile()) rels.add(r); } catch { /* no existe */ }
  }
  // 2) grep por keywords SOLO en archivos de código. Usamos `grep` (siempre en el
  // PATH, incluso bajo systemd; `rg` vive en ~/.cargo/bin y da ENOENT en el runner)
  // con --include REPETIDOS (grep NO expande `{a,b}` como rg). Node shell-out =
  // igual que gh en el runner de PR: recolección determinística, no es el modelo.
  const includes = CODE_EXT.split(',').map((e) => `--include=*.${e}`);
  const excludes = ['node_modules', '.git', 'docs', 'data', 'dist', 'build', 'coverage', '.next', '.turbo'].map((d) => `--exclude-dir=${d}`);
  for (const kw of keywordsFrom(problem)) {
    if (rels.size >= maxFiles * 2) break;
    const out = await sh('grep', ['-rIl', '-i', ...excludes, ...includes, '--', kw, '.'], projectDir);
    out.split('\n').map((s) => s.replace(/^\.\//, '').trim()).filter(Boolean).slice(0, 6).forEach((f) => rels.add(f));
  }
  // 3) ordenar por relevancia y quedarse con los mejores.
  const candidates = [...rels].sort((a, b) => rankCandidate(a) - rankCandidate(b)).slice(0, maxFiles);
  // 4) snippets (head) de los mejores candidatos que sean código, para arrancar sin leer todo.
  const snippets = [];
  for (const f of candidates.filter((x) => CODE_RE.test(x)).slice(0, maxSnippets)) {
    try {
      const txt = fss.readFileSync(path.join(projectDir, f), 'utf8');
      snippets.push({ file: f, head: txt.split('\n').slice(0, snippetLines).join('\n').slice(0, 4000) });
    } catch { /* ilegible */ }
  }
  return { candidates, snippets };
}

// Parseo defensivo: último bloque JSON válido de la respuesta del modelo.
export function parseTicketVerdict(out) {
  const candidates = [];
  const fences = out.match(/```(?:json)?\s*([\s\S]*?)```/gi);
  if (fences) for (const f of fences) candidates.push(f.replace(/```(?:json)?/gi, '').trim());
  const brace = out.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  let p = null;
  for (const c of candidates.reverse()) { try { p = JSON.parse(c); break; } catch { /* siguiente */ } }
  if (!p || typeof p !== 'object') return { ok: false, error: 'No se pudo interpretar el veredicto.' };
  const comp = ['baja', 'media', 'alta'].includes(p.complejidad) ? p.complejidad : 'media';
  return {
    ok: true,
    porQueNoResuelto: String(p.porQueNoResuelto || '').slice(0, 700),
    causaRaiz: String(p.causaRaiz || '').slice(0, 700),
    archivos: Array.isArray(p.archivos) ? p.archivos.slice(0, 12).map((s) => String(s).slice(0, 200)) : [],
    complejidad: comp,
    pasos: Array.isArray(p.pasos) ? p.pasos.slice(0, 8).map((s) => String(s).slice(0, 300)) : [],
    riesgo: String(p.riesgo || '').slice(0, 400),
    confianza: ['alta', 'media', 'baja'].includes(p.confianza) ? p.confianza : 'media',
    titular: String(p.titular || '').slice(0, 60),
    necesitaMasInfo: p.necesitaMasInfo === true,
  };
}

// ===== Persistencia por ticket (resultado + request de entrada) =====
const safeKey = (n) => String(n).replace(/[^\w.-]/g, '').slice(0, 20);
export function tktInvResultPath(n) { return path.join(TKTINV_DIR, `${safeKey(n)}.json`); }
export function tktInvRequestPath(n) { return path.join(TKTINV_DIR, `${safeKey(n)}.req.json`); }

export function readTicketInvestigation(n) {
  try { return JSON.parse(fss.readFileSync(tktInvResultPath(n), 'utf8')); } catch { return null; }
}
export function writeTicketInvestigation(n, data) {
  try {
    fss.mkdirSync(TKTINV_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(tktInvResultPath(n), JSON.stringify(data), { mode: 0o600 });
  } catch (err) { console.error('[ticket-investigate] no pude persistir:', err?.message); }
}
// El server escribe el "problema" a un archivo antes de spawnear; el runner lo lee
// (así el texto del ticket sobrevive al reinicio del server sin viajar por argv).
export function writeTicketInvRequest(n, problem) {
  try {
    fss.mkdirSync(TKTINV_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(tktInvRequestPath(n), JSON.stringify({ ...problem, ticket: safeKey(n), ts: Date.now() }), { mode: 0o600 });
  } catch (err) { console.error('[ticket-investigate] no pude escribir request:', err?.message); }
}
export function readTicketInvRequest(n) {
  try { return JSON.parse(fss.readFileSync(tktInvRequestPath(n), 'utf8')); } catch { return null; }
}

// ===== Lock de "investigación de contexto corriendo" (heartbeat del runner) =====
export function writeTktInvLock(state) {
  try {
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fss.writeFileSync(TKTINV_LOCK, JSON.stringify({ ...state, ts: Date.now() }), { mode: 0o600 });
  } catch { /* noop */ }
}
export function clearTktInvLock() { try { fss.unlinkSync(TKTINV_LOCK); } catch { /* noop */ } }
export function readTktInvLock() {
  try {
    const l = JSON.parse(fss.readFileSync(TKTINV_LOCK, 'utf8'));
    if (Date.now() - l.ts >= TKTINV_LOCK_FRESH_MS) return null;
    return l;
  } catch { return null; }
}
export function isTicketInvestigating() { return !!readTktInvLock(); }
