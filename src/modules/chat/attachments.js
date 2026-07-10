// modules/chat/attachments.js — ADJUNTOS de una conversación de chat.
//
// Subsistema compartido entre el SERVER (modules/chat/index.js: endpoints de
// subida/lectura) y el RUNNER desacoplado (bin/cwc-chat-runner.js: arma el
// content del mensaje del SDK). Cada conversación tiene su carpeta propia bajo
// ~/.cwc-data/chat-attachments/<chatId>/ — estado de RUNTIME (regla 4: dentro
// de ~/.cwc-*), que sobrevive reinicios y es navegable desde el Explorador
// ("Abrir carpeta del chat" del menú ⋯ de Sesiones).
//
// FLUJO: el composer sube CADA archivo a POST /api/chat/attachment (multer,
// escritura a disco con límite de tamaño ANTES de leer a memoria) → al enviar
// el mensaje viajan las REFERENCIAS {name,type,mime} (no el base64) por el WS →
// el runner LEE cada archivo del disco y arma el content del SDK según su tipo:
//   · imagen (jpeg/png/gif/webp) → bloque `image` base64 (visión nativa)
//   · PDF                        → bloque `document` base64 (visión nativa)
//   · texto (txt/md/csv/código…) → contenido INLINE en un bloque `text`
//   · binario (docx/zip/…)       → nota con la ruta absoluta (el modelo lo abre
//                                  con sus herramientas si lo necesita — la API
//                                  no tiene bloque nativo para estos)
//
// INVARIANTE de seguridad (ver health/invariants.js): TODO nombre de archivo se
// reduce a un basename validado y se confina a la carpeta del chat; el límite
// de tamaño se aplica ANTES de leer el archivo a memoria (multer al subir +
// statSync antes del readFileSync acá). Nunca se resuelven rutas del cliente.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import multer from 'multer';

export const ATTACH_ROOT = path.join(os.homedir(), '.cwc-data', 'chat-attachments');

// Id de chat: `c<pid>-<seq>` (ver ChatManager.create). Whitelist estricta.
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
// Nombre de archivo: basename sin separadores ni traversal.
const NAME_RE = /^[^/\\\0]{1,255}$/;

// Límites PROPIOS de la consola (más conservadores que la API donde aplica).
export const MAX_IMAGES = 4;        // imágenes por mensaje (bloque de visión)
export const MAX_ATTACHMENTS = 8;   // adjuntos totales por mensaje
export const IMAGE_MAX = 10 * 1024 * 1024;      // 10 MB base64 (tope API imagen)
export const PDF_MAX = 32 * 1024 * 1024;        // 32 MB (tope request API)
export const FILE_MAX = 20 * 1024 * 1024;       // 20 MB política propia (no van como bloque)
export const UPLOAD_MAX = 32 * 1024 * 1024;     // tope duro de multer por archivo
export const TEXT_INLINE_MAX = 400 * 1024;      // chars inline de un archivo de texto

// MIME → media_type que acepta la Messages API para imágenes.
export const IMAGE_MIME = {
  'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg',
  'image/png': 'image/png', 'image/gif': 'image/gif', 'image/webp': 'image/webp',
};
const IMAGE_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

// Extensiones que tratamos como TEXTO plano (contenido inline). No exhaustivo;
// cualquier mime `text/*` o application/json|xml|yaml también cae acá.
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'mdx', 'rst', 'csv', 'tsv', 'json', 'jsonl', 'ndjson',
  'yaml', 'yml', 'xml', 'toml', 'ini', 'conf', 'cfg', 'properties', 'env',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'sh', 'bash', 'zsh', 'fish',
  'sql', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'log', 'gradle', 'make',
  'dockerfile', 'vue', 'svelte', 'r', 'lua', 'pl', 'pm', 'ex', 'exs', 'erl',
  'clj', 'cljs', 'scala', 'dart', 'tf', 'proto', 'graphql', 'gql', 'diff', 'patch',
]);

const extOf = (name) => String(name || '').split('.').pop().toLowerCase();

// Clasifica un adjunto por mime + nombre: 'image' | 'pdf' | 'text' | 'binary'.
// La ÚNICA fuente de verdad de la clasificación (server, runner y front la usan).
export function classifyAttachment(mime, name) {
  const m = String(mime || '').toLowerCase();
  const ext = extOf(name);
  if (IMAGE_MIME[m] || IMAGE_EXT[ext]) return 'image';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m.startsWith('text/') || m === 'application/json' || m === 'application/xml'
      || m === 'application/x-yaml' || m === 'application/yaml' || TEXT_EXT.has(ext)) return 'text';
  return 'binary';
}

// Carpeta absoluta de adjuntos del chat (o null si el id es inválido).
export function chatAttachDir(chatId) {
  if (!ID_RE.test(String(chatId || ''))) return null;
  return path.join(ATTACH_ROOT, chatId);
}

// Ruta RELATIVA al home para el deep-link del Explorador (?path=…).
export function attachRelForExplorer(chatId) {
  if (!ID_RE.test(String(chatId || ''))) return null;
  return path.join('.cwc-data', 'chat-attachments', chatId);
}

// Basename saneado o null (sin traversal, sin separadores, sin . / ..).
export function safeAttachName(name) {
  const base = path.basename(String(name || ''));
  if (!base || base === '.' || base === '..' || !NAME_RE.test(base)) return null;
  return base;
}

