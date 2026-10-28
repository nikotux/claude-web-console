// modules/skills/catalog.js — catálogo instalable de skills de Mi Consola.
//
// Las fuentes viven project-scoped en <repo>/.claude/skills. Este módulo copia
// únicamente las clasificadas `cwc-share: catalog` al scope GLOBAL del
// principal, siempre bajo <scope.claudeDir>/skills. La whitelist del nombre,
// el confinamiento de ruta y el marcador de origen impiden traversal y evitan
// pisar o borrar una skill propia del usuario.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../../core/atomic-write.js';

const CONSOLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MARKER_NAME = '.cwc-catalog.json';
const MARKER_SOURCE = 'console-catalog';
const DEFAULTS_OFFERED_NAME = 'skills-defaults-offered.json';

export const CATALOG_DIR = path.join(CONSOLE_ROOT, '.claude', 'skills');
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;

// Frontmatter YAML MINIMAL (mismo criterio que chat/index.js
// `skillDescription`): soporta líneas `clave: valor` y listas simples bajo la
// última clave. Se exporta para que el censo y el catálogo compartan una única
// implementación (CONVE-2085).
export function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  let curKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z_-]+):[ \t]*(.*)$/);
    if (kv) {
      curKey = kv[1].trim();
      const val = kv[2].trim();
      out[curKey] = val ? val.replace(/^["']|["']$/g, '') : '';
      continue;
    }
    const item = line.match(/^\s*-\s*(.+)$/);
    if (item && curKey) {
      if (!Array.isArray(out[curKey])) out[curKey] = [];
      out[curKey].push(item[1].trim());
    }
  }
  return out;
}

function regularFilesUnder(root) {
  const files = [];

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const error = new Error(`La skill contiene un symlink no permitido: ${entry.name}`);
        error.code = 'unsafe_symlink';
        throw error;
      }
      if (stat.isDirectory()) {
        walk(absolute);
      } else if (stat.isFile()) {
        files.push({
          absolute,
          relative: path.relative(root, absolute).split(path.sep).join('/'),
        });
      } else {
        const error = new Error(`La skill contiene una entrada no soportada: ${entry.name}`);
        error.code = 'unsupported_entry';
        throw error;
      }
    }
  }

  walk(root);
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

