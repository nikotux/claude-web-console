// SOLO SERVER: importarlo instala los resolvers; todo entry point de server/host
// que use retro con owner debe importarlo.
import {
  hostUser, readUserOauthToken, userClaudeDir, userDataDir, userRunnerEnv,
} from '../../core/user-space.js';
import { installRetroServerResolvers } from './owner-dirs.js';

function runnerEnvFor(owner, { oauth = true, missingOauthMessage = 'Necesitás conectar tu cuenta de Claude.' } = {}) {
  if (!owner || owner === hostUser()) return process.env;
  if (!oauth) return userRunnerEnv(owner);
  const oauthToken = readUserOauthToken(owner);
  if (!oauthToken) {
    const error = new Error(missingOauthMessage);
    error.conflict = true;
    throw error;
  }
  return userRunnerEnv(owner, { oauthToken });
}

installRetroServerResolvers({ hostUser, userDataDir, userClaudeDir, runnerEnvFor });

export { queueRetroDistill } from './shared.js';
