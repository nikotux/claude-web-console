// modules/chat/codex-shared.js — lógica PURA compartida de las delegaciones
// Tándem a Codex. La usan tanto la tool in-process como el runner desacoplado;
// por eso no arrastra dependencias del servidor y puede arrancar sin
// core/config.js.
//
// Cada delegación persistida usa un job con esta forma:
// { id, chatId, cwd, task, model, effort, fullAccess, writableRoots, pid,
//   status: 'pending'|'running'|'done'|'error'|'killed'|'orphaned', label,
//   startedAt, heartbeatAt, finishedAt, report, isError, error, threadId }
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveDataDir } from '../../core/data-dir.js';
import { TANDEM_CODEX_MODEL, TANDEM_CODEX_EFFORT } from './codex-models.js';
import { MAX_PR_LINKS, prLinkFromCodexEvent } from './pr-milestones.js';

// Defaults del ejecutor Codex (gama alta: gpt-5.6-sol/high). PLAN-519 F2: el
// usuario puede CONFIGURAR modelo+esfuerzo del Codex desde el selector; estos
// defaults viven en codex-models.js (módulo puro). El valor
// `model_reasoning_effort` sin comillas cae a string crudo (TOML inválido →
// raw), verificado con --strict-config.
export const TANDEM_CODEX_PREAMBLE = [
  'Reglas fijas del protocolo Tándem (aplican SIEMPRE, no hace falta que te las repitan):',
  '- Tocá ÚNICAMENTE los archivos que el plan menciona. Si creés que hace falta tocar otro, decilo en tu mensaje final en vez de hacerlo.',
  '- Al terminar, verificá la sintaxis de cada archivo .js que hayas modificado con `node --check <archivo>`.',
  '- No corras git commit, git push, systemctl ni npm install salvo pedido explícito.',
  '- Usá `python3`, nunca `python` (en esta máquina `python` no existe).',
  '- Evitá heredocs frágiles y comillas/backticks anidados sin cerrar; preferí comandos de una línea simples.',
  '- Si la tarea necesita escribir en `.git` (git add/commit/rebase/etc.), avisá que hace falta `full_access: true`; sin eso `.git` es read-only.',
  '- La generación PURA de documentos (redactar/traducir texto que no es código) es razonamiento y conviene que la resuelva Claude directo, no esta delegación.',
  '- En tu mensaje final resumí en pocas líneas QUÉ cambiaste y en qué archivo.',
  '- Si la delegación declaró archivos, limitate a ellos: solo esos cambios se aplican de vuelta al proyecto real.',
  '',
  'PLAN CONCRETO:',
  '',
].join('\n');

// Advertencia que se antepone al preámbulo cuando la delegación corre SIN
// sandbox (`danger-full-access`, opt-in por tarea vía `full_access`). Solo se
// usa para tareas que necesitan escribir en `.git` (rebase, cherry-pick,
// reset): en `workspace-write` Codex monta `.git` como solo-lectura por diseño
// y no hay permiso fino para excluirlo (verificado con `codex sandbox`:
// `writable_roots` NO alcanza para `.git`).
export const TANDEM_FULL_ACCESS_WARNING = [
  '⚠️ ATENCIÓN: esta delegación corre SIN SANDBOX (acceso total al filesystem).',
  'Limitate ESTRICTAMENTE a las rutas que el plan menciona. Cualquier escritura fuera de ellas es un error grave.',
  '',
].join('\n');

