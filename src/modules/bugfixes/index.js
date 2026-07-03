// modules/bugfixes/index.js — seguimiento de fixes de tickets y subida de PRs.
//
// HTTP (la UI vive en la pestaña Salud del menú ⚙ Sistema):
//   GET  /api/bugfixes          -> { bugfixes } (todos los autenticados)
//   POST /api/bugfixes/scan     -> registra chats de tickets viejos sin registro (admin)
//   POST /api/bugfixes/pr {id}  -> branch + commit + push + PR a origin de Tolkien (admin)
//   POST /api/bugfixes/refresh-prs -> estado real de los PRs desde GitHub (admin)
//   GET  /api/bugfixes/context?kind=work|pr -> contexto editable (autenticados)
//   POST /api/bugfixes/context {kind, context} -> guarda el contexto (admin)
//   POST /api/bugfixes/cancel-pr {id} -> cierra el PR + borra el branch remoto
//        y el registro vuelve a 'pendiente' para rehacer el fix (admin)
//   POST /api/bugfixes/delete {id} -> descarta un registro (admin)
//
// GIT/PR — decisiones duras:
//  - SOLO opera sobre config.projectDir (Tolkien) y SOLO empuja el branch del
//    fix a SU PROPIO origin (el PR a Chris es el flujo de trabajo del repo de
//    la empresa). La regla 5 de CLAUDE.md (bloqueo Mordor-Staffing) protege el
//    código de la CONSOLA, que acá nunca se toca.
//  - El branch se arma en un WORKTREE TEMPORAL desde origin/main: el árbol de
//    trabajo real de Tolkien no se toca (ni checkout ni stash). Se copian solo
//    los archivos del registro y se commitea la diferencia.
//  - Necesita SSH agent (push) y gh autenticado (PR); sin gh cae a la URL de
//    compare para abrir el PR a mano.
import express from 'express';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { config } from '../../core/config.js';
import { isAdmin } from '../../core/auth.js';
import { listBugfixes, saveBugfixes, scanUnregistered, getContext, saveContext, DEFAULT_CONTEXTS } from './store.js';

const WT_BASE = path.join(os.homedir(), '.cwc-data', 'bugfix-wt');
const inFlight = new Set(); // sessionIds con PR en curso (anti doble click)

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args[0]}: ${String(stderr || err.message).trim().slice(0, 400)}`));
      else resolve(String(stdout).trim());
    });
  });
}

// Notas del PR: arrancan SIEMPRE con las respuestas formales a "cuál fue el
// problema", "qué hice" y "¿concuerda con la mejor solución?". El cierre del
// chat trae esos marcadores (los pide el contexto de trabajo editable); si el
// resumen no los tiene, se cae a lo que haya registrado.
export function formatPrBody(entry) {
  const s = String(entry.summary || '');
  const grab = (label) => {
    const re = new RegExp(`^\\**${label}\\**\\s*:\\s*([\\s\\S]*?)(?=^\\**(?:Problema|Qu[eé] hice|Mejor soluci[oó]n)\\**\\s*:|\\s*$)`, 'im');
    return (s.match(re) || [])[1]?.trim() || null;
  };
  const problema = grab('Problema') || (entry.title || '').replace(/^TKT #[\w.-]+ ?[—-]? ?/, '') || '(no registrado)';
  const queHice = grab('Qu[eé] hice') || (s && !grab('Problema') ? s : '(no registrado en el cierre del chat)');
  const mejor = grab('Mejor soluci[oó]n') || '(no evaluado en el cierre del chat)';
  return [
    `**Problema:** ${problema}`,
    '',
    `**Qué se hizo:** ${queHice}`,
    '',
    `**¿Es la mejor solución?:** ${mejor}`,
    '',
    entry.ticketUrl ? `Ticket Desk #${entry.ticketNumber}: ${entry.ticketUrl}` : (entry.ticketNumber ? `Ticket Desk #${entry.ticketNumber}` : ''),
    '',
    '_PR generado desde Claude Web Console (fix trabajado en una sesión de chat registrada)._',
  ].filter((l, i, a) => l || a[i - 1]).join('\n');
}

