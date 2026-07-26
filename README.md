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

### 2026-07-03 23:23 — main
- Modified `CLAUDE.md`
- Modified `bin/cwc-healthfix-runner.js`
- Modified `public/css/style.css`
- Modified `public/js/modules/system/health-review-modal.js`
- Modified `public/js/modules/tolkien/bug-board.js`
- Modified `src/modules/health/index.js`
- Modified `src/modules/health/invariants.js`
- Modified `src/modules/health/shared.js`

### 2026-07-03 23:17 — main
- Salud: resolución de hallazgos de la revisión exhaustiva (19 fixes reales de 49)
- Salud: resolución autónoma por runner (auto-fix) + registro durable de resueltos
- Sistema nervioso F1: inventario determinístico del proyecto (censo vivo)
- Sistema nervioso F2: auditoría de salud INCREMENTAL por fingerprint
- Sistema nervioso F3: los chats de la consola consumen el inventario
- Sistema nervioso F4: invariantes verificables + foco en la auditoría de salud
- Modified `CLAUDE.md`
- Modified `public/css/style.css`
- Modified `public/js/modules/tolkien/bug-board.js`
- Added `src/modules/bugfixes/engine.js`
- Modified `src/modules/bugfixes/index.js`

### 2026-07-03 21:10 — main
- Salud/revisión: resolución autónoma (acceptEdits) + hallazgos colapsables en móvil
- Modified `CLAUDE.md`
- Modified `public/css/style.css`
- Modified `public/js/modules/tolkien/bug-board.js`
- Modified `src/core/auth.js`
- Modified `src/modules/backup/index.js`
- Modified `src/modules/bugfixes/index.js`
- Modified `src/modules/bugs/index.js`
- Modified `src/modules/bugs/shared.js`
- Modified `src/modules/tmux/index.js`

### 2026-07-03 20:41 — main
- Modified `public/js/modules/system/health-review-modal.js`

### 2026-07-03 20:30 — main
- Chat móvil: burbujas a ancho (casi) completo, sin columna muerta a la derecha
- Sidebar: ☰ y Nueva sesión comparten fila (fuera el espacio muerto)
- Centro Bugs & PRs: tablero unificado del ciclo del bug con GitHub en vivo y Desk
- Bugfixes: GET /desk-live/:n — estado en vivo del ticket de Zoho Desk (read-only)
- Sidebar: rename tickets->bugs, seccion "Bugs & Features" y Tolkien informativo
- Bugs & PRs: resolución parcial/completo (merge ≠ resuelto) + sección Archivo
- Sidebar visual: Tolkien y Bugs & Features iconicos + boton Buscar cambios
- Modified `CLAUDE.md`
- Added `bin/cwc-health-runner.js`
- Modified `public/js/modules/system/health-panel.js`
- Added `public/js/modules/system/health-review-modal.js`
- Modified `src/modules/health/index.js`
- Added `src/modules/health/shared.js`

### 2026-07-03 18:01 — main
- Chat: sintaxis de editor en los detalles expandidos de tool calls
- Chat: vista de editor en el código expandido — indentación real, sin wrap
- Modified `CLAUDE.md`
- Modified `public/js/modules/tolkien/tolkien.js`
- Modified `src/modules/bugfixes/index.js`
- Modified `src/modules/bugfixes/store.js`

### 2026-07-03 15:52 — main
- Chat: solicitud de permiso compacta (chip + botones), sin desborde en móvil
- Modified `CLAUDE.md`
- Modified `public/js/modules/chat/chat-tab.js`
- Modified `public/js/modules/tolkien/tolkien.js`
- Modified `src/modules/bugfixes/index.js`
- Modified `src/modules/bugfixes/store.js`

### 2026-07-03 13:27 — main
- Modified `CLAUDE.md`

### 2026-07-03 07:26 — main
- Chat: modo 'Todo' (bypassPermissions) + selector de modos compacto por riesgo
- Auto-título con IA: la sesión se renombra sola (≤20 chars) según lo que hace
- Móvil: la barra auxiliar (botón ⌨ incluido) se oculta en la vista Chat
- Chat: chips de ejecución solo con íconos + leyenda en el modal de ayuda
- Modified `CLAUDE.md`
- Modified `public/js/modules/system/project-context-panel.js`
- Modified `src/modules/projects/index.js`

