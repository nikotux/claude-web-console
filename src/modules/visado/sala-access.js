// Acceso compartido a salas para visado y puertas interactivas de Tolkien.
// Este módulo depende del singleton del chat, pero nunca de tolkien/index.js:
// así ambos consumidores ven el mismo manager sin formar un ciclo de imports.
import { manager } from '../chat/index.js';
import { safeSalaId } from '../chat/aduana.js';

export function salaChat(salaId) {
  try { safeSalaId(salaId); } catch { return null; }
  for (const chat of manager.chats.values()) {
    try {
      if (chat.isSala() && chat._salaId() === salaId) return chat;
    } catch { /* un chat a medio construir no rompe la búsqueda */ }
  }
  return null;
}

export function salaVisiblePara(salaId, user) {
  const chat = salaChat(salaId);
  if (!chat) return null;
  try {
    return chat.isParticipant(user) ? chat : null;
  } catch {
    return null;
  }
}
