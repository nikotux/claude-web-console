// core/pad-context.js — deriva el PadContext {url, token, workspace} del
// INQUILINO dueño de una request (o de un userId, para los runners), para el
// multi-tenant B2 (ver PLAN-623 / DOC-633). El HOST (Niko/admin) → null, que
// pad-service-client resuelve al Pad de 'console' con el token de ~/.pad
// (retrocompat total). Un INQUILINO → su propio {url, token, workspace}.
//
// CONTRATO de aislamiento: para un inquilino SIEMPRE se devuelve un ctx cuyo
// `workspace` es su tenant-<userId>. Si su token aún no está provisionado
// (readUserPadToken → null), el ctx viaja igual con token null; la operación
// contra Pad falla limpio (403/sin token) SIN contaminar el workspace 'console'
// del host — nunca se cae silenciosamente al Pad de Niko. (F8 agregará el
// provisioning lazy que llena ese token.)
import { readUserPadToken, userPadWorkspace, hostUser } from './user-space.js';
import { principalOf } from './auth.js';
import { provisionUserPad, reloginUserPad, SHARED_WORKSPACE, readHostPadToken } from './pad-provision.js';
import { setUnauthorizedHandler } from './pad-service-client.js';
import { PAD_DEFAULT_URL } from './pad-url.js';

// MISMA URL que usan pad-service-client.js y pad-provision.js.
const PAD_URL = PAD_DEFAULT_URL;
const tenantByToken = new Map(); // token -> userId; nunca contiene al host

// Dado un userId (o null), devuelve el PadContext del inquilino, o null si es
// el host (o no hay usuario → host). Lo usan los RUNNERS desacoplados, que
// reciben el userId del owner por su job y reconstruyen el ctx acá.
export function padContextForUser(userId) {
  if (!userId || userId === hostUser()) return null; // host → default (Niko/console)
  const token = readUserPadToken(userId, PAD_URL);
  if (token != null) tenantByToken.set(token, userId);
  return {
    url: PAD_URL,
    token, // puede ser null si aún no provisionado (ver contrato)
    workspace: userPadWorkspace(userId),
  };
}

// Ctx del POZO COMÚN (console:PLAN-2222). A diferencia de padContextForUser,
// SIEMPRE devuelve un ctx con workspace explícito — también para el host, que
// si no caería al default `console` de pad-service-client.
// FAIL-CLOSED: un inquilino sin token propio viaja con token:null y la op falla
// limpio (403). NUNCA se cae al token del host: una donación escrita con la
// credencial de Niko falsearía la autoría (C2/C5 del plan).
export function sharedPadContextForUser(userId) {
  if (!userId || userId === hostUser()) {
    return { url: PAD_URL, token: readHostPadToken(), workspace: SHARED_WORKSPACE };
  }
  const token = readUserPadToken(userId, PAD_URL);
  if (token != null) tenantByToken.set(token, userId);
  return {
    url: PAD_URL,
    token,
    workspace: SHARED_WORKSPACE,
  };
}

// LAZY PROVISIONING (F8): un inquilino cuyo Pad aún no tiene token dispara su
// provisión en background. Dedup (Set de userIds con una provisión EN VUELO) +
// cooldown (no re-intentar dentro de PROVISION_COOLDOWN_MS si acaba de fallar,
// para no martillar a Pad si está caído / sin token admin). Fire-and-forget:
// nunca bloquea el request; este degrada, el próximo ya tiene el token en disco.
const provisioning = new Set();
const lastProvisionAttempt = new Map();
const PROVISION_COOLDOWN_MS = 30_000;

function maybeLazyProvision(userId) {
  if (provisioning.has(userId)) return;
  const last = lastProvisionAttempt.get(userId) || 0;
  if (Date.now() - last < PROVISION_COOLDOWN_MS) return;
  provisioning.add(userId);
  lastProvisionAttempt.set(userId, Date.now());
  provisionUserPad(userId)
    .catch(() => { /* best-effort: si falla, el cooldown evita el martilleo y se reintenta luego */ })
    .finally(() => provisioning.delete(userId));
}

// Un 401 de un token tenant dispara un solo re-login en background por usuario.
// El cooldown evita martillar Pad si el password falta o el servicio está caído.
const relogging = new Set();
const lastReloginAttempt = new Map();
const RELOGIN_COOLDOWN_MS = 5 * 60_000;

function maybeLazyRelogin(userId) {
  if (relogging.has(userId)) return;
  const last = lastReloginAttempt.get(userId) || 0;
  if (Date.now() - last < RELOGIN_COOLDOWN_MS) return;
  relogging.add(userId);
  lastReloginAttempt.set(userId, Date.now());
  reloginUserPad(userId)
    .then((result) => {
      if (!result?.ok) return;
      // La próxima derivación registrará el token nuevo; los anteriores ya no
      // deben volver a disparar re-logins por requests que quedaron en vuelo.
      for (const [token, owner] of tenantByToken) {
        if (owner === userId) tenantByToken.delete(token);
      }
    })
    .catch(() => { /* best-effort: el request que vio el 401 ya degradó limpio */ })
    .finally(() => relogging.delete(userId));
}

setUnauthorizedHandler(({ token }) => {
  const userId = tenantByToken.get(token);
  if (userId) maybeLazyRelogin(userId);
});

// Deriva el PadContext del principal de una request HTTP. host/token/null → null.
export function reqPadContext(req) {
  const p = principalOf(req);
  const userId = p?.username || null;
  const ctx = padContextForUser(userId);
  // Inquilino con ctx pero SIN token → aún no provisionado: dispararlo en
  // background (dedup + cooldown). ctx tiene su workspace tenant-* igual, así que
  // este request falla limpio (403/sin token) sin contaminar el Pad del host.
  if (ctx && !ctx.token) maybeLazyProvision(userId);
  return ctx;
}

// El pozo comparte workspace, no identidad: conserva la credencial del principal
// y sólo dispara el mismo provisioning lazy cuando falta la del inquilino.
export function reqSharedPadContext(req) {
  const p = principalOf(req);
  const userId = p?.username || null;
  const ctx = sharedPadContextForUser(userId);
  if (userId && userId !== hostUser() && !ctx.token) maybeLazyProvision(userId);
  return ctx;
}
