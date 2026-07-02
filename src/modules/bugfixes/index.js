// modules/bugfixes/index.js — seguimiento de fixes de tickets y subida de PRs.
//
// HTTP (la UI vive en la pestaña Salud del menú ⚙ Sistema):
//   GET  /api/bugfixes          -> { bugfixes } (todos los autenticados)
//   POST /api/bugfixes/scan     -> registra chats de tickets viejos sin registro (admin)
//   POST /api/bugfixes/pr {id}  -> branch + commit + push + PR a origin de Tolkien (admin)
//   POST /api/bugfixes/refresh-prs -> estado real de los PRs desde GitHub (admin)
//   GET  /api/bugfixes/context     -> contexto de trabajo editable (autenticados)
//   POST /api/bugfixes/context     -> guarda el contexto (admin)
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
import { listBugfixes, saveBugfixes, scanUnregistered, getContext, saveContext, DEFAULT_CONTEXT } from './store.js';

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

async function pushPr(entry) {
  const TOLKIEN = config.projectDir;
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
        const { branch, prUrl, prNumber, files } = await pushPr(entry);
        entry.status = 'subido';
        entry.branch = branch;
        entry.prUrl = prUrl;
        entry.prNumber = prNumber;
        entry.prState = prNumber ? 'open' : null; // sin gh no sabemos el estado
        entry.sentAt = Date.now();
        entry.updatedAt = Date.now();
        saveBugfixes(all);
        res.json({ ok: true, branch, prUrl, files, entry });
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
      for (const b of all) {
        if (b.status !== 'subido' || (!b.prNumber && !b.branch)) continue;
        try {
          const out = await run('gh', [
            'pr', 'view', String(b.prNumber || b.branch),
            '--json', 'number,state,mergedAt,mergedBy,url',
          ], { cwd: config.projectDir });
          const pr = JSON.parse(out);
          b.prNumber = pr.number || b.prNumber;
          b.prUrl = pr.url || b.prUrl;
          b.prState = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open';
          b.mergedAt = pr.mergedAt ? Date.parse(pr.mergedAt) : null;
          b.mergedBy = pr.mergedBy?.login || null;
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
          '--json', 'number,title,state,mergedAt,mergedBy,url,createdAt,headRefName',
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
          }));
      } catch (err) {
        errors.push(`gh pr list: ${String(err?.message || err).slice(0, 120)}`);
      }
      res.json({ bugfixes: all, github, errors });
    });

    // Contexto de trabajo editable (se inyecta en cada "Trabajar en Chat").
    r.get('/context', (req, res) => {
      const context = getContext();
      res.json({ context, isDefault: context === DEFAULT_CONTEXT });
    });

    r.post('/context', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const text = String(req.body?.context ?? '');
      if (!text.trim()) return res.status(400).json({ error: 'El contexto no puede quedar vacío (borralo a mano si de verdad querés eso).' });
      saveContext(text);
      res.json({ ok: true, context: getContext() });
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
