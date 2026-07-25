// modules/chat/codex-tool.js — herramientas TÁNDEM para delegar ejecución a
// Codex mediante jobs persistidos y un runner desacoplado.
//
// En Tándem, Claude RAZONA y PLANEA pero NO edita código (el runner le deniega
// Edit/Write). Su único brazo para tocar archivos es esta herramienta: Claude le
// pasa un PLAN concreto y Codex (gpt-5.6-sol, esfuerzo alto) lo IMPLEMENTA en el
// MISMO cwd del chat. Cada delegación vive como job en disco y la ejecuta
// bin/cwc-codex-runner.js en un proceso detached: sobrevive a reinicios de la web
// y permite lanzar varias corridas en paralelo. `delegate_to_codex` puede esperar
// como antes o devolver de inmediato; `collect_codex` lista y recoge resultados.
//
// El runner arma el reporte con el resumen de Codex y el diff acotado a los
// archivos atribuibles a esa delegación. Este módulo solo persiste, lanza y
// observa jobs; nunca ejecuta Codex dentro del proceso del chat.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  TANDEM_CODEX_MODEL,
  TANDEM_CODEX_EFFORT,
  CODEX_MODELS,
  CODEX_EFFORTS,
  normalizeCodexModel,
  normalizeCodexEffort,
} from './codex-models.js';
import {
  CODEX_MAX_MS,
  codexJobLabel,
  listCodexJobs,
  newCodexJobId,
  readCodexJob,
  writeCodexJob,
} from './codex-shared.js';

const RUNNER_PATH = fileURLToPath(new URL('../../../bin/cwc-codex-runner.js', import.meta.url));
const JOB_POLL_MS = 2 * 1000;
const HEARTBEAT_EXPIRED_MS = 90 * 1000;
const WAIT_MAX_MS = CODEX_MAX_MS + 5 * 60 * 1000;

// Re-exports históricos: otros módulos pueden seguir importando estos nombres
// desde codex-tool.js aunque la implementación viva en módulos puros.
export {
  TANDEM_CODEX_PREAMBLE,
  TANDEM_FULL_ACCESS_WARNING,
  delegationDiff,
  diffSnapshots,
} from './codex-shared.js';
export { TANDEM_CODEX_MODEL, TANDEM_CODEX_EFFORT, CODEX_MODELS, CODEX_EFFORTS };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function heartbeatExpired(job, now = Date.now()) {
  return job?.status === 'running'
    && now - Number(job.heartbeatAt || 0) > HEARTBEAT_EXPIRED_MS;
}

function jobResultText(job) {
  if (job?.report) return job.report;
  const error = job?.error || 'La delegación terminó sin reporte ni detalle de error.';
  return `⚠️ Codex terminó con problema: ${error}`;
}

function resultIsError(job) {
  return job?.status === 'error' || job?.isError === true;
}

function safeNotify(callback, ...args) {
  if (typeof callback !== 'function') return;
  try {
    const pending = callback(...args);
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  } catch { /* un callback del radar nunca rompe la delegación */ }
}

function stateText(job) {
  const warning = heartbeatExpired(job) ? ' · ⚠ heartbeat vencido' : '';
  return `${job?.status || 'desconocido'}${warning}`;
}

function ageMinutes(job, now = Date.now()) {
  const startedAt = Number(job?.startedAt || now);
  return Math.max(0, Math.floor((now - startedAt) / 60000));
}

