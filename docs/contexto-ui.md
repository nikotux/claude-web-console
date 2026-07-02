# Claude Web Console — Contexto técnico para rediseño de UI

> Documento de contexto para asesoría externa de rediseño de interfaz.
> Generado el 2026-07-02 analizando el código real del proyecto.
> Proyecto: `~/claude-web-console` (~5.000 líneas propias, sin contar `node_modules`).
>
> **Qué es**: consola web personal para trabajar con Claude Code desde el navegador
> (desktop y celular) a través de una red ZeroTier, sin cliente SSH. Terminal real
> (PTY + tmux + xterm.js) más paneles satélite: gestor de archivos, tokens/costos,
> control de tmux, estado del proyecto principal (git), backups, usuarios y
> monitoreo de sistema.
>
> **Importante**: el proyecto **no está bajo git** (no hay repo inicializado). El
> mecanismo de versionado/red de seguridad actual es el módulo de backups (tar.gz
> completos en `~/.cwc-backups/`).

---

## 1. Inventario de módulos

La app tiene una arquitectura modular explícita en backend: cada módulo exporta
`{ name, init(ctx), registerHttp(apiRouter, ctx), registerWs(wss, ctx) }` y se
monta desde `src/core/registry.js` (array `MODULES`). El frontend espeja esa
estructura en `public/js/modules/<nombre>/` pero el cableado es manual en
`public/js/main.js` (no hay auto-registro en el cliente).

### 1.1 Terminal (el corazón)

| | |
|---|---|
| **Qué hace** | Terminales reales en el navegador. Cada pestaña = una sesión tmux en socket aislado (`-L cwc`) envuelta por un node-pty que actúa de viewport. Persistencia doble: sobrevive a desconexión del navegador (reconexión WS + ring buffer) y a reinicio de Node (rehidratación desde `tmux list-sessions`). |
| **Backend** | `src/modules/terminal/index.js` (rutas), `src/modules/terminal/sessions.js` (clase `Session` + `SessionManager`), `src/modules/terminal/tmux.cwc.conf` (config del servidor tmux dedicado). |
| **Frontend** | `public/js/modules/terminal/terminal.js` (clase `TerminalTab`: xterm + addons fit/web-links/clipboard, reconexión, scroll táctil, Ctrl armado, pegar con click derecho). |
| **HTTP** | `GET /api/terminal/sessions` (lista), `POST /api/terminal/sessions` (crea; body `{cwd?, runClaude?, title?, attach?:{socket,session}}`), `GET /api/terminal/model?id=` (modelo de Claude en uso, ver §4). |
| **WebSocket** | `wss://…/ws/terminal?id=<id>`. Cliente→servidor: frames de texto JSON `{type:'input',data}` y `{type:'resize',cols,rows}`. Servidor→cliente: frames **binarios** = salida cruda del PTY; frames de texto JSON = control (`{type:'exit'}`, `{type:'error',message}`). Al adjuntar, el servidor reenvía el ring buffer completo como un frame binario (replay). |
| **Depende de** | `src/core/tmux.js` (validación socket/nombre para attach externo), `src/core/claude-model.js` (endpoint de modelo), `src/core/config.js`. |
| **Lo usan** | El módulo tmux (adjuntar sesión externa se hace vía `POST /api/terminal/sessions` con `attach`), y los paneles Archivos/Tolkien del sidebar (abrir terminal/Claude ahí). |

### 1.2 Archivos (API) + Gestor de Archivos (página)

| | |
|---|---|
| **Qué hace** | API de archivos (listar, leer, subir, descargar, zip, mkdir, renombrar, papelera) + una subpágina completa estilo Finder (`/archivos`) que es **el único navegador de archivos de la app** (los árboles del sidebar se eliminaron en el último rediseño). |
| **Backend** | `src/modules/files/index.js` (todas las rutas), `src/core/paths.js` (`resolveWithinHome`, anti path-traversal), `src/core/trash.js` (papelera con purga automática a 30 días en `~/.cwc-trash/`). |
| **Frontend** | `public/archivos.html` + `public/js/filemanager/fm.js` (489 líneas: estado, vistas grilla/lista, breadcrumb, drag&drop, selección múltiple, preview con highlight.js, menú contextual, papelera) + `public/css/fm.css`. |
| **HTTP** | `GET /api/files/list?path=&hidden=`, `GET /api/files/read?path=` (texto ≤2 MiB, sniff de binarios), `GET /api/files/raw?path=` (inline, para previews de imagen/video/pdf), `GET /api/files/download?path=`, `GET /api/files/download-zip?path=` (carpeta), `POST /api/files/zip {paths[]}` (selección múltiple), `POST /api/files/upload?path=` (multipart, multer, 5 GiB máx), `POST /api/files/mkdir`, `POST /api/files/rename`, `POST /api/files/trash`, `GET /api/files/trash`, `POST /api/files/trash/restore`, `POST /api/files/trash/purge`. |
| **Deep-link** | `/archivos?path=<rel>` abre directamente en esa carpeta (lo usan los botones "Explorar" del sidebar). |
| **Depende de** | `src/core/paths.js`, `src/core/trash.js`. Consulta `GET /api/tolkien/status` solo para rotular el favorito "Proyecto". Usa `public/js/ui/icons.js`. |

### 1.3 tmux (control de sesiones)

