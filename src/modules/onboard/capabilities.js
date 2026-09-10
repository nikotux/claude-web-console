// modules/onboard/capabilities.js — catálogo declarativo de pasos del onboarding.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  hasCodexCreds,
  hasInfisicalCreds,
  hostUser,
  sanitizeUserId,
  userClaudeDir,
  userRunnerEnv,
  userSpace,
} from '../../core/user-space.js';
import { resolveClaudeCredential } from '../../core/sponsorship.js';
import { sponsorshipState, listUsers } from '../../core/users.js';

// El HOST no pasa por el wizard: su credencial es la del login real del CLI
// (`.credentials.json`), no el `oauth-token` que deja `claude setup-token`.
export function isHostUser(user) {
  try { return !!user && sanitizeUserId(user) === hostUser(); } catch { return false; }
}

// Detecta la credencial de cuenta completa que habilita el medidor de consumo.
export function hasClaudeAccountCreds(user) {
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(userClaudeDir(user), '.credentials.json'), 'utf8'),
    );
    return typeof data?.claudeAiOauth?.accessToken === 'string'
      && data.claudeAiOauth.accessToken.length > 0;
  } catch {
    return false;
  }
}

// `gh` guarda la sesión en el HOME del usuario. El detector corre con el mismo
// entorno aislado que los runners para no confundirla con la cuenta del host.
export function hasGithubAuth(user) {
  try {
    const result = spawnSync('gh', ['auth', 'status'], {
      cwd: userSpace(user),
      env: userRunnerEnv(user),
      stdio: 'ignore',
      timeout: 10_000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// `required` admite un boolean o un objeto segmentado. Las claves del objeto
// quedan deliberadamente abiertas: hoy resolvemos primero el tier patrocinado
// y, para el resto, conservamos el rol binario admin/usuario.
export const CAPABILITIES = [
  // Un patrocinado no genera credencial propia: usa la resolución central del
  // sponsor. Si ese sponsor aún no tiene oauth-token, el paso sigue incompleto.
  {
    id: 'claude',
    order: 1,
    required: { admin: true, usuario: true, patrocinado: false },
    labelEs: 'Credencial de Claude',
    detect: (user) => !!resolveClaudeCredential(user).token
      || (isHostUser(user) && hasClaudeAccountCreds(user)),
    startPath: '/creds-start',
    statusPath: '/creds-status',
  },
  // Habilita consultar el consumo real de la cuenta Claude.
  {
    id: 'account',
    order: 2,
    required: false,
    labelEs: 'Cuenta Claude completa',
    detect: (user) => hasClaudeAccountCreds(user),
    startPath: '/claude-account-start',
    statusPath: '/claude-account-status',
  },
  // Un patrocinado tampoco pasa por el login de Codex: por definición no se le
  // exige una cuenta propia para completar el alta.
  {
    id: 'codex',
    order: 3,
    required: { admin: true, usuario: true, patrocinado: false },
    labelEs: 'Codex',
    detect: (user) => hasCodexCreds(user),
    startPath: '/codex-start',
    statusPath: '/codex-status',
  },
  // El perfil patrocinado no es desarrollador: Infisical y GitHub se detectan
  // si existen, pero no bloquean su alta porque son herramientas de desarrollo.
  {
    id: 'infisical',
    order: 4,
    required: { admin: true, usuario: true, patrocinado: false },
    labelEs: 'Infisical',
    detect: (user) => hasInfisicalCreds(user),
    startPath: '/infisical-start',
    statusPath: '/infisical-status',
  },
  // Habilita clonar, consultar y pushear repositorios por HTTPS.
  {
    id: 'github',
    order: 5,
    required: { admin: true, usuario: true, patrocinado: false },
    labelEs: 'GitHub',
    detect: (user) => hasGithubAuth(user),
    startPath: '/github-start',
    statusPath: '/github-status',
  },
];

function detected(capability, user) {
  try {
    return !!capability.detect(user);
  } catch {
    return false;
  }
}

export function requiredFor(capability, user) {
  if (typeof capability?.required === 'boolean') return capability.required;

  const segmented = capability?.required;
  if (!segmented || typeof segmented !== 'object' || Array.isArray(segmented)) return true;

  const knownUser = typeof user === 'string'
    ? listUsers().find((candidate) => candidate.username === user)
    : null;
  if (!knownUser) return true;

  const segment = sponsorshipState(knownUser.username) !== 'none'
    ? 'patrocinado'
    : (knownUser.admin ? 'admin' : 'usuario');
  // Ante un segmento ausente o inválido cerramos el gate: pedir un paso de más
  // es recuperable; dar el alta incompleta deja al usuario mal provisionado.
  return typeof segmented[segment] === 'boolean' ? segmented[segment] : true;
}

export function capabilityStatus(user) {
  if (!user) return Object.fromEntries(CAPABILITIES.map((capability) => [capability.id, false]));
  return Object.fromEntries(
    CAPABILITIES.map((capability) => [capability.id, detected(capability, user)]),
  );
}

export function pendingFor(user) {
  if (!user) return [];
  return [...CAPABILITIES]
    .sort((a, b) => a.order - b.order)
    .filter((capability) => !detected(capability, user))
    .map((capability) => capability.id);
}

export function blockingFor(user) {
  if (!user) return [];
  return [...CAPABILITIES]
    .sort((a, b) => a.order - b.order)
    .filter((capability) => requiredFor(capability, user) && !detected(capability, user))
    .map((capability) => capability.id);
}

export function capabilityById(id) {
  return CAPABILITIES.find((capability) => capability.id === id) || null;
}
