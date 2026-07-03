// modules/bugfixes/index.js — seguimiento de fixes de tickets y subida de PRs.
//
// HTTP (la UI vive en la pestaña Salud del menú ⚙ Sistema):
//   GET  /api/bugfixes          -> { bugfixes } (todos los autenticados)
//   POST /api/bugfixes/scan     -> registra chats de tickets viejos sin registro (admin)
//   POST /api/bugfixes/pr {id}  -> branch + commit + push + PR a origin de Tolkien (admin)
//   POST /api/bugfixes/refresh-prs -> estado real de los PRs desde GitHub (admin)
//   GET  /api/bugfixes/pr-live/:n   -> reviews/checks/commits/feedback (gh, admin)
//   GET  /api/bugfixes/desk-live/:n -> estado + comentarios del ticket en Zoho
//        Desk (headless READ-ONLY, consume tokens; admin)
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
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../../core/config.js';
import { isAdmin } from '../../core/auth.js';
import { settingSourcesFor } from '../../core/sdk-settings.js';
import { listBugfixes, saveBugfixes, scanUnregistered, getContext, saveContext, DEFAULT_CONTEXTS, addEvent } from './store.js';

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
    // Los que no pasan (fuera de ~/tolkien o borrados) se registran en
    // `skipped`: un skip silencioso ocultaría un PR incompleto.
    const copied = [];
    const skipped = [];
    for (const rel of entry.files) {
      const src = path.resolve(TOLKIEN, rel);
      const dst = path.resolve(wt, rel);
      // EXCLUSIVO de ~/tolkien: ni origen ni destino pueden salirse (aunque
      // el registro se haya editado a mano con ../).
      if (!src.startsWith(TOLKIEN + path.sep) || !dst.startsWith(wt + path.sep)) { skipped.push(rel); continue; }
      if (!fss.existsSync(src)) { skipped.push(rel); continue; } // borrado después del chat
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
    return { branch, prUrl, prNumber, files: copied, skipped };
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
  await run('git', ['fetch', 'origin', 'main'], { cwd: TOLKIEN }).catch(() => {});
  fss.mkdirSync(WT_BASE, { recursive: true, mode: 0o700 });
  await run('git', ['worktree', 'add', '-B', branch, wt, `origin/${branch}`], { cwd: TOLKIEN });

  try {
    const copied = [];
    const skipped = []; // fuera de ~/tolkien o borrados: se informan, no se ocultan
    for (const rel of entry.files) {
      const src = path.resolve(TOLKIEN, rel);
      const dst = path.resolve(wt, rel);
      if (!src.startsWith(TOLKIEN + path.sep) || !dst.startsWith(wt + path.sep)) { skipped.push(rel); continue; }
      if (!fss.existsSync(src)) { skipped.push(rel); continue; }
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
    const commit = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: wt });
    // Fast-forward sobre el branch del PR: GitHub actualiza el MISMO PR.
    await run('git', ['push', 'origin', branch], { cwd: wt });

    // VERIFICACIÓN post-push: nuestro commit tiene que estar CONTENIDO en el
    // branch remoto. BEST-EFFORT: el push ya fue exitoso (run() habría tirado
    // si fallaba) — tirar error acá dejaría el registro local sin actualizar
    // con el PR YA actualizado en GitHub (estado inconsistente peor que no
    // verificar). Si alguien apiló un commit en el medio, is-ancestor lo
    // tolera; solo un force-push ajeno (o red caída) marca verified: false.
    let verified = true;
    try {
      await run('git', ['fetch', 'origin', branch], { cwd: wt });
      const remoteSha = await run('git', ['rev-parse', `origin/${branch}`], { cwd: wt });
      const localSha = await run('git', ['rev-parse', 'HEAD'], { cwd: wt });
      if (remoteSha !== localSha) {
        await run('git', ['merge-base', '--is-ancestor', localSha, remoteSha], { cwd: wt });
      }
    } catch {
      verified = false; // se informa en la respuesta; el registro se actualiza igual
    }
    // Posición del commit en el branch (2º, 3º…) — informativo para la UI.
    const commitCount = Number(await run('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: wt }).catch(() => '')) || null;

    // Notas del PR al día + aviso al reviewer (best-effort: el PR ya se actualizó).
    await run('gh', ['pr', 'edit', String(entry.prNumber), '--body', body], { cwd: wt }).catch(() => {});
    await run('gh', ['pr', 'comment', String(entry.prNumber), '--body',
      `PR actualizado desde la consola: el ticket se retrabajó y este PR recibió los cambios nuevos en el commit ${commit} (adicional en el branch, historial intacto). Notas del PR actualizadas.`], { cwd: wt }).catch(() => {});

    return { branch, prUrl: entry.prUrl, prNumber: entry.prNumber, files: copied, skipped, updated: true, commit, commitCount, verified };
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

// ===== Actualización automática del ticket en Desk (SOLO el 1er PR) =====
// Corrida headless del SDK con el MCP de Desk (el mismo que usa el triage).
// EXCEPCIÓN QUIRÚRGICA a la regla 6 de CLAUDE.md (headless = read-only):
// esta corrida SÍ puede escribir, pero ÚNICAMENTE vía tools `desk_*` del MCP
// (allowlist por prefijo en las DOS capas: hook PreToolUse + canUseTool);
// Bash/Edit/Write/git y cualquier otra tool quedan denegados. Es asíncrona y
// best-effort: si falla, el PR no se afecta y el tablero muestra el estado
// (deskStatus + evento ticket_actualizado en el historial, ok o error).
// Las ITERACIONES del PR (feedback) NUNCA actualizan Desk automáticamente:
// van por el chat "Actualizar ticket" del tablero, con aprobación del usuario.
const DESK_TIMEOUT_MS = 4 * 60000;
const deskToolAllowed = (name) =>
  /^mcp__[a-z0-9_-]+__desk_[a-z0-9_]+$/i.test(String(name)) || name === 'TodoWrite';

async function deskUpdateAuto(sessionId) {
  const all = listBugfixes();
  const entry = all.find((b) => b.sessionId === sessionId);
  if (!entry || !entry.ticketNumber) return;
  entry.deskStatus = 'updating';
  saveBugfixes(all);

  const deny = (why) => ({ behavior: 'deny', message: why });
  const denyHook = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Actualización de ticket: SOLO tools desk_* del MCP.',
    },
  };
  const prompt = [
    `Se envió el PR interno #${entry.prNumber} (${entry.prUrl}) con el fix del ticket de Zoho Desk #${entry.ticketNumber}.`,
    entry.ticketUrl ? `Ticket: ${entry.ticketUrl}` : '',
    '',
    'Tu ÚNICA tarea, usando las tools desk_* del MCP:',
    '1. Buscá el ticket y verificá que sea ese.',
    '2. Ponelo en estado "On Hold" (o el equivalente que exista).',
    '3. Publicá una actualización EN INGLÉS, corta y humana (2 a 4 frases), para quien reportó: qué estaba fallando (en simple), que el arreglo ya está implementado y en revisión, y que se desplegará en los próximos días. Sin jerga interna, sin mencionar herramientas ni consolas. Si podés elegir, hacela VISIBLE para el solicitante (respuesta); si no, como comentario.',
    '',
    'Referencia de lo arreglado (notas del PR, para tu resumen):',
    formatPrBody(entry).slice(0, 1500),
    '',
    'NO toques nada más (ni otros tickets, ni código). Al terminar respondé SOLO una línea: "DESK-OK <qué aplicaste>" o "DESK-FAIL <motivo>".',
  ].filter(Boolean).join('\n');

  let out = '';
  try {
    const q = query({
      prompt,
      options: {
        cwd: config.projectDir,
        model: 'sonnet',
        maxTurns: 15,
        permissionMode: 'default',
        settingSources: settingSourcesFor('headless'), // carga el MCP del proyecto, sin settings de user
        hooks: {
          PreToolUse: [{
            hooks: [async (input) => (deskToolAllowed(input.tool_name) ? {} : denyHook)],
          }],
        },
        canUseTool: async (name, input) => (deskToolAllowed(name)
          ? { behavior: 'allow', updatedInput: input }
          : deny('Actualización de ticket: SOLO tools desk_* del MCP.')),
      },
    });
    let timer = null;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), DESK_TIMEOUT_MS); });
    const pump = (async () => {
      for await (const m of q) {
        if (m.type === 'assistant') {
          for (const b of m.message?.content || []) if (b.type === 'text' && b.text) out += `${b.text}\n`;
        } else if (m.type === 'result') break;
      }
    })();
    try {
      await Promise.race([pump, timeout]);
    } finally { clearTimeout(timer); }
  } catch (err) {
    out += `\nDESK-FAIL ${String(err?.message || err).slice(0, 120)}`;
  }

  const okMatch = out.match(/DESK-OK\s*(.*)/);
  const failMatch = out.match(/DESK-FAIL\s*(.*)/);
  const fresh = listBugfixes();
  const e2 = fresh.find((b) => b.sessionId === sessionId);
  if (!e2) return;
  e2.deskStatus = okMatch ? 'ok' : 'error';
  addEvent(e2, 'ticket_actualizado', {
    mode: 'auto',
    ok: !!okMatch,
    detail: (okMatch?.[1] || failMatch?.[1] || 'sin confirmación del modelo').trim().slice(0, 200),
  });
  e2.updatedAt = Date.now();
  saveBugfixes(fresh);
}