| | |
|---|---|
| **Qué hace** | Lista TODAS las sesiones tmux del usuario (todos los sockets en `/tmp/tmux-<uid>/`), permite adjuntarlas como pestaña, matarlas, y **elegir el modelo de Claude por sesión** (dropdown que inyecta `/model <x>` vía `send-keys`). Muestra el modelo en uso con banderín de color. |
| **Backend** | `src/modules/tmux/index.js`, `src/core/tmux.js` (enumeración de sockets, ejecución sin heredar `$TMUX`, validaciones anti-inyección). |
| **Frontend** | `public/js/modules/tmux/tmux.js`. |
| **HTTP** | `GET /api/tmux/sessions` (incluye `model` por sesión, resuelto por cwd), `POST /api/tmux/kill {socket,session}`, `POST /api/tmux/set-model {socket,session,model}` (modelos válidos: `opusplan`, `opus`, `sonnet`, `haiku`, `default`). |
| **Depende de** | módulo terminal (adjuntar = `POST /api/terminal/sessions {attach}`), `src/core/claude-model.js` (modelo por sesión). |

### 1.4 Tokens (uso y costo de Claude Code)

| | |
|---|---|
| **Qué hace** | Calcula uso y costo de tokens leyendo los transcripts `~/.claude/projects/*/*.jsonl` (deduplica por `message.id`, precios oficiales por modelo, caché 1h=2×/5m=1.25×/lectura=0.1× del precio de input). Muestra: total global + hoy (pie fijo del sidebar) y desglose por proyecto con barra apilada por modelo + panel expandible con detalle exacto. |
| **Backend** | `src/modules/tokens/index.js` (caché por archivo según mtime+size; caché del summary 4 s). |
| **Frontend** | `public/js/modules/tokens/tokens.js` (poll 15 s, pausado con `document.hidden`). |
| **HTTP** | `GET /api/tokens/summary` → `{totals, today, projects[{name,label,tokens,cost,lastMtime,input,output,cacheWrite,cacheRead,models[{model,tokens,cost}]}], updatedAt}`. |
| **Depende de** | Nada interno (lee el filesystem de Claude Code directamente). Módulo de solo lectura, totalmente independiente. |

### 1.5 Stats (sistema)

| | |
|---|---|
| **Qué hace** | Gauges de CPU (delta de `os.cpus()`), RAM (`/proc/meminfo`), disco (`fs.statfs`), carga, uptime, hostname. Siempre visibles en el pie del sidebar. |
| **Backend** | `src/modules/stats/index.js`. |
| **Frontend** | `public/js/modules/stats/stats.js` (poll 2.5 s, pausado en background). |
| **HTTP** | `GET /api/stats`. |
| **Depende de** | Nada. Totalmente independiente. |

### 1.6 Tolkien (proyecto principal, git)

| | |
|---|---|
| **Qué hace** | Estado git del monorepo `~/tolkien` (SHA corto, al día/N detrás, cambios locales) + actualización segura desde GitHub (stash → pull --ff-only → stash pop; nunca destruye trabajo sin commitear). Acciones rápidas: abrir terminal/Claude en el proyecto, explorar en el Gestor de Archivos. Chequeo automático cada 5 min. |
| **Backend** | `src/modules/tolkien/index.js` (configurable vía `CWC_PROJECT_DIR`/`CWC_PROJECT_NAME`). |
| **Frontend** | `public/js/modules/tolkien/tolkien.js` (sección del sidebar + mini-bloque del pie). |
| **HTTP** | `GET /api/tolkien/status` (local, sin red), `POST /api/tolkien/fetch`, `POST /api/tolkien/update`. |
| **Depende de** | El **agente SSH** del proceso para fetch/pull (ver §8). El frontend usa `openTerminal` de main.js. |

### 1.7 Backup

| | |
|---|---|
| **Qué hace** | Snapshot tar.gz de todo el proyecto (sin `node_modules`, ~140 KB) en `~/.cwc-backups/` (modo 700, fuera del proyecto). Restaurar extrae sobre el proyecto y **reinicia el server automáticamente** (bajo systemd: exit y `Restart=on-failure`; manual: helper bash desacoplado). El frontend espera el reinicio (poll a `/api/whoami`) y recarga. |
| **Backend** | `src/modules/backup/index.js` (solo administradores). |
| **Frontend** | `public/js/modules/backup/backup.js` (modal `#backup-modal` en `public/index.html`). |
| **HTTP** | `GET /api/backup/list`, `POST /api/backup/create`, `POST /api/backup/restore {id}`, `POST /api/backup/delete {id}`. |
| **Depende de** | `src/core/auth.js` (`isAdmin`). Independiente del resto. |

### 1.8 Admin (usuarios)

| | |
|---|---|
| **Qué hace** | CRUD de usuarios (crear, cambiar contraseña, rol admin, eliminar). Página propia `/admin`, gateada a administradores. |
| **Backend** | `src/modules/admin/index.js`, `src/core/users.js` (scrypt, persistencia en `users.json` modo 600). |
| **Frontend** | `public/admin.html` + `public/js/admin.js`. |
| **HTTP** | `GET/POST /api/admin/users`, `PUT/DELETE /api/admin/users/:username`. |
| **Depende de** | `src/core/auth.js`, `src/core/users.js`. |

### 1.9 Infraestructura transversal (no son "módulos" pero definen la app)

- **Auth** — `src/core/auth.js`: dos credenciales válidas en HTTP **y** en el
  handshake WS: sesión de usuario (cookie `cwc_session`, persistida en
  `sessions.json`, TTL `CWC_SESSION_DAYS`=30) y token maestro (`CWC_TOKEN` del
  `.env`, cookie/header/Bearer, siempre admin). Rutas en `src/server.js`:
  `POST /login`, `POST /logout`, `GET /api/whoami`. Throttle de login por IP
  (8 fallos/5 min → 429). Cookies `HttpOnly; Secure; SameSite=Strict`.
