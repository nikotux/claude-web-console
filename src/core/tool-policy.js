// core/tool-policy.js — NÚCLEO de gobernanza de permisos del chat interactivo.
//
// NO es un motor: es plomería IN-PROCESS (como sdk-settings.js / paths.js). El
// estado del modo lo PERSISTE el server (Chat.permissionMode → chats.json) y lo
// APLICA en vivo el chat-runner (que ya es un motor). Acá viven SOLO las REGLAS,
// como FUENTE ÚNICA — así el bug del flag de bypass (abajo) no puede recurrir.
//
// Modos (PERMISSION_MODES): 'default' (pregunta) · 'acceptEdits' (auto-acepta
// ediciones) · 'bypassPermissions' ("Todo": acepta TODO sin canUseTool) ·
// 'plan' (sin ejecución). Deliberado que "Todo" exista SOLO en chats
// interactivos — las corridas headless (tickets/salud) siguen blindadas
// read-only con sus PROPIAS allowlists (regla dura 6): ESO no pasa por acá.
//
// SOBRE EL FLAG `allowDangerouslySkipPermissions` (verificado empíricamente
// 2026-07-06, SDK 0.3.198): el .d.ts dice "Must be set to `true` when using
// permissionMode 'bypassPermissions'", así que lo pasamos SIEMPRE por contrato
// (es INERTE salvo en 'bypassPermissions'). PERO el test A/B mostró que en esta
// versión el bypass YA auto-aprueba y "shadowea" canUseTool SIN el flag — o sea
// el flag NO era la causa de "elegí Todo y me sigue preguntando". La causa REAL
// es que el modo no siempre LLEGA/aplica en el runner (drift: runner viejo,
// setPermissionMode que falla y se traga el error, o la tarjeta ya emitida que
// no se auto-resuelve al cambiar). Eso se arregla en el runner (set_mode robusto
// + approveAllPending) — este núcleo aporta la fuente única de opciones/flag.
// OJO adicional: las ALLOW-RULES del ~/.claude/settings.json del usuario también
// "shadowean" canUseTool (pre-aprueban tools antes del callback), así que en modo
// 'default' algunas acciones NO piden permiso — eso es la allowlist del usuario,
// no un bug de la consola.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settingSourcesFor } from './sdk-settings.js';
import { chatAttachDir } from '../modules/chat/attachments.js';

// Raíz del repo de la CONSOLA (este archivo vive en src/core/ → ../.. = raíz).
// Se usa para decidir si un chat trabaja en el MUNDO INTERNO (Mi Consola) y por
// ende debe recibir el recordatorio de bootstrap de Pad local (workspace
// `console`). Los chats de Tolkien (mundo externo) NO lo reciben — regla dura 12.
const CONSOLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function isConsoleCwd(cwd) {
  if (!cwd) return false;
  const c = path.resolve(cwd);
  return c === CONSOLE_ROOT || c.startsWith(CONSOLE_ROOT + path.sep);
}

// BOOTSTRAP DE PAD para chats de Consola (Gap #1, ROAD-63/TASK-295). Recordatorio
// que se AGREGA (append) al system prompt NATIVO de Claude Code — nunca lo
// reemplaza — SOLO en chats cuyo cwd está dentro del repo de la consola. Hace que
// el chat cargue el contexto de Pad local y modele el trabajo como TASK/PLAN, en
// vez de depender de que el modelo recuerde CLAUDE.md. NO es un hook global
// (eso alcanzaría a las sesiones de Tolkien = otro mundo/workspace, regla 12).
export const CONSOLE_PAD_BOOTSTRAP = [
  'CONTEXTO DE MI CONSOLA — Pad LOCAL (workspace `console`).',
  'Antes de trabajo NO trivial en este repo, cargá el estado del proyecto en Pad: `pad_set_workspace console` (o `pad_meta action=bootstrap workspace=console`) y revisá `pad_project action=dashboard`/`next` para no duplicar trabajo en curso.',
  'Registrá lo que hagas en Pad: bug real → item BUG; trabajo de entidad (feature/migración/fase) → TASK/PLAN; decisión de arquitectura → `pad_item action=decide` con rationale. Los playbooks `module-scan`/`codex-verify` son procedimientos invocables cuando calcen.',
  'El server MCP `pad` es el LOCAL (workspace `console`); `pad-cloud-backup` es solo respaldo, nunca operativo. La fuente de verdad de las reglas duras es el CLAUDE.md del repo.',
  'Regla dura #12 (anti-colisión entre mundos): los dos mundos NUNCA se enlazan EN VIVO — 🏠 interno = Mi Consola + Pad `console` · 🌳 externo = Tolkien + Pad `tolkien`. Todo se resuelve PRIMERO y por completo acá; el ÚLTIMO paso es crear un PLAN NUEVO (plan-puente) para inyectar en Tolkien. Nunca al revés, nunca un sync/MCP vivo cruzando los dos Pad.',
  'Al crear ítems en Pad, enlazalos a su "sol" (root real: un PLAN es sol de sus tareas, una RED de sus miembros) con parent/link y cross-linkeá entre sistemas; nunca dejes ítems flotando ni crees hubs sintéticos en colecciones de módulos vivos (pendientes/planes, temas/rutas, mejora-continua, contexto-de-tickets).',
].join('\n');