// URL de compare como fallback si gh no puede crear el PR.
function compareUrl(originUrl, branch) {
  const m = String(originUrl).match(/github\.com[:/](.+?)(?:\.git)?$/);
  return m ? `https://github.com/${m[1]}/compare/main...${encodeURIComponent(branch)}?expand=1` : null;
}

// Estado REAL de un PR en GitHub ('open'|'merged'|'closed'); sin gh o PR
// inaccesible devuelve el estado registrado (mismo criterio que cancelPr).
async function realPrState(entry) {
  let state = entry.prState || 'open';
  if (entry.prNumber) {
    try {
      const s = JSON.parse(await run('gh', ['pr', 'view', String(entry.prNumber), '--json', 'state'], { cwd: config.projectDir })).state;
      state = s === 'MERGED' ? 'merged' : s === 'CLOSED' ? 'closed' : 'open';
    } catch { /* estado registrado */ }
  }
  return state;
}

async function pushPr(entry) {
  const TOLKIEN = config.projectDir;

  // ¿La entrada ya tiene un PR montado? Verificar el estado REAL en GitHub
  // ANTES de decidir: ABIERTO -> ACTUALIZAR ese PR (commit encima de su
  // branch, sin --force, mismo número de PR — ticket reabierto no duplica
  // PRs); MERGEADO o CERRADO -> ciclo terminado, sigue el camino de PR nuevo
  // (branch nuevo: el sessionId del registro ya es el del chat más reciente).
  if (entry.branch && entry.prNumber && await realPrState(entry) === 'open') {
    return updatePr(entry);
  }

  const safeNum = String(entry.ticketNumber || 'sn').replace(/[^\w.-]/g, '').slice(0, 20) || 'sn';
  const branch = `bugfix/tkt-${safeNum}-${entry.sessionId.slice(0, 8)}`;
  const wt = path.join(WT_BASE, entry.sessionId);

  // Limpieza de un intento anterior a medias.
  await run('git', ['worktree', 'remove', '--force', wt], { cwd: TOLKIEN }).catch(() => {});
  await run('git', ['branch', '-D', branch], { cwd: TOLKIEN }).catch(() => {});

  await run('git', ['fetch', 'origin', 'main'], { cwd: TOLKIEN });
  fss.mkdirSync(WT_BASE, { recursive: true, mode: 0o700 });
  await run('git', ['worktree', 'add', '-b', branch, wt, 'origin/main'], { cwd: TOLKIEN });

  try {
    // Copiar SOLO los archivos del fix desde el árbol real al worktree.
    const copied = [];
    for (const rel of entry.files) {
      const src = path.resolve(TOLKIEN, rel);
      const dst = path.resolve(wt, rel);
      // EXCLUSIVO de ~/tolkien: ni origen ni destino pueden salirse (aunque
      // el registro se haya editado a mano con ../).
      if (!src.startsWith(TOLKIEN + path.sep) || !dst.startsWith(wt + path.sep)) continue;
      if (!fss.existsSync(src)) continue;           // borrado después del chat
      fss.mkdirSync(path.dirname(dst), { recursive: true });
      fss.copyFileSync(src, dst);
      copied.push(rel);
    }
    if (!copied.length) throw new Error('Ninguno de los archivos del fix existe en el árbol de Tolkien.');

    await run('git', ['add', '--', ...copied], { cwd: wt });
    const dirty = await run('git', ['status', '--porcelain'], { cwd: wt });
    if (!dirty) throw new Error('Sin diferencias contra origin/main (¿el fix ya está mergeado?).');

    const title = `Fix TKT #${entry.ticketNumber || '?'}: ${(entry.title || '').replace(/^TKT #[\w.-]+ ?[—-]? ?/, '').slice(0, 70) || 'bugfix'}`;
    const body = formatPrBody(entry);

    await run('git', ['commit', '-m', `${title}\n\n${body}`], { cwd: wt });
    await run('git', ['push', '-u', 'origin', branch], { cwd: wt });

    let prUrl = null;
    try {
      prUrl = await run('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body', body], { cwd: wt });
      prUrl = (prUrl.match(/https:\/\/\S+/) || [null])[0];
      // Reviewer = Chris (mergea los PRs del repo). Best-effort: si falla, el
      // PR ya existe igual.
      if (prUrl) await run('gh', ['pr', 'edit', prUrl, '--add-reviewer', 'cswenor'], { cwd: wt }).catch(() => {});
    } catch { /* sin gh o sin permisos de PR: cae al compare */ }
    if (!prUrl) {
      const origin = await run('git', ['remote', 'get-url', 'origin'], { cwd: TOLKIEN });
      prUrl = compareUrl(origin, branch);
    }
    const prNumber = Number((String(prUrl).match(/\/pull\/(\d+)/) || [])[1]) || null;
    return { branch, prUrl, prNumber, files: copied };
  } finally {
    await run('git', ['worktree', 'remove', '--force', wt], { cwd: TOLKIEN }).catch(() => {});
    await run('git', ['branch', '-D', branch], { cwd: TOLKIEN }).catch(() => {}); // el remoto ya lo tiene
  }
}

