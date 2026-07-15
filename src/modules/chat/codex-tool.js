// modules/chat/codex-tool.js — herramienta IN-PROCESS `delegate_to_codex` del
// modelo TÁNDEM (PLAN-507 / PEND-508).
//
// En Tándem, Claude RAZONA y PLANEA pero NO edita código (el runner le deniega
// Edit/Write). Su único brazo para tocar archivos es esta herramienta: Claude le
// pasa un PLAN concreto y Codex (gpt-5.5, esfuerzo alto) lo IMPLEMENTA en el
// MISMO cwd del chat. Devuelve el resumen de Codex + el `git diff` para que
// Claude lo VERIFIQUE. El split es estructural: la generación de código —lo
// caro en la ventana de Claude— corre en la ventana de la suscripción ChatGPT.
//
// La herramienta se arma con createSdkMcpServer()+tool() del Agent SDK (corre
// dentro del proceso del runner). Como una corrida de Codex puede durar minutos,
// el runner sube CLAUDE_CODE_STREAM_CLOSE_TIMEOUT (el SDK corta las tools MCP a
// 60 s por defecto — ver sdk.d.ts:441).
import fs from 'node:fs';
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
// Modelos Codex válidos (whitelist estricta para el arg del runner).
export const CODEX_MODELS = new Set(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark']);
export const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const CODEX_TIMEOUT_MS = 8 * 60 * 1000; // tope por delegación
const MAX_DIFF = 16000;                 // recorte del diff (tracked) para no reventar el contexto
const MAX_NEW = 8000;                    // recorte del contenido de archivos NUEVOS
const MAX_NEW_FILE = 4000;               // recorte por archivo nuevo

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

// Corre `codex exec --json` con el plan y junta el stream JSONL. Devuelve
// {code|error, msgs[], threadId, usage, stderr}. Kill por timeout. PLAN-519 F2:
// modelo+esfuerzo configurables (default gama alta).
function runCodex(cwd, task, model = TANDEM_CODEX_MODEL, effort = TANDEM_CODEX_EFFORT) {
  return new Promise((resolve) => {
    const args = [
      'exec', '--json', '--skip-git-repo-check',
      '-m', model,
      '-c', `model_reasoning_effort=${effort}`,
      '-s', 'workspace-write',
      task,
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
    + 'resumen de lo que hizo Codex y el git diff resultante para que lo verifiques. '
    + 'Cuanto más preciso el plan, mejor la ejecución.',
    { task: z.string().describe('Plan de implementación concreto para Codex: archivos, cambios exactos y criterios de verificación.') },
    async ({ task }) => {
      const res = await runCodex(cwd, task, codexModel, codexEffort);
      const [stat, diff, untracked] = await Promise.all([
        runGit(cwd, ['diff', '--stat']),
        runGit(cwd, ['diff']),
        runGit(cwd, ['ls-files', '--others', '--exclude-standard']),
      ]);
      const parts = [];
      if (res.error) parts.push(`⚠️ Codex terminó con problema: ${res.error}`);
      else if (res.code !== 0) parts.push(`⚠️ Codex salió con código ${res.code}${res.stderr ? ` — ${res.stderr.slice(0, 300)}` : ''}`);
      parts.push(`RESUMEN DE CODEX:\n${res.msgs.length ? res.msgs.join('\n\n') : '(Codex no devolvió mensaje final)'}`);
      if (stat.trim()) parts.push(`ARCHIVOS MODIFICADOS:\n${stat.trim()}`);
      if (untracked.trim()) {
        parts.push(`ARCHIVOS NUEVOS (sin trackear):\n${untracked.trim()}`);
        const newContent = readUntracked(cwd, untracked);
        if (newContent) parts.push(`CONTENIDO DE ARCHIVOS NUEVOS:\n${newContent}`);
      }
      let diffText = diff.trim();
      if (diffText.length > MAX_DIFF) diffText = `${diffText.slice(0, MAX_DIFF)}\n… (diff truncado — revisá el resto con git diff)`;
      parts.push(diffText ? `DIFF:\n${diffText}` : 'DIFF: (sin cambios en archivos trackeados — revisá "ARCHIVOS NUEVOS" si los hay)');
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
