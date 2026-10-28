<!-- cwc:ficha-modulo -->
# src/modules/comms — ficha del proyecto

> Ficha de contexto de esta carpeta. Claude Code la carga automáticamente cuando lee un archivo de acá (NO se carga al arrancar la sesión). Las reglas duras y convenciones globales viven en el `CLAUDE.md` de la raíz del repo.
### comms/                    LIBRERÍAS COMPARTIDAS de comunicaciones (file-based, patrón
Interfono; estado 100% en ~/.cwc-data/comms/, 0 tokens, sobrevive
reinicios). ⚠️ El DASHBOARD de Comunicaciones (módulo backend
registrado `index.js` con ruta /api/comms + el tablero frontend
`public/js/modules/comms/board/`) se ELIMINÓ el 2026-07-14 (feedback
de Niko: no lo usaba, un inbox-dashboard COMPITE con Teams/WhatsApp
nativos y no gana — ver memoria `feedback-comms-dashboard-vs-flujo`):
`index.js` → `_archived/src-modules-comms/`, el frontend →
`_archived/public-js-modules/comms/`; `comms` YA NO está en
registry.js ni se monta en main.js. Lo que QUEDA en `src/modules/comms/`
son LIBRERÍAS SHARED que otros módulos consumen (NO es un módulo
registrado): `shared.js` (constantes ~/.cwc-data/comms/*, contactos/
self/overrides, buildIndex(), ledgers JSONL, y las constantes
WHATSAPP_* que usa el daemon), `pr-read-shared.js` (LECTOR ÚNICO de
PRs y despliegues de GitHub — lo importan `tickets/sources.js` y `forja/refresher.js`;
`listMergedPrsByAuthor()` usa repo explícito Tolkien, incluye `mergeCommit` y `headRefOid`, caché
por autor de 150 s y fallback `_stale` al último bueno; `githubUserExists()`
resuelve existencia, login canónico y nombre con caché corta;
`getCurrentProductionSha()` recorre una página de runs exitosos `deploy-v2.yml`
del más nuevo al más viejo hasta el primer `operation=deploy`, y acepta el SHA
solo desde el JSON estricto de `EXPECTED_ARTIFACT_JSON.sourceSha` emitido por el
mismo job; operaciones o SHAs contradictorios dejan el run inclasificable. La
caché por run está versionada (`run-v2-*`) y limita cada lectura a cinco logs:
prioriza runs nunca inspeccionados, de nuevo a viejo, y recién después reintenta
inclasificables cuyo TTL venció. Deploys, no-deploys y logs no disponibles se
cachean permanentemente; un run inclasificable reciente vence a los 10 min y
uno terminado hace más de una hora queda permanente. Errores de red/5xx no se
cachean y hacen caer al último estado bueno marcado `_stale`. Los runs
`OPERATION: rollback` se clasifican como no-deploy y se omiten: no representan
el estado actual de producción en este modelo simplificado.
`listCommitsBetween(base,head)` pagina compare, devuelve commits `ahead` y los
exclusivos del head en `diverged`, deja `behind` vacío y cachea permanentemente
cada par inmutable),
`gateway-shared.js`
(GATEWAY de envíos Desk/Teams/GitHub — lo importa el CLI
`bin/cwc-comms.js`), `teams-shared.js` · `chatbot-shared.js` ·
`analyze-shared.js` (usados por los runners `bin/cwc-comms-*.js`), y
`whatsapp-transcribe.js` (transcripción de voz, ver abajo). El
reemplazo del dashboard NO es otro inbox: es el FLUJO DE SEGUIMIENTO
"trabajar un hilo de WhatsApp en un chat de la consola" (ver WhatsApp).
OJO: `comms` ≠ `interfono` (mensajería entre sesiones de Claude).
**WhatsApp (PLAN-447):** puente bidireccional con **Baileys** (paquete
npm `baileys`, FIJADO a 6.7.23 — NUNCA el dist-tag `latest`, que es un
RC 7.x con breaking changes; librería NO oficial, WebSocket NATIVO de
WhatsApp, sin navegador/Chromium → ~58MB RAM). MIGRÓ desde
whatsapp-web.js (BUG-455: su evento `ready` dejó de disparar por un A/B
testing de WhatsApp Web 2.3000.x sobre los módulos internos que esa
librería espía — bug ajeno sin fix upstream). GOTCHA del arranque
(resuelto): Baileys 6.7.23 trae hardcodeada una versión vieja del
protocolo → error 405 "Connection Failure"; se llama
`fetchLatestBaileysVersion()` en cada arranque y se pasa `version` a
makeWASocket (github.com/WhiskeySockets/Baileys#2370). Sesión emparejada
por QR UNA vez (QR rasterizado a PNG en `whatsapp-qr.png` — el ASCII
terminal salía ilegible; credenciales en `~/.cwc-data/whatsapp-session/`,
`useMultiFileAuthState`, nunca al repo; REUTILIZA al reiniciar sin
re-escanear). `markOnlineOnConnect:false` (no roba las notificaciones
push del teléfono). Corre como **servicio systemd de usuario
`whatsapp-bridge.service`** (proceso LARGO, regla de oro/regla 2 — NUNCA
nohup: se cayó dos veces así; heartbeat `whatsapp-daemon.json`
{pid,ts,state}). Watchlist `whatsapp-watch.json` [{jid,label}] = chats a
persistir; el daemon loguea DISCOVERY de los NO-watchlist SIEMPRE (aun
con watchlist activa) para mapear un chat nuevo mandándole un mensaje
—propio o ajeno— sin apagar el monitoreo. Modos puntuales del daemon
(terminan solos): `--find=n1,n2` · `--groupmeta=jid` ·
`--listgroups[=filtro]` (grupos vía groupFetchAllParticipating —
los grupos SÍ se listan directo; los chats individuales solo se
"ven" con un mensaje nuevo). JIDs: `@g.us` grupos · `@lid` (LID nuevo
de WhatsApp por privacidad) o `@s.whatsapp.net` individuales — todos
sirven para leer Y enviar. Mensajes en `whatsapp.json` (threads[] con
messages[] {id,ts,from,fromMe,body,attachment?}). LEER + ESCRIBIR +
ADJUNTOS + VOZ, todo verificado E2E con la cuenta espejo:
· 📥 RECIBIR ADJUNTOS (PEND-458): `downloadMediaMessage` → binario en
  `whatsapp-media/<safeName(jid)>/<msgId>.<ext>` + referencia
  {type,file,fileName,mime,caption,size} en el thread. Tipos:
  image/video/audio/document/sticker (MEDIA_KINDS). Descarga async
  ANTES de persistir (1 write); fallo → referencia con `error`.
· 📤 ESCRIBIR (texto + adjuntos, PEND-453/459): canal file-based OUTBOX
  — un job `<id>.json` en `whatsapp-outbox/` {jid, text?, media?} que el
  daemon vigila (polling 1.5s, SERIAL para no ráfaga-ar el anti-bot),
  envía con sock.sendMessage (buildOutgoingContent arma text |
  {image|video|audio|document} leyendo el archivo local), resultado en
  `whatsapp-sent/<id>.json`, borra el outbox. El server/CLI encola SIN
  tener la sesión (solo el daemon la tiene); confirm gate va ARRIBA.
· 🎙️ TRANSCRIPCIÓN DE VOZ (PEND-479, todo LOCAL, 0 tokens SDK):
  `whatsapp-transcribe.js` (transcribeAudio) — ffmpeg convierte el .ogg
  opus → WAV 16k mono → `whisper.cpp` transcribe en español. NO usa un
  MCP de whisper (los locales son macOS-only y solo transcriben a
  demanda en un chat; el daemon no es un modelo) — usa el MISMO core
  (whisper.cpp) directo como binario. Al transcribir: campo `transcript`
  en la referencia + escribe un `.txt` JUNTO al audio
  (`<msgId>.txt`, campo `transcriptFile`). Herramientas: whisper.cpp
  compilado en `~/whisper.cpp` (binario `build/bin/whisper-cli` + modelo
  `models/ggml-small.bin` 466MB — `small` da buen español; subir a
  `medium` si no alcanza) + ffmpeg del sistema (apt). Rutas overridables
  por env `WHISPER_BIN`/`WHISPER_MODEL`/`FFMPEG_BIN` (defaults en
  código, NO en .env). Best-effort: si whisper no está o falla, el audio
  queda igual sin transcripción. OJO: whisper.cpp + su modelo viven en
  `~/whisper.cpp` (FUERA del repo, como pad-local; no versionar).
· 🔗 FLUJO "TRABAJAR UN HILO EN UN CHAT" (PEND-479, el reemplazo del
  dashboard): `bin/cwc-whatsapp-work.js <jid|substring-label> <chatId>`
  copia a la carpeta de trabajo de UN chat de la consola
  (`chatAttachDir(chatId)` = `~/.cwc-data/chat-attachments/<chatId>/`, la
  que abre "Abrir carpeta de este chat" y viaja con el paquete-sesión)
  TODOS los artefactos del hilo (audios, sus `.txt`, PDFs, imágenes) + un
  `<hilo>-historial.txt` con la conversación y las transcripciones
  inline. Determinístico, 0 tokens: reusa `materializeIntoChat()` de
  chat/attachments.js (mismo filtro/saneo/confinamiento que cwc-attach.js).
  Disparador (sin dashboard): desde un chat de la consola el usuario pide
  "traeme el hilo de X" y el asistente corre el CLI con el chatId actual →
  el hilo entero queda en la carpeta del chat (referenciada por
  sessionFolderRule) → lo analiza/contrasta. Es el flujo de SEGUIMIENTO
  que Niko validó, no un inbox.
