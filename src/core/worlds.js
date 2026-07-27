// core/worlds.js — fuente única para la etiqueta humana de un mundo por cwd.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

// Se deriva acá en vez de importar ENVS_DIR desde modules/tolkien/env-store.js:
// core no debe depender de modules. Mantiene la misma ruta canónica del store.
const ENVS_DIR = path.join(config.home, '.cwc-data', 'tolkien-envs');
const CONSOLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function worldLabelFor(cwd) {
  if (!cwd) return null;
  const abs = path.resolve(cwd);
  const envsDir = path.resolve(ENVS_DIR);
  // Una subcarpeta del repo sigue perteneciendo a Mi Consola; se conserva la
  // variante amplia que ya usaba el bus, no solo el match de la raíz.
  if (abs === CONSOLE_ROOT || abs.startsWith(CONSOLE_ROOT + path.sep)) return 'Mi Consola';
  if (config.projectDir && (abs === path.resolve(config.projectDir) || abs.startsWith(envsDir + path.sep))) return 'Tolkien';
  return path.basename(abs) || null;
}
