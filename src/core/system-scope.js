// core/system-scope.js — scope de las superficies del menú ⚙ Sistema.
//
// Centraliza la traducción del principal de la request a sus rutas: usar
// os.homedir() en el proceso del server delata siempre el HOME del host. Esta es
// la FUENTE ÚNICA para las superficies de Sistema. Un userId inválido propaga la
// excepción de sanitizeUserId (fail-closed); jamás cae al scope del host. El
// token maestro (o un principal admin sin username) conserva el scope host,
// pero una request sin principal tira: nunca obtiene el HOME por default.
import { principalOf } from './auth.js';
import {
  hostUser,
  userClaudeDir,
  userDataDir,
  userFileRoot,
  userPadWorkspace,
  userSpace,
} from './user-space.js';

function resolvedPrincipal(reqOrPrincipal) {
  if (reqOrPrincipal == null) return null;
  const isPrincipal = reqOrPrincipal
    && typeof reqOrPrincipal === 'object'
    && !('headers' in reqOrPrincipal)
    && ('username' in reqOrPrincipal || 'type' in reqOrPrincipal);
  return isPrincipal ? reqOrPrincipal : principalOf(reqOrPrincipal);
}

export function systemScopeFor(reqOrPrincipal) {
  const principal = resolvedPrincipal(reqOrPrincipal);
  if (!principal) throw new Error('systemScopeFor: request sin principal');
  const host = hostUser();
  const user = principal.username ?? ((principal.type === 'token' || principal.admin) ? host : null);
  if (!user) throw new Error('systemScopeFor: principal sin username');
  const isHost = user === host;

  return {
    user,
    isHost,
    admin: !!principal.admin,
    home: userSpace(user),
    dataDir: userDataDir(user),
    claudeDir: userClaudeDir(user),
    workspace: userFileRoot(user),
    padWorkspace: isHost ? 'console' : userPadWorkspace(user),
  };
}

export function isHostPrincipal(reqOrPrincipal) {
  return systemScopeFor(reqOrPrincipal).isHost;
}
