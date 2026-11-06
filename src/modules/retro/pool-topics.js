// Taxonomía determinística del pozo común (console:PLAN-3595). Este módulo es
// puro: lo comparten el destilador, el puente a Pad y los CLIs sin acoplarlos.
export const POOL_TOPICS_COLLECTION = 'temas';
export const POOL_TOPIC_FALLBACK = 'sin-clasificar';

export const POOL_TOPICS = Object.freeze([
  { slug: 'verificar-evidencia', hint: 'comprobar hechos contra la fuente, no inventar datos' },
  { slug: 'diagnostico', hint: 'reproducir, medir, causa raíz' },
  { slug: 'pruebas', hint: 'tests y verificación de cambios en entorno real' },
  { slug: 'alcance', hint: 'entender el pedido, confirmar lo ambiguo, pedir aprobación' },
  { slug: 'comunicacion', hint: 'correos, mensajes y documentos' },
  { slug: 'git-prs', hint: 'ramas, commits, PRs, revisión de código' },
  { slug: 'delegacion', hint: 'Codex, subagentes, sesiones paralelas' },
  { slug: 'tickets', hint: 'crear, cruzar, cerrar tickets y seguimiento' },
  { slug: 'pad-memoria', hint: 'Pad, memorias, fichas y documentación' },
  { slug: 'acceso-seguridad', hint: 'credenciales, cuentas, permisos, privacidad' },
  { slug: 'datos', hint: 'bases de datos, migraciones, idempotencia, concurrencia, aislamiento por usuario' },
  { slug: 'infra', hint: 'servidores, servicios, reinicios, entornos, red, despliegue' },
  { slug: 'diseno-codigo', hint: 'arquitectura, contratos, refactors' },
  { slug: 'interfaz', hint: 'pantallas, textos, estilos, UX' },
  { slug: 'integraciones', hint: 'MCP, APIs y servicios de terceros' },
].map(Object.freeze));

export const POOL_TOPIC_SLUGS = Object.freeze(POOL_TOPICS.map(({ slug }) => slug));

export function normalizePoolTopic(value) {
  const slug = typeof value === 'string' ? value.trim() : '';
  return POOL_TOPIC_SLUGS.includes(slug) ? slug : POOL_TOPIC_FALLBACK;
}

export function poolLessonTags({ topic, project, category, existing } = {}) {
  const tags = [];
  const add = (value) => {
    if (typeof value !== 'string') return;
    const tag = value.trim();
    if (tag && !tags.includes(tag)) tags.push(tag);
  };
  for (const tag of (Array.isArray(existing) ? existing : [])) add(tag);
  add(normalizePoolTopic(topic));
  add(project);
  add(category);
  return tags;
}
