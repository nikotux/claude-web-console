#!/usr/bin/env node
// bin/cwc-bugfix-link.js — vincula un PR YA existente de GitHub a un registro
// del tablero Bugs & Features (bugfixes.json).
//
// Es la pata de PREVENCIÓN del bug "el tablero no se entera del trabajo hecho
// en los chats" (2026-07-05, caso FEAT-2/PR #249; patrón Desk #519/PR #232):
// cuando una sesión crea/actualiza un PR por FUERA del módulo "Enviar PR"
// (la excepción autorizada del contexto de trabajo), DEBE correr esto en el
// MISMO turno del push — así el tablero nunca queda huérfano. La otra pata
// (detección) es la reconciliación automática de refresh-prs.
//
// DETERMINÍSTICO y 0 tokens (patrón cwc-health-resolve): un gh pr view
// (solo LECTURA de GitHub) + escritura de bugfixes.json con la MISMA lógica
// del endpoint POST /api/bugfixes/link-pr (link-shared.js). No toca código,
// no pushea nada, no reinicia nada.
//
// Uso:  node bin/cwc-bugfix-link.js <TKT-n|FEAT-n|sessionId> <nroPR>
//   p.ej.  node bin/cwc-bugfix-link.js FEAT-2 249
//          node bin/cwc-bugfix-link.js 519 232
//
// OJO: NO importa core/config.js (exige CWC_TOKEN y hace exit si el .env no
// está en el cwd — este CLI corre desde cualquier lado, típicamente ~/tolkien).
// Carga el .env del proyecto por ruta explícita y cae a ~/tolkien.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { linkPrToRegistry } from '../src/modules/bugfixes/link-shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });
const projectDir = path.resolve(process.env.CWC_PROJECT_DIR?.trim() || path.join(os.homedir(), 'tolkien'));

const [item, prArg] = process.argv.slice(2);
const prNumber = Number(prArg);
if (!item || !Number.isInteger(prNumber) || prNumber <= 0) {
  console.error('Uso: cwc-bugfix-link.js <TKT-n|FEAT-n|sessionId> <nroPR>');
  process.exit(2);
}

try {
  const bySession = /^[0-9a-f-]{32,}$/i.test(item);
  const entry = await linkPrToRegistry({
    ...(bySession
      ? { sessionId: item }
      : { ticket: item.replace(/^(?:TKT\s*#?|#)/i, '').trim() }),
    prNumber,
    projectDir,
    mode: 'chat',
  });
  console.log(`✅ ${entry.ticketNumber || entry.sessionId} vinculado al PR #${entry.prNumber} (${entry.prState}). El tablero ya lo refleja.`);
} catch (err) {
  console.error(`❌ No se pudo vincular: ${String(err?.message || err)}`);
  process.exit(1);
}
