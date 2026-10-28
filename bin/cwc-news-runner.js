#!/usr/bin/env node
// bin/cwc-news-runner.js — genera y publica "🆕 Novedades" en un proceso
// DESACOPLADO del server. El job y el resultado viven en ~/.cwc-data/news/.
//
// SEGURIDAD (regla 6): corrida READ-ONLY con DOS capas explícitas. El hook
// PreToolUse y canUseTool comparten la allowlist Read/Grep/Glob/ToolSearch;
// todo lo demás se deniega por defecto. settingSources queda vacío: no carga
// settings, Bash, MCP ni permisos pre-aprobados.
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  ROOT,
  NEWS_ID_RE,
  NEWS_TIMEOUT_MS,
  appendEntries,
  buildNewsPrompt,
  makePublishedNewsEntry,
  parseNewsResponse,
  readNewsJob,
  writeNewsCursor,
  writeNewsJob,
} from '../src/modules/news/news-shared.js';

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);
const id = String(process.argv[2] || '');
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'ToolSearch']);
const denyMessage = 'Novedades: corrida de SOLO LECTURA (Read/Grep/Glob/ToolSearch).';
const denyHook = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: denyMessage,
  },
};

function toolAllowed(name) {
  return READ_TOOLS.has(name);
}

async function generate(job) {
  let finalText = '';
  const q = query({
    prompt: buildNewsPrompt(job),
    options: {
      cwd: ROOT,
      model: 'sonnet',
      maxTurns: 30,
      permissionMode: 'default',
      settingSources: [],
      // Capa 1: deny por defecto antes de evaluar permisos.
      hooks: {
        PreToolUse: [{
          hooks: [async (input) => (toolAllowed(input.tool_name) ? {} : denyHook)],
        }],
      },
      // Capa 2: allowlist idéntica para toda solicitud de herramienta.
      canUseTool: async (name, input) => (toolAllowed(name)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: denyMessage }),
    },
  });

  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('La generación venció el timeout de 8 minutos.')), NEWS_TIMEOUT_MS);
  });
  const pump = (async () => {
    for await (const message of q) {
      if (message.type === 'assistant') {
        const assistantText = (message.message?.content || [])
          .filter((block) => block.type === 'text' && block.text)
          .map((block) => block.text)
          .join('');
        if (assistantText.trim()) finalText = assistantText;
      } else if (message.type === 'result') {
        log('resultado del SDK:', message.subtype || '(sin subtype)');
        if (typeof message.result === 'string' && message.result.trim()) finalText = message.result;
        break;
      }
    }
  })();
  pump.catch(() => {});

  try {
    await Promise.race([pump, timeout]);
  } finally {
    clearTimeout(timer);
    try { await Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ }
  }
  return finalText;
}

async function main() {
  if (!NEWS_ID_RE.test(id)) {
    log('falta un id de job válido.');
    process.exit(1);
    return;
  }
  const job = readNewsJob(id);
  if (!job) {
    log(`job ${id} inexistente (¿se podó antes de arrancar?).`);
    process.exit(0);
    return;
  }
  if (job.status !== 'running') {
    log(`job ${id} ya está en estado ${job.status}; no se repite.`);
    process.exit(0);
    return;
  }

  let text = '';
  try {
    text = await generate(job);
    const parsed = parseNewsResponse(text);
    if (!parsed) {
      const message = 'No se pudo interpretar un array JSON en la respuesta.';
      const rawTail = String(text || '').slice(-1500);
      writeNewsJob(id, {
        ...job,
        status: 'error',
        count: null,
        error: message,
        rawTail,
        updatedAt: Date.now(),
      });
      log(`FAIL job ${id}:`, message, 'rawTail:', rawTail);
      return;
    }

    const tech = { commits: job.commits || [], files: job.files || [] };
    const entries = parsed
      .map((draft) => makePublishedNewsEntry(draft, tech))
      .filter(Boolean)
      // Un push suele reunir medio día de trabajo con varias features visibles;
      // un techo de tres recortaba novedades reales.
      .slice(0, 6);
    if (entries.length) await appendEntries(entries);

    // El cursor avanza también cuando la respuesta válida es []; así el mismo
    // rango interno no vuelve a consumir tokens en la próxima generación.
    const lastCommit = [...(job.commits || [])].reverse()
      .find((commit) => /^[a-f0-9]{7,40}$/i.test(String(commit?.sha || '').trim()));
    if (!lastCommit) throw new Error('El job no contiene un commit válido para avanzar el cursor.');
    writeNewsCursor(lastCommit.sha);

    writeNewsJob(id, {
      ...job,
      status: 'done',
      count: entries.length,
      error: null,
      updatedAt: Date.now(),
    });
    log(`OK job ${id}: ${entries.length} novedad(es) publicada(s).`);
  } catch (error) {
    const message = String(error?.message || error).slice(0, 300);
    writeNewsJob(id, {
      ...job,
      status: 'error',
      count: null,
      error: message,
      updatedAt: Date.now(),
    });
    log(`FAIL job ${id}:`, message);
  }
}

main().catch((error) => {
  log('FALLO inesperado:', error?.message || error);
  process.exit(1);
});
