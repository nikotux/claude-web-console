// core/paths.js — resolución de rutas SEGURA dentro del home permitido.
//
// Toda ruta que llega desde el cliente se trata como relativa a config.home y
// se valida que, una vez resuelta, siga cayendo dentro de él. Así se bloquea
// el path traversal (../../etc/passwd) y las rutas absolutas inyectadas.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

// Versión general: resuelve `rel` (relativa) DENTRO de `root`, o null si
// intenta escapar. Comparación por segmentos (evita el falso positivo de
// startsWith con prefijos como /a/user vs /a/user-malicioso).
export function resolveWithinRoot(root, rel = '') {
  const clean = String(rel).replace(/^[/\\]+/, '');
  const target = path.resolve(root, clean);
  const relFromRoot = path.relative(root, target);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) return null;
  return target; // relFromRoot === '' => el propio root, válido
}

// Variante para cwd de sesiones/chats: acepta rel o absoluta DENTRO de root,
// y ante un escape CAE a root en vez de fallar.
export function clampToRoot(root, requested) {
  if (!requested) return root;
  const resolved = path.resolve(root, String(requested));
  const relFromRoot = path.relative(root, resolved);
  if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) return root;
  return resolved;
}

// Devuelve la ruta absoluta dentro del home, o null si hay intento de escape.
export function resolveWithinHome(rel = '') {
  return resolveWithinRoot(config.home, rel);
}

// Variante para cwd de sesiones/chats: acepta rutas relativas al home O
// absolutas dentro de él, y ante un escape CAE al home en vez de fallar.
// Misma comparación por segmentos que resolveWithinHome (un startsWith
// aceptaría /home/user-malicioso como "dentro" de /home/user).
export function clampToHome(requested) {
  return clampToRoot(config.home, requested);
}

// Raíz de la instalación de la consola (…/claude-web-console). El server la
// inyecta como CWC_CONSOLE_ROOT en el env de los runners de chat y de los PTY
// para que una skill COMPARTIDA pueda invocar los CLIs de bin/ desde cualquier
// cwd. Un inquilino tiene su cwd clampado a su workspace aislado, que no
// contiene el repo: sin esta variable, `node bin/<cli>.js` solo funciona para
// el host. No es un secreto ni una ruta de datos de usuario — es el dato de
// INSTALACIÓN de la consola, y el aislamiento por usuario lo siguen dando
// HOME + CWC_DATA_DIR, que no se tocan acá.
export const CONSOLE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..',
);
