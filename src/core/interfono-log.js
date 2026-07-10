// core/interfono-log.js — bitácora de ENTREGA del Interfono (rediseño 2026-07-10).
//
// Registro append-only (JSONL) de CADA vez que un mensaje del interfono se
// entrega/muestra/expira, para: (a) medir el ruido antes/después del rediseño
// (baseline de la Fase 0), y (b) materializar R6 ("nada se pierde en silencio"):
// todo pendiente deja rastro consultable, aunque no dispare ningún popup.
//
// Es 100% fail-open: un fallo del log JAMÁS corta un hook, un watcher ni un
// turno (patrón appendCapped de core/model-router.js). Estado en archivos, en
// el MISMO árbol del bus (~/.cwc-data/session-bus/) => cumple R4 (sobrevive
// reinicios). Poda cruda a la mitad pasado ~2 MB, idéntica a model-router-log.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const LOG_FILE = path.join(config.home, '.cwc-data', 'session-bus', 'delivery-log.jsonl');
const LOG_MAX_BYTES = 2 * 1024 * 1024; // tope crudo — ver poda

// Rutas por las que un mensaje llega (o no) al humano. Enum cerrado.
//   auto-deliver  — watcher server-side inyectó el mensaje a un chat abierto+ocioso
//   tui-nudge     — send-keys a una TUI idle
//   hook-inject   — el hook UserPromptSubmit/SessionStart imprimió pendientes
//   badge         — se surfaceó como señal pasiva en la tarjeta de Sesiones
//   popup-shown   — (legado F1/F2) se mostró una tarjeta modal
//   popup-resume  — el humano tocó "Entregar/Retomar"
//   popup-dismiss — el humano tocó "Archivar/Descartar"
//   expired       — el mensaje venció por TTL sin ser atendido
export const ROUTES = [
  'auto-deliver', 'tui-nudge', 'hook-inject', 'badge',
  'popup-shown', 'popup-resume', 'popup-dismiss', 'expired',
];

function appendCapped(obj) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOG_FILE, `${JSON.stringify({ ts: Date.now(), ...obj })}\n`, { mode: 0o600 });
    const size = fs.statSync(LOG_FILE).size;
    if (size > LOG_MAX_BYTES) {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
      const kept = lines.slice(-Math.floor(lines.length / 2));
      fs.writeFileSync(LOG_FILE, `${kept.join('\n')}\n`, { mode: 0o600 });
    }
  } catch { /* best-effort: la bitácora nunca rompe nada */ }
}

// Registra un evento de entrega. `event`:
//   { route, msgId?, from?, to?, kind?, level?, chatId?, windowsOpen?, detail? }
export function logDelivery(event) {
  if (!event || !ROUTES.includes(event.route)) return; // route inválido => no ensucia
  appendCapped(event);
}

// Últimos N eventos (para la vista "Bitácora" del panel Interfono). Solo lee.
export function readDeliveries(limit = 100) {
  let lines;
  try { lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean); }
  catch { return []; }
  const n = Math.max(1, Math.min(1000, Number(limit) || 100));
  const out = [];
  for (const l of lines.slice(-n)) {
    try { out.push(JSON.parse(l)); } catch { /* línea corrupta: se saltea */ }
  }
  return out.reverse(); // más reciente primero
}

export const paths = { LOG_FILE };
