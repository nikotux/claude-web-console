#!/usr/bin/env node
// bin/cwc-publish-runner.js — PUBLICA el repo interno al repo limpio la-consola
// (PLAN-488). DESACOPLADO (regla de oro/regla 2): sobrevive a reinicios del
// server; el front encuesta el estado persistido. 0 tokens (git puro, no SDK).
//
// Flujo: preparar mirror local → rsync del árbol interno (con excludes) →
// transform de limpieza → GATES bloqueantes (secretos + identidad) → commit
// incremental → push. Si un gate falla, ABORTA sin publicar y persiste el motivo.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import {
  REPO_DIR, MIRROR_DIR, LOG_FILE, CLEAN_REPO_URL, CLEAN_BRANCH,
  RSYNC_EXCLUDES, writeState, applyTransforms, runGates, readMasterToken,
} from '../src/modules/publish/shared.js';

const log = (...a) => {
  const line = `[${new Date().toISOString()}] [publish] ${a.join(' ')}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* noop */ }
  console.log(line);
};

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', timeout: 120000, ...opts }).trim();
}
function phase(p) { log(p); writeState({ status: 'running', phase: p }); }

function ensureMirror() {
  if (!fs.existsSync(`${MIRROR_DIR}/.git`)) {
    phase('clonando el repo limpio (primera vez)…');
    fs.rmSync(MIRROR_DIR, { recursive: true, force: true });
    git(['clone', CLEAN_REPO_URL, MIRROR_DIR], { timeout: 180000 });
    return;
  }
  phase('sincronizando el mirror con el remoto…');
  git(['-C', MIRROR_DIR, 'fetch', 'origin', CLEAN_BRANCH], { timeout: 120000 });
  git(['-C', MIRROR_DIR, 'checkout', CLEAN_BRANCH]);
  git(['-C', MIRROR_DIR, 'reset', '--hard', `origin/${CLEAN_BRANCH}`]);
  git(['-C', MIRROR_DIR, 'clean', '-fd']); // deja el mirror EXACTO al remoto
}

async function main() {
  try {
    writeState({ status: 'running', phase: 'iniciando', startedAt: Date.now(), result: null, error: null });

    ensureMirror();

    phase('copiando el árbol interno (sin secretos)…');
    // rsync con excludes + --delete (borra en el mirror lo que ya no está en el
    // interno). --delete NO toca .git del mirror porque está excluido.
    const excludeArgs = RSYNC_EXCLUDES.flatMap((e) => ['--exclude', e]);
    execFileSync('rsync', ['-a', '--delete', ...excludeArgs, `${REPO_DIR}/`, `${MIRROR_DIR}/`], { stdio: 'inherit', timeout: 120000 });

    phase('aplicando limpieza (CLAUDE genérico, changelog, docs)…');
    const transforms = applyTransforms(MIRROR_DIR, REPO_DIR);

    phase('verificando (gates de secretos e identidad)…');
    const problems = runGates(MIRROR_DIR, { masterToken: readMasterToken() });
    if (problems.length) {
      log('GATES FALLARON, abortando:', JSON.stringify(problems));
      writeState({ status: 'error', phase: 'gates', error: 'No se publicó: los gates detectaron problemas.', result: { gates: problems } });
      process.exit(0); // salida limpia: el estado ya refleja el error
    }

    phase('registrando cambios…');
    git(['-C', MIRROR_DIR, 'add', '-A']);
    let hasChanges = true;
    try { git(['-C', MIRROR_DIR, 'diff', '--cached', '--quiet']); hasChanges = false; } catch { hasChanges = true; }

    if (!hasChanges) {
      log('sin cambios, nada que publicar');
      writeState({ status: 'done', phase: 'sin-cambios', result: { published: false, message: 'El repo limpio ya estaba al día. Nada que publicar.', transforms } });
      process.exit(0);
    }

    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    // Committer NEUTRAL (sin PII): el mirror es un artefacto generado.
    git(['-C', MIRROR_DIR, '-c', 'user.name=cwc-publish', '-c', 'user.email=cwc-publish@localhost',
      'commit', '-q', '-m', `Sincronización desde el repo interno (${stamp})`]);
    const sha = git(['-C', MIRROR_DIR, 'rev-parse', '--short', 'HEAD']);
    const files = git(['-C', MIRROR_DIR, 'show', '--stat', '--oneline', 'HEAD']).split('\n').length - 1;

    phase('publicando (git push)…');
    git(['-C', MIRROR_DIR, 'push', 'origin', CLEAN_BRANCH], { timeout: 180000 });

    log(`publicado: ${sha} (${files} archivos)`);
    writeState({ status: 'done', phase: 'publicado', result: { published: true, sha, files, transforms, message: `Publicado al repo limpio (commit ${sha}).` } });
    process.exit(0);
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 400);
    log('ERROR:', msg);
    writeState({ status: 'error', phase: 'error', error: msg });
    process.exit(1);
  }
}

main();
