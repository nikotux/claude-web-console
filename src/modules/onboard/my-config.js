// modules/onboard/my-config.js — checklist personal de onboarding.
// Este router se monta únicamente en el apiRouter post-auth: el usuario sale
// siempre de la sesión y nunca de query/body, incluso si la sesión es admin.
import express from 'express';
import { principalOf } from '../../core/auth.js';
import {
  blockingFor,
  CAPABILITIES,
  capabilityStatus,
  isHostUser,
  pendingFor,
  requiredFor,
} from './capabilities.js';
import { readProvisionState } from './provision-state.js';
import { provisionNewUser } from './provision-user.js';

export const myConfigRouter = express.Router();

function sessionUser(req, res) {
  const principal = principalOf(req);
  if (principal?.type === 'user' && principal.username) return principal.username;
  res.status(400).json({ error: 'Esta ruta requiere una sesión de usuario.' });
  return null;
}

async function configStatus(user) {
  const [status, pending, blocking] = await Promise.all([
    capabilityStatus(user),
    pendingFor(user),
    blockingFor(user),
  ]);
  const capabilities = [...CAPABILITIES]
    .sort((a, b) => a.order - b.order)
    .map((capability) => ({
      id: capability.id,
      order: capability.order,
      required: requiredFor(capability, user),
      labelEs: capability.labelEs,
      complete: !!status[capability.id],
      startPath: capability.startPath,
      statusPath: capability.statusPath,
    }));

  return {
    capabilities,
    pending,
    blocking,
    // Para el host el provisioning de alta no aplica: nunca corrió y no debe correr.
    hostExempt: isHostUser(user),
    provisioning: readProvisionState(user),
  };
}

myConfigRouter.get('/my-config', async (req, res) => {
  const user = sessionUser(req, res);
  if (!user) return;
  try {
    res.json(await configStatus(user));
  } catch {
    res.status(500).json({ error: 'No se pudo leer tu configuración.' });
  }
});

myConfigRouter.post('/my-config/retry', async (req, res) => {
  const user = sessionUser(req, res);
  if (!user) return;
  try {
    if (isHostUser(user)) {
      return res.status(409).json({
        error: 'El provisioning de alta no aplica al host: su espacio ya existe. Reintentarlo crearía un workspace de Pad fantasma y pisaría sus skills.',
        ...await configStatus(user),
      });
    }
    provisionNewUser(user);
    return res.json(await configStatus(user));
  } catch {
    return res.status(500).json({ error: 'No se pudo leer tu configuración.' });
  }
});