// Tope de SEGURIDAD, no operativo: desde que el ejecutor pasó a gpt-5.6-sol,
// hoy el 20% de las delegaciones supera los 8 minutos. Matarlas perdía el
// resumen de un trabajo que YA estaba aplicado en el repo.
export const CODEX_MAX_MS = 60 * 60 * 1000;
export const MAX_DIFF = 16000;                    // recorte del diff del árbol completo; solo aplica en la rama de fallback
export const MAX_SCOPED_DIFF = 8000;              // recorte chico: solo trae lo que tocó esta delegación
export const MAX_NEW = 8000;                      // recorte del contenido de archivos NUEVOS
export const MAX_NEW_FILE = 4000;                 // recorte por archivo nuevo
export const MAX_SNAPSHOT_FILE = 1024 * 1024;     // 1 MB: no snapshoteamos archivos enormes
export const MAX_SNAPSHOT_TOTAL = 8 * 1024 * 1024; // 8 MB: tope global del snapshot en memoria

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FINISHED_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CODEX_HEARTBEAT_MS = 15 * 1000;
export const CODEX_HEARTBEAT_STALE_MS = 3 * CODEX_HEARTBEAT_MS;
export const CODEX_JOB_TERMINAL_STATUSES = Object.freeze([
  'done',
  'error',
  'killed',
  'orphaned',
]);

// Etiqueta corta y estable para mostrar una delegación en el radar del chat.
export function codexJobLabel(task) {
  const firstLine = typeof task === 'string'
    ? task.split(/\r?\n/).find((line) => line.trim())
    : '';
  return firstLine ? firstLine.trim().slice(0, 120) : 'delegación a Codex';
}

// Muestra el contenido de los archivos NUEVOS (untracked): `git diff` NO los
// incluye (solo cambios de archivos ya trackeados) y tocar el índice con
// `git add -N` interferiría con lo que el usuario tenga stageado. Los leemos con
// fs (no muta el repo) y los formateamos como "+" para que Claude los verifique.
export function readUntracked(cwd, list) {
  const files = list.split('\n').map((s) => s.trim()).filter(Boolean);
  const out = [];
  let total = 0;
  for (const rel of files) {
    if (total >= MAX_NEW) { out.push(`… (${files.length - out.length} archivo(s) nuevo(s) más — leelos con Read)`); break; }
    let content = '';
    try { content = fs.readFileSync(path.join(cwd, rel), 'utf8'); }
    catch { out.push(`+++ ${rel}\n(no se pudo leer — ¿binario?)`); continue; }
    if (content.length > MAX_NEW_FILE) content = `${content.slice(0, MAX_NEW_FILE)}\n… (truncado — leé el resto con Read)`;
    const block = `+++ ${rel}\n${content}`;
    total += block.length;
    out.push(block);
  }
  return out.join('\n\n');
}

// Corre `git` en cwd. El contrato histórico devuelve stdout (o '' si falla);
// el modo `result` agrega estado/stderr y `input` permite enviar un parche por
// stdin. Nunca lanza — best-effort.
export function runGit(cwd, gitArgs, { input = null, result = false } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let settled = false;
    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      if (result) {
        resolve({ ok: !error && code === 0, code, stdout: out, stderr: err, error });
      } else {
        resolve(error ? '' : out);
      }
    };
    try {
      const p = spawn('git', ['-C', cwd, ...gitArgs], {
        stdio: [input === null ? 'ignore' : 'pipe', 'pipe', result ? 'pipe' : 'ignore'],
      });
      p.stdout.on('data', (d) => { out += d.toString(); });
      if (result) p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('close', (code) => finish(code));
      p.on('error', (error) => finish(null, error));
      if (input !== null) {
        p.stdin.on('error', () => {});
        p.stdin.end(input);
      }
    } catch (error) { finish(null, error); }
  });
}

function gitFailure(action, gitResult) {
  const detail = gitResult?.stderr?.trim() || gitResult?.error?.message || `código ${gitResult?.code ?? 'desconocido'}`;
  return `${action}: ${detail}`;
}

export async function createDelegationWorktree(cwd, jobId) {
  const root = path.join(path.dirname(codexJobsDir()), 'codex-worktrees', String(jobId));
  fs.mkdirSync(root, { recursive: true });
  const added = await runGit(cwd, ['worktree', 'add', '--detach', root, 'HEAD'], { result: true });
  if (!added.ok) {
    await removeDelegationWorktree(cwd, root);
    throw new Error(gitFailure(`No se pudo crear el worktree aislado en ${root}`, added));
  }
  return { path: root };
}

