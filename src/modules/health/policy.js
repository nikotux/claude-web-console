// modules/health/policy.js — POLÍTICA DE RIESGO de resolución (Fase A del
// orquestador anti-colisión).
//
// Clasifica DETERMINÍSTICAMENTE cada hallazgo según qué superficie toca:
//   - 'critical' → superficie sensible (seguridad/bootstrap/bind/reglas duras):
//                  NO se permite auto-resolver, solo chat manual supervisado.
//   - 'shared'   → toca archivos que varios fixes podrían pisar (registry,
//                  tokens.css, ui/, shared.js, CLAUDE.md): auto sí, pero en
//                  paralelo hay que SERIALIZARlos (lo usará la Fase B).
//   - 'safe'     → toca solo su módulo: paralelizable.
// `domain` = rutas que el fix probablemente toca (para el grafo de colisión de
// la Fase B). Sin LLM y sin estado → sobrevive a cualquier reinicio.
//
// Grounded en las REGLAS DURAS de CLAUDE.md (bind ZeroTier, auth, settingSources
// read-only headless, guardas de push, registry, paths).

// Superficies CRÍTICAS (por ruta de archivo).
const CRITICAL = [
  { re: /(^|\/)server\.js$/, why: 'bootstrap del server (bind ZeroTier, HTTPS)' },
  { re: /core\/zerotier\.js$/, why: 'detección de la IP ZeroTier (regla 1)' },
  { re: /core\/auth\.js$|core\/users\.js$/, why: 'autenticación de usuarios' },
  { re: /core\/config\.js$/, why: 'config y secretos (.env)' },
  { re: /core\/tls\.js$/, why: 'certificado/TLS' },
  { re: /core\/sdk-settings\.js$/, why: 'settingSources del SDK (regla 6)' },
  { re: /core\/registry\.js$/, why: 'montaje de módulos (si se rompe, no arranca nada)' },
  { re: /core\/paths\.js$/, why: 'validación de rutas / path-traversal' },
  { re: /modules\/backup\//, why: 'guardas de push (regla 5: Mordor-Staffing/secretos)' },
  // NOTA (2026-07-11, B0): se quitaron `bugfixes`/`bugs` (módulos ARCHIVADOS) y el
  // runner `triage` (bin/cwc-triage-runner.js ya no existe) — eran refs muertas.
  // B2 (2026-07-11): RESUELTO — se restaura la protección EQUIVALENTE para el ciclo
  // VIVO que reemplazó a bugfixes/bugs: `tickets/context-analyze-shared.js` (define
  // el blindaje read-only doble capa del runner de contexto) + el runner
  // `cwc-ticket-context-runner.js`. Es una adición CONSERVADORA (solo suma
  // protección: esos hallazgos van a chat supervisado, nunca al auto-fix), extra
  // justificada porque el auto-fix demostró tener un hueco en su allowlist (B2 #1).
  // PENDIENTE (Codex, review de Niko): evaluar si TODOS los módulos con runner
  // headless read-only (learning/explain, comms/*, audio, projects, tasks) deberían
  // entrar acá también — hoy se replica el subconjunto histórico (health + ciclo de
  // tickets), no todos. Registrado en Pad.
  { re: /modules\/(health)\/(index|shared)\.js$/, why: 'blindaje read-only headless (regla 6)' },
  { re: /modules\/tickets\/context-analyze-shared\.js$/, why: 'blindaje read-only headless del runner de contexto de tickets (regla 6)' },
  { re: /bin\/cwc-(health|healthfix|chat|ticket-context)-runner\.js$/, why: 'runner desacoplado con allowlist de seguridad' },
];

// Superficies COMPARTIDAS (varios fixes podrían tocarlas → serializar en paralelo).
const SHARED = [
  /public\/css\/(tokens|ui|style)\.css$/,
  /public\/js\/ui\//,
  /public\/js\/main\.js$/,
  /public\/index\.html$/,
  /modules\/[^/]+\/shared\.js$/,
  /(^|\/)CLAUDE\.md$/,
];

const fileOf = (f) => String(f?.file || '').split(':')[0].trim();

export function classifyFinding(f) {
  const file = fileOf(f);
  if (file) {
    const crit = CRITICAL.find((c) => c.re.test(file));
    if (crit) return { risk: 'critical', reason: crit.why, domain: [file] };
    const shared = SHARED.some((re) => re.test(file));
    return { risk: shared ? 'shared' : 'safe', reason: shared ? 'toca archivos compartidos' : '', domain: [file] };
  }
  // Sin archivo citado: conservador según el módulo. Un hallazgo sin ruta en un
  // módulo sensible se trata como CRÍTICO (mejor pecar de cauto para el gate).
  const unit = String(f?.unit || '');
  if (unit === 'core' || /^mod:(backup|health)$/.test(unit)) {
    return { risk: 'critical', reason: 'módulo sensible sin archivo puntual — verificá a mano', domain: [] };
  }
  return { risk: 'shared', reason: 'sin archivo citado (dominio incierto)', domain: [] };
}
