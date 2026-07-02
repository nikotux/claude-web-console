// modules/chat/chat-tab.js — vista de conversación nativa (Fase 4a: mínima).
//
// Una pestaña de chat = un WS a /ws/chat?id=<id>. Burbujas con streaming,
// tarjetas de permiso [Permitir]/[Denegar], selector de modo, costo por turno
// y detener. El input es un TEXTAREA normal: el dictado por voz del teléfono
// funciona nativo (el motivo de esta migración). Markdown/diffs llegan en 4b.
import { icon } from '../../ui/icons.js';
import { renderMarkdown } from '../../ui/markdown.js';
import { renderDiff } from '../../ui/diff.js';

const MODES = [
  ['default', 'Preguntar'],
  ['acceptEdits', 'Aceptar ediciones'],
  ['plan', 'Solo plan'],
];

export class ChatTab {
  constructor({ id, title, container, onToggleMode, onViewMode, initialPrompt = null }) {
    this.id = id;
    this.title = title || 'chat';
    this.container = container;
    this.onToggleMode = onToggleMode; // pasar a TUI (lo maneja el shell)
    this.onViewMode = onViewMode;     // el server anunció un cambio de modo
    this.initialPrompt = initialPrompt; // primer mensaje a enviar al conectar
    this._sentInitial = false;
    this.ws = null;
    this.reconnectTimer = null;
    this.closedByUser = false;
    this.streamEl = null;   // burbuja del asistente en streaming
    this.totalCost = 0;

    container.classList.add('chat-pane-host');
    container.innerHTML = `
      <div class="chat-view">
        <header class="chat-head">
          <span class="chat-title">${this.title}</span>
          <select class="chat-mode" title="Modo de permisos">
            ${MODES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
          </select>
          <button class="btn-ghost btn--icon chat-toggle" title="Abrir como Terminal (TUI)">${icon('terminal', { size: 16 })}</button>
          <span class="chat-cost" title="Costo estimado de esta conversación">$0.00</span>
        </header>
        <div class="chat-msgs"></div>
        <div class="chat-composer">
          <textarea class="chat-input" rows="1" enterkeyhint="send"
            placeholder="Escribí o dictá un mensaje…"></textarea>
          <button class="btn btn--icon chat-send" title="Enviar">${icon('play', { size: 16 })}</button>
          <button class="btn-ghost btn--icon chat-stop" title="Detener" hidden>${icon('close', { size: 16 })}</button>
        </div>
      </div>`;

    this.msgsEl = container.querySelector('.chat-msgs');
    this.inputEl = container.querySelector('.chat-input');
    this.sendBtn = container.querySelector('.chat-send');
    this.stopBtn = container.querySelector('.chat-stop');
    this.modeEl = container.querySelector('.chat-mode');
    this.costEl = container.querySelector('.chat-cost');
    this.toggleBtn = container.querySelector('.chat-toggle');

    this.sendBtn.addEventListener('click', () => this._submit());
    this.stopBtn.addEventListener('click', () => this._send({ type: 'interrupt' }));
    this.toggleBtn.addEventListener('click', () => this.onToggleMode?.());
    this.modeEl.addEventListener('change', () => this._send({ type: 'set_mode', mode: this.modeEl.value }));
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this._submit();
      }
    });
    // Autogrow del textarea (hasta ~6 líneas).
    this.inputEl.addEventListener('input', () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 140)}px`;
    });
  }

  connect() {
    const url = `wss://${location.host}/ws/chat?id=${encodeURIComponent(this.id)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      // Prompt precargado (p.ej. desde un ticket): se envía UNA sola vez, no en
      // las reconexiones.
      if (this.initialPrompt && !this._sentInitial) {
        this._sentInitial = true;
        this._send({ type: 'user', text: this.initialPrompt });
      }
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      this._onEvent(m);
    };
    ws.onclose = () => {
      if (this.closedByUser) return;
      this.reconnectTimer = setTimeout(() => this.connect(), 1500);
    };
    ws.onerror = () => ws.close();
  }

  _submit() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this._send({ type: 'user', text });
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';
    this.inputEl.focus();
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  // ===== Render de eventos (mismo camino para history y vivo) =====
  _onEvent(m) {
    switch (m.type) {
      case 'history':
        this.msgsEl.innerHTML = '';
        this.streamEl = null;
        this.totalCost = 0;
        for (const ev of m.events) this._onEvent(ev);
        if (m.mode) this.modeEl.value = m.mode;
        this._setWorking(m.status === 'working');
        break;
      case 'user': this._closeStream(); this._bubble('user', m.text); break;
      case 'assistant': this._assistantFinal(m.text); break;
      case 'delta': this._stream(m.text); break;
      case 'tool_use': this._closeStream(); this._toolCard(m); break;
      case 'tool_result': this._toolResult(m); break;
      case 'permission_request': this._permCard(m); break;
      case 'permission_closed': this._permClose(m); break;
      case 'result': this._result(m); break;
      case 'status': this._setWorking(m.state === 'working'); break;
      case 'mode': this.modeEl.value = m.mode; break;
      case 'viewmode':
        if (m.viewMode === 'switching') {
          this._line('chat-switch-note', 'Cambiando a Terminal (TUI)…');
          if (this.toggleBtn) this.toggleBtn.disabled = true;
        } else if (m.error) {
          this._line('chat-error', m.error);
          if (this.toggleBtn) this.toggleBtn.disabled = false;
        }
        // El shell reconstruye la vista si el modo efectivo cambió.
        this.onViewMode?.(m);
        break;
      case 'error': this._line('chat-error', `Error: ${m.message}`); break;
      case 'closed':
        this._line('chat-closed-note', 'Conversación cerrada en el servidor.');
        this.inputEl.disabled = true;
        this.sendBtn.disabled = true;
        break;
      default: break;
    }
  }

  _bubble(kind, text) {
    const el = document.createElement('div');
    el.className = `chat-msg chat-${kind}`;
    el.textContent = text;
    this.msgsEl.appendChild(el);
    this._scroll();
    return el;
  }

  _stream(text) {
    if (!this.streamEl) this.streamEl = this._bubble('assistant streaming', '');
    this.streamEl.textContent += text;
    this._scroll();
  }

  // Texto final del asistente: reemplaza la burbuja de streaming (texto plano)
  // por la versión renderizada en markdown.
  _assistantFinal(text) {
    const md = renderMarkdown(text);
    if (this.streamEl) {
      this.streamEl.classList.remove('streaming');
      this.streamEl.replaceChildren(md);
      this.streamEl = null;
    } else {
      const el = document.createElement('div');
      el.className = 'chat-msg chat-assistant';
      el.appendChild(md);
      this.msgsEl.appendChild(el);
    }
    this._scroll();
  }

  _closeStream() {
    if (this.streamEl) {
      this.streamEl.classList.remove('streaming');
      this.streamEl = null;
    }
  }

  // Tool call como <details> colapsado: resumen de una línea; adentro el
  // input (diff para Edit/Write, comando para Bash) y luego el resultado.
  _toolCard(m) {
    const det = document.createElement('details');
    det.className = 'chat-toolcard';
    if (m.id) det.dataset.toolId = m.id;
    det.innerHTML = `
      <summary>${icon('terminal', { size: 13 })}<span class="ct-name">${m.name}</span><span class="ct-sum"></span></summary>
      <div class="ct-body"></div>`;
    det.querySelector('.ct-sum').textContent = m.summary || '';
    const body = det.querySelector('.ct-body');
    const d = m.detail;
    if (d && (d.old != null || d.new != null)) body.appendChild(renderDiff(d));
    else if (d?.command) {
      const pre = document.createElement('pre');
      pre.className = 'ct-cmd';
      pre.textContent = d.command;
      body.appendChild(pre);
    }
    this.msgsEl.appendChild(det);
    this._scroll();
  }

  _toolResult(m) {
    if (!m.id) return;
    const det = this.msgsEl.querySelector(`[data-tool-id="${CSS.escape(m.id)}"]`);
    if (!det) return;
    const pre = document.createElement('pre');
    pre.className = 'ct-out' + (m.ok ? '' : ' err');
    pre.textContent = m.output || '(sin salida)';
    det.querySelector('.ct-body').appendChild(pre);
    det.querySelector('summary').classList.add(m.ok ? 'done' : 'fail');
  }

  _permCard(m) {
    const el = document.createElement('div');
    el.className = 'chat-perm';
    el.dataset.permId = m.id;
    el.innerHTML = `
      <div class="chat-perm-head">${icon('gear', { size: 14 })}<span>Claude quiere usar <b>${m.tool}</b></span></div>
      <div class="chat-perm-sum"></div>
      <div class="chat-perm-actions">
        <button class="btn-ghost btn--sm" data-allow="0">Denegar</button>
        <button class="btn btn--sm" data-allow="1">Permitir</button>
      </div>`;
    el.querySelector('.chat-perm-sum').textContent = m.summary || '';
    // Si es una edición, mostramos el diff exacto para decidir viendo el cambio.
    if (m.detail && (m.detail.old != null || m.detail.new != null)) {
      el.querySelector('.chat-perm-sum').after(renderDiff(m.detail));
    }
    for (const b of el.querySelectorAll('[data-allow]')) {
      b.addEventListener('click', () => {
        this._send({ type: 'permission_response', id: m.id, allow: b.dataset.allow === '1' });
      });
    }
    this.msgsEl.appendChild(el);
    this._scroll();
  }

  _permClose(m) {
    const el = this.msgsEl.querySelector(`[data-perm-id="${m.id}"]`);
    if (!el) return;
    el.querySelector('.chat-perm-actions').innerHTML =
      `<span class="chat-perm-badge ${m.allow ? 'ok' : 'no'}">${m.allow ? 'Permitido' : 'Denegado'}</span>`;
  }

  _result(m) {
    this._closeStream();
    if (m.costUsd != null) {
      this.totalCost += m.costUsd;
      this.costEl.textContent = `$${this.totalCost.toFixed(2)}`;
      const el = document.createElement('div');
      el.className = 'chat-turn-cost';
      const tok = m.usage ? ` · ${m.usage.output} tok` : '';
      el.textContent = `$${m.costUsd.toFixed(4)}${tok}${m.ms ? ` · ${(m.ms / 1000).toFixed(1)}s` : ''}`;
      this.msgsEl.appendChild(el);
      this._scroll();
    }
  }

  _line(cls, text) {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    this.msgsEl.appendChild(el);
    this._scroll();
  }

  _setWorking(on) {
    this.stopBtn.hidden = !on;
    this.sendBtn.hidden = on;
    this.container.querySelector('.chat-view').classList.toggle('working', on);
  }

  _scroll() {
    this.msgsEl.scrollTop = this.msgsEl.scrollHeight;
  }

  focus() {
    // En táctil no auto-enfocamos: abriría el teclado sin que lo pidas.
    if (!window.matchMedia('(pointer: coarse)').matches) this.inputEl.focus();
  }

  dispose() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch { /* noop */ }
  }
}