export async function seedWorktree(worktreePath, cwd) {
  const failure = (error) => ({
    ok: false,
    error: `${error}\nEl sembrado suele fallar cuando otro proceso está escribiendo el árbol en ese momento.`,
  });
  try {
    const dirty = await runGit(cwd, ['diff', 'HEAD'], { result: true });
    if (!dirty.ok) return failure(gitFailure('No se pudo leer el estado sucio del repositorio', dirty));
    if (dirty.stdout) {
      const applied = await runGit(worktreePath, ['apply', '--whitespace=nowarn'], {
        input: dirty.stdout,
        result: true,
      });
      if (!applied.ok) {
        const threeWayCheck = await runGit(worktreePath, ['apply', '-3', '--check', '--whitespace=nowarn'], {
          input: dirty.stdout,
          result: true,
        });
        let threeWay = threeWayCheck;
        if (threeWayCheck.ok) {
          threeWay = await runGit(worktreePath, ['apply', '-3', '--whitespace=nowarn'], {
            input: dirty.stdout,
            result: true,
          });
        }
        if (!threeWay.ok) {
          return failure([
            gitFailure('No se pudo sembrar el parche de archivos trackeados', applied),
            gitFailure('El reintento con merge de tres vías también falló', threeWay),
          ].join('\n'));
        }
      }
    }

    const untracked = await runGit(cwd, ['ls-files', '--others', '--exclude-standard'], { result: true });
    if (!untracked.ok) return failure(gitFailure('No se pudieron listar los archivos untracked', untracked));
    for (const rel of untracked.stdout.split('\n').map((item) => item.trim()).filter(Boolean)) {
      const destination = path.join(worktreePath, rel);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(cwd, rel), destination);
    }

    const added = await runGit(worktreePath, ['add', '-A'], { result: true });
    if (!added.ok) return failure(gitFailure('No se pudo preparar el estado sembrado', added));
    const committed = await runGit(worktreePath, [
      '-c', 'user.email=cwc@local',
      '-c', 'user.name=cwc',
      'commit', '-m', 'cwc: estado sembrado', '--no-verify', '--allow-empty',
    ], { result: true });
    if (!committed.ok) return failure(gitFailure('No se pudo fijar la base sembrada', committed));
    return { ok: true };
  } catch (error) {
    return failure(String(error?.message || error));
  }
}

export async function applyDeclaredBack(worktreePath, cwd, files) {
  const added = await runGit(worktreePath, ['add', '-A'], { result: true });
  if (!added.ok) {
    return { ok: false, conflict: true, error: gitFailure('No se pudo preparar el diff aislado', added), patch: '' };
  }
  const diff = await runGit(worktreePath, ['diff', 'HEAD', '--binary', '--', ...files], { result: true });
  if (!diff.ok) {
    return { ok: false, conflict: true, error: gitFailure('No se pudo generar el parche declarado', diff), patch: diff.stdout };
  }
  const patch = diff.stdout;
  if (!patch.trim()) return { applied: [], skipped: files, empty: true };

  const applied = await runGit(cwd, ['apply', '--whitespace=nowarn'], { input: patch, result: true });
  if (applied.ok) return { ok: true, applied: files };

  // `--check` evita que un merge de tres vías con conflictos deje marcadores o
  // entradas sin resolver en el árbol real. Si pasa, la aplicación inmediata
  // usa exactamente el mismo parche y la misma base.
  const threeWayCheck = await runGit(cwd, ['apply', '-3', '--check', '--whitespace=nowarn'], {
    input: patch,
    result: true,
  });
  if (!threeWayCheck.ok) {
    return {
      ok: false,
      conflict: true,
      error: threeWayCheck.stderr.trim() || applied.stderr.trim() || gitFailure('El parche declarado entró en conflicto', threeWayCheck),
      patch,
    };
  }
  const threeWay = await runGit(cwd, ['apply', '-3', '--whitespace=nowarn'], { input: patch, result: true });
  if (!threeWay.ok) {
    return {
      ok: false,
      conflict: true,
      error: threeWay.stderr.trim() || applied.stderr.trim() || gitFailure('El parche declarado entró en conflicto', threeWay),
      patch,
    };
  }
  return { ok: true, applied: files };
}

