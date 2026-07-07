// board/index.js — composición del tablero de Comunicaciones: modal full-screen
// + listener delegado + ciclo de vida. Estado en store.js, render puro en
// render.js, endpoints en actions.js, polls por clave en polls.js.
import * as store from './store.js';
import { initRender, render } from './render.js';
import * as A from './actions.js';
import { stopAll } from './polls.js';

export function openCommsBoard({ dialog, icon, openChat, projectRel, onClose } = {}) {
  const m = dialog.openModal({ title: 'Comunicaciones', width: '90vw', onClose });
  m.card.classList.add('dlg-card--tickets');
  m.card.style.maxWidth = '';

  const wrap = document.createElement('div');
  wrap.className = 'cm';
  wrap.innerHTML = `
    <div class="cm-top">
      <div class="bb-tabs" data-ref="tabs" role="tablist"></div>
      <div class="cm-toolbar">
        <button class="btn-ghost btn--sm" data-act="addcontact">${icon('plus', { size: 13 })}<span>Contacto</span></button>
        <button class="btn btn--sm" data-act="scan">${icon('refresh', { size: 13 })}<span>GitHub</span></button>
        <button class="btn-ghost btn--sm" data-act="scanteams" title="Leer mensajes directos de Teams (consume tokens)">${icon('search', { size: 13 })}<span>Teams</span></button>
      </div>
    </div>
    <div class="cm-body" data-ref="body"></div>`;
  m.body.appendChild(wrap);

  const refs = {};
  for (const r of wrap.querySelectorAll('[data-ref]')) refs[r.dataset.ref] = r;

  store.reset();
  initRender({ icon, refs });
  A.initActions({ dialog, openChat, projectRel });
  store.subscribe(render);

  // Pestaña (contacto) — un simple set, re-render seguro.
  refs.tabs.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (!t || t.dataset.tab === store.get().tab) return;
    store.set({ tab: t.dataset.tab });
  });

  // Listener delegado del cuerpo + toolbar (acciones por data-act; expand por header).
  wrap.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      if (act.tagName === 'A') return; // links (Ver en GitHub) navegan solos
      e.preventDefault();
      const id = act.dataset.id;
      switch (act.dataset.act) {
        case 'addcontact': A.addContact(); return;
        case 'scan': A.scan(); return;
        case 'scanteams': A.scanTeams(); return;
        case 'log': A.logManual(store.get().tab); return;
        case 'send': A.sendMessage(store.get().tab); return;
        case 'reply': {
          // Respuesta rápida: enfoca el composer del contacto (arriba del hilo).
          const ta = wrap.querySelector('.cm-composer-input');
          if (ta) { ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); ta.focus(); }
          return;
        }
        case 'togglearch': store.set({ showArchived: !store.get().showArchived }); return;
        case 'talk': { const t = store.get().threads.find((x) => x.id === id); if (t) A.talkAbout(t); return; }
        case 'project': A.assignProject(id); return;
        case 'seen': A.markSeen(id); return;
        case 'archive': A.archive(id, act.dataset.arch === '1'); return;
        case 'analyze': A.analyze(id); return;
        case 'useproject': A.applySuggestedProject(id, act.dataset.proj); return;
        default: return;
      }
    }
    const head = e.target.closest('.cm-thead');
    if (head?.dataset?.id) A.toggleExpand(head.dataset.id);
  });

  // Composer: cada tecla escribe el borrador al store SIN re-render (así el
  // texto sobrevive a un re-render por scan/reload; el botón Enviar se rehúsa
  // hasta que hay texto — se sincroniza con el próximo render legítimo).
  wrap.addEventListener('input', (e) => {
    const ta = e.target.closest('.cm-composer-input');
    if (!ta) return;
    const tab = store.get().tab;
    if (tab) store.get().composer[tab] = ta.value;
    // Habilitar/deshabilitar el botón Enviar en vivo, sin re-render (que
    // perdería el foco del textarea mientras se tipea).
    const btn = wrap.querySelector('[data-act="send"]');
    if (btn) btn.disabled = !ta.value.trim() || !!store.get().busy.send;
  });

  A.reload();

  const origClose = m.close;
  m.close = () => { stopAll(); origClose(); };
  return m;
}
