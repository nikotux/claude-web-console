import { loadInstance } from '../../core/instance-config.js';
import { listUsers } from '../../core/users.js';
import { hostUser, userDataDir } from '../../core/user-space.js';
import { getGithubProfile } from './store.js';

export const ATTRIBUTED_BOT_AUTHOR = 'app/tolkien-builder';
export const EXCLUDED_BOT_AUTHORS = ['app/mordor-staffing-updates', 'app/renovate', 'app/dependabot'];
export const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function githubLoginStatusForUsername(username) {
  const identity = loadInstance({ dataDir: userDataDir(username) })?.identity || {};
  const login = typeof identity.github === 'string' ? identity.github.trim() : '';
  return { login, configured: Boolean(login), valid: Boolean(login && GITHUB_LOGIN_RE.test(login)) };
}

function initialsFor(name, login) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? String(login || parts[0]).slice(0, 2) : `${parts[0][0]}${parts.at(-1)[0]}`).toUpperCase();
}

function firstGivenName(value) {
  return String(value || '').trim().split(/\s+/).find((token) => /\p{L}/u.test(token)) || null;
}

export function celebrationNameFrom(identityName, profileName) {
  return firstGivenName(identityName) || firstGivenName(profileName) || null;
}

export function excludeDuplicateLoginClaims(candidates, { warn = true } = {}) {
  const claims = new Map();
  for (const player of candidates) {
    const key = player.login.toLowerCase();
    if (!claims.has(key)) claims.set(key, []);
    claims.get(key).push(player);
  }
  const duplicated = new Set([...claims].filter(([, players]) => players.length > 1).map(([login]) => login));
  if (warn) {
    for (const login of [...duplicated].sort()) {
      const claimants = claims.get(login).map((player) => player.username).sort((a, b) => a.localeCompare(b));
      console.warn(`[forja] login GitHub ${claims.get(login)[0].login} reclamado por varios usuarios: ${claimants.join(', ')} — ninguno participa`);
    }
  }
  return candidates.filter((player) => !duplicated.has(player.login.toLowerCase()));
}

export function resolvePlayers({ warnDuplicateClaims = true } = {}) {
  const consoleUsers = listUsers();
  const cabinaUsers = new Set(consoleUsers
    .filter((user) => user.sponsorshipState !== 'none')
    .map((user) => user.username));
  const usernames = new Set([hostUser(), ...consoleUsers.map((user) => user.username)]);
  const candidates = [];
  for (const username of usernames) {
    if (cabinaUsers.has(username)) continue;
    const identity = loadInstance({ dataDir: userDataDir(username) })?.identity || {};
    const login = typeof identity.github === 'string' ? identity.github.trim() : '';
    if (!login || !GITHUB_LOGIN_RE.test(login)
      || EXCLUDED_BOT_AUTHORS.some((author) => author.toLowerCase() === login.toLowerCase())
      || login.toLowerCase() === ATTRIBUTED_BOT_AUTHOR.toLowerCase()) continue;
    const identityName = typeof identity.name === 'string' ? identity.name.trim() : '';
    const profile = getGithubProfile(username);
    const profileName = profile && profile.login.toLowerCase() === login.toLowerCase() ? profile.name : '';
    const displayName = identityName || profileName || username;
    candidates.push({
      username,
      login,
      displayName,
      celebrationName: celebrationNameFrom(identityName, profileName),
      initials: initialsFor(displayName, login),
      needsGithubName: !identityName && !profileName,
    });
  }

  const players = excludeDuplicateLoginClaims(candidates, { warn: warnDuplicateClaims });
  return players.sort((a, b) => a.displayName.localeCompare(b.displayName, 'es'));
}

export function playerForUsername(username, players = resolvePlayers()) {
  return players.find((player) => player.username === username) || null;
}

export function playerForBranch(branch, players) {
  const prefix = String(branch || '').split('/')[0].trim().toLowerCase();
  if (!prefix) return null;
  return players.find((player) => (
    player.login.toLowerCase() === prefix || player.username.toLowerCase() === prefix
  )) || null;
}