export async function removeDelegationWorktree(cwd, worktreePath) {
  try {
    const removed = await runGit(cwd, ['worktree', 'remove', '--force', worktreePath], { result: true });
    if (removed.ok) return;
  } catch { /* continúa con la limpieza de fallback */ }
  try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { await runGit(cwd, ['worktree', 'prune'], { result: true }); } catch { /* best-effort */ }
}

export async function snapshotTree(cwd, { withContents = false } = {}) {
  const [numstat, untracked] = await Promise.all([
    runGit(cwd, ['diff', '--numstat']),
    runGit(cwd, ['ls-files', '--others', '--exclude-standard']),
  ]);
  const tracked = new Map();
  for (const line of numstat.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    tracked.set(parts.slice(2).join('\t'), `${parts[0]}:${parts[1]}`);
  }
  const others = new Set(untracked.split('\n').map((s) => s.trim()).filter(Boolean));
  let contents = null;
  // Solo hace falta el contenido previo de lo que YA venía sucio, para diffear
  // pre/post; lo limpio se resuelve con git diff vs HEAD.
  if (withContents) {
    contents = new Map();
    let total = 0;
    const rels = new Set([...tracked.keys(), ...others]);
    for (const rel of rels) {
      if (total >= MAX_SNAPSHOT_TOTAL) break;
      const abs = path.join(cwd, rel);
      try {
        const stat = fs.statSync(abs);
        if (!stat.isFile() || stat.size > MAX_SNAPSHOT_FILE || total + stat.size > MAX_SNAPSHOT_TOTAL) continue;
        const content = fs.readFileSync(abs, 'utf8');
        total += stat.size;
        contents.set(rel, content);
      } catch { /* si no se puede leer, no se snapshotea */ }
    }
  }
  return { tracked, others, contents };
}

export async function delegationDiff(cwd, touched, before) {
  const parts = [];
  const tmpDirs = [];
  try {
    for (const rel of touched) {
      if (before?.contents?.has(rel)) {
        try {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-tandem-'));
          tmpDirs.push(dir);
          const tmp = path.join(dir, path.basename(rel));
          const real = path.join(cwd, rel);
          fs.writeFileSync(tmp, before.contents.get(rel), 'utf8');
          let diff = await runGit(cwd, ['diff', '--no-index', '--', tmp, real]);
          diff = diff
            .split(`a${tmp}`).join(`a/${rel}`)
            .split(`b${real}`).join(`b/${rel}`)
            .split(`b${tmp}`).join(`b/${rel}`)
            .split(`a${real}`).join(`a/${rel}`)
            .split(tmp).join(rel)
            .split(real).join(rel);
          if (diff.trim()) {
            parts.push(`# ${rel} — diff de ESTA delegación (el archivo ya venía modificado)\n${diff.trim()}`);
          }
        } catch {
          const fallback = await runGit(cwd, ['diff', '--', rel]);
          if (fallback.trim()) parts.push(fallback.trim());
        }
      } else {
        const diff = await runGit(cwd, ['diff', '--', rel]);
        if (diff.trim()) parts.push(diff.trim());
      }
    }
  } finally {
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }
  return parts.join('\n');
}

