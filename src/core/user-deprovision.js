// core/user-deprovision.js — baja best-effort de todos los recursos de un inquilino.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { listInvites, revokeInvite } from './onboard-tokens.js';
import { readHostPadToken, SHARED_WORKSPACE } from './pad-provision.js';
import { PAD_DEFAULT_URL } from './pad-url.js';
import { loadOwners } from './session-names.js';
import { moveToTrash } from './trash.js';
import { tmuxHasSession } from './bus.js';
import {
  USERS_ROOT,
  hostUser,
  readUserPadToken,
  sanitizeUserId,
  userPadWorkspace,
  userSpace,
} from './user-space.js';
import { deleteProvisionState, PROVISION_DIR } from '../modules/onboard/provision-state.js';

const PAD_URL = PAD_DEFAULT_URL;
const JOB_DIRS = [
  'onboard-jobs',
  'claude-login-jobs',
  'codex-login-jobs',
  'codex-jobs',
  'gh-login-jobs',
  'infisical-login',
  'tolkien-setup',
];

function badRequest(msg) {
  const e = new Error(msg);
  e.badRequest = true;
  return e;
}

function errorMessage(error) {
  return String(error?.message || error || 'error desconocido').slice(0, 200);
}

export async function deprovisionUser(username) {
  // Los primeros cuatro guards son fail-closed y se evalúan antes de tocar recursos:
  // G1 impide traversal/basura; G2 protege el HOME real del host; G3 exige
  // contención real bajo USERS_ROOT; G4 limita Pad al slug tenant exacto.
  // G5–G7 protegen la membresía compartida justo antes de intentar borrarla.
  let id;
  try {
    id = sanitizeUserId(username); // G1: nada de '../' ni basura.
  } catch (error) {
    throw badRequest(errorMessage(error));
  }
  if (id === hostUser()) { // G2: el más importante.
    // userSpace(host) devuelve config.home: el HOME REAL del dueño del server
    // (retrocompat del multi-tenant, user-space.js:38). Dar de baja al host
    // movería su casa entera a la papelera. Nunca, por ningún camino.
    throw badRequest('No se puede dar de baja al usuario host.');
  }
  const root = userSpace(id);
  const rel = path.relative(USERS_ROOT, root); // G3: contención REAL.
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    // `rel` vacío = el root ES ~/.cwc-users (la carpeta madre de TODOS).
    // Se compara con path.relative y no con startsWith de strings: un
    // startsWith deja pasar '~/.cwc-usersXX'.
    throw badRequest('Ruta de usuario fuera de la raíz multi-tenant.');
  }
  const slug = userPadWorkspace(id);
  const safePadSlug = !!slug && slug.startsWith('tenant-');

  const warnings = [];
  let pad;
  let shared;
  let trash = { status: 'absent' };
  const removed = [];
  let revoked = 0;

  // Paso 1 — Pad va primero: el token vive dentro de
  // ~/.cwc-users/<id>/.pad/credentials.json y el paso 4 se lleva ese espacio
  // a la papelera. El DELETE del Pad es soft: el workspace queda restaurable
  // y aparece en GET /api/v1/workspaces/deleted.
  // G4: borrar SOLO el slug tenant exacto evita iterar los workspaces visibles
  // con ese token y llevarse también `comunidad`, el pozo común de TODOS.
  if (!safePadSlug) {
    const error = 'Slug de workspace Pad inseguro; no se borró ningún workspace.';
    pad = { status: 'failed', slug: slug || undefined, error };
    warnings.push(error);
  } else {
    const token = readUserPadToken(id, PAD_URL);
    if (!token) {
      pad = { status: 'no-token' };
      warnings.push(`sin token de Pad para ${id}; no se pudo borrar ${slug}`);
    } else {
      try {
        const response = await fetch(`${PAD_URL}/api/v1/workspaces/${encodeURIComponent(slug)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(8000),
        });
        if (response.ok) {
          pad = { status: 'deleted', slug };
        } else if (response.status === 404) {
          pad = { status: 'not-found', slug };
        } else {
          const error = `Pad respondió HTTP ${response.status}`;
          pad = { status: 'failed', slug, error };
          warnings.push(`no se pudo borrar el workspace Pad ${slug}: ${error}`);
        }
      } catch (error) {
        const message = errorMessage(error);
        pad = { status: 'failed', slug, error: message };
        warnings.push(`no se pudo borrar el workspace Pad ${slug}: ${message}`);
      }
    }
  }

  // Paso 2 — el pozo común es el único recurso de Pad COMPARTIDO que toca un
  // inquilino. Si su membresía sobrevive a la baja, una cuenta eliminada
  // conserva acceso de escritura a las lecciones de todos.
  //
  // Limitación conocida: la API de Pad no permite revocar invitaciones
  // PENDIENTES, solo miembros reales. Si nunca aceptó, la invitación queda y
  // no hay forma de borrarla por API.
  const adminToken = readHostPadToken();
  if (!adminToken) {
    shared = { status: 'no-admin-token' };
    warnings.push(`sin token admin de Pad; no se pudo quitar a ${id} de ${SHARED_WORKSPACE}`);
  } else {
    try {
      const membersResponse = await fetch(
        `${PAD_URL}/api/v1/workspaces/${encodeURIComponent(SHARED_WORKSPACE)}/members`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!membersResponse.ok) {
        const error = `Pad respondió HTTP ${membersResponse.status} al listar miembros`;
        shared = { status: 'failed', error };
        warnings.push(`no se pudo verificar la membresía de ${id} en ${SHARED_WORKSPACE}: ${error}`);
      } else {
        const data = await membersResponse.json();
        const members = Array.isArray(data?.members) ? data.members : [];
        const email = `${id}@console.local`;
        // G5: igualdad exacta y case-sensitive. Un prefijo jamás identifica a
        // una persona dentro de un workspace compartido.
        const matches = members.filter((member) => member?.user_email === email);

        if (matches.length > 1) {
          // G7: ante ambigüedad no se toca ningún miembro.
          const reason = 'multiple-exact-matches';
          shared = { status: 'skipped', reason };
          warnings.push(
            `no se quitó a ${id} de ${SHARED_WORKSPACE}: hay ${matches.length} miembros con el email exacto`,
          );
        } else if (matches.length === 0) {
          shared = { status: 'not-member' };
        } else if (matches[0].role === 'owner') {
          // G6: ningún camino puede expulsar al dueño de su propio pozo.
          const reason = 'matched-member-is-owner';
          shared = { status: 'skipped', reason };
          warnings.push(`no se quitó a ${id} de ${SHARED_WORKSPACE}: el miembro encontrado es owner`);
        } else if (matches[0].user_id === undefined || matches[0].user_id === null) {
          const error = 'el miembro exacto no tiene user_id';
          shared = { status: 'failed', error };
          warnings.push(`no se pudo quitar a ${id} de ${SHARED_WORKSPACE}: ${error}`);
        } else {
          const deleteResponse = await fetch(
            `${PAD_URL}/api/v1/workspaces/${encodeURIComponent(SHARED_WORKSPACE)}/members/${encodeURIComponent(matches[0].user_id)}`,
            {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${adminToken}` },
              signal: AbortSignal.timeout(8000),
            },
          );
          if (deleteResponse.ok) {
            shared = { status: 'removed', workspace: SHARED_WORKSPACE };
          } else {
            const error = `Pad respondió HTTP ${deleteResponse.status} al borrar la membresía`;
            shared = { status: 'failed', error };
            warnings.push(`no se pudo quitar a ${id} de ${SHARED_WORKSPACE}: ${error}`);
          }
        }
      }
    } catch (error) {
      const message = errorMessage(error);
      shared = { status: 'failed', error: message };
      warnings.push(`no se pudo quitar a ${id} de ${SHARED_WORKSPACE}: ${message}`);
    }
  }

  // Paso 3 — no existe un helper owner-scoped que enumere Y mate sesiones.
  // Se dejan vivas y se informa el registro durable que tmux confirma activo.
  try {
    const liveSessions = Object.entries(loadOwners())
      .filter(([, owner]) => owner === id)
      .map(([sessionId]) => `cwc-${sessionId}`)
      .filter((name) => tmuxHasSession(name));
    if (liveSessions.length) {
      warnings.push(`quedaron ${liveSessions.length} sesión(es) tmux del usuario: ${liveSessions.join(', ')}`);
    }
  } catch (error) {
    warnings.push(`no se pudieron verificar las sesiones tmux de ${id}: ${errorMessage(error)}`);
  }

  // Paso 4 — decisión explícita: TODO el espacio va a la papelera recuperable
  // por 30 días, sin separar credenciales. Trade-off aceptado: durante ese
  // plazo las credenciales siguen legibles y el token Pad sigue vivo; el
  // workspace Pad del usuario, en cambio, ya desapareció en el paso 1.
  try {
    const trashId = moveToTrash(root, path.join('.cwc-users', id));
    trash = { status: 'moved', id: trashId };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      trash = { status: 'absent' };
    } else {
      trash = { status: 'failed' };
      warnings.push(`no se pudo mover el espacio de ${id} a la papelera: ${errorMessage(error)}`);
    }
  }

  // Paso 5 — estado administrativo del host: solo archivos cuyo nombre
  // empieza exactamente con "<id>."; nunca se arma un glob con el username.
  for (const dirName of JOB_DIRS) {
    const dir = path.join(config.home, '.cwc-data', dirName);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        warnings.push(`no se pudo listar .cwc-data/${dirName}: ${errorMessage(error)}`);
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(`${id}.`)) continue;
      try {
        await fs.unlink(path.join(dir, entry.name));
        removed.push(path.join('.cwc-data', dirName, entry.name));
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          warnings.push(`no se pudo borrar .cwc-data/${dirName}/${entry.name}: ${errorMessage(error)}`);
        }
      }
    }
  }

  const provisionFile = path.join(PROVISION_DIR, `${id}.json`);
  let provisionExisted = false;
  try {
    await fs.access(provisionFile);
    provisionExisted = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      warnings.push(`no se pudo verificar el estado de provisioning de ${id}: ${errorMessage(error)}`);
    }
  }
  try {
    if (deleteProvisionState(id)) {
      if (provisionExisted) {
        removed.push(path.join('.cwc-data', 'onboard-provisioning', `${id}.json`));
      }
    } else {
      warnings.push(`no se pudo borrar el estado de provisioning de ${id}`);
    }
  } catch (error) {
    warnings.push(`no se pudo borrar el estado de provisioning de ${id}: ${errorMessage(error)}`);
  }

  // Paso 6 — revocar invitaciones pendientes o bloqueadas a este usuario.
  try {
    const invites = listInvites().filter((invite) =>
      invite.lockedTo === id && invite.status !== 'consumed' && invite.status !== 'revoked');
    // No usa runAdaptivePool: el orden de los pasos es contrato de la baja y
    // estas revocaciones son secuenciales a propósito. Declarado en el exclude
    // de parallel-pool (src/core/inventory.js) para que Coherencia no lo remarque.
    for (const invite of invites) {
      try {
        if (revokeInvite(invite.id)) revoked += 1;
        else warnings.push(`no se pudo revocar la invitación ${invite.id} de ${id}`);
      } catch (error) {
        warnings.push(`no se pudo revocar la invitación ${invite.id} de ${id}: ${errorMessage(error)}`);
      }
    }
  } catch (error) {
    warnings.push(`no se pudieron listar las invitaciones de ${id}: ${errorMessage(error)}`);
  }

  return {
    ok: true,
    user: id,
    trash,
    pad,
    shared,
    jobs: { removed },
    invites: { revoked },
    warnings,
  };
}
