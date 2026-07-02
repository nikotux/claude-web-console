# Claude Web Console

Consola web personal para trabajar con **Claude Code desde el navegador** (incluido el celular) a través de **ZeroTier**, sin depender de un cliente SSH. Terminal real (PTY) con `xterm.js` + `node-pty` + `tmux`, árbol de archivos, panel de tokens, control de tmux, panel del proyecto principal (git) y administración de usuarios.

Proyecto **personal y aislado**: vive en `~/claude-web-console` y no depende del monorepo de la empresa.

---

## Modelo de acceso (leer esto)

La seguridad tiene **dos capas**:

1. **Red ZeroTier** — controla *quién llega*. El servidor hace **bind EXCLUSIVO a la IP de la interfaz ZeroTier** (nunca `0.0.0.0`). Solo los miembros aprobados de tu red ZeroTier pueden siquiera abrir la página.
2. **Autenticación** — controla *quién entra*:
   - **Usuario + contraseña** (normal, cómodo en el celular). Los usuarios se administran en `/admin` y se guardan hasheados (scrypt) en `users.json`.
   - **Token maestro** (`CWC_TOKEN` del `.env`) — llave de administración/emergencia y para crear el primer usuario. Se exige como cookie/header en HTTP y en el handshake del WebSocket.

Se sirve por **HTTPS** con un certificado self-signed atado a la IP de ZeroTier (necesario para que el portapapeles del navegador funcione). La primera vez, cada dispositivo debe **aceptar el aviso de certificado**.

### Qué NO hacer

- **Nunca** cambiar el bind a `0.0.0.0` ni exponer el puerto fuera de ZeroTier.
- **Nunca** commitear `.env`, `users.json`, `sessions.json` ni `certs/` (ya están en `.gitignore`).
- No desactivar la autenticación por token/usuario "para probar".
- No tocar el firewall ni la configuración de ZeroTier del servidor.

---

## Requisitos

- **Node.js** (probado con v24) y **npm**.
- **tmux** (3.2+ recomendado; usa un socket aislado `cwc`, no interfiere con tu tmux personal).
- **git** y **openssl** (para el módulo Tolkien y el certificado).
- Una **red ZeroTier** ya configurada y con la interfaz `zt*` levantada.

---

## Instalación

```bash
cd ~/claude-web-console
npm install
cp .env.example .env
$EDITOR .env          # completá CWC_TOKEN (ver abajo)
```

Generá el token maestro:

```bash
openssl rand -hex 32   # pegá el resultado en CWC_TOKEN
```

### Variables del `.env`

| Variable            | Descripción                                                              |
|---------------------|--------------------------------------------------------------------------|
| `CWC_TOKEN`         | **Obligatoria.** Token maestro / admin. Generar con `openssl rand -hex 32`. |
| `CWC_PORT`          | Puerto (default `8092`). Se sirve por HTTPS, bind solo a la IP ZeroTier.  |
| `CWC_ZT_IFACE`      | Interfaz ZeroTier (`zt...`). Vacío = autodetecta la primera `zt*`.        |
| `CWC_HOME`          | Raíz permitida para el árbol y las terminales (default: tu home).         |
| `CWC_TMUX_SOCKET`   | Socket tmux aislado (default `cwc`).                                      |
| `CWC_SCROLLBACK`    | Líneas de scrollback en memoria por sesión (default `5000`).             |
| `CWC_SESSION_DAYS`  | Días de validez de la sesión de usuario (default `30`).                  |
| `CWC_PROJECT_DIR`   | Proyecto principal del panel "Tolkien" (default `~/tolkien`).            |
| `CWC_PROJECT_NAME`  | Nombre a mostrar del proyecto (default `tolkien`).                        |

---

## Arranque

**El modo normal es el servicio systemd de usuario, YA INSTALADO y habilitado**
(sobrevive a reboots gracias a `loginctl enable-linger`):

```bash
systemctl --user status claude-web-console    # estado
journalctl --user -u claude-web-console -f    # logs
systemctl --user restart claude-web-console   # reiniciar
```

