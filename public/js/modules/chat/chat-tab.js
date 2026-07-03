// modules/chat/chat-tab.js — vista de conversación nativa (Fase 4a: mínima).
//
// Una pestaña de chat = un WS a /ws/chat?id=<id>. Burbujas con streaming,
// tarjetas de permiso [Permitir]/[Denegar], selector de modo, costo por turno
// y detener. El input es un TEXTAREA normal: el dictado por voz del teléfono
// funciona nativo (el motivo de esta migración). Markdown/diffs llegan en 4b.
import { icon } from '../../ui/icons.js';
import { renderMarkdown } from '../../ui/markdown.js';
import { renderDiff } from '../../ui/diff.js';
import { dismissablePopup } from '../../ui/popup.js';
import { pacman } from '../../ui/pacman.js';

// Un mensaje que empieza con /comando se pinta con chip destacado (Fase 8).
const CMD_RE = /^(\/[a-zA-Z0-9_:-]+)([\s\S]*)$/;

// REGLA DE SEGURIDAD (Fase 9 · 4): clasificador de comandos destructivos.
// Un permiso de Bash clasificado acá nace con el detalle EXPANDIDO — el atajo
// visual de la fila compacta es para lo rutinario, no para lo peligroso.
// El resumen del chip es SIEMPRE el inicio real del comando (viene así del
// server), nunca una paráfrasis.
const DESTRUCTIVE_PATTERNS = [
  /\bsudo\b/,
  /\brm\b[^\n|;&]*(\s-\w*[rf]\w*|\s--(force|recursive))/, // rm -r/-f en cualquier orden
  /\bchmod\b/, /\bchown\b/,
  /\bgit\s+push\b[^\n|;&]*(\s--force(-with-lease)?\b|\s-\w*f\w*\b|\s\+\S)/,
  /\bcurl\b/, /\bwget\b/, /\bnc\b/, // salida a red
  /\bdd\b/, /\bmkfs\w*\b/, /\btruncate\b/,
  /\bkill(all)?\b/, /\bpkill\b/,
  /\bshutdown\b/, /\breboot\b/, /\bsystemctl\b[^\n|;&]*\s(stop|disable|mask)\b/,
];
function isDestructiveCommand(cmd) {
  const c = String(cmd || '');
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(c));
}

