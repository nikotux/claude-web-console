// modules/admin/index.js — administración: usuarios + mantenimiento del sistema
// (solo administradores).
//
// HTTP (todo bajo requireAdmin):
//   GET    /api/admin/users              -> lista de usuarios
//   POST   /api/admin/users             -> crea { username, password, admin }
//   PUT    /api/admin/users/:username    -> { password?, admin? }
//   DELETE /api/admin/users/:username    -> elimina
//   POST   /api/admin/restart-runners    -> recicla los runners de chat (SIGTERM)
import express from 'express';
import { execFileSync } from 'node:child_process';
import { isAdmin, principalOf, invalidateSessionsForUser } from '../../core/auth.js';
import { listUsers, createUser, setPassword, setAdmin, deleteUser } from '../../core/users.js';
import { deprovisionUser } from '../../core/user-deprovision.js';
import { hostUser } from '../../core/user-space.js';
import { provisionNewUser } from '../onboard/provision-user.js';

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
  next();
}

// PIDs de los runners de chat VIVOS (bin/cwc-chat-runner.js). pgrep -f matchea
// la línea de comando completa: SOLO los runners, nunca src/server.js (el
// proceso principal) ni el propio pid. Exit 1 de pgrep = sin coincidencias, no
// es un error. Se excluye process.pid por las dudas (defensivo).
function liveRunnerPids() {
  let out = '';
  try {
    out = execFileSync('pgrep', ['-f', 'cwc-chat-runner\\.js'], { encoding: 'utf8' });
  } catch (e) {
    if (e.status === 1) return []; // sin runners vivos
    throw e;
  }
  return out
    .split('\n')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
}