// ===== Datos EN VIVO de un PR (no se persisten) =====
// Proxy de gh con caché en memoria de 60 s: reviews, comentarios, checks y
// commits para el panel vivo del tablero. Si gh falla, error limpio y el
// tablero degrada a los datos locales.
const liveCache = new Map(); // prNumber -> { at, data }
const LIVE_TTL_MS = 60000;

async function prLive(prNumber) {
  const hit = liveCache.get(prNumber);
  if (hit && Date.now() - hit.at < LIVE_TTL_MS) return hit.data;
  const out = await run('gh', [
    'pr', 'view', String(prNumber),
    '--json', 'number,state,title,url,mergeable,reviewDecision,updatedAt,additions,deletions,changedFiles,statusCheckRollup,reviews,comments,commits',
  ], { cwd: config.projectDir });
  const pr = JSON.parse(out);
  const data = {
    number: pr.number,
    state: pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open',
    url: pr.url,
    mergeable: pr.mergeable || null,          // MERGEABLE | CONFLICTING | UNKNOWN
    reviewDecision: pr.reviewDecision || null, // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
    updatedAt: pr.updatedAt ? Date.parse(pr.updatedAt) : null,
    stats: { add: pr.additions ?? 0, del: pr.deletions ?? 0, files: pr.changedFiles ?? 0 },
    checks: (pr.statusCheckRollup || []).map((c) => ({
      name: String(c.name || c.context || '?').slice(0, 60),
      status: String(c.conclusion || c.state || c.status || '?').toLowerCase(),
    })).slice(0, 20),
    commits: (pr.commits || []).map((c) => ({
      sha: String(c.oid || '').slice(0, 7),
      msg: String(c.messageHeadline || '').slice(0, 100),
      at: c.committedDate ? Date.parse(c.committedDate) : null,
    })).slice(-10),
    // Conversación: reviews con cuerpo + comentarios, cronológico, últimos 8.
    feedback: [
      ...(pr.reviews || []).map((r) => ({
        author: r.author?.login || '?', at: r.submittedAt ? Date.parse(r.submittedAt) : null,
        kind: String(r.state || 'review').toLowerCase(), body: String(r.body || '').slice(0, 500),
      })),
      ...(pr.comments || []).map((c) => ({
        author: c.author?.login || '?', at: c.createdAt ? Date.parse(c.createdAt) : null,
        kind: 'comment', body: String(c.body || '').slice(0, 500),
      })),
    ].filter((f) => f.body || f.kind !== 'comment').sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-8),
    fetchedAt: Date.now(),
  };
  liveCache.set(prNumber, { at: Date.now(), data });
  return data;
}

