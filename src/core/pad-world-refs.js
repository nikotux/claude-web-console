// core/pad-world-refs.js — frontera de refs de Pad entre Mi Consola y Tolkien.
// Un artefacto que se escribe en Tolkien solo puede conservar refs de ese
// workspace. La lista cerrada evita falsos positivos como UTF-8/SHA-256 y hace
// explícito el caso TASK (console) vs TTASK (tolkien).

export const PAD_REF_PREFIXES = {
  console: [
    'CONVE', 'PLAN', 'TASK', 'BUG', 'ARQUI', 'DOC', 'PLAYB', 'ROAD', 'PEND',
    'MC', 'FEAT', 'FB', 'TDA', 'RDA', 'CDT', 'IDR', 'AR',
  ],
  tolkien: ['TCONVE', 'TPLAN', 'TTASK', 'TBUG', 'TARQUI', 'TDOC', 'TPLAYB'],
};

const TOLKIEN_REF_PREFIXES = new Set(PAD_REF_PREFIXES.tolkien);
const PAD_REF_PATTERN = `\\b(?:${Object.values(PAD_REF_PREFIXES).flat().join('|')})-\\d+\\b`;
const PAD_REF_RE = new RegExp(PAD_REF_PATTERN, 'g');

export function findForeignRefsForTolkien(text) {
  const findings = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    PAD_REF_RE.lastIndex = 0;
    for (const match of line.matchAll(PAD_REF_RE)) {
      const ref = match[0];
      const prefix = ref.slice(0, ref.indexOf('-'));
      if (!TOLKIEN_REF_PREFIXES.has(prefix)) {
        findings.push({ ref, line: index + 1 });
      }
    }
  }
  return findings;
}

export function replaceForeignRefsForTolkien(text, replacement) {
  PAD_REF_RE.lastIndex = 0;
  return String(text ?? '').replace(PAD_REF_RE, (ref) => {
    const prefix = ref.slice(0, ref.indexOf('-'));
    return TOLKIEN_REF_PREFIXES.has(prefix) ? ref : replacement(ref, prefix);
  });
}