- **WS router** — `src/core/wss.js`: un `WebSocketServer` en modo `noServer`;
  valida auth en el evento `upgrade` **antes** de aceptar el socket; despacha
  por prefijo de path (`wss.route(prefix, handler)`). `permessage-deflate` con
  umbral 512 bytes.
- **TLS** — `src/core/tls.js`: certificado self-signed autogenerado en `certs/`
  atado a la IP ZeroTier (SAN `IP:<ip>`); se regenera si la IP cambia.
- **ZeroTier** — `src/core/zerotier.js`: detección/espera de la interfaz `zt*`
  con reintentos (el server hace bind EXCLUSIVO a esa IP, nunca `0.0.0.0`).
- **Íconos** — `public/js/ui/icons.js`: 25 íconos SVG de trazo
  (`icon(name)` / `hydrateIcons()` para `[data-icon]` en HTML estático).
- **Tokens de diseño** — `public/css/tokens.css`: variables `--cwc-*`
  compartidas por las 4 páginas.
- **Detección de modelo** — `src/core/claude-model.js` (ver §4).

---

## 2. Mapa de navegación actual

La app tiene **4 páginas** (navegación completa de documento, misma pestaña del
navegador) y dentro de la principal, un modelo de **acordeón + modales** (no hay
router SPA ni hash-routing; el estado de navegación no es enlazable salvo el
deep-link `/archivos?path=`).

```
https://<ip-zerotier>:8092
│
├── /login ······················· página (usuario+contraseña; token maestro plegado en <details>)
│
├── /  (CONSOLA PRINCIPAL) ─ public/index.html
│   │
│   ├── SIDEBAR IZQUIERDO (#sidebar, 260px, colapsable con ☰;
│   │   │                  en móvil: overlay 78vw, arranca oculto)
│   │   │
│   │   ├── ACORDEÓN (todas las secciones arrancan COLAPSADAS; una no cierra
│   │   │   │         a las otras — pueden estar varias abiertas a la vez)
│   │   │   ├── 1. Archivos ········ panel de acciones: [Terminal] [Claude] [Explorar→/archivos]
│   │   │   ├── 2. Tolkien ········· chip estado git (✓/↓N) + herramientas (actualizar, fetch)
│   │   │   │                        + acciones: [Terminal] [Claude] [Explorar→/archivos?path=tolkien]
│   │   │   ├── 3. tmux ············ contador + lista de sesiones por socket; cada fila:
│   │   │   │                        info (● nombre cwd) / acciones DEBAJO [Adjuntar][Matar]
│   │   │   │                        / modelo en uso (banderín color) / dropdown de modelo
│   │   │   └── 4. Tokens por proyecto ·· filas con barra apilada por modelo;
│   │   │                            clic en fila → expande detalle inline (no modal)
│   │   │
│   │   └── PIE FIJO (siempre visible, no scrollea)
│   │       ├── gauges sistema (CPU/RAM/Disco + hostname/carga/uptime)
│   │       ├── total tokens global + costo + "hoy"
│   │       ├── Tolkien mini (nombre #SHA · estado · botón Actualizar)
│   │       └── fila de cuenta: [Archivos→página] [Backup→MODAL] [Usuarios→página,
│   │           solo admin] · usuario · [Salir]
│   │
│   ├── CENTRO (#terminals) ······· panes de terminal apilados; solo el activo visible
│   │
│   ├── RAIL DERECHO (#rail, 46px, vertical, siempre visible)
│   │   ├── ☰ (toggle sidebar)
│   │   ├── chips de pestañas (iniciales 2 letras; activa resaltada con ×;
│   │   │   banderín de color inferior = modelo de Claude en uso, poll 8s)
│   │   └── ＋ (nueva terminal en el home)
│   │
│   ├── BARRA INFERIOR (#auxbar; solo móvil/táctil: @media ≤768px o pointer:coarse)
│   │   └── tirador ⌨ (colapsada por defecto) → despliega:
│   │       ├── fila de dictado (oculta hasta tocar "abc"): input + ⏎ + Enviar
│   │       └── teclas: Esc Tab ⇧Tab Ctrl ↑ ↓ ← → ^C 📋(pegar) abc(dictado)
│   │
│   └── MODALES de la consola
│       └── #backup-modal ········· crear backup + lista (fecha/hora) + restaurar/eliminar
│
├── /archivos  (GESTOR DE ARCHIVOS) ─ public/archivos.html   [página completa]
│   ├── toolbar: ‹atrás · breadcrumb ⌂›…  |  grilla/lista · Subir · Carpeta · ⟳ · ⌂(→ /)
│   ├── sidebar propio: Favoritos (Home, ◈Proyecto) / Sistema (Papelera + contador)
│   ├── área principal: grilla de iconos o lista detallada; drag&drop para subir
│   ├── barra de estado: nº ítems · selección
│   ├── MODAL preview (#fm-preview): imagen/video/audio/pdf/código con resaltado
│   └── menú contextual (#fm-ctx): abrir/previsualizar/descargar/renombrar/eliminar
│       (con selección múltiple: descargar N como zip / eliminar N)
│
└── /admin  (USUARIOS) ─ public/admin.html   [página completa, solo admin]
    └── form crear usuario + lista con acciones (admin/contraseña/eliminar)
```

**Qué abre qué**: `/archivos` y `/admin` son **navegaciones de página completa**
(se pierde el contexto visual de la consola; volver = link "⌂"/"volver").
Backup y el preview del gestor son **modales**. El detalle de tokens es
**expansión inline**. Las secciones del sidebar son **acordeón**. Los `confirm()`
y `prompt()` nativos del navegador se usan para todas las confirmaciones
(matar sesión, restaurar backup, eliminar, renombrar, nueva carpeta) — no hay
componente propio de diálogo.