// Fábrica del servidor MCP in-process que administra los jobs desacoplados.
// `cwd` = directorio del chat (Codex ejecuta ahí, con sandbox workspace-write).
// PLAN-519 F2: `model`/`effort` del Codex configurables (default gama alta).
export function createCodexToolServer({
  cwd,
  model = TANDEM_CODEX_MODEL,
  effort = TANDEM_CODEX_EFFORT,
  chatDir,
  chatId,
  onBgStart,
  onBgEnd,
}) {
  if (chatDir) { try { fs.mkdirSync(chatDir, { recursive: true }); } catch { /* best-effort */ } }
  const codexModel = normalizeCodexModel(model);
  const codexEffort = normalizeCodexEffort(codexModel, effort);

  async function launchJob({ task, fullAccess }) {
    const id = newCodexJobId();
    const label = codexJobLabel(task);
    const writableRoots = fullAccess ? [] : (chatDir ? [chatDir] : []);
    writeCodexJob(id, {
      id,
      chatId,
      cwd,
      task,
      label,
      model: codexModel,
      effort: codexEffort,
      fullAccess: !!fullAccess,
      writableRoots,
      status: 'pending',
      startedAt: Date.now(),
    });

    try {
      const child = spawn(process.execPath, [RUNNER_PATH, '--job', id], {
        detached: true,
        stdio: 'ignore',
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
    } catch (err) {
      const error = `No se pudo lanzar el runner de Codex: ${String(err?.message || err)}`;
      try {
        writeCodexJob(id, {
          status: 'error',
          error,
          finishedAt: Date.now(),
        });
      } catch { /* preservamos como causa principal el fallo del spawn */ }
      throw new Error(error);
    }

    safeNotify(onBgStart, { id, kind: 'Codex', label });
    return { id, label };
  }

  async function waitJob(id) {
    const initial = readCodexJob(id);
    const waitStartedAt = Number(initial?.startedAt || Date.now());
    try {
      while (true) {
        const job = readCodexJob(id);
        if (!job) {
          return {
            id,
            status: 'error',
            error: 'El job de Codex desapareció antes de dejar resultado.',
          };
        }
        if (job.status === 'done' || job.status === 'error') return job;
        if (heartbeatExpired(job)) {
          return {
            ...job,
            status: 'error',
            error: 'El proceso de Codex murió sin dejar resultado (heartbeat vencido). Volvé a delegar.',
          };
        }
        if (Date.now() - waitStartedAt > WAIT_MAX_MS) {
          return {
            ...job,
            status: 'error',
            error: `La delegación superó el tope de ${Math.round(WAIT_MAX_MS / 60000)} minutos sin dejar resultado. Volvé a delegar.`,
          };
        }
        await sleep(JOB_POLL_MS);
      }
    } finally {
      safeNotify(onBgEnd, id);
    }
  }

  const delegateTool = tool(
    'delegate_to_codex',
    `Delega la EJECUCIÓN de cambios de código a Codex (${codexModel}, esfuerzo ${codexEffort}). `
    + 'En el modelo Tándem, vos (Claude) NO editás archivos: describí acá un PLAN '
    + 'concreto y accionable (qué archivos tocar, qué cambios exactos hacer, cómo '
    + 'verificar) y Codex lo implementa en un proceso propio que sobrevive a reinicios '
    + 'de la web y ya no tiene el antiguo tope de 8 minutos. Devuelve el '
    + 'resumen de lo que hizo Codex y el diff ACOTADO a los archivos que tocó esta '
    + 'delegación (no el árbol entero) para que lo verifiques. '
    + 'Con background: true devuelve inmediatamente y permite lanzar varias delegaciones en paralelo; después recogelas con collect_codex. '
    + 'Si la tarea necesita escribir en `.git` (rebase, cherry-pick, reset, fetch), pasá full_access: true — sin eso Codex ve `.git` como solo-lectura y falla. '
    + 'Cuanto más preciso el plan, mejor la ejecución.',
    {
      task: z.string().describe('Plan de implementación concreto para Codex: archivos, cambios exactos y criterios de verificación.'),
      full_access: z.boolean().optional().describe('Desactiva el sandbox de Codex (corre en danger-full-access). Úsalo ÚNICAMENTE cuando la tarea necesite escribir en `.git` (rebase, cherry-pick, reset, fetch): en el modo normal Codex monta `.git` como solo-lectura y esas operaciones fallan con "read-only file system". No lo actives para cambios de código comunes.'),
      background: z.boolean().optional().describe('Lanza la delegación y devuelve el control INMEDIATAMENTE, sin esperar a que Codex termine. Usalo cuando quieras trabajar en otra cosa mientras corre, o lanzar VARIAS delegaciones en paralelo sobre archivos que no se pisan. Después recogé el resultado con `collect_codex`. Por defecto (false) espera el resultado, como siempre.'),
    },
    async ({ task, full_access, background }) => {
      let launched;
      try {
        launched = await launchJob({ task, fullAccess: full_access === true });
      } catch (err) {
        return {
          content: [{ type: 'text', text: String(err?.message || err) }],
          isError: true,
        };
      }
      if (background === true) {
        return {
          content: [{
            type: 'text',
            text: `Delegación lanzada: ${launched.label}\n`
              + `jobId: ${launched.id}\n`
              + `Recogé el resultado con collect_codex usando job_ids: ["${launched.id}"]. `
              + 'Mientras tanto podés lanzar más delegaciones en paralelo; este trabajo sobrevive a un reinicio de la web.',
          }],
        };
      }
      const job = await waitJob(launched.id);
      return {
        content: [{ type: 'text', text: jobResultText(job) }],
        ...(resultIsError(job) ? { isError: true } : {}),
      };
    },
    { alwaysLoad: true }, // que Claude la vea sin ToolSearch
  );

  const collectTool = tool(
    'collect_codex',
    'Recoge el resultado de delegaciones lanzadas con `background: true`. Sin argumentos lista el estado de todas las de esta conversación; con `job_ids` espera a que terminen y devuelve el resumen y el diff de cada una.',
    {
      job_ids: z.array(z.string()).optional().describe('Ids exactos de los jobs de esta conversación que querés recoger. Sin esta lista, muestra el estado de todos sin esperar.'),
      wait: z.boolean().optional().describe('Si es false, devuelve solo el estado actual sin esperar. Por defecto es true.'),
    },
    async ({ job_ids, wait }) => {
      if (!Array.isArray(job_ids) || job_ids.length === 0) {
        const jobs = listCodexJobs(chatId);
        if (!jobs.length) {
          return { content: [{ type: 'text', text: 'No hay delegaciones de Codex en esta conversación.' }] };
        }
        const now = Date.now();
        const rows = ['jobId | estado | label | hace'];
        const expired = [];
        for (const job of jobs) {
          if (heartbeatExpired(job, now)) expired.push(job.id);
          const label = String(job.label || 'delegación a Codex').replaceAll('|', '¦');
          rows.push(`${job.id} | ${stateText(job)} | ${label} | ${ageMinutes(job, now)} min`);
        }
        if (expired.length) {
          rows.push('', `Aviso: heartbeat vencido en ${expired.join(', ')}; el proceso puede haber muerto.`);
        }
        return { content: [{ type: 'text', text: rows.join('\n') }] };
      }

      const ids = [...new Set(job_ids)];
      const accepted = [];
      const discarded = [];
      for (const id of ids) {
        const job = readCodexJob(id);
        if (!job || job.chatId !== chatId) discarded.push(id);
        else accepted.push(job);
      }

      const discardedText = discarded.length
        ? `Descartados por inexistentes o por pertenecer a otra conversación: ${discarded.join(', ')}`
        : '';
      if (!accepted.length) {
        return {
          content: [{ type: 'text', text: discardedText || 'No se indicó ningún job válido de esta conversación.' }],
        };
      }

      const jobs = wait === false
        ? accepted
        : await Promise.all(accepted.map((job) => waitJob(job.id)));
      const blocks = jobs.map((job) => {
        const label = job.label || 'delegación a Codex';
        const body = wait === false ? `estado: ${stateText(job)}` : jobResultText(job);
        return `=== ${job.id} · ${label} ===\n${body}`;
      });
      const text = [discardedText, ...blocks].filter(Boolean).join('\n\n');
      return {
        content: [{ type: 'text', text }],
        ...(jobs.some(resultIsError) ? { isError: true } : {}),
      };
    },
    { alwaysLoad: true }, // que Claude la vea sin ToolSearch
  );

  return createSdkMcpServer({
    name: 'codex',
    version: '1.0.0',
    tools: [delegateTool, collectTool],
  });
}
