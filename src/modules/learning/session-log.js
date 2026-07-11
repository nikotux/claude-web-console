// modules/learning/session-log.js — registro DURABLE de los sessionIds de las
// corridas del MÓDULO DE APRENDIZAJE (explain/context/analyze), para el filtro
// "Aprendizaje" del panel de Uso.
//
// POR QUÉ EXISTE: las corridas de aprendizaje usan el SDK con cwd = la consola
// (o Tolkien), así que su transcript cae en el MISMO directorio ~/.claude/
// projects/-home-...-claude-web-console/ que un chat normal — projectOf() (módulo
// tokens) no puede distinguirlas por el directorio. La ÚNICA señal determinística
// es el session_id que el SDK emite en el mensaje system/init del stream (igual
// que hace cwc-chat-runner.js con chat-session-ids.json). Cada runner de
// aprendizaje captura ese id y lo registra acá; el módulo tokens lee este archivo
// y atribuye esos transcripts al bucket 'aprendizaje' en vez de 'consola'.
//
// MISMO PATRÓN que registerChatSessionIds (chat/index.js): Set append-only,
// best-effort (jamás rompe el runner). Read-merge-write con rename atómico para
// tolerar dos runners de aprendizaje concurrentes (raro, pero posible). NO es
// retroactivo: transcripts de aprendizaje ya generados antes de esto quedan
// contados en 'consola' (no hay señal para re-separarlos).
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = path.join(os.homedir(), '.cwc-data');
// El módulo tokens lee este MISMO archivo por su cuenta (misma convención que
// chat-session-ids.json, que chat/index.js y tokens/index.js declaran por
// separado): si cambia el nombre, actualizar LEARNING_IDS_FILE en tokens/index.js.
export const LEARNING_IDS_FILE = path.join(DATA_DIR, 'learning-session-ids.json');

// Registra un sessionId de aprendizaje (idempotente). Re-lee el archivo antes de
// escribir para no pisar el id que otro runner concurrente pudo agregar.
export function registerLearningSession(id) {
  try {
    if (!id || typeof id !== 'string') return;
    const set = new Set();
    try {
      const arr = JSON.parse(fss.readFileSync(LEARNING_IDS_FILE, 'utf8'));
      if (Array.isArray(arr)) for (const x of arr) if (typeof x === 'string' && x) set.add(x);
    } catch { /* primera vez: el archivo todavía no existe */ }
    if (set.has(id)) return;
    set.add(id);
    fss.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${LEARNING_IDS_FILE}.tmp`;
    fss.writeFileSync(tmp, JSON.stringify([...set]), { mode: 0o600 });
    fss.renameSync(tmp, LEARNING_IDS_FILE);
  } catch { /* best-effort */ }
}
