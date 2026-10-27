# Archivos de runtime — detalle por módulo

> Detalle histórico de la sección "NO MODIFICAR" del CLAUDE.md raíz, movido acá el 2026-07-24 (PLAN-1862) porque el archivo raíz superaba 3,8× el límite de 150k.
> La versión corta y vigente está en el `CLAUDE.md` de la raíz.
> El detalle de cada archivo también debe reflejarse en la ficha del módulo que lo escribe.

## NO MODIFICAR (generado o estado de runtime)

- `node_modules/`, `package-lock.json` (solo vía npm)
- `certs/` (cert self-signed autogenerado; se regenera si cambia la IP)
- `users.json`, `sessions.json` (auth; perms 600), `recents.json`, `titles.json`
- `.env` (config del usuario: token maestro, puerto, etc. — solo el usuario)
- Fuera del repo: `~/.cwc-data/` (chats.json, `chat-session-ids.json` —
  registro DURABLE append-only de TODOS los sessionIds que alguna vez fueron
  chat: lo escribe el módulo chat en persist()/rehydrate() y NUNCA se poda (a
  diferencia de chats.json, que persist() filtra a los vivos y el reaper poda
  a las 24 h); lo lee tokens/buildSummary (unión con chats.json + bugfixes.json)
  para que un chat cerrado/olvidado no se atribuya como "Motores headless" en
  el panel de Uso (fable/opus fantasma, hallazgo de la Optimización IA
  2026-07-05; backfill histórico one-time hecho desde los logs de
  ~/.cwc-data/chats/*.log) —, `chat-trash/` PAPELERA DE CONVERSACIONES bajo el
  data-dir de CADA dueño (`~/.cwc-data/` para el host y el espacio propio del
  inquilino): `chat-trash/index.json` + una carpeta
  `chat-trash/<trashId>/` por entrada con `meta.json`,
  `transcript/<sid>.jsonl` y `attachments/`; retención 30 días
  (`CHAT_TRASH_TTL_DAYS`), con purga de vencidos al arrancar el módulo y al
  listar la papelera —, sockets/logs de runners, caché
  tickets/salud — incluida `triage-cache.json`, caché INCREMENTAL por ticket
  del triage (fingerprint status+subject + TTL 12 h; borrarla solo fuerza
  un triage completo) —, `desk-live/<ticket>.json` resultado de la consulta a Zoho Desk
  + `desk.lock` heartbeat del runner desk, `investigations/<pr>.json` veredicto de
  la investigación a fondo + `investigate.lock` heartbeat,
  `ticket-investigations/<n>.json` veredicto de la investigación de contexto de un
  ticket sin PR + `<n>.req.json` enunciado + `ticket-investigate.lock` heartbeat,
  snapshot interno del módulo `seguimientos` + historia diaria de métricas (estado
  generado desde Zoho Desk; el dashboard lee disco, no el mundo externo en vivo),
  `connections/_app.json` (credenciales de la APP OAuth de instancia, admin) +
  `connections/<provider>.json` por usuario (tokens OAuth, perms 600) +
  `connections/jobs/` (jobs efímeros del flujo de conexión),
  `inventory.json`+`inventory.md` generados por core/inventory.js,
  `updates-census.json` último censo de versiones de terceros (módulo `updates`;
  npm outdated/audit + claude/apt/pad versions; escritura atómica, caché 6 h, se
  re-sirve como fallback tras reinicio antes de re-correr los npm lentos),
  `updates-job.json` estado por fases del BOTÓN ÚNICO de actualización orquestada
  (módulo `updates`; lo reserva POST /updates/run, lo avanza
  `bin/cwc-updates-runner.js` con heartbeat — REANUDABLE, sobrevive el reinicio que
  él mismo dispara) + `updates-orchestrate.log` de ese runner,
  `updates-risk.json` veredictos IA de riesgo de los saltos mayores (módulo
  `updates` Fase B; lo escribe `bin/cwc-updates-analyze-runner.js`, heartbeat) +
  `updates-analyze.log`,
  `plan-limits.json` último snapshot BUENO de límites/créditos del plan (lo
  escribe el módulo tokens en cada respuesta OK de /api/tokens/limits; se sirve
  como fallback `stale` ante 429/corte de red/reinicio),
  `codex-limits.json` último snapshot BUENO de los límites de CODEX CLI (OpenAI)
  — lo escribe el módulo tokens (writePersistedCodex) desde el endpoint interno
  `chatgpt.com/backend-api/wham/usage`, leyendo la credencial local
  `~/.codex/auth.json`; fallback `stale` best-effort (PEND-499, ver módulo tokens),
  `usage-history.json` HISTÓRICO PERSISTENTE de consumo por día(LOCAL Medellín)×
  PROYECTO×modelo (days[fecha][consola|tolkien|otros][modelKey]={tokens,cost}; lo
  escribe el módulo tokens vía history-store.js: buildSummary calcula el desglose y
  lo snapshotea cada ~5 min — independiente de la poda de transcripts del CLI;
  retención 400 días diaria + rollup mensual `months`; alimenta GET
  /history?range=week|month&project — Semana=7 d, Mes=30 d — = gráficas de Tendencia
  del modal Uso; el rango Día sale del summary, no de acá; días en formato viejo flat
  se normalizan a {otros} al leer).
  REEMPLAZÓ al viejo `tokens-reset.json`/POST /reset (2026-07-10): con historial
  persistente NO hace falta "poner en cero"; si quedó un tokens-reset.json huérfano
  de antes es inerte (ya no se lee),
  `health-solved.json` registro de bugs, `health-audit-cache.json` caché
  incremental de salud, `health-invariant-proposals.json` invariantes propuestos
  pendientes, `health-scan.json` estado por fases del ESCANEO DE SALUD UNIFICADO +
  `health-scan.lock` heartbeat de su orquestador + `health-scan.log` (ver
  "Verificación de salud" · Escaneo unificado), `comms/` (motor de Comunicaciones: contacts.json · projects.json · github.json escaneo gh · manual.json registros · overrides.json · gh-cache.json · self.json identidad del dueño · chatbot.json chatbot derivado por IA · comms.lock heartbeat · teams.lock · chatbot.lock heartbeat · analyze/ análisis IA de hilos), `optimization.json` resultado de la Optimización IA +
  `optimize.lock` heartbeat de su runner, `coherence.json` resultado del Módulo
  de Coherencia (propuestas + hallazgos determinísticos persistidos) +
  `coherence.lock` heartbeat de su runner, `projects-analyze/<id>.json` jobs del
  análisis IA de secciones de contexto (módulo projects; poda >24 h en cada
  escritura) + `projects-analyze.log` de su runner, `commitmsg/<id>.json` jobs
  de la generación IA del mensaje de commit (módulo backup; misma poda >24 h) +
  `commitmsg.log` de su runner,
  `news.json` registro de 🆕 Novedades con formato
  `{entries:[{id,createdAt,emoji,category,title,summary,bullets,tryIt,tech:{commits,files},source,hidden,editedAt,editedBy}]}`;
  se ordena por `createdAt` descendente y se poda a 200 entradas,
  `news-seen.json` mapa `{<principal>:<lastSeenMs>}` de última lectura por
  usuario (sin poda), `news/<jobId>.json` job de redacción con formato
  `{status,startedAt,commits,files,count,error,updatedAt?,rawTail?}` (poda de
  jobs >24 h en cada escritura) + `news.log` de `bin/cwc-news-runner.js`,
  `forja/me.json` snapshot PRIVADO de progresión de cada dueño (vive bajo el
  `userDataDir(owner)` correspondiente) + `forja/arena.json` snapshot de la
  arena pública en el `userDataDir(hostUser())`; ambos se escriben atómicamente,
  se reconstruyen desde GitHub cada 3 minutos y conservan el último bueno ante
  fallos de red. Las cachés canónicas de esos listados viven en
  `comms/pr-author-cache/` con TTL corto,
  `tolkien-refresh.json` job del refresh DESACOPLADO
  de la DB LOCAL de Tolkien (lo reserva POST /api/tolkien/refresh-data, lo completa
  `bin/cwc-tolkien-refresh-runner.js`; staleness 12 min) + `tolkien-refresh.log`,
  `tasks.json` registro PRIVADO de las tareas
  pendientes + PLANES (módulo tasks; CRUD síncrono determinístico, escritura
  atómica tmp+rename — NO hay runner) + `tasks-activity.json` LOG de actividad
  append-only (create/update/status/complete/delete de tareas y planes; poda a
  300 eventos) + `tasks-analysis-<scope>.json` resultado del ANÁLISIS GENERAL IA
  del tablero (scope tasks|plans; lo escribe `bin/cwc-tasks-analyze-runner.js`) +
  `tasks-analyze.log` de ese runner, `learning.json` registro PRIVADO de los TEMAS
  del MÓDULO DE APRENDIZAJE (módulo learning; CRUD síncrono tmp+rename, sin runner)
  + `learning-activity.json` su LOG append-only (poda 300) +
  `learning-explain-<id>.json` job de "🎓 Explicame esto" (lo escribe el POST, lo
  completa `bin/cwc-learning-explain-runner.js`) + `learning-explain.log` de ese
  runner + `learning-context-<jobId>.json` job de "🎙️ Contexto adicional" (id
  determinístico por tema+transcripción) + `learning-context.log` de
  `bin/cwc-learning-context-runner.js` + `learning-analysis.json` resultado de
  "🧠 Analizar aprendizaje" (`bin/cwc-learning-analyze-runner.js`) +
  `learning-analyze.log` — OJO: `learning.json` guarda AMBOS temas (LT<n>,
  ahora con contextoAdicional/explainFingerprint/explainFiles/explainVersions)
  y RUTAS de aprendizaje (LR<n>, routes[]+routeSeq),
  `learning-session-ids.json` registro DURABLE append-only de los sessionIds de
  las corridas del MÓDULO DE APRENDIZAJE (lo escriben los 3 runners de aprendizaje
  vía `learning/session-log.js` capturando el `session_id` del msg SDK
  `system/init`; lo lee el módulo tokens): esas corridas usan cwd = la consola,
  así que `projectOf` las vería como 'consola' — este registro permite atribuir su
  consumo al bucket 'aprendizaje' APARTE, para auditar tokens de ESTUDIO vs
  DESARROLLO (no es retroactivo: transcripts de aprendizaje previos a 2026-07-10
  quedan contados en 'consola'),
  `audio/<id>.json` jobs del análisis IA de
  transcripciones (módulo audio; id determinístico por contenido, poda >30 días)
  + `audio.log` de su runner, `retro/<id>.json` jobs de la destilación de MEJORA
  CONTINUA (ROAD-256, módulo `retro`; id sha1 del sessionId, lo encola Chat.close,
  poda >30 días) + `retro.log` de su runner + `retro-activity.json` log local
  append-only del registro de lecciones + `retro-curation.json` job de la
  curaduría IA (Fase 5) + `retro-curate.log` (las lecciones EN SÍ viven en Pad
  local, colección `mejora-continua`, no en archivo), `session-bus/` del INTERFONO entre
  sesiones — `messages/<id>.json` bandeja de mensajes · `claims/<hash>.json`
  reservas de archivo (1 por archivo, clave = hash de la ruta) ·
  `tombstones/<id>.json` avisos de claim robado; lo escriben los hooks vía
  `bin/cwc-bus.js`, el módulo `interfono` solo lo lee), `ticket-meta.json`
  (metadata NUESTRA por ticket/PR del módulo VIVO `tickets/`: "Contexto adicional"
  + "Histórico del trabajo" — clave `ticketNumber` o `pr:<n>`; lo escribe
  `tickets/meta-store.js`, escritura atómica tmp+rename; NADA lo poda),
  `ticket-context/<id>.json` jobs del runner de contexto adicional
  (`bin/cwc-ticket-context-runner.js`; poda >30 días) + `ticket-context.log`,
  `~/.cwc-backups/`, `~/.cwc-trash/`, `~/.cwc-state/`
  (observador — OJO: `claude-state.js` PODA todo .json de `~/.cwc-state` sin
  `ts` fresco; nunca guardar ahí nada ajeno al observador)