### 2026-07-03 07:07 — main
- Header del chat: fuera costo y botón TUI; '?' que explica los modos de permisos
- Modified `CLAUDE.md`
- Modified `public/css/style.css`
- Modified `public/js/modules/chat/chat-tab.js`
- Modified `public/js/modules/system/project-context-panel.js`
- Modified `src/modules/chat/shared.js`
- Modified `src/modules/projects/index.js`
- Modified `src/modules/projects/memory.js`

### 2026-07-03 06:55 — main
- Modified `CLAUDE.md`
- Modified `public/css/style.css`
- Modified `public/js/modules/system/project-context-panel.js`

### 2026-07-03 06:49 — main
- CLAUDE.md: Salud sin bugfixes (UI única en el modal Enviar PR de Tolkien)

### 2026-07-03 06:44 — main
- Uso de tokens: vista por MODELO con desplegable de últimos 3 proyectos
- Uso: límites del plan (claude.ai) y Pac-Man por modelo consumiendo ahora
- Splash de arranque con Pac-Man y textos de progreso reales
- Splash: esperar el render REAL del historial del chat activo antes de destapar
- Splash: barra de progreso 0→100 por hitos reales del arranque
- Modified `CLAUDE.md`
- Added `bin/cwc-triage-runner.js`
- Modified `public/js/modules/system/health-panel.js`
- Modified `public/js/modules/tickets/tickets.js`
- Modified `public/js/modules/tolkien/tolkien.js`
- Modified `src/modules/tickets/index.js`
- Added `src/modules/tickets/shared.js`

### 2026-07-03 06:20 — main
- Modified `CLAUDE.md`
- Modified `src/modules/tokens/index.js`

### 2026-07-03 06:19 — main
- Deleted `docs/test-untracked.md`

### 2026-07-03 06:18 — main
- Sesiones: Pac-Man de estado en las tarjetas del sidebar
- Added `docs/test-untracked.md`
- Modified `public/js/modules/system/backup-panel.js`
- Modified `src/modules/backup/index.js`

### 2026-07-03 06:14 — main
- Modified `CLAUDE.md`
- Modified `public/css/style.css`
- Added `public/js/modules/system/project-context-panel.js`
- Modified `public/js/modules/usage/usage.js`
- Added `public/js/ui/pacman.js`
- Added `src/core/session-names.js`
- Added `src/modules/projects/index.js`
- Added `src/modules/projects/memory.js`
- Modified `src/modules/tokens/index.js`

### 2026-07-03 06:11 — main
- Lanzador móvil: modal alcanzable (88dvh) y Retomar compacto con modal Ver más
- Chat: re-anclar el scroll al final al volver a una pestaña oculta
- Lanzador: 'Abrir en' compacto — 3 recientes + Ver más al lado de Elegir carpeta
- Modified `CLAUDE.md`
- Modified `bin/cwc-chat-runner.js`
- Modified `public/js/modules/sessions/sessions.js`
- Modified `public/js/modules/system/backup-panel.js`
- Modified `public/js/modules/system/health-panel.js`
- Modified `public/js/modules/tickets/tickets.js`
- Modified `public/js/modules/tolkien/tolkien.js`
- Modified `public/js/modules/usage/usage.js`
- Modified `src/modules/backup/index.js`
- Modified `src/modules/terminal/index.js`
- Modified `src/modules/tmux/index.js`

### 2026-07-03 02:22 — main
- Modified `CLAUDE.md`
- Modified `public/css/style.css`
- Modified `public/index.html`
- Modified `public/js/main.js`
- Modified `public/js/modules/system/system.js`
- Modified `public/js/modules/tickets/tickets.js`
- Modified `public/js/modules/tolkien/tolkien.js`
- Modified `src/core/registry.js`
- Modified `src/modules/tolkien/index.js`

### 2026-07-03 01:09 — main
- Modified `CLAUDE.md`

### 2026-07-03 01:09 — main
- Modified `CLAUDE.md`
- Modified `package-lock.json`
- Modified `package.json`
- Modified `public/css/ui.css`
- Modified `public/js/modules/system/backup-panel.js`
- Modified `src/modules/backup/index.js`

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

Open `https://<zerotier-ip>:8092` (e.g. `https://10.213.222.62:8092`). The
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