// ===== Estado EN VIVO de un ticket de Zoho Desk (LECTURA, no persiste) =====
// Sub-excepción de la regla 6 (más blindada que la escritura de deskUpdateAuto):
// corrida headless con allowlist ESTRICTA de tools desk_* de LECTURA. La tool
// debe (a) NO contener ningún verbo de escritura y (b) SÍ un verbo de lectura;
// Bash/Edit/Write/git y cualquier desk_* de escritura (add/update/reply/…)
// quedan denegados por las DOS capas. Sirve para ver el estado real del ticket
// y si el último comentario ya se publicó. Caché en memoria 60 s.
const deskCache = new Map(); // ticketNumber -> { at, data }
const DESK_LIVE_TTL_MS = 60000;
const DESK_WRITE_VERB = /(add|create|update|reply|post|delete|remove|close|set|write|send|move|assign|merge|edit|patch|put)/i;
const DESK_READ_VERB = /(get|list|search|view|read|find|fetch|detail|show|info|history|thread|conversation)/i;
const deskReadAllowed = (name) => {
  const s = String(name);
  if (s === 'TodoWrite') return true; // estado interno del modelo, no toca nada externo
  const m = s.match(/^mcp__[a-z0-9_-]+__desk_([a-z0-9_]+)$/i);
  if (!m) return false;
  const op = m[1];
  return !DESK_WRITE_VERB.test(op) && DESK_READ_VERB.test(op); // deny por defecto
};