// ACTUALIZA un PR existente (abierto): worktree desde el branch DEL PR (no
// desde main), se copian los archivos del fix y el commit nuevo va ENCIMA
// del historial existente — push fast-forward, jamás --force (historial
// limpio para el reviewer). Además refresca el body del PR con las notas del
// último cierre y deja un comentario avisando (editar el body no notifica;
// el comentario sí). Best-effort en la parte gh: el push ya actualizó el PR.
async function updatePr(entry) {
  const TOLKIEN = config.projectDir;
  const branch = entry.branch;
  const wt = path.join(WT_BASE, entry.sessionId);

  await run('git', ['worktree', 'remove', '--force', wt], { cwd: TOLKIEN }).catch(() => {});
  await run('git', ['branch', '-D', branch], { cwd: TOLKIEN }).catch(() => {});

  // Base = el branch del PR tal cual está en GitHub. Si el fetch falla, el
  // branch remoto ya no existe (borrado a mano): mensaje claro, sin adivinar.
  try {
    await run('git', ['fetch', 'origin', branch], { cwd: TOLKIEN });
  } catch {
    throw new Error(`El branch del PR (${branch}) ya no existe en GitHub. Cancelá el PR desde el detalle y volvé a enviarlo como PR nuevo.`);
  }
  fss.mkdirSync(WT_BASE, { recursive: true, mode: 0o700 });
  await run('git', ['worktree', 'add', '-B', branch, wt, `origin/${branch}`], { cwd: TOLKIEN });

  try {
    const copied = [];
    for (const rel of entry.files) {
      const src = path.resolve(TOLKIEN, rel);
      const dst = path.resolve(wt, rel);
      if (!src.startsWith(TOLKIEN + path.sep) || !dst.startsWith(wt + path.sep)) continue;
      if (!fss.existsSync(src)) continue;
      fss.mkdirSync(path.dirname(dst), { recursive: true });
      fss.copyFileSync(src, dst);
      copied.push(rel);
    }
    if (!copied.length) throw new Error('Ninguno de los archivos del fix existe en el árbol de Tolkien.');

    await run('git', ['add', '--', ...copied], { cwd: wt });
    const dirty = await run('git', ['status', '--porcelain'], { cwd: wt });
    if (!dirty) throw new Error('Sin cambios nuevos respecto de lo que YA tiene el PR (¿el trabajo nuevo tocó los mismos contenidos?).');

    const title = `Update TKT #${entry.ticketNumber || '?'}: ${(entry.title || '').replace(/^TKT #[\w.-]+ ?[—-]? ?/, '').slice(0, 70) || 'bugfix'}`;
    const body = formatPrBody(entry);
    await run('git', ['commit', '-m', `${title}\n\n${body}`], { cwd: wt });
    // Fast-forward sobre el branch del PR: GitHub actualiza el MISMO PR.
    await run('git', ['push', 'origin', branch], { cwd: wt });

    // Notas del PR al día + aviso al reviewer (best-effort: el PR ya se actualizó).
    await run('gh', ['pr', 'edit', String(entry.prNumber), '--body', body], { cwd: wt }).catch(() => {});
    await run('gh', ['pr', 'comment', String(entry.prNumber), '--body',
      'PR actualizado desde la consola: el ticket se retrabajó y este PR recibió los cambios nuevos (commit adicional en el branch). Notas del PR actualizadas.'], { cwd: wt }).catch(() => {});

    return { branch, prUrl: entry.prUrl, prNumber: entry.prNumber, files: copied, updated: true };
  } finally {
    await run('git', ['worktree', 'remove', '--force', wt], { cwd: TOLKIEN }).catch(() => {});
    await run('git', ['branch', '-D', branch], { cwd: TOLKIEN }).catch(() => {});
  }
}

