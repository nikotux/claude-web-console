#!/usr/bin/env node
// bin/cwc-comms-chatbot-runner.js — motor del CHATBOT del módulo Comunicaciones,
// DESACOPLADO (regla de oro: detached+unref, un reinicio de la web NO lo mata).
//
// Deriva la sección "🤖 Chatbot" de lo que YA escaneamos del bot de Teams
// "Tolkien" (TheEye), en DOS fases (ver chatbot-shared.js):
//   Fase 1 (LEER): por cada contacto kind:'bot' con chatId, lee sus mensajes
//     CRUDOS de Teams vía Graph (read-only, regla 6 doble capa = graphReadAllowed,
//     reusa teamsBotPrompt/parseTeamsResponse). Fallback: teams.json ya escaneado.
//   Fase 2 (INTERPRETAR): una corrida SDK (haiku + effort low, 1 turno, CERO herramientas —
//     doble capa deniega TODO, regla 6) DEDUCE la persona REAL detrás de cada
//     mensaje del bot y la atribuye a un contacto conocido.
//     La fase 1 SÍ sigue en sonnet porque usa Graph.
//   Fase 3 (MERGE): agrupa por contacto real y FUSIONA con chatbot.json (append,
//     no destructivo — preserva el seed histórico).
//
// CONSUME TOKENS (Graph read + interpretación) ⇒ se lanza bajo botón.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../src/core/config.js';
import { settingSourcesFor } from '../src/core/sdk-settings.js';
import { runAdaptivePool } from '../src/modules/health/pool.js';
import { readContacts, readSelf, readTeams, readChatbot, writeChatbot } from '../src/modules/comms/shared.js';
import {
  graphReadAllowed, teamsBotPrompt, parseTeamsResponse, TEAMS_TIMEOUT_MS,
} from '../src/modules/comms/teams-shared.js';
import {
  relayBots, freshBotThread, chatbotInterpretPrompt, parseChatbotInterpretation, mergeChatbotThreads,
  writeChatbotLock, clearChatbotLock, readChatbotLock,
  CHATBOT_INTERPRET_TIMEOUT_MS, CHATBOT_HEARTBEAT_MS,
} from '../src/modules/comms/chatbot-shared.js';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, '[comms-chatbot]', ...a);

// Dedup pid-aware (patrón bugs/index.js:spawnTriage): el server RESERVA el lock
// con el pid de ESTE hijo antes de que bootee. Un lock fresco AJENO ⇒ ya hay otra
// corrida, salgo; si es MI propia reserva (pid propio) o está vencido, sigo.
const _resv = readChatbotLock();
if (_resv && _resv.pid !== process.pid) { log('ya hay otra corrida de chatbot (lock fresco ajeno): salgo.'); process.exit(0); }

const contacts = readContacts();
const self = readSelf();
const bots = relayBots(contacts);
let phase = 'leyendo';
const beat = () => writeChatbotLock({ pid: process.pid, phase });
beat();
const heartbeat = setInterval(beat, CHATBOT_HEARTBEAT_MS);
heartbeat.unref?.();
function finish(code) { clearInterval(heartbeat); clearChatbotLock(); process.exit(code); }

const denyRead = 'Chatbot fase 1: SOLO tools graph_*/teams_* de lectura.';
const denyReadHook = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyRead } };
const denyInterpret = 'La interpretación de chatbot no usa herramientas.';
const denyInterpretHook = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyInterpret } };

