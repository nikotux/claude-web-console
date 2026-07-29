// modules/onboard/capabilities.js — catálogo declarativo de pasos del onboarding.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  hasCodexCreds,
  hasInfisicalCreds,
  readUserOauthToken,
  userClaudeDir,
  userRunnerEnv,
  userSpace,
} from '../../core/user-space.js';

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

export const CAPABILITIES = [
  // Habilita ejecutar Claude con la credencial propia del usuario.
  {
    id: 'claude',
    order: 1,
    required: true,
    labelEs: 'Credencial de Claude',
    detect: (user) => !!readUserOauthToken(user),
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
  // Habilita usar Codex como proveedor del chat.
  {
    id: 'codex',
    order: 3,
    required: true,
    labelEs: 'Codex',
    detect: (user) => hasCodexCreds(user),
    startPath: '/codex-start',
    statusPath: '/codex-status',
  },
  // Habilita acceder a secretos y servicios respaldados por Infisical.
  {
    id: 'infisical',
    order: 4,
    required: true,
    labelEs: 'Infisical',
    detect: (user) => hasInfisicalCreds(user),
    startPath: '/infisical-start',
    statusPath: '/infisical-status',
  },
  // Habilita clonar, consultar y pushear repositorios por HTTPS.
  {
    id: 'github',
    order: 5,
    required: true,
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
    .filter((capability) => capability.required && !detected(capability, user))
    .map((capability) => capability.id);
}

export function capabilityById(id) {
  return CAPABILITIES.find((capability) => capability.id === id) || null;
}