// REGLA DE CARPETA DE TRABAJO DEL PAQUETE-SESIÓN (PLAN-447 · pedido de Niko
// 2026-07-14). Se AGREGA (append) al system prompt de TODO chat (cualquier mundo,
// no solo Consola): le dice al modelo cuál es la carpeta propia de ESTA sesión —
// la que abre "Abrir carpeta de este chat" — y la disciplina: copiar ahí TODO
// archivo trabajable que traiga de una fuente externa (WhatsApp/Outlook/etc.),
// nunca los temporales, con el CLI determinístico bin/cwc-attach.js. Así el
// escritorio del paquete-sesión queda completo y VIAJA con él al cambiar de mundo.
// No cruza mundos (Regla 12): habla solo de la carpeta de runtime propia de la
// consola, indexada por chatId, no de recursos de otro mundo. Devuelve '' si el
// chatId no es válido (compone sin romper).
function sessionFolderRule(chatId) {
  const dir = chatAttachDir(chatId);
  if (!dir) return '';
  return [
    'CARPETA DE TRABAJO DE ESTA SESIÓN (escritorio del paquete-sesión).',
    `Esta conversación tiene una carpeta propia: ${dir}`,
    'Es la que abre "Abrir carpeta de este chat" en el menú de Sesiones y VIAJA con el paquete-sesión al cambiar de mundo.',
    `REGLA: cuando descargues o traigas a la conversación un archivo TRABAJABLE de CUALQUIER fuente externa (adjunto de WhatsApp ya en disco, de Outlook/Teams, un documento, factura o informe) —porque el usuario lo pidió o porque es un entregable real— COPIALO a esa carpeta con: node ${CONSOLE_ROOT}/bin/cwc-attach.js ${chatId} <ruta-absoluta-del-archivo> ["nombre legible"]`,
    'NO copies temporales ni distractores (descargas parciales, .tmp, QR de emparejamiento, scratch, algo que solo ojeás y no es entregable). Así todo el material de trabajo queda en un solo lugar, listo para manipular, y persiste con el paquete.',
  ].join('\n');
}

// MODO TÁNDEM (PLAN-507): instrucción que se AGREGA al system prompt cuando la
// conversación corre el modelo Tándem. Claude razona/planea pero NO edita código
// (el runner le deniega Edit/Write); su único brazo de ejecución es la tool
// `delegate_to_codex`. El bloqueo estructural (deny) es el que GARANTIZA el split;
// esta instrucción evita que Claude gaste turnos intentando editar.
export const TANDEM_INSTRUCTION = [
  'MODO TÁNDEM — vos (Claude) RAZONÁS, PLANEÁS y VERIFICÁS; la EJECUCIÓN de código la hace CODEX.',
  'En este modo NO tenés herramientas de edición: Edit/Write/MultiEdit/NotebookEdit están DESHABILITADAS a propósito. Para CUALQUIER cambio de código llamá la herramienta `delegate_to_codex` con un plan CONCRETO (archivos, cambios exactos, criterios de aceptación).',
  'Codex implementa y te devuelve el diff. Vos lo VERIFICÁS (leé el diff; usá Bash para node --check / tests si hace falta) y, si algo está mal, volvés a llamar a `delegate_to_codex` con las correcciones.',
  'Bash es SOLO para inspección y verificación (leer, correr checks/tests), NUNCA para escribir archivos — todo cambio pasa por Codex.',
].join('\n');

// Nombre completo (namespaced) de la tool del servidor MCP in-process de Codex.
export const TANDEM_TOOL = 'mcp__codex__delegate_to_codex';

export const TANDEM_BLOCKED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Un destino en /tmp NO es código del proyecto: escribir un script descartable
// ahí no esquiva a Codex (que es lo que el guard protege). Exigimos ruta
// ABSOLUTA bajo /tmp/ y sin '..' para que no se pueda salir por traversal.
function isScratchTarget(dest) {
  if (typeof dest !== 'string') return false;
  if (!dest.startsWith('/tmp/')) return false;
  if (dest.includes('..')) return false;
  return dest.length > '/tmp/'.length;
}

