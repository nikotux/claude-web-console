// core/sponsorship.js — punto ÚNICO donde se materializa la excepción nominal
// al blindaje anticonsumo: un usuario declarado como sponsored puede usar el
// setup-token dedicado de su sponsor sin perder su HOME ni sus datos aislados.
//
// Riesgo ACEPTADO explícitamente por Nico el 2026-08-29: Bash permite que el
// patrocinado lea /proc/self/environ de su runner y conserve el token prestado.
// Se acepta por confianza, igual que la Ley 5 de Aduana; no se recorta Bash ni
// bypassPermissions para mitigarlo. Ningún consumidor debe re-derivar acá las
// reglas de patrocinio: sólo debe usar resolveClaudeCredential().
import { sponsorshipState, sponsorOf, listUsers } from './users.js';
import {
  readUserOauthToken,
  sanitizeUserId,
  hostUser,
} from './user-space.js';

const unresolved = (state, sponsor = null) => ({
  token: null,
  source: null,
  sponsor,
  state,
});

function readSponsorshipToken(sponsor) {
  const sponsorId = sanitizeUserId(sponsor);
  // Para el host, este camino apunta a ~/.claude/oauth-token: el setup-token
  // dedicado y revocable. Nunca se consulta ~/.claude/.credentials.json.
  if (sponsorId === hostUser()) return readUserOauthToken(hostUser());
  return readUserOauthToken(sponsorId);
}

export function resolveClaudeCredential(userId) {
  let owner;
  try {
    owner = sanitizeUserId(userId);
  } catch {
    return unresolved('none');
  }

  const state = sponsorshipState(owner);
  const ownToken = readUserOauthToken(owner);
  if (ownToken) return {
    token: ownToken,
    source: 'own',
    sponsor: null,
    state,
  };

  if (state !== 'sponsored') return unresolved(state);

  const sponsor = sponsorOf(owner);
  let sponsorId;
  try {
    sponsorId = sanitizeUserId(sponsor);
  } catch {
    return unresolved(state, sponsor);
  }
  const sponsorUser = listUsers().find((u) => u.username === sponsorId);
  // Un perfil patrocinado normalmente no tiene credencial propia que prestar,
  // así que una cadena ya terminaría sin token. El guard explícito se conserva
  // como defensa en profundidad y para mantener inequívoco el fallo.
  if (!sponsorUser
    || sponsorId === owner
    || sponsorshipState(sponsorId) !== 'none') {
    return unresolved(state, sponsor);
  }

  const token = readSponsorshipToken(sponsorId);
  return token
    ? {
      token,
      source: 'sponsored',
      sponsor: sponsorId,
      state,
    }
    : unresolved(state, sponsorId);
}

export function sponsorTokenReady(sponsor) {
  try {
    return !!readSponsorshipToken(sponsor);
  } catch {
    return false;
  }
}
