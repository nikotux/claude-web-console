// modules/bugfixes/link-shared.js — vinculación de un PR YA EXISTENTE de GitHub
// a un registro del tablero (bugfixes.json).
//
// Cierra el punto ciego "el tablero no se entera del trabajo hecho en los chats"
// (bug 2026-07-05, caso FEAT-2/PR #249; mismo patrón que Desk #519/PR #232): un
// PR creado por FUERA del módulo "Enviar PR" (gh pr create desde un chat o un
// worktree externo) dejaba el registro huérfano para siempre — 'pendiente', sin
// prNumber, "falta enviar el PR" con el PR ya abierto.
//
// TRES consumidores, UNA lógica (por eso vive acá y no en index.js):
//   - POST /api/bugfixes/link-pr  (vínculo manual desde el tablero, admin)
//   - la RECONCILIACIÓN de refresh-prs (adopción automática por título/branch)
//   - bin/cwc-bugfix-link.js (el propio chat lo corre tras publicar por la
//     excepción autorizada — patrón cwc-health-resolve, determinístico, 0 tokens)
//
// OJO: este módulo NO importa core/config.js a propósito — config exige
// CWC_TOKEN y hace process.exit fuera del repo, y el CLI corre desde cualquier
// cwd (p.ej. ~/tolkien). El projectDir para gh viaja por parámetro.
import { execFile } from 'node:child_process';
import { listBugfixes, saveBugfixes, addEvent } from './store.js';

export const normalizePrState = (s) => (s === 'MERGED' ? 'merged' : s === 'CLOSED' ? 'closed' : 'open');

// gh pr view → objeto normalizado (LECTURA de red; cwd = repo de Tolkien).
export function fetchPr(prNumber, projectDir) {
  return new Promise((resolve, reject) => {
    execFile('gh', [
      'pr', 'view', String(prNumber),
      '--json', 'number,state,url,title,createdAt,headRefName,mergedAt,mergedBy,additions,deletions,changedFiles',
    ], { cwd: projectDir, timeout: 60000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`gh pr view: ${String(stderr || err.message).trim().slice(0, 300)}`));
      let pr;
      try { pr = JSON.parse(stdout); } catch { return reject(new Error('gh pr view: respuesta no parseable.')); }
      resolve({
        number: pr.number,
        state: normalizePrState(pr.state),
        url: pr.url || null,
        title: pr.title || '',
        headRefName: pr.headRefName || null,
        createdAt: pr.createdAt ? Date.parse(pr.createdAt) : null,
        mergedAt: pr.mergedAt ? Date.parse(pr.mergedAt) : null,
        mergedBy: pr.mergedBy?.login || null,
        stats: { add: pr.additions ?? 0, del: pr.deletions ?? 0, files: pr.changedFiles ?? 0, src: 'github' },
      });
    });
  });
}

// Mutación PURA (sin I/O): aplica el vínculo al registro. `pr` ya normalizado
// (shape de fetchPr o de las filas de gh pr list en refresh-prs). Idempotente:
// re-vincular el MISMO PR refresca campos sin duplicar eventos.
export function applyPrLink(entry, pr, { mode = 'manual' } = {}) {
  const relink = entry.prNumber === pr.number;
  entry.prNumber = pr.number;
  entry.prUrl = pr.url || entry.prUrl || null;
  entry.branch = pr.headRefName || pr.branch || entry.branch || null;
  // El PR ya existe en GitHub: el registro pasa a SEGUIRLO ('subido', como si
  // hubiera salido del módulo). refresh-prs FASE 2 lo mantiene desde acá.
  entry.status = 'subido';
  entry.prState = pr.state;
  entry.sentAt = entry.sentAt || pr.createdAt || Date.now();
  if (pr.stats) entry.stats = pr.stats;
  if (!relink) addEvent(entry, 'pr_vinculado', { pr: pr.number, mode, branch: entry.branch || null });
  if (pr.state === 'merged') {
    entry.mergedAt = pr.mergedAt || entry.mergedAt || Date.now();
    entry.mergedBy = pr.mergedBy || entry.mergedBy || null;
    if (!(entry.history || []).some((e) => e.type === 'pr_mergeado' && e.pr === pr.number)) {
      addEvent(entry, 'pr_mergeado', { pr: pr.number, by: entry.mergedBy });
    }
  }
  entry.updatedAt = Date.now();
  return entry;
}

// Camino COMPLETO (endpoint y CLI): resuelve el registro (por sessionId o por
// ticketNumber/FEAT-n), trae el estado REAL del PR con gh y persiste el vínculo.
// Lanza Error con mensaje humano en todo caso inválido (el caller decide el 4xx).
export async function linkPrToRegistry({ sessionId = null, ticket = null, prNumber, projectDir, mode = 'manual' }) {
  const n = Number(prNumber);
  if (!Number.isInteger(n) || n <= 0) throw new Error('Número de PR inválido.');
  const all = listBugfixes();
  let entry = sessionId ? all.find((b) => b.sessionId === sessionId) : null;
  if (!entry && ticket) {
    const key = String(ticket).toLowerCase();
    const cands = all.filter((b) => String(b.ticketNumber || '').toLowerCase() === key && !b.archived);
    // Preferencia: el registro SIN PR (el huérfano típico); después el que siga vivo.
    entry = cands.find((b) => !b.prNumber && b.prState !== 'merged')
      || cands.find((b) => b.prState !== 'merged') || null;
  }
  if (!entry) throw new Error(`No hay registro en el tablero para ${sessionId || ticket} (¿el ítem existe? ¿está archivado?).`);
  if (entry.prNumber && entry.prNumber !== n) {
    throw new Error(`El registro ya está vinculado al PR #${entry.prNumber} (${entry.prState || '?'}); cancelalo o usá otro registro.`);
  }
  const pr = await fetchPr(n, projectDir);
  if (pr.state === 'closed') throw new Error(`El PR #${n} está CERRADO sin merge: no se vincula (rehacé el fix o vinculá el PR correcto).`);
  applyPrLink(entry, pr, { mode });
  saveBugfixes(all);
  return entry;
}
