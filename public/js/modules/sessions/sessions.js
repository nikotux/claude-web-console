// modules/sessions/sessions.js — "Sesiones": retomar trabajo.
//
// Sección principal del sidebar, SIEMPRE visible (sin acordeón). Lista las
// sesiones tmux de todos los sockets; adjuntar = abrir pestaña; matar y el
// selector de modelo van con diálogos propios. Las tarjetas ricas (estado
// real, nombre editable) llegan en la Fase 3 — este es el port del panel
// anterior al patrón de módulos.
import { modelColor } from '../../ui/models.js';

export default {
  name: 'sessions',

  mount(el, ctx) {
    const { icon, dialog, bus, openSession } = ctx;

    el.innerHTML = `
      <header class="sec-head">
        <span class="sec-title">Sesiones</span>
        <span class="side-count" data-ref="count"></span>
        <button class="btn-ghost btn--sm btn--icon" data-ref="refresh" title="Refrescar">${icon('refresh', { size: 14 })}</button>
      </header>
      <div class="sess-list" data-ref="list"></div>`;

    const listEl = el.querySelector('[data-ref="list"]');
    const countEl = el.querySelector('[data-ref="count"]');
    el.querySelector('[data-ref="refresh"]').addEventListener('click', refresh);
    bus.addEventListener('sessions-changed', refresh);

    const shortCwd = (p) => {
      const parts = (p || '').split('/').filter(Boolean);
      return parts.length ? parts[parts.length - 1] : p || '';
    };

    async function refresh() {
      listEl.innerHTML = '<div class="cwc-loading"><span class="cwc-spinner"></span>cargando…</div>';
      try {
        const res = await fetch('/api/tmux/sessions');
        if (!res.ok) throw new Error();
        const { sessions } = await res.json();
        render(sessions);
      } catch {
        listEl.innerHTML = '<div class="tmux-msg tmux-err">No se pudieron listar las sesiones.</div>';
      }
    }

    function render(sessions) {
      countEl.textContent = sessions.length ? String(sessions.length) : '';
      if (!sessions.length) {
        listEl.innerHTML = '<div class="tmux-msg">Sin sesiones. Creá una con “Nueva sesión”.</div>';
        return;
      }
      const bySocket = new Map();
      for (const s of sessions) {
        if (!bySocket.has(s.socketName)) bySocket.set(s.socketName, []);
        bySocket.get(s.socketName).push(s);
      }
      listEl.innerHTML = '';
      for (const [sockName, list] of bySocket) {
        const grp = document.createElement('div');
        grp.className = 'tmux-grp';
        grp.innerHTML = `<div class="tmux-grp-h">socket: ${sockName}</div>`;
        for (const s of list) grp.appendChild(row(s));
        listEl.appendChild(grp);
      }
    }

    function setCurModel(elm, model) {
      if (!elm) return;
      if (model) {
        const color = modelColor(model.key);
        elm.innerHTML = `<span class="tmux-flag" style="background:${color}"></span>${model.name}`;
        elm.style.color = color;
        elm.title = `Modelo en uso: ${model.name} (${model.id})`;
      } else {
        elm.innerHTML = '<span class="tmux-flag off"></span><span class="tmux-nomodel">sin Claude</span>';
        elm.style.color = '';
        elm.title = 'No se detectó una sesión de Claude en uso';
      }
    }

    function row(s) {
      const elm = document.createElement('div');
      elm.className = 'tmux-row' + (s.owned ? ' owned' : '');
      elm.dataset.key = `${s.socket}\n${s.name}`;

      const line = document.createElement('div');
      line.className = 'tmux-line';
      const info = document.createElement('div');
      info.className = 'tmux-info';
      info.innerHTML = `
        <span class="tmux-dot ${s.attached ? 'on' : ''}">${s.attached ? '●' : '○'}</span>
        <span class="tmux-name">${s.name}</span>
        <span class="tmux-cwd">${shortCwd(s.cwd)}</span>`;
      line.append(info);

      const actions = document.createElement('div');
      actions.className = 'tmux-actions';
      const attachBtn = document.createElement('button');
      attachBtn.className = 'btn-ghost btn--sm';
      attachBtn.innerHTML = `${icon('play', { size: 13 })}<span>Adjuntar</span>`;
      attachBtn.addEventListener('click', () => openSession({ attach: { socket: s.socket, session: s.name }, title: shortCwd(s.cwd) || s.name }));
      const killBtn = document.createElement('button');
      killBtn.className = 'btn-ghost btn--sm btn--danger';
      killBtn.innerHTML = `${icon('trash', { size: 13 })}<span>Matar</span>`;
      killBtn.addEventListener('click', () => kill(s));
      actions.append(attachBtn, killBtn);

      const cur = document.createElement('div');
      cur.className = 'tmux-curmodel';
      setCurModel(cur, s.model);

      const sel = document.createElement('select');
      sel.className = 'tmux-model';
      sel.title = 'Modelo de Claude para esta sesión';
      sel.innerHTML = `
        <option value="" disabled selected>modelo…</option>
        <option value="opusplan">Auto (Opus plan / Sonnet)</option>
        <option value="opus">Opus</option>
        <option value="sonnet">Sonnet</option>
        <option value="haiku">Haiku</option>
        <option value="default">Default</option>`;
      sel.addEventListener('change', () => setModel(s, sel.value));

      elm.append(line, actions, cur, sel);
      return elm;
    }

    async function setModel(s, model) {
      if (!model) return;
      try {
        const res = await fetch('/api/tmux/set-model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ socket: s.socket, session: s.name, model }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          dialog.alertDialog({ title: 'Modelo', message: d.error || 'No se pudo cambiar el modelo.' });
        }
      } catch {
        dialog.alertDialog({ title: 'Modelo', message: 'No se pudo cambiar el modelo.' });
      }
    }

    async function kill(s) {
      const ok = await dialog.confirmDialog({
        title: 'Matar sesión',
        message: s.owned
          ? `Se cerrará definitivamente "${s.name}" y todo lo que corra adentro.`
          : `"${s.name}" es una sesión externa (socket ${s.socketName}). Matarla puede interrumpir algo que estés usando por fuera.`,
        confirmLabel: 'Matar',
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await fetch('/api/tmux/kill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ socket: s.socket, session: s.name }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          dialog.alertDialog({ title: 'Sesiones', message: d.error || 'No se pudo matar la sesión.' });
        }
      } finally {
        refresh();
      }
    }

    // Mantiene vivas las etiquetas de modelo sin reconstruir la lista.
    async function updateModelsInPlace() {
      if (document.hidden) return;
      try {
        const { sessions } = await (await fetch('/api/tmux/sessions')).json();
        const map = new Map(sessions.map((s) => [`${s.socket}\n${s.name}`, s.model]));
        for (const rowEl of listEl.querySelectorAll('.tmux-row')) {
          if (map.has(rowEl.dataset.key)) setCurModel(rowEl.querySelector('.tmux-curmodel'), map.get(rowEl.dataset.key));
        }
      } catch { /* noop */ }
    }
    setInterval(updateModelsInPlace, 8000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) updateModelsInPlace(); });

    refresh();
  },
};
