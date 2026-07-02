// modules/admin/index.js — administración de usuarios (solo administradores).
//
// HTTP (todo bajo requireAdmin):
//   GET    /api/admin/users              -> lista de usuarios
//   POST   /api/admin/users             -> crea { username, password, admin }
//   PUT    /api/admin/users/:username    -> { password?, admin? }
//   DELETE /api/admin/users/:username    -> elimina
import express from 'express';
import { isAdmin } from '../../core/auth.js';
import { listUsers, createUser, setPassword, setAdmin, deleteUser } from '../../core/users.js';

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
  next();
}

export default {
  name: 'admin',

  registerHttp(router) {
    const r = express.Router();
    r.use(requireAdmin);

    r.get('/users', (req, res) => res.json({ users: listUsers() }));

    r.post('/users', (req, res) => {
      const { username, password, admin } = req.body || {};
      try {
        createUser(username, password, !!admin);
        res.json({ ok: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    r.put('/users/:username', (req, res) => {
      const { username } = req.params;
      const { password, admin } = req.body || {};
      try {
        if (typeof password === 'string' && password.length) setPassword(username, password);
        if (typeof admin === 'boolean') setAdmin(username, admin);
        res.json({ ok: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    r.delete('/users/:username', (req, res) => {
      try {
        deleteUser(req.params.username);
        res.json({ ok: true });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    });

    router.use('/admin', r);
  },
};
