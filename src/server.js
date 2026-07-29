// server.js — bootstrap de Claude Web Console.
//
// Secuencia de arranque:
//   1) Espera la interfaz ZeroTier (no crashea si aún no levantó).
//   2) Bind EXCLUSIVO a la IP ZeroTier (nunca 0.0.0.0).
//   3) Login por token + rutas de API protegidas + WebSocket con auth.
//   4) Monta los módulos vía el registry.
import express from 'express';
import compression from 'compression';
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './core/config.js';
import { waitForZeroTier } from './core/zerotier.js';
import { ensureCert } from './core/tls.js';
import {
  isAuthenticated, isAdmin, principalOf, tokenMatches, COOKIE_NAME,
  createSession, destroySession, sessionIdOf, SESSION_COOKIE,
} from './core/auth.js';
import { verifyUser, getUserLang, setUserLang } from './core/users.js';
import { hostUser } from './core/user-space.js';
import { createWsRouter } from './core/wss.js';
import { registerModules } from './core/registry.js';
import { warmCache, startCacheSweep } from './core/pad-service-client.js';
import { publicRouter as onboardPublicRouter } from './modules/onboard/index.js';

// Colecciones "calientes" de Pad local que la UI pide al abrir: se precargan al
// arrancar y el barrido las mantiene frescas (RDA-347 — transporte del Banco de
// Conocimiento y demás tableros sobre Pad local).
const HOT_PAD_COLLECTIONS = [
  'temas-de-aprendizaje', 'rutas-de-aprendizaje', // Banco de Conocimiento
  'pendientes', 'planes', // tablero de tareas
  'contexto-de-tickets', 'mejora-continua', // tickets internos + retro
];

// Helper para setear cookies de sesión: httpOnly + Secure (HTTPS) + SameSite.
function setCookie(res, name, value, { clear = false } = {}) {
  const age = clear ? 0 : 31536000;
  return `${name}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${age}`;
}

// Throttle simple de login por IP (anti fuerza bruta; complementa a scrypt+ZeroTier).
const loginFails = new Map(); // ip -> { count, first }
const MAX_FAILS = 8;
const FAIL_WINDOW_MS = 5 * 60 * 1000;
function loginBlocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > FAIL_WINDOW_MS) { loginFails.delete(ip); return false; }
  return rec.count >= MAX_FAILS;
}
function noteFail(ip) {
  const now = Date.now();
  const rec = loginFails.get(ip);
  if (!rec || now - rec.first > FAIL_WINDOW_MS) loginFails.set(ip, { count: 1, first: now });
  else rec.count += 1;
}
function clearFails(ip) { loginFails.delete(ip); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// BUILD_ID: identidad de la versión desplegada. Se usa para invalidar el
// caché del Service Worker en cada deploy (git pull in-place conserva los
// nombres de archivo, así que el navegador necesita otra señal de cambio).
// Hash corto de git HEAD; si git no está, cae al mtime de este archivo.
const BUILD_ID = (() => {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: path.join(__dirname, '..'), encoding: 'utf8',
    }).trim();
  } catch {
    try { return String(Math.floor(statSync(fileURLToPath(import.meta.url)).mtimeMs)); }
    catch { return String(Date.now()); }
  }
})();

// Fuente del Service Worker con el BUILD_ID ya inyectado (se lee UNA vez al
// arrancar; el placeholder __BUILD_ID__ vive en public/sw.js).
const SW_SOURCE = (() => {
  try {
    return readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8')
      .replace(/__BUILD_ID__/g, BUILD_ID);
  } catch { return null; }
})();

// index.html con el BUILD_ID inyectado (se lee UNA vez al arrancar). Expone
// window.__CWC_BUILD__ de forma SÍNCRONA para que la caché cache-then-network
// (Capa 2, ui/cache-store.js) pueda invalidar respuestas de un deploy viejo
// ANTES del primer paint.
const INDEX_HTML = (() => {
  try {
    return readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
      .replace(/__BUILD_ID__/g, BUILD_ID);
  } catch { return null; }
})();

