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
import { modelColor, modelName, tierName, CHAT_MODEL_OPTIONS, ROUTER_MANAGED_MODELS, effortLabel } from '../../ui/models.js';
import { resolvePlace } from '../../ui/places.js';
import { flowBarHtml, ensureFlowDirector } from '../../ui/token-flow.js';
import { t } from '../../ui/i18n.js';
import { helpBtn } from '../../ui/help.js';

// Etiqueta de cada modelChoice (incluye "AutoTux" y "Opus plan" — fuente
// única en ui/models.js, la misma que usa el menú "Cambiar modelo").
const CHAT_MODEL_LABEL = new Map(CHAT_MODEL_OPTIONS);

// Un mensaje que empieza con /comando se pinta con chip destacado (Fase 8).
const CMD_RE = /^(\/[a-zA-Z0-9_:-]+)([\s\S]*)$/;

// Adjuntos del composer: límites (espejo del backend chat/attachments.js —
// los reales los valida el server; acá son solo para el aviso temprano).
const MAX_ATTACHMENTS = 8;
// Clasificación local para el chip optimista de la bandeja (mientras sube).
// El tipo DEFINITIVO lo devuelve el server (classifyAttachment); esto es la
// aproximación por mime/extensión para la miniatura instantánea.
const IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const TEXT_EXT_LOCAL = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'cs', 'php', 'sh', 'sql', 'html', 'css', 'scss', 'log', 'ini', 'toml', 'yml'];
function classifyLocal(file) {
  const mime = (file.type || '').toLowerCase();
  const ext = (file.name || '').split('.').pop().toLowerCase();
  if (mime.startsWith('image/') || IMG_EXT.includes(ext)) return 'image';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime.startsWith('text/') || mime === 'application/json' || TEXT_EXT_LOCAL.includes(ext)) return 'text';
  return 'binary';
}
const ATT_KIND_LABEL = { image: 'imagen', pdf: 'PDF', text: 'archivo', binary: 'archivo' };
const ATT_KIND_I18N = { image: ['chat.att.image', 'imagen'], pdf: ['chat.att.pdf', 'PDF'], text: ['chat.att.file', 'archivo'], binary: ['chat.att.file', 'archivo'] };

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
// vive en el tema unificado de ayuda del chat y el nombre completo queda
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
    otherInput.placeholder = t('chat.askq.otherPlaceholder', 'Otra respuesta…');

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
  cancel.innerHTML = `${icon('close', { size: 13 })} ${t('chat.common.cancel', 'Cancelar')}`;
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
    submit.innerHTML = `${icon('check', { size: 13 })} ${t('chat.common.send', 'Enviar')}${qs.length > 1 ? ` (${done}/${qs.length})` : ''}`;
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
  ['default', 'Preguntar', 'ok', 'chat.mode.ask'],
  ['acceptEdits', 'Ediciones', 'warn', 'chat.mode.edits'],
  ['bypassPermissions', 'Todo', 'danger', 'chat.mode.all'],
  ['plan', 'Plan', 'safe', 'chat.mode.plan'],
];
const riskOf = (mode) => (MODES.find(([v]) => v === mode) || [])[2] || 'ok';
const modeLabel = (mode) => { const e = MODES.find(([v]) => v === mode); return e ? t(e[3], e[1]) : mode; };

