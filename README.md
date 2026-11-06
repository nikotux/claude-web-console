# Claude Web Console

A personal web console for working with **Claude Code from the browser**
(including from your phone) over **ZeroTier**, with no SSH client required.
Real PTY terminals (`xterm.js` + `node-pty` + `tmux`), a native SDK-based
chat, a file explorer, a token/usage dashboard, tmux control, a panel for the
main tracked project (git), ticket triage, an automated bugfix→PR workflow,
backups, and admin/health tooling.

This is a **personal, self-contained project**: it lives in
`~/claude-web-console` and does not depend on any company monorepo.

---

## Overview

Claude Web Console is a single Node/Express/WebSocket server that serves a
vanilla JS/HTML/CSS frontend and orchestrates a set of independent backend
modules (mounted in `src/core/registry.js`):

- **terminal** — tmux-backed PTY sessions (raw terminals and hidden TUI
  views used for chat↔TUI handoff); survive disconnects and server restarts.
- **chat** — native Agent SDK conversations (message bubbles, markdown,
  collapsible tool calls with results, red/green diffs, permission modes,
  per-turn cost, resume). Each conversation runs in its own detached runner
  process (`bin/cwc-chat-runner.js`) so a server crash/restart never kills
  work in progress.
- **files** — the file tree that feeds the launcher and session pickers.
- **stats** — CPU/RAM/disk gauges shown in the sidebar footer.
- **tokens** — per-project, per-model token usage and cost.
- **tmux** — low-level tmux session helpers used by `terminal`.
- **admin** — user management (scrypt-hashed passwords in `users.json`).
- **tolkien** — panel for the main tracked project (git status, update).
- **tickets** — on-demand triage of reported bugs.
- **bugfixes** — turns a ticket-tagged chat close-out into a tracked fix
  and, on demand, opens a PR against the tracked project's *own* GitHub
  origin (never against this console's own code).
- **backup** — full `.tar.gz` snapshots (kept server-side, secrets
  included) plus a hardened, secrets-free `git push` of the console's own
  code to a personal GitHub remote (see below).
- **health** — live self-checks (systemd, tmux, chat runners, state
  observer, TLS cert, git, code syntax, disk, runtime data) plus an
  optional, read-only, SDK-driven deep review of the code against
  `CLAUDE.md`.

## Changelog

Updated automatically by the "Push to GitHub" backup action every time the
console's code is pushed to this repository — each entry lists what changed
since the previous push. Newest entry first.

<!-- cwc:changelog:start -->

### 2026-11-06 17:46 — main
- perf(forja): cachear el formateador de fechas y agregar benchmark
- perf(forja): sondear merges nuevos antes de consultar por autor
- perf(forja): aligerar el polling de la ficha
- refactor(forja): retirar el festejo global que nunca llegaba al chat
- feat(chat): hitos de PR por sesión (aprobado, mergeado, en producción)
- feat(chat): aviso de 5 s y chip de hito en la lista de sesiones
- fix(chat): hitos de PR sin carreras ni avisos perdidos en pestañas ocultas
- fix(chat): título, router y juez con credenciales del dueño y sin tomar errores del SDK como texto
- fix(chat): enlazar hitos de PR publicados por Codex desde sus comandos reales
- fix(admin): los runners de admin usan la cuenta de Claude de quien los dispara
- fix(admin): mostrar el 409 de cuenta de Claude faltante en vez de simular que arrancó
- Dormir motores de chat según la pelota y afinar recursos del servicio

### 2026-10-28 15:33 — main
- Endurecer runners y stores: timeouts, reanudación y aislamiento por usuario

### 2026-10-28 14:50 — main
- feat(forja): construye La Forja v2
- docs(forja): documenta validación y festejos productivos
- fix: deploys por delta, parser estricto, primer nombre y fila accesible
- refactor: festejo de producción por estado y parser robusto
- fix: caché versionada, correlación por job y presupuesto de logs
- fix: frescura al cambiar producción, re-forja inmediata y docs
- fix: backoff del re-forjado y perfil stale
- feat(forja): permitir cambiar el usuario de GitHub
- docs(forja): documentar el cambio de login
- fix(forja): restaurar el foco tras cambiar el login
- fix(forja): apagar temporalmente el overlay de festejos
- Archivar módulos legacy (tickets, tasks, learning, seguimientos, audio, cerebro, lab)

### 2026-10-28 08:41 — main
- Arreglar el teclado del chat en móvil y respetar títulos puestos a mano
- feat: agrega datos y refresco de La Forja
- docs: registra contratos y facetas de La Forja
- fix: deriva iniciales desde la identidad GitHub
- fix: isMe de la arena por playerId opaco y snapshots coherentes
- fix: protege y conserva el historial de La Forja
- fix: faceta, frescura real y concurrencia acotada de La Forja
- Implementa la ficha y los salones de La Forja
- Afina el emblema y los niveles de La Forja
- Documenta el frontend de La Forja
- Pulir el salón y la arena de La Forja
- fix: accesibilidad, enlaces y CTA de identidad de La Forja
- fix: restaura el foco aunque la ficha se haya re-renderizado
- fix: la antigüedad visible usa la frescura real
- fix: dataAsOf nulo se muestra como desactualizado
- Persistir festejos privados de La Forja
- Celebrar cada nuevo anillo en la interfaz
- Precisar el contrato de festejos de La Forja
- refactor: estilos del festejo en la hoja del módulo
- fix: foco, capas y arranque seguro del festejo
- fix: evita re-mostrar un festejo durante su acuse y conserva el foco
- docs: registra festejos.json en el censo de runtime

### 2026-10-20 09:06 — main
- Adaptar el scraper de Tolkien al nuevo workboard en tabla y actualizar dependencias

### 2026-10-13 13:04 — main
- agregar sub-salas de Aduana con entorno de preview Tolkien compartido

### 2026-09-30 09:53 — main
- Agregar módulo Laboratorio (omp/Orca) y repointear label de Opus a 5.5

### 2026-09-24 10:14 — main
- Agregar integración con Microsoft y memoria de compactación del runner

### 2026-09-14 15:30 — main
- Sumar Cabina (modo simplificado) y rediseñar gestión de usuarios/patrocinio

### 2026-09-10 09:41 — main
- feat(chat): day separator and per-message timestamp styles
- Agregar patrocinio de tokens, ver 3D del grafo (Cerebro) y responder por correo desde Desk

### 2026-08-27 09:52 — main
- Agregar modo ventana desanclada, drag&drop en Sesiones y fix de cwd en runners de login
- Actualizar dependencias vendorizadas y mejoras varias en módulos internos

### 2026-08-12 11:06 — main
- Corrige credenciales de Codex login, refuerza captura de tickets en Tolkien y agrega carpetas de sesiones

### 2026-08-04 14:53 — main
- Agregar aliases de identidad y contexto operativo a Tolkien
- Agregar modo documento al chat, marcado semántico y skill tkt compartida

### 2026-08-04 09:28 — main
- Agregar módulo mcps y helper nativo de pageout (capa 5 de swap)

### 2026-08-03 22:39 — main
- Deriva CWC_PAD_URL de la IP ZeroTier y desacopla bus/mirror por SSH

### 2026-08-03 17:29 — main
- tkt: agregar reassign de tickets con dueño cambiado en Zoho y censo paralelo

### 2026-07-31 22:58 — main
- Agregar store SQLite local a Tolkien y módulo de visado de operaciones

### 2026-07-31 20:45 — main
- Sumar integración de Tolkien a Conexiones y mejorar /btw con --kind

### 2026-07-31 19:15 — main
- Aislar config de instancia por principal y endurecer reintentos/pool

### 2026-07-31 18:23 — main
- Agregar cierre masivo de tickets Tolkien y modo pregunta a la IA en salas

### 2026-07-31 16:54 — main
- Sumar mudanza de chat a sala de Aduana y aviso de origen en el hilo
- Aduana: identidad visual v2 (avatares, agrupación por autor, panel raw) y PAD del arquitecto
- Reemplazar PTY por spawn en login de GitHub y agregar respuesta con cita en sala
- Sumar skills impacto y probar, e integrar intención al flujo de anclaje/orquestación

### 2026-07-30 17:47 — main
- Sumar módulo Novedades y modernizar diagramas Mermaid con paleta

### 2026-07-29 20:04 — main
- Implementar facetas, migrar tasks→pendientes y mejorar herramientas Pad

### 2026-07-29 13:39 — main
- Aislar datos por usuario + runners Tolkien + gráficos inline

### 2026-07-29 05:50 — main
- Agregar soporte multi-tenant y catálogo de skills compartidas
- Aduana, papelera y pool común de lecciones

### 2026-07-28 02:42 — main
- Soportar multi-inquilino, mejorar onboarding, agrupar sesiones
- Agregar autenticación multi-tenant de Claude + UI adaptativa por rol

### 2026-07-27 04:25 — main
- Agregar entornos aislados de Tolkien con sub-bloques UI colapsables

### 2026-07-27 02:29 — main
- Verificar y sembrar contexto de Tolkien en entornos (PLAN-2072)

### 2026-07-26 23:54 — main
- Reparación Pad, verificación MC e higiene de lecciones

### 2026-07-26 18:46 — main
- Implementar sistema de anclaje y contraste de criterios (CONVE-1957)

### 2026-07-26 04:30 — main
- Implementar sistema de ayuda contextual unificado en toda la consola

### 2026-07-25 14:08 — main
- Actualizar Codex a gpt-5.6-sol + runners desacoplados + auditoría Pad

### 2026-07-24 22:23 — main
- Dividir CLAUDE.md monolítico en mapa + fichas descentralizadas

### 2026-07-24 19:40 — main
- Implementar entornos Tolkien efímeros por sesión (PLAN-1815)

### 2026-07-24 04:57 — main
- Integrar arquitectura en auditoría y workflows de creación de items
- Integrar módulo UniFi y refactorizar runners

### 2026-07-23 19:18 — main
- Integrar SharePoint y Unifi; refactor tokens/Codex; herramientas Pad

### 2026-07-22 21:41 — main
- Implementar escrituras a Desk con identidad del usuario (PLAN-781)
- Soportar custom fields y nombre visible de adjuntos en cwc-desk
- Monitorear trabajo en segundo plano, mejorar MCP y agregar keyring

### 2026-07-21 17:25 — main
- Corregir caída del server tras actualización de dependencias mayores
- Tándem por defecto, opus/high razonador, diff acotado

### 2026-07-21 06:12 — main
- Corregir Tándem inerte, agregar módulo Updates y conectores

### 2026-07-19 16:51 — main
- Integrar marca Mordor Staffing en login y splash

### 2026-07-19 16:29 — main
- Rediseño PLAN-752: módulo Salud con UI colapsable inline

### 2026-07-19 14:33 — main
- Añadir pestaña Skills y multi-tenant en terminal
- Feedback de clientes, i18n Fase 1, panel MCP y mejoras en métricas

### 2026-07-19 01:59 — main
- Aislar datos y credenciales por usuario en multi-tenant

### 2026-07-15 19:25 — main
- Implementar interfono consciente de paquetes-sesión (PLAN-469)
- Agregar tabla de tickets, WhatsApp, config instancia y publish
- Agregar modelo Tándem y selector rediseñado; robustez de sesión

### 2026-07-14 05:18 — main
- Implementar handoff de sesiones entre mundos (F1-F4)
- Refactor handoff: move in-place + paquete-sesión con refs

### 2026-07-14 00:17 — main
- Agregar AutoTux v4 y daemon WhatsApp; archivar comms board

### 2026-07-12 07:24 — redesign/board-mobile
- fix(tasks): evitar ráfaga de 429 contra Pad local en listTasks/listPlans
- Escaneo de Salud unificado: 1 botón que corre todo (Revisión+Optim+Coherencia+Pad)

### 2026-07-12 06:49 — redesign/board-mobile
- Migrar backend a PAD LOCAL (tareas/learning/tickets) + RETRO

### 2026-07-11 08:52 — redesign/board-mobile
- Implementar ROAD-76, auditoría B0-B5 y evaluación Pad

### 2026-07-11 05:57 — redesign/board-mobile
- Auditoría learning, imágenes/diagramas, sync Tolkien, git workflow

### 2026-07-10 17:13 — redesign/board-mobile
- Agregar learning module, chat attachments y AutoTux v2

### 2026-07-09 23:12 — redesign/board-mobile
- Ampliar tablero, análisis holístico y robustez en runners

### 2026-07-09 17:29 — redesign/board-mobile
- Agregar sistema de meta-tickets, análisis IA y chatbot derivado

### 2026-07-07 14:51 — redesign/board-mobile
- Compactar UI + confirmSheet adaptativa + tickets sin triar

### 2026-07-07 05:44 — redesign/board-mobile
- fix(sdk): cargar MCP de scope local en los chats (pad/honcho no aparecían)
- Modularizar tareas y audio, rediseñar barras laterales

### 2026-07-06 15:45 — redesign/board-mobile
- Implementar AutoTux, interfono global y flujos interactivos mejorados

### 2026-07-06 05:48 — redesign/board-mobile
- Motor de estados Pac-Man: catálogo central + fix de reactivación en TUI/interfono
- Migrar Salud, Bugs, Backup, Uso y Proyectos al motor Pac-Man
- Sumar leyenda del motor Pac-Man a la ayuda del chat
- Tablero Bugs & PRs: organizar en 3 subvistas (Tickets · Features · Archivados)
- bugfixes: el tablero se entera de PRs creados fuera del módulo Enviar PR
- Agregar motor Comunicaciones + módulo Coherencia

### 2026-07-05 18:21 — redesign/board-mobile
- Initial published version.

### 2026-07-05 18:07 — redesign/board-mobile
- Integración del Estándar Documental v1.0 (`docs/estandar-documental.md`): fuente única de convenciones documentales (idiomas por audiencia, plantillas de correo/informe/minuta, firmas de canales externos)
- CLAUDE.md: nueva regla dura #10 — leer el estándar antes de generar cualquier documento o publicar en un canal externo
- MEMORY.md: indexada la entrada del estándar
- Validación (sección 8 del estándar): 5 casos de prueba ejecutados — 4 cumplen, 1 desviación de contenido detectada (plantilla de informe técnico §4.2b sin sección "Resumen ejecutivo" pese a exigirla su propia regla dura), diagnosticada y propuesta sin aplicar
- Added `docs/estandar-documental.md`
- Modified `CLAUDE.md`

### 2026-07-04 05:57 — main
- Sistema nervioso F5 (cierre): loop que aprende — invariantes propuestos
- Salud F2.5: análisis en paralelo adaptativo (síntesis y auto-fix serial)
- CLAUDE.md: regla de oro — toda implementación sobrevive al reinicio de la web
- Salud/orquestador Fase A: gate de política — críticos no se auto-resuelven
- bugfixes: desacoplar la consulta a Zoho Desk en un runner detached
- bugfixes: refresh-prs paraleliza las lecturas a GitHub (orquestador de Salud)
- Salud/orquestador Fase B: resolución en batch — paralelo aislado + integración serial
- bugfixes: feedback de Chris como base de conocimiento del motor
- checkpoint: WIP del orquestador de salud (integracion batch) dejado por sesion paralela
- Salud/orquestador: fix auto-deadlock (pid:0), gate por severidad y Pac-Man por hallazgo
- Salud/orquestador: aprobar invariantes (glob→regex) + estado "falso positivo"
- Salud/auto-fix: resolución en batch de 20 hallazgos de la revisión
- bug-board: separar "tu acción pendiente" de "esperando a Chris" en el estado del PR
- Salud: falsos positivos quedan descartados y no se re-escanean (corta el bucle)
- Salud: invariantes aprendidos aprobados desde la UI (29 en total)
- Salud/auto-fix: 2do batch — 16 hallazgos resueltos (revisados)
- Salud: el auditor pasa de haiku a sonnet (auditModelFor, fuente única)
- bugs(sidebar): línea de resolución (completos/parciales/Desk) con íconos
- bugs(sidebar): pipeline de resolución SIEMPRE visible (dashboard)
- tokens: detalle del modal Uso por MOTOR de origen + animación precisa por modelo
- bugfixes: Fase 1 — botón "Investigar a fondo" de un PR (semáforo + IA)
- Chat: arreglar selecciones que "se cambiaban solas o no se tomaban"
- bug-board: Fase 2 — el PR abierto absorbe el/los TKT (fila-PR)
- users: endurecer contraseña mínima de 4 a 10 caracteres
- bugs: listener 'error' en el spawn del runner de triage
- Seguridad: igualar timing de verifyUser para usuarios inexistentes
- Modified `CLAUDE.md`
- Added `bin/cwc-health-resolve.js`
- Modified `bin/cwc-healthfix-orchestrator.js`
- Added `bin/cwc-ticket-investigate-runner.js`
- Modified `bin/cwc-triage-runner.js`
- Added `docs/task-bugfixes-branch-mode.md`
- Modified `public/css/style.css`
- Modified `public/js/modules/launcher/launcher.js`
- Modified `public/js/modules/system/backup-panel.js`
- Modified `public/js/modules/system/health-review-modal.js`
- Modified `public/js/modules/system/project-context-panel.js`
- Modified `public/js/modules/tolkien/bug-board.js`
- Modified `public/js/modules/tolkien/tolkien.js`
- Modified `public/js/ui/dialog.js`
- Modified `public/js/ui/markdown.js`
- Modified `public/js/ui/pacman.js`
- Modified `src/core/tmux.js`
- Modified `src/core/trash.js`
- Modified `src/modules/admin/index.js`
- Modified `src/modules/backup/index.js`
- Modified `src/modules/bugfixes/index.js`
- Added `src/modules/bugfixes/ticket-investigate-shared.js`
- Modified `src/modules/bugs/index.js`
- Modified `src/modules/bugs/shared.js`
- Modified `src/modules/chat/index.js`
- Modified `src/modules/files/index.js`
- Modified `src/modules/health/index.js`
- Modified `src/modules/health/invariants-learned.json`
- Modified `src/modules/health/shared.js`
- Modified `src/modules/health/worktree.js`
- Modified `src/modules/projects/index.js`
- Modified `src/modules/projects/memory.js`
- Modified `src/modules/stats/index.js`
- Modified `src/modules/terminal/index.js`
- Modified `src/modules/terminal/sessions.js`
- Modified `src/modules/tmux/index.js`
- Modified `src/modules/tolkien/index.js`

_(older entries trimmed — see `git log` for the full history)_

<!-- cwc:changelog:end -->

---

## Access model (read this first)

Security has **two layers**:

1. **ZeroTier network** — controls *who can even reach it*. The server
   binds **exclusively to the ZeroTier interface's IP** (never `0.0.0.0`).
   Only approved members of your ZeroTier network can open the page at all.
2. **Authentication** — controls *who gets in*:
   - **Username + password** (normal day-to-day use, comfortable on phone).
     Users are managed from ⚙ System → Users and stored scrypt-hashed in
     `users.json`.
   - **Master token** (`CWC_TOKEN` from `.env`) — admin/emergency key, also
     used to create the first user. Required as a cookie/header for HTTP
     and in the WebSocket handshake.

Served over **HTTPS** with a self-signed certificate bound to the ZeroTier
IP (required for the browser clipboard to work). The first time, each
device must **accept the certificate warning**.

### What NOT to do

- **Never** change the bind address to `0.0.0.0` or expose the port outside
  ZeroTier.
- **Never** commit `.env`, `users.json`, `sessions.json` or `certs/` (they
  are already in `.gitignore`).
- Don't disable token/user authentication "just to test".
- Don't touch the server's firewall or ZeroTier configuration.

---

## Requirements

- **Node.js** (tested with v24) and **npm**.
- **tmux** (3.2+ recommended; uses an isolated `cwc` socket, doesn't
  interfere with your personal tmux).
- **git** and **openssl** (for the tracked-project panel and the TLS cert).
- An already-configured **ZeroTier network** with its `zt*` interface up.

---

## Installation

### Guided setup (recommended for a fresh instance)

After cloning and `npm install`, run the interactive installer — it checks
requirements, generates `.env` (with a fresh master token), sets this
instance's identity, installs the systemd service, and creates the first admin:

```bash
cd ~/claude-web-console
npm install
node bin/cwc-setup.js          # guided wizard
# or just check requirements without changing anything:
node bin/cwc-setup.js --check
```

Add extra users later with `node bin/cwc-adduser.js <username> [--admin]`.

### Manual setup

```bash
cd ~/claude-web-console
npm install
cp .env.example .env
$EDITOR .env          # fill in CWC_TOKEN (see below)
```

Generate the master token:

```bash
openssl rand -hex 32   # paste the result into CWC_TOKEN
```

### `.env` variables

| Variable            | Description                                                               |
|---------------------|----------------------------------------------------------------------------|
| `CWC_TOKEN`         | **Required.** Master/admin token. Generate with `openssl rand -hex 32`.    |
| `CWC_PORT`          | Port (default `8092`). Served over HTTPS, bound only to the ZeroTier IP.   |
| `CWC_ZT_IFACE`      | ZeroTier interface (`zt...`). Empty = auto-detect the first `zt*`.         |
| `CWC_HOME`          | Root allowed for the file tree and terminals (default: your home).        |
| `CWC_TMUX_SOCKET`   | Isolated tmux socket (default `cwc`).                                     |
| `CWC_SCROLLBACK`    | In-memory scrollback lines per session (default `5000`).                  |
| `CWC_SESSION_DAYS`  | User session validity in days (default `30`).                             |
| `CWC_PROJECT_DIR`   | Main tracked project for the "Tolkien" panel (default `~/tolkien`).       |
| `CWC_PROJECT_NAME`  | Display name for that project (default `tolkien`).                        |

---

## Starting the server

**The normal mode is the already-installed, enabled user systemd service**
(survives reboots thanks to `loginctl enable-linger`):

```bash
systemctl --user status claude-web-console    # status
journalctl --user -u claude-web-console -f    # logs
systemctl --user restart claude-web-console   # restart
```

On startup it waits for the ZeroTier interface (won't crash if it isn't up
yet), generates the TLS certificate if missing, and listens on
`https://<zerotier-ip>:<port>`. Restoring a backup restarts the service on
its own (`Restart=on-failure`).

> **SSH for the tracked project's "Update":** under systemd the SSH agent
> isn't inherited automatically; it was imported once with
> `systemctl --user import-environment SSH_AUTH_SOCK`. **After a reboot**
> that socket stops existing until you start a new SSH session — reconnect
> and repeat the `import-environment` (or use a deploy key). Everything
> else works without the agent.

### Reinstalling the service (if needed)

```bash
cp systemd/claude-web-console.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now claude-web-console
loginctl enable-linger "$USER"
```

### Alternatives: by hand or inside tmux

```bash
npm start                                              # foreground
tmux new -s cwc-server 'cd ~/claude-web-console && npm start'
```

---

## Connecting

### From desktop

Open `https://<zerotier-ip>:8092` (e.g. `https://10.213.222.192:8092`). The
first time, the browser warns "not secure" (it's your self-signed cert):
accept it once.

### From Android (or another mobile device) over ZeroTier

1. Install **ZeroTier One**, join the network and wait for an admin to
   approve the device.
2. Open `https://<zerotier-ip>:8092` in the browser.
3. Accept the certificate warning (once per device).
4. Log in with your **username + password**.

**First boot (bootstrap):** there are no users yet. On the login screen,
expand *"Log in with master token"* and enter `CWC_TOKEN`. Then, in the
sidebar footer, tap **⚙ System → Users** and create your admin user. From
then on, log in with username + password.

---

## State observer (statusline + Claude Code hooks)

The "Sessions" cards show Claude's real status (● working / ○ idle) and its
current model, thanks to an observer installed into Claude Code's user
config (`~/.claude/settings.json`):

- **What it installs** (`node bin/install-observer.js`): a `statusLine`
  (shows "Model · ~folder" in every Claude Code session, including over
  SSH) and `UserPromptSubmit`/`Stop`/`SessionEnd` hooks, all pointing at
  `bin/cwc-observe.js`, which writes state to `~/.cwc-state/` (mode 700).
- **Additive**: it never overwrites someone else's statusline or hooks; it
  backs up the original to `settings.json.bak` the first time.
- **Uninstall**: `node bin/uninstall-observer.js` (removes exactly what was
  installed; everything else stays intact).
- Claude Code sessions that were already open start reporting only after
  they're restarted.
- Limitation: state is mapped to tmux sessions **by folder**; two Claude
  sessions in the same directory share state.

## The interface (organized by intent)

- **[＋ New session]** — the launcher, the one prominent action: type
  (**Chat** by default / Claude TUI / Terminal), model (remembers the
  last one), destination (Home, the tracked project, recent folders, or a
  breadcrumb browser) and, for Chat, **"Resume"** the folder's latest
  conversations.
- **Sessions** — cards with a human-readable name, a **real status** dot
  (● working / ○ idle, via the observer) and a color-coded model. New
  sessions get **unique names** automatically ("tolkien", "tolkien 1",
  "tolkien 2" — checked across chats *and* terminals). Tap to attach/focus;
  the ⋯ menu renames / switches model / kills (or, for a chat conversation,
  renames / switches Chat↔TUI / **switches model live** without losing
  context / closes). External tmux sessions live in a collapsed group.
- **Native chat (Agent SDK)** — conversation with bubbles, markdown and
  code with a copy button, collapsible tool calls with their result,
  **red/green diffs** (also inside the **Allow/Deny** permission card),
  permission modes (ask / accept edits / plan), a live model switch (from
  the session's ⋯ menu, no restart needed), per-turn cost, stop, and
  resume. Uses the **CLI's own subscription** (no separate API key or
  billing). The textarea supports **native voice dictation** on phone.
- **PTY terminal** — for the full Claude Code TUI, htop, vim: `tmux` on an
  isolated socket; survives disconnects and restarts (rehydration).
  **Scrollback history lives in tmux** (10,000 lines, reachable via
  touch/wheel scroll through copy-mode), so it isn't re-injected on reload.
- **Status footer** — CPU/RAM/disk gauges, **today's $** (→ the **Usage**
  modal with a per-project/per-model breakdown), Explorer, and
  **⚙ System** (Backup + Users + **Projects** + **Health** + Log out).
- **Explorer** (`/archivos`) — a Finder-style file manager: upload/download,
  zip folders and selections, a trash with 30-day purge, preview with
  syntax highlighting, and "Claude here / Terminal here" per folder.
- **Mobile** — an auxiliary key bar (Esc/Tab/⇧Tab/Ctrl/arrows), dictation,
  paste; copy = select text (OSC52), paste = right-click on desktop. The
  sidebar becomes a compact overlay (capped width, dimmed backdrop, tap
  outside to dismiss) instead of the fixed desktop panel, and drops the
  redundant open-tabs strip (the Sessions cards already cover that). The
  chat header has a tiny **Pac-Man** next to the title (pure CSS, no image):
  gray, mouth closed and still while waiting for your message; golden and
  chomping through a trail of dots while Claude is working — a real-time
  "alive vs. asleep" cue (deliberately exempt from reduced-motion, since
  it's a functional status indicator). The same Pac-Man doubles as the
  loader for every long-running operation (deep health review, bug triage,
  PR uploads, GitHub push, usage calculation) — if it's chomping, the
  process is alive.
- **Backups** — a full snapshot (`.tar.gz`, secrets included, **stays on
  the server**), restoring restarts the service on its own. Separately,
  **code backup to GitHub**: `git push` to the **`personal`** remote (your
  own private repo) with hard safety guards — never uploads
  `.env`/`users.json`/`sessions.json`/`certs/` and blocks any URL containing
  `Mordor-Staffing`. Brand-new (untracked) files never travel silently: the
  push dialog lists them with a checkbox each, so nothing new leaves the
  machine without explicit per-file approval (the backend re-validates the
  selection against the secrets list). Every successful push also refreshes this README's
  Changelog section and the repository's GitHub description. The inverse,
  **pull from GitHub**, restores the code from the remote: fetch +
  stash → fast-forward-only merge → stash pop (local work is never
  discarded, diverged histories are never forced), reruns `npm install`
  when the lockfile changed, and restarts the server on its own — only if
  the tree is clean. You configure the remote yourself:
  `git remote add personal git@github.com:<user>/<repo>.git`.
- **Health** (⚙ System → Health) — live quick checks (systemd/KillMode,
  tmux, chat runners, observer, cert, git, syntax of the whole codebase,
  disk, runtime data) and a **deep review powered by Claude**: a read-only
  headless SDK run that reads `CLAUDE.md` and audits the code (on demand,
  costs tokens, admin only). API: `GET /api/health/checks`,
  `GET|POST /api/health/review`.

---

## Adding a new module (repeatable pattern)

The backend is modular. Each module is an object with a standard shape:

```js
// src/modules/<name>/index.js
export default {
  name: '<name>',
  init(ctx) { /* optional: setup on mount */ },
  registerHttp(apiRouter, ctx) { /* routes under /api/<name>/... */ },
  registerWs(wss, ctx) { /* optional: wss.route('/ws/<name>', handler) */ },
};
```

Steps:

1. Create `src/modules/<name>/index.js` with that shape.
2. Add it to the `MODULES` array in `src/core/registry.js`.
3. (Frontend) add your UI under `public/js/modules/<name>/` and mount it
   from `public/js/main.js`.

The frontend has a mirrored pattern documented in
`docs/frontend-modules.md`. Zero changes to existing code: it's the same
pattern used by `terminal`, `files`, `stats`, `tokens`, `tmux`, `admin` and
`tolkien`.

---

## Troubleshooting

- **"Waiting for the ZeroTier interface..." and it never starts:**
  `zerotier-one` hasn't assigned an IP to the `zt*` interface yet. Normal
  after a reboot; the server keeps retrying on its own. Check with
  `ip -o -4 addr show | grep zt`.
- **The browser doesn't trust the certificate:** expected (self-signed).
  Accept it once per device. If the ZeroTier IP changed, delete `certs/`
  and restart to regenerate it.
- **Can't copy/paste:** requires HTTPS (already the case) and accepting
  the cert. On mobile, pasting goes through the 📋 button in the key bar;
  copying is done via touch selection.
- **Shift+Tab doesn't change Claude's permission mode:** make sure you're
  focused on the terminal (not the dictation field). On mobile use the
  ⇧Tab button in the key bar.
- **The tracked project's "Update" button fails on the network step:** the
  server has no access to the SSH agent (typical under systemd). See the
  SSH note above.
- **Locked out of login (429):** too many failed attempts from your IP;
  wait a few minutes or restart the server.
- **Port already in use:** change `CWC_PORT` in `.env`.

---

## Structure

```
src/
  server.js            bootstrap: ZeroTier + HTTPS + auth + mounts modules
  core/
    config.js           loads/validates .env
    auth.js              master token + persistent user sessions
    users.js             users (scrypt) in users.json
    tls.js                self-signed certificate
    zerotier.js          waits for / detects the ZeroTier interface
    wss.js                WebSocket router with handshake auth
    tmux.js               tmux socket utilities
    registry.js           mounts modules (repeatable pattern)
  modules/
    terminal/ files/ stats/ tokens/ tmux/ admin/ tolkien/ backup/
    chat/ tickets/ health/ bugfixes/
public/                frontend (vanilla HTML/CSS/JS + xterm.js)
systemd/               user unit
```

Generated files (never committed): `.env`, `users.json`, `sessions.json`,
`certs/`.