Al iniciar: espera la interfaz ZeroTier (no crashea si aún no levantó), genera
el certificado si falta, y escucha en `https://<ip-zerotier>:<puerto>`. La
restauración de un backup reinicia el servicio sola (`Restart=on-failure`).

> **SSH para "Actualizar" de Tolkien:** bajo systemd el agente SSH no se hereda
> solo; ya se importó con `systemctl --user import-environment SSH_AUTH_SOCK`.
> **Tras un reboot** ese socket deja de existir hasta que inicies sesión SSH de
> nuevo — reconectate y repetí el `import-environment` (o usá una deploy key).
> Todo lo demás funciona sin el agente.

### Reinstalar el servicio (si hiciera falta)

```bash
cp systemd/claude-web-console.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now claude-web-console
loginctl enable-linger "$USER"
```

### Alternativas: a mano o en tmux

```bash
npm start                                              # foreground
tmux new -s cwc-server 'cd ~/claude-web-console && npm start'
```

---

## Conexión

### Desde el escritorio

Abrí `https://<ip-zerotier>:8092` (p. ej. `https://10.213.222.62:8092`). La primera vez el navegador avisa "sitio no seguro" (es tu cert self-signed): aceptá/avanzá una vez.

### Desde Android (u otro móvil) vía ZeroTier

1. Instalá **ZeroTier One**, unite a la red y esperá a que un admin apruebe el dispositivo.
2. Abrí `https://<ip-zerotier>:8092` en el navegador.
3. Aceptá el aviso de certificado (una vez por dispositivo).
4. Entrá con tu **usuario + contraseña**.

**Primer arranque (bootstrap):** todavía no hay usuarios. En el login, desplegá *"Acceso con token maestro"* e ingresá el `CWC_TOKEN`. Luego, en el pie del panel lateral, tocá **⚙ Usuarios** y creá tu usuario admin. A partir de ahí entrás con usuario + contraseña.

---

## Observador de estado (statusline + hooks de Claude Code)

Las tarjetas de "Sesiones" muestran el estado real de Claude (● trabajando /
○ esperando) y el modelo en tiempo real gracias a un observador instalado en
la configuración de usuario de Claude Code (`~/.claude/settings.json`):

- **Qué instala** (`node bin/install-observer.js`): una `statusLine` (muestra
  "Modelo · ~carpeta" en todas tus sesiones de Claude Code, también por SSH) y
  hooks `UserPromptSubmit`/`Stop`/`SessionEnd`, todos apuntando a
  `bin/cwc-observe.js`, que escribe el estado en `~/.cwc-state/` (modo 700).
- **Aditivo**: no pisa una statusline ajena ni hooks de otros; guarda backup
  del original en `settings.json.bak` la primera vez.
- **Desinstalar**: `node bin/uninstall-observer.js` (quita exactamente lo
  instalado; lo demás queda intacto).
- Las sesiones de Claude ya abiertas empiezan a reportar al reiniciarse.
- Limitación: el estado se mapea a las sesiones tmux **por carpeta**; dos
  sesiones de Claude en el mismo directorio comparten estado.

## La interfaz (organizada por intención)

- **[＋ Nueva sesión]** — el lanzador, la única acción prominente: tipo
  (**Chat** por defecto / Claude TUI / Terminal), modelo (recuerda el último),
  destino (Home, Tolkien, carpetas recientes o navegador con breadcrumb) y,
  con tipo Chat, **"Retomar"** las últimas conversaciones de esa carpeta.
- **Sesiones** — tarjetas con nombre humano, punto de **estado real**
  (● trabajando / ○ esperando, vía el observador) y modelo con su color.
  Tap = adjuntar/enfocar; menú ⋯ = renombrar / cambiar modelo / matar.
  Las sesiones tmux externas viven en un grupo colapsado.
- **Chat nativo (Agent SDK)** — conversación con burbujas, markdown y código
  con botón copiar, tool calls colapsables con resultado, **diffs rojo/verde**
  (también dentro de la tarjeta de permiso **Permitir/Denegar**), modos de
  permiso (preguntar / aceptar ediciones / plan), costo por turno, detener, y
  resume. Usa la **suscripción del CLI** (sin API key ni facturación aparte).
  El textarea permite **dictado por voz nativo** en el celular.