// ===== Fase 1: leer los mensajes crudos del bot vía Graph (read-only) =====
async function fetchBotRaw(bot) {
  let out = '';
  try {
    const q = query({
      prompt: teamsBotPrompt(bot, self),
      options: {
        cwd: config.projectDir,
        model: 'sonnet',
        maxTurns: 14,
        permissionMode: 'default',
        settingSources: settingSourcesFor('headless'),
        hooks: { PreToolUse: [{ hooks: [async (input) => (graphReadAllowed(input.tool_name) ? {} : denyReadHook)] }] },
        canUseTool: async (name, input) => (graphReadAllowed(name)
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: denyRead }),
      },
    });
    let timer = null;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), TEAMS_TIMEOUT_MS); });
    const pump = (async () => {
      for await (const m of q) {
        if (m.type === 'assistant') { for (const b of m.message?.content || []) if (b.type === 'text' && b.text) out += b.text; }
        else if (m.type === 'result') break;
      }
    })();
    pump.catch(() => {}); // si el timeout gana, pump queda pendiente y puede rechazar (q.close aborta) → evitar unhandledRejection (paridad send/analyze runners)
    try { await Promise.race([pump, timeout]); }
    finally { clearTimeout(timer); try { Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ } }
  } catch (err) {
    return { found: false, note: String(err?.message || err).slice(0, 160) };
  }
  return parseTeamsResponse(out, bot, self);
}

// ===== Fase 2: interpretar (CERO herramientas) =====
async function interpret(knownContacts, rawMessages) {
  const q = query({
    prompt: chatbotInterpretPrompt(knownContacts, rawMessages, self?.name),
    // Optimización IA 2026-08-27: haiku + effort low. Esta fase es 1 turno, CERO
    // herramientas y criterio 100% explícito en el prompt (lista cerrada de ids,
    // JSON fijo) — el mismo perfil que extractTitle/classifyRelative/judgeAnswer de
    // chat/index.js, ya validados en producción con haiku. Lo que el proyecto
    // documenta que haiku NO puede es la AUDITORÍA PROFUNDA de código (health), no
    // la atribución mecánica de texto corto.
    options: {
      cwd: process.cwd(),
      settingSources: [],
      model: 'haiku',
      effort: 'low',
      maxTurns: 1,
      permissionMode: 'default',
      hooks: { PreToolUse: [{ hooks: [async () => denyInterpretHook] }] },
      canUseTool: async () => ({ behavior: 'deny', message: denyInterpret }),
    },
  });
  let out = '';
  let timer = null;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('La interpretación tardó demasiado.')), CHATBOT_INTERPRET_TIMEOUT_MS); });
  const pump = (async () => {
    for await (const m of q) {
      if (m.type === 'assistant') { for (const b of m.message?.content || []) if (b.type === 'text' && b.text) out += `${b.text}\n`; }
      else if (m.type === 'result') break;
    }
  })();
  pump.catch(() => {});
  try { await Promise.race([pump, timeout]); }
  finally { clearTimeout(timer); try { await Promise.resolve(q.close?.()).catch(() => {}); } catch { /* noop */ } }
  return out;
}

