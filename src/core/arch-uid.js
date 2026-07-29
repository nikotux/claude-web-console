import path from 'node:path';

function normalizedSuffix(uid, prefix) {
  if (typeof uid !== 'string' || !uid.startsWith(prefix)) return null;
  const suffix = uid.slice(prefix.length).replaceAll('\\', '/');
  if (!suffix || suffix.startsWith('/') || suffix.split('/').includes('..')) return null;
  const normalized = path.posix.normalize(suffix);
  if (!normalized || normalized.startsWith('..') || normalized.startsWith('/')) return null;
  return normalized;
}

function target(kind, rel) {
  const normalized = path.posix.normalize(rel);
  if (!normalized || normalized.startsWith('..') || normalized.startsWith('/')) return null;
  return { kind, rel: normalized };
}

export function uidTarget(uid) {
  // Un uid es dato que viene del Pad: se valida antes de convertirlo en ruta.
  const moduleName = normalizedSuffix(uid, 'mod:');
  if (moduleName !== null) return target('dir', `src/modules/${moduleName}`);

  const frontendName = normalizedSuffix(uid, 'fe:');
  if (frontendName !== null) return target('dir', `public/js/modules/${frontendName}`);

  const runnerName = normalizedSuffix(uid, 'run:');
  if (runnerName !== null) return target('file', `bin/${runnerName}.js`);

  const filePath = normalizedSuffix(uid, 'file:');
  if (filePath !== null) return target('file', filePath);

  return null;
}

export function uidFamily(uid) {
  // La familia NO es un cuarto eje de CONVE-2279: es metadata DERIVADA del
  // prefijo del uid, y existe solo para que un invariante de backend no se le
  // inyecte a una unidad de frontend.
  if (typeof uid !== 'string') return null;
  if (uid.startsWith('mod:') || uid.startsWith('endpoint:')) return 'backend';
  if (uid.startsWith('fe:')) return 'frontend';
  if (uid.startsWith('run:')) return 'runner';

  const filePath = normalizedSuffix(uid, 'file:');
  if (filePath?.startsWith('public/')) return 'frontend';
  if (filePath?.startsWith('bin/')) return 'runner';
  if (filePath?.startsWith('src/')) return 'backend';
  return null;
}