export function diffSnapshots(before, after, cwd, startedAt) {
  const touchedSet = new Set();
  for (const [rel, value] of after.tracked) {
    if (before.tracked.get(rel) !== value) touchedSet.add(rel);
  }
  for (const rel of before.tracked.keys()) {
    if (!after.tracked.has(rel)) touchedSet.add(rel);
  }

  const newFilesSet = new Set();
  for (const rel of after.others) {
    if (!before.others.has(rel)) {
      newFilesSet.add(rel);
      continue;
    }
    try {
      if (fs.statSync(path.join(cwd, rel)).mtimeMs >= startedAt) newFilesSet.add(rel);
    } catch { /* si no se puede stattear, no se atribuye a esta delegación */ }
  }

  // Señal PRIMARIA para lo que YA venía sucio: comparar el CONTENIDO real contra
  // el snapshot previo. El numstat (agregadas:borradas) es CIEGO a un cambio que
  // no altere esos conteos — p.ej. reemplazar una línea ya agregada por otra.
  if (before.contents) {
    for (const [rel, prev] of before.contents) {
      let now = null;
      try { now = fs.readFileSync(path.join(cwd, rel), 'utf8'); } catch { continue; }
      if (now === prev) continue;
      if (after.others.has(rel)) newFilesSet.add(rel);
      else touchedSet.add(rel);
    }
  }

  return {
    touched: [...touchedSet].sort(),
    newFiles: [...newFilesSet].sort(),
  };
}

