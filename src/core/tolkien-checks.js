/*
 * Reglas MECÁNICAS del Protocolo Tolkien (PLAN-1935, contrato CONVE-1964).
 * Se EJECUTAN sobre un diff: no son prosa para leer ni una guía interpretativa.
 *
 * Regla dura 12: ~/tolkien es totalmente READ-ONLY.
 * Todo acceso git pasa por una allowlist explícita de subcomandos de lectura.
 *
 * ¿Por qué son 3 reglas y no 6?
 * Se validaron 7 candidatas contra los 21 PRs reales del histórico (#225→#345).
 * Principio: "mejor sin regla que con una regla débil".
 * El triage de Chris ya excluía términos que llevaban la cobertura de 51% a 59%,
 * pero elevaban el error de 0,4% a 5,6%. Se descartaron estas cuatro:
 * - catchVacio (P3): 0 disparos, aun en 3 PRs con 8 fallas fail-closed.
 *   `catch { return [] }` no representa el defecto real: config vacía = "todos"
 *   o catálogo stale. Recall: 0.
 * - stringDeDisplay (P7): 1 disparo, falso (`state.status === 'error'` en React).
 *   El path `desk|ticket` abarca toda la feature "tickets" y no permite separar
 *   estado local de un status localizado de Desk.
 * - autorizacionDuplicada (P1): 0 disparos, aun en 6 PRs con 8 fallas.
 *   La duplicación real es semántica: dos superficies responden la misma pregunta.
 * - datoSensibleGenerico (P4): términos estrictos dieron 0 disparos, incluso #275;
 *   subject/description/email dieron 10/21, aunque `subject` en un audit es normal.
 *   Es el mismo trade-off cobertura/error que el motor de Chris ya descartó.
 *
 * Si un check no aplica devuelve ok:null y detail empieza con `skipped:`; NUNCA
 * se informa como incumplido.
 *
 * GOTCHA `base`: migrationOrder compara con el máximo timestamp existente en base.
 * Una base equivocada (p.ej. el tip actual para un PR viejo) falla el 100% de casos.
 * En el gate pre-push corresponde origin/main; para un PR histórico, su baseRefOid.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const TOLKIEN_CONTRACT = 'CONVE-1964';
export const TOLKIEN_REPO = path.join(os.homedir(), 'tolkien');

export const TOLKIEN_CHECKS = {
  diff: {
    migrationOrder: { origin: TOLKIEN_CONTRACT, obligation: 'Toda migración nueva tiene timestamp posterior a la última ya mergeada' },
    schemaSinMigracion: { origin: TOLKIEN_CONTRACT, obligation: 'Un cambio de `schema.prisma` viene con su migración en el mismo tip' },
    handlerSinProductor: { origin: TOLKIEN_CONTRACT, obligation: 'Todo handler registrado está encolado desde su trigger real' },
  },
};

const GIT_READONLY = new Set([
  'diff',
  'grep',
  'log',
  'show',
  'ls-tree',
  'rev-parse',
  'merge-base',
  'cat-file',
]);

function git(repo, args, { allowFail = false } = {}) {
  if (!GIT_READONLY.has(args[0])) {
    throw new Error(
      `Regla 12: el subcomando git "${args[0] || ''}" no está permitido sobre el repo Tolkien (solo lectura).`,
    );
  }
  try {
    return execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    if (allowFail) return '';
    throw error;
  }
}

function isTestPath(filePath) {
  const normalized = `/${String(filePath || '').replaceAll('\\', '/')}`;
  return normalized.includes('/test/')
    || normalized.includes('/tests/')
    || normalized.includes('/__tests__/')
    || normalized.endsWith('.test.ts')
    || normalized.endsWith('.spec.ts');
}

function isGeneratedPath(filePath) {
  const normalized = `/${String(filePath || '').replaceAll('\\', '/')}/`;
  return ['/dist/', '/node_modules/', '/.next/', '/build/', '/coverage/']
    .some((segment) => normalized.includes(segment));
}

function stripComments(text) {
  const value = String(text || '');
  if (/^\s*(?:\/\/|\*)/.test(value)) return '';
  return value.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '');
}

function isCodeLine(text) {
  return stripComments(text).trim().length > 0;
}

function parseUnifiedDiff(diffText) {
  const files = [];
  let current = null;
  let newLine = null;

  const finish = () => {
    if (current && !current.binary) {
      const { binary, ...parsed } = current;
      files.push(parsed);
    }
    current = null;
    newLine = null;
  };

  for (const line of String(diffText || '').split(/\r?\n/)) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      finish();
      current = {
        path: header[2],
        oldPath: header[1],
        status: 'modified',
        addedLines: [],
        removedLines: [],
        binary: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      current.binary = true;
      continue;
    }
    if (line.startsWith('new file mode ')) {
      current.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      current.status = 'deleted';
      current.path = current.oldPath;
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.status = 'renamed';
      current.path = line.slice('rename to '.length);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (newLine === null) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.addedLines.push({ line: newLine, text: line.slice(1) });
      newLine += 1;
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      current.removedLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith(' ')) newLine += 1;
  }
  finish();
  return files;
}

function check(module, name, ok, detail) {
  return { module, kind: 'diff', check: name, ok, detail };
}

function skippedChecks(reason) {
  return [
    check('prisma', 'migrationOrder', null, `skipped: ${reason}`),
    check('prisma', 'schemaSinMigracion', null, `skipped: ${reason}`),
    check('worker', 'handlerSinProductor', null, `skipped: ${reason}`),
  ];
}

function limited(items, render) {
  const visible = items.slice(0, 8).map(render).join(', ');
  return items.length > 8 ? `${visible} (+${items.length - 8} más)` : visible;
}

function relevantFile(file) {
  return !isTestPath(file.path) && !isGeneratedPath(file.path);
}

function migrationOrderCheck(files, repo, base) {
  const migrationPattern = /^packages\/db\/prisma\/migrations\/(\d{14})_[^/]+\/migration\.sql$/;
  const migrations = files
    .filter((file) => file.status === 'added')
    .map((file) => ({ file, match: file.path.match(migrationPattern) }))
    .filter((item) => item.match)
    .map(({ file, match }) => ({ file, timestamp: match[1] }));
  if (!migrations.length) {
    return check('prisma', 'migrationOrder', null, 'skipped: el diff no agrega migraciones');
  }

  const tree = git(
    repo,
    ['ls-tree', '--name-only', base, 'packages/db/prisma/migrations/'],
    { allowFail: true },
  );
  if (!tree.trim()) {
    return check(
      'prisma',
      'migrationOrder',
      null,
      `skipped: no se pudo leer las migraciones de ${base}`,
    );
  }
  const timestamps = [...tree.matchAll(/(?:^|\/)(\d{14})_[^/\n]+/gm)].map((match) => match[1]);
  if (!timestamps.length) {
    return check(
      'prisma',
      'migrationOrder',
      null,
      `skipped: no se pudo leer las migraciones de ${base}`,
    );
  }
  const ceiling = timestamps.sort().at(-1);
  const offenders = migrations.filter((item) => item.timestamp <= ceiling);
  if (offenders.length) {
    return check(
      'prisma',
      'migrationOrder',
      false,
      limited(
        offenders,
        ({ file, timestamp }) => `${file.path}:1 (${timestamp} <= ${ceiling})`,
      ),
    );
  }
  return check(
    'prisma',
    'migrationOrder',
    true,
    `${migrations.length} migración(es) posterior(es) a ${ceiling}`,
  );
}

function schemaSinMigracionCheck(files) {
  const schema = files.find((file) => file.path === 'packages/db/prisma/schema.prisma');
  if (!schema) {
    return check('prisma', 'schemaSinMigracion', null, 'skipped: el diff no toca schema.prisma');
  }
  const substantive = [...schema.addedLines.map((line) => line.text), ...schema.removedLines]
    .filter((line) => isCodeLine(line));
  if (!substantive.length) {
    return check(
      'prisma',
      'schemaSinMigracion',
      null,
      'skipped: schema.prisma cambió solo en comentarios',
    );
  }
  const addsMigration = files.some(
    (file) => file.status === 'added'
      && file.path.startsWith('packages/db/prisma/migrations/'),
  );
  return check(
    'prisma',
    'schemaSinMigracion',
    addsMigration,
    addsMigration
      ? 'schema.prisma y migración nueva presentes en el diff'
      : 'packages/db/prisma/schema.prisma:1 sin migración nueva',
  );
}

function grepHasCodeLine(repo, eventType, revision, filePath) {
  const literal = `'${eventType}'`;
  const output = git(
    repo,
    ['grep', '-n', '-F', literal, ...(revision ? [revision] : []), '--', filePath],
    { allowFail: true },
  );
  return output.split(/\r?\n/).some((line) => {
    const match = line.match(/:\d+:(.*)$/);
    return match ? isCodeLine(match[1]) : false;
  });
}

function repoHasProducer(repo, eventType, revision) {
  const literal = `'${eventType}'`;
  const output = git(
    repo,
    ['grep', '-l', '-F', literal, ...(revision ? [revision] : []), '--', 'apps', 'packages'],
    { allowFail: true },
  );
  return output.split(/\r?\n/)
    .map((filePath) => {
      if (revision && filePath.startsWith(`${revision}:`)) {
        return filePath.slice(revision.length + 1);
      }
      return filePath;
    })
    .filter(Boolean)
    .filter((filePath) => filePath !== 'apps/worker/src/handlers/index.ts')
    .filter((filePath) => !isTestPath(filePath) && !isGeneratedPath(filePath))
    .some((filePath) => grepHasCodeLine(repo, eventType, revision, filePath));
}

function handlerSinProductorCheck(files, repo, revision) {
  const registrations = [];
  for (const file of files) {
    const addedText = file.addedLines.map((added) => added.text).join('\n');
    const pattern = /registerHandler\(\s*'([^']+)'/g;
    for (const match of addedText.matchAll(pattern)) {
      const addedIndex = addedText.slice(0, match.index).split('\n').length - 1;
      registrations.push({
        eventType: match[1],
        file: file.path,
        line: file.addedLines[addedIndex].line,
      });
    }
  }
  if (!registrations.length) {
    return check(
      'worker',
      'handlerSinProductor',
      null,
      'skipped: el diff no registra handlers nuevos',
    );
  }

  const offenders = [];
  for (const registration of registrations) {
    const literal = `'${registration.eventType}'`;
    const inDiff = files.some(
      (file) => file.path !== 'apps/worker/src/handlers/index.ts'
        && relevantFile(file)
        && file.addedLines.some(
          (added) => added.text.includes(literal) && isCodeLine(added.text),
        ),
    );
    if (!inDiff && !repoHasProducer(repo, registration.eventType, revision)) {
      offenders.push(registration);
    }
  }
  if (offenders.length) {
    return check(
      'worker',
      'handlerSinProductor',
      false,
      limited(
        offenders,
        ({ eventType, file, line }) => `${eventType} (${file}:${line})`,
      ),
    );
  }
  return check(
    'worker',
    'handlerSinProductor',
    true,
    `${registrations.length} handler(s) con productor`,
  );
}

export function collectTolkienChecks({
  repo = TOLKIEN_REPO,
  diffText = null,
  base = 'origin/main',
  head = null,
  revision = null,
} = {}) {
  if (!fs.existsSync(repo)) return skippedChecks(`el repo no existe: ${repo}`);

  const resolvedDiff = diffText === null
    ? git(repo, ['diff', head ? `${base}...${head}` : base])
    : diffText;
  if (!String(resolvedDiff).trim()) return skippedChecks('el diff está vacío');

  const files = parseUnifiedDiff(resolvedDiff).filter(relevantFile);
  if (!files.length) return skippedChecks('el diff no contiene archivos relevantes');

  return [
    migrationOrderCheck(files, repo, base),
    schemaSinMigracionCheck(files),
    handlerSinProductorCheck(files, repo, revision),
  ];
}
