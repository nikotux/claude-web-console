// modules/chat/codex-tool.js — herramienta IN-PROCESS `delegate_to_codex` del
// modelo TÁNDEM (PLAN-507 / PEND-508).
//
// En Tándem, Claude RAZONA y PLANEA pero NO edita código (el runner le deniega
// Edit/Write). Su único brazo para tocar archivos es esta herramienta: Claude le
// pasa un PLAN concreto y Codex (gpt-5.5, esfuerzo alto) lo IMPLEMENTA en el
// MISMO cwd del chat. Devuelve el resumen de Codex + el `git diff` ACOTADO a los
// archivos que esa delegación tocó, detectado por snapshot de git antes/después,
// para que Claude lo VERIFIQUE sin tragarse el árbol entero. La atribución usa
// dos señales: el numstat de git y, para lo que ya venía sucio, el contenido real
// contra el snapshot previo (el numstat es ciego si no cambian los conteos de
// líneas). Si un archivo YA venía modificado, el diff se calcula pre/post contra
// el contenido snapshoteado antes de Codex (no contra HEAD), así muestra SOLO lo
// de esa delegación. El diff
// global escondía el cambio real en 2 de cada 3 delegaciones y consumía ~30k
// chars por vuelta. El split es estructural: la generación de código —lo caro en
// la ventana de Claude— corre en la ventana de la suscripción ChatGPT.
//
// La herramienta se arma con createSdkMcpServer()+tool() del Agent SDK (corre
// dentro del proceso del runner). Como una corrida de Codex puede durar minutos,
// el runner sube CLAUDE_CODE_STREAM_CLOSE_TIMEOUT (el SDK corta las tools MCP a
// 60 s por defecto — ver sdk.d.ts:441).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// Defaults del ejecutor Codex (gama alta). PLAN-519 F2: el usuario puede
// CONFIGURAR modelo+esfuerzo del Codex desde el selector; estos son los defaults
// (retrocompat con el Tándem hardcodeado original). `model_reasoning_effort` va
// como override -c; el valor sin comillas cae a string crudo (TOML inválido →
// raw), verificado con --strict-config.
export const TANDEM_CODEX_MODEL = 'gpt-5.5';
export const TANDEM_CODEX_EFFORT = 'high';
export const TANDEM_CODEX_PREAMBLE = [
  'Reglas fijas del protocolo Tándem (aplican SIEMPRE, no hace falta que te las repitan):',
  '- Tocá ÚNICAMENTE los archivos que el plan menciona. Si creés que hace falta tocar otro, decilo en tu mensaje final en vez de hacerlo.',
  '- Al terminar, verificá la sintaxis de cada archivo .js que hayas modificado con `node --check <archivo>`.',
  '- No corras git commit, git push, systemctl ni npm install salvo pedido explícito.',
  '- En tu mensaje final resumí en pocas líneas QUÉ cambiaste y en qué archivo.',
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

// Modelos Codex válidos (whitelist estricta para el arg del runner).
export const CODEX_MODELS = new Set(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark']);
export const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const CODEX_TIMEOUT_MS = 8 * 60 * 1000; // tope por delegación
const MAX_DIFF = 16000;                 // recorte del diff del árbol completo; solo aplica en la rama de fallback
const MAX_SCOPED_DIFF = 8000;            // recorte chico: solo trae lo que tocó esta delegación
const MAX_NEW = 8000;                    // recorte del contenido de archivos NUEVOS
const MAX_NEW_FILE = 4000;               // recorte por archivo nuevo
const MAX_SNAPSHOT_FILE = 1024 * 1024;      // 1 MB: no snapshoteamos archivos enormes
const MAX_SNAPSHOT_TOTAL = 8 * 1024 * 1024; // 8 MB: tope global del snapshot en memoria

// Muestra el contenido de los archivos NUEVOS (untracked): `git diff` NO los
// incluye (solo cambios de archivos ya trackeados) y tocar el índice con
// `git add -N` interferiría con lo que el usuario tenga stageado. Los leemos con
// fs (no muta el repo) y los formateamos como "+" para que Claude los verifique.
function readUntracked(cwd, list) {
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

// Corre un `git` de LECTURA en cwd y devuelve su stdout (o '' si falla / no es
// repo). Nunca lanza — best-effort.
function runGit(cwd, gitArgs) {
  return new Promise((resolve) => {
    let out = '';
    try {
      const p = spawn('git', ['-C', cwd, ...gitArgs], { stdio: ['ignore', 'pipe', 'ignore'] });
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.on('close', () => resolve(out));
      p.on('error', () => resolve(''));
    } catch { resolve(''); }
  });
}

async function snapshotTree(cwd, { withContents = false } = {}) {
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
// {code|error, msgs[], threadId, usage, stderr}. Kill por timeout. PLAN-519 F2:
// modelo+esfuerzo configurables (default gama alta). `fullAccess` desactiva el
// sandbox, necesario para escribir en `.git`.
function runCodex(cwd, task, model = TANDEM_CODEX_MODEL, effort = TANDEM_CODEX_EFFORT, fullAccess = false) {
  return new Promise((resolve) => {
    const args = [
      'exec', '--json', '--skip-git-repo-check',
      '-m', model,
      '-c', `model_reasoning_effort=${effort}`,
      '-s', fullAccess ? 'danger-full-access' : 'workspace-write',
      (fullAccess ? TANDEM_FULL_ACCESS_WARNING : '') + TANDEM_CODEX_PREAMBLE + task,
    ];
    let child;
    try {
      child = spawn('codex', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ error: e.message, msgs: [], threadId: null, usage: null, stderr: '' });
      return;
    }
    let buf = '';
    let stderr = '';
    const msgs = [];
    let threadId = null;
    let usage = null;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      resolve({ error: `timeout tras ${Math.round(CODEX_TIMEOUT_MS / 60000)} min`, msgs, threadId, usage, stderr });
    }, CODEX_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'thread.started') threadId = ev.thread_id || threadId;
        else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) msgs.push(ev.item.text);
        else if (ev.type === 'turn.completed' && ev.usage) usage = ev.usage;
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, msgs, threadId, usage, stderr }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message, msgs, threadId, usage, stderr }); });
  });
}

