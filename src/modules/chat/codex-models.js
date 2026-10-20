// Whitelists de modelos/esfuerzos de Codex. Viven acá, extraídas de
// codex-tool.js, para que src/modules/chat/index.js pueda validarlas sin
// arrastrar el Agent SDK ni zod al proceso del server; esa era la razón de la
// whitelist duplicada que este archivo elimina.
export const TANDEM_CODEX_MODEL = 'gpt-5.6-sol';
export const TANDEM_CODEX_EFFORT = 'high';

// Esfuerzos que acepta CADA modelo (catálogo real del CLI de Codex 0.146.0,
// verificado en ~/.codex/models_cache.json). La whitelist incluye a propósito
// SOLO modelos con `visibility: "list"`; los `hide` (`gpt-reserve` y
// `codex-auto-review`) quedan deliberadamente afuera. sol/terra suman `ultra`
// ("máximo razonamiento con delegación automática"), luna llega hasta `max`,
// y los modelos legacy cortan en `xhigh`. Codex 0.162.1 (2026-10-13) suma la
// familia GPT-6 (astra/sol suman `ultra`, luna hasta `max`) y pasa `gpt-5.5` a
// `hide`; se conserva igual para no invalidar chats que lo tengan guardado. El
// default de Tándem sigue en gpt-5.6-sol hasta probar GPT-6 a mano.
export const CODEX_MODEL_EFFORTS = {
  'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4-mini': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.3-codex-spark': ['low', 'medium', 'high', 'xhigh'],
};

export const CODEX_MODELS = new Set(Object.keys(CODEX_MODEL_EFFORTS));
export const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export function normalizeCodexModel(model) {
  return CODEX_MODELS.has(model) ? model : TANDEM_CODEX_MODEL;
}

// Devuelve un esfuerzo VÁLIDO PARA ESE MODELO: un `ultra` pedido sobre luna (que
// no lo soporta) cae al default en vez de hacer fallar la corrida con un 400.
export function normalizeCodexEffort(model, effort) {
  const allowed = CODEX_MODEL_EFFORTS[normalizeCodexModel(model)];
  if (allowed.includes(effort)) return effort;
  return allowed.includes(TANDEM_CODEX_EFFORT) ? TANDEM_CODEX_EFFORT : allowed[allowed.length - 1];
}
