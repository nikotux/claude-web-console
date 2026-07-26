// modules/seguimientos/classify-shared.js — clasificación IA batch de frentes.
// Solo interpreta el snapshot ya armado por la Aduana: no lee Desk ni toca el
// mundo externo. Best-effort: cualquier respuesta rara devuelve Map vacío.
import { textOnlyQuery } from '../../core/text-only-query.js';

// Fuente ÚNICA de la taxonomía de ownerType: la consume el prompt IA, la
// validación de normalizeClassification Y el frontend (vía el snapshot de
// GET /api/seguimientos). Antes estaba duplicada a mano en
// public/js/seguimientos/seguimientos.js: agregar un tipo en el backend sin
// tocar el front hacía caer esos frentes al fallback '⚪ —' en silencio.
export const OWNER_TYPE_LIST = [
  { key: 'vendor', label: '🔴 Proveedor', color: 'var(--cwc-danger)' },
  { key: 'aprobacion', label: '🟠 Aprobación', color: 'var(--cwc-warn)' },
  { key: 'decision-mark-chris', label: '🟡 Decisión M/C', color: 'var(--cwc-warn)' },
  { key: 'mio', label: '✅ Mío', color: 'var(--cwc-ok)' },
];
const OWNER_TYPES = new Set(OWNER_TYPE_LIST.map((t) => t.key));

function briefFrente(f) {
  return {
    key: String(f?.key || f?.id || ''),
    title: String(f?.title || '').slice(0, 500),
    status: f?.status || f?.statusType || null,
    domain: f?.domain || null,
    daysIdle: Number.isFinite(f?.daysIdle) ? f.daysIdle : 0,
  };
}

function buildPrompt(items) {
  return [
    'Clasificá estos frentes de un dashboard personal de facilities/gestión.',
    'IMPORTANTE: son tareas HUMANAS (coordinar proveedores, aprobaciones,',
    'decisiones de Mark/Chris o acciones mías), no tickets de backend/dev/código.',
    'Si algún ítem parece backend, desarrollo, código, deploy, bug técnico o PR,',
    'marcalo con isBackend:true.',
    '',
    'Personas internas del equipo (Mordor) y sus roles — para el campo involucrados:',
    '- Julián: líder del proyecto de la OFICINA NUEVA (Local 112) e infraestructura IT.',
    '- Camilo: CONTABILIDAD (anticipos, pagos, reembolsos, cualquier tema financiero o de costo).',
    '- Chris: jefe (aprobaciones de alto nivel / presupuesto).',
    '- Mark: dueño del APARTAMENTO (decisiones sobre su casa).',
    '',
    'Devolvé SOLO un array JSON, sin markdown ni explicación. Un objeto por frente,',
    'con esta forma exacta:',
    '[{"key":"...","ownerBall":"nombre corto","ownerType":"vendor|aprobacion|decision-mark-chris|mio","blockedBy":["nombre"],"involucrados":["nombre"],"nextAction":"frase corta","isBackend":false,"isMine":true}]',
    '',
    'Reglas:',
    '- key debe ser exactamente el recibido.',
    '- ownerBall es el nombre corto de quien tiene la pelota ahora.',
    '- ownerType debe ser uno de: vendor, aprobacion, decision-mark-chris, mio.',
    '- blockedBy es un array de nombres concretos; si no hay bloqueo, array vacío.',
    '- involucrados: personas INTERNAS del equipo metidas en el frente MÁS ALLÁ del dueño de la',
    '  pelota (stakeholders que aprueban/empujan/coordinan). Aplicá los roles de arriba: p.ej.',
    '  CUALQUIER frente de la oficina Local 112 involucra a Julián; CUALQUIER tema financiero/',
    '  anticipo/pago involucra a Camilo. Array vacío si ninguno aplica.',
    '- nextAction debe ser una frase corta, accionable y en español.',
    '- isMine es true si la próxima acción depende de mí.',
    '- No inventes datos finos: inferí conservadoramente desde título/status/domain/daysIdle.',
    '',
    'Frentes:',
    JSON.stringify(items, null, 2),
  ].join('\n');
}

function jsonArrayFromText(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end < start) return null;
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeClassification(o) {
  if (!o || typeof o !== 'object' || !o.key) return null;
  const ownerType = OWNER_TYPES.has(o.ownerType) ? o.ownerType : 'mio';
  return {
    key: String(o.key),
    ownerBall: typeof o.ownerBall === 'string' ? o.ownerBall.slice(0, 80) : '',
    ownerType,
    blockedBy: Array.isArray(o.blockedBy)
      ? o.blockedBy.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.slice(0, 80))
      : [],
    involucrados: Array.isArray(o.involucrados)
      ? o.involucrados.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.slice(0, 60))
      : [],
    nextAction: typeof o.nextAction === 'string' ? o.nextAction.slice(0, 240) : '',
    isBackend: !!o.isBackend,
    isMine: !!o.isMine,
  };
}

// Tamaño de lote: con demasiados frentes en UNA respuesta, Haiku trunca el
// array (verificado: 61 de golpe devuelve JSON incompleto → parse falla). Se
// clasifica en lotes chicos y se fusiona. Cada lote es best-effort e independiente.
const CHUNK = 10;

export async function classifyFrentes(frentes) {
  const items = (Array.isArray(frentes) ? frentes : []).map(briefFrente).filter((f) => f.key);
  if (!items.length) return new Map();

  const out = new Map();
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    try {
      const text = await textOnlyQuery(buildPrompt(chunk), { model: 'haiku', maxTurns: 1, timeoutMs: 120000 });
      const parsed = jsonArrayFromText(text);
      if (!Array.isArray(parsed)) continue;
      for (const raw of parsed) {
        const c = normalizeClassification(raw);
        if (c) out.set(c.key, c);
      }
    } catch { /* best-effort: si un lote falla, sigue con el resto */ }
  }
  return out;
}
