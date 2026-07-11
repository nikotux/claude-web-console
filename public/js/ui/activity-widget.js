// ui/activity-widget.js — widget compacto de "Actividad en Segundo Plano"
// (proyecto ROAD-76). Vive en el pie de la barra derecha, ENTRE el pulso de
// Tolkien (.tk-persist) y los gauges de recursos (data-module="stats").
//
// Muestra, en ~2 líneas y con ÍCONOS + NÚMEROS (el espacio es chico):
//   🤖 N  → subagentes (chats delegando en un Task/Agent ahora)
//   ⚙️ N  → procesos/runners desacoplados vivos (bin/cwc-*-runner.js)
//   ●     → semáforo con el color del MODELO DOMINANTE corriendo ahora
// Oculto (guard [hidden]) si no hay NADA en segundo plano.
// Clickeable → abre la ventana de detalle (modules/system/activity-modal.js).
//
// No encuesta solo: main.js lo alimenta con update(processes, chats) dentro del
// poll de 8 s ya existente (processes de /api/health/active-runners; chats de
// /api/chat/list, que ya se consulta). 0 estado en el server.
import { icon, hydrateIcons } from './icons.js';
import { modelColor, modelName } from './models.js';
import { openActivityModal, refreshActivityModal, activityModalOpen } from '../modules/system/activity-modal.js';

const KNOWN_MODELS = ['haiku', 'sonnet', 'opus', 'fable'];

export function initActivityWidget({ openChat } = {}) {
  const el = document.getElementById('activity-widget');
  if (!el) return { update() {} };
  let data = { processes: [], agents: [] };

  const open = () => openActivityModal(data, { openChat });
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });

  function dominantModel() {
    const counts = {};
    for (const it of [...data.agents, ...data.processes]) {
      if (KNOWN_MODELS.includes(it.model)) counts[it.model] = (counts[it.model] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  function render() {
    const nAg = data.agents.length;
    const nPr = data.processes.length;
    const total = nAg + nPr;
    // SIEMPRE visible (pedido de Niko 2026-07-11: "actualicé y no lo veo" — un
    // widget que se esconde cuando está vacío es indescubrible). En reposo se
    // atenúa (.cwc-activity--idle) mostrando 0/0 con semáforo gris; al arrancar
    // algo se enciende con el color del modelo dominante. El guard [hidden] queda
    // sin usar (no togglear la clase .hidden, que NO existe en el CSS).
    el.hidden = false;
    el.classList.toggle('cwc-activity--idle', total === 0);
    const dom = dominantModel();
    el.title = `${nAg} subagente(s) · ${nPr} proceso(s) en segundo plano${dom ? ` · modelo dominante: ${modelName(dom)}` : ''} — tocá para ver el detalle`;
    el.innerHTML = `
      <div class="cwc-act-cols">
        <span class="cwc-act-col" title="${nAg} subagente(s) en chats">${icon('sparkle', { size: 14 })}<b class="cwc-act-n">${nAg}</b></span>
        <span class="cwc-act-col" title="${nPr} proceso(s) en segundo plano">${icon('gear', { size: 14 })}<b class="cwc-act-n">${nPr}</b></span>
      </div>
      <span class="cwc-act-sem" style="background:${dom ? modelColor(dom) : 'var(--cwc-model-unknown)'}" title="${dom ? `Modelo dominante: ${modelName(dom)}` : 'Sin modelo IA activo'}"></span>`;
    hydrateIcons(el);
  }

  // processes: array del endpoint; chats: /api/chat/list.
  function update(processes, chats) {
    const agents = (chats || [])
      .filter((c) => c.delegating)
      .map((c) => ({
        kind: 'agent',
        key: `agent:${c.id}`,
        chatId: c.id,
        session: c.title || c.id,
        model: KNOWN_MODELS.includes(c.model) ? c.model : (c.model || null),
        count: c.delegatingCount || 1,
        startedAt: c.delegatingSince || null,
      }));
    data = { processes: processes || [], agents };
    render();
    if (activityModalOpen()) refreshActivityModal(data);
  }

  render();
  return { update };
}