export default {
  name: 'admin',

  init(ctx) { // eslint-disable-line no-unused-vars -- interfaz estándar (CLAUDE.md:162), no usado por este módulo
    return Promise.resolve();
  },

  registerWs(wss, ctx) { // eslint-disable-line no-unused-vars -- interfaz estándar (CLAUDE.md:162), no usado por este módulo
    // No-op: este módulo no usa WebSocket.
  },

  registerHttp(router, ctx) { // eslint-disable-line no-unused-vars -- ctx: interfaz estándar (CLAUDE.md:162), no usado por este módulo
    const r = express.Router();
    r.use(requireAdmin);

    r.get('/users', (req, res) => {
      try {
        res.json({ users: listUsers() });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    r.post('/users', (req, res) => {
      const { username, password, admin } = req.body || {};
      if (admin !== undefined && typeof admin !== 'boolean') {
        return res.status(400).json({ error: 'admin debe ser boolean.' });
      }
      try {
        createUser(username, password, typeof admin === 'boolean' ? admin : false);
        try {
          provisionNewUser(username);
        } catch (e) {
          console.error('[admin] provisioning inicial best-effort falló:', e?.message || e);
        }
        res.json({ ok: true });
      } catch (e) {
        res.status(e.badRequest ? 400 : 500).json({ error: e.message });
      }
    });

    r.put('/users/:username', (req, res) => {
      const { username } = req.params;
      const { password, admin } = req.body || {};
      if (admin !== undefined && typeof admin !== 'boolean') {
        return res.status(400).json({ error: 'admin debe ser boolean.' });
      }
      // Simétrico con `admin`: si vino `password` pero no es un string usable,
      // rechazar explícito en vez de ignorarlo en silencio (el cliente podría
      // creer que la contraseña se actualizó cuando no fue así).
      if (password !== undefined && (typeof password !== 'string' || !password.length)) {
        return res.status(400).json({ error: 'password debe ser un string no vacío.' });
      }
      const principal = principalOf(req);
      if (principal && principal.username === username) {
        return res.status(409).json({ error: 'No puedes modificar tu propio usuario.' });
      }
      try {
        let changed = false;
        if (typeof password === 'string' && password.length) {
          setPassword(username, password);
          // Cambio de contraseña ⇒ revocar sesiones vivas (típico ante cuenta
          // comprometida): la cookie vieja no debe seguir válida hasta vencer.
          invalidateSessionsForUser(username);
          changed = true;
        }
        if (typeof admin === 'boolean') {
          setAdmin(username, admin);
          changed = true;
          // Democión: revocar las sesiones vivas para que la cookie no siga
          // operando como admin hasta vencer (re-login toma el flag nuevo).
          if (admin === false) invalidateSessionsForUser(username);
        }
        if (!changed) return res.status(400).json({ error: 'Ningún parámetro válido enviado (password o admin).' });
        res.json({ ok: true, changed });
      } catch (e) {
        res.status(e.badRequest ? 400 : 500).json({ error: e.message });
      }
    });

    r.delete('/users/:username', async (req, res) => {
      const { username } = req.params;
      const principal = principalOf(req);
      if (principal && principal.username === username) {
        return res.status(409).json({ error: 'No puedes eliminar tu propio usuario.' });
      }
      // El host no se da de baja por esta vía: su espacio ES el HOME real del server
      // (userSpace(host) === config.home) y su workspace de Pad es `console`, no un
      // `tenant-*`. deprovisionUser ya lo rechaza con su guard G2, pero para cuando
      // llega ahí `deleteUser` ya lo sacó de users.json y el host queda sin cuenta.
      // Por eso el corte va acá arriba: el guard viejo solo cubría la
      // autoeliminación y con el token maestro (principal sin username) no aplicaba.
      if (username === hostUser()) {
        return res.status(409).json({ error: 'No se puede eliminar al usuario host de la consola.' });
      }
      try {
        deleteUser(username);
        // Usuario eliminado ⇒ ninguna sesión suya puede seguir viva.
        invalidateSessionsForUser(username);
        let cleanup = null;
        try {
          cleanup = await deprovisionUser(username);
        } catch (e) {
          // Un guard que salta acá significa que el username no era dado de
          // baja de forma segura (host, ruta fuera de la raíz multi-tenant).
          // El usuario ya salió de users.json: se informa sin romper la respuesta.
          cleanup = { ok: false, error: e.message };
        }
        res.json({ ok: true, cleanup });
      } catch (e) {
        res.status(e.badRequest ? 400 : 500).json({ error: e.message });
      }
    });

    // Reciclar los runners de chat: SIGTERM a cada bin/cwc-chat-runner.js vivo.
    // Al morir el runner, el server detecta el socket cerrado (RunnerLink.onClose
    // → Chat._engineDown) y lo RE-LANZA con `--resume <sessionId>` en la próxima
    // interacción del usuario, así que NO se pierde historial de la conversación.
    // Objetivo real: forzar que cada runner RE-LEA ~/.claude/.credentials.json al
    // re-inicializar sus MCP (el Agent SDK hereda la suscripción del CLI desde ese
    // archivo). Arregla el caso del MCP `pad` que queda silenciosamente sin cargar
    // en las corridas headless del SDK tras una credencial OAuth vieja: reciclar
    // los runners los hace re-leer las credenciales frescas del disco. NO reinicia
    // el servicio systemd ni el proceso principal — solo los hijos runner.
    r.post('/restart-runners', (req, res) => {
      try {
        const killed = [];
        const failed = [];
        for (const pid of liveRunnerPids()) {
          try {
            process.kill(pid, 'SIGTERM');
            killed.push(pid);
          } catch (err) {
            if (err.code === 'ESRCH') continue; // ya murió, no es un fallo
            // Otro error (p.ej. EPERM): no abortar todo el reciclado por un pid;
            // acumular y seguir con el resto para no dejar runners sin señal.
            failed.push({ pid, error: err.code || err.message });
          }
        }
        res.json({ killed: killed.length, pids: killed, failed });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    router.use('/admin', r);
  },
};