// Ícono representativo por herramienta en la fila de permiso.
const TOOL_ICONS = { Bash: 'terminal', Edit: 'edit', Write: 'edit', Read: 'eye', WebFetch: 'download' };

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
    this.slashCommands = [];      // [{name, description|null}] del meta/attach
    this._metaSeen = false;       // ¿ya llegó el init de ESTA conversación?
    this._slashPop = null;        // popup de autocompletado abierto
    this._slashDismiss = null;    // teardown del dismissablePopup activo
    this._slashActive = 0;        // índice de la fila activa (↑↓)
    this._slashItems = [];        // filas visibles tras el filtro
    this._slashSuppressed = null; // texto con el que se cerró con Esc (no reabrir)
    // Señal REAL de "historial renderizado al 100%": se resuelve al terminar
    // de procesar el PRIMER evento `history` del attach (no un timer). La
    // espera el splash de arranque (main.js) antes de destapar la app.
    this.ready = new Promise((resolve) => { this._readyResolve = resolve; });

    container.classList.add('chat-pane-host');
    container.innerHTML = `
      <div class="chat-view">
        <header class="chat-head">
          <button class="btn-ghost btn--icon mobile-menu-btn chat-menu" title="Abrir panel lateral">${icon('menu', { size: 16 })}</button>
          <span class="chat-title">${this.title}</span>
          ${pacman({ working: false, cls: 'chat-alive', title: 'Esperando tu mensaje' })}
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
    this.aliveEl = container.querySelector('.chat-alive');

    // ☰ (solo visible en móvil): pide el panel lateral al shell. En móvil el
    // panel es overlay y su propio ☰ queda fuera de pantalla al ocultarse.
    container.querySelector('.chat-menu').addEventListener('click', () => {
      window.dispatchEvent(new Event('cwc:open-sidebar'));
    });
    this.sendBtn.addEventListener('click', () => this._submit());
    this.stopBtn.addEventListener('click', () => this._send({ type: 'interrupt' }));
    this.toggleBtn.addEventListener('click', () => this.onToggleMode?.());
    this.modeEl.addEventListener('change', () => this._send({ type: 'set_mode', mode: this.modeEl.value }));
    this.inputEl.addEventListener('keydown', (e) => {
      if (this._slashKeydown(e)) return; // el autocompletado consumió la tecla
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this._submit();
      }
    });
    // Esc cierra los detalles de tool calls expandidos (Fase 9 · 3). El Esc
    // del popup de comandos slash se maneja antes (captura en dismissablePopup).
    this.container.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      let closed = false;
      for (const chip of this.msgsEl.querySelectorAll('.chat-toolgroup .chat-toolchip.active')) {
        this._toolCollapse(chip.closest('.chat-toolgroup'));
        closed = true;
      }
      if (closed) e.stopPropagation();
    });
    // Autogrow del textarea (hasta ~6 líneas) + autocompletado de comandos.
    this.inputEl.addEventListener('input', () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 140)}px`;
      this._slashUpdate();
    });
  }

  // ===== Autocompletado de comandos slash (Fase 8) =====
  // Query activa: el input empieza con '/' y todavía no hay espacio (se está
  // tipeando el comando). null = el popup no corresponde.
  _slashQuery() {
    const v = this.inputEl.value;
    if (!v.startsWith('/')) { this._slashSuppressed = null; return null; }
    if (this._slashSuppressed === v) return null; // cerrado con Esc: no reabrir igual
    const token = v.slice(1);
    if (/\s/.test(token)) return null; // comando completo + argumentos
    return token.toLowerCase();
  }

  _slashUpdate() {
    const q = this._slashQuery();
    if (q == null) { this._slashClose(); return; }
    if (!this._slashPop) this._slashOpen();
    this._slashRender(q);
  }

  _slashOpen() {
    const pop = document.createElement('div');
    pop.className = 'chat-slash-pop';
    // Los taps en las filas no deben robar el foco del input (teclado abierto).
    pop.addEventListener('mousedown', (e) => e.preventDefault());
    this.container.querySelector('.chat-composer').appendChild(pop);
    this._slashPop = pop;
    this._slashDismiss = dismissablePopup(pop, {
      onDismiss: () => {
        // Cierre externo (Esc/tap afuera): no reabrir hasta que cambie el texto.
        if (this._slashPop === pop) {
          this._slashSuppressed = this.inputEl.value;
          this._slashPop = null;
          this._slashDismiss = null;
        }
        pop.remove();
      },
    });
    this._slashFit();
  }

  _slashClose() {
    if (!this._slashDismiss) return;
    const dismiss = this._slashDismiss;
    this._slashPop = null;
    this._slashDismiss = null;
    dismiss(); // el onDismiss ve _slashPop !== pop y no marca suppressed
  }

  // Que la lista nunca tape el header: alto máximo = espacio libre sobre el
  // composer (el #app ya sigue a visualViewport, así que esto respeta teclado).
  _slashFit() {
    if (!this._slashPop) return;
    const top = this.container.querySelector('.chat-composer').getBoundingClientRect().top;
    this._slashPop.style.maxHeight = `${Math.max(96, Math.min(320, top - 16))}px`;
  }

  _slashRender(q) {
    const pop = this._slashPop;
    if (!pop) return;
    const all = this.slashCommands;
    // Prefijo primero, subcadena después (sin duplicar).
    const pre = all.filter((c) => c.name.toLowerCase().startsWith(q));
    const sub = q ? all.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q)) : [];
    this._slashItems = [...pre, ...sub];
    this._slashActive = Math.min(this._slashActive, Math.max(0, this._slashItems.length - 1));
    pop.replaceChildren();
    if (!this._slashItems.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-slash-empty';
      empty.textContent = !all.length
        ? (this._metaSeen ? 'Esta conversación no expone comandos.' : 'Cargando comandos… (llegan con el primer mensaje)')
        : 'Sin coincidencias.';
      pop.appendChild(empty);
      return;
    }
    this._slashItems.forEach((c, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'chat-slash-item' + (i === this._slashActive ? ' active' : '');
      const name = document.createElement('span');
      name.className = 'csi-name';
      name.textContent = `/${c.name}`;
      row.appendChild(name);
      if (c.description) {
        const desc = document.createElement('span');
        desc.className = 'csi-desc';
        desc.textContent = c.description;
        row.appendChild(desc);
      }
      row.addEventListener('click', () => this._slashPick(c));
      pop.appendChild(row);
    });
    this._slashFit();
  }

  _slashPick(c) {
    this._slashClose();
    this._slashSuppressed = null;
    this.inputEl.value = `/${c.name} `;
    this.inputEl.focus();
    this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
  }

  // Teclas mientras el popup está abierto. Devuelve true si la consumió.
  // (Esc lo maneja dismissablePopup en captura; acá ni llega.)
  _slashKeydown(e) {
    if (!this._slashPop || !this._slashItems.length) return false;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const n = this._slashItems.length;
      this._slashActive = (this._slashActive + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      const rows = this._slashPop.querySelectorAll('.chat-slash-item');
      rows.forEach((r, i) => r.classList.toggle('active', i === this._slashActive));
      rows[this._slashActive]?.scrollIntoView({ block: 'nearest' });
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      this._slashPick(this._slashItems[this._slashActive]);
      return true;
    }
    return false;
  }

  // Botón "/" de la barra auxiliar (móvil): antepone la barra y abre el popup.
  insertSlash() {
    if (!this.inputEl.value.startsWith('/')) this.inputEl.value = `/${this.inputEl.value}`;
    this._slashSuppressed = null;
    this.inputEl.focus();
    this._slashUpdate();
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
    this._slashClose();
    this._slashSuppressed = null;
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
        // Puede venir de la caché por cwd del server (init aún pendiente).
        if (Array.isArray(m.slashCommands) && m.slashCommands.length) this.slashCommands = m.slashCommands;
        for (const ev of m.events) this._onEvent(ev);
        if (m.mode) this.modeEl.value = m.mode;
        this._setWorking(m.status === 'working');
        // Historial renderizado: destraba al splash de arranque (ver arriba).
        this._readyResolve?.();
        this._readyResolve = null;
        break;
      case 'meta':
        this.slashCommands = Array.isArray(m.slashCommands) ? m.slashCommands : [];
        this._metaSeen = true;
        if (this._slashPop) this._slashUpdate(); // refresco en vivo si está abierto
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
        if (m.resumable) {
          // El motor se durmió (inactividad); la conversación sigue viva:
          // el próximo mensaje la retoma. No se bloquea nada.
          this._line('chat-closed-note', 'Conversación dormida por inactividad — tu próximo mensaje la retoma.');
        } else {
          this._line('chat-closed-note', 'Conversación cerrada en el servidor.');
          this.inputEl.disabled = true;
          this.sendBtn.disabled = true;
        }
        break;
      default: break;
    }
  }

  _bubble(kind, text) {
    const el = document.createElement('div');
    el.className = `chat-msg chat-${kind}`;
    // Mensaje que empieza con /comando: chip destacado + resto normal (solo
    // presentación; el texto viajó intacto al SDK). Aplica también al replay.
    const cmd = kind === 'user' ? String(text).match(CMD_RE) : null;
    if (cmd) {
      const chip = document.createElement('span');
      chip.className = 'chat-cmd-chip';
      chip.textContent = cmd[1];
      el.appendChild(chip);
      if (cmd[2]) el.appendChild(document.createTextNode(cmd[2]));
    } else {
      el.textContent = text;
    }
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

  // ===== Tool calls: chips agrupados horizontalmente (Fase 9 · 3) =====
  // Tool calls consecutivos (sin texto/permiso/costo en el medio) comparten un
  // grupo: fila flex con wrap + UN detalle expandible de ancho completo debajo.
  // La condición "consecutivos" sale sola del DOM: si el último hijo de la
  // lista es un grupo, el chip nuevo se suma ahí; cualquier otro elemento
  // intermedio corta el grupo.
  _toolGroup() {
    const last = this.msgsEl.lastElementChild;
    if (last && last.classList.contains('chat-toolgroup')) return last;
    const g = document.createElement('div');
    g.className = 'chat-toolgroup';
    g.innerHTML = '<div class="ctg-row"></div><div class="ctg-detail" hidden></div>';
    this.msgsEl.appendChild(g);
    return g;
  }

  // Chip compacto: el resumen se trunca a ~40 caracteres (el detalle completo
  // vive en el bloque expandible; para Bash el resumen es el inicio REAL del
  // comando, nunca una paráfrasis). El detalle se construye PEREZOSO al abrir.
  _toolCard(m) {
    const group = this._toolGroup();
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chat-toolchip';
    if (m.id) chip.dataset.toolId = m.id;
    chip.innerHTML = `${icon('terminal', { size: 14 })}<span class="ct-name"></span>`;
    chip.querySelector('.ct-name').textContent = m.name;
    // Chip mínimo: icono + nombre. El resumen vive en el tooltip (desktop) y
    // completo en el detalle expandible.
    chip.title = String(m.summary || '');
    chip._detail = m.detail || null;         // datos crudos para el render perezoso
    chip._summary = String(m.summary || ''); // fallback del detalle (tools sin input propio)
    chip._output = null;                     // {ok, text} cuando llegue el tool_result
    chip.addEventListener('click', () => this._toolToggle(group, chip));
    group.querySelector('.ctg-row').appendChild(chip);
    this._scroll();
  }

  // Construye el cuerpo del detalle a demanda (lazy, Fase 7): diff para
  // Edit/Write, comando para Bash, y la salida si ya llegó.
  _toolDetailBody(chip) {
    const body = document.createElement('div');
    body.className = 'ct-body';
    const d = chip._detail;
    if (d && (d.old != null || d.new != null)) body.appendChild(renderDiff(d));
    else if (d?.command || chip._summary) {
      // Con el chip mínimo (solo icono+nombre), el resumen del server es la
      // única pista del input para tools sin detalle propio (Read, etc.).
      const pre = document.createElement('pre');
      pre.className = 'ct-cmd';
      pre.textContent = d?.command || chip._summary;
      body.appendChild(pre);
    }
    if (chip._output) {
      const pre = document.createElement('pre');
      pre.className = 'ct-out' + (chip._output.ok ? '' : ' err');
      pre.textContent = chip._output.text || '(sin salida)';
      body.appendChild(pre);
    }
    if (!body.childNodes.length) {
      const note = document.createElement('div');
      note.className = 'ctg-empty';
      note.textContent = '(sin detalle)';
      body.appendChild(note);
    }
    return body;
  }

  // Un solo chip expandido por grupo: tocar otro cambia el detalle; tocar el
  // activo (o Esc, ver constructor) lo cierra.
  _toolToggle(group, chip) {
    const det = group.querySelector('.ctg-detail');
    const active = group.querySelector('.chat-toolchip.active');
    if (active === chip) { this._toolCollapse(group); return; }
    active?.classList.remove('active');
    chip.classList.add('active');
    det.replaceChildren(this._toolDetailBody(chip));
    det.hidden = false;
    det.scrollIntoView({ block: 'nearest' });
  }

  _toolCollapse(group) {
    group.querySelector('.chat-toolchip.active')?.classList.remove('active');
    const det = group.querySelector('.ctg-detail');
    det.hidden = true;
    det.replaceChildren();
  }

  _toolResult(m) {
    if (!m.id) return;
    const chip = this.msgsEl.querySelector(`.chat-toolchip[data-tool-id="${CSS.escape(m.id)}"]`);
    if (!chip) return;
    chip._output = { ok: !!m.ok, text: m.output || '' };
    chip.classList.add(m.ok ? 'done' : 'fail');
    // Si justo está expandido, el detalle se refresca en vivo con la salida.
    if (chip.classList.contains('active')) {
      const det = chip.closest('.chat-toolgroup').querySelector('.ctg-detail');
      det.replaceChildren(this._toolDetailBody(chip));
    }
  }

  // Solicitud de permiso como fila compacta (Fase 9 · 4):
  // [icono] [tool] [resumen] [chevron] [✕ Denegar] [✓ Permitir].
  // El chevron abre el detalle íntegro (comando/diff) ANTES de decidir.
  _permCard(m) {
    const el = document.createElement('div');
    el.className = 'chat-perm';
    el.dataset.permId = m.id;
    // Datos crudos para el detalle perezoso y el chip de registro posterior.
    el._tool = m.tool;
    el._summary = String(m.summary || '');
    el._detail = m.detail || null;
    el.innerHTML = `
      <div class="chat-perm-row">
        ${icon(TOOL_ICONS[m.tool] || 'gear', { size: 15 })}
        <span class="cp-tool"></span>
        <span class="cp-sum"></span>
        <button class="btn-ghost btn--icon cp-chev" title="Ver detalle completo">${icon('chevronDown', { size: 14 })}</button>
        <button class="btn-ghost btn--sm cp-deny" data-allow="0">${icon('close', { size: 13 })} Denegar</button>
        <button class="btn btn--sm cp-allow" data-allow="1">${icon('check', { size: 13 })} Permitir</button>
      </div>
      <div class="chat-perm-detail" hidden></div>`;
    el.querySelector('.cp-tool').textContent = m.tool;
    // El resumen NUNCA parafrasea: es el texto del server (para Bash, el inicio
    // real del comando). El truncado es por CSS (ellipsis) desde el final.
    const sumEl = el.querySelector('.cp-sum');
    sumEl.textContent = el._summary;
    sumEl.title = el._summary;
    const detEl = el.querySelector('.chat-perm-detail');
    const toggle = (want = detEl.hidden) => {
      if (want && !detEl.childNodes.length) detEl.appendChild(this._permDetailBody(el));
      detEl.hidden = !want;
      el.classList.toggle('open', want);
    };
    el.querySelector('.cp-chev').addEventListener('click', () => toggle());
    for (const b of el.querySelectorAll('[data-allow]')) {
      b.addEventListener('click', () => {
        this._send({ type: 'permission_response', id: m.id, allow: b.dataset.allow === '1' });
      });
    }
    // Regla de seguridad: los comandos destructivos nacen EXPANDIDOS.
    if (m.tool === 'Bash' && isDestructiveCommand(m.detail?.command || m.summary)) toggle(true);
    this.msgsEl.appendChild(el);
    this._scroll();
  }

  // Detalle íntegro de un permiso: diff exacto para ediciones, comando completo
  // para Bash, resumen completo para el resto.
  _permDetailBody(el) {
    const body = document.createElement('div');
    body.className = 'ct-body';
    const d = el._detail;
    if (d && (d.old != null || d.new != null)) body.appendChild(renderDiff(d));
    else {
      const pre = document.createElement('pre');
      pre.className = 'ct-cmd';
      pre.textContent = d?.command || el._summary || '(sin detalle)';
      body.appendChild(pre);
    }
    return body;
  }

  // Al decidir, la tarjeta colapsa a un chip de registro con el veredicto que
  // se integra al grupo horizontal de tool calls (punto 3): al grupo anterior
  // si lo hay, o a uno nuevo en su lugar (el tool_use aprobado que llegue
  // después se suma solo al mismo grupo).
  _permClose(m) {
    const el = this.msgsEl.querySelector(`[data-perm-id="${m.id}"]`);
    if (!el) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chat-toolchip chat-permchip ${m.allow ? 'ok' : 'no'}`;
    chip.innerHTML = `${icon(m.allow ? 'check' : 'close', { size: 13 })}<span class="ct-name"></span>`;
    chip.querySelector('.ct-name').textContent = m.allow ? 'Permitido' : 'Denegado';
    chip.title = `${el._tool || ''} ${el._summary || ''}`.trim();
    chip._detail = el._detail || (el._summary ? { command: el._summary } : null);
    chip._summary = el._summary || '';
    chip._output = null;
    const prev = el.previousElementSibling;
    let group;
    if (prev && prev.classList.contains('chat-toolgroup')) {
      group = prev;
      el.remove();
    } else {
      group = document.createElement('div');
      group.className = 'chat-toolgroup';
      group.innerHTML = '<div class="ctg-row"></div><div class="ctg-detail" hidden></div>';
      el.replaceWith(group);
    }
    chip.addEventListener('click', () => this._toolToggle(group, chip));
    group.querySelector('.ctg-row').appendChild(chip);
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
    // Ícono "vivo" (móvil): pulsa mientras Claude trabaja, quieto ("dormido")
    // cuando espera tu mensaje — mismo lenguaje de color que sess-dot/rail-status.
    this.aliveEl.classList.toggle('is-working', on);
    this.aliveEl.title = on ? 'Trabajando…' : 'Esperando tu mensaje';
  }

  _scroll() {
    this.msgsEl.scrollTop = this.msgsEl.scrollHeight;
  }

  focus() {
    // Re-anclar SIEMPRE al final al activar la pestaña: mientras el panel está
    // oculto (display:none) scrollTop se pierde (scrollHeight=0), así que el
    // historial re-renderizado o los eventos llegados en background dejaban la
    // vista arriba de todo al volver a este chat. setActive() nos llama justo
    // DESPUÉS de mostrar el panel, con el layout ya medible.
    this._scroll();
    // En táctil no auto-enfocamos: abriría el teclado sin que lo pidas.
    if (!window.matchMedia('(pointer: coarse)').matches) this.inputEl.focus();
  }

  dispose() {
    this.closedByUser = true;
    this._slashClose();
    clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch { /* noop */ }
  }
}