---

## 3. Sistema de diseño actual (y sus huecos)

### 3.1 Tokens formales (existen desde el último rediseño)

`public/css/tokens.css` define variables `--cwc-*` que cargan las 4 páginas:

| Grupo | Variables |
|---|---|
| Fondos | `--cwc-bg #0b0e14` · `--cwc-bg-panel #0d1119` · `--cwc-bg-elevated #11151f` · `--cwc-bg-hover #141a26` · `--cwc-bg-input #0b0e14` |
| Bordes | `--cwc-border #1e2431` · `--cwc-border-soft #232b3a` · `--cwc-border-strong #2a3040` |
| Texto | `--cwc-text #c5c8c6` · `--cwc-text-secondary #9aa4b2` · `--cwc-text-dim #7c8494` · `--cwc-text-dimmer #566072` |
| Acento | `--cwc-accent #d97757` (terracota "Claude orange") · `--cwc-accent-bg #2a2018` · `--cwc-accent-ink #1a1000` |
| Estados | `--cwc-ok #6c9e6e` · `--cwc-warn #c9a94e` · `--cwc-danger #cd5c5c` · `--cwc-danger-strong #ff453a` |
| Radios | `--cwc-radius-sm 5px` · `--cwc-radius-md 8px` · `--cwc-radius-lg 12px` |
| Fuentes | `--cwc-font-ui` (system-ui stack) · `--cwc-font-mono` (ui-monospace stack) |
| Íconos | `--cwc-icon-size 18px` · `--cwc-icon-stroke 1.8` |

Los íconos de acción/navegación son un sistema único (`public/js/ui/icons.js`,
SVG stroke `currentColor`). Los íconos de **tipo de archivo** del gestor
(carpeta azul, documento coloreado por extensión con badge) son deliberadamente
un segundo sistema, más rico (como Finder/VS Code).

### 3.2 Inconsistencias reales (honestas)

La tokenización fue **parcial** — se migró el acento y lo estructural, pero:

1. **Hex hardcodeados conviven con las variables.** En `public/css/style.css`
   quedan ~20 valores repetidos sin tokenizar: `#1c2130` (fondo de chips,
   gauges, botones secundarios — 7 usos), `#161c28` (divisores — 5 usos),
   `#1a2130` (otros divisores), y todos los colores de texto/bordes que sí
   tienen variable se usan a veces como variable y a veces como hex literal.
2. **Tres rojos distintos para "error/peligro"**: `--cwc-danger #cd5c5c`
   (botones), `--cwc-danger-strong #ff453a` (gestor), y `#ff6b6b` (mensajes de
   error en login/admin/tmux/tokens — 4 usos, no está en tokens.css).
3. **Colores de modelo de IA duplicados en 2 lugares**: la paleta
   Opus `#b57edc` / Sonnet `#4e8fd1` / Haiku `#6cb06c` / Fable `#d9925a` vive
   hardcodeada en `src/core/claude-model.js` (backend, función `describe()`) y
   **otra vez** en `public/js/modules/tokens/tokens.js` (`modelColor()`). No
   están en tokens.css ni comparten fuente. Riesgo real de divergencia.
4. **Unidades de fuente mezcladas**: `style.css` usa **rem** (16 tamaños
   distintos: de `.66rem` a `1.2rem` — .66/.68/.7/.72/.74/.75/.78/.8/.82/.85/
   .9/.95/1/1.05/1.1/1.2); `fm.css` usa **px** (8.5/11/11.5/12/12.5/13/15px).
   No hay escala tipográfica: hay valores ad-hoc por componente.
5. **Radios sin consolidar en fm.css**: aunque existen los tokens 5/8/12px,
   fm.css todavía usa 0/5/6/7/9/10/12/14px según el componente.
6. **`--tok-fill` fallback azul huérfano**: `.tok-fill` en style.css conserva
   `background:#4e7fb0` como fondo por defecto de la barra de tokens (tapado
   por los segmentos apilados, pero visible si un proyecto no trae `models`).
7. **fm.css re-declara su propio `:root`** que *mapea* a los tokens
   (`--bg: var(--cwc-bg-elevated)`, etc.). Funciona, pero significa que el
   gestor tiene una capa de indirección propia (`--bg`, `--panel`, `--accent`)
   distinta del resto (`--cwc-*`). Dos vocabularios para lo mismo.
8. **Interacciones nativas sin estilizar**: `confirm()`/`prompt()`/`alert()`
   del navegador se usan en ~15 puntos (tmux kill, backups, papelera, rename,
   mkdir, tolkien update...). Rompen la estética por completo y en móvil son
   especialmente feos. Es probablemente la mayor deuda visual.
9. **Sin estados de carga consistentes**: cada módulo inventa el suyo
   ("cargando…", opacidad `.fm-uploading`, botón deshabilitado con "…").

### 3.3 Tipografías

- UI: system stack (`-apple-system, "SF Pro Text", BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif`).
- Monoespaciada: `ui-monospace, "SF Mono", Menlo, Consolas, monospace` (terminal, chips del rail, SHA, previews de código).
- La terminal xterm usa su propia config en JS (`terminal.js`: `fontSize: 14`,
  familia mono propia) — no lee los tokens CSS.

---

## 4. Modelo de datos de sesiones

### 4.1 Backend (`src/modules/terminal/sessions.js`)

