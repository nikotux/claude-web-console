// server.js — bootstrap de Claude Web Console.
//
// Secuencia de arranque:
//   1) Espera la interfaz ZeroTier (no crashea si aún no levantó).
//   2) Bind EXCLUSIVO a la IP ZeroTier (nunca 0.0.0.0).
//   3) Login por token + rutas de API protegidas + WebSocket con auth.
//   4) Monta los módulos vía el registry.
import express from 'express';
import compression from 'compression';
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
import { verifyUser } from './core/users.js';
import { createWsRouter } from './core/wss.js';
import { registerModules } from './core/registry.js';

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
    res.setHeader('X-Frame-Options', 'DENY');
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
  app.get('/css/style.css', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'css', 'style.css')));

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
  app.get('/api/whoami', (req, res) => res.json(principalOf(req)));

  // Página de administración de usuarios: solo administradores (o token maestro).
  app.get(['/admin', '/admin.html'], (req, res) => {
    if (!isAdmin(req)) return res.status(403).send('Solo administradores.');
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
  });

  // Gestor de archivos (subpágina): cualquier usuario autenticado.
  app.get('/archivos', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'archivos.html')));

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
  });
}

main().catch((err) => {
  console.error('[server] Error fatal en el arranque:', err);
  process.exit(1);
});