// Corre `codex exec --json` con el plan y junta el stream JSONL. Devuelve
// {code|error, msgs[], threadId, usage, stderr, prLinks[]}. Kill por tope de seguridad.
// PLAN-519 F2: modelo+esfuerzo configurables (default gama alta). `fullAccess`
// desactiva el sandbox, necesario para escribir en `.git`.
export function runCodex(cwd, task, model = TANDEM_CODEX_MODEL, effort = TANDEM_CODEX_EFFORT, fullAccess = false, writableRoots = [], onThread = null) {
  return new Promise((resolve) => {
    // Este código corre dentro del runner: os.homedir() ya resuelve al HOME aislado
    // del dueño, inyectado por userRunnerEnv; no corresponde importar user-space.
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    if (!fs.existsSync(authPath)) {
      resolve({
        error: 'Codex no está autenticado para este usuario (falta ~/.codex/auth.json). Ejecutá `codex login` con el HOME de este usuario, o cambiá el modelo del chat a AutoTux/manual.',
        msgs: [],
        threadId: null,
        usage: null,
        stderr: '',
        prLinks: [],
      });
      return;
    }
    const args = [
      'exec', '--json', '--skip-git-repo-check',
      '-m', model,
      '-c', `model_reasoning_effort=${effort}`,
      '-s', fullAccess ? 'danger-full-access' : 'workspace-write',
      ...(!fullAccess && Array.isArray(writableRoots) && writableRoots.length
        ? ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(writableRoots)}`]
        : []),
      (fullAccess ? TANDEM_FULL_ACCESS_WARNING : '') + TANDEM_CODEX_PREAMBLE + task,
    ];
    let child;
    try {
      child = spawn('codex', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ error: e.message, msgs: [], threadId: null, usage: null, stderr: '', prLinks: [] });
      return;
    }
    let buf = '';
    let stderr = '';
    const msgs = [];
    let threadId = null;
    let threadNotified = false;
    let usage = null;
    const prLinks = [];
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      resolve({ error: `timeout tras ${Math.round(CODEX_MAX_MS / 60000)} min`, msgs, threadId, usage, stderr, prLinks });
    }, CODEX_MAX_MS);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'thread.started') {
          threadId = ev.thread_id || threadId;
          if (!threadNotified && threadId && typeof onThread === 'function') {
            threadNotified = true;
            try { onThread(threadId); } catch { /* noop */ }
          }
        }
        else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) msgs.push(ev.item.text);
        else if (ev.type === 'turn.completed' && ev.usage) usage = ev.usage;
        const prLink = prLinkFromCodexEvent(ev);
        if (prLink && prLinks.length < MAX_PR_LINKS && !prLinks.some((link) => link.number === prLink.number)) {
          prLinks.push(prLink);
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, msgs, threadId, usage, stderr, prLinks }); });
    child.on('error', (e) => {
      clearTimeout(timer);
      const error = e.code === 'ENOENT'
        ? 'El binario `codex` no está en el PATH de este runner.'
        : e.message;
      resolve({ error, msgs, threadId, usage, stderr, prLinks });
    });
  });
}

// Arma el texto que recibe Claude con el mismo orden y los mismos recortes que
// tenía la tool inline. `isError` conserva la semántica histórica: solo los
// errores de ejecución marcan error de tool; un exit code distinto de cero se
// informa dentro del reporte.
export async function buildDelegationReport({ res, before, after, cwd, startedAt, changes, attributed = false }) {
  const { touched, newFiles } = changes || diffSnapshots(before, after, cwd, startedAt);
  const parts = [];
  if (res.error) parts.push(`⚠️ Codex terminó con problema: ${res.error}`);
  else if (res.code !== 0) parts.push(`⚠️ Codex salió con código ${res.code}${res.stderr ? ` — ${res.stderr.slice(0, 300)}` : ''}`);
  parts.push(`RESUMEN DE CODEX:\n${res.msgs.length ? res.msgs.join('\n\n') : '(Codex no devolvió mensaje final)'}`);
  if (touched.length || newFiles.length) {
    if (touched.length) {
      const scopedStat = await runGit(cwd, ['diff', '--stat', '--', ...touched]);
      if (scopedStat.trim()) {
        const title = attributed ? 'ARCHIVOS QUE TOCÓ CODEX' : 'ARCHIVOS QUE CAMBIARON DURANTE LA DELEGACIÓN';
        parts.push(`${title}:\n${scopedStat.trim()}`);
      }
    }
    if (newFiles.length) {
      const title = attributed ? 'ARCHIVOS NUEVOS DE ESTA DELEGACIÓN' : 'ARCHIVOS NUEVOS APARECIDOS DURANTE LA DELEGACIÓN';
      parts.push(`${title}:\n${newFiles.join('\n')}`);
      const trulyNewFiles = newFiles.filter((rel) => !before.contents?.has(rel));
      const preexistingNewFiles = newFiles.filter((rel) => before.contents?.has(rel));
      const newContent = readUntracked(cwd, trulyNewFiles.join('\n'));
      if (newContent) parts.push(`CONTENIDO DE ARCHIVOS NUEVOS:\n${newContent}`);
      if (preexistingNewFiles.length) {
        const preexistingDiff = (await delegationDiff(cwd, preexistingNewFiles, before)).trim();
        if (preexistingDiff) parts.push(`DIFF DE ARCHIVOS NUEVOS YA EXISTENTES:\n${preexistingDiff}`);
      }
    }
    let scoped = touched.length ? (await delegationDiff(cwd, touched, before)).trim() : '';
    if (scoped.length > MAX_SCOPED_DIFF) {
      scoped = `${scoped.slice(0, MAX_SCOPED_DIFF)}\n… (diff acotado truncado — leé el resto con Read sobre: ${touched.join(', ')})`;
    }
    const diffTitle = attributed ? 'DIFF (solo lo que tocó esta delegación)' : 'DIFF (cambios ocurridos durante la delegación)';
    parts.push(scoped ? `${diffTitle}:\n${scoped}` : 'DIFF: (Codex no modificó archivos ya trackeados — mirá ARCHIVOS NUEVOS)');

    const touchedSet = new Set(touched);
    const newFilesSet = new Set(newFiles);
    let unrelated = 0;
    for (const rel of after.tracked.keys()) {
      if (!touchedSet.has(rel)) unrelated += 1;
    }
    for (const rel of after.others) {
      if (!newFilesSet.has(rel)) unrelated += 1;
    }
    if (unrelated > 0) parts.push(`(nota: el árbol tiene además ${unrelated} archivo(s) modificado(s) ajenos a esta delegación — ignoralos)`);
    if (!attributed) parts.push('(aviso: esta corrida no corrió aislada, así que no se puede distinguir lo que escribió Codex de lo que escribió otra sesión en la misma ventana. Puede ser porque no se declararon `files`, o porque esta sesión arrancó antes de que el campo existiera y lo descartó en silencio — en ese caso hace falta «Reabrir para cambios». Con `files` activo la atribución es exacta y además hay aislamiento.)');
  } else {
    let diffText = (await runGit(cwd, ['diff'])).trim();
    if (diffText.length > MAX_DIFF) diffText = `${diffText.slice(0, MAX_DIFF)}\n… (diff truncado — revisá el resto con git diff)`;
    parts.push(diffText ? `DIFF (no se pudo acotar a esta delegación — árbol completo):\n${diffText}` : 'DIFF: (sin cambios detectados)');
  }
  if (res.threadId) parts.push(`(codex thread: ${res.threadId})`);
  return { text: parts.join('\n\n'), isError: !!res.error };
}

// Usa el mismo resolutor multi-tenant que chatAttachDir(): el server puede
// inyectar CWC_DATA_DIR y el HOME aislado del dueño conserva el fallback.
export function codexJobsDir() {
  const dir = path.join(resolveDataDir(), 'codex-jobs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function newCodexJobId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

export function codexJobPath(id) {
  const safeId = String(id || '');
  if (!JOB_ID_RE.test(safeId)) throw new Error(`Id de job Codex inválido: ${safeId || '(vacío)'}`);
  return path.join(codexJobsDir(), `${safeId}.json`);
}

function readCodexJobFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function writeCodexJobFile(file, next) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}

function processIsDead(pid) {
  const n = Number(pid);
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return false;
  } catch (err) {
    return err?.code === 'ESRCH';
  }
}

// Reaper central: TODO lector obtiene estado efectivo, no un `running` fósil.
// El pid permite detectar enseguida un runner muerto; el heartbeat cubre jobs
// viejos sin pid, PID reciclado, SIGKILL y caídas completas del host.
export function readCodexJob(id) {
  let file;
  try { file = codexJobPath(id); }
  catch { return null; }
  const job = readCodexJobFile(file);
  if (!job || job.status !== 'running') return job;

  const now = Date.now();
  const heartbeatAt = Number(job.heartbeatAt || job.startedAt || 0);
  const heartbeatExpired = heartbeatAt > 0 && now - heartbeatAt > CODEX_HEARTBEAT_STALE_MS;
  const pidDead = processIsDead(job.pid);
  if (!heartbeatExpired && !pidDead) return job;

  const reason = pidDead
    ? `El runner de Codex quedó huérfano: el pid ${job.pid} ya no existe.`
    : `El runner de Codex quedó huérfano: heartbeat vencido por más de ${CODEX_HEARTBEAT_STALE_MS / 1000} s.`;
  const orphaned = {
    ...job,
    status: 'orphaned',
    isError: true,
    error: reason,
    orphanedAt: now,
    finishedAt: now,
    id,
  };
  // Leer conserva su contrato best-effort aunque el volumen se haya vuelto
  // read-only: el lector igual ve el estado efectivo y deja de contarlo vivo.
  try { return writeCodexJobFile(file, orphaned); }
  catch { return orphaned; }
}

export function writeCodexJob(id, patch) {
  const file = codexJobPath(id);
  const current = readCodexJob(id) || {};
  return writeCodexJobFile(file, { ...current, ...(patch || {}), id });
}

export function listCodexJobs(chatId) {
  let files = [];
  try { files = fs.readdirSync(codexJobsDir()); } catch { return []; }
  const jobs = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -5);
    if (!JOB_ID_RE.test(id)) continue;
    const job = readCodexJob(id);
    if (job?.chatId === chatId) jobs.push(job);
  }
  return jobs.sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
}

export function pruneCodexJobs() {
  try {
    const dir = codexJobsDir();
    const now = Date.now();
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -5);
      if (!JOB_ID_RE.test(id)) continue;
      try {
        const job = readCodexJob(id);
        if (!job || !CODEX_JOB_TERMINAL_STATUSES.includes(job.status)) continue;
        const finishedAt = Number(job.finishedAt || 0);
        if (finishedAt > 0 && now - finishedAt > FINISHED_JOB_MAX_AGE_MS) {
          fs.unlinkSync(path.join(dir, file));
        }
      } catch { /* best-effort por archivo */ }
    }
  } catch { /* best-effort global */ }
}