async function main() {
  const { ip, iface } = await waitForZeroTier(config.ztIface);
  console.log(`[server] Interfaz ZeroTier lista: ${iface} -> ${ip}`);

  const app = express();
  app.disable('x-powered-by');

  // Compresión gzip de respuestas de texto (HTML/CSS/JS/JSON): menos ancho de
  // banda en enlaces lentos. No afecta al WebSocket.
  app.use(compression());

  // Cabeceras de seguridad básicas (defensa en profundidad).
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // SAMEORIGIN (no DENY): el Explorador flotante embebe /archivos en un
    // <iframe> del MISMO origen. Sigue bloqueando el embebido por terceros.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(express.json({ limit: '256kb' }));

  // --- Rutas PÚBLICAS (sin auth): login/logout y estáticos del login ---
  // POST /login: usuario+contraseña -> sesión; o token maestro -> cookie token.
  app.post('/login', (req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    if (loginBlocked(ip)) {
      return res.status(429).json({ error: 'Demasiados intentos fallidos. Esperá unos minutos.' });
    }
    const { username, password, token } = req.body || {};

    if (username != null || password != null) {
      const principal = verifyUser(String(username || ''), String(password || ''));
      if (!principal) {
        noteFail(ip);
        return res.status(401).json({ error: 'Usuario o contraseña inválidos.' });
      }
      clearFails(ip);
      const sid = createSession(principal);
      res.setHeader('Set-Cookie', setCookie(res, SESSION_COOKIE, sid));
      return res.json({ ok: true, admin: principal.admin });
    }

    if (tokenMatches(token)) {
      clearFails(ip);
      res.setHeader('Set-Cookie', setCookie(res, COOKIE_NAME, token));
      return res.json({ ok: true, admin: true });
    }
    noteFail(ip);
    return res.status(401).json({ error: 'Credenciales inválidas.' });
  });

  // POST /logout: destruye la sesión y limpia ambas cookies.
  app.post('/logout', (req, res) => {
    destroySession(sessionIdOf(req));
    res.setHeader('Set-Cookie', [
      setCookie(res, SESSION_COOKIE, '', { clear: true }),
      setCookie(res, COOKIE_NAME, '', { clear: true }),
    ]);
    res.json({ ok: true });
  });

  app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
  app.get('/js/login.js', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'js', 'login.js')));
  // Onboarding PÚBLICO (SP7): página del wizard + su JS, servidos SIN auth (el
  // usuario nuevo no tiene cuenta; el flujo se gatea por el token de invitación).
  app.get('/onboard', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'onboard.html')));
  app.get('/js/onboard/onboard.js', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'js', 'onboard', 'onboard.js')));
  // TODO el CSS que usa login.html debe ser público: si falta uno acá, el 401
  // devuelve JSON y el navegador lo rechaza por MIME (login sin estilos).
  app.get('/css/style.css', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'css', 'style.css')));
  app.get('/css/tokens.css', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'css', 'tokens.css')));
  app.get('/css/ui.css', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'css', 'ui.css')));

  // Imágenes de marca (Mordor Staffing): públicas porque el login se sirve
  // ANTES del gate de auth (mismo criterio que el CSS de arriba). Cubren
  // también el splash de index.html (que es post-auth) sin ruta extra.
  app.get('/img/mordor-logo.png', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'img', 'mordor-logo.png')));
  app.get('/img/mordor-iso.png', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'img', 'mordor-iso.png')));

  // Onboarding PÚBLICO (SP7): un usuario nuevo no tiene cuenta — estos endpoints
  // se gatean por el TOKEN de invitación, no por login. Montados ANTES del gate.
  app.use('/api/onboard/public', onboardPublicRouter);

  // --- A partir de acá, TODO exige token ---
  // Páginas HTML sin token -> redirect a /login. API/otros -> 401.
  app.use((req, res, next) => {
    if (isAuthenticated(req)) return next();
    const wantsHtml = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
    if (wantsHtml) return res.redirect('/login');
    return res.status(401).json({ error: 'No autorizado: token inválido o ausente.' });
  });

  const apiRouter = express.Router();
  app.use('/api', apiRouter);

  // Identidad del principal actual (la app la usa para mostrar/ocultar admin).
  // `lang` (PLAN i18n, 2026-07-19): preferencia personal, solo tiene sentido
  // para type 'user' (tiene registro persistente); el token maestro no tiene
  // perfil propio, así que queda fijo en 'es'.
  app.get('/api/whoami', (req, res) => {
    const p = principalOf(req);
    if (p) p.lang = p.type === 'user' ? getUserLang(p.username) : 'es';
    res.json({ ...p, host: hostUser() });
  });

  // Self-service: CADA usuario elige SU idioma de interfaz (no admin-gated,
  // es una preferencia personal — mismo criterio que "Variables de entorno"
  // sería admin porque es config del SISTEMA; esto es config de la CUENTA).
  app.post('/api/account/lang', (req, res) => {
    const p = principalOf(req);
    if (!p) return res.status(401).json({ error: 'No autorizado.' });
    if (p.type !== 'user') {
      return res.status(400).json({ error: 'El token maestro no tiene perfil de usuario persistente.' });
    }
    try {
      setUserLang(p.username, req.body?.lang);
      return res.json({ ok: true, lang: getUserLang(p.username) });
    } catch (e) {
      return res.status(e.badRequest ? 400 : 500).json({ error: e.message || 'Error.' });
    }
  });

  // Página de administración de usuarios: solo administradores (o token maestro).
  app.get(['/admin', '/admin.html'], (req, res) => {
    if (!isAdmin(req)) return res.status(403).send('Solo administradores.');
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  });

  // Gestor de archivos (subpágina): cualquier usuario autenticado.
  app.get('/archivos', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'archivos.html')));

  // Vista Raw (subpágina, PLAN-544): cualquier usuario autenticado, y cada uno
  // ve SOLO lo suyo. El aislamiento NO lo hace esta ruta (sirve un HTML estático
  // sin datos): lo garantiza cada endpoint que la vista consume, todos ya
  // fail-closed por principal — /api/tokens/{flow,stream,stream/seed} resuelven
  // el owner del principal autenticado y nunca de la query (BUG-1874),
  // /api/chat/list filtra con manager.list(principalOf(req)), /api/tmux/raw-feed
  // con ownsSession() y /api/health/active-runners descarta todo job sin dueño
  // legible. Si mañana la vista consume un endpoint nuevo, ESE endpoint tiene
  // que traer su propio filtro por principal: acá ya no hay red de contención.
  app.get('/raw', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'raw.html'));
  });

  // Dashboard "Seguimientos" (subpágina, PLAN-553 · primer habitante de Limbo):
  // trabajo humano-accionable de Niko. Cualquier usuario autenticado.
  app.get('/seguimientos', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'seguimientos.html')));

  // App shell (index.html) con el BUILD_ID inyectado. Cache-Control: no-cache
  // porque es una navegación que el Service Worker deja pasar a la red siempre
  // (ver public/sw.js) — así el BUILD_ID que ve el cliente es siempre el actual.
  app.get(['/', '/index.html'], (req, res, next) => {
    if (!INDEX_HTML) return next(); // fallback a express.static si falló la lectura
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(INDEX_HTML);
  });

  // Service Worker (Capa 1 de caché de navegador): se sirve con el BUILD_ID
  // inyectado y SIN caché HTTP (es el único pedido que queremos que el
  // navegador revalide siempre — es chico). Service-Worker-Allowed: / permite
  // que controle todo el origen aunque se sirva desde /sw.js.
  app.get('/sw.js', (req, res) => {
    if (!SW_SOURCE) return res.status(404).end();
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Service-Worker-Allowed', '/');
    res.send(SW_SOURCE);
  });

  // Assets de terceros (xterm, hljs, addons): no cambian -> cache largo e
  // inmutable, así el navegador NO los revalida en cada carga (menos round-trips).
  app.use('/vendor', (req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    next();
  });

  // Estáticos protegidos (app + assets de xterm servidos desde node_modules).
  app.use(express.static(PUBLIC_DIR));
  app.use('/vendor/xterm', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm')));
  app.use('/vendor/addon-fit', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-fit')));
  app.use('/vendor/addon-web-links', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-web-links')));
  app.use('/vendor/addon-clipboard', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-clipboard')));

  // WebSocket router con auth en el handshake.
  const { wss, attach } = createWsRouter();

  // Monta los módulos (terminal, y a futuro files/docker/logs...).
  const ctx = { config };
  registerModules({ app, apiRouter, wss, ctx });

  // HTTPS con cert self-signed atado a la IP ZeroTier (contexto seguro para el
  // portapapeles del navegador). El WebSocket viaja por wss sobre el mismo server.
  const { key, cert } = ensureCert(ip);
  const server = https.createServer({ key, cert }, app);
  // TCP_NODELAY: manda cada tecla al instante (sin esperar a Nagle). Es la
  // mejora más grande para la latencia percibida de la terminal.
  server.on('connection', (socket) => socket.setNoDelay(true));
  attach(server);

  server.listen(config.port, ip, () => {
    console.log(`[server] Escuchando en https://${ip}:${config.port} (solo ZeroTier)`);
    console.log('[server] Acceso: abrí esa URL desde un dispositivo de la red ZeroTier');
    console.log('[server] (la primera vez, aceptá el aviso de certificado self-signed).');

    // Caché de Pad local: precarga las colecciones calientes y arranca el barrido
    // de refresco. Best-effort — si Pad local está caído, no afecta el boot.
    warmCache(HOT_PAD_COLLECTIONS)
      .then((r) => {
        console.log(`[server] Pad local: precarga de caché lista (${r.warmed}/${HOT_PAD_COLLECTIONS.length} colecciones).`);
        startCacheSweep();
      })
      .catch((err) => console.warn('[server] Pad local: precarga de caché falló (se sigue sin caché):', String(err?.message || err)));
  });
}

main().catch((err) => {
  console.error('[server] Error fatal en el arranque:', err);
  process.exit(1);
});
