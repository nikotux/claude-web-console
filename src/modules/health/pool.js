// modules/health/pool.js — RE-EXPORT del pool adaptativo, que ahora vive en
// core/pool.js (infra transversal, movido en la coherencia 2026-07-12). Se
// conserva este módulo para no romper a sus consumidores históricos
// (health-runner, healthfix-orchestrator, comms-teams-runner, comms-chatbot-
// runner, tokens). Nuevos consumidores: importar directo de core/pool.js.
export { runAdaptivePool } from '../../core/pool.js';