function hashSkillDir(dir) {
  const hash = crypto.createHash('sha256');
  for (const file of regularFilesUnder(dir)) {
    const content = fs.readFileSync(file.absolute);
    hash.update(file.relative);
    hash.update('\0');
    hash.update(String(content.length));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

export function listCatalog() {
  let dirs;
  try {
    dirs = fs.readdirSync(CATALOG_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SKILL_NAME_RE.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }

  const catalog = [];
  for (const entry of dirs) {
    const skillDir = path.join(CATALOG_DIR, entry.name);
    let raw;
    try {
      raw = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw);
    // Fail-closed: cualquier valor ausente o desconocido equivale a host-only.
    const share = fm['cwc-share'] === 'catalog' ? 'catalog' : 'host-only';
    if (share !== 'catalog') continue;

    try {
      catalog.push({
        dirName: entry.name,
        name: fm.name || entry.name,
        description: fm.description || '',
        share,
        isDefault: fm['cwc-default'] === 'true',
        hash: hashSkillDir(skillDir),
      });
    } catch {
      // Una skill con symlinks/entradas especiales no es instalable.
    }
  }
  return catalog;
}

function readMarker(skillDir) {
  const markerPath = path.join(skillDir, MARKER_NAME);
  try {
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
    return marker;
  } catch {
    return null;
  }
}

export function installedSkills(claudeDir) {
  const skillsDir = path.join(claudeDir, 'skills');
  let dirs;
  try {
    dirs = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return {};
  }

  const installed = Object.create(null);
  for (const entry of dirs) {
    const marker = readMarker(path.join(skillsDir, entry.name));
    if (!marker) continue;
    installed[entry.name] = {
      hash: marker.hash,
      installedAt: marker.installedAt,
      source: marker.source,
    };
  }
  return installed;
}

export function catalogStateFor(claudeDir, catalog = listCatalog()) {
  const installed = installedSkills(claudeDir);
  return catalog.map((entry) => {
    const marker = installed[entry.dirName];
    const isInstalled = marker?.source === MARKER_SOURCE;
    return {
      ...entry,
      installed: isInstalled,
      outdated: isInstalled && marker.hash !== entry.hash,
    };
  });
}

function validationError(code, error) {
  return { ok: false, code, error };
}

function catalogEntryFor(dirName, catalog = listCatalog()) {
  if (typeof dirName !== 'string' || !SKILL_NAME_RE.test(dirName)) {
    return { error: validationError('invalid_name', 'Nombre de skill inválido.') };
  }
  const entry = catalog.find((item) => item.dirName === dirName);
  if (!entry) {
    return { error: validationError('not_found', 'La skill no existe en el catálogo.') };
  }
  return { entry };
}

function destinationFor(claudeDir, dirName) {
  const skillsDir = path.resolve(path.join(claudeDir, 'skills'));
  const destination = path.resolve(path.join(claudeDir, 'skills', dirName));
  if (!destination.startsWith(`${skillsDir}${path.sep}`)) {
    const error = new Error('La ruta destino sale del espacio de skills.');
    error.code = 'unsafe_path';
    throw error;
  }
  return { skillsDir, destination };
}

function destinationExists(destination) {
  try {
    return fs.lstatSync(destination);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function isCatalogOwned(destination, dirName) {
  const stat = destinationExists(destination);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return false;
  const marker = readMarker(destination);
  return marker?.source === MARKER_SOURCE && marker?.dirName === dirName;
}

function copyTreeWithoutSymlinks(source, destination) {
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    const error = new Error('La fuente de la skill no es un directorio seguro.');
    error.code = 'unsafe_source';
    throw error;
  }
  fs.mkdirSync(destination, { mode: sourceStat.mode & 0o777 });

  const entries = fs.readdirSync(source, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) {
      const error = new Error(`La skill contiene un symlink no permitido: ${entry.name}`);
      error.code = 'unsafe_symlink';
      throw error;
    }
    if (stat.isDirectory()) {
      copyTreeWithoutSymlinks(from, to);
    } else if (stat.isFile()) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, stat.mode & 0o777);
    } else {
      const error = new Error(`La skill contiene una entrada no soportada: ${entry.name}`);
      error.code = 'unsupported_entry';
      throw error;
    }
  }
}

export function installSkill(claudeDir, dirName, catalog = listCatalog()) {
  const validated = catalogEntryFor(dirName, catalog);
  if (validated.error) return validated.error;

  const { skillsDir, destination } = destinationFor(claudeDir, dirName);
  const existing = destinationExists(destination);
  if (existing && !isCatalogOwned(destination, dirName)) {
    return validationError('user_owned', 'Ya existe una skill propia del usuario con ese nombre.');
  }

  fs.mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  const stageRoot = fs.mkdtempSync(path.join(skillsDir, '.cwc-catalog-'));
  const stagedSkill = path.join(stageRoot, dirName);
  const previousSkill = path.join(stageRoot, '.previous');
  let preserveStage = false;
  try {
    copyTreeWithoutSymlinks(path.join(CATALOG_DIR, dirName), stagedSkill);
    writeJsonAtomic(path.join(stagedSkill, MARKER_NAME), {
      source: MARKER_SOURCE,
      dirName,
      hash: validated.entry.hash,
      installedAt: Date.now(),
    }, { mode: 0o600, space: 2 });

    if (existing) {
      // Se vuelve a validar inmediatamente antes del borrado para no convertir
      // una carrera obvia en el borrado de una skill propia.
      if (!isCatalogOwned(destination, dirName)) {
        return validationError('user_owned', 'La skill dejó de pertenecer al catálogo.');
      }
      fs.renameSync(destination, previousSkill);
      try {
        fs.renameSync(stagedSkill, destination);
      } catch (error) {
        try {
          fs.renameSync(previousSkill, destination);
        } catch (rollbackError) {
          // El respaldo queda en stageRoot para permitir recuperación manual.
          preserveStage = true;
          error.rollbackError = rollbackError;
        }
        throw error;
      }
      fs.rmSync(previousSkill, { recursive: true, force: true });
    } else if (destinationExists(destination)) {
      return validationError('user_owned', 'Ya existe una skill propia del usuario con ese nombre.');
    } else {
      fs.renameSync(stagedSkill, destination);
    }
    return { ok: true, dirName, hash: validated.entry.hash };
  } finally {
    if (!preserveStage) fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

export function uninstallSkill(claudeDir, dirName) {
  const validated = catalogEntryFor(dirName);
  if (validated.error) return validated.error;

  const { destination } = destinationFor(claudeDir, dirName);
  if (!isCatalogOwned(destination, dirName)) {
    return validationError('user_owned', 'La skill no pertenece al catálogo.');
  }
  fs.rmSync(destination, { recursive: true, force: true });
  return { ok: true, dirName };
}

export function reconcileDefaults(claudeDir, dataDir, catalog = listCatalog()) {
  const offeredPath = path.join(dataDir, DEFAULTS_OFFERED_NAME);
  let rawOffered = [];
  try {
    const record = JSON.parse(fs.readFileSync(offeredPath, 'utf8'));
    if (record && Array.isArray(record.offered)) {
      rawOffered = record.offered.filter((dirName) => typeof dirName === 'string');
    }
  } catch {
    // Registro ausente o corrupto: falla abierto para no romper la carga.
  }

  const offered = new Set(rawOffered);
  const installed = [];
  const skipped = [];
  const failed = [];
  for (const entry of catalog.filter((item) => item.isDefault)) {
    if (offered.has(entry.dirName)) continue;
    try {
      const result = installSkill(claudeDir, entry.dirName, catalog);
      if (result.ok) {
        installed.push(entry.dirName);
        offered.add(entry.dirName);
      } else if (result.code === 'user_owned') {
        skipped.push(entry.dirName);
        offered.add(entry.dirName);
      } else {
        failed.push({
          dirName: entry.dirName,
          code: result.code || 'install_failed',
          error: result.error || result.code || 'No se pudo instalar la skill.',
        });
      }
    } catch (error) {
      failed.push({
        dirName: entry.dirName,
        code: error?.code || 'install_failed',
        error: String(error?.message || error),
      });
    }
  }

  // El registro recuerda qué defaults ya se ofrecieron para respetar una
  // desinstalación deliberada. `user_owned` también cuenta como evaluada porque
  // nunca debe pisarse; un fallo de I/O no se registra y así puede reintentarse.
  if (offered.size !== new Set(rawOffered).size) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(offeredPath, {
      offered: [...offered].sort((a, b) => a.localeCompare(b)),
    }, { mode: 0o600, space: 2 });
  }

  return { installed, skipped, failed };
}

export function installDefaults(
  claudeDir,
  dataDir = path.join(path.dirname(path.resolve(claudeDir)), '.cwc-data'),
) {
  return reconcileDefaults(claudeDir, dataDir);
}
