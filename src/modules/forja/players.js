import { loadInstance } from '../../core/instance-config.js';
import { listUsers } from '../../core/users.js';
import { hostUser, userDataDir } from '../../core/user-space.js';

export const ATTRIBUTED_BOT_AUTHOR = 'app/tolkien-builder';
export const EXCLUDED_BOT_AUTHORS = ['app/mordor-staffing-updates', 'app/renovate', 'app/dependabot'];

function initialsFor(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : `${parts[0][0]}${parts.at(-1)[0]}`).toUpperCase();
}

export function resolvePlayers() {
  const usernames = new Set([hostUser(), ...listUsers().map((user) => user.username)]);
  const players = [];
  for (const username of usernames) {
    const identity = loadInstance({ dataDir: userDataDir(username) })?.identity || {};
    const login = typeof identity.github === 'string' ? identity.github.trim() : '';
    if (!login || EXCLUDED_BOT_AUTHORS.some((author) => author.toLowerCase() === login.toLowerCase())
      || login.toLowerCase() === ATTRIBUTED_BOT_AUTHOR.toLowerCase()) continue;
    const displayName = (typeof identity.name === 'string' && identity.name.trim()) || username;
    players.push({ username, login, displayName, initials: initialsFor(displayName) });
  }
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
