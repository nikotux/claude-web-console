// modules/admin/index.js — administración de usuarios (solo administradores).
//
// HTTP (todo bajo requireAdmin):
//   GET    /api/admin/users              -> lista de usuarios
//   POST   /api/admin/users             -> crea { username, password, admin }
//   PUT    /api/admin/users/:username    -> { password?, admin? }
//   DELETE /api/admin/users/:username    -> elimina
import express from 'express';
import { isAdmin, principalOf, invalidateSessionsForUser } from '../../core/auth.js';
import { listUsers, createUser, setPassword, setAdmin, deleteUser } from '../../core/users.js';

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
  next();
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
      const principal = principalOf(req);
      if (principal && principal.username === username) {
        return res.status(409).json({ error: 'No puedes modificar tu propio usuario.' });
      }
      try {
        let changed = false;
        if (typeof password === 'string' && password.length) {
          setPassword(username, password);
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

    r.delete('/users/:username', (req, res) => {
      const { username } = req.params;
      const principal = principalOf(req);
      if (principal && principal.username === username) {
        return res.status(409).json({ error: 'No puedes eliminar tu propio usuario.' });
      }
      try {
        deleteUser(username);
        // Usuario eliminado ⇒ ninguna sesión suya puede seguir viva.
        invalidateSessionsForUser(username);
        res.json({ ok: true });
      } catch (e) {
        res.status(e.badRequest ? 400 : 500).json({ error: e.message });
      }
    });

    router.use('/admin', r);
  },
};