function shellOutsideQuotes(cmd) {
  let out = '';
  let quote = null;
  let escaped = false;
  for (const ch of String(cmd || '')) {
    if (escaped) { out += quote ? ' ' : ch; escaped = false; continue; }
    if (ch === '\\') { out += quote ? ' ' : ch; escaped = true; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      out += ' ';
      continue;
    }
    if (ch === '\'' || ch === '"') { quote = ch; out += ' '; continue; }
    out += ch;
  }
  return out;
}

// Heurística conservadora para Tándem: Bash se permite para inspección y checks,
// pero no para escribir archivos. Evaluamos la línea completa (también comandos
// encadenados con &&, ; o |) y marcamos patrones típicos de escritura.
export function isWritingBashCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return false;
  const raw = cmd;
  const outside = shellOutsideQuotes(raw).replace(/\s+/g, ' ');

  // Redirecciones de escritura: >, >> y &> hacia destinos reales. Ignoramos
  // duplicación de fd (2>&1), sinks explícitos de salida/errores y scratch /tmp.
  const redirRe = /(?:^|[\s;&|])(?:\d*)?(>>?|&>)\s*([^\s;&|]+)/g;
  for (const m of outside.matchAll(redirRe)) {
    const dest = (m[2] || '').replace(/^['"]|['"]$/g, '');
    if (!dest || /^&\d+$/.test(dest)) continue;
    if (['/dev/null', '/dev/stderr', '/dev/stdout'].includes(dest)) continue;
    if (isScratchTarget(dest)) continue;
    return true;
  }

  const writingPatterns = [
    /(?:^|[\s;&|])tee(?:\s|$)/,
    /(?:^|[\s;&|])sed\s+(?:[^\s;&|]*\s+)*--in-place(?:[=\s]|$)/,
    /(?:^|[\s;&|])sed\s+(?:[^\s;&|]*\s+)*-[A-Za-z]*i[A-Za-z]*(?:\s|$)/,
    /(?:^|[\s;&|])perl\s+(?:[^\s;&|]*\s+)*-[A-Za-z]*i[A-Za-z]*(?:\s|$)/,
    /(?:^|[\s;&|])patch(?:\s|$)/,
    /(?:^|[\s;&|])git\s+apply(?:\s|$)/,
    /(?:^|[\s;&|])git\s+checkout\s+--(?:\s|$)/,
    /(?:^|[\s;&|])dd\s+(?:[^\s;&|]+\s+)*of=/,
    /(?:^|[\s;&|])truncate(?:\s|$)/,
    /(?:^|[\s;&|])install\s+-/,
    /(?:^|[\s;&|])mv(?:\s|$)/,
    /(?:^|[\s;&|])cp(?:\s|$)/,
    /(?:^|[\s;&|])rm(?:\s|$)/,
    /(?:^|[\s;&|])mkdir(?:\s|$)/,
    /(?:^|[\s;&|])touch(?:\s|$)/,
    /(?:^|[\s;&|])chmod(?:\s|$)/,
    /(?:^|[\s;&|])ln\s+-s(?:\s|$)/,
  ];
  if (writingPatterns.some((re) => re.test(outside))) return true;

  // Inline scripting: solo bloqueamos python -c / node -e si el código contiene
  // APIs obvias de escritura.
  if (/(?:^|[\s;&|])(?:python(?:3)?|node)\s+(?:[^\s;&|]+\s+)*-(?:c|e)(?:\s|=)/.test(outside)
    && /\b(?:open\s*\(|writeFile\s*\(|writeFileSync\s*\(|appendFile\s*\()/.test(raw)) {
    return true;
  }

  return false;
}

export function tandemPreToolUseHook() {
  const deny = (permissionDecisionReason) => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason,
    },
  });
  return {
    PreToolUse: [{
      hooks: [async (input) => {
        if (TANDEM_BLOCKED_TOOLS.has(input.tool_name)) {
          return deny('Modo Tándem: Claude no edita archivos. Usá delegate_to_codex con un plan concreto para que Codex haga el cambio.');
        }
        if (input.tool_name === 'Bash' && isWritingBashCommand(input.tool_input?.command || '')) {
          return deny('Modo Tándem: Bash es solo para inspección y verificación (leer, node --check, tests). Para escribir archivos usá delegate_to_codex.');
        }
        return {};
      }],
    }],
  };
}

// FUENTE ÚNICA de los modos válidos del chat (shared.js la re-exporta para no
// romper a sus importadores; server y runner validan contra este mismo Set).
export const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan']);

// ¿El modo necesita el flag "peligroso" del SDK para activarse?
export function requiresDangerousSkip(mode) { return mode === 'bypassPermissions'; }

// Normaliza un modo arbitrario (del cliente / disco) a uno válido.
export function normalizeMode(mode) { return PERMISSION_MODES.has(mode) ? mode : 'default'; }

// ¿Este modo auto-aprueba TODA solicitud sin preguntar? (lo usa el runner para
// resolver al instante las tarjetas que quedaron pendientes al pasar a "Todo").
export function autoApprovesAll(mode) { return mode === 'bypassPermissions'; }

// Opciones de query() del chat interactivo — FUENTE ÚNICA (la usan el runner al
// spawnear el motor). El flag va SIEMPRE: debe estar presente en la CREACIÓN de
// query() para que un cambio a "Todo" (al arranque o en vivo con
// setPermissionMode) pueda activarse; es inerte en default/acceptEdits/plan.
export function chatQueryOptions({ cwd, model, resume, sessionId, mode, effort, canUseTool, chatId, tandem, mcpServers, hooks }) {
  // Append al system prompt (preset claude_code = PRESERVA el prompt nativo,
  // nunca lo reemplaza): (1) la regla de carpeta de trabajo del paquete-sesión
  // para TODO chat, (2) el bootstrap de Pad SOLO para chats del mundo interno
  // (repo de la consola) — Tolkien no lo recibe (regla 12), (3) la instrucción
  // de TÁNDEM si la conversación corre ese modelo (delegar ejecución a Codex).
  const appends = [];
  const folderRule = sessionFolderRule(chatId);
  if (folderRule) appends.push(folderRule);
  if (isConsoleCwd(cwd)) appends.push(CONSOLE_PAD_BOOTSTRAP);
  if (tandem) appends.push(TANDEM_INSTRUCTION);
  const appendText = appends.join('\n\n');
  return {
    cwd,
    ...(model ? { model } : {}),
    // BUG-496: EXACTAMENTE uno. `sessionId` CREA la conversación con NUESTRO UUID
    // (chat nuevo, durable desde el segundo cero); `resume` RETOMA una existente.
    // El SDK prohíbe combinarlos sin forkSession, así que sessionId tiene prioridad
    // y excluye resume (el server manda solo uno — ver Chat._startEngine).
    ...(sessionId ? { sessionId } : (resume ? { resume } : {})),
    // Eje thinking effort (PEND-391 #3): `effort` es opción de query() del Agent
    // SDK (low|medium|high|xhigh|max) que guía la profundidad de razonamiento
    // JUNTO al modelo — una palanca MÁS BARATA que saltar de tier. El SDK lo
    // manda como output_config.effort; un modelo sin soporte lo degrada solo.
    // NO hay control en vivo (q.setEffort no existe): se fija al spawnear.
    ...(effort ? { effort } : {}),
    permissionMode: normalizeMode(mode),
    // Habilita que el modo "Todo" realmente saltee permisos. Requisito del SDK.
    allowDangerouslySkipPermissions: true,
    // Append compuesto (regla de carpeta de sesión + bootstrap de Pad si aplica).
    // preset claude_code PRESERVA el prompt nativo — un string pelado lo
    // REEMPLAZARÍA. Sin nada que agregar, no se toca el system prompt.
    ...(appendText
      ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: appendText } }
      : {}),
    includePartialMessages: true,
    // Fase 8: skills + comandos slash + CLAUDE.md del usuario y del proyecto del
    // cwd (fuente única en core/sdk-settings.js) + invocación autónoma de skills.
    settingSources: settingSourcesFor('chat'),
    // OJO (verificado E2E 2026-07-15): un nombre en `allowedTools` AUTO-APRUEBA
    // esa tool ANTES de canUseTool (warning CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). Por
    // eso NO metemos la tool de Codex acá — así la delegación cae en canUseTool y
    // sale la TARJETA DE PERMISO (Niko aprueba cada delegación; en modo "Todo" se
    // auto-aprueba como cualquier tool). La tool sigue DISPONIBLE vía mcpServers +
    // alwaysLoad:true (availability), independiente de allowedTools (auto-approve).
    allowedTools: ['Skill'],
    // Servidores MCP in-process (solo Tándem hoy: { codex: <sdk server> }).
    ...(mcpServers ? { mcpServers } : {}),
    ...(hooks ? { hooks } : {}),
    canUseTool,
  };
}
