// bin/_env-boot.js — carga el .env del REPO por ruta explícita.
//
// core/config.js hace `import 'dotenv/config'`, que resuelve el .env contra el
// CWD del proceso. Un runner de INQUILINO corre con env limpio por allowlist
// (userRunnerEnv) y cwd fuera del repo, así que sin esto aborta con
// "[config] Falta la variable obligatoria CWC_TOKEN". Importar este módulo
// PRIMERO (antes que cualquier import que arrastre core/config.js) lo resuelve
// sin tocar el blindaje del env.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

// Claves que un proceso de INQUILINO no debe heredar ni pasar a sus hijos
// (su Bash podría leer /proc/self/environ). Se llama DESPUÉS de que config.js
// ya las capturó en memoria; el host queda intacto por retrocompatibilidad.
const SENSIBLE_RE = /(TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIAL)/i;
// Son configuración, no secretos; sus nombres coinciden con /TOKEN/i por casualidad.
const CLAUDE_CONFIG_ENV = new Set([
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'MAX_THINKING_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
]);
export function scrubEnvSecrets() {
  for (const key of Object.keys(process.env)) {
    if (key === 'CLAUDE_CODE_OAUTH_TOKEN') continue; // credencial PROPIA del inquilino
    if (CLAUDE_CONFIG_ENV.has(key)) continue;
    if (SENSIBLE_RE.test(key)) delete process.env[key];
  }
}
