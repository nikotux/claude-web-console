// ui/code.js — resaltado de sintaxis COMPARTIDO (window.hljs, vendor local,
// el mismo bundle que usa el markdown del chat).
//
// Best-effort deliberado: solo se resalta con un lenguaje CONFIABLE (extensión
// de archivo conocida o lenguaje explícito) y con texto acotado — la
// autodetección sobre salidas de consola mete falsos positivos y el resaltado
// de textos enormes es lento. Si no se puede, queda texto plano: nunca rompe.
// Seguridad: hljs ESCAPA el input, su .value es HTML seguro para innerHTML.
import { t } from './i18n.js';

const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', go: 'go',
  rs: 'rust', sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json',
  css: 'css', html: 'xml', xml: 'xml', svg: 'xml', md: 'markdown',
  yml: 'yaml', yaml: 'yaml', sql: 'sql', php: 'php', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', toml: 'ini', ini: 'ini',
  conf: 'ini', service: 'ini', dockerfile: 'dockerfile',
};

export const HL_MAX_CHARS = 20000;
// Tope duro de contenido volcado al DOM (perf/memoria), con aviso visible de
// truncado — mismo patrón que diff.js (DOM_MAX_LINES) y markdown.js
// (MD_MAX_LINES). Antes fillCode volcaba el texto COMPLETO sin corte.
export const CODE_MAX_LINES = 5000;

// Lenguaje hljs a partir de la extensión de una ruta (o null si no hay
// mapeo confiable).
export function langForPath(p) {
  const m = /\.([a-z0-9]+)$/i.exec(String(p || '').trim());
  return (m && EXT_LANG[m[1].toLowerCase()]) || null;
}

// Llena un <pre> con código: resaltado si hay lenguaje confiable, plano si no.
export function fillCode(pre, text, lang) {
  const full = String(text ?? '');
  const allLines = full.split('\n');
  const truncated = allLines.length > CODE_MAX_LINES;
  const t = truncated ? allLines.slice(0, CODE_MAX_LINES).join('\n') : full;
  // Aviso de truncado (texto estático, sin metacaracteres HTML → seguro tanto
  // como textContent como concatenado a innerHTML resaltado).
  const note = truncated ? `\n${t('core.trunc.linesHidden', '… ({n} líneas más ocultas por límite de rendimiento)', { n: allLines.length - CODE_MAX_LINES })}` : '';
  pre.textContent = t + note; // fallback siempre seguro
  const hljs = window.hljs;
  if (!hljs || !lang || !t || t.length > HL_MAX_CHARS || !hljs.getLanguage(lang)) return;
  try {
    pre.innerHTML = hljs.highlight(t, { language: lang }).value + note;
    pre.classList.add('hljs');
  } catch {
    pre.textContent = t + note;
  }
}

// Resalta UNA línea (para diffs, línea a línea: el markup queda balanceado
// por línea, sin spans cruzando saltos). Devuelve HTML seguro o null.
export function highlightLine(line, lang) {
  const hljs = window.hljs;
  if (!hljs || !lang || !hljs.getLanguage(lang)) return null;
  try { return hljs.highlight(String(line), { language: lang }).value; } catch { return null; }
}
