#!/usr/bin/env node
// bin/cwc-bus.js — CLI del "Interfono" entre sesiones (ver src/core/bus.js).
//
// Es la PUERTA ÚNICA que usan (a) los hooks de Claude Code instalados por
// bin/install-interfono.js y (b) el comando /btw. Todo el estado vive en
// archivos (~/.cwc-data/session-bus/), así que sobrevive reinicios del server.
//
// Subcomandos:
//   send <destino> <mensaje...>   una sesión manda un mensaje (lo usa /btw)
//   hook-inject                   hooks SessionStart/UserPromptSubmit: imprime
//                                 los mensajes/lápidas pendientes -> Claude los
//                                 inyecta como contexto en su próximo turno
//   hook-guard                    hook PreToolUse (Edit|Write|MultiEdit): frena
//                                 la edición si otra sesión VIVA reclama el
//                                 archivo (árbol zombi de core/bus.js)
//   hook-claim                    hook PostToolUse (Edit|Write): crea/renueva el
//                                 claim del archivo recién editado
//   hook-release                  hook SessionEnd: suelta todos los claims propios
//   list | directory | claims     inspección (debug / uso del server)
//
// Nunca romper la sesión de Claude: ante cualquier error los hooks salen 0
// (fail-open) — salvo hook-guard, que solo bloquea con evidencia positiva.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as bus from '../src/core/bus.js';

const __filename = fileURLToPath(import.meta.url);
const TMUX_SOCKET = process.env.CWC_TMUX_SOCKET?.trim() || 'cwc';
const cmd = process.argv[2] || 'help';

// ---- Lectura de stdin (los hooks reciben JSON de Claude Code) ----
function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}
function parseHookInput() {
  try { return JSON.parse(readStdin()); } catch { return {}; }
}