```
Session {
  id: "<pid>-<seq>"          // pid del proceso Node + contador (sin aleatoriedad)
  tmuxName: "cwc-<id>"       // nombre de la sesión tmux real (socket -L cwc)
  cwd: string                // absoluto; validado dentro del home al crear
  title: string              // basename del cwd o "terminal"/"claude:<dir>"
  cols, rows: number         // último resize recibido
  buffer: string[]           // ring buffer de salida (~scrollback*120 bytes)
  clients: Set<WebSocket>    // navegadores adjuntos (puede ser >1)
  proc: node-pty             // envuelve `tmux new-session -A` o `attach -d`
  alive: boolean
  attachSpec: {socket, session} | null  // si envuelve una sesión tmux EXTERNA
}
```

- **Creación**: `tmux -L cwc new-session -A -s cwc-<id> -c <cwd>` dentro de un
  node-pty. `-A` = idempotente (adjunta si existe), que es también el mecanismo
  de **rehidratación**: al arrancar Node se escanea `tmux -L cwc list-sessions`
  y se reconstruye un `Session` por cada `cwc-*` viva (`rehydrate()`).
- **Adjuntar sesión externa** (desde el panel tmux): `attach-session -d`
  (desadjunta a otros clientes → evita la "guerra de resize" de tmux).
- **`runClaude: true`** simplemente escribe `claude\r` en el pty tras crear.
- Lo que viaja al frontend (`info()`): `{id, title, cwd, alive}` — nada más.

### 4.2 Sesiones tmux en el panel de control (`src/modules/tmux/index.js`)

`GET /api/tmux/sessions` enumera **todos** los sockets (`/tmp/tmux-<uid>/*`) y
devuelve por sesión:

```
{ socket, socketName, name, windows, attached, created, cwd,
  owned,   // true si es del socket cwc con prefijo "cwc-" (creada por la consola)
  model }  // {id, name, color} | null — modelo de Claude en uso (ver 4.3)
```

### 4.3 Detección del modelo en uso (`src/core/claude-model.js`)

- **Cómo**: se codifica el `cwd` de la sesión al formato de directorio de
  Claude Code (`abs.replace(/[^A-Za-z0-9]/g,'-')`), se busca en
  `~/.claude/projects/<encoded>/` el transcript `.jsonl` **más recientemente
  modificado**, se leen los últimos 64 KB y se toma el último
  `"model":"claude-…"` que aparezca. Cache de 3 s por cwd.
- **Dónde se muestra**: banderín de color bajo cada chip del rail (poll 8 s,
  `main.js:updateModelFlag`) y etiqueta coloreada + dropdown en cada fila del
  panel tmux (refresh in-place 8 s).
- **Limitaciones honestas**:
  1. Es una inferencia **por cwd**, no por proceso: si el usuario hace `cd` a
     otra carpeta dentro de la terminal y corre `claude` ahí, el banderín lee
     el proyecto equivocado. Si dos sesiones comparten cwd, comparten banderín.
  2. Refleja el modelo de la **última respuesta**, no el configurado para la
     próxima (si se cambió con `/model` y aún no respondió, hay desfase).
  3. Latencia de hasta ~8 s (polling).

### 4.4 Estado "activa / esperando / trabajando": **NO EXISTE**

Hoy no se detecta en absoluto si Claude Code dentro de una sesión está
generando, esperando un permiso, o idle. Lo único que hay es:

- `attached` de tmux = *hay un cliente tmux adjunto* (casi siempre true porque
  el propio server es un cliente). **No** indica actividad de Claude.
- El punto ●/○ del panel tmux refleja ese `attached`, nada más.

