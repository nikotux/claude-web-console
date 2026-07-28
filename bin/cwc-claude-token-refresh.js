#!/usr/bin/env node
// bin/cwc-claude-token-refresh.js — sirve para diagnosticar/forzar desde la
// terminal la renovación OAuth de Claude de un usuario, sin mostrar nunca el
// token ni ninguna otra credencial.
//
// Uso: node bin/cwc-claude-token-refresh.js <userId>  (sin argumento: host)
import {
  refreshClaudeOauth,
  getValidClaudeAccessToken,
} from '../src/core/claude-oauth.js';
import { hostUser } from '../src/core/user-space.js';

const owner = process.argv[2] || hostUser();
const valid = await getValidClaudeAccessToken(owner);

if (!valid) {
  console.log(JSON.stringify({
    owner,
    ok: false,
    refreshed: false,
    expiresAt: null,
    subscription: null,
  }, null, 2));
  console.error('No se pudo obtener una credencial válida: probablemente faltan credenciales o venció el refresh token.');
  process.exitCode = 1;
} else {
  const expiresDate = new Date(Number(valid.oauth?.expiresAt));
  const hasExpiresAt = valid.oauth?.expiresAt != null && !Number.isNaN(expiresDate.getTime());
  console.log(JSON.stringify({
    owner,
    ok: true,
    refreshed: valid.refreshed,
    expiresAt: hasExpiresAt ? expiresDate.toISOString() : null,
    subscription: valid.oauth?.subscriptionType || null,
  }, null, 2));
}