// ---- Identidad propia: handles del proceso actual ----
// $TMUX_PANE está seteado si corremos dentro de una tmux (TUI). Derivamos el
// nombre de sesión tmux — es la MISMA clave que usa el emisor al direccionar
// por nombre de tarjeta. Un chat del SDK no tiene $TMUX: solo el claude sid.
function currentTmuxSession() {
  if (!process.env.TMUX) return null;
  try {
    const name = execFileSync('tmux', ['display-message', '-p', '#{session_name}'],
      { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return name || null;
  } catch { return null; }
}
function selfIdentity(input) {
  const claudeSid = input?.session_id || null;
  const tmuxName = currentTmuxSession();
  const handles = [];
  if (claudeSid) handles.push(`claude:${claudeSid}`);
  if (tmuxName) handles.push(`tmux:${tmuxName}`);
  // Nombre amigable propio (para el "from" de los mensajes).
  let name = null;
  const dir = bus.buildDirectory();
  const mine = dir.find((e) => handles.includes(e.handle));
  if (mine) name = mine.name;
  const kind = mine ? mine.kind : (tmuxName ? 'tui' : (claudeSid ? 'chat' : 'desconocida'));
  return { claudeSid, tmuxName, handles, name: name || tmuxName || 'una sesión', kind, primary: handles[0] || null };
}

function done(code = 0) { try { bus.gc(); } catch { /* noop */ } process.exit(code); }

// ================= SEND =================
function doSend() {
  // Todo lo que sigue al subcomando; /btw pasa "$ARGUMENTS" tal cual. Aceptamos
  // "--" como separador opcional. Primer token = destino, resto = mensaje.
  let args = process.argv.slice(3);
  if (args[0] === '--') args = args.slice(1);
  const raw = args.join(' ').trim();
  const m = raw.match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) {
    console.log('Uso: /btw <sesión|all> <mensaje>. Sesiones disponibles: ' +
      (bus.buildDirectory().map((e) => e.name).join(', ') || '(ninguna)'));
    return done(0);
  }
  const [, targetArg, text] = m;
  const target = bus.resolveTarget(targetArg);
  if (target.error) { console.log('⚠ ' + target.error); return done(0); }

  const self = selfIdentity(parseHookInputSafe());
  const msg = bus.sendMessage({
    from: self.primary, fromName: self.name,
    to: target.handle, toName: target.name, text,
  });

  // Nudge SEGURO: si el destino es UNA TUI con Claude idle (el observador dice
  // waiting + modelo presente + ts fresco) y su tmux existe, le tecleamos un
  // aviso corto por send-keys para que lo vea YA. Si está trabajando o es un
  // shell, NO tocamos su input: el mensaje espera en la bandeja (hook-inject).
  let nudged = false;
  if (target.entry && target.entry.kind === 'tui') {
    nudged = tryNudge(target.entry, self, text);
  }
  const via = nudged ? 'entregado en vivo' : 'quedó en la bandeja (lo verá en su próximo turno)';
  console.log(`✅ Mensaje para ${target.name}: ${via}. [id ${msg.id}]`);
  return done(0);
}

function parseHookInputSafe() {
  // send se invoca desde una Bash tool: normalmente NO hay JSON en stdin. Pero
  // si lo hubiera (llamada programática), lo aprovechamos para el claude sid.
  if (process.stdin.isTTY) return {};
  try { const s = fs.readFileSync(0, 'utf8'); return s ? JSON.parse(s) : {}; } catch { return {}; }
}

// send-keys de aviso a una TUI idle. Devuelve true si nudgeó.
function tryNudge(entry, self, text) {
  try {
    const obs = entry.claudeSid ? bus.readObserver(entry.claudeSid) : findObserverByTmux(entry.tmux);
    if (!obs || obs.status !== 'waiting' || !obs.model) return false;
    if (Date.now() - (obs.ts || 0) > 10 * 60 * 1000) return false; // no idle-fresh
    if (!bus.tmuxHasSession(entry.tmux)) return false;
    const socket = tmuxSocketPath();
    const short = String(text).replace(/\s+/g, ' ').slice(0, 200);
    const line = `[Interfono · mensaje de ${self.name}] ${short}  (para responder: /btw ${self.name} <respuesta>)`;
    // -l = literal (no interpreta el texto como nombres de tecla). Enter aparte.
    execFileSync('tmux', ['-S', socket, 'send-keys', '-t', `=${entry.tmux}`, '-l', line],
      { stdio: 'ignore', env: cleanEnv() });
    execFileSync('tmux', ['-S', socket, 'send-keys', '-t', `=${entry.tmux}`, 'Enter'],
      { stdio: 'ignore', env: cleanEnv() });
    return true;
  } catch { return false; }
}
function findObserverByTmux() { return null; } // TUIs sin claude sid: sin nudge (seguro)
function tmuxSocketPath() {
  return path.join(os.tmpdir(), `tmux-${os.userInfo().uid}`, TMUX_SOCKET);
}
function cleanEnv() { const e = { ...process.env }; delete e.TMUX; delete e.TMUX_PANE; return e; }

// ================= HOOK: inject (SessionStart / UserPromptSubmit) =================
function doInject() {
  const input = parseHookInput();
  const self = selfIdentity(input);
  if (!self.handles.length) return done(0);

  const msgs = bus.pendingFor(self.handles);
  const tombs = bus.tombstonesFor(self.handles);
  if (!msgs.length && !tombs.length) return done(0);

  const lines = [];
  lines.push('📨 INTERFONO — mensajes de otras sesiones de Claude Code:');
  for (const t of tombs) {
    lines.push(`  ⚠️ Tu reserva sobre ${t.file} fue liberada por inactividad; ${t.byName} la está editando. Releé ese archivo antes de tocarlo.`);
  }
  for (const m of msgs) {
    const when = new Date(m.ts).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    lines.push(`  • [${when}] ${m.fromName}: ${m.text}`);
  }
  if (msgs.length) {
    lines.push('Si alguno requiere respuesta, contestá UNA vez con: node ' +
      __filename + ' send "<nombre-de-la-sesión>" "<respuesta>"  (no encadenes respuestas innecesarias).');
  }
  console.log(lines.join('\n'));

  bus.markDelivered(msgs, self.handles);
  bus.markTombstonesDelivered(tombs);
  return done(0);
}

// ================= HOOK: guard (PreToolUse Edit|Write|MultiEdit) =================
function doGuard() {
  const input = parseHookInput();
  const absPath = input?.tool_input?.file_path;
  if (!absPath) return done(0); // no hay archivo => nada que reservar
  const self = selfIdentity(input);
  const claim = bus.getClaim(absPath);

  // Sin claim, o claim propio => adelante (hook-claim lo (re)creará luego).
  if (!claim || self.handles.includes(claim.handle)) return done(0);

  const verdict = bus.evaluateClaim(claim);

  if (bus.blocks(verdict.state)) {
    // BLOQUEO: exit 2 + stderr => Claude Code frena la herramienta y ve el motivo.
    process.stderr.write(
      `⛔ INTERFONO: otra sesión (${claim.name}) está trabajando en ${absPath} — ${verdict.reason}.\n` +
      `Coordiná antes de editar: node ${__filename} send "${claim.name}" "¿puedo editar ${absPath}?"  ` +
      `o esperá a que libere. (Si estás seguro de que es un error, reintentá en unos minutos.)\n`);
    return done(2);
  }

  if (verdict.state === 'gray') {
    // SOFT: se permite, pero se avisa a la (posible) dueña inactiva.
    bus.sendMessage({
      from: self.primary, fromName: self.name, to: claim.handle, toName: claim.name,
      text: `Heads-up: edité ${absPath}, que figurabas reservando pero estabas inactiva. Reléelo antes de seguir.`,
      kind: 'heads-up',
    });
    // (hook-claim tomará el claim a nombre propio tras la edición.)
    return done(0);
  }

  // ROBABLE (zombie/stale): tomamos el claim y dejamos lápida para el zombi.
  if (bus.stealable(verdict.state)) {
    bus.tombstone({ file: absPath, formerHandle: claim.handle, byHandle: self.primary, byName: self.name });
    // El claim propio se escribirá en hook-claim (PostToolUse). Acá solo liberamos.
    bus.releaseFile(absPath, [claim.handle]);
    return done(0);
  }
  return done(0);
}

// ================= HOOK: claim (PostToolUse Edit|Write) =================
function doClaim() {
  const input = parseHookInput();
  const absPath = input?.tool_input?.file_path;
  if (!absPath) return done(0);
  const self = selfIdentity(input);
  if (!self.primary) return done(0);
  bus.claimFile({
    absPath, handle: self.primary, claudeSid: self.claudeSid,
    name: self.name, kind: self.kind, tmux: self.tmuxName,
  });
  return done(0);
}

// ================= HOOK: release (SessionEnd) =================
function doRelease() {
  const input = parseHookInput();
  const self = selfIdentity(input);
  if (self.handles.length) bus.releaseAll(self.handles);
  return done(0);
}

// ================= Inspección =================
function doList() {
  console.log(JSON.stringify({
    directory: bus.buildDirectory(),
    messages: bus.allMessages(),
    claims: bus.allClaims().map((c) => ({ ...c, verdict: bus.evaluateClaim(c) })),
  }, null, 2));
  return done(0);
}

switch (cmd) {
  case 'send': doSend(); break;
  case 'hook-inject': doInject(); break;
  case 'hook-guard': doGuard(); break;
  case 'hook-claim': doClaim(); break;
  case 'hook-release': doRelease(); break;
  case 'list': case 'directory': case 'claims': doList(); break;
  default:
    console.log('cwc-bus: send | hook-inject | hook-guard | hook-claim | hook-release | list');
    done(0);
}
