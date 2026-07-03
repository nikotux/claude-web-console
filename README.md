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
