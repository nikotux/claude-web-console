#!/usr/bin/env node
// bin/cwc-attach.js — COPIA un archivo de disco (de cualquier fuente externa) al
// ESCRITORIO DE TRABAJO de una conversación de chat: la carpeta
// ~/.cwc-data/chat-attachments/<chatId>/ que abre "Abrir carpeta de este chat"
// del menú de Sesiones (PLAN-447 · pedido de Niko 2026-07-14).
//
// El asistente lo invoca al TRAER un archivo trabajable a la conversación —
// venga de WhatsApp (comms/whatsapp-media/<jid>/<file>, ya descargado por el
// daemon), de Outlook/Teams (graph_save_attachment lo dejó en disco), o de donde
// sea. Así TODOS los archivos de trabajo quedan en un solo lugar, listos para
// manipular, y VIAJAN con el paquete-sesión al cambiar de mundo (chat-attachments
// no está anidado por mundo; el handoff conserva el mismo chatId).
//
// Es DETERMINÍSTICO y NO consume tokens: reusa materializeIntoChat() de
// chat/attachments.js (filtro trabajable + nombre saneado/único + confinamiento
// a la carpeta, defensa anti-traversal). Los temporales/distractores se filtran.
//
// Uso:  node bin/cwc-attach.js <chatId> <ruta-absoluta-del-archivo> ["nombre legible"]
import { materializeIntoChat, attachRelForExplorer } from '../src/modules/chat/attachments.js';

const chatId = process.argv[2];
const srcPath = process.argv[3];
const label = process.argv.slice(4).join(' ').trim() || undefined;

if (!chatId || !srcPath) {
  console.error('Uso: cwc-attach.js <chatId> <rutaAbsoluta> ["nombre legible"]');
  process.exit(2);
}

const r = materializeIntoChat(chatId, srcPath, { label });
if (r.ok) {
  console.log(`OK: «${r.name}» copiado al escritorio del chat (~/${attachRelForExplorer(chatId)}/${r.name}).`);
  process.exit(0);
}
console.error(`No se copió (${r.reason}${r.name ? `: ${r.name}` : ''}).`);
// 3 = filtrado por no-trabajable (esperable, no un error del flujo); 1 = fallo real.
process.exit(r.reason === 'no-trabajable' ? 3 : 1);