- **Terminal PTY** — para la TUI completa de Claude Code, htop, vim: `tmux`
  en socket aislado; sobrevive a desconexiones y reinicios (rehidratación).
  El **scrollback histórico vive en tmux** (10.000 líneas, accesible con el
  scroll táctil/rueda vía copy-mode), por eso no se re-inyecta al recargar.
- **Pie de estado** — gauges CPU/RAM/disco, **hoy $** (→ modal **Uso** con el
  detalle por proyecto y por modelo), Explorador, y **⚙ Sistema** (Backup +
  Usuarios + Salir).
- **Explorador** (`/archivos`) — gestor de archivos estilo Finder: subir/bajar,
  zip de carpetas y selecciones, papelera con purga a 30 días, preview con
  resaltado, y "Claude aquí / Terminal aquí" por carpeta.
- **Móvil** — barra de teclas auxiliares (Esc/Tab/⇧Tab/Ctrl/flechas), dictado,
  pegar; copiar = seleccionar (OSC52), pegar = click derecho en desktop.
- **Backups** — snapshot completo, restaurar reinicia el servicio solo.

---

## Cómo agregar un módulo nuevo (patrón repetible)

El backend es modular. Cada módulo es un objeto con la interfaz estándar:

```js
// src/modules/<nombre>/index.js
export default {
  name: '<nombre>',
  init(ctx) { /* opcional: setup al montar */ },
  registerHttp(apiRouter, ctx) { /* rutas /api/<nombre>/... */ },
  registerWs(wss, ctx) { /* opcional: wss.route('/ws/<nombre>', handler) */ },
};
```

Pasos:

1. Creá `src/modules/<nombre>/index.js` con esa forma.
2. Agregalo al array `MODULES` en `src/core/registry.js`.
3. (Frontend) sumá tu UI en `public/js/modules/<nombre>/` y montala desde `public/js/main.js`.

El frontend tiene su patrón espejo documentado en `docs/frontend-modules.md`.
Cero cambios en lo existente: es el mismo patrón que usan `terminal`, `files`, `stats`, `tokens`, `tmux`, `admin` y `tolkien`.

---

## Troubleshooting

- **"Esperando la interfaz ZeroTier..." y no arranca:** `zerotier-one` todavía no asignó IP a la interfaz `zt*`. Es normal tras un reboot; el server reintenta solo. Verificá con `ip -o -4 addr show | grep zt`.
- **El navegador no confía en el certificado:** es esperado (self-signed). Aceptalo una vez por dispositivo. Si cambiaste la IP de ZeroTier, borrá `certs/` y reiniciá para regenerarlo.
- **No puedo pegar / copiar:** requiere HTTPS (ya lo es) y aceptar el cert. En móvil, el pegado va por el botón 📋 de la barra; el copiado, por selección táctil.
- **Shift+Tab no cambia el modo de permisos en Claude:** verificá que estás en la terminal (no en el campo de dictado). En móvil usá el botón ⇧Tab de la barra.
- **El botón "Actualizar" de Tolkien falla en la parte de red:** el server no tiene acceso al agente SSH (típico bajo systemd). Ver la nota de SSH más arriba.
- **Quedé bloqueado del login (429):** hubo demasiados intentos fallidos desde tu IP; esperá unos minutos o reiniciá el server.
- **Puerto ocupado:** cambiá `CWC_PORT` en `.env`.

---

## Estructura

```
src/
  server.js            arranque: ZeroTier + HTTPS + auth + monta módulos
  core/
    config.js          carga y valida el .env
    auth.js            token maestro + sesiones de usuario (persistentes)
    users.js           usuarios (scrypt) en users.json
    tls.js             certificado self-signed
    zerotier.js        espera/detección de la interfaz ZeroTier
    wss.js             router de WebSocket con auth en el handshake
    tmux.js            utilidades de sockets tmux
    registry.js        monta los módulos (patrón repetible)
  modules/
    terminal/ files/ stats/ tokens/ tmux/ admin/ tolkien/
public/                frontend (HTML/CSS/JS vanilla + xterm.js)
systemd/               unidad de usuario
```

Archivos generados (no se commitean): `.env`, `users.json`, `sessions.json`, `certs/`.
