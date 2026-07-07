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
import { pacman, pacClass } from '../../ui/pacman.js';
import { openModal, confirmDialog, confirmSheet } from '../../ui/dialog.js';
import { fillCode, langForPath } from '../../ui/code.js';
import { modelColor, modelName, CHAT_MODEL_OPTIONS, ROUTER_MANAGED_MODELS } from '../../ui/models.js';

// Etiqueta de cada modelChoice (incluye "AutoTux" y "Opus plan" — fuente
// única en ui/models.js, la misma que usa el menú "Cambiar modelo").
const CHAT_MODEL_LABEL = new Map(CHAT_MODEL_OPTIONS);

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
export function isDestructiveCommand(cmd) {
  const c = String(cmd || '');
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(c));
}

// Ícono del TIPO de herramienta: es el SEGUNDO ícono del chip de ejecución
// (el primero es siempre la consola = "Claude usó una herramienta"). El chip
// ya no lleva texto (era innecesariamente largo); la leyenda de estos íconos
// vive en el modal del "?" del header (_modeHelp) y el nombre completo queda
// en el tooltip del chip.
const TOOL_TYPE_ICONS = [
  [/^Bash/i, 'play'],
  [/^(Edit|Write|NotebookEdit|MultiEdit)/i, 'edit'],
  [/^Read/i, 'eye'],
  [/^(Grep|Glob)/i, 'search'],
  [/^Web/i, 'download'],
  [/^Todo/i, 'list'],
  [/^(Task|Agent)/i, 'sparkle'],
  [/^AskUserQuestion/i, 'help'],
];
export const toolTypeIcon = (name) => (TOOL_TYPE_ICONS.find(([re]) => re.test(String(name || ''))) || [null, 'gear'])[1];

// Cuerpo interactivo de un AskUserQuestion (preguntas + opciones + acciones).
// COMPARTIDO por la tarjeta inline del chat (_askQuestionCard) y el centro global
// de permisos (perm-center) para no duplicar el render. `questions` es el
// detail.askQuestions normalizado por el server (shared.js/toolDetail): cada
// pregunta { question, header, multiSelect, options:[{label, description}] }.
// onSubmit(answers) recibe el mapa { textoPregunta: label(s) } (multiSelect =
// labels con coma, contrato del SDK); onCancel() deniega/cancela la pregunta.
export function buildAskQuestionBody(questions, { onSubmit, onCancel }) {
  const wrap = document.createElement('div');
  wrap.className = 'askq-body';
  const qs = Array.isArray(questions) ? questions : [];
  const state = qs.map(() => ({ chosen: new Set(), other: '' }));

  qs.forEach((q, qi) => {
    const qEl = document.createElement('div');
    qEl.className = 'askq-q';

    const qhead = document.createElement('div');
    qhead.className = 'askq-qhead';
    if (q.header) {
      const chip = document.createElement('span');
      chip.className = 'askq-chip';
      chip.textContent = q.header;
      qhead.appendChild(chip);
    }
    const qtext = document.createElement('span');
    qtext.className = 'askq-qtext';
    qtext.textContent = q.question || '';
    qhead.appendChild(qtext);
    qEl.appendChild(qhead);

    const opts = document.createElement('div');
    opts.className = 'askq-opts';
    qEl.appendChild(opts);

    // Texto libre = la opción "Other" que el SDK ofrece siempre.
    const otherInput = document.createElement('input');
    otherInput.type = 'text';
    otherInput.className = 'askq-other';
    otherInput.placeholder = 'Otra respuesta…';

    (Array.isArray(q.options) ? q.options : []).forEach((o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'askq-opt';
      const lab = document.createElement('span');
      lab.className = 'askq-opt-label';
      lab.textContent = o.label || '';
      b.appendChild(lab);
      if (o.description) {
        const desc = document.createElement('span');
        desc.className = 'askq-opt-desc';
        desc.textContent = o.description;
        b.appendChild(desc);
      }
      b.addEventListener('click', () => {
        const st = state[qi];
        if (q.multiSelect) {
          if (st.chosen.has(o.label)) st.chosen.delete(o.label);
          else st.chosen.add(o.label);
          b.classList.toggle('sel', st.chosen.has(o.label));
        } else {
          st.chosen.clear();
          st.chosen.add(o.label);
          for (const sib of opts.querySelectorAll('.askq-opt')) sib.classList.remove('sel');
          b.classList.add('sel');
          st.other = '';
          otherInput.value = '';
        }
        refresh();
      });
      opts.appendChild(b);
    });

    otherInput.addEventListener('input', () => {
      const st = state[qi];
      st.other = otherInput.value.trim();
      // En single-select, escribir texto libre desmarca las opciones.
      if (st.other && !q.multiSelect) {
        st.chosen.clear();
        for (const sib of opts.querySelectorAll('.askq-opt')) sib.classList.remove('sel');
      }
      refresh();
    });
    qEl.appendChild(otherInput);

    wrap.appendChild(qEl);
  });

  const actions = document.createElement('div');
  actions.className = 'askq-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn-ghost btn--sm askq-cancel';
  cancel.innerHTML = `${icon('close', { size: 13 })} Cancelar`;
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn btn--sm askq-submit';
  actions.appendChild(cancel);
  actions.appendChild(submit);
  wrap.appendChild(actions);

  const answered = () => state.filter((st) => st.chosen.size || st.other).length;
  const refresh = () => {
    const done = answered();
    submit.disabled = done < qs.length;
    submit.innerHTML = `${icon('check', { size: 13 })} Enviar${qs.length > 1 ? ` (${done}/${qs.length})` : ''}`;
  };
  const buildAnswers = () => {
    const answers = {};
    qs.forEach((q, qi) => {
      const st = state[qi];
      const parts = [...st.chosen];
      if (st.other) parts.push(st.other);
      if (parts.length && q.question) answers[q.question] = parts.join(', ');
    });
    return answers;
  };

  cancel.addEventListener('click', () => onCancel?.());
  submit.addEventListener('click', () => {
    if (submit.disabled) return;
    onSubmit?.(buildAnswers());
  });
  refresh();
  return wrap;
}