async function run() {
  if (!bots.length) { log('no hay contactos bot (kind:\'bot\') para escanear.'); return; }

  // ---- Fase 1: juntar mensajes crudos + metadata (chatId/participantes) por bot.
  // PARALELO (regla de oro: paralelo lo que LEE, serial lo que ESCRIBE): cada
  // fetchBotRaw es una lectura Graph aislada (read-only, regla 6 doble capa).
  // runAdaptivePool (mismo de health F2.5, patrón teams/desk/triage) las corre a
  // la vez; los resultados llegan FUERA DE ORDEN, así que se guardan por índice y
  // la acumulación ordenada (raws/chatId/participants) queda SERIAL tras la
  // barrera — determinismo idéntico al for secuencial anterior. start:2 porque
  // cada query() consume tokens; hoy hay 1 bot pero el código ya es N.
  phase = 'leyendo'; beat();
  const raws = [];        // { from, sender, at, ts, text }
  let chatId = null;
  let participants = null;
  const teams = readTeams();
  const resByIdx = new Array(bots.length).fill(null);
  await runAdaptivePool(bots.map((bot, i) => ({ bot, i })), async ({ bot, i }, ctl) => {
    // REUSO (Optimización IA 2026-07-12): si /teams-refresh escaneó este bot hace
    // poco, usamos ese hilo directo (0 tokens) en vez de disparar otra corrida
    // Graph (sonnet ×14 turnos) que trae EXACTAMENTE lo mismo. Los botones
    // /teams-refresh y /chatbot-refresh no coordinaban caché — ahora sí.
    const cached = freshBotThread(bot, teams);
    if (cached) {
      log(`fase 1: ${bot.name} — reuso teams.json fresco (${cached.messages.length} msg, sin Graph).`);
      resByIdx[i] = { bot, thread: cached };
      beat();
      return;
    }
    log(`fase 1: leyendo el chat del bot ${bot.name} vía Graph…`);
    const rawRes = await fetchBotRaw(bot);
    // El backoff debe mirar el resultado real de Graph, antes de que el
    // fallback lo convierta en found:true o la rama sin datos haga return.
    if (!rawRes.found && /429|overload|rate.?limit/i.test(rawRes.note || '')) ctl.backoff();
    let res = rawRes;
    // Fallback: si Graph falla, usar lo que ya está en teams.json para ese bot.
    if (!res.found || !res.thread) {
      const t = (teams.threads || []).find((x) => x.contactId === bot.id);
      if (t && (t.messages || []).length) {
        log(`fase 1: Graph falló (${res.note || 'sin datos'}); uso teams.json (${t.messages.length} msg).`);
        res = { found: true, thread: t };
      } else {
        log(`fase 1: ${bot.name} sin mensajes (${res.note || 'no encontrado'}).`);
        return;
      }
    }
    resByIdx[i] = { bot, thread: res.thread };
    beat();
  }, { min: 1, start: 2 });
  // Acumulación SERIAL y determinística en el orden de la lista de bots.
  for (const r of resByIdx) {
    if (!r) continue;
    const th = r.thread;
    chatId = chatId || th.chatId || r.bot.chatId || null;
    participants = participants || (Array.isArray(th.participants) ? th.participants : null);
    for (const m of (th.messages || [])) {
      raws.push({ from: m.fromContact ? 'contact' : 'me', sender: m.author || '', at: '', ts: m.ts || 0, text: m.text || '' });
    }
  }
  if (!raws.length) { log('sin mensajes crudos del bot: nada que interpretar.'); return; }
  raws.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  // ---- Fase 2: interpretar y atribuir a la persona real.
  phase = 'interpretando'; beat();
  log(`fase 2: interpretando ${raws.length} mensaje(s) del bot con IA…`);
  const out = await interpret(contacts, raws);
  const knownIds = new Set(contacts.map((c) => c.id));
  const botFallbackId = bots[0]?.id || null;
  const fresh = parseChatbotInterpretation(out, raws, knownIds, {
    botFallbackId, chatId, participants, meName: self?.name,
  });
  if (!fresh.length) throw new Error('No se pudo interpretar la respuesta (sin atribuciones).');
  log(`fase 2: ${fresh.length} hilo(s) atribuido(s): ${fresh.map((t) => t.contactId).join(', ')}.`);

  // ---- Fase 3: merge NO destructivo con lo existente + escribir.
  phase = 'guardando'; beat();
  const prev = readChatbot();
  const merged = mergeChatbotThreads(prev.threads || [], fresh);
  writeChatbot({ threads: merged, scannedAt: Date.now(), error: null });
  log(`listo: ${merged.length} hilo(s) de chatbot (fusionado con lo previo).`);
}

log(`comms-chatbot arrancando (pid ${process.pid}, ${bots.length} bot(s))`);
run().then(() => finish(0)).catch((err) => {
  log('FALLÓ:', err?.message || err);
  const prev = readChatbot();
  writeChatbot({ threads: prev.threads || [], scannedAt: prev.scannedAt || null, error: String(err?.message || err).slice(0, 200) });
  finish(1);
});
