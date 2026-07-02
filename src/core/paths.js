// core/paths.js — resolución de rutas SEGURA dentro del home permitido.
//
// Toda ruta que llega desde el cliente se trata como relativa a config.home y
// se valida que, una vez resuelta, siga cayendo dentro de él. Así se bloquea
// el path traversal (../../etc/passwd) y las rutas absolutas inyectadas.
import path from 'node:path';
import { config } from './config.js';

// Devuelve la ruta absoluta dentro del home, o null si hay intento de escape.
export function resolveWithinHome(rel = '') {
  // Descartamos separadores iniciales: TODO se interpreta relativo al home
  // (una "/etc/passwd" del cliente se vuelve "<home>/etc/passwd", no la raíz).
  const clean = String(rel).replace(/^[/\\]+/, '');
  const target = path.resolve(config.home, clean);

  // Comparación por segmentos (evita el falso positivo de startsWith con
  // prefijos como /home/user vs /home/user-malicioso).
  const relFromHome = path.relative(config.home, target);
  if (relFromHome.startsWith('..') || path.isAbsolute(relFromHome)) return null;
  return target; // relFromHome === '' => el propio home, que es válido
}

// Variante para cwd de sesiones/chats: acepta rutas relativas al home O
// absolutas dentro de él, y ante un escape CAE al home en vez de fallar.
// Misma comparación por segmentos que resolveWithinHome (un startsWith
// aceptaría /home/user-malicioso como "dentro" de /home/user).
export function clampToHome(requested) {
  if (!requested) return config.home;
  const resolved = path.resolve(config.home, String(requested));
  const relFromHome = path.relative(config.home, resolved);
  if (relFromHome.startsWith('..') || path.isAbsolute(relFromHome)) return config.home;
  return resolved;
}
