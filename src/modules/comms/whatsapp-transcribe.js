// modules/comms/whatsapp-transcribe.js — transcripción LOCAL de notas de voz de
// WhatsApp (PEND-479 del PLAN-447). Speech-to-text 100% en la máquina, sin nube:
// usa whisper.cpp (el mismo core que envuelven los MCP de whisper, pero llamado
// directo como binario porque el daemon NO es un modelo — no puede invocar un
// MCP) + ffmpeg para normalizar el audio.
//
// Flujo: el .ogg (opus) de WhatsApp → ffmpeg lo pasa a WAV 16kHz mono (formato
// que whisper.cpp espera) → whisper-cli transcribe en español → devuelve el
// texto. Determinístico, 0 tokens del SDK (es cómputo local, no una corrida IA).
//
// Rutas de las herramientas: whisper.cpp compilado en ~/whisper.cpp (binario
// build/bin/whisper-cli + modelo models/ggml-small.bin), ffmpeg del sistema.
// Overridables por env (WHISPER_BIN / WHISPER_MODEL) por si se mueven.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const HOME = os.homedir();
const WHISPER_BIN = process.env.WHISPER_BIN || path.join(HOME, 'whisper.cpp', 'build', 'bin', 'whisper-cli');
const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(HOME, 'whisper.cpp', 'models', 'ggml-small.bin');
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const TRANSCRIBE_TIMEOUT_MS = 5 * 60 * 1000; // audios largos en CPU pueden tardar

export function transcriptionAvailable() {
  try { return fs.existsSync(WHISPER_BIN) && fs.existsSync(WHISPER_MODEL); } catch { return false; }
}

function run(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
  });
}

// Transcribe el archivo de audio en `audioPath`. Devuelve { text, txtFile } o
// null si no se pudo. `lang` por defecto 'es' (español) — la mayoría de las
// notas de voz de los proveedores. Además del texto, ESCRIBE la transcripción
// como archivo `.txt` JUNTO al audio (mismo basename) — así queda como artefacto
// de archivo (Parte A del PLAN-447/PEND-479), copiable a la carpeta de un chat
// con cwc-whatsapp-work.js. Best-effort: cualquier fallo → null + log, nunca
// lanza (el mensaje se guarda igual, sin transcripción).
export async function transcribeAudio(audioPath, { lang = 'es' } = {}) {
  if (!transcriptionAvailable()) return null;
  if (!audioPath || !fs.existsSync(audioPath)) return null;
  // WAV 16kHz mono a un tmp (formato que whisper.cpp requiere).
  const wavPath = `${audioPath}.16k.wav`;
  try {
    await run(FFMPEG_BIN, ['-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath], 60000);
    // -nt: sin timestamps · -np: sin prints de progreso · salida por stdout.
    const { stdout } = await run(WHISPER_BIN, ['-m', WHISPER_MODEL, '-f', wavPath, '-l', lang, '-nt', '-np'], TRANSCRIBE_TIMEOUT_MS);
    const text = String(stdout || '').trim();
    if (!text) return null;
    // El .txt junto al audio: <audio>.ogg → <audio>.txt (basename sin la ext).
    let txtFile = null;
    try {
      const txtPath = `${audioPath.replace(/\.[^.]+$/, '')}.txt`;
      fs.writeFileSync(txtPath, text, { mode: 0o600 });
      txtFile = path.basename(txtPath);
    } catch (err) { console.error('[whatsapp] no se pudo escribir el .txt:', err?.message); }
    return { text, txtFile };
  } catch (err) {
    console.error('[whatsapp] transcripción falló:', err?.message);
    return null;
  } finally {
    try { fs.unlinkSync(wavPath); } catch { /* noop */ }
  }
}