async function deskLive(ticketNumber, fresh) {
  const key = String(ticketNumber);
  if (!fresh) {
    const hit = deskCache.get(key);
    if (hit && Date.now() - hit.at < DESK_LIVE_TTL_MS) return hit.data;
  }
  const denyMsg = 'Lectura de Desk: SOLO tools desk_* de lectura.';
  const denyHook = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyMsg,
    },
  };
  const prompt = [
    `Necesito el estado ACTUAL del ticket de Zoho Desk #${key}. Es SOLO lectura: no modifiques nada.`,
    '',
    'Con las tools desk_* de LECTURA del MCP:',
    `1. Buscá el ticket #${key} y abrilo.`,
    '2. Leé su estado actual y sus comentarios/hilos más recientes.',
    '',
    'Respondé ÚNICAMENTE con un bloque JSON (nada de texto fuera de él):',
    '```json',
    '{"found":true,"status":"<estado legible, p.ej. On Hold>","closed":true|false,"requesterReplied":true|false,"subject":"<asunto corto>","comments":[{"author":"<quién>","at":"<fecha ISO o texto>","visibility":"public|private","excerpt":"<~200 chars del comentario>"}]}',
    '```',
    'Reglas para esos campos:',
    '- "closed": true si el estado indica cerrado/resuelto (Closed, Resolved, Cerrado, Completed…), false si sigue abierto/en curso.',
    '- "requesterReplied": true si el ÚLTIMO comentario visible lo escribió QUIEN REPORTÓ el ticket (el cliente/solicitante) DESPUÉS de la última respuesta del equipo de soporte — es decir, el ticket "tiene respuesta" del cliente. false si el último movimiento fue del equipo o no hay respuesta del cliente.',
    'Máximo los 5 comentarios más recientes (el más nuevo primero). Si no encontrás el ticket: {"found":false}.',
  ].join('\n');

  let out = '';
  try {
    const q = query({
      prompt,
      options: {
        cwd: config.projectDir,
        model: 'sonnet',
        maxTurns: 12,
        permissionMode: 'default',
        settingSources: settingSourcesFor('headless'), // carga el MCP del proyecto, sin settings de user
        hooks: {
          PreToolUse: [{ hooks: [async (input) => (deskReadAllowed(input.tool_name) ? {} : denyHook)] }],
        },
        canUseTool: async (name, input) => (deskReadAllowed(name)
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: denyMsg }),
      },
    });
    let timer = null;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), DESK_TIMEOUT_MS); });
    const pump = (async () => {
      for await (const m of q) {
        if (m.type === 'assistant') {
          for (const b of m.message?.content || []) if (b.type === 'text' && b.text) out += b.text;
        } else if (m.type === 'result') break;
      }
    })();
    try { await Promise.race([pump, timeout]); } finally { clearTimeout(timer); }
  } catch (err) {
    return { found: false, error: String(err?.message || err).slice(0, 160), fetchedAt: Date.now() };
  }

  // Parseo defensivo: último bloque JSON válido de la respuesta.
  const candidates = [];
  const fences = out.match(/```(?:json)?\s*([\s\S]*?)```/gi);
  if (fences) for (const f of fences) candidates.push(f.replace(/```(?:json)?/gi, '').trim());
  const brace = out.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  let parsed = null;
  for (const c of candidates.reverse()) {
    try { parsed = JSON.parse(c); break; } catch { /* probamos el siguiente */ }
  }
  // El status legible también se clasifica por regex como red de seguridad
  // (por si el modelo no completa "closed"): cerrado/resuelto/completado.
  const statusText = parsed?.status ? String(parsed.status).slice(0, 60) : null;
  const closedByStatus = /clos|resolv|cerrad|complet|solved/i.test(statusText || '');
  const closed = parsed?.closed === true || closedByStatus;
  const replied = parsed?.requesterReplied === true;
  const data = parsed && typeof parsed === 'object'
    ? {
      found: parsed.found !== false,
      status: statusText,
      subject: parsed.subject ? String(parsed.subject).slice(0, 120) : null,
      closed, replied,
      resolved: closed || replied, // "completo": cerrado O el cliente respondió
      comments: Array.isArray(parsed.comments) ? parsed.comments.slice(0, 5).map((c) => ({
        author: String(c.author || '?').slice(0, 60),
        at: c.at ? String(c.at).slice(0, 40) : null,
        visibility: /priv/i.test(String(c.visibility)) ? 'private' : 'public',
        excerpt: String(c.excerpt || '').slice(0, 300),
      })) : [],
      fetchedAt: Date.now(),
    }
    : { found: false, error: 'No se pudo interpretar la respuesta de Desk.', fetchedAt: Date.now() };
  if (data.found) {
    deskCache.set(key, { at: Date.now(), data }); // no cacheamos fallos
    persistDeskSnapshot(key, data); // marca resolución en los registros del ticket
  }
  return data;
}

// Vuelca lo leído de Desk en TODOS los registros de ese ticket: estado,
// timestamp y si quedó resuelto (cerrado o con respuesta del cliente). Emite
// un evento al historial la PRIMERA vez que se detecta cada transición.
function persistDeskSnapshot(ticketKey, data) {
  const all = listBugfixes();
  let touched = false;
  for (const b of all) {
    if (String(b.ticketNumber) !== ticketKey) continue;
    touched = true;
    b.deskStatusText = data.status || null;
    b.deskCheckedAt = data.fetchedAt;
    b.deskClosed = data.closed;
    b.deskReplied = data.replied;
    const wasResolved = b.deskResolved === true;
    b.deskResolved = data.resolved;
    if (data.resolved && !wasResolved) {
      addEvent(b, data.closed ? 'ticket_cerrado' : 'ticket_respondido',
        { status: data.status || null });
    }
    b.updatedAt = Date.now();
  }
  if (touched) saveBugfixes(all);
}

// Nivel de resolución de un fix (derivado, NO se persiste):
//   'complete' — el ticket confirmó (cerrado o el cliente respondió: deskResolved)
//   'partial'  — nuestro PR se mergeó, pero el ticket NO confirmó todavía
//   'active'   — en curso (sin merge)
// merge ≠ resuelto: un PR mergeado es solución PARCIAL hasta que Desk confirma.
function resolutionOf(b) {
  if (b.deskResolved === true) return 'complete';
  if (b.prState === 'merged') return 'partial';
  return 'active';
}

export default {
  name: 'bugfixes',

  registerHttp(router) {
    const r = express.Router();

    r.get('/', (req, res) => {
      const all = listBugfixes().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .map((b) => ({ ...b, resolution: resolutionOf(b) })); // derivado para el tablero
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
        const { branch, prUrl, prNumber, files, skipped, updated, commit, commitCount, verified } = await pushPr(entry);
        const esPrimerEnvio = !updated && !entry.sentAt; // 1er PR de este fix
        entry.status = 'subido';
        entry.branch = branch;
        entry.prUrl = prUrl;
        entry.prNumber = prNumber;
        entry.prState = prNumber ? 'open' : null; // sin gh no sabemos el estado
        entry.sentAt = Date.now();
        entry.updatedAt = Date.now();
        addEvent(entry, updated ? 'pr_actualizado' : 'pr_creado', {
          pr: prNumber, ...(updated ? { commit: commit || null, commitN: commitCount || null } : { branch }),
          files: files.length,
        });
        saveBugfixes(all);
        // Desk: SOLO el 1er envío actualiza el ticket automáticamente (On Hold
        // + nota corta en inglés); las iteraciones van por chat con aprobación
        // del usuario ("Actualizar ticket" del tablero). Asíncrono: el PR ya
        // está subido, la respuesta no espera a Desk.
        let deskAuto = false;
        if (esPrimerEnvio && prNumber && entry.ticketNumber) {
          deskAuto = true;
          deskUpdateAuto(entry.sessionId).catch(() => {});
        }
        res.json({ ok: true, branch, prUrl, files, skipped: skipped || [], entry, updated: !!updated, commit: commit || null, commitCount: commitCount || null, deskAuto, verified: verified !== false });
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
          const nuevoEstado = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open';
          // Transición a merged detectada: evento al historial (una sola vez).
          if (nuevoEstado === 'merged' && b.prState !== 'merged') {
            addEvent(b, 'pr_mergeado', { pr: pr.number, by: pr.mergedBy?.login || null });
          }
          b.prState = nuevoEstado;
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
        addEvent(entry, 'pr_cancelado', { pr: entry.prNumber || null });
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

    // Datos EN VIVO de un PR (gh, caché 60 s; ?fresh=1 la saltea). No persiste.
    r.get('/pr-live/:number', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const n = Number(req.params.number);
      if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: 'Número de PR inválido.' });
      if (req.query.fresh) liveCache.delete(n);
      try {
        res.json({ ok: true, live: await prLive(n) });
      } catch (err) {
        res.status(502).json({ error: `GitHub no disponible: ${String(err?.message || err).slice(0, 200)}` });
      }
    });

    // Estado EN VIVO de un ticket de Zoho Desk (headless READ-ONLY; caché 60 s,
    // ?fresh=1 la saltea). CONSUME TOKENS: el front lo dispara bajo botón, no al
    // expandir. El número de ticket puede no ser entero (acepta \w.-).
    r.get('/desk-live/:number', async (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const raw = String(req.params.number || '').replace(/[^\w.-]/g, '').slice(0, 20);
      if (!raw) return res.status(400).json({ error: 'Número de ticket inválido.' });
      try {
        res.json({ ok: true, desk: await deskLive(raw, !!req.query.fresh) });
      } catch (err) {
        res.status(502).json({ error: `Desk no disponible: ${String(err?.message || err).slice(0, 200)}` });
      }
    });

    // Archivar / restaurar un fix: lo saca de (o devuelve a) la lista activa.
    // No toca código ni PRs — es solo organización del tablero.
    r.post('/archive', (req, res) => {
      if (!isAdmin(req)) return res.status(403).json({ error: 'Requiere administrador.' });
      const id = String(req.body?.id || '');
      const archived = req.body?.archived !== false; // default true
      const all = listBugfixes();
      const entry = all.find((b) => b.sessionId === id);
      if (!entry) return res.status(404).json({ error: 'Registro inexistente.' });
      entry.archived = archived;
      addEvent(entry, archived ? 'archivado' : 'restaurado', {});
      entry.updatedAt = Date.now();
      saveBugfixes(all);
      res.json({ ok: true, entry: { ...entry, resolution: resolutionOf(entry) } });
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