// Ruta absoluta del adjunto SI existe y cae dentro de la carpeta del chat.
// Defensa en profundidad: además del basename, se exige que el padre sea EXACTO.
export function attachPath(chatId, name) {
  const dir = chatAttachDir(chatId);
  const base = safeAttachName(name);
  if (!dir || !base) return null;
  const abs = path.join(dir, base);
  if (path.dirname(abs) !== dir) return null;
  try { if (!fs.statSync(abs).isFile()) return null; } catch { return null; }
  return abs;
}

// Nombre único dentro de la carpeta (agrega " (n)" antes de la extensión).
function uniqueName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let i = 1; let cand;
  do { cand = `${base} (${i})${ext}`; i += 1; } while (fs.existsSync(path.join(dir, cand)));
  return cand;
}

// multer para la subida de UN adjunto. Destino = carpeta del chat (?id=…),
// creada al vuelo; nombre saneado + único. El límite de tamaño se aplica
// DURANTE el streaming a disco (nunca se buffea entero a memoria).
const badReq = (m) => Object.assign(new Error(m), { badRequest: true });
export const attachUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = chatAttachDir(req.query?.id);
      if (!dir) return cb(badReq('Id de conversación inválido.'));
      try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
      catch (e) { return cb(e); }
      cb(null, dir);
    },
    filename(req, file, cb) {
      const dir = chatAttachDir(req.query?.id);
      const raw = path.basename(file.originalname || '').replace(/[/\\]/g, '_') || 'archivo';
      cb(null, uniqueName(dir, raw));
    },
  }),
  limits: { fileSize: UPLOAD_MAX, files: 1 },
});

// Filtra la metadata de adjuntos recibida del cliente a los que EXISTEN en la
// carpeta del chat. Devuelve [{name,type,mime}] listo para viajar al runner y
// para la burbuja del usuario. Tope MAX_ATTACHMENTS.
export function existingAttachments(chatId, raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw) {
    if (out.length >= MAX_ATTACHMENTS) break;
    const name = safeAttachName(a?.name);
    if (!name || !attachPath(chatId, name)) continue;
    const mime = typeof a?.mime === 'string' ? a.mime.slice(0, 120) : '';
    out.push({ name, type: classifyAttachment(mime, name), mime });
  }
  return out;
}

const imageMimeFromName = (name) => IMAGE_EXT[extOf(name)] || null;

// Bloque de texto que REFERENCIA un archivo por ruta (imágenes/PDF/binarios que
// exceden límite, o binarios sin bloque nativo). El modelo lo lee con Read/bash.
function refBlock(name, abs, kind) {
  return {
    type: 'text',
    text: `📎 Adjunto «${name}» (${kind}) guardado en: ${abs}\n`
      + 'Usá tus herramientas de lectura (Read/Bash) si necesitás su contenido.',
  };
}

// Arma el `content` del mensaje de usuario del SDK a partir del texto + los
// adjuntos [{name,type,mime}]. SIN adjuntos → devuelve el STRING tal cual
// (retrocompat total). CON adjuntos → array de bloques image/document/text.
// Lee cada archivo del disco de la carpeta del chat (ID). Valida tamaño ANTES
// de leer a memoria (invariante). Lo usa el RUNNER.
export function buildUserContent(chatId, text, attachments) {
  const list = Array.isArray(attachments) ? attachments.slice(0, MAX_ATTACHMENTS) : [];
  const clean = String(text || '');
  if (!list.length) return clean; // string: camino histórico intacto

  const blocks = [];
  let imageCount = 0;
  for (const a of list) {
    const name = safeAttachName(a?.name);
    const abs = name ? attachPath(chatId, name) : null;
    if (!abs) continue;
    const type = a?.type || classifyAttachment(a?.mime, name);
    let size = 0;
    try { size = fs.statSync(abs).size; } catch { continue; } // tamaño ANTES de leer

    if (type === 'image') {
      const media = IMAGE_MIME[String(a?.mime || '').toLowerCase()] || imageMimeFromName(name);
      if (imageCount >= MAX_IMAGES || size > IMAGE_MAX || !media) {
        blocks.push(refBlock(name, abs, 'imagen')); continue;
      }
      blocks.push({ type: 'image', source: { type: 'base64', media_type: media, data: fs.readFileSync(abs).toString('base64') } });
      imageCount += 1;
    } else if (type === 'pdf') {
      if (size > PDF_MAX) { blocks.push(refBlock(name, abs, 'PDF')); continue; }
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(abs).toString('base64') } });
    } else if (type === 'text') {
      let content;
      try { content = fs.readFileSync(abs, 'utf8'); } catch { blocks.push(refBlock(name, abs, 'archivo')); continue; }
      if (content.length > TEXT_INLINE_MAX) content = `${content.slice(0, TEXT_INLINE_MAX)}\n… [recortado; archivo completo en ${abs}]`;
      blocks.push({ type: 'text', text: `📎 Archivo adjunto «${name}»:\n\n\`\`\`\n${content}\n\`\`\`` });
    } else {
      blocks.push(refBlock(name, abs, 'archivo'));
    }
  }

  if (clean.trim()) blocks.push({ type: 'text', text: clean });
  else if (!blocks.some((b) => b.type === 'text')) blocks.push({ type: 'text', text: '(sin texto — ver los adjuntos)' });
  return blocks.length ? blocks : clean;
}
