// Auditoría compartida de i18n, carga de diccionarios y ayuda.
// Es determinística y read-only: inspecciona el repo sin ejecutar frontend.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

// Estas excepciones evitan que Salud nazca en amarillo por paneles que
// legítimamente no pueden ofrecer helpBtn. Antes de sumar otra hay que
// verificar que el panel realmente no tenga un header donde ubicarlo.
export const HELP_BUTTON_EXCEPTIONS = Object.freeze([
  Object.freeze({
    id: 'sala',
    reason: 'la ayuda de la Sala de Aduana se abre desde el índice general, no desde un header propio',
  }),
  Object.freeze({
    id: 'auxbar',
    reason: 'es la barra móvil; no tiene header donde poner un botón',
  }),
  Object.freeze({
    id: 'stats',
    reason: 'se monta como una fila compacta de gauges en el footer derecho, sin header propio (verificado el 2026-07-31)',
  }),
]);

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function plural(count, singular, pluralForm) {
  return count === 1 ? singular : pluralForm;
}

export function auditI18n(repoRoot = DEFAULT_REPO_ROOT) {
  const root = path.resolve(repoRoot);
  const publicDir = path.join(root, 'public');
  const jsDir = path.join(publicDir, 'js');
  const dictionaryDir = path.join(publicDir, 'i18n', 'en');
  const i18nFile = path.join(jsDir, 'ui', 'i18n.js');
  const helpIndexFile = path.join(jsDir, 'ui', 'help-index.js');

  function relative(file) {
    return path.relative(root, file).split(path.sep).join('/');
  }

  function walkFiles(dir, predicate) {
    if (!fs.existsSync(dir)) return [];
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...walkFiles(file, predicate));
      else if (entry.isFile() && predicate(file)) found.push(file);
    }
    return found.sort((a, b) => relative(a).localeCompare(relative(b)));
  }

  function htmlPages() {
    return walkFiles(
      publicDir,
      (file) => path.dirname(file) === publicDir && file.endsWith('.html'),
    );
  }

  function readModules() {
    const source = fs.readFileSync(i18nFile, 'utf8');
    const declaration = source.match(/\bconst\s+MODULES\s*=\s*\[([\s\S]*?)\]\s*;/);
    if (!declaration) {
      throw new Error(`No se pudo parsear MODULES en ${relative(i18nFile)}`);
    }
    return sortedUnique(
      [...declaration[1].matchAll(/(['"])([^'"]+)\1/g)].map((match) => match[2]),
    );
  }

  function localScriptPath(htmlFile, src) {
    const cleanSrc = src.split(/[?#]/, 1)[0];
    if (!cleanSrc || /^(?:https?:)?\/\//.test(cleanSrc)) return null;
    const resolved = cleanSrc.startsWith('/')
      ? path.resolve(publicDir, `.${cleanSrc}`)
      : path.resolve(path.dirname(htmlFile), cleanSrc);
    const outsidePublic = path.relative(publicDir, resolved).startsWith('..');
    return outsidePublic ? null : resolved;
  }

  function ignoredDictionaries(dictionaryPaths) {
    if (!dictionaryPaths.length) return [];
    try {
      // Un único git recibe todas las rutas por stdin. El feeder mantiene la
      // API pública sincrónica y evita archivos temporales dentro o fuera del repo.
      const output = execFileSync('/bin/sh', [
        '-c',
        'printf "%s\\n" "$@" | git check-ignore --stdin',
        'cwc-i18n-check-ignore',
        ...dictionaryPaths,
      ], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      return sortedUnique(output.split(/\r?\n/).filter(Boolean));
    } catch (error) {
      // git check-ignore usa exit 1 cuando no encontró coincidencias. Cualquier
      // otro fallo también es best-effort: esta auditoría nunca debe caerse por git.
      if (error?.status === 1) return [];
      return [];
    }
  }

  const usedKeys = [];
  // \b evita falsos positivos como format(...) y at(...). El cuerpo admite
  // comillas simples/dobles y whitespace (incluidos saltos) antes de la clave.
  const tCall = /\bt\s*\(\s*(['"])([^'"]+)\1/g;
  for (const file of walkFiles(jsDir, (candidate) => candidate.endsWith('.js'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(tCall)) usedKeys.push(match[2]);
  }

  const htmlAttribute = /\bdata-i18n(?:-title)?\s*=\s*(['"])([^'"]+)\1/g;
  const pageFiles = htmlPages();
  for (const file of pageFiles) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(htmlAttribute)) usedKeys.push(match[2]);
  }

  const usedByNamespace = new Map();
  for (const key of sortedUnique(usedKeys)) {
    const namespace = key.split('.')[0];
    if (!usedByNamespace.has(namespace)) usedByNamespace.set(namespace, []);
    usedByNamespace.get(namespace).push(key);
  }

  const dictionaries = new Map();
  const dictionaryFiles = walkFiles(dictionaryDir, (candidate) => candidate.endsWith('.json'));
  for (const file of dictionaryFiles) {
    const namespace = path.basename(file, '.json');
    let keys = [];
    let error = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error('la raíz no es un objeto');
      }
      keys = sortedUnique(Object.keys(parsed));
    } catch (readError) {
      error = readError.message;
    }
    dictionaries.set(namespace, { file: relative(file), keys, error });
  }

  const modules = readModules();
  const namespaces = sortedUnique([
    ...usedByNamespace.keys(),
    ...dictionaries.keys(),
    ...modules,
  ]);
  const namespaceRows = namespaces.map((namespace) => {
    const used = usedByNamespace.get(namespace) || [];
    const dictionary = dictionaries.get(namespace) || null;
    const translated = dictionary?.keys || [];
    const translatedSet = new Set(translated);
    const usedSet = new Set(used);
    const missing = used.filter((key) => !translatedSet.has(key));
    const orphaned = translated.filter((key) => !usedSet.has(key));
    let status = 'OK';
    if (!dictionary) status = 'SIN DICCIONARIO';
    else if (dictionary.error) status = 'DICCIONARIO INVÁLIDO';
    else if (missing.length) status = 'FALTANTES';
    else if (orphaned.length) status = 'HUÉRFANAS';
    return {
      namespace,
      dictionary: dictionary?.file || null,
      usedCount: used.length,
      translatedCount: translated.length,
      missingCount: missing.length,
      orphanedCount: orphaned.length,
      missing,
      orphaned,
      status,
      dictionaryError: dictionary?.error || null,
      used,
      translated,
    };
  });
  const i18n = {
    totals: namespaceRows.reduce((totals, row) => ({
      used: totals.used + row.usedCount,
      translated: totals.translated + row.translatedCount,
      missing: totals.missing + row.missingCount,
      orphaned: totals.orphaned + row.orphanedCount,
    }), { used: 0, translated: 0, missing: 0, orphaned: 0 }),
    namespaces: namespaceRows,
  };

  const moduleSet = new Set(modules);
  const dictionariesOnDisk = dictionaryFiles.map((file) => path.basename(file, '.json'));
  const dictionarySet = new Set(dictionariesOnDisk);
  const pages = pageFiles.map((file) => {
    const html = fs.readFileSync(file, 'utf8');
    const scriptSources = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(['"])([^'"]+)\1[^>]*>/gi)]
      .map((match) => match[2]);
    const scripts = [];
    let hasInitI18n = false;
    for (const src of scriptSources) {
      const scriptFile = localScriptPath(file, src);
      if (!scriptFile || !fs.existsSync(scriptFile) || !scriptFile.endsWith('.js')) continue;
      scripts.push(relative(scriptFile));
      if (/\binitI18n\b/.test(fs.readFileSync(scriptFile, 'utf8'))) hasInitI18n = true;
    }
    return {
      page: relative(file),
      scripts: sortedUnique(scripts),
      callsInitI18n: hasInitI18n,
    };
  });
  const carga = {
    dictionariesOutsideModules: dictionariesOnDisk.filter((namespace) => !moduleSet.has(namespace)),
    modulesWithoutFile: modules.filter((namespace) => !dictionarySet.has(namespace)),
    pagesWithoutInit: pages
      .filter((page) => !page.callsInitI18n)
      .map((page) => path.basename(page.page)),
    dictionariesIgnoredByGit: ignoredDictionaries(dictionaryFiles.map(relative)),
    modules,
    dictionariesOnDisk,
    pages,
  };

  const helpSource = fs.readFileSync(helpIndexFile, 'utf8');
  const marker = helpSource.indexOf('export const HELP_INDEX');
  if (marker < 0) {
    throw new Error(`No se pudo encontrar HELP_INDEX en ${relative(helpIndexFile)}`);
  }
  const indexSource = helpSource.slice(marker);
  const idMatches = [...indexSource.matchAll(/^\s{4}id:\s*(['"])([^'"]+)\1,/gm)];
  const entries = idMatches.map((match, index) => {
    const start = match.index;
    const end = idMatches[index + 1]?.index ?? indexSource.length;
    const entrySource = indexSource.slice(start, end);
    const loadMatch = entrySource.match(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/);
    const load = loadMatch?.[2] || null;
    const loadFile = load ? path.resolve(path.dirname(helpIndexFile), load) : null;
    return {
      id: match[2],
      load,
      path: loadFile ? relative(loadFile) : null,
      exists: Boolean(loadFile && fs.existsSync(loadFile) && fs.statSync(loadFile).isFile()),
    };
  });
  const indexIds = sortedUnique(entries.map((entry) => entry.id));
  const indexIdSet = new Set(indexIds);
  const buttonIds = [];
  const helpButton = /\bhelpBtn\s*\(\s*(['"])([^'"]+)\1/g;
  for (const file of walkFiles(jsDir, (candidate) => candidate.endsWith('.js'))) {
    const js = fs.readFileSync(file, 'utf8');
    for (const match of js.matchAll(helpButton)) buttonIds.push(match[2]);
  }
  const uniqueButtonIds = sortedUnique(buttonIds);
  const buttonIdSet = new Set(uniqueButtonIds);
  const exceptionIds = new Set(HELP_BUTTON_EXCEPTIONS.map((exception) => exception.id));
  const rawIndexWithoutButton = indexIds.filter((id) => !buttonIdSet.has(id));
  const ayuda = {
    indexWithoutButton: rawIndexWithoutButton.filter((id) => !exceptionIds.has(id)),
    knownExceptions: rawIndexWithoutButton.filter((id) => exceptionIds.has(id)),
    buttonsWithoutIndex: uniqueButtonIds.filter((id) => !indexIdSet.has(id)),
    brokenLoads: entries
      .filter((entry) => !entry.exists)
      .map((entry) => ({ id: entry.id, path: entry.path })),
    indexIds,
    buttonIds: uniqueButtonIds,
    entries,
  };

  const problems = [];
  const missingNamespaces = i18n.namespaces.filter((row) => row.missingCount > 0);
  if (missingNamespaces.length) {
    const detail = missingNamespaces
      .map((row) => `${row.namespace} (${row.missingCount})`)
      .join(', ');
    problems.push({
      area: 'i18n',
      message: `${missingNamespaces.length} ${plural(missingNamespaces.length, 'namespace', 'namespaces')} con claves sin traducir: ${detail}`,
    });
  }
  const invalidDictionaries = i18n.namespaces.filter((row) => row.dictionaryError);
  if (invalidDictionaries.length) {
    const detail = invalidDictionaries
      .map((row) => `${row.namespace} (${row.dictionaryError})`)
      .join(', ');
    problems.push({
      area: 'i18n',
      message: `${invalidDictionaries.length} ${plural(invalidDictionaries.length, 'diccionario inválido', 'diccionarios inválidos')}: ${detail}`,
    });
  }
  if (carga.dictionariesOutsideModules.length) {
    problems.push({
      area: 'carga',
      message: `${carga.dictionariesOutsideModules.length} ${plural(carga.dictionariesOutsideModules.length, 'diccionario en disco que MODULES no carga', 'diccionarios en disco que MODULES no carga')}: ${carga.dictionariesOutsideModules.join(', ')}`,
    });
  }
  if (carga.modulesWithoutFile.length) {
    problems.push({
      area: 'carga',
      message: `${carga.modulesWithoutFile.length} ${plural(carga.modulesWithoutFile.length, 'entrada de MODULES sin archivo', 'entradas de MODULES sin archivo')}: ${carga.modulesWithoutFile.join(', ')}`,
    });
  }
  if (carga.pagesWithoutInit.length) {
    problems.push({
      area: 'carga',
      message: `${carga.pagesWithoutInit.length} ${plural(carga.pagesWithoutInit.length, 'página sin initI18n', 'páginas sin initI18n')}: ${carga.pagesWithoutInit.join(', ')}`,
    });
  }
  if (carga.dictionariesIgnoredByGit.length) {
    problems.push({
      area: 'carga',
      message: `${carga.dictionariesIgnoredByGit.length} ${plural(carga.dictionariesIgnoredByGit.length, 'diccionario ignorado por git', 'diccionarios ignorados por git')}: ${carga.dictionariesIgnoredByGit.join(', ')}`,
    });
  }
  if (ayuda.indexWithoutButton.length) {
    problems.push({
      area: 'ayuda',
      message: `${ayuda.indexWithoutButton.length} ${plural(ayuda.indexWithoutButton.length, 'tema del índice sin helpBtn', 'temas del índice sin helpBtn')}: ${ayuda.indexWithoutButton.join(', ')}`,
    });
  }
  if (ayuda.buttonsWithoutIndex.length) {
    problems.push({
      area: 'ayuda',
      message: `${ayuda.buttonsWithoutIndex.length} ${plural(ayuda.buttonsWithoutIndex.length, 'helpBtn sin tema en el índice', 'helpBtn sin tema en el índice')}: ${ayuda.buttonsWithoutIndex.join(', ')}`,
    });
  }
  if (ayuda.brokenLoads.length) {
    problems.push({
      area: 'ayuda',
      message: `${ayuda.brokenLoads.length} ${plural(ayuda.brokenLoads.length, 'tema de ayuda apunta a un archivo inexistente', 'temas de ayuda apuntan a archivos inexistentes')}: ${ayuda.brokenLoads.map((entry) => entry.id).join(', ')}`,
    });
  }

  return {
    ok: problems.length === 0,
    problems,
    i18n,
    carga,
    ayuda,
  };
}
