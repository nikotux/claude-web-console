// modules/lab/index.js — backend de accesos admin del Laboratorio.
import fs from 'node:fs';
import path from 'node:path';
import { principalOf } from '../../core/auth.js';
import { resolveDataDir } from '../../core/data-dir.js';

function passwordFile() {
  return path.join(resolveDataDir(), 'lab', 'orca-vnc.pass');
}

export default {
  name: 'lab',

  registerHttp(router) {
    router.get('/lab/orca', (req, res) => {
      if (principalOf(req)?.admin !== true) {
        return res.status(403).json({ error: 'Solo administradores.' });
      }

      let password;
      try {
        password = fs.readFileSync(passwordFile(), 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return res.status(503).json({ error: 'El escritorio de Orca no está configurado.' });
        }
        return res.status(500).json({ error: 'No se pudo abrir el escritorio de Orca.' });
      }

      res.set('Cache-Control', 'no-store');
      return res.json({ password });
    });
  },
};