export function peerToneFor(username) {
  let hash = 0;
  for (const ch of String(username || '')) hash = ((hash * 31) + ch.codePointAt(0)) >>> 0;
  return `peer-${(hash % 6) + 1}`;
}

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
    this._tandemActive = true;    // retrocompat: runners viejos no reportan tandemActive
    this._engineDormant = false;  // motor dormido: el badge de modelo NO debe alarmar (eso lo dice el Pac-Man)
    this.isSala = null;           // null hasta que llegue el primer history
    this.participants = [];
    this.me = null;
    this._salaSayCount = 0;
    this._cutPending = false;
    this._lastTypingSent = 0;
    this._typingTimers = new Map();
    // Adjuntos pendientes de ESTE mensaje (subidos a disco, aún sin enviar).
    // Cada uno: {name|null, type, mime, size, uploading, error?, localUrl?, origName}.
    // Se limpian al enviar. Ver _uploadFiles/_renderTray/_submit.
    this.pending = [];
    // Señal REAL de "historial renderizado al 100%": se resuelve al terminar
    // de procesar el PRIMER evento `history` del attach (no un timer). La
    // espera el splash de arranque (main.js) antes de destapar la app.
    this.ready = new Promise((resolve) => { this._readyResolve = resolve; });

    container.classList.add('chat-pane-host');
    container.innerHTML = `
      <div class="chat-view">
        <header class="chat-head">
          <button class="btn-ghost btn--icon mobile-menu-btn chat-menu" title="${t('chat.header.menuTitle', 'Abrir panel lateral')}">${icon('menu', { size: 16 })}</button>
          <span class="chat-title">${this.title}</span>
          <span class="chat-world" title="${t('chat.header.worldTitle', 'Mundo de esta conversación')}" hidden></span>
          <span class="chat-peers" aria-label="${t('chat.sala.participants', 'Participantes')}" hidden></span>
          <span class="chat-flow" hidden></span>
          ${pacman({ state: 'waiting', cls: 'chat-alive', title: t('chat.pac.waitingTitle', 'Esperando tu mensaje') })}
          <span class="chat-model-pill" title="${t('chat.header.modelPillTitle', 'Router de modelo automático')}" hidden></span>
          <select class="chat-mode" data-risk="ok" title="${t('chat.header.modeTitle', 'Modo de permisos')}">
            ${MODES.map(([v, l, , k]) => `<option value="${v}">${t(k, l)}</option>`).join('')}
          </select>
          ${helpBtn('chat')}
        </header>
        <div class="chat-msgs"></div>
        <div class="chat-atttray" hidden></div>
        <div class="chat-composer">
          <span class="chat-typing" hidden></span>
          <input type="file" class="chat-file-input" multiple hidden>
          <button class="btn-ghost btn--icon chat-attach" title="${t('chat.composer.attachTitle', 'Adjuntar archivo (imagen, PDF, texto…)')}">${icon('paperclip', { size: 16 })}</button>
          <button class="btn-ghost btn--icon chat-pkgref" title="${t('chat.composer.pkgrefTitle', 'Referenciar otro paquete-sesión (F5)')}">${icon('externalLink', { size: 16 })}</button>
          <textarea class="chat-input" rows="1" enterkeyhint="send" placeholder="${t('chat.composer.inputPlaceholder', 'Escribí o dictá un mensaje…')}"></textarea>
          <button class="btn btn--sm chat-cut-btn" type="button" hidden disabled>${t('chat.sala.cutButton', '✦ Enviar a la IA ({count})', { count: 0 })}</button>
          <button class="btn btn--icon chat-send" title="${t('chat.common.send', 'Enviar')}">${icon('play', { size: 16 })}</button>
          <button class="btn-ghost btn--icon chat-stop" title="${t('chat.composer.stopTitle', 'Detener')}" hidden>${icon('close', { size: 16 })}</button>
        </div>
      </div>`;

    this.worldEl = container.querySelector('.chat-world');
    this.peersEl = container.querySelector('.chat-peers');
    this.msgsEl = container.querySelector('.chat-msgs');
    // Un diagrama Mermaid renderiza asíncrono (después de que su mensaje ya
    // está en el DOM) y puede crecer la burbuja — re-anclar abajo, mismo
    // criterio "siempre pinea al final" que usa _scroll() en todo el resto.
    this.msgsEl.addEventListener('cwc:mermaid-rendered', () => this._scroll());
    this.inputEl = container.querySelector('.chat-input');
    // BUG-498: el borrador NO debe perderse en una reconexión/rebuild del pane.
    // El value del textarea vive SOLO en el DOM; lo respaldamos en localStorage por
    // id de chat → sobrevive incluso a un `new ChatTab` (misma clave por this.id).
    this._draftKey = `cwc:chat-draft:${this.id}`;
    try {
      const d = localStorage.getItem(this._draftKey);
      if (d) { this.inputEl.value = d; requestAnimationFrame(() => this._autosize()); }
    } catch { /* localStorage no disponible: sin respaldo, no rompe */ }
    this.sendBtn = container.querySelector('.chat-send');
    this.cutBtn = container.querySelector('.chat-cut-btn');
    this.stopBtn = container.querySelector('.chat-stop');
    this.typingEl = container.querySelector('.chat-typing');
    this.modeEl = container.querySelector('.chat-mode');
    this.aliveEl = container.querySelector('.chat-alive');
    this.modelPillEl = container.querySelector('.chat-model-pill');
    this.flowEl = container.querySelector('.chat-flow');
    this.attachBtn = container.querySelector('.chat-attach');
    this.pkgRefBtn = container.querySelector('.chat-pkgref');
    this.pkgRefBtn?.addEventListener('click', () => this._openPackagePicker());
    this.fileInput = container.querySelector('.chat-file-input');
    this.trayEl = container.querySelector('.chat-atttray');

    // ☰ (solo visible en móvil): pide el panel lateral al shell. En móvil el
    // panel es overlay y su propio ☰ queda fuera de pantalla al ocultarse.
    container.querySelector('.chat-menu').addEventListener('click', () => {
      window.dispatchEvent(new Event('cwc:open-sidebar'));
    });
    this.sendBtn.addEventListener('click', () => this._submit());
    this.cutBtn.addEventListener('click', () => {
      if (this.isSala && this._salaSayCount > 0 && !this._cutPending) this._send({ type: 'cut' });
    });
    // Confirmación antes de detener (pedido del usuario 2026-07-07): ventana en
    // escritorio, "menú de deslizamiento" (bottom sheet) en móvil. Cancelar
    // aborta la operación; Parar envía el interrupt.
    this.stopBtn.addEventListener('click', async () => {
      const ok = await confirmSheet({
        title: t('chat.stop.title', 'Detener respuesta'),
        message: t('chat.stop.message', '¿Parar la respuesta en curso? Se interrumpe lo que Claude está generando.'),
        confirmLabel: t('chat.stop.confirm', 'Parar'), cancelLabel: t('chat.common.cancel', 'Cancelar'), danger: true,
      });
      if (ok) this._send({ type: 'interrupt' });
    });
    this.modeEl.addEventListener('change', () => this._modeChanged());
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
      this._autosize();
      this._slashUpdate();
      // BUG-498: respaldar el borrador en cada tecla (barato; cubre reconexión,
      // disable y reconstrucción total del pane).
      try { localStorage.setItem(this._draftKey, this.inputEl.value); } catch { /* noop */ }
      this._sendTyping();
    });

    fetch('/api/whoami', { cache: 'no-store' })
      .then((res) => res.json())
      .then((me) => {
        this.me = me?.username || me?.host || null;
        this._refreshSalaIdentity();
      })
      .catch(() => { /* sin identidad: la sala sigue funcionando, sin alineación propia */ });

    // ===== Adjuntos (Fase 3): UN solo botón 📎 + pegar + arrastrar =====
    // La consola detecta el tipo de cada archivo sola (no hay botones por tipo).
    this.attachBtn.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      this._uploadFiles(this.fileInput.files);
      this.fileInput.value = ''; // permite re-elegir el mismo archivo
    });
    // Pegar (Ctrl+V): captura imágenes del portapapeles o archivos copiados.
    this.inputEl.addEventListener('paste', (e) => {
      const files = e.clipboardData?.files;
      if (files && files.length) { e.preventDefault(); this._uploadFiles(files); }
    });
    // Arrastrar y soltar sobre el chat (composer o lista de mensajes).
    const view = container.querySelector('.chat-view');
    const onDragOver = (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); view.classList.add('chat-dragover'); } };
    const onDragLeave = (e) => { if (e.target === view) view.classList.remove('chat-dragover'); };
    const onDrop = (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault(); view.classList.remove('chat-dragover');
      this._uploadFiles(e.dataTransfer.files);
    };
    view.addEventListener('dragover', onDragOver);
    view.addEventListener('dragleave', onDragLeave);
    view.addEventListener('drop', onDrop);
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
        ? (this._metaSeen ? t('chat.slash.noCommands', 'Esta conversación no expone comandos.') : t('chat.slash.loading', 'Cargando comandos… (llegan con el primer mensaje)'))
        : t('chat.slash.noMatches', 'Sin coincidencias.');
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

  // Abre el WebSocket de la conversación. IDEMPOTENTE: llamarla más de una vez
  // NO abre un segundo socket. El arranque (lazy-connect) conecta la conversación
  // recién al mostrarla, y puede pedir conectar la MISMA pestaña varias veces
  // (setActive) — el guard `_wsWanted` lo hace inofensivo. La reconexión
  // automática reusa `_open()` directo, sin volver a pasar por el guard.
  connect() {
    if (this._wsWanted) return;
    this._wsWanted = true;
    this._open();
  }
  _open() {
    const url = `wss://${location.host}/ws/chat?id=${encodeURIComponent(this.id)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this._sendInitialPrompt();
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      this._onEvent(m);
    };
    ws.onclose = () => {
      if (this.closedByUser) return;
      this.reconnectTimer = setTimeout(() => this._open(), 1500);
    };
    ws.onerror = () => ws.close();
  }

  _sendInitialPrompt() {
    // En la primera conexión esperamos history para saber si corresponde
    // `user` (chat común) o `say` (sala). En reconexiones el dato ya está.
    if (!this.initialPrompt || this._sentInitial || this.isSala === null) return;
    this._sentInitial = true;
    this._send({ type: this.isSala ? 'say' : 'user', text: this.initialPrompt });
  }

  _submit() {
    const text = this.inputEl.value.trim();
    // Adjuntos LISTOS (subidos, con name del server). Los que fallaron no viajan.
    const ready = this.pending.filter((p) => p.name && !p.error);
    if (!text && !ready.length) return;
    if (this.isSala && !text) return;
    if (this.pending.some((p) => p.uploading)) return; // esperar a que terminen de subir
    this._slashClose();
    this._slashSuppressed = null;
    const attachments = ready.map((p) => ({ name: p.name, type: p.type, mime: p.mime }));
    if (this.isSala) this._send({ type: 'say', text });
    else this._send({ type: 'user', text, ...(attachments.length ? { attachments } : {}) });
    for (const p of this.pending) { if (p.localUrl) URL.revokeObjectURL(p.localUrl); }
    this.pending = [];
    this._renderTray();
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';
    try { localStorage.removeItem(this._draftKey); } catch { /* noop */ } // BUG-498: enviado OK → sin borrador
    this.inputEl.focus();
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  _sendTyping() {
    if (!this.isSala || !this.inputEl.value.trim()) return;
    const now = Date.now();
    if (now - this._lastTypingSent < 2000) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this._lastTypingSent = now;
    this._send({ type: 'typing' });
  }

  // ===== Adjuntos (Fase 3): subida a disco + bandeja de pendientes =====
  // Cada archivo se sube al toque a POST /api/chat/attachment (a la carpeta del
  // chat); el chip optimista aparece mientras sube y se completa con el `name`
  // real que asigna el server. Al enviar el mensaje viajan solo las referencias.
  async _uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      if (this.pending.length >= MAX_ATTACHMENTS) {
        this._line('chat-error', t('chat.attach.max', 'Máximo {max} adjuntos por mensaje.', { max: MAX_ATTACHMENTS }));
        break;
      }
      const type = classifyLocal(file);
      const entry = {
        name: null, type, mime: file.type || '', size: file.size,
        uploading: true, error: null,
        localUrl: type === 'image' ? URL.createObjectURL(file) : null,
        origName: file.name || 'archivo',
      };
      this.pending.push(entry);
      this._renderTray();
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch(`/api/chat/attachment?id=${encodeURIComponent(this.id)}`, { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || t('chat.attach.uploadFail', 'No se pudo subir.'));
        entry.name = data.attachment.name;
        entry.type = data.attachment.type || type;
        entry.mime = data.attachment.mime || entry.mime;
      } catch (e) {
        entry.error = String(e.message || e).slice(0, 140);
      } finally {
        entry.uploading = false;
        this._renderTray();
      }
    }
  }

  _removePending(entry) {
    const i = this.pending.indexOf(entry);
    if (i < 0) return;
    if (entry.localUrl) URL.revokeObjectURL(entry.localUrl);
    this.pending.splice(i, 1);
    this._renderTray();
  }

  _renderTray() {
    if (!this.trayEl) return;
    this.trayEl.innerHTML = '';
    if (!this.pending.length) { this.trayEl.hidden = true; return; }
    this.trayEl.hidden = false;
    for (const p of this.pending) {
      const chip = document.createElement('div');
      chip.className = `chat-att${p.error ? ' chat-att--err' : ''}${p.uploading ? ' chat-att--up' : ''}`;
      if (p.type === 'image' && (p.localUrl || p.name)) {
        const img = document.createElement('img');
        img.className = 'chat-att-thumb';
        img.src = p.localUrl || `/api/chat/attachment?id=${encodeURIComponent(this.id)}&name=${encodeURIComponent(p.name)}`;
        img.alt = p.origName;
        chip.appendChild(img);
      } else {
        const ic = document.createElement('span');
        ic.className = 'chat-att-ic';
        ic.innerHTML = icon('fileGeneric', { size: 15 });
        chip.appendChild(ic);
      }
      const label = document.createElement('span');
      label.className = 'chat-att-name';
      label.textContent = p.origName;
      label.title = p.error || p.origName;
      chip.appendChild(label);
      const rm = document.createElement('button');
      rm.className = 'chat-att-rm';
      rm.type = 'button';
      rm.title = t('chat.attach.remove', 'Quitar');
      rm.innerHTML = icon('close', { size: 12 });
      rm.addEventListener('click', () => this._removePending(p));
      chip.appendChild(rm);
      this.trayEl.appendChild(chip);
    }
  }

  // Previews de adjuntos DENTRO de la burbuja del usuario (vivo y replay).
  // Con `name` → miniatura/chip real (la sirve GET /api/chat/attachment); sin
  // `name` (replay desde el transcript) → chip de tipo, sin miniatura.
  _attsEl(attachments) {
    const box = document.createElement('div');
    box.className = 'chat-atts';
    for (const a of attachments) {
      const type = a.type || 'binary';
      if (type === 'image' && a.name) {
        const img = document.createElement('img');
        img.className = 'chat-att-img';
        const src = `/api/chat/attachment?id=${encodeURIComponent(this.id)}&name=${encodeURIComponent(a.name)}`;
        img.src = src;
        img.alt = a.name;
        img.title = a.name;
        img.addEventListener('click', () => this._lightbox(src, a.name));
        box.appendChild(img);
      } else {
        const chip = document.createElement('div');
        chip.className = 'chat-att chat-att--msg';
        const ic = document.createElement('span');
        ic.className = 'chat-att-ic';
        ic.innerHTML = icon('fileGeneric', { size: 15 });
        chip.appendChild(ic);
        const label = document.createElement('span');
        label.className = 'chat-att-name';
        const _k = ATT_KIND_I18N[type];
        label.textContent = a.name || (_k ? t(_k[0], _k[1]) : '') || t('chat.att.attachment', 'adjunto');
        chip.appendChild(label);
        if (a.name) {
          chip.classList.add('chat-att--link');
          chip.addEventListener('click', () => window.open(`/api/chat/attachment?id=${encodeURIComponent(this.id)}&name=${encodeURIComponent(a.name)}`, '_blank'));
        }
        box.appendChild(chip);
      }
    }
    return box;
  }

  _lightbox(src, name) {
    const m = openModal({ title: name || t('chat.lightbox.title', 'Imagen'), width: 'min(92vw, 900px)' });
    const img = document.createElement('img');
    img.src = src;
    img.className = 'chat-lightbox-img';
    m.body.appendChild(img);
  }

  // ===== Render de eventos (mismo camino para history y vivo) =====
  _onEvent(m) {
    switch (m.type) {
      case 'history':
        this.isSala = !!m.isSala;
        this.participants = Array.isArray(m.participants) ? m.participants : [];
        this._salaSayCount = 0;
        this._cutPending = false;
        this._clearTyping();
        this._renderSalaState();
        this.msgsEl.innerHTML = '';
        this.streamEl = null;
        // BUG-498: una reconexión/history exitosa REVIVE el composer si un `closed`
        // previo lo dejó deshabilitado (antes `disabled=true` no se revertía nunca).
        if (this.inputEl) this.inputEl.disabled = false;
        if (this.sendBtn) this.sendBtn.disabled = false;
        this._applyWorld(m.cwd, m.world); // insignia de mundo (anti-confusión)
        this._applyFlow(m.sessionId, m.cwd);
        if (m.packageRef) this._packageRef = m.packageRef; // F5: para excluirse del picker
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
        // OJO: preservar el null (motor dormido). Un `!!` lo aplastaría a false y
        // el badge volvería a mentir "pendiente" en toda conversación dormida.
        this._tandemActive = m.tandemActive === undefined ? true
          : (m.tandemActive === null ? null : !!m.tandemActive);
        this._engineDormant = false; // llegó history: hay motor/atadura fresca
        this._effort = m.effort || null;           // eje thinking effort (PEND-391 #3): 2ª línea del banderín
        this._effortPinned = !!m.effortPinned;
        this._applyModel(m.model); // sin auto: solo poblar el badge al abrir/reconectar
        this._sendInitialPrompt();
        // Historial renderizado: destraba al splash de arranque (ver arriba).
        this._readyResolve?.();
        this._readyResolve = null;
        break;
      case 'meta':
        this.slashCommands = Array.isArray(m.slashCommands) ? m.slashCommands : [];
        this._metaSeen = true;
        if (this._slashPop) this._slashUpdate(); // refresco en vivo si está abierto
        break;
      case 'say': this._say(m); break;
      case 'cut': this._cut(m); break;
      case 'cut-pending':
        this._cutPending = true;
        this._renderCutButton();
        break;
      case 'typing': this._typing(m); break;
      case 'participants':
        this.participants = Array.isArray(m.participants) ? m.participants : [];
        this._renderPeers();
        break;
      case 'user': this._closeStream(); this._bubble('user', m.text, m.attachments); break;
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
      // Señal EN VIVO del interfono (Fase 3): el server la empuja SOLO a las
      // ventanas que tienen este chat abierto (c.clients). La re-emitimos
      // global para que el centro (ui/interfono-center.js) refresque el aviso
      // `active` al instante, sin esperar el poll de 8 s.
      case 'interfono':
        window.dispatchEvent(new CustomEvent('cwc:interfono', { detail: { chatId: this.id, pending: m.pending || [] } }));
        break;
      case 'result': this._result(m); break;
      case 'status': this._setWorking(m.state === 'working'); break;
      case 'model': this._applyModel(m.model, { auto: !!m.auto }); break;
      case 'modelChoice': this._applyModelChoice(m.modelChoice); break;
      // Eje thinking effort (PEND-391 #3): 2ª línea del banderín del header.
      case 'effort': this._effort = m.effort || null; this._effortPinned = !m.auto; this._renderModelBadge(); break;
      // Juez AutoMix (PEND-391 #1 / D1): banner PASIVO de consentimiento. El
      // juez detectó que la respuesta se quedó corta y ofrece subir de modelo.
      // NUNCA sube solo: el usuario decide [Reintentar] / [Ignorar].
      case 'redo-suggest': this._redoSuggest(m); break;
      case 'mode':
        // Reconciliación con el modo REAL del motor (paso 2, fin del drift): el
        // select SIEMPRE refleja lo que el motor aplica de verdad. Si el usuario
        // pidió un modo y el motor reporta OTRO, el cambio NO tomó: avisamos
        // claro y no dejamos el select mintiendo un modo que no está vigente.
        if (this._pendingMode && m.mode !== this._pendingMode) {
          const want = modeLabel(this._pendingMode);
          const real = modeLabel(m.mode);
          this._line('chat-error', t('chat.mode.switchFail', 'No se pudo activar el modo “{want}”: sigue en “{real}”. Si esta conversación viene de antes, cerrala y reabrila para aplicar el cambio.', { want, real }));
          this._pendingMode = null;
        } else if (m.mode === this._pendingMode) {
          this._pendingMode = null; // confirmado por el motor
        }
        this._applyMode(m.mode);
        break;
      case 'viewmode':
        if (m.viewMode === 'switching') {
          this._line('chat-switch-note', t('chat.viewmode.switching', 'Cambiando a Terminal (TUI)…'));
        } else if (m.error) {
          this._line('chat-error', m.error);
        }
        // El shell reconstruye la vista si el modo efectivo cambió.
        this.onViewMode?.(m);
        break;
      case 'error': this._line('chat-error', t('chat.event.error', 'Error: {message}', { message: m.message })); break;
      case 'reopened':
        // Se mató el runner viejo y arrancó uno fresco sobre la misma sesión
        // (opción "Reabrir para cambios" del menú ⋯): ya toma el código nuevo.
        this._line('chat-closed-note', t('chat.event.reopened', 'Motor reabierto — arrancó un proceso fresco que toma los cambios de código nuevos. El contexto se conserva.'));
        break;
      case 'moved':
        // La conversación se mudó a otro MUNDO (menú ⋯ "Mover a otro mundo", F1/
        // PLAN-373): misma sesión, nuevo cwd; ya usa las herramientas de ese mundo.
        this._line('chat-closed-note', t('chat.event.moved', '📦 Movida a {world} — ahora usás las herramientas de ese mundo. El contexto viajó completo.', { world: m.world || t('chat.event.otherWorld', 'otro mundo') }));
        this._applyWorld(m.cwd, m.world); // actualizar la insignia de mundo del header
        this._applyFlow(this._flowSid, m.cwd);
        break;
      case 'closed':
        if (m.resumable) {
          // El motor se durmió (inactividad); la conversación sigue viva:
          // el próximo mensaje la retoma. No se bloquea nada.
          this._line('chat-closed-note', t('chat.event.dormant', 'Conversación dormida por inactividad — tu próximo mensaje la retoma.'));
          this._engineDormant = true;
          // El motor durmió: el badge de modelo deja de alarmar (el Pac-Man ya comunica el sueño).
          if (this._tandemActive === false) { this._tandemActive = null; this._renderModelBadge(); }
        } else {
          this._line('chat-closed-note', t('chat.event.closed', 'Conversación cerrada en el servidor.'));
          this.inputEl.disabled = true;
          this.sendBtn.disabled = true;
        }
        break;
      default: break;
    }
  }

  _localTime(ts) {
    const date = new Date(ts);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  _say(m) {
    if (!this.isSala) return;
    const by = String(m.by || '');
    const el = document.createElement('div');
    el.className = `chat-msg chat-say ${peerToneFor(by)}`;
    el.dataset.by = by;
    el.classList.toggle('chat-say--own', !!this.me && by === this.me);

    const label = document.createElement('span');
    label.className = 'chat-say-label';
    label.textContent = t('chat.sala.sayLabel', '{name} · {time}', { name: by, time: this._localTime(m.ts) });
    const body = document.createElement('span');
    body.className = 'chat-say-text';
    body.textContent = m.text || '';
    el.append(label, body);
    this.msgsEl.appendChild(el);
    this._salaSayCount++;
    this._renderCutButton();
    this._scroll();
  }

  _cut(m) {
    if (!this.isSala) return;
    const el = document.createElement('div');
    el.className = 'chat-cut';
    el.textContent = t('chat.sala.cutLine', '✂ {name} envió a la IA · {time}', {
      name: String(m.by || ''),
      time: this._localTime(m.ts),
    });
    this.msgsEl.appendChild(el);
    this._salaSayCount = 0;
    this._cutPending = false;
    this._renderCutButton();
    this._scroll();
  }

  _typing(m) {
    if (!this.isSala || !m.by || m.by === this.me) return;
    const by = String(m.by);
    clearTimeout(this._typingTimers.get(by));
    const timer = setTimeout(() => {
      this._typingTimers.delete(by);
      this._renderTyping();
    }, 4000);
    this._typingTimers.set(by, timer);
    this._renderTyping();
  }

  _clearTyping() {
    for (const timer of this._typingTimers.values()) clearTimeout(timer);
    this._typingTimers.clear();
    this._renderTyping();
  }

  _renderTyping() {
    if (!this.typingEl) return;
    const names = [...this._typingTimers.keys()].filter((name) => name !== this.me);
    this.typingEl.hidden = !this.isSala || names.length === 0;
    if (!names.length) {
      this.typingEl.textContent = '';
    } else if (names.length === 1) {
      this.typingEl.textContent = t('chat.sala.typingOne', '{name} está escribiendo…', { name: names[0] });
    } else {
      this.typingEl.textContent = t('chat.sala.typingMany', '{names} están escribiendo…', { names: names.join(', ') });
    }
  }

  _renderSalaState() {
    this.container.querySelector('.chat-view')?.classList.toggle('chat-view--sala', !!this.isSala);
    this._renderPeers();
    this._renderCutButton();
    this._renderTyping();
  }

  _renderCutButton() {
    if (!this.cutBtn) return;
    this.cutBtn.hidden = !this.isSala;
    this.cutBtn.disabled = !this.isSala || this._salaSayCount === 0 || this._cutPending;
    this.cutBtn.textContent = this._cutPending
      ? t('chat.sala.cutPending', 'IA ocupada · queda pendiente')
      : t('chat.sala.cutButton', '✦ Enviar a la IA ({count})', { count: this._salaSayCount });
  }

  _renderPeers() {
    if (!this.peersEl) return;
    this.peersEl.replaceChildren();
    const people = [...this.participants];
    if (this.me && !people.some((p) => p?.user === this.me)) people.unshift({ user: this.me, role: null });
    const seen = new Set();
    for (const participant of people) {
      const username = String(participant?.user || '');
      if (!username || seen.has(username)) continue;
      seen.add(username);
      const chip = document.createElement('span');
      chip.className = `chat-peer ${peerToneFor(username)}`;
      chip.title = t('chat.sala.participantTitle', 'Participante: {name}', { name: username });
      const parts = username.trim().split(/\s+/).filter(Boolean);
      chip.textContent = ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
      this.peersEl.appendChild(chip);
    }
    this.peersEl.hidden = !this.isSala || !this.peersEl.children.length;
  }

  _refreshSalaIdentity() {
    for (const el of this.msgsEl?.querySelectorAll('.chat-say') || []) {
      el.classList.toggle('chat-say--own', !!this.me && el.dataset.by === this.me);
    }
    this._renderPeers();
    this._renderTyping();
  }

  _bubble(kind, text, attachments = null) {
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
    } else if (text) {
      el.appendChild(document.createTextNode(text));
    }
    // Adjuntos: miniaturas (imágenes) / chips (PDF, texto, binarios) bajo el texto.
    if (attachments && attachments.length) el.appendChild(this._attsEl(attachments));
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
        pre.textContent = t('chat.tool.noOutput', '(sin salida)');
      }
      body.appendChild(pre);
    }
    if (!body.childNodes.length) {
      const note = document.createElement('div');
      note.className = 'ctg-empty';
      note.textContent = t('chat.tool.noDetail', '(sin detalle)');
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
    // Imágenes que DEVOLVIÓ la herramienta (Read de un PNG, screenshot…): el
    // runner las materializó en la carpeta de adjuntos del chat y mandó solo
    // las referencias {name,type,mime}. Se muestran como miniatura clickeable
    // (→ lightbox) bajo el grupo del tool, reusando _attsEl de los adjuntos —
    // así se VEN sin tocar nada, no escondidas en el detalle. Guard por id: un
    // replay (hello.events al reconectar) no debe duplicar la tira.
    if (Array.isArray(m.images) && m.images.length
        && !this.msgsEl.querySelector(`.chat-toolimgs[data-tool-id="${CSS.escape(m.id)}"]`)) {
      const group = chip.closest('.chat-toolgroup');
      if (group) {
        const strip = this._attsEl(m.images);
        strip.classList.add('chat-toolimgs');
        strip.dataset.toolId = m.id;
        group.after(strip);
        this._scroll();
      }
    }
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
        <button class="btn-ghost btn--sm cp-deny" data-allow="0">${icon('close', { size: 13 })} ${t('chat.perm.deny', 'Denegar')}</button>
        <button class="btn btn--sm cp-allow" data-allow="1">${icon('check', { size: 13 })} ${t('chat.perm.allow', 'Permitir')}</button>
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
    label.textContent = t('chat.askq.assistantQuestion', 'Pregunta del asistente');
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
      pre.textContent = d?.command || el._summary || t('chat.tool.noDetail', '(sin detalle)');
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
    chip.querySelector('.ct-name').textContent = m.allow ? t('chat.perm.allowed', 'Permitido') : t('chat.perm.denied', 'Denegado');
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
        title: t('chat.bypass.title', 'Aceptar todo'),
        message: t('chat.bypass.message', 'En este modo Claude ejecuta TODA acción (comandos, ediciones, red…) sin pedir permiso, hasta que lo cambies. Es el modo más riesgoso: usalo solo si confiás plenamente en la tarea.'),
        confirmLabel: t('chat.bypass.confirm', 'Aceptar todo'),
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
  // Insignia de MUNDO en el header (anti-confusión, pedido de Niko): muestra
  // SIEMPRE en qué mundo está esta conversación (🏠 Mi Consola / 🌳 Tolkien / otro)
  // con color de identidad (ui/places.js). Se puebla al abrir ('history') y se
  // actualiza al mudar de mundo ('moved'). Así nunca confundís "el GitHub/Pad de
  // este mundo" con el del otro.
  _applyWorld(cwd, world) {
    const el = this.worldEl;
    if (!el) return;
    const p = cwd ? resolvePlace(cwd) : null;
    const label = p?.isolated ? t('chat.world.envLabel', 'Tolkien (aislado)') : (p?.label || world || '');
    if (!label) { el.hidden = true; return; }
    el.hidden = false;
    el.dataset.world = p?.rel || 'other';
    el.innerHTML = `${icon(p?.ico || 'folder', { size: 12 })}<span>${label}</span>`;
    const _path = cwd ? ` · ${cwd}` : '';
    const _env = p?.isolated ? t('chat.world.envSuffix', ' · entorno {env}', { env: p.envId }) : '';
    el.title = t('chat.world.title', 'Mundo: {label}{env}{path} — acá "GitHub/Pad/cuenta" son los de {label}', { label, env: _env, path: _path });
  }

  _applyFlow(sessionId, cwd) {
    if (!this.flowEl) return;
    const sid = sessionId || this._flowSid || '';
    const dir = cwd || this._flowCwd || '';
    this._flowSid = sid;
    this._flowCwd = dir;
    if (!sid && !dir) {
      this.flowEl.hidden = true;
      return;
    }
    this.flowEl.innerHTML =
      flowBarHtml({ engine: 'claude', session: sid, total: true, compact: true }) +
      flowBarHtml({ engine: 'codex', cwd: dir, total: true, compact: true });
    this.flowEl.hidden = false;
    ensureFlowDirector();
  }

  // F5 (PLAN-373/PEND-464): picker para REFERENCIAR otro paquete-sesión desde
  // este chat. Busca en GET /api/chat/packages (sin importar el mundo) y, al elegir
  // uno, inserta en el composer una referencia con su snippet — así traés el
  // contexto de otra sesión a la conversación actual. Lista construida con DOM +
  // textContent (sin innerHTML de datos del usuario).
  _openPackagePicker() {
    const m = openModal({ title: t('chat.pkg.pickerTitle', 'Referenciar un paquete-sesión'), width: 440 });
    const q = document.createElement('input');
    q.className = 'dlg-input chat-pkg-q';
    q.placeholder = t('chat.pkg.searchPlaceholder', 'Buscar por ref (PKG-3), título o mundo…');
    const list = document.createElement('div');
    list.className = 'chat-pkg-list';
    m.body.append(q, list);
    let timer = null;
    const render = async () => {
      let pkgs = [];
      try { pkgs = (await fetch(`/api/chat/packages?q=${encodeURIComponent(q.value)}`).then((r) => r.json())).packages || []; } catch { /* noop */ }
      pkgs = pkgs.filter((p) => p.ref !== this._packageRef); // no referenciarse a sí mismo
      list.replaceChildren();
      if (!pkgs.length) {
        const e = document.createElement('div');
        e.className = 'chat-pkg-empty'; e.textContent = t('chat.pkg.empty', 'Sin paquetes.');
        list.append(e); return;
      }
      for (const p of pkgs) {
        const b = document.createElement('button');
        b.className = 'btn-ghost chat-pkg-item';
        const r = document.createElement('span'); r.className = 'chat-pkg-ref'; r.textContent = p.ref;
        const titleEl = document.createElement('span'); titleEl.className = 'chat-pkg-title'; titleEl.textContent = p.title || t('chat.pkg.noTitle', '(sin título)');
        const meta = document.createElement('span'); meta.className = 'chat-pkg-meta'; meta.textContent = `${p.world || '?'} · ${p.status || ''}`;
        b.append(r, titleEl, meta);
        b.addEventListener('click', () => this._insertPackageRef(p.ref, m));
        list.append(b);
      }
    };
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 180); });
    render();
    setTimeout(() => q.focus(), 30);
  }

  async _insertPackageRef(ref, modal) {
    let data = {};
    try { data = await fetch(`/api/chat/package/${encodeURIComponent(ref)}`).then((r) => r.json()); } catch { /* noop */ }
    const p = data.package || { ref };
    const snip = data.snippet ? `: ${data.snippet}` : '';
    const block = t('chat.pkg.refBlock', '📦 Referencia al paquete {ref} «{title}» (mundo {world}){snip}', { ref: p.ref, title: p.title || '', world: p.world || '?', snip });
    modal?.close();
    const ta = this.inputEl;
    if (ta) {
      ta.value = ta.value ? `${ta.value}\n${block}\n` : `${block}\n`;
      ta.dispatchEvent(new Event('input')); // dispara el auto-grow del textarea
      ta.focus();
    }
  }

  _applyModel(model, { auto = false } = {}) {
    const prev = this._model;
    this._model = model || null;
    this._renderModelBadge();
    if (auto && prev && this._modelChoice === 'auto' && prev !== model) {
      this._line('chat-switch-note', t('chat.model.autoSwitch', '🤖 AutoTux cambió el modelo a {model} sin que hagas nada.', { model: tierName(model) }));
    }
  }

  // Puerta de entrada de la ELECCIÓN a la UI: 'auto' (AutoTux, el router
  // queda al mando) u otro valor fijo (Fable/Opus/Sonnet/Haiku/opusplan/
  // default — la conversación queda FORZADA a ese único modelo). Separado de
  // _applyModel porque el backend los manda como eventos distintos
  // (`modelChoice` cambia mucho menos seguido que `model`).
  _applyModelChoice(modelChoice) {
    this._modelChoice = modelChoice || null;
    // Pesimista SOLO con motor vivo (ahí la desincronía es real y hay que avisar).
    // Con el motor dormido no hay nada desincronizado: el próximo spawn ya nace en Tándem.
    if (this._modelChoice === 'tandem') this._tandemActive = this._engineDormant ? null : false;
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
    // Banderín de 2 LÍNEAS (PEND-391 #3, pedido de Niko): 1ª línea = modelo
    // (como siempre), 2ª línea = ESFUERZO de razonamiento — compacto, mismo
    // tamaño reducido. Se arma en dos <span> internos (.chat-pill-l1/.chat-pill-l2).
    const effTxt = this._effort ? effortLabel(this._effort, this._effortPinned) : '';
    const paint = (l1, color, title) => {
      this.modelPillEl.hidden = false;
      this.modelPillEl.style.color = color;
      this.modelPillEl.style.borderColor = color;
      this.modelPillEl.title = title + (effTxt ? t('chat.model.effortSuffix', ' · esfuerzo: {eff}', { eff: effTxt }) : '');
      this.modelPillEl.innerHTML = `<span class="chat-pill-l1">${l1}</span>${effTxt ? `<span class="chat-pill-l2">🧠 ${effTxt}</span>` : ''}`;
      this.modelPillEl.classList.toggle('chat-model-pill--two', !!effTxt);
    };
    if (choice === 'auto') {
      const level = ROUTER_MANAGED_MODELS.includes(model) ? tierName(model) : '…';
      paint(t('chat.model.autoBadge', '🤖 AutoTux: {level}', { level }), modelColor(ROUTER_MANAGED_MODELS.includes(model) ? model : 'unknown'),
        t('chat.model.autoTitle', 'AutoTux (router de modelo automático) — nivel actual: {level}', { level }));
    } else if (choice === 'tandem') {
      // Modelo TÁNDEM (PLAN-507): Opus razona/verifica, Codex ejecuta. Color
      // propio (acento frío, el mismo que Codex en el panel de Uso) para
      // distinguirlo de un modelo forzado común.
      if (this._tandemActive === false) {
        paint(t('chat.model.tandemPendingBadge', '🤝 Tándem · inactivo'), 'var(--cwc-warn)',
          t('chat.model.tandemPendingTitle', 'Elegiste Tándem pero el motor que está corriendo NO lo aplica (arrancó antes del cambio). Usá «Reabrir para cambios» en el menú ⋯ de Sesiones.'));
      } else {
        paint(t('chat.model.tandemBadge', '🤝 Tándem'), 'var(--cwc-accent-cool)',
          t('chat.model.tandemTitle', 'Tándem — Opus (alto) razona y verifica · Codex GPT-5.6 Sol (alto) ejecuta el código'));
      }
    } else if (choice) {
      const label = CHAT_MODEL_LABEL.get(choice) || choice;
      paint(label, modelColor(ROUTER_MANAGED_MODELS.includes(choice) ? choice : 'unknown'),
        t('chat.model.forcedTitle', 'Modelo forzado — esta conversación solo usa {label}', { label }));
    } else {
      this.modelPillEl.hidden = true;
    }
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

  // Banner de consentimiento del juez AutoMix (PEND-391 #1 / D1): pasivo, con
  // [Reintentar en <modelo>] / [Ignorar]. Nunca sube solo. Solo dejamos UNO a la
  // vez (si llega otro, reemplaza al anterior — el último juicio manda).
  _redoSuggest(m) {
    this.msgsEl.querySelector('.chat-redo')?.remove();
    const to = m.to || t('chat.redo.strongerModel', 'un modelo más fuerte');
    const el = document.createElement('div');
    el.className = 'chat-redo';
    el.innerHTML = `
      <span class="chat-redo-txt">${t('chat.redo.text', '🤔 Creo que un modelo más fuerte lo haría mejor.')}</span>
      <span class="chat-redo-actions">
        <button class="btn btn--sm" data-act="redo">${t('chat.redo.retry', 'Reintentar en {to}', { to })}</button>
        <button class="btn-ghost btn--sm" data-act="ignore">${t('chat.redo.ignore', 'Ignorar')}</button>
      </span>`;
    el.querySelector('[data-act="ignore"]').addEventListener('click', () => el.remove());
    el.querySelector('[data-act="redo"]').addEventListener('click', async () => {
      el.remove();
      try {
        const res = await fetch('/api/chat/redo', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: this.id }),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || t('chat.redo.failMsg', 'No se pudo reintentar.')); }
      } catch (e) { this._line('chat-error', t('chat.redo.failLine', 'Reintentar: {message}', { message: e.message })); }
    });
    this.msgsEl.appendChild(el);
    this._scroll();
  }

  _setWorking(on) {
    this.stopBtn.hidden = !on;
    // En Aduana las personas pueden seguir hablando mientras la IA trabaja;
    // el botón ✦ encola el próximo corte si hace falta.
    this.sendBtn.hidden = on && !this.isSala;
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
    this.aliveEl.title = state === 'delegating' ? t('chat.pac.delegatingTitle', 'Delegando a un subagente…')
      : state === 'working' ? t('chat.pac.workingTitle', 'Trabajando…') : t('chat.pac.waitingTitle', 'Esperando tu mensaje');
  }

  _scroll() {
    // Coalesce: durante el streaming llegan muchos _scroll() por segundo; sin
    // esto cada token forzaría un reflow (lee scrollHeight). Con rAF se hace a
    // lo sumo UNA vez por frame.
    if (this._scrollPending) return;
    this._scrollPending = true;
    requestAnimationFrame(() => {
      this._scrollPending = false;
      this.msgsEl.scrollTop = this.msgsEl.scrollHeight;
    });
  }

  // Recalcula el alto del textarea según su contenido. NO fija 0px cuando el
  // pane está oculto (display:none) o sin layout: ahí scrollHeight es 0 y
  // fijarlo colapsaría el input a un sliver ilegible (bug: composer chico e
  // inmóvil al restaurar un borrador con la pestaña inactiva, lazy-connect
  // PEND-747). En ese caso se deja en 'auto' hasta que haya layout real; se
  // recomputa en focus() al mostrar la pestaña y en el handler de 'input'.
  _autosize() {
    const el = this.inputEl;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }

  focus() {
    // Re-anclar SIEMPRE al final al activar la pestaña: mientras el panel está
    // oculto (display:none) scrollTop se pierde (scrollHeight=0), así que el
    // historial re-renderizado o los eventos llegados en background dejaban la
    // vista arriba de todo al volver a este chat. setActive() nos llama justo
    // DESPUÉS de mostrar el panel, con el layout ya medible.
    this._scroll();
    this._autosize();
    // En táctil no auto-enfocamos: abriría el teclado sin que lo pidas.
    if (!window.matchMedia('(pointer: coarse)').matches) this.inputEl.focus();
  }

  dispose() {
    this.closedByUser = true;
    this._slashClose();
    this._clearTyping();
    clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch { /* noop */ }
  }
}
