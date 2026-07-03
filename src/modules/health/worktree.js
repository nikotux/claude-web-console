// modules/health/worktree.js — mecánicas de GIT del orquestador (Fase B).
//
// AISLAMIENTO para el paralelo de resolución: cada fix corre en su propio
// SANDBOX (git worktree) que REFLEJA el estado ACTUAL del working tree (HEAD +
// cambios sin commitear de archivos trackeados). Los agentes editan copias
// independientes → colisión imposible al editar. La colisión real solo puede
// aparecer al INTEGRAR, y ahí git es la verdad (git apply --check detecta el
// choque). integratePatch acepta targetRoot para poder testearlo en un repo
// de juguete sin tocar la consola.
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './shared.js';

export const WT_BASE = path.join(os.homedir(), '.cwc-data', 'healthfix-wt');
const GIT_ID = ['-c', 'user.email=healthfix@cwc', '-c', 'user.name=cwc-healthfix'];

function git(args, cwd) {
  return execFileSync('git', args, { cwd: cwd || ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// Crea un sandbox que refleja el estado ACTUAL (HEAD + uncommitted trackeado),
// consolidado en un commit "base" para que el diff del fix sea SOLO el fix.
export function createSandbox(id) {
  fss.mkdirSync(WT_BASE, { recursive: true, mode: 0o700 });
  removeSandbox(id);
  const wt = path.join(WT_BASE, id);
  git(['worktree', 'add', '--detach', wt, 'HEAD']);
  let basePatch = '';
  try { basePatch = git(['diff', 'HEAD']); } catch { basePatch = ''; }
  if (basePatch.trim()) {
    const pf = path.join(WT_BASE, `${id}.base.patch`);
    fss.writeFileSync(pf, basePatch);
    try { git(['apply', pf], wt); } catch { /* si no aplica, queda en HEAD */ }
    try { fss.unlinkSync(pf); } catch { /* noop */ }
  }
  git([...GIT_ID, 'add', '-A'], wt);
  try { git([...GIT_ID, 'commit', '-m', 'base', '--no-verify', '--allow-empty'], wt); } catch { /* noop */ }
  return wt;
}

// Patch del fix = cambios del sandbox contra su commit base.
export function extractPatch(wt) {
  git([...GIT_ID, 'add', '-A'], wt);
  return git([...GIT_ID, 'diff', '--cached'], wt);
}

export function removeSandbox(id) {
  const wt = path.join(WT_BASE, id);
  try { git(['worktree', 'remove', '--force', wt]); } catch { /* noop */ }
  try { fss.rmSync(wt, { recursive: true, force: true }); } catch { /* noop */ }
}

// Reanudación tras reinicio: purga worktrees registrados que ya no existen y
// borra los directorios sueltos del batch anterior.
export function pruneSandboxes(keepIds = []) {
  try { git(['worktree', 'prune']); } catch { /* noop */ }
  try {
    for (const d of fss.readdirSync(WT_BASE)) {
      const full = path.join(WT_BASE, d);
      try { if (!fss.statSync(full).isDirectory()) continue; } catch { continue; }
      if (!keepIds.includes(d)) removeSandbox(d);
    }
  } catch { /* sin dir */ }
}

// Integra un patch al árbol targetRoot (default: la consola). Verifica que
// aplique limpio (conflicto → NO aplica), lo aplica, y corre `node --check` en
// los .js tocados; si el check falla, REVIERTE. Nunca reinicia nada.
export function integratePatch(patchText, targetRoot = ROOT) {
  if (!patchText || !patchText.trim()) return { ok: true, files: [], reason: 'sin cambios' };
  fss.mkdirSync(WT_BASE, { recursive: true, mode: 0o700 });
  const pf = path.join(WT_BASE, `integrate-${process.pid}-${Math.abs(hash(patchText))}.patch`);
  fss.writeFileSync(pf, patchText);
  const files = [...patchText.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1].trim());
  const jsFiles = files.filter((f) => /\.(js|mjs)$/.test(f));
  try {
    try { git(['apply', '--check', pf], targetRoot); }
    catch (e) { return { ok: false, reason: 'conflict', detail: String(e.message).slice(0, 200), files }; }
    git(['apply', pf], targetRoot);
    for (const f of jsFiles) {
      try { execFileSync('node', ['--check', path.join(targetRoot, f)], { encoding: 'utf8' }); }
      catch (e) {
        try { git(['apply', '-R', pf], targetRoot); } catch { /* noop */ }
        return { ok: false, reason: 'check-failed', detail: `node --check falló en ${f}: ${String(e.message).slice(0, 120)}`, files };
      }
    }
    return { ok: true, files };
  } finally { try { fss.unlinkSync(pf); } catch { /* noop */ } }
}

// hash chico y determinístico para nombrar el archivo temporal (sin crypto).
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h;
}