// Cancela un PR subido para rehacer el fix de cero: cierra el PR en GitHub y
// borra el branch remoto (borrar el branch cierra el PR igual si gh falló).
// Un PR MERGEADO nunca se cancela — el fix ya está en main: se verifica el
// estado REAL con gh antes de tocar nada; sin gh, vale el estado registrado.
// Devuelve la lista de pasos efectivamente ejecutados (para mostrarla en la UI).
async function cancelPr(entry) {
  const TOLKIEN = config.projectDir;
  let state = entry.prState;
  if (entry.prNumber) {
    try {
      const s = JSON.parse(await run('gh', ['pr', 'view', String(entry.prNumber), '--json', 'state'], { cwd: TOLKIEN })).state;
      state = s === 'MERGED' ? 'merged' : s === 'CLOSED' ? 'closed' : 'open';
    } catch { /* sin gh o PR inaccesible: se usa el estado registrado */ }
  }
  if (state === 'merged') {
    throw new Error('El PR ya fue mergeado a main; no se puede cancelar (el fix ya está en el repo).');
  }
  const steps = [];
  let prCerrado = state === 'closed';
  if (entry.prNumber && !prCerrado) {
    try {
      await run('gh', ['pr', 'close', String(entry.prNumber), '--comment',
        'Cancelado desde la consola: el fix se rehace y se sube en un PR nuevo.'], { cwd: TOLKIEN });
      steps.push(`PR #${entry.prNumber} cerrado en GitHub (sin mergear)`);
      prCerrado = true;
    } catch (err) {
      steps.push(`no se pudo cerrar el PR vía gh: ${String(err.message).slice(0, 80)}`);
    }
  } else if (prCerrado && entry.prNumber) {
    steps.push(`el PR #${entry.prNumber} ya estaba cerrado`);
  }
  if (entry.branch) {
    try {
      await run('git', ['push', 'origin', '--delete', entry.branch], { cwd: TOLKIEN });
      steps.push(`branch remoto ${entry.branch} borrado`);
    } catch (err) {
      const msg = String(err?.message || err);
      if (/remote ref does not exist/i.test(msg)) {
        steps.push(`el branch ${entry.branch} ya no existía en el remoto`);
      } else if (!prCerrado) {
        // Ni el PR se cerró ni el branch se pudo borrar: el PR sigue vivo.
        throw new Error(`No se pudo cancelar: el PR sigue abierto y el branch no se pudo borrar (${msg.slice(0, 150)}).`);
      } else {
        steps.push(`no se pudo borrar el branch remoto: ${msg.slice(0, 80)}`);
      }
    }
  }
  return steps;
}