// [valor SDK, etiqueta de UNA palabra, riesgo]. Etiquetas cortas a propósito:
// el select colapsado queda mínimo; el "?" de al lado explica cada modo. El
// riesgo pinta el color del select (ver .chat-mode[data-risk] en style.css):
// safe=plan (no toca nada) · ok=pregunta todo · warn=edita solo · danger=
// bypassPermissions del SDK (acepta ABSOLUTAMENTE todo, con confirm previo).
const MODES = [
  ['default', 'Preguntar', 'ok'],
  ['acceptEdits', 'Ediciones', 'warn'],
  ['bypassPermissions', 'Todo', 'danger'],
  ['plan', 'Plan', 'safe'],
];
const riskOf = (mode) => (MODES.find(([v]) => v === mode) || [])[2] || 'ok';

export class ChatTab {
  constructor({ id, title, container, onToggleMode, onViewMode, initialPrompt = null }) {
    this.id = id;
    this.title = title || 'chat';
    this.container = container;
    // Pasar a TUI ya no tiene botón en el header (se quitó junto con el costo):
    // el camino es el menú ⋯ de la tarjeta en Sesiones. El callback queda por
    // compatibilidad con el shell (main.js lo sigue pasando).
    this.onToggleMode = onToggleMode;
    this.onViewMode = onViewMode;     // el server anunció un cambio de modo
    this.initialPrompt = initialPrompt; // primer mensaje a enviar al conectar
    this._sentInitial = false;
    this.ws = null;
    this.reconnectTimer = null;
    this.closedByUser = false;
    this._pendingMode = null; // modo elegido por el usuario, aún sin confirmar por el eco del server
    this.streamEl = null;   // burbuja del asistente en streaming
    this.slashCommands = [];      // [{name, description|null}] del meta/attach
    this._metaSeen = false;       // ¿ya llegó el init de ESTA conversación?
    this._slashPop = null;        // popup de autocompletado abierto
    this._slashDismiss = null;    // teardown del dismissablePopup activo
    this._slashActive = 0;        // índice de la fila activa (↑↓)
    this._slashItems = [];        // filas visibles tras el filtro
    this._slashSuppressed = null; // texto con el que se cerró con Esc (no reabrir)
    this._working = false;        // motor Pac-Man del header (ver _renderPacState)
    this._delegatingCount = 0;    // subagentes Task/Agent pendientes del turno actual
    this._model = null;           // modelo REAL en curso (haiku/sonnet/opus/fable/opusplan/...)
    this._modelChoice = null;     // QUÉ ELIGIÓ la persona: 'auto' (AutoTux) u otro fijo — ver _applyModel/_applyModelChoice
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
          ${pacman({ state: 'waiting', cls: 'chat-alive', title: 'Esperando tu mensaje' })}
          <span class="chat-model-pill" title="Router de modelo automático" hidden></span>
          <select class="chat-mode" data-risk="ok" title="Modo de permisos">
            ${MODES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
          </select>
          <button class="btn-ghost btn--icon chat-mode-help" title="Ayuda: modos de permisos e íconos de acciones">${icon('help', { size: 15 })}</button>
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
    this.aliveEl = container.querySelector('.chat-alive');
    this.modelPillEl = container.querySelector('.chat-model-pill');

    // ☰ (solo visible en móvil): pide el panel lateral al shell. En móvil el
    // panel es overlay y su propio ☰ queda fuera de pantalla al ocultarse.
    container.querySelector('.chat-menu').addEventListener('click', () => {
      window.dispatchEvent(new Event('cwc:open-sidebar'));
    });
    this.sendBtn.addEventListener('click', () => this._submit());
    // Confirmación antes de detener (pedido del usuario 2026-07-07): ventana en
    // escritorio, "menú de deslizamiento" (bottom sheet) en móvil. Cancelar
    // aborta la operación; Parar envía el interrupt.
    this.stopBtn.addEventListener('click', async () => {
      const ok = await confirmSheet({
        title: 'Detener respuesta',
        message: '¿Parar la respuesta en curso? Se interrumpe lo que Claude está generando.',
        confirmLabel: 'Parar', cancelLabel: 'Cancelar', danger: true,
      });
      if (ok) this._send({ type: 'interrupt' });
    });
    this.modeEl.addEventListener('change', () => this._modeChanged());
    container.querySelector('.chat-mode-help').addEventListener('click', () => this._modeHelp());
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
    this._slashActive = 0; // el popup nace resaltando la mejor coincidencia
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
    // La lista se REORDENA por relevancia en cada tecla (prefijo antes que
    // subcadena): el resaltado tiene que volver SIEMPRE a la mejor coincidencia
    // (índice 0). Antes solo se clampeaba, así que el índice heredado apuntaba a
    // otra fila tras el reordenamiento → Enter insertaba un comando distinto.
    this._slashActive = 0;
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
        // Puede venir de la caché por cwd del server (init aún pendiente).
        if (Array.isArray(m.slashCommands) && m.slashCommands.length) this.slashCommands = m.slashCommands;
        for (const ev of m.events) this._onEvent(ev);
        // Si el usuario eligió un modo que el server TODAVÍA no confirmó, no lo
        // pisamos con el modo (posiblemente viejo) del history: reafirmamos el
        // elegido y lo REENVIAMOS (reconciliación tras reconexión / set_mode
        // perdido si la ws no estaba abierta). Si ya coincide o no hay pendiente,
        // aplicamos el del server y limpiamos el pendiente.
        if (this._pendingMode && this._pendingMode !== m.mode) {
          this._applyMode(this._pendingMode);
          this._send({ type: 'set_mode', mode: this._pendingMode });
        } else {
          if (m.mode) this._applyMode(m.mode);
          this._pendingMode = null;
        }
        this._setWorking(m.status === 'working');
        this._modelChoice = m.modelChoice || null; // sin notita: solo poblar el estado al abrir/reconectar
        this._applyModel(m.model); // sin auto: solo poblar el badge al abrir/reconectar
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
      // Los permission_* además se anuncian GLOBALMENTE (window): el centro de
      // permisos (ui/perm-center.js) muestra el popup al instante si esta
      // pestaña NO es la activa, y lo retira al resolverse. El replay de
      // history también pasa por acá y es correcto: un request aún pendiente
      // debe popupear, y su closed posterior (mismo replay) lo retira.
      case 'permission_request':
        this._permCard(m);
        window.dispatchEvent(new CustomEvent('cwc:perm-request', { detail: { chatId: this.id, perm: m } }));
        break;
      case 'permission_closed':
        this._permClose(m);
        window.dispatchEvent(new CustomEvent('cwc:perm-closed', { detail: { chatId: this.id, permId: m.id } }));
        break;
      case 'result': this._result(m); break;
      case 'status': this._setWorking(m.state === 'working'); break;
      case 'model': this._applyModel(m.model, { auto: !!m.auto }); break;
      case 'modelChoice': this._applyModelChoice(m.modelChoice); break;
      case 'mode':
        // Reconciliación con el modo REAL del motor (paso 2, fin del drift): el
        // select SIEMPRE refleja lo que el motor aplica de verdad. Si el usuario
        // pidió un modo y el motor reporta OTRO, el cambio NO tomó: avisamos
        // claro y no dejamos el select mintiendo un modo que no está vigente.
        if (this._pendingMode && m.mode !== this._pendingMode) {
          const want = (MODES.find(([v]) => v === this._pendingMode) || [, this._pendingMode])[1];
          const real = (MODES.find(([v]) => v === m.mode) || [, m.mode])[1];
          this._line('chat-error', `No se pudo activar el modo “${want}”: sigue en “${real}”. Si esta conversación viene de antes, cerrala y reabrila para aplicar el cambio.`);
          this._pendingMode = null;
        } else if (m.mode === this._pendingMode) {
          this._pendingMode = null; // confirmado por el motor
        }
        this._applyMode(m.mode);
        break;
      case 'viewmode':
        if (m.viewMode === 'switching') {
          this._line('chat-switch-note', 'Cambiando a Terminal (TUI)…');
        } else if (m.error) {
          this._line('chat-error', m.error);
        }
        // El shell reconstruye la vista si el modo efectivo cambió.
        this.onViewMode?.(m);
        break;
      case 'error': this._line('chat-error', `Error: ${m.message}`); break;
      case 'reopened':
        // Se mató el runner viejo y arrancó uno fresco sobre la misma sesión
        // (opción "Reabrir para cambios" del menú ⋯): ya toma el código nuevo.
        this._line('chat-closed-note', 'Motor reabierto — arrancó un proceso fresco que toma los cambios de código nuevos. El contexto se conserva.');
        break;
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
    // Chip SOLO íconos: consola (= herramienta ejecutada) + tipo (leyenda en
    // el "?" del header). Nombre y resumen quedan en el tooltip y el detalle.
    chip.innerHTML = `${icon('terminal', { size: 14 })}${icon(toolTypeIcon(m.name), { size: 13, className: 'ct-type' })}`;
    chip.title = `${m.name}${m.summary ? ` — ${m.summary}` : ''}`;
    chip._detail = m.detail || null;         // datos crudos para el render perezoso
    chip._summary = String(m.summary || ''); // fallback del detalle (tools sin input propio)
    chip._output = null;                     // {ok, text} cuando llegue el tool_result
    // Motor Pac-Man: un Task/Agent abre la espera de un subagente — mismo
    // matcher que TOOL_TYPE_ICONS/toolTypeIcon, acá para pintar 'delegating'
    // en el header mientras el subagente no vuelva con su tool_result.
    chip._isDelegate = /^(Task|Agent)/i.test(m.name || '');
    if (chip._isDelegate) { this._delegatingCount++; this._renderPacState(); }
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
      // Con el chip mínimo (solo íconos), el resumen del server es la única
      // pista del input para tools sin detalle propio (Read, etc.).
      // Comandos Bash: resaltados como en un editor (ui/code.js).
      const pre = document.createElement('pre');
      pre.className = 'ct-cmd';
      fillCode(pre, d?.command || chip._summary, d?.command ? 'bash' : null);
      body.appendChild(pre);
    }
    if (chip._output) {
      const pre = document.createElement('pre');
      pre.className = 'ct-out' + (chip._output.ok ? '' : ' err');
      if (chip._output.text) {
        // Salida con sintaxis SOLO si la extensión del archivo es confiable
        // (Read/Write de un .js, .css, etc.); logs/errores quedan planos.
        fillCode(pre, chip._output.text, chip._output.ok ? langForPath(chip._summary) : null);
      } else {
        pre.textContent = '(sin salida)';
      }
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
    if (chip._isDelegate && !chip._delegateDone) {
      chip._delegateDone = true; // guarda: un tool_result por id, nunca decrementar dos veces
      this._delegatingCount = Math.max(0, this._delegatingCount - 1);
      this._renderPacState();
    }
    chip._output = { ok: !!m.ok, text: m.output || '' };
    chip.classList.add(m.ok ? 'done' : 'fail');
    // Si justo está expandido, el detalle se refresca en vivo con la salida.
    if (chip.classList.contains('active')) {
      const det = chip.closest('.chat-toolgroup').querySelector('.ctg-detail');
      det.replaceChildren(this._toolDetailBody(chip));
    }
  }

  // Solicitud de permiso COMPACTA (rediseño a pedido: el nombre de la función
  // era flex:none y con nombres largos —p.ej. tools MCP— empujaba los botones
  // fuera de la pantalla en móvil): un chip IDÉNTICO al de tool calls (consola
  // + tipo, sin texto) con chevron, y lo único que sobresale son [✕ Denegar]
  // [✓ Permitir]. Tocar el chip expande el detalle íntegro (función completa +
  // comando/diff) ANTES de decidir; en desktop el tooltip ya adelanta todo.
  _permCard(m) {
    // AskUserQuestion NO es un permiso permitir/denegar: es una PREGUNTA con
    // opciones. Se renderiza distinto (elegir opción => responde al SDK).
    if (m.tool === 'AskUserQuestion' && m.detail?.askQuestions?.length) {
      this._askQuestionCard(m);
      return;
    }
    const el = document.createElement('div');
    el.className = 'chat-perm';
    el.dataset.permId = m.id;
    // Datos crudos para el detalle perezoso y el chip de registro posterior.
    el._tool = m.tool;
    el._summary = String(m.summary || '');
    el._detail = m.detail || null;
    el.innerHTML = `
      <div class="chat-perm-row">
        <button type="button" class="chat-toolchip cp-chip">
          ${icon('terminal', { size: 14 })}${icon(toolTypeIcon(m.tool), { size: 13, className: 'ct-type' })}${icon('chevronDown', { size: 12, className: 'cp-chev' })}
        </button>
        <button class="btn-ghost btn--sm cp-deny" data-allow="0">${icon('close', { size: 13 })} Denegar</button>
        <button class="btn btn--sm cp-allow" data-allow="1">${icon('check', { size: 13 })} Permitir</button>
      </div>
      <div class="chat-perm-detail" hidden></div>`;
    // El tooltip NUNCA parafrasea: tool + inicio real del comando (server).
    const chipEl = el.querySelector('.cp-chip');
    chipEl.title = `${m.tool}${el._summary ? ` — ${el._summary}` : ''}`;
    const detEl = el.querySelector('.chat-perm-detail');
    const toggle = (want = detEl.hidden) => {
      if (want && !detEl.childNodes.length) detEl.appendChild(this._permDetailBody(el));
      detEl.hidden = !want;
      el.classList.toggle('open', want);
    };
    chipEl.addEventListener('click', () => toggle());
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

  // Tarjeta de AskUserQuestion: pregunta(s) con opciones seleccionables. Elegir
  // y Enviar responde al SDK (permission_response con answers); Cancelar deniega.
  // Mantiene _tool/_summary/_detail y data-perm-id para que _permClose la colapse
  // a un chip de registro igual que cualquier permiso.
  _askQuestionCard(m) {
    const el = document.createElement('div');
    el.className = 'chat-perm chat-askq';
    el.dataset.permId = m.id;
    el._tool = m.tool;
    el._summary = String(m.summary || '');
    el._detail = m.detail || null;

    const head = document.createElement('div');
    head.className = 'askq-head';
    head.innerHTML = icon('help', { size: 14 });
    const label = document.createElement('span');
    label.textContent = 'Pregunta del asistente';
    head.appendChild(label);
    el.appendChild(head);

    el.appendChild(buildAskQuestionBody(m.detail.askQuestions, {
      onSubmit: (answers) => this._send({ type: 'permission_response', id: m.id, allow: true, answers }),
      onCancel: () => this._send({ type: 'permission_response', id: m.id, allow: false }),
    }));

    this.msgsEl.appendChild(el);
    this._scroll();
  }

  // Detalle íntegro de un permiso: nombre COMPLETO de la función (con el chip
  // sin texto es la única forma de verlo en móvil; wrappea, nunca desborda) +
  // diff exacto para ediciones o comando completo para Bash/resto.
  _permDetailBody(el) {
    const body = document.createElement('div');
    body.className = 'ct-body';
    const name = document.createElement('div');
    name.className = 'cp-detail-tool';
    name.textContent = el._tool || '';
    body.appendChild(name);
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

  // El usuario eligió un modo en el select. "Todo" (bypassPermissions del SDK)
  // acepta ABSOLUTAMENTE todo sin preguntar: confirm previo para que un tap
  // accidental (sobre todo en móvil) no lo active.
  async _modeChanged() {
    const mode = this.modeEl.value;
    if (mode === 'bypassPermissions') {
      const ok = await confirmDialog({
        title: 'Aceptar todo',
        message: 'En este modo Claude ejecuta TODA acción (comandos, ediciones, red…) sin pedir permiso, hasta que lo cambies. Es el modo más riesgoso: usalo solo si confiás plenamente en la tarea.',
        confirmLabel: 'Aceptar todo',
        danger: true,
      });
      if (!ok) { this._applyMode(this._mode || 'default'); return; }
    }
    this._pendingMode = mode; // deseo del usuario hasta que el server lo confirme por eco
    this._applyMode(mode); // optimista; el eco 'mode' del server confirma
    this._send({ type: 'set_mode', mode });
  }

  // Única puerta de entrada del modo a la UI (usuario, history y eco del
  // server): sincroniza valor + color de riesgo del select (data-risk).
  _applyMode(mode) {
    this._mode = mode;
    this.modeEl.value = mode;
    this.modeEl.dataset.risk = riskOf(mode);
  }

  // Puerta de entrada del MODELO REAL a la UI (AutoTux, core/model-router.js):
  // actualiza el badge del header y, si el cambio lo decidió el router
  // (`auto:true` — nunca un cambio manual del selector de Sesiones), agrega
  // una notita inline para que quede claro que nadie lo tocó a mano.
  _applyModel(model, { auto = false } = {}) {
    const prev = this._model;
    this._model = model || null;
    this._renderModelBadge();
    if (auto && prev && this._modelChoice === 'auto' && prev !== model) {
      this._line('chat-switch-note', `🤖 AutoTux cambió el modelo a ${modelName(model)} sin que hagas nada.`);
    }
  }

  // Puerta de entrada de la ELECCIÓN a la UI: 'auto' (AutoTux, el router
  // queda al mando) u otro valor fijo (Fable/Opus/Sonnet/Haiku/opusplan/
  // default — la conversación queda FORZADA a ese único modelo). Separado de
  // _applyModel porque el backend los manda como eventos distintos
  // (`modelChoice` cambia mucho menos seguido que `model`).
  _applyModelChoice(modelChoice) {
    this._modelChoice = modelChoice || null;
    this._renderModelBadge();
  }

  // Único punto que pinta el badge, a partir de _model (real) + _modelChoice
  // (elegido). Con AutoTux ('auto') el badge SIEMPRE dice "AutoTux" primero
  // — el nivel real (color + nombre de ui/models.js) va después de los dos
  // puntos, y cambia solo, sin que el badge deje de anunciar el router.
  // Forzado a un modelo fijo: badge plano con ese nombre, sin 🤖. Sin
  // elección (chats viejos/adoptados de TUI): oculto, como siempre.
  _renderModelBadge() {
    const choice = this._modelChoice;
    const model = this._model;
    if (choice === 'auto') {
      this.modelPillEl.hidden = false;
      const level = ROUTER_MANAGED_MODELS.includes(model) ? modelName(model) : '…';
      this.modelPillEl.textContent = `🤖 AutoTux: ${level}`;
      this.modelPillEl.style.color = modelColor(ROUTER_MANAGED_MODELS.includes(model) ? model : 'unknown');
      this.modelPillEl.style.borderColor = this.modelPillEl.style.color;
      this.modelPillEl.title = `AutoTux (router de modelo automático) — nivel actual: ${level}`;
    } else if (choice) {
      this.modelPillEl.hidden = false;
      this.modelPillEl.textContent = CHAT_MODEL_LABEL.get(choice) || choice;
      const color = modelColor(ROUTER_MANAGED_MODELS.includes(choice) ? choice : 'unknown');
      this.modelPillEl.style.color = color;
      this.modelPillEl.style.borderColor = color;
      this.modelPillEl.title = `Modelo forzado — esta conversación solo usa ${CHAT_MODEL_LABEL.get(choice) || choice}`;
    } else {
      this.modelPillEl.hidden = true;
    }
  }

  // ¿Qué significan los modos de permisos? Modal explicativo del "?" del header.
  // Ayuda del chat: modos de permisos + nomenclatura de los chips de
  // herramientas (los chips son SOLO íconos; esta es su leyenda).
  _modeHelp() {
    const leg = (ic, name, desc) => `
      <div class="mh-leg">
        <span class="mh-leg-icons">${icon('terminal', { size: 13 })}${icon(ic, { size: 12 })}</span>
        <b>${name}</b><span>${desc}</span>
      </div>`;
    // Leyenda del motor Pac-Man (ver ui/pacman.js): un swatch real de cada
    // estado (mismo componente que el header/las tarjetas de Sesiones) para
    // reconocer de un vistazo qué está haciendo la conversación.
    const pacLeg = (state, name, desc) => `
      <div class="mh-leg">
        <span class="mh-leg-icons">${pacman({ state, size: 'sm', title: name })}</span>
        <b>${name}</b><span>${desc}</span>
      </div>`;
    const m = openModal({ title: 'Ayuda del chat', width: 480 });
    m.body.innerHTML = `
      <div class="mode-help">
        <div class="mh-sec">Modos de permisos</div>
        <div class="mh-item">
          <b>Preguntar</b>
          <p>El modo estándar. Claude pide permiso antes de CADA acción que toque
          tu sistema (editar archivos, correr comandos): aparece una tarjeta y
          vos aprobás o denegás una por una.</p>
        </div>
        <div class="mh-item">
          <b>Ediciones</b>
          <p>Claude puede editar y crear archivos sin preguntar; todo lo demás
          (comandos de terminal, red, etc.) sigue pidiendo permiso. Cómodo
          cuando ya confiás en el rumbo del trabajo.</p>
        </div>
        <div class="mh-item">
          <b class="mh-danger">Todo</b>
          <p>Aceptación avanzada: Claude ejecuta ABSOLUTAMENTE todo sin pedir
          permiso — comandos, ediciones, red. Es el modo más riesgoso (por eso
          pide confirmación al activarlo); usalo solo cuando confiás plenamente
          en la tarea y quieras cero fricción.</p>
        </div>
        <div class="mh-item">
          <b>Plan</b>
          <p>Claude no toca nada: solo lee el proyecto y arma un plan de
          trabajo. Ideal para explorar una idea o ver qué haría antes de
          soltarle la mano.</p>
        </div>
        <p class="mh-foot">Podés cambiar de modo en cualquier momento; aplica
        desde la próxima acción. El color del selector marca el riesgo:
        verde = controlado · amarillo = medio · rojo = acepta todo.</p>

        <div class="mh-sec">Íconos de acciones</div>
        <p class="mh-intro">Cada acción de Claude aparece en el hilo como un
        chip de dos íconos: la consola (ejecutó una herramienta) + el tipo.
        Tocá el chip para ver el detalle completo; el borde marca el
        resultado (verde ok · rojo error).</p>
        <div class="mh-legend">
          ${leg('play', 'Bash', 'corre un comando')}
          ${leg('edit', 'Edit / Write', 'edita o crea archivos')}
          ${leg('eye', 'Read', 'lee archivos')}
          ${leg('search', 'Grep / Glob', 'busca en el proyecto')}
          ${leg('download', 'Web', 'consulta la web')}
          ${leg('list', 'Todo', 'lista de tareas del agente')}
          ${leg('sparkle', 'Task', 'lanza un subagente')}
          ${leg('gear', 'Otras', 'cualquier otra herramienta')}
        </div>

        <div class="mh-sec">Estados del Pac-Man</div>
        <p class="mh-intro">El mismo Pac-Man aparece acá arriba y en las
        tarjetas de Sesiones — el color Y el movimiento te dicen qué está
        haciendo la conversación en cada momento:</p>
        <div class="mh-legend">
          ${pacLeg('working', 'Trabajando', 'dorado, mordisco rápido: un turno corriendo ahora')}
          ${pacLeg('delegating', 'Delegando', 'violeta con el ícono del interfono: esperando que vuelva un subagente (Task) u otro proceso')}
          ${pacLeg('queued', 'En cola', 'ámbar que respira: esperando su turno detrás de otro paso')}
          ${pacLeg('waiting', 'Tu turno', 'verde, parpadeo lento: esperando tu mensaje o tu decisión')}
          ${pacLeg('stale', 'Sin señales', 'ámbar apagado y quieto: se perdió el rastro, no se sabe si sigue activo')}
          ${pacLeg('error', 'Falló', 'rojo y quieto: se detuvo por un error')}
          ${pacLeg('dormant', 'Dormido', 'gris y quieto: nada activo ni delegado — el único estado sin animación')}
        </div>
      </div>`;
  }

  _result(m) {
    this._closeStream();
    if (m.costUsd != null) {
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
    this._working = on;
    // Un turno nuevo (u "off") arranca sin subagentes delegados pendientes:
    // evita que un tool_result perdido de un turno anterior deje el header
    // pegado en "delegando" para siempre.
    if (!on) this._delegatingCount = 0;
    this._renderPacState();
  }

  // Motor Pac-Man del header (ver ui/pacman.js): 'working' (dorado) mientras
  // el turno corre, 'delegating' (violeta + badge del interfono) si hay un
  // subagente Task/Agent corriendo dentro del turno, 'waiting' (verde,
  // parpadeo) esperando tu mensaje. Ícono "vivo" (móvil): mismo lenguaje de
  // color que sess-pac/rail-status.
  _renderPacState() {
    const state = !this._working ? 'waiting' : (this._delegatingCount > 0 ? 'delegating' : 'working');
    this.container.querySelector('.chat-view').classList.toggle('working', this._working);
    this.aliveEl.className = pacClass(state, { cls: 'chat-alive' });
    this.aliveEl.title = state === 'delegating' ? 'Delegando a un subagente…'
      : state === 'working' ? 'Trabajando…' : 'Esperando tu mensaje';
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