// Fábrica del servidor MCP in-process con la única tool `delegate_to_codex`.
// `cwd` = directorio del chat (Codex ejecuta ahí, con sandbox workspace-write).
// PLAN-519 F2: `model`/`effort` del Codex configurables (default gama alta).
export function createCodexToolServer({ cwd, model = TANDEM_CODEX_MODEL, effort = TANDEM_CODEX_EFFORT }) {
  const codexModel = CODEX_MODELS.has(model) ? model : TANDEM_CODEX_MODEL;
  const codexEffort = CODEX_EFFORTS.has(effort) ? effort : TANDEM_CODEX_EFFORT;
  const delegateTool = tool(
    'delegate_to_codex',
    `Delega la EJECUCIÓN de cambios de código a Codex (${codexModel}, esfuerzo ${codexEffort}). `
    + 'En el modelo Tándem, vos (Claude) NO editás archivos: describí acá un PLAN '
    + 'concreto y accionable (qué archivos tocar, qué cambios exactos hacer, cómo '
    + 'verificar) y Codex lo implementa en el directorio del proyecto. Devuelve el '
    + 'resumen de lo que hizo Codex y el diff ACOTADO a los archivos que tocó esta '
    + 'delegación (no el árbol entero) para que lo verifiques. '
    + 'Si la tarea necesita escribir en `.git` (rebase, cherry-pick, reset, fetch), pasá full_access: true — sin eso Codex ve `.git` como solo-lectura y falla. '
    + 'Cuanto más preciso el plan, mejor la ejecución.',
    {
      task: z.string().describe('Plan de implementación concreto para Codex: archivos, cambios exactos y criterios de verificación.'),
      full_access: z.boolean().optional().describe('Desactiva el sandbox de Codex (corre en danger-full-access). Úsalo ÚNICAMENTE cuando la tarea necesite escribir en `.git` (rebase, cherry-pick, reset, fetch): en el modo normal Codex monta `.git` como solo-lectura y esas operaciones fallan con "read-only file system". No lo actives para cambios de código comunes.'),
    },
    async ({ task, full_access }) => {
      const startedAt = Date.now();
      const before = await snapshotTree(cwd, { withContents: true });
      const res = await runCodex(cwd, task, codexModel, codexEffort, full_access === true);
      const after = await snapshotTree(cwd);
      const { touched, newFiles } = diffSnapshots(before, after, cwd, startedAt);
      const parts = [];
      if (res.error) parts.push(`⚠️ Codex terminó con problema: ${res.error}`);
      else if (res.code !== 0) parts.push(`⚠️ Codex salió con código ${res.code}${res.stderr ? ` — ${res.stderr.slice(0, 300)}` : ''}`);
      parts.push(`RESUMEN DE CODEX:\n${res.msgs.length ? res.msgs.join('\n\n') : '(Codex no devolvió mensaje final)'}`);
      if (touched.length || newFiles.length) {
        if (touched.length) {
          const scopedStat = await runGit(cwd, ['diff', '--stat', '--', ...touched]);
          if (scopedStat.trim()) parts.push(`ARCHIVOS QUE TOCÓ CODEX:\n${scopedStat.trim()}`);
        }
        if (newFiles.length) {
          parts.push(`ARCHIVOS NUEVOS DE ESTA DELEGACIÓN:\n${newFiles.join('\n')}`);
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
        parts.push(scoped ? `DIFF (solo lo que tocó esta delegación):\n${scoped}` : 'DIFF: (Codex no modificó archivos ya trackeados — mirá ARCHIVOS NUEVOS)');

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
      } else {
        let diffText = (await runGit(cwd, ['diff'])).trim();
        if (diffText.length > MAX_DIFF) diffText = `${diffText.slice(0, MAX_DIFF)}\n… (diff truncado — revisá el resto con git diff)`;
        parts.push(diffText ? `DIFF (no se pudo acotar a esta delegación — árbol completo):\n${diffText}` : 'DIFF: (sin cambios detectados)');
      }
      if (res.threadId) parts.push(`(codex thread: ${res.threadId})`);
      return {
        content: [{ type: 'text', text: parts.join('\n\n') }],
        ...(res.error ? { isError: true } : {}),
      };
    },
    { alwaysLoad: true }, // que Claude la vea sin ToolSearch
  );
  return createSdkMcpServer({ name: 'codex', version: '1.0.0', tools: [delegateTool] });
}