export default {
  name: 'bugfixes',

  registerHttp(router) {
    const r = express.Router();

    r.get('/', (req, res) => {
      const all = listBugfixes().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      res.json({ bugfixes: all, inFlight: [...inFlight] });
    });

    r.post('/scan', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const { scanned, added } = scanUnregistered(config.projectDir);
      res.json({ scanned, added: added.length, bugfixes: listBugfixes() });
    });

    r.post('/pr', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const id = String(req.body?.id || '');
      const all = listBugfixes();
      const entry = all.find((b) => b.sessionId === id);
      if (!entry) return res.status(404).json({ error: 'Registro inexistente.' });
      if (path.resolve(entry.cwd) !== config.projectDir) {
        return res.status(409).json({ error: 'Solo se suben PRs del proyecto Tolkien.' });
      }
      if (!entry.files?.length) {
        return res.status(409).json({ error: 'El registro no tiene archivos editados (el chat quedó en plan). Trabajá el fix y volvé a cerrar la conversación.' });
      }
      if (inFlight.has(id)) return res.status(409).json({ error: 'Ya hay una subida en curso para este fix.' });
      inFlight.add(id);
      try {
        const { branch, prUrl, prNumber, files, updated } = await pushPr(entry);
        entry.status = 'subido';
        entry.branch = branch;
        entry.prUrl = prUrl;
        entry.prNumber = prNumber;
        entry.prState = prNumber ? 'open' : null; // sin gh no sabemos el estado
        entry.sentAt = Date.now();
        entry.updatedAt = Date.now();
        saveBugfixes(all);
        res.json({ ok: true, branch, prUrl, files, entry, updated: !!updated });
      } catch (err) {
        res.status(500).json({ error: String(err?.message || err).slice(0, 400) });
      } finally {
        inFlight.delete(id);
      }
    });

    // Refresca desde GitHub: (1) el estado real de cada PR subido del registro
    // (¿lo mergeó Chris?) y (2) TODOS los PRs de Tolkien que autoreó el usuario
    // (gh pr list --author @me) — los que no están en el registro vuelven como
    // filas "solo GitHub" para que el cuadro muestre el panorama completo.
    // Errores por-PR no cortan el resto (quedan en `errors`).
    r.post('/refresh-prs', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const all = listBugfixes();
      const errors = [];
      // Para medir los pendientes contra el main REAL, primero refrescar la ref.
      await run('git', ['fetch', 'origin', 'main'], { cwd: config.projectDir }).catch(() => {});
      for (const b of all) {
        if (b.status === 'pendiente') {
          // Aporte del fix = diff del árbol de trabajo vs origin/main, SOLO en
          // sus archivos ("cambios que aún no se mergearon a main").
          if (!b.files?.length || path.resolve(b.cwd) !== config.projectDir) continue;
          try {
            const out = await run('git', ['diff', '--numstat', 'origin/main', '--', ...b.files], { cwd: config.projectDir });
            let add = 0; let del = 0; let files = 0;
            for (const line of out.split('\n').filter(Boolean)) {
              const [a, d] = line.split('\t');
              add += Number(a) || 0; // binarios vienen como '-': cuentan 0
              del += Number(d) || 0;
              files += 1;
            }
            b.stats = { add, del, files, src: 'local' };
          } catch { b.stats = null; }
          continue;
        }
        if (!b.prNumber && !b.branch) continue;
        try {
          const out = await run('gh', [
            'pr', 'view', String(b.prNumber || b.branch),
            '--json', 'number,state,mergedAt,mergedBy,url,additions,deletions,changedFiles',
          ], { cwd: config.projectDir });
          const pr = JSON.parse(out);
          b.prNumber = pr.number || b.prNumber;
          b.prUrl = pr.url || b.prUrl;
          b.prState = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open';
          b.mergedAt = pr.mergedAt ? Date.parse(pr.mergedAt) : null;
          b.mergedBy = pr.mergedBy?.login || null;
          b.stats = { add: pr.additions ?? 0, del: pr.deletions ?? 0, files: pr.changedFiles ?? 0, src: 'github' };
          b.updatedAt = Date.now();
        } catch (err) {
          errors.push(`TKT #${b.ticketNumber}: ${String(err?.message || err).slice(0, 120)}`);
        }
      }
      saveBugfixes(all);

      let github = [];
      try {
        const out = await run('gh', [
          'pr', 'list', '--author', '@me', '--state', 'all', '--limit', '50',
          '--json', 'number,title,state,mergedAt,mergedBy,url,createdAt,headRefName,additions,deletions,changedFiles',
        ], { cwd: config.projectDir });
        const registrados = new Set(all.map((b) => b.prNumber).filter(Boolean));
        github = JSON.parse(out)
          .filter((pr) => !registrados.has(pr.number))
          .map((pr) => ({
            number: pr.number,
            title: String(pr.title || '').slice(0, 160),
            state: pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open',
            createdAt: pr.createdAt ? Date.parse(pr.createdAt) : null,
            mergedAt: pr.mergedAt ? Date.parse(pr.mergedAt) : null,
            mergedBy: pr.mergedBy?.login || null,
            url: pr.url,
            branch: pr.headRefName || null,
            stats: { add: pr.additions ?? 0, del: pr.deletions ?? 0, files: pr.changedFiles ?? 0, src: 'github' },
          }));
      } catch (err) {
        errors.push(`gh pr list: ${String(err?.message || err).slice(0, 120)}`);
      }
      res.json({ bugfixes: all, github, errors });
    });

    // Contextos editables (?kind=work|pr). Ambos se inyectan en cada
    // "Trabajar en Chat": 'work' = cómo se trabaja el bug (módulo Bugs),
    // 'pr' = cómo se redactan las notas del PR (modal Enviar PR).
    r.get('/context', (req, res) => {
      const kind = req.query.kind === 'pr' ? 'pr' : 'work';
      const context = getContext(kind);
      res.json({ kind, context, isDefault: context === DEFAULT_CONTEXTS[kind] });
    });

    r.post('/context', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const kind = req.body?.kind === 'pr' ? 'pr' : 'work';
      const text = String(req.body?.context ?? '');
      if (!text.trim()) return res.status(400).json({ error: 'El contexto no puede quedar vacío (borralo a mano si de verdad querés eso).' });
      saveContext(kind, text);
      res.json({ ok: true, kind, context: getContext(kind) });
    });

    // Cancela el PR de un fix subido y LIMPIA el registro a 'pendiente' (sin
    // rastros del PR) para volver a trabajar/subir el bugfix de cero. El
    // próximo pushPr regenera branch y PR nuevos. Un PR mergeado no se toca.
    r.post('/cancel-pr', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const id = String(req.body?.id || '');
      const all = listBugfixes();
      const entry = all.find((b) => b.sessionId === id);
      if (!entry) return res.status(404).json({ error: 'Registro inexistente.' });
      if (entry.status !== 'subido') return res.status(409).json({ error: 'Este fix no tiene PR subido; no hay nada que cancelar.' });
      if (inFlight.has(id)) return res.status(409).json({ error: 'Ya hay una operación en curso para este fix.' });
      inFlight.add(id);
      try {
        const steps = await cancelPr(entry);
        entry.status = 'pendiente';
        entry.branch = null;
        entry.prUrl = null;
        entry.prNumber = null;
        entry.prState = null;
        entry.sentAt = null;
        entry.mergedAt = null;
        entry.mergedBy = null;
        entry.stats = null;
        entry.updatedAt = Date.now();
        saveBugfixes(all);
        res.json({ ok: true, steps, entry });
      } catch (err) {
        res.status(500).json({ error: String(err?.message || err).slice(0, 400) });
      } finally {
        inFlight.delete(id);
      }
    });

    r.post('/delete', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const id = String(req.body?.id || '');
      const all = listBugfixes();
      if (!all.some((b) => b.sessionId === id)) return res.status(404).json({ error: 'Registro inexistente.' });
      saveBugfixes(all.filter((b) => b.sessionId !== id));
      res.json({ ok: true });
    });

    router.use('/bugfixes', r);
  },
};