Para un rediseño que quiera mostrar estado real por sesión, las opciones
técnicas conocidas son: (a) analizar la cola del transcript (rol del último
mensaje + timestamps → "respondió hace X" / "hay un turno de usuario sin
respuesta" ≈ trabajando), (b) configurar la **statusline** de Claude Code
(recibe JSON con modelo y contexto por stdin — verificado en docs oficiales) y
capturarla, o (c) hooks de Claude Code (`UserPromptSubmit`, `Stop`) escribiendo
a un archivo que el server lea. Ninguna está implementada.

---

## 5. Flujos de usuario actuales (con conteo de interacciones)

Convención: clic/tap = 1; escribir texto no se cuenta como clic pero se señala.

**(a) Abrir Claude Code en una carpeta NUEVA (arbitraria)**
⚠️ Este flujo quedó **degradado** tras el último rediseño (se quitaron los
árboles del sidebar que tenían "Abrir Claude aquí" por carpeta, y el Gestor de
Archivos **no tiene** acción "abrir terminal/Claude aquí"):
1. Rail derecho → ＋ (nueva terminal, abre en el home) — 1 clic
2. Escribir `cd ruta/a/la/carpeta && claude` + Enter — tecleo manual
**Total: 1 clic + tecleo.** Para el home y para tolkien sí hay atajo directo:
sidebar → expandir sección (1) → botón "Claude" (1) = **2 clics**.

**(b) Retomar una sesión existente**
- Caso normal: **0 clics** — al cargar la página, todas las sesiones vivas se
  re-adjuntan como pestañas automáticamente (`main.js`, bloque final).
- Cambiar entre sesiones abiertas: 1 clic en el chip del rail.
- Adjuntar una sesión tmux externa (p. ej. `main-*` de otro socket):
  expandir "tmux" (1) → [Adjuntar] en la fila (1) = **2 clics**.

**(c) Matar una sesión**
1. Expandir sección "tmux" — 1 clic
2. [Matar] en la fila — 1 clic
3. `confirm()` nativo — 1 clic
**Total: 3 clics.** (Cerrar la pestaña con × del rail NO mata la sesión, solo
descarta la vista; es un matiz que la UI no explica en ningún lado.)

**(d) Ver consumo de tokens**
- Global + hoy: **0 clics** (pie fijo del sidebar, siempre visible; en móvil
  requiere abrir el sidebar con ☰ = 1 clic).
- Por proyecto: expandir "Tokens por proyecto" — 1 clic.
- Detalle por modelo de un proyecto: + 1 clic en la fila = **2 clics**.

**(e) Hacer backup**
1. Botón [Backup] en el pie del sidebar — 1 clic
2. [Crear backup ahora] en el modal — 1 clic
**Total: 2 clics.** Restaurar: Backup (1) → [Restaurar] (1) → `confirm()` (1)
= **3 clics** + espera de reinicio automático (~5-8 s) con recarga sola.

---

## 6. Deuda y acoplamientos (evaluación honesta)

### 6.1 El acoplador central: `public/js/main.js`

`main.js` (245 líneas) es el **orquestador de todo el frontend**: mantiene el
`Map` de pestañas, crea/destruye panes y chips del rail, implementa el acordeón,
cablea los botones de los paneles Archivos/Tolkien, inyecta callbacks
(`openTerminal`, `openAttach`) a los módulos, hace el poll de banderines de
modelo, maneja whoami/logout/visualViewport. **Cualquier reorganización de la
navegación pasa por reescribir main.js + index.html.** Los módulos JS del
sidebar (tmux, tokens, tolkien, stats, backup) reciben sus elementos DOM por id
desde main.js — están acoplados a los ids concretos de `index.html`.

### 6.2 Acoplamientos concretos

| Acoplamiento | Detalle | Riesgo al reorganizar |
|---|---|---|
| main.js ↔ index.html | ~20 `getElementById` con ids fijos | Alto: mover/renombrar markup rompe silenciosamente (null listeners) |
| tmux → terminal | Adjuntar usa `POST /api/terminal/sessions {attach}` y el callback `openAttach` inyectado desde main.js | Medio: la API es estable, el callback es cableado manual |
| tmux/rail → claude-model | El banderín y la etiqueta de modelo dependen de que `/api/tmux/sessions` y `/api/terminal/model` embeban `modelForCwd()` | Bajo |
| tokens.js ↔ claude-model.js | Paleta de colores de modelo **duplicada** (ver §3.2.3) | Divergencia visual si se toca una sola |
| Tolkien → main.js | `initTolkien({openTerminal})`; el href de "Explorar" se setea en runtime | Bajo |
| fm.js ↔ archivos.html | Igual patrón de ids fijos; fm.js es 1 archivo de 489 líneas con estado global de módulo (`state`), render por template strings y listeners re-atados en cada render | Medio: es el archivo más "monolítico" del frontend |
| auxbar → TerminalTab | La barra móvil llama métodos del tab activo (`sendData`, `setCtrlArmed`, `pasteText`) vía `getActiveTab()` | Bajo |
| style.css | Un solo archivo (377 líneas) mezcla login + admin + consola + tmux + tokens + backup + auxbar + rail | Medio: sin scoping, los nombres de clase son la única frontera |

### 6.3 Módulos realmente independientes (seguros de mover/rediseñar)

- **stats** y **tokens**: solo leen (`/api/stats`, `/api/tokens/summary`) y
  pintan; cero dependencias salientes.
- **backup**: modal autocontenido; solo necesita `isAdmin` al inicializar.
- **admin** y **login**: páginas aparte con su propio JS; no tocan la consola.
- **Gestor de Archivos**: página aparte; su único lazo con el resto es el
  fetch a `/api/tolkien/status` para rotular el favorito (falla con gracia).

### 6.4 Deuda técnica general (sin adornos)

1. **No hay git** en el proyecto. Los backups tar.gz son la única red de
   seguridad. Cualquier rediseño serio debería empezar por `git init`.
2. **No hay tests** de ningún tipo. La verificación histórica fue manual
   (curl + navegador del propietario).
3. **No hay build step** (a propósito: vanilla ES modules). Único artefacto
   generado: `public/vendor/hljs/hljs.min.js` (bundle IIFE de highlight.js
   hecho una vez con esbuild, porque el paquete npm no trae build de browser).
4. **Renderizado por template strings + innerHTML** en todos los módulos, con
   re-render completo por sección y listeners re-atados a mano. Funciona a esta
   escala, pero cualquier crecimiento de interactividad lo va a sufrir. No hay
   componentes reutilizables (cada módulo re-implementa filas, botones, modal).
5. **Modales/diálogos nativos** (`confirm`/`prompt`/`alert`) en ~15 sitios.
6. **Trampa conocida en `sessions.js`**: la propiedad de adjuntado se llama
   `attachSpec` porque `attach` colisiona con el método `attach(ws)` de la
   misma clase (ya causó un crash una vez; está comentado en el código).
7. **CSS muerto potencial bajo del radar**: la limpieza tras retirar los
   árboles fue verificada, pero style.css acumula variantes de botón muy
   similares (`.icon-btn`, `.rail-btn`, `.tmux-btn`, `.side-act`, `.acct-btn`,
   `.bk-btn`, `.tree-…` ya no, `.fm-btn` en fm.css) que un rediseño debería
   unificar en 1-2 clases.
8. **El ring buffer de scrollback se pierde** al reiniciar Node (las sesiones
   tmux sobreviven, pero el replay del buffer arranca vacío; tmux repinta solo
   su pantalla visible). Mitigación conocida no implementada: `capture-pane`
   al rehidratar.
9. **Operativo**: el server corre lanzado a mano (`setsid npm start`); la
   unidad systemd existe (`systemd/claude-web-console.service`, validada) pero
   no está instalada. `pkill -f src/server.js` mata el shell propio (gotcha
   documentado); matar por PID del puerto 8092.

---

## 7. Estado de la migración a Agent SDK

**No hay ningún avance, rama ni intento.** Verificado: el proyecto no es repo
git (no hay ramas posibles) y `grep -ri 'agent.?sdk|headless|claude -p|@anthropic'`
sobre `src/`, `public/js/` y `package.json` no devuelve nada. El chat con
Claude Code es 100 % PTY: xterm.js ↔ WS ↔ node-pty ↔ tmux ↔ CLI interactivo.

### 7.1 Qué del código actual ES reutilizable para una migración

- **Toda la capa de auth** (`src/core/auth.js` + rutas en `server.js`): las
  sesiones/token ya se validan tanto en HTTP como en el handshake WS; un chat
  por SDK usaría exactamente el mismo gate.
- **El router de WebSocket** (`src/core/wss.js`): está diseñado para múltiples
  rutas (`wss.route('/ws/chat', handler)` conviviría con `/ws/terminal` sin
  tocar nada).
- **El patrón de módulos** (`src/core/registry.js`): un módulo `chat` nuevo
  entra con la interfaz estándar sin modificar lo existente.
- **Bootstrap de red** (ZeroTier + TLS + bind exclusivo): idéntico.
- **El módulo tokens**: ya sabe parsear los transcripts de `~/.claude/projects/`;
  el SDK escribe en el mismo formato, así que la contabilidad seguiría andando.
- **La detección de modelo** se volvería innecesaria en el chat SDK (el SDK
  reporta modelo/estado por evento, sin inferencias por transcript) — pero
  seguiría haciendo falta para sesiones PTY que convivan.
- **Auth de usuarios, gestor de archivos, stats, backup, tolkien**: ortogonales,
  intactos.

### 7.2 Qué NO es reutilizable / habría que construir

- **Todo el modelo de sesión del terminal** (`sessions.js`: tmux + pty + ring
  buffer + rehidratación) no aplica a un chat SDK; la persistencia de una
  conversación SDK es el `session_id`/transcript, no un proceso vivo.
- **El frontend xterm** no sirve para chat estructurado: haría falta una vista
  de conversación nueva (mensajes, tool calls, permisos, streaming), que es
  justamente la pieza de UI más grande a diseñar.
- **El protocolo WS actual** (binario crudo = pantalla) se reemplazaría por
  eventos estructurados (JSON por mensaje/delta/tool-use/permission-request).
- **Consideración de convivencia**: lo razonable técnicamente es que SDK y PTY
  **convivan** (chat estructurado para conversar; PTY para htop/vim/tmux y para
  el modo interactivo completo de Claude Code). El rediseño de navegación
  debería contemplar ambos tipos de "pestaña".

---

## 8. Restricciones técnicas descubiertas (no rediseñar contra esto)

Aprendidas construyendo la app; todas verificadas en este entorno real.

### Claude Code / modelos
1. **No existe enrutamiento automático de modelo por-pregunta** en Claude Code,
   ni hooks por-turno que permitan a un tercero cambiar el modelo antes de cada
   prompt (verificado contra docs oficiales). Lo más adaptativo nativo es
   `opusplan` (Opus para planear, Sonnet para ejecutar). Por eso el dropdown
   "Auto" = `opusplan`.
2. **Cambiar el modelo desde afuera** solo se puede inyectando `/model <x>` por
   `tmux send-keys` (y solo surte efecto si en esa sesión corre Claude Code; en
   una shell se tipea como texto inofensivo).
3. **Saber el modelo/estado desde afuera**: transcript jsonl (lo que usamos) o
   statusline (recibe `{model:{id,display_name}}` por stdin — mejor fuente si
   se quiere estado en tiempo real, no implementado).
4. **Shift+Tab es crítico** (cambia el modo de permisos de Claude Code); debe
   llegar como `\x1b[Z`. En móvil no hay Shift físico → botón dedicado en la
   barra auxiliar.

### xterm.js / móvil
5. **El arrastre táctil NO scrollea** xterm por defecto: hubo que sintetizarlo
   a mano (`terminal.js:_setupTouchScroll`). Y con `tmux mouse on`, la rueda/
   arrastre no debe scrollear el buffer de xterm sino **emitir eventos de mouse
   SGR al PTY** (`\x1b[<64/65;x;yM`) para que tmux haga copy-mode — se decide
   en runtime según `term.modes.mouseTrackingMode`.
6. **`keydown` no es confiable en teclados virtuales** (Android): el modificador
   Ctrl de la barra táctil se implementa "armado" — transforma el *próximo
   carácter resultante* en su código de control, no intercepta teclas.
7. **El dictado por voz móvil funciona mal inyectando en xterm**: hace falta un
   `<input>` normal (con soporte de composición/IME) + botón enviar. Ya existe.
8. **Teclado virtual tapa la UI**: se usa `visualViewport.height` + `100dvh`
   para mantener la barra de teclas sobre el teclado. Cualquier rediseño móvil
   debe conservar ese mecanismo.
9. **El portapapeles del navegador exige contexto seguro (HTTPS)**: por eso el
   server es HTTPS con cert self-signed atado a la IP ZeroTier (SAN IP). Cada
   dispositivo debe aceptar el aviso una vez. Copiar = OSC52 (tmux
   `set-clipboard on` + `terminal-features xterm*:clipboard` + addon-clipboard
   de xterm; el terminfo `xterm-256color` NO trae la capacidad `Ms`, hay que
   declararla). Pegar = click derecho (desktop) / botón 📋 (móvil); en móvil no
   hay click derecho.

### tmux / node-pty
10. **Guerra de redimensionado**: dos clientes tmux adjuntos a la misma sesión
    con tamaños distintos oscilan; solución adoptada: `attach -d` (cliente
    único; "roba" la vista, aceptado como trade-off).
11. **`$TMUX` heredado envenena**: el server puede correr dentro de una sesión
    tmux; todas las invocaciones de tmux y los PTYs hijos limpian
    `TMUX`/`TMUX_PANE` para no anidar ni apuntar al socket equivocado.
12. **La config del socket (`tmux.cwc.conf`) solo se lee al CREAR el servidor
    tmux**: cambios de config para sesiones ya vivas hay que aplicarlos también
    en runtime con `set-option` (se hace en `terminal/index.js:init`).
13. **node-pty requiere build nativo** (`node-gyp rebuild`); npm 11 bloquea
    install-scripts por defecto (`allow-scripts`) — ya está compilado, pero un
    `npm ci` fresco puede requerir aprobación manual.
14. **Sesiones tmux sobreviven a Node, el scrollback no** (ver §6.4.8).

### Red / infra
15. **Bind EXCLUSIVO a la IP ZeroTier** (requisito duro del proyecto; nunca
    `0.0.0.0`). La interfaz `zt*` puede tardar en existir tras un reboot: el
    arranque espera con reintentos (`src/core/zerotier.js`). Cualquier feature
    nueva no debe asumir localhost ni exponer otro puerto.
16. **Latencia percibida**: `TCP_NODELAY` activado (sin él, cada tecla puede
    esperar ~40 ms por Nagle) y `permessage-deflate` con umbral 512 bytes (las
    ráfagas de salida se comprimen; los tecleos chicos no, para no añadir
    latencia). Assets `/vendor` con `Cache-Control: immutable` 30 días + gzip.
    Un rediseño no debería introducir frameworks pesados sin considerar el
    enlace móvil vía ZeroTier (a veces relayed).
17. **SSH agent bajo systemd**: el botón "Actualizar" de Tolkien necesita
    `SSH_AUTH_SOCK`; systemd --user no lo hereda (documentado en el README y en
    la unidad). Lanzado a mano funciona porque hereda el agente del shell.
18. **El reinicio post-restore de backup** detecta systemd por `INVOCATION_ID`
    (exit → `Restart=on-failure`) y si no, se auto-relanza con un bash
    desacoplado. Un supervisor distinto requeriría ajustar esa lógica
    (`src/modules/backup/index.js:scheduleRestart`).

### Datos / seguridad (contexto para decisiones de UI)
19. La validación de rutas (`resolveWithinHome`) es defensa en profundidad,
    **no una frontera real**: cualquier usuario autenticado tiene una terminal
    con el UID del dueño. Por eso no hay "roles" con menos permisos que valgan
    la pena en la UI (el flag admin solo gatea usuarios y backups).
20. Archivos sensibles generados (no committeables): `.env` (token maestro),
    `users.json` (hashes scrypt, 600), `sessions.json` (ids de sesión, 600),
    `certs/` (clave TLS, 600). La papelera vive en `~/.cwc-trash/` y los
    backups en `~/.cwc-backups/` (700), ambos fuera del proyecto.

---

## Apéndice A — Mapa completo de endpoints

| Método | Ruta | Módulo | Auth |
|---|---|---|---|
| POST | `/login` | server.js | pública (throttle por IP) |
| POST | `/logout` | server.js | pública |
| GET | `/login`, `/css/style.css`, `/js/login.js` | server.js | públicas |
| GET | `/`, `/archivos`, estáticos, `/vendor/*` | server.js | autenticado |
| GET | `/admin` | server.js | admin |
| GET | `/api/whoami` | server.js | autenticado |
| GET/POST | `/api/terminal/sessions` | terminal | autenticado |
| GET | `/api/terminal/model?id=` | terminal | autenticado |
| WS | `/ws/terminal?id=` | terminal | autenticado (en upgrade) |
| GET | `/api/files/list · read · raw · download · download-zip · trash` | files | autenticado |
| POST | `/api/files/zip · upload · mkdir · rename · trash · trash/restore · trash/purge` | files | autenticado |
| GET | `/api/stats` | stats | autenticado |
| GET | `/api/tokens/summary` | tokens | autenticado |
| GET | `/api/tmux/sessions` | tmux | autenticado |
| POST | `/api/tmux/kill · set-model` | tmux | autenticado |
| GET | `/api/tolkien/status` | tolkien | autenticado |
| POST | `/api/tolkien/fetch · update` | tolkien | autenticado |
| GET/POST/PUT/DELETE | `/api/admin/users[...]` | admin | admin |
| GET | `/api/backup/list` | backup | admin |
| POST | `/api/backup/create · restore · delete` | backup | admin |

## Apéndice B — Variables de entorno (`.env`)

`CWC_TOKEN` (obligatoria, llave maestra) · `CWC_PORT` (8092) · `CWC_ZT_IFACE`
(autodetecta `zt*`) · `CWC_HOME` (raíz permitida) · `CWC_TMUX_SOCKET` (`cwc`) ·
`CWC_SCROLLBACK` (5000) · `CWC_SESSION_DAYS` (30) · `CWC_PROJECT_DIR`
(`~/tolkien`) · `CWC_PROJECT_NAME` (`tolkien`).

## Apéndice C — Dependencias npm

`express`, `ws`, `node-pty`, `@xterm/xterm` + addons (`fit`, `web-links`,
`clipboard`), `cookie`, `dotenv`, `compression`, `multer` (upload),
`archiver` (zip), `highlight.js` (bundlead a IIFE en `public/vendor/hljs/`).
Sin framework de frontend: vanilla ES modules, sin build step.
