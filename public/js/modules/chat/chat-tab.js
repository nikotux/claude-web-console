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
import { PLACES, placeFor, resolvePlace } from '../../ui/places.js';
import { flowBarHtml, ensureFlowDirector } from '../../ui/token-flow.js';
import { t } from '../../ui/i18n.js';
import { helpBtn } from '../../ui/help.js';
import { avatarFor, avatarNodeFrom } from '../../ui/avatars.js';
import { milestoneGlyph, milestoneToastTitle, milestoneTrackHtml } from '../../ui/pr-milestone.js';
import { openPeticionDialog } from '../visado/peticion-dialog.js';
import { fetchPreview } from '../visado/api.js';

// Etiqueta de cada modelChoice (incluye "AutoTux" y "Opus plan" — fuente
// única en ui/models.js, la misma que usa el menú "Cambiar modelo").
const CHAT_MODEL_LABEL = new Map(CHAT_MODEL_OPTIONS);
const DOC_MODE_STORAGE_KEY = 'cwc.chat.docmode';
const DOC_MODE_EVENT = 'cwc:docmode';

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
const SALA_REACTIONS = [
  { emoji: '👍', labelKey: 'chat.sala.reactionAgree', label: 'de acuerdo' },
  { emoji: '❓', labelKey: 'chat.sala.reactionDoubt', label: 'tengo dudas' },
  { emoji: '🔴', labelKey: 'chat.sala.reactionBlock', label: 'esto bloquea' },
];
const SALA_REACTION_EMOJIS = new Set(SALA_REACTIONS.map(({ emoji }) => emoji));

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

export function stripAddressees(text, { final = false } = {}) {
  const raw = String(text ?? '');
  const newline = raw.indexOf('\n');
  if (newline !== -1) {
    const match = raw.slice(0, newline).match(/^@para:[ \t]*(.*)$/i);
    if (match) {
      const addressees = match[1].split(',').map((name) => name.trim()).filter(Boolean);
      return { addressees, text: raw.slice(newline + 1), pending: false };
    }
  } else if (!final) {
    const lower = raw.toLowerCase();
    if ('@para:'.startsWith(lower) || lower.startsWith('@para:')) {
      return { addressees: null, text: '', pending: true };
    }
  }
  // En el texto final preferimos mostrar una marca cruda una vez (feo pero
  // visible) antes que comernos la respuesta entera sin que el usuario lo note.
  return { addressees: null, text: raw, pending: false };
}

export class ChatTab {
  constructor({ id, title, container, onToggleMode, onViewMode, onPopout = null, soloMode = false, initialPrompt = null }) {
    this.id = id;
    this.title = title || 'chat';
    this.container = container;
    // Pasar a TUI ya no tiene botón en el header (se quitó junto con el costo):
    // el camino es el menú ⋯ de la tarjeta en Sesiones. El callback queda por
    // compatibilidad con el shell (main.js lo sigue pasando).
    this.onToggleMode = onToggleMode;
    this.onViewMode = onViewMode;     // el server anunció un cambio de modo
    this.onPopout = onPopout;
    this.soloMode = !!soloMode;
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
    this._slashKind = null;       // 'slash' o 'mention': un solo popup compartido
    this._mentionRange = null;    // fragmento @query que reemplaza la opción elegida
    this._mentionSuppressed = null;
    this._working = false;        // motor Pac-Man del header (ver _renderPacState)
    this._delegatingCount = 0;    // subagentes Task/Agent pendientes del turno actual
    // Índice id-de-tool → { rec, group } para que _toolResult() encuentre su
    // registro SIN buscarlo en el DOM: desde el rediseño del panel lateral el
    // chip ya no existe como elemento, así que un querySelector devolvería
    // null y el resultado (salida, ok/fail, imágenes) se perdería en silencio.
    this._toolIndex = new Map();
    // Grupo cuyo panel lateral está abierto (null = panel cerrado).
    this._rawGroup = null;
    this._model = null;           // modelo REAL en curso (haiku/sonnet/opus/fable/opusplan/...)
    this._modelChoice = null;     // QUÉ ELIGIÓ la persona: 'auto' (AutoTux) u otro fijo — ver _applyModel/_applyModelChoice
    this._tandemActive = true;    // retrocompat: runners viejos no reportan tandemActive
    this._engineDormant = false;  // motor dormido: el badge de modelo NO debe alarmar (eso lo dice el Pac-Man)
    this.isSala = null;           // null hasta que llegue el primer history
    this.salaId = null;           // 🛃 id de la CARPETA de la sala; distinto del id de la conversación
    this._previewEnv = null;
    this._previewSalaId = null;
    this._previewLoading = false;
    this._previewTimer = null;
    this._previewGeneration = 0;
    this.participants = [];
    this.salaOwner = null;   // 🛃 dueño de la sala: no viene en participants
    this.salaAiName = 'cucho';
    this.salaAiLabel = 'Cucho';
    this.me = null;
    this._avatarKeys = new Map();
    this._unreadAtOpen = 0;
    this._newSepEl = null;
    this._lastSayTs = null;
    this._lastDaySepKey = null; // día del último separador pintado (estilo WhatsApp)
    this._lastReadTs = null;
    this._markReadTimer = null;
    this._markReadQueuedTs = null;
    this._markReadLastAt = 0;
    this._markReadInFlight = false;
    this._readGeneration = 0;
    this._historyRendering = false;
    this._historySayIndex = 0;
    this._historySayTotal = 0;
    this._prQueue = [];
    this._prKeys = new Set();
    this._prCurrent = null;
    this._prToastTimer = null;
    this._active = false;
    this._salaSayCount = 0;
    this._salaAskCount = 0;
    this._cutPending = false;
    this._lastCutAuthors = [];
    this._replyTo = null;
    this._orchestratedChatIds = new Set();
    this._subsalaChatIds = new Set();
    this._pendingPromptActive = false;
    this._streamRaw = '';
    this._streamAddresseesResolved = false;
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
          <span class="chat-head-break" aria-hidden="true"></span>
          <span class="chat-world" title="${t('chat.header.worldTitle', 'Mundo de esta conversación')}" hidden></span>
          <span class="chat-peers" aria-label="${t('chat.sala.participants', 'Participantes')}" hidden></span>
          <button type="button" class="btn-ghost btn--icon chat-visado-btn" hidden
            title="${t('chat.sala.visadoTitle', 'Pedir una operación')}"
            aria-label="${t('chat.sala.visadoTitle', 'Pedir una operación')}">${icon('check', { size: 14 })}</button>
          <button type="button" class="btn-ghost btn--sm chat-preview-btn" hidden disabled
            title="${t('chat.sala.previewTitle', 'Abrir el preview de Tolkien de esta sala con tu propia identidad')}"
            aria-label="${t('chat.sala.previewTitle', 'Abrir el preview de Tolkien de esta sala con tu propia identidad')}">
            ${icon('eye', { size: 14 })}<span>${t('chat.sala.previewLabel', 'Preview')}</span>
          </button>
          <span class="chat-flow" hidden></span>
          ${pacman({ state: 'waiting', cls: 'chat-alive', title: t('chat.pac.waitingTitle', 'Esperando tu mensaje') })}
          <span class="chat-model-pill" title="${t('chat.header.modelPillTitle', 'Router de modelo automático')}" hidden></span>
          <select class="chat-mode" data-risk="ok" title="${t('chat.header.modeTitle', 'Modo de permisos')}">
            ${MODES.map(([v, l, , k]) => `<option value="${v}">${t(k, l)}</option>`).join('')}
          </select>
          ${this.soloMode ? `
          <button type="button" class="btn-ghost btn--icon chat-popout"
            title="${t('chat.popout.toConsole', 'Abrir la consola completa')}"
            aria-label="${t('chat.popout.toConsole', 'Abrir la consola completa')}">${icon('console', { size: 15 })}</button>` : `
          <button type="button" class="btn-ghost btn--icon chat-popout"
            title="${t('chat.popout.title', 'Desanclar: abrir esta conversación en su propia ventana')}"
            aria-label="${t('chat.popout.title', 'Desanclar: abrir esta conversación en su propia ventana')}">${icon('externalLink', { size: 15 })}</button>`}
          <button type="button" class="btn-ghost btn--icon chat-doc-toggle"
            title="${t('chat.doc.toggle', 'Modo documento — texto angosto, justificado y serif')}"
            aria-label="${t('chat.doc.toggle', 'Modo documento — texto angosto, justificado y serif')}"
            aria-pressed="false">${icon('docMode', { size: 15 })}</button>
          ${helpBtn('chat')}
        </header>
        <div class="hito-toast-host" aria-live="polite" aria-atomic="true"></div>
        <div class="chat-body">
          <div class="chat-main">
            <details class="chat-acta" hidden>
              <summary class="chat-acta-head">
                <span class="chat-acta-label">${t('chat.sala.actaLabel', 'Acta de la sala')}</span>
                <span class="chat-acta-meta">
                  <span class="chat-acta-stale" hidden>${t('chat.sala.actaStale', 'Puede estar desactualizada')}</span>
                  <time class="chat-acta-at" hidden></time>
                </span>
              </summary>
              <div class="chat-acta-body"></div>
            </details>
            <div class="chat-msgs"></div>
          </div>
          <aside class="chat-raw" hidden>
            <header class="chat-raw-head">
              <span class="chat-raw-title"></span>
              <button type="button" class="btn-ghost btn--icon chat-raw-close" title="${t('chat.raw.close', 'Cerrar el detalle')}">${icon('close', { size: 14 })}</button>
            </header>
            <div class="chat-raw-body"></div>
          </aside>
        </div>
        <div class="chat-atttray" hidden></div>
        <div class="chat-pending-prompt" hidden>
          <span>${t('chat.orchestrate.pendingNotice', 'Este texto llegó de una sala de Aduana y se envía cuando vos quieras.')}</span>
          <button type="button" class="btn-ghost btn--sm chat-pending-prompt-dismiss">${t('chat.orchestrate.discard', 'Descartar')}</button>
        </div>
        <div class="chat-replybar" hidden>
          <span class="chat-replybar-copy">
            <span class="chat-quote-author"></span>
            <span class="chat-replybar-text"></span>
          </span>
          <button type="button" class="btn-ghost btn--icon chat-replybar-dismiss" title="${t('chat.sala.cancelReplyTitle', 'Cancelar respuesta')}">${icon('close', { size: 13 })}</button>
        </div>
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

    this.titleEl = container.querySelector('.chat-title');
    this.titleEl.title = this.title;
    this.worldEl = container.querySelector('.chat-world');
    this.prToastHost = container.querySelector('.hito-toast-host');
    this._onPrVisibility = () => this._drainPrMilestones();
    document.addEventListener('visibilitychange', this._onPrVisibility);
    this.peersEl = container.querySelector('.chat-peers');
    this.visadoBtn = container.querySelector('.chat-visado-btn');
    this.visadoBtn.addEventListener('click', () => {
      if (!this.salaId) return;
      openPeticionDialog({ salaId: this.salaId, onDone: () => {} });
    });
    this.previewBtn = container.querySelector('.chat-preview-btn');
    this.previewLabelEl = this.previewBtn.querySelector('span');
    this.previewBtn.addEventListener('click', () => {
      const env = this._previewEnv;
      if (!env?.alive || env.status !== 'serving' || !env.enterUrl) return;
      window.open(env.enterUrl, '_blank', 'noopener');
    });
    this.actaEl = container.querySelector('.chat-acta');
    this.actaBodyEl = container.querySelector('.chat-acta-body');
    this.actaAtEl = container.querySelector('.chat-acta-at');
    this.actaStaleEl = container.querySelector('.chat-acta-stale');
    this.msgsEl = container.querySelector('.chat-msgs');
    this.rawEl = container.querySelector('.chat-raw');
    this.rawBodyEl = container.querySelector('.chat-raw-body');
    this.rawTitleEl = container.querySelector('.chat-raw-title');
    container.querySelector('.chat-raw-close').addEventListener('click', () => this._rawClose());
    // Un diagrama Mermaid renderiza asíncrono (después de que su mensaje ya
    // está en el DOM) y puede crecer la burbuja — re-anclar abajo, mismo
    // criterio "siempre pinea al final" que usa _scroll() en todo el resto.
    this.msgsEl.addEventListener('cwc:mermaid-rendered', () => this._scroll());
    // Teclado móvil: al abrirse, #app se achica al viewport visible (main.js) y
    // esta lista pierde alto sin mover su scrollTop → los últimos mensajes
    // quedaban tapados. Si ANTES del cambio de alto estábamos al final (medido
    // con el alto previo, sin depender del orden de eventos), re-anclamos.
    this._msgsH = this.msgsEl.clientHeight;
    if (typeof ResizeObserver === 'function') {
      this._msgsResizeObs = new ResizeObserver(() => {
        const el = this.msgsEl;
        if (!el) return;
        const prevH = this._msgsH;
        this._msgsH = el.clientHeight;
        if (prevH && el.clientHeight !== prevH && el.scrollHeight - el.scrollTop - prevH < 80) this._scroll();
      });
      this._msgsResizeObs.observe(this.msgsEl);
    }
    this.inputEl = container.querySelector('.chat-input');
    // BUG-498: el borrador NO debe perderse en una reconexión/rebuild del pane.
    // El value del textarea vive SOLO en el DOM; lo respaldamos en localStorage por
    // id de chat → sobrevive incluso a un `new ChatTab` (misma clave por this.id).
    this._draftKey = `cwc:chat-draft:${this.id}`;
    this._pendingDraftKey = `cwc:chat-pending-prompt:${this.id}`;
    try {
      const d = localStorage.getItem(this._draftKey);
      if (d) { this.inputEl.value = d; requestAnimationFrame(() => this._autosize()); }
      this._pendingPromptActive = localStorage.getItem(this._pendingDraftKey) === '1';
    } catch { /* localStorage no disponible: sin respaldo, no rompe */ }
    this.sendBtn = container.querySelector('.chat-send');
    this.cutBtn = container.querySelector('.chat-cut-btn');
    this.stopBtn = container.querySelector('.chat-stop');
    this.typingEl = container.querySelector('.chat-typing');
    this.modeEl = container.querySelector('.chat-mode');
    this.docModeBtn = container.querySelector('.chat-doc-toggle');
    const popoutBtn = container.querySelector('.chat-popout');
    if (popoutBtn) {
      popoutBtn.addEventListener('click', () => {
        // En una ventana ya desanclada el botón lleva a la consola completa;
        // en el shell, desancla esta conversación.
        if (this.soloMode) window.open('/', 'cwc-main')?.focus();
        else this.onPopout?.();
      });
    }
    this._onDocMode = (event) => this._applyDocMode(Boolean(event.detail?.on));
    window.addEventListener(DOC_MODE_EVENT, this._onDocMode);
    let docModeOn = document.body.classList.contains('doc-mode');
    try { docModeOn = localStorage.getItem(DOC_MODE_STORAGE_KEY) === '1'; } catch { /* sin persistencia */ }
    this._applyDocMode(docModeOn);
    this.docModeBtn.addEventListener('click', () => {
      const on = !document.body.classList.contains('doc-mode');
      try { localStorage.setItem(DOC_MODE_STORAGE_KEY, on ? '1' : '0'); } catch { /* sin persistencia */ }
      window.dispatchEvent(new CustomEvent(DOC_MODE_EVENT, { detail: { on } }));
    });
    this.aliveEl = container.querySelector('.chat-alive');
    this.modelPillEl = container.querySelector('.chat-model-pill');
    this.flowEl = container.querySelector('.chat-flow');
    this.attachBtn = container.querySelector('.chat-attach');
    this.pkgRefBtn = container.querySelector('.chat-pkgref');
    this.pkgRefBtn?.addEventListener('click', () => this._openPackagePicker());
    this.fileInput = container.querySelector('.chat-file-input');
    this.trayEl = container.querySelector('.chat-atttray');
    this.pendingPromptEl = container.querySelector('.chat-pending-prompt');
    this.pendingPromptEl.querySelector('.chat-pending-prompt-dismiss').addEventListener('click', () => {
      this._discardPendingPrompt();
    });
    this.replyBarEl = container.querySelector('.chat-replybar');
    this.replyAuthorEl = this.replyBarEl.querySelector('.chat-quote-author');
    this.replyTextEl = this.replyBarEl.querySelector('.chat-replybar-text');
    this.replyBarEl.querySelector('.chat-replybar-dismiss').addEventListener('click', () => {
      this._clearReply();
    });

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
      if (this._slashKeydown(e)) return; // slash o @ consumió la tecla
      if (e.key === 'Escape' && !this.inputEl.value.trim() && this._replyTo) {
        e.preventDefault();
        e.stopPropagation();
        this._clearReply();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this._submit();
      }
    });
    // Esc cierra el panel lateral de tool calls. El Esc
    // del popup de comandos slash se maneja antes (captura en dismissablePopup).
    this.container.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      let closed = false;
      if (this._rawGroup) {
        this._rawClose();
        closed = true;
      }
      if (closed) e.stopPropagation();
    });
    // Autogrow del textarea (hasta ~6 líneas) + autocompletado slash/@.
    this.inputEl.addEventListener('input', () => {
      this._autosize();
      this._slashUpdate(); // en sala también detecta @query justo antes del cursor
      // BUG-498: respaldar el borrador en cada tecla (barato; cubre reconexión,
      // disable y reconstrucción total del pane).
      try { localStorage.setItem(this._draftKey, this.inputEl.value); } catch { /* noop */ }
      this._sendTyping();
    });

    fetch('/api/whoami', { cache: 'no-store' })
      .then((res) => res.json())
      .then((me) => {
        this.me = me?.username || me?.host || null;
        if (this.isSala) this._rebuildAvatarKeys();
        this._refreshSalaIdentity();
        if (this._slashPop && this._slashKind === 'mention') this._slashUpdate();
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
    const mention = this._mentionQuery();
    if (this._slashPop) {
      if (this._slashKind === 'slash') {
        if (q == null) this._slashClose();
        else this._slashRender(q);
      } else if (this._slashKind === 'mention') {
        if (mention == null) this._slashClose();
        else this._mentionRender(mention);
      }
      return;
    }
    if (q != null) {
      this._slashOpen('slash');
      this._slashRender(q);
    } else if (mention != null) {
      this._slashOpen('mention');
      this._mentionRender(mention);
    }
  }

  _mentionQuery() {
    if (!this.isSala) {
      this._mentionSuppressed = null;
      return null;
    }
    const start = this.inputEl.selectionStart;
    const end = this.inputEl.selectionEnd;
    if (start == null || end == null || start !== end) return null;
    const before = this.inputEl.value.slice(0, start);
    const match = before.match(/(?:^| )@([A-Za-z0-9._-]*)$/);
    if (!match) {
      this._mentionSuppressed = null;
      return null;
    }
    const at = match.index + (match[0][0] === ' ' ? 1 : 0);
    const signature = `${this.inputEl.value}\u0000${start}`;
    if (this._mentionSuppressed === signature) return null;
    return { query: match[1].toLocaleLowerCase(), start: at, end: start, signature };
  }

  _slashOpen(kind = 'slash') {
    this._slashActive = 0; // el popup nace resaltando la mejor coincidencia
    this._slashKind = kind;
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
          if (kind === 'mention') {
            this._mentionSuppressed = `${this.inputEl.value}\u0000${this.inputEl.selectionStart}`;
          } else {
            this._slashSuppressed = this.inputEl.value;
          }
          this._slashPop = null;
          this._slashDismiss = null;
          this._slashKind = null;
          this._mentionRange = null;
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
    this._slashKind = null;
    this._mentionRange = null;
    this._slashItems = [];
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

  _mentionRender(match) {
    const pop = this._slashPop;
    if (!pop) return;
    const query = match.query;
    this._mentionRange = { start: match.start, end: match.end };
    const aiName = String(this.salaAiName || 'cucho');
    const aiNameLower = aiName.toLocaleLowerCase();
    const humans = this._salaUsers()
      .filter((username) => username.toLocaleLowerCase() !== aiNameLower)
      .sort((a, b) => a.localeCompare(b))
      .filter((username) => username.toLocaleLowerCase().startsWith(query));
    this._slashItems = aiNameLower.startsWith(query) ? [aiName, ...humans] : humans;
    this._slashActive = 0;
    pop.replaceChildren();
    if (!this._slashItems.length) {
      this._slashClose();
      return;
    }
    this._slashItems.forEach((username, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'chat-slash-item' + (i === this._slashActive ? ' active' : '');
      const isAi = username.toLocaleLowerCase() === aiNameLower;
      if (isAi) {
        const avatar = document.createElement('span');
        avatar.className = 'csi-ai-avatar';
        avatar.textContent = '✦';
        avatar.setAttribute('aria-hidden', 'true');
        row.appendChild(avatar);
      } else {
        row.appendChild(this._avatarNodeFor(username, { size: 18 }));
      }
      const name = document.createElement('span');
      name.className = 'csi-name';
      name.textContent = username;
      row.appendChild(name);
      if (isAi) {
        const desc = document.createElement('span');
        desc.className = 'csi-desc';
        desc.textContent = t('chat.sala.aiMentionDescription', 'la IA de la sala');
        row.appendChild(desc);
      }
      row.addEventListener('click', () => this._slashPick(username));
      pop.appendChild(row);
    });
    this._slashFit();
  }

  _slashPick(c) {
    const kind = this._slashKind;
    const mentionRange = this._mentionRange;
    this._slashClose();
    this._slashSuppressed = null;
    this._mentionSuppressed = null;
    if (kind === 'mention' && mentionRange) {
      const before = this.inputEl.value.slice(0, mentionRange.start);
      const after = this.inputEl.value.slice(mentionRange.end);
      this.inputEl.value = `${before}@${c} ${after}`;
      const cursor = before.length + String(c).length + 2;
      this.inputEl.focus();
      this.inputEl.setSelectionRange(cursor, cursor);
      this._autosize();
    } else {
      this.inputEl.value = `/${c.name} `;
      this.inputEl.focus();
      this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
    }
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
    // En una sala también se puede enviar solo un adjunto.
    if (this.pending.some((p) => p.uploading)) return; // esperar a que terminen de subir
    this._slashClose();
    this._slashSuppressed = null;
    const attachments = ready.map((p) => ({ name: p.name, type: p.type, mime: p.mime }));
    const reply = this.isSala && this._replyTo ? { ...this._replyTo } : {};
    if (this.isSala) this._send({ type: 'say', text, ...(attachments.length ? { attachments } : {}), ...reply });
    else this._send({ type: 'user', text, ...(attachments.length ? { attachments } : {}) });
    if (this.isSala) this._clearReply();
    for (const p of this.pending) { if (p.localUrl) URL.revokeObjectURL(p.localUrl); }
    this.pending = [];
    this._renderTray();
    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';
    try { localStorage.removeItem(this._draftKey); } catch { /* noop */ } // BUG-498: enviado OK → sin borrador
    if (this._pendingPromptActive) this._clearPendingPrompt();
    // En táctil, enviar CIERRA el teclado (blur): dejarlo abierto tapaba media
    // conversación justo cuando llega la respuesta. En desktop seguimos con el
    // foco en el input para encadenar mensajes sin clic.
    if (window.matchMedia('(pointer: coarse)').matches) this.inputEl.blur();
    else this.inputEl.focus();
  }

  _applyPendingPrompt(prompt) {
    const text = typeof prompt === 'string' ? prompt : '';
    if (!text.trim()) {
      this._setPendingPromptActive(false);
      return;
    }
    // Un marcador local conserva el aviso si la vista se reconstruyó mientras
    // la persona editaba el texto precargado. Sin ese marcador, un composer no
    // vacío es un borrador propio y jamás se pisa ni se reclama como pendiente.
    if (!this._pendingPromptActive && this.inputEl.value) {
      this.pendingPromptEl.hidden = true;
      return;
    }
    if (!this.inputEl.value) {
      this.inputEl.value = text;
      requestAnimationFrame(() => this._autosize());
    }
    this._setPendingPromptActive(true);
  }

  _setPendingPromptActive(active) {
    this._pendingPromptActive = !!active;
    if (this.pendingPromptEl) this.pendingPromptEl.hidden = !this._pendingPromptActive;
    try {
      if (this._pendingPromptActive) localStorage.setItem(this._pendingDraftKey, '1');
      else localStorage.removeItem(this._pendingDraftKey);
    } catch { /* localStorage no disponible: el estado en memoria alcanza */ }
  }

  async _clearPendingPrompt({ clearInput = false } = {}) {
    if (clearInput) {
      this.inputEl.value = '';
      this.inputEl.style.height = 'auto';
      try { localStorage.removeItem(this._draftKey); } catch { /* noop */ }
    }
    this._setPendingPromptActive(false);
    try {
      const res = await fetch('/api/chat/pending-prompt/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: this.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.error || t('chat.orchestrate.clearFailFallback', 'No se pudo limpiar la instrucción pendiente.'));
      }
    } catch (err) {
      this._line('chat-error', t('chat.orchestrate.clearFail', 'No se pudo limpiar la instrucción pendiente: {message}', {
        message: String(err?.message || err),
      }));
    }
  }

  _discardPendingPrompt() {
    if (!this._pendingPromptActive) return;
    this._clearPendingPrompt({ clearInput: true });
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
        this.salaId = m.salaId || null;
        this.participants = Array.isArray(m.participants) ? m.participants : [];
        this.salaOwner = m.salaOwner || null;
        if (m.salaAiName) this.salaAiName = String(m.salaAiName);
        if (m.salaAiLabel) this.salaAiLabel = String(m.salaAiLabel);
        if (this.isSala) this._rebuildAvatarKeys();
        this._renderActa(m.acta);
        this._unreadAtOpen = this.isSala ? (m.salaUnread || 0) : 0;
        this._newSepEl = null;
        this._lastSayTs = null;
        this._lastDaySepKey = null;
        this._lastReadTs = null;
        this._readGeneration++;
        clearTimeout(this._markReadTimer);
        this._markReadTimer = null;
        this._markReadQueuedTs = null;
        this._salaSayCount = 0;
        this._salaAskCount = 0;
        this._cutPending = false;
        this._lastCutAuthors = [];
        this._orchestratedChatIds.clear();
        this._subsalaChatIds.clear();
        this._streamRaw = '';
        this._streamAddresseesResolved = false;
        this._clearTyping();
        this._renderSalaState();
        this.msgsEl.innerHTML = '';
        // El índice apunta a grupos que acaban de desaparecer del DOM.
        this._toolIndex.clear();
        this._rawClose();
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
        this._historyRendering = this.isSala;
        this._historySayIndex = 0;
        this._historySayTotal = this.isSala ? m.events.filter((ev) => ev?.type === 'say').length : 0;
        for (const ev of m.events) this._onEvent(ev);
        this._historyRendering = false;
        this._applyPendingPrompt(m.pendingPrompt);
        if (this.isSala && this._unreadAtOpen === 0) this._lastReadTs = this._lastSayTs;
        if (this.isSala && this._unreadAtOpen > 0 && document.visibilityState === 'visible') this._markRead();
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
        this._enqueuePrMilestones(m.prMilestones);
        this._sendInitialPrompt();
        // Historial renderizado: destraba al splash de arranque (ver arriba).
        this._readyResolve?.();
        this._readyResolve = null;
        break;
      case 'meta':
        this.slashCommands = Array.isArray(m.slashCommands) ? m.slashCommands : [];
        this._metaSeen = true;
        if (this._slashPop && this._slashKind === 'slash') this._slashUpdate(); // refresco en vivo si está abierto
        break;
      case 'say': {
        const markAfterPaint = !this._historyRendering
          && this.isSala
          && document.visibilityState === 'visible'
          && this._isNearMessagesBottom();
        this._say(m);
        if (markAfterPaint) this._markRead();
        break;
      }
      case 'react': this._react(m); break;
      case 'cut': this._cut(m); break;
      case 'acta': this._renderActa(m); break;
      case 'orquestado': this._orquestado(m); break;
      case 'subsala': this._subsala(m); break;
      case 'eco': this._eco(m); break;
      case 'origin': this._origin(m); break;
      case 'cut-pending':
        this._cutPending = true;
        this._renderCutButton();
        break;
      case 'typing': this._typing(m); break;
      case 'participants':
        this.participants = Array.isArray(m.participants) ? m.participants : [];
        this.salaOwner = m.salaOwner || null;
        if (this.isSala) this._rebuildAvatarKeys();
        this._refreshSalaIdentity();
        if (this._slashPop && this._slashKind === 'mention') this._slashUpdate();
        break;
      case 'user': this._closeStream(); this._bubble('user', m.text, m.attachments, m.by, m.ts); break;
      case 'assistant': this._assistantFinal(m.text, m.ts); break;
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
      case 'pr-milestone':
        this._enqueuePrMilestones([m.milestone]);
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

  // ===== Fecha y hora del mensaje (estilo WhatsApp) =====
  // Dos piezas: un separador que corta el hilo cuando cambia el día, y la
  // hora al pie de cada mensaje. Sin `ts` no se pinta nada: un evento viejo
  // (anterior al matasellos del server) prefiere no decir nada a mentir.
  _dayKey(ts) {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return null;
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }

  _dayLabel(ts) {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return '';
    const key = this._dayKey(ts);
    const now = new Date();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (key === this._dayKey(now.getTime())) return t('chat.day.today', 'Hoy');
    if (key === this._dayKey(yesterday.getTime())) return t('chat.day.yesterday', 'Ayer');
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // Inserta el separador de día si este mensaje cae en un día distinto al
  // del último pintado. Cuelga de .chat-msgs (no de un grupo): así corta
  // también el grupo de la IA y el de un autor de sala, que es lo correcto.
  _maybeDaySep(ts) {
    if (ts == null) return;
    const key = this._dayKey(ts);
    if (!key || key === this._lastDaySepKey) return;
    const sep = document.createElement('div');
    sep.className = 'chat-day-sep';
    sep.textContent = this._dayLabel(ts);
    this.msgsEl.appendChild(sep);
    this._lastDaySepKey = key;
  }

  _timeTag(ts) {
    const time = ts == null ? '' : this._localTime(ts);
    if (!time) return null;
    const el = document.createElement('span');
    el.className = 'chat-msg-time';
    el.textContent = time;
    return el;
  }

  _renderActa(acta) {
    if (!this.actaEl) return;
    const text = typeof acta?.text === 'string' ? acta.text : '';
    if (!this.isSala || !text.trim()) {
      this.actaEl.hidden = true;
      this.actaBodyEl.replaceChildren();
      return;
    }

    const wasOpen = this.actaEl.open;
    const localAt = this._localTime(acta?.at);
    this.actaBodyEl.replaceChildren(renderMarkdown(text));
    this.actaAtEl.textContent = localAt
      ? t('chat.sala.actaUpdated', 'Actualizada {time}', { time: localAt })
      : '';
    this.actaAtEl.hidden = !localAt;
    this.actaStaleEl.hidden = !acta?.stale;
    this.actaEl.classList.toggle('chat-acta--stale', !!acta?.stale);
    this.actaEl.hidden = false;
    this.actaEl.open = wasOpen;
  }

  _salaUsers() {
    const users = this.participants.map((participant) => String(participant?.user || '')).filter(Boolean);
    // El dueño NO viaja en participants (contrato de chat/index.js l.846). Sin
    // agregarlo acá, ningún invitado puede mencionar al anfitrión — y, peor, cada
    // navegador armaba los avatares con un set distinto y se cruzaban.
    if (this.salaOwner) users.push(String(this.salaOwner));
    if (this.me) users.push(String(this.me));
    return [...new Set(users)];
  }

  _rebuildAvatarKeys() {
    this._avatarKeys = new Map();
    const taken = [];
    // Sin este orden canónico, dos navegadores desempatarían las colisiones
    // en distinto orden y terminarían viendo los avatares cruzados.
    const users = this._salaUsers().sort((a, b) => a.localeCompare(b));
    for (const username of users) {
      const avatar = avatarFor(username, { taken });
      this._avatarKeys.set(username, avatar);
      taken.push(avatar.key);
    }
  }

  _avatarKeyFor(username) {
    const name = String(username || '');
    let avatar = this._avatarKeys.get(name);
    if (!avatar) {
      const taken = [...this._avatarKeys.values()].map((entry) => entry.key);
      avatar = avatarFor(name, { taken });
      this._avatarKeys.set(name, avatar);
    }
    return avatar;
  }

  _avatarNodeFor(username, { size = 22, title = '' } = {}) {
    const name = String(username || '');
    const assigned = this._avatarKeyFor(name);
    let el = null;
    try {
      el = avatarNodeFrom(assigned, { size, title });
    } catch {
      // Las iniciales conservan la identidad mínima si falla el avatar visual.
    }
    if (el?.classList) return el;
    const fallback = document.createElement('span');
    const px = Number.isFinite(Number(size)) && Number(size) > 0 ? Number(size) : 22;
    fallback.className = `cwc-avatar ${assigned.tone}`;
    fallback.style.width = `${px}px`;
    fallback.style.height = `${px}px`;
    fallback.title = title;
    const parts = name.trim().split(/\s+/).filter(Boolean);
    fallback.textContent = ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
    return fallback;
  }

  _sayTextNodes(text, mentions, askAi = false) {
    const fragment = document.createDocumentFragment();
    const raw = String(text ?? '');
    const names = [...new Set(
      [
        ...(Array.isArray(mentions) ? mentions : []),
        ...(askAi ? [this.salaAiName] : []),
      ].map((username) => String(username || '')).filter(Boolean),
    )].sort((a, b) => b.length - a.length);
    if (!names.length) {
      fragment.appendChild(document.createTextNode(raw));
      return fragment;
    }

    const escaped = names.map((username) => username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const mentionRe = new RegExp(`(^|[^A-Za-z0-9._-])@(${escaped.join('|')})(?![A-Za-z0-9._-])`, 'gi');
    let cursor = 0;
    let match;
    while ((match = mentionRe.exec(raw)) !== null) {
      const username = names.find((name) => name.toLowerCase() === match[2].toLowerCase());
      if (!username) continue;
      const mentionStart = match.index + match[1].length;
      if (mentionStart > cursor) fragment.appendChild(document.createTextNode(raw.slice(cursor, mentionStart)));
      const span = document.createElement('span');
      const isAi = askAi && username === this.salaAiName;
      span.className = isAi
        ? 'chat-mention chat-mention--ai'
        : `chat-mention ${this._avatarKeyFor(username).tone}`;
      span.classList.toggle('chat-mention--me', !isAi && !!this.me && username === this.me);
      span.dataset.username = username;
      if (isAi) span.dataset.ai = 'true';
      span.textContent = `@${match[2]}`;
      fragment.appendChild(span);
      cursor = mentionStart + username.length + 1;
    }
    if (cursor < raw.length) fragment.appendChild(document.createTextNode(raw.slice(cursor)));
    return fragment;
  }

  _say(m) {
    if (!this.isSala) return;
    this._maybeDaySep(m.ts);
    if (this._historyRendering) {
      const unread = Math.min(this._historySayTotal, Math.max(0, Number(this._unreadAtOpen) || 0));
      if (!this._newSepEl && unread > 0 && this._historySayIndex === this._historySayTotal - unread) {
        const sep = document.createElement('div');
        sep.className = 'chat-newline-sep';
        sep.textContent = t('chat.sala.newMessages', 'mensajes nuevos');
        this.msgsEl.appendChild(sep);
        this._newSepEl = sep;
      }
      this._historySayIndex++;
    }
    const by = String(m.by || '');
    const avatar = this._avatarKeyFor(by);
    const last = this.msgsEl.lastElementChild;
    let group = last?.classList.contains('chat-say-group') && last.dataset.by === by ? last : null;
    if (!group) {
      group = document.createElement('div');
      group.className = `chat-say-group ${avatar.tone}`;
      group.dataset.by = by;
      group.classList.toggle('chat-say-group--own', !!this.me && by === this.me);

      const head = document.createElement('div');
      head.className = 'chat-say-group-head';
      const title = t('chat.sala.participantTitle', 'Participante: {name}', { name: by });
      const avatarNode = this._avatarNodeFor(by, { size: 22, title });
      const label = document.createElement('span');
      label.className = 'chat-say-label';
      label.textContent = t('chat.sala.sayLabel', '{name}', { name: by });
      head.append(avatarNode, label);
      group.appendChild(head);
      this.msgsEl.appendChild(group);
    }

    const el = document.createElement('div');
    el.className = `chat-msg chat-say ${avatar.tone}`;
    el.dataset.by = by;
    el.dataset.msgId = String(m.id ?? '');
    el.dataset.askAi = m.askAi ? 'true' : 'false';
    el.classList.toggle('chat-say--own', !!this.me && by === this.me);
    el.classList.toggle('chat-say--ask-ai', !!m.askAi);
    if (m.askAi) {
      el.title = t('chat.sala.askMessageTitle', 'Pregunta para {name}', { name: this.salaAiLabel });
    }
    if (group.children.length > 1) el.classList.add('chat-say--cont');

    if (m.replyTo) {
      const replyToBy = String(m.replyToBy || '');
      const quote = document.createElement('div');
      quote.className = `chat-quote ${this._avatarKeyFor(replyToBy).tone}`;

      const quoteAuthor = document.createElement('span');
      quoteAuthor.className = 'chat-quote-author';
      quoteAuthor.textContent = replyToBy;
      const quoteText = document.createElement('span');
      quoteText.className = 'chat-quote-text';
      quoteText.textContent = String(m.replyToText || '').slice(0, 100);
      quote.append(quoteAuthor, quoteText);

      const quotedSay = this._findSay(m.replyTo);
      if (quotedSay) {
        quote.classList.add('chat-quote--link');
        quote.tabIndex = 0;
        quote.setAttribute('role', 'button');
        quote.title = t('chat.sala.quoteJumpTitle', 'Ir al mensaje citado');
        const jump = () => this._flashSay(quotedSay);
        quote.addEventListener('click', jump);
        quote.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          jump();
        });
      }
      el.appendChild(quote);
    }

    const body = document.createElement('span');
    body.className = 'chat-say-text';
    body.appendChild(this._sayTextNodes(m.text || '', m.mentions, !!m.askAi));
    if (typeof m.text === 'string' && m.text) el.appendChild(body);
    if (Array.isArray(m.attachments) && m.attachments.length) el.appendChild(this._attsEl(m.attachments));
    const timeTag = this._timeTag(m.ts);
    if (timeTag) el.appendChild(timeTag);
    el.appendChild(this._reactionRow(el.dataset.msgId, m.reactions));
    group.appendChild(el);
    if (m.ts != null) this._lastSayTs = m.ts;
    this._salaSayCount++;
    if (m.askAi) this._salaAskCount++;
    this._renderCutButton();
    this._scroll();
  }

  _normalizedReactions(reactions) {
    const normalized = new Map();
    for (const { emoji } of SALA_REACTIONS) {
      const rawUsers = reactions && typeof reactions === 'object' ? reactions[emoji] : null;
      const users = Array.isArray(rawUsers)
        ? [...new Set(rawUsers.map((username) => String(username || '')).filter(Boolean))]
        : [];
      normalized.set(emoji, users);
    }
    return normalized;
  }

  _reactionRow(msgId, reactions) {
    const row = document.createElement('div');
    row.className = 'chat-reacts';
    row._reactions = this._normalizedReactions(reactions);
    row.dataset.msgId = msgId;
    this._renderReactions(row);
    return row;
  }

  _renderReactions(row) {
    if (!row?._reactions) return;
    const fragment = document.createDocumentFragment();
    for (const { emoji } of SALA_REACTIONS) {
      const users = row._reactions.get(emoji) || [];
      if (!users.length) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-react';
      button.classList.toggle('chat-react--mine', !!this.me && users.includes(this.me));
      button.title = users.join(', ');
      button.setAttribute('aria-label', `${emoji}: ${users.join(', ')}`);
      const mark = document.createElement('span');
      mark.textContent = emoji;
      const count = document.createElement('span');
      count.className = 'chat-react-count';
      count.textContent = String(users.length);
      button.append(mark, count);
      button.addEventListener('click', () => this._toggleReaction(row.dataset.msgId, emoji));
      fragment.appendChild(button);
    }
    // Filtra los usados: sin esto se duplican como pastilla e invitación.
    for (const { emoji, labelKey, label } of SALA_REACTIONS) {
      const users = row._reactions.get(emoji) || [];
      if (users.length) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chat-react chat-react--add';
      button.textContent = emoji;
      const reactionLabel = t(labelKey, label);
      button.title = `${emoji} ${reactionLabel}`;
      button.setAttribute('aria-label', `${emoji} ${reactionLabel}`);
      button.addEventListener('click', () => this._toggleReaction(row.dataset.msgId, emoji));
      fragment.appendChild(button);
    }
    const reply = document.createElement('button');
    reply.type = 'button';
    reply.className = 'chat-react chat-react--reply';
    reply.innerHTML = icon('externalLink', { size: 13 });
    const replyLabel = t('chat.sala.replyTitle', 'Responder citando este mensaje');
    reply.title = replyLabel;
    reply.setAttribute('aria-label', replyLabel);
    reply.addEventListener('click', () => this._startReply(row.dataset.msgId));
    fragment.appendChild(reply);
    row.replaceChildren(fragment);
  }

  _findSay(msgId) {
    const wanted = String(msgId ?? '');
    if (!wanted) return null;
    for (const el of this.msgsEl?.querySelectorAll('.chat-say[data-msg-id]') || []) {
      if (el.dataset.msgId === wanted) return el;
    }
    return null;
  }

  _startReply(msgId) {
    if (!this.isSala) return;
    const say = this._findSay(msgId);
    if (!say) return;
    const replyToBy = String(say.dataset.by || '');
    const replyToText = String(say.querySelector('.chat-say-text')?.textContent || '').trim().slice(0, 100);
    this._replyTo = { replyTo: String(msgId), replyToBy, replyToText };
    this.replyAuthorEl.className = `chat-quote-author ${this._avatarKeyFor(replyToBy).tone}`;
    this.replyAuthorEl.textContent = replyToBy;
    this.replyTextEl.textContent = replyToText;
    this.replyBarEl.hidden = false;
    this.inputEl.focus();
  }

  _clearReply() {
    this._replyTo = null;
    if (!this.replyBarEl) return;
    this.replyBarEl.hidden = true;
    this.replyAuthorEl.textContent = '';
    this.replyTextEl.textContent = '';
  }

  _flashSay(say) {
    say.scrollIntoView({ block: 'center' });
    say.classList.remove('chat-say--flash');
    void say.offsetWidth;
    say.classList.add('chat-say--flash');
    clearTimeout(say._flashTimer);
    say._flashTimer = setTimeout(() => {
      say.classList.remove('chat-say--flash');
      say._flashTimer = null;
    }, 1200);
  }

  _toggleReaction(msgId, emoji) {
    if (!this.isSala || !SALA_REACTION_EMOJIS.has(emoji)) return;
    const say = this._findSay(msgId);
    const row = say?.querySelector('.chat-reacts');
    if (!row) return;
    if (this.me) {
      const users = row._reactions.get(emoji) || [];
      row._reactions.set(
        emoji,
        users.includes(this.me) ? users.filter((username) => username !== this.me) : [...users, this.me],
      );
      this._renderReactions(row);
    }
    this._send({ type: 'react', msgId: String(msgId), emoji });
  }

  _react(m) {
    if (!this.isSala || !SALA_REACTION_EMOJIS.has(m.emoji)) return;
    const say = this._findSay(m.msgId);
    const row = say?.querySelector('.chat-reacts');
    const by = String(m.by || '');
    if (!row || !by) return;
    const users = row._reactions.get(m.emoji) || [];
    row._reactions.set(
      m.emoji,
      m.off
        ? users.filter((username) => username !== by)
        : (users.includes(by) ? users : [...users, by]),
    );
    this._renderReactions(row);
  }

  _cut(m) {
    if (!this.isSala) return;
    this._lastCutAuthors = Array.isArray(m.authors) && m.authors.length ? m.authors : (m.by ? [m.by] : []);
    const el = document.createElement('div');
    el.className = 'chat-cut';
    el.textContent = t('chat.sala.cutLine', '✂ {name} envió a la IA · {time}', {
      name: String(m.by || ''),
      time: this._localTime(m.ts),
    });
    this.msgsEl.appendChild(el);
    if (m.directed) {
      this._salaSayCount = Math.max(0, this._salaSayCount - (Number(m.count) || 0));
    } else {
      this._salaSayCount = 0;
    }
    this._salaAskCount = 0;
    this._cutPending = false;
    this._renderCutButton();
    this._scroll();
  }

  _orquestado(m) {
    if (!this.isSala) return;
    const chatId = String(m.chatId || '');
    if (chatId && this._orchestratedChatIds.has(chatId)) return;
    if (chatId) this._orchestratedChatIds.add(chatId);
    const rawWorld = String(m.world || '').trim();
    const knownWorld = placeFor(rawWorld) || PLACES.find((place) => place.label === rawWorld);
    const world = knownWorld?.label || rawWorld || t('chat.orchestrate.unknownWorld', 'otro mundo');
    const by = String(m.by || '').trim() || t('chat.orchestrate.unknownPerson', 'alguien');
    const el = document.createElement('div');
    el.className = 'chat-orquestado';
    el.textContent = t('chat.orchestrate.threadLine', '⇱ {name} orquestó esto a {world} · {time}', {
      name: by,
      world,
      time: this._localTime(m.ts),
    });
    this.msgsEl.appendChild(el);
    this._scroll();
  }

  _openRelatedChat(chatId) {
    const id = String(chatId || '').trim();
    if (!id) return;
    const key = `chat:${id}`;
    const card = [...document.querySelectorAll('.sess-card[data-key]')]
      .find((candidate) => candidate.dataset.key === key);
    const main = card?.querySelector('.sess-main');
    if (main) {
      main.click(); // Camino normal de Sesiones: openChatView + foco si ya existe.
      return;
    }
    // En una ventana `?solo=` no existe el panel de Sesiones. El shell ya
    // soporta `?focus=<id>` y la ventana principal tiene nombre estable.
    const href = `/?focus=${encodeURIComponent(id)}`;
    if (this.soloMode) window.open(href, 'cwc-main')?.focus();
    else window.location.assign(href);
  }

  _subsala(m) {
    if (!this.isSala) return;
    const chatId = String(m.chatId || '').trim();
    if (chatId && this._subsalaChatIds.has(chatId)) return;
    if (chatId) this._subsalaChatIds.add(chatId);
    const by = String(m.by || '').trim() || t('chat.sala.subsalaUnknownPerson', 'alguien');
    const title = String(m.title || '').trim() || t('chat.sala.subsalaUnknownTitle', 'Sin título');
    const ref = String(m.ref || '').trim();
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'chat-subsala';
    el.textContent = t('chat.sala.subsalaLine', '🛃 {name} abrió la sub-sala «{title}» · {time}', {
      name: by,
      title,
      time: this._localTime(m.ts),
    }) + (ref ? t('chat.sala.subsalaRefSuffix', ' · {ref}', { ref }) : '');
    if (chatId) el.addEventListener('click', () => this._openRelatedChat(chatId));
    else el.disabled = true;
    this.msgsEl.appendChild(el);
    this._scroll();
  }

  _eco(m) {
    if (!this.isSala) return;
    const from = String(m.from || '').trim();
    const fromTitle = String(m.fromTitle || '').trim() || t('chat.sala.ecoUnknownRoom', 'Sala sin título');
    const el = document.createElement('div');
    el.className = 'chat-eco';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'chat-eco-head';
    head.textContent = m.dir === 'down'
      ? t('chat.sala.ecoDownLine', '📨 La sala madre «{fromTitle}» escribió · {time}', { fromTitle, time: this._localTime(m.ts) })
      : t('chat.sala.ecoUpLine', '📨 «{fromTitle}» avisó · {time}', { fromTitle, time: this._localTime(m.ts) });
    if (from) head.addEventListener('click', () => this._openRelatedChat(from));
    else head.disabled = true;

    const body = document.createElement('div');
    body.className = 'chat-eco-body';
    if (m.text) body.appendChild(renderMarkdown(String(m.text)));
    el.append(head, body);
    if (m.wake === false) {
      const note = document.createElement('div');
      note.className = 'chat-eco-note';
      note.textContent = t('chat.sala.ecoNoWake', 'No despertó a Cucho: se alcanzó el tope de despertares automáticos');
      el.appendChild(note);
    }
    this.msgsEl.appendChild(el);
    this._salaSayCount++;
    this._renderCutButton();
    this._scroll();
  }

  _origin(m) {
    const world = String(m.fromWorld || '').trim() || t('chat.sala.originUnknownWorld', 'su mundo anterior');
    const by = String(m.by || '').trim() || t('chat.sala.originUnknownPerson', 'alguien');
    const time = this._localTime(m.ts) || t('chat.sala.originUnknownTime', 'hora desconocida');
    const el = document.createElement('div');
    el.className = 'chat-origin';
    el.textContent = t('chat.sala.originLine', '🛃 Esta conversación entró a la sala desde {world} · la trajo {name} · {time}', {
      world,
      name: by,
      time,
    });
    this.msgsEl.appendChild(el);
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
    if (this.inputEl) {
      this.inputEl.placeholder = this.isSala
        ? t('chat.sala.inputPlaceholder', 'Escribí a la sala… o @{name} para preguntarle', { name: this.salaAiName })
        : t('chat.composer.inputPlaceholder', 'Escribí o dictá un mensaje…');
    }
    this._renderPeers();
    this._renderCutButton();
    this._renderTyping();
  }

  _renderCutButton() {
    if (!this.cutBtn) return;
    this.cutBtn.hidden = !this.isSala;
    this.cutBtn.disabled = !this.isSala || this._salaSayCount === 0 || this._cutPending;
    if (this._cutPending) {
      this.cutBtn.textContent = t('chat.sala.cutPending', 'IA ocupada · queda pendiente');
    } else if (this._salaAskCount > 0) {
      this.cutBtn.textContent = t('chat.sala.askButton', '✦ Preguntarle a {name} ({count})', {
        name: this.salaAiLabel,
        count: this._salaAskCount,
      });
    } else {
      this.cutBtn.textContent = t('chat.sala.cutButton', '✦ Enviar a la IA ({count})', { count: this._salaSayCount });
    }
    this.cutBtn.title = this._salaAskCount > 0
      ? t('chat.sala.askButtonTitle', 'Solo viajan los mensajes tagueados para {name}; el resto queda esperando.', { name: this.salaAiLabel })
      : '';
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
      const title = t('chat.sala.participantTitle', 'Participante: {name}', { name: username });
      let chip;
      if (this.isSala) {
        chip = this._avatarNodeFor(username, { size: 22, title });
        chip.classList.add('chat-peer');
      } else {
        chip = document.createElement('span');
        chip.className = `chat-peer ${peerToneFor(username)}`;
        chip.title = title;
        const parts = username.trim().split(/\s+/).filter(Boolean);
        chip.textContent = ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
      }
      this.peersEl.appendChild(chip);
    }
    this.peersEl.hidden = !this.isSala || !this.peersEl.children.length;
    this.visadoBtn.hidden = !this.isSala || !this.salaId;
    if (this.isSala && this.salaId) this._startPreviewPolling();
    else this._stopPreviewPolling();
  }

  _previewVisible() {
    return this.container.classList.contains('active') && !document.hidden;
  }

  _renderPreview(env) {
    this._previewEnv = env || null;
    if (!env) {
      this.previewBtn.hidden = true;
      this.previewBtn.disabled = true;
      return;
    }

    const ready = env.alive && env.status === 'serving';
    this.previewBtn.hidden = false;
    this.previewBtn.disabled = !ready;
    this.previewLabelEl.textContent = ready
      ? t('chat.sala.previewLabel', 'Preview')
      : t('chat.sala.previewStarting', 'Preview: preparando…');
    const title = `${t('chat.sala.previewTitle', 'Abrir el preview de Tolkien de esta sala con tu propia identidad')} · ${t(
      'chat.sala.previewMeta',
      'rama {branch} · puerto {port}',
      { branch: env.branch || '—', port: env.port ?? '—' },
    )}`;
    this.previewBtn.title = title;
    this.previewBtn.setAttribute('aria-label', title);
  }

  async _refreshPreview() {
    if (!this.salaId || !this._previewVisible() || this._previewLoading) return;
    const salaId = this.salaId;
    const generation = this._previewGeneration;
    this._previewLoading = true;
    try {
      const data = await fetchPreview(salaId);
      if (this.closedByUser || generation !== this._previewGeneration || salaId !== this.salaId) return;
      this._renderPreview(data?.env || null);
    } catch {
      if (generation === this._previewGeneration) this._renderPreview(null);
    } finally {
      if (generation === this._previewGeneration) this._previewLoading = false;
    }
  }

  _stopPreviewPolling() {
    if (this._previewTimer !== null) window.clearInterval(this._previewTimer);
    this._previewTimer = null;
    this._previewSalaId = null;
    this._previewLoading = false;
    this._previewGeneration++;
    this._renderPreview(null);
  }

  _startPreviewPolling() {
    if (!this.salaId) return;
    if (this._previewTimer !== null && this._previewSalaId === this.salaId) return;
    this._stopPreviewPolling();
    this._previewSalaId = this.salaId;
    this._refreshPreview();
    this._previewTimer = window.setInterval(() => this._refreshPreview(), 30_000);
  }

  _refreshSalaIdentity() {
    if (!this.isSala) {
      this._renderPeers();
      this._renderTyping();
      return;
    }
    for (const group of this.msgsEl?.querySelectorAll('.chat-say-group[data-by]') || []) {
      const avatar = this._avatarKeyFor(group.dataset.by);
      for (let i = 1; i <= 6; i++) group.classList.remove(`peer-${i}`);
      group.classList.add(avatar.tone);
      group.classList.toggle('chat-say-group--own', !!this.me && group.dataset.by === this.me);
      const head = group.querySelector('.chat-say-group-head');
      const title = t('chat.sala.participantTitle', 'Participante: {name}', { name: group.dataset.by });
      head?.firstElementChild?.replaceWith(this._avatarNodeFor(group.dataset.by, { size: 22, title }));
    }
    for (const el of this.msgsEl?.querySelectorAll('.chat-say') || []) {
      const avatar = this._avatarKeyFor(el.dataset.by);
      for (let i = 1; i <= 6; i++) el.classList.remove(`peer-${i}`);
      el.classList.add(avatar.tone);
      el.classList.toggle('chat-say--own', !!this.me && el.dataset.by === this.me);
      el.classList.toggle('chat-say--ask-ai', el.dataset.askAi === 'true');
      this._renderReactions(el.querySelector('.chat-reacts'));
    }
    for (const el of this.msgsEl?.querySelectorAll('.chat-mention[data-username]') || []) {
      if (el.dataset.ai === 'true') {
        for (let i = 1; i <= 6; i++) el.classList.remove(`peer-${i}`);
        el.classList.add('chat-mention--ai');
        el.classList.remove('chat-mention--me');
        continue;
      }
      const username = el.dataset.username;
      const avatar = this._avatarKeyFor(username);
      for (let i = 1; i <= 6; i++) el.classList.remove(`peer-${i}`);
      el.classList.add(avatar.tone);
      el.classList.toggle('chat-mention--me', !!this.me && username === this.me);
    }
    this._renderPeers();
    this._renderTyping();
  }

  _bubble(kind, text, attachments = null, by = null, ts = null) {
    this._maybeDaySep(ts);
    const el = document.createElement('div');
    el.className = `chat-msg chat-${kind}`;
    if (by) {
      const author = document.createElement('div');
      author.className = 'chat-pkg-meta';
      author.textContent = t('chat.message.author', 'Mensaje de {name}', { name: by });
      el.appendChild(author);
    }
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
    const timeTag = this._timeTag(ts);
    if (timeTag) el.appendChild(timeTag);
    const host = String(kind).includes('assistant') ? this._aiHost() : this.msgsEl;
    host.appendChild(el);
    this._scroll();
    return el;
  }

  _stream(text) {
    if (!this.streamEl) {
      this._maybeDaySep(Date.now());
      this.streamEl = this._bubble('assistant streaming', '');
    }
    if (!this.isSala) {
      this.streamEl.textContent += text;
      this._scroll();
      return;
    }
    const delta = String(text || '');
    this._streamRaw += delta;
    if (this._streamAddresseesResolved) {
      this.streamEl.textContent += delta;
    } else {
      const parsed = stripAddressees(this._streamRaw);
      this.streamEl.textContent = parsed.text;
      this._streamAddresseesResolved = !parsed.pending;
    }
    this._scroll();
  }

  // Texto final del asistente: reemplaza la burbuja de streaming (texto plano)
  // por la versión renderizada en markdown.
  _assistantFinal(text, ts = null) {
    if (!this.streamEl) this._maybeDaySep(ts);
    const parsed = this.isSala ? stripAddressees(text, { final: true }) : { addressees: null, text, pending: false };
    const md = renderMarkdown(parsed.text);
    let addressees = [];
    if (this.isSala) {
      const known = this._salaUsers();
      const knownByLower = new Map(known.map((name) => [name.toLocaleLowerCase(), name]));
      const declared = parsed.addressees;
      const requested = declared?.some((name) => ['todos', 'all'].includes(name.toLocaleLowerCase()))
        ? known
        : (declared?.length ? declared : this._lastCutAuthors);
      const seen = new Set();
      for (const requestedName of requested) {
        const name = knownByLower.get(String(requestedName || '').trim().toLocaleLowerCase());
        const lower = name?.toLocaleLowerCase();
        if (name && !seen.has(lower)) {
          seen.add(lower);
          addressees.push(name);
        }
      }
    }
    const decorate = (el) => {
      if (!addressees.length) return;
      const to = document.createElement('div');
      to.className = 'chat-ai-to';
      for (const name of addressees) {
        const chip = document.createElement('span');
        chip.className = `chat-ai-to-chip ${this._avatarKeyFor(name).tone}`;
        chip.textContent = name;
        to.appendChild(chip);
      }
      el.classList.add('assistant--addressed');
      el.style.setProperty('--peer-tone', `var(--cwc-${this._avatarKeyFor(addressees[0]).tone})`);
      el.replaceChildren(to, md);
    };
    let answerEl;
    if (this.streamEl) {
      this.streamEl.classList.remove('streaming');
      this.streamEl.replaceChildren(md);
      decorate(this.streamEl);
      answerEl = this.streamEl;
      this.streamEl = null;
    } else {
      const el = document.createElement('div');
      el.className = 'chat-msg chat-assistant';
      el.appendChild(md);
      decorate(el);
      this._aiHost().appendChild(el);
      answerEl = el;
    }
    const timeTag = this._timeTag(ts);
    if (timeTag) answerEl.appendChild(timeTag);
    if (this.isSala) this._addOrchestrateButton(answerEl, parsed.text);
    this._streamRaw = '';
    this._streamAddresseesResolved = false;
    this._scroll();
  }

  _addOrchestrateButton(el, text) {
    if (!el || !this.isSala) return;
    el.classList.add('chat-assistant--orchestrable');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-orq-btn';
    btn.title = t('chat.orchestrate.buttonTitle', 'Crear una conversación nueva con esta instrucción');
    const ico = document.createElement('span');
    ico.innerHTML = icon('externalLink', { size: 12 });
    const label = document.createElement('span');
    label.textContent = t('chat.orchestrate.button', 'Orquestar');
    btn.append(ico, label);
    btn.addEventListener('click', () => this._openOrchestrateModal(text));
    el.prepend(btn);
  }

  _openOrchestrateModal(sourceText) {
    const worlds = PLACES
      .filter((place) => ['claude-web-console', 'tolkien'].includes(place.rel))
      .map((place) => placeFor(place.rel))
      .filter(Boolean);
    let selected = null;
    const m = openModal({ title: t('chat.orchestrate.modalTitle', 'Orquestar a otro mundo'), width: 520 });
    const body = document.createElement('div');
    body.className = 'chat-orq-modal';

    const worldLabel = document.createElement('div');
    worldLabel.className = 'chat-orq-label';
    worldLabel.textContent = t('chat.orchestrate.worldLabel', 'Mundo destino');
    const worldOptions = document.createElement('div');
    worldOptions.className = 'chat-orq-modal-worlds';
    const worldButtons = worlds.map((place) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `chat-orq-world ${place.cls || ''}`.trim();
      button.dataset.world = place.rel;
      button.setAttribute('aria-pressed', 'false');
      const ico = document.createElement('span');
      ico.innerHTML = icon(place.ico, { size: 15 });
      const label = document.createElement('span');
      label.textContent = place.label;
      button.append(ico, label);
      button.addEventListener('click', () => {
        selected = place;
        for (const option of worldButtons) {
          const active = option === button;
          option.classList.toggle('is-active', active);
          option.setAttribute('aria-pressed', String(active));
        }
        syncCreateState();
      });
      worldOptions.appendChild(button);
      return button;
    });

    const textLabel = document.createElement('label');
    textLabel.className = 'chat-orq-label';
    textLabel.textContent = t('chat.orchestrate.textLabel', 'Instrucción');
    const textarea = document.createElement('textarea');
    textarea.className = 'dlg-input chat-orq-text';
    textarea.rows = 7;
    textarea.value = String(sourceText || '');
    textLabel.appendChild(textarea);

    const help = document.createElement('p');
    help.className = 'chat-orq-help';
    help.textContent = t('chat.orchestrate.help', 'Se crea una conversación nueva en ese mundo con este texto esperando en el composer; no se ejecuta nada hasta que la abras y la envíes.');
    const error = document.createElement('p');
    error.className = 'dlg-editor-err';
    error.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'dlg-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-ghost btn--sm';
    cancel.textContent = t('chat.common.cancel', 'Cancelar');
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'btn btn--sm';
    create.textContent = t('chat.orchestrate.create', 'Crear sesión');
    actions.append(cancel, create);
    body.append(worldLabel, worldOptions, textLabel, help, error, actions);
    m.body.appendChild(body);

    const syncCreateState = () => {
      create.disabled = !selected || !textarea.value.trim();
    };
    textarea.addEventListener('input', syncCreateState);
    cancel.addEventListener('click', () => m.close());
    create.addEventListener('click', async () => {
      const outgoingText = textarea.value.trim();
      if (!selected || !outgoingText) return;
      create.disabled = true;
      cancel.disabled = true;
      error.hidden = true;
      try {
        const res = await fetch('/api/chat/collab/orquestar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: this.id, world: selected.rel, text: outgoingText }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          throw new Error(data.error || t('chat.orchestrate.createFailFallback', 'No se pudo crear la sesión.'));
        }
        this._orquestado({
          by: this.me || t('chat.orchestrate.you', 'Vos'),
          ts: Date.now(),
          world: selected.rel,
          chatId: data.chat?.id,
          snippet: outgoingText.slice(0, 160),
        });
        m.close();
      } catch (err) {
        error.textContent = String(err?.message || err);
        error.hidden = false;
        cancel.disabled = false;
        syncCreateState();
      }
    });
    syncCreateState();
    textarea.focus();
    textarea.select();
  }

  _closeStream() {
    if (this.streamEl) {
      this.streamEl.classList.remove('streaming');
      this.streamEl = null;
    }
    this._streamRaw = '';
    this._streamAddresseesResolved = false;
  }

  // ===== Turno de la IA: una sola caja para todo lo que dijo/hizo =====
  // Antes cada mensaje, permiso, tira de imágenes y la línea de costo eran
  // hermanos sueltos de .chat-msgs y el turno se leía fragmentado, mientras el
  // mensaje del usuario sí iba en una caja. Ahora todo eso cuelga de UN
  // contenedor. El corte sale solo del DOM, igual que .chat-say-group y que
  // los grupos de tools: apenas entra al hilo algo que no es de la IA (un
  // mensaje del usuario, un corte de Aduana), lastElementChild deja de ser el
  // grupo y el próximo elemento de IA abre uno nuevo.
  _aiHost() {
    const last = this.msgsEl.lastElementChild;
    if (last && last.classList.contains('chat-aigroup')) return last;
    const g = document.createElement('div');
    g.className = 'chat-aigroup';
    this.msgsEl.appendChild(g);
    return g;
  }

  // ===== Tool calls: grupos compactos con Pac-Man =====
  // Tool calls consecutivos (sin texto/permiso/costo en el medio) comparten un
  // grupo. La condición "consecutivos" sale sola del DOM: si el último hijo de
  // la lista es un grupo, el registro nuevo se suma ahí; cualquier otro
  // elemento intermedio corta el grupo.
  _toolGroup() {
    const host = this._aiHost();
    const last = host.lastElementChild;
    if (last && last.classList.contains('chat-toolgroup')) return last;
    const g = document.createElement('div');
    g.className = 'chat-toolgroup';
    // Registros de las tools del grupo (id, name, summary, detail, output…).
    // El detalle YA NO vive en el DOM del hilo: se pinta a demanda en el panel.
    g._tools = [];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctg-pac';
    btn.innerHTML = `${pacman({ state: 'working', size: 'sm' })}<span class="ctg-count"></span>`;
    btn.addEventListener('click', () => this._rawToggle(g));
    // El botón se guarda por REFERENCIA porque puede terminar viviendo FUERA
    // del grupo (colgado del mensaje anterior): un querySelector sobre el
    // grupo devolvería null y el Pac-Man se quedaría congelado en 'working'.
    g._pacBtn = btn;
    // El grupo entra igual al hilo aunque quede vacío: es el ancla de
    // .chat-toolimgs (group.after) y el que lleva la clase .active.
    host.appendChild(g);
    const anchor = this._pacAnchor(last);
    (anchor || g).appendChild(btn);
    return g;
  }

  // Dónde cuelga el Pac-Man para no gastar un renglón propio: al final de la
  // última línea del mensaje anterior. Sólo se mete dentro del último párrafo
  // si el mensaje TERMINA en párrafo — si termina en tabla, código, gráfico o
  // diagrama, el Pac-Man quedaría enterrado en medio del contenido, así que
  // se cuelga del mensaje entero. Devuelve null si no hay mensaje al que
  // pegarse (un turno que arranca ejecutando, sin texto previo).
  _pacAnchor(prev) {
    if (!prev || !prev.classList.contains('chat-assistant')) return null;
    // La hora al pie del mensaje (.chat-msg-time) es el último hijo desde que
    // existe el sello estilo WhatsApp: el markdown es el hermano anterior.
    let md = prev.lastElementChild;
    if (md && md.classList.contains('chat-msg-time')) md = md.previousElementSibling;
    const lastBlock = md && md.children.length ? md.children[md.children.length - 1] : null;
    if (lastBlock && lastBlock.tagName === 'P') return lastBlock;
    return prev;
  }

  // Ya NO crea un chip por herramienta: guarda el registro en el grupo y
  // refresca su Pac-Man. El detalle se pinta a demanda en el panel lateral.
  _toolCard(m) {
    const group = this._toolGroup();
    const rec = {
      id: m.id || null,
      name: m.name || '',
      summary: String(m.summary || ''),
      detail: m.detail || null,
      output: null,                              // {ok, text} cuando llegue el tool_result
      isDelegate: /^(Task|Agent)/i.test(m.name || ''),
      delegateDone: false,
    };
    group._tools.push(rec);
    if (rec.id) this._toolIndex.set(rec.id, { rec, group });
    // Motor Pac-Man del header: un Task/Agent abre la espera de un subagente.
    if (rec.isDelegate) { this._delegatingCount++; this._renderPacState(); }
    this._toolGroupSync(group);
    if (this._rawGroup === group) this._rawRender();
    this._scroll();
  }

  // Estado del Pac-Man del grupo + contador. Cuál gana: si queda alguna tool
  // sin resultado, el grupo sigue vivo ('delegating' si la pendiente es un
  // subagente, si no 'working'); ya terminado, 'error' si alguna falló y
  // 'dormant' si salió todo bien.
  _toolGroupSync(group) {
    const tools = group._tools || [];
    const pending = tools.filter((t) => !t.output);
    const state = pending.length
      ? (pending.some((t) => t.isDelegate) ? 'delegating' : 'working')
      : (tools.some((t) => t.output && !t.output.ok) ? 'error' : 'dormant');
    const btn = group._pacBtn;
    if (!btn) return;
    const pacEl = btn.querySelector('.cwc-pacman');
    if (pacEl) pacEl.className = pacClass(state, { size: 'sm' });
    const countEl = btn.querySelector('.ctg-count');
    if (countEl) countEl.textContent = String(tools.length);
    btn.title = t('chat.tool.groupTitle', '{count} herramienta(s) — tocá para ver el detalle', { count: tools.length });
    btn.classList.toggle('ctg-pac--fail', state === 'error');
  }

  // ===== Panel lateral de detalle (1/3 del área del chat) =====
  // Reemplaza al viejo detalle inline: el hilo queda limpio y el detalle
  // técnico vive al costado, donde puede ser largo sin empujar la conversación.
  _rawToggle(group) {
    if (this._rawGroup === group) { this._rawClose(); return; }
    this._rawGroup = group;
    for (const g of this.msgsEl.querySelectorAll('.chat-toolgroup.active')) {
      g.classList.remove('active');
      g._pacBtn?.classList.remove('ctg-pac--active');
    }
    group.classList.add('active');
    group._pacBtn?.classList.add('ctg-pac--active');
    this.rawEl.hidden = false;
    this.container.querySelector('.chat-view').classList.add('chat-view--raw');
    this._rawRender();
    this._scroll();
  }

  _rawClose() {
    this._rawGroup = null;
    for (const g of this.msgsEl.querySelectorAll('.chat-toolgroup.active')) {
      g.classList.remove('active');
      g._pacBtn?.classList.remove('ctg-pac--active');
    }
    if (this.rawEl) this.rawEl.hidden = true;
    this.rawBodyEl?.replaceChildren();
    this.container.querySelector('.chat-view')?.classList.remove('chat-view--raw');
  }

  // Pinta el detalle de TODAS las tools del grupo abierto, una debajo de otra.
  _rawRender() {
    const group = this._rawGroup;
    if (!group || !this.rawBodyEl) return;
    const tools = group._tools || [];
    this.rawTitleEl.textContent = t('chat.raw.title', '{count} herramienta(s)', { count: tools.length });
    const frag = document.createDocumentFragment();
    for (const rec of tools) {
      const item = document.createElement('div');
      item.className = 'craw-item';
      if (rec.output) item.classList.add(rec.output.ok ? 'craw-item--ok' : 'craw-item--fail');
      else item.classList.add('craw-item--run');
      const head = document.createElement('div');
      head.className = 'craw-head';
      head.innerHTML = `${icon(toolTypeIcon(rec.name), { size: 12, className: 'craw-ico' })}<span class="craw-name"></span>`;
      head.querySelector('.craw-name').textContent = rec.name || '?';
      if (rec.summary) {
        const sum = document.createElement('span');
        sum.className = 'craw-sum';
        sum.textContent = rec.summary;
        head.appendChild(sum);
      }
      item.appendChild(head);
      item.appendChild(this._toolDetailBody(rec));
      frag.appendChild(item);
    }
    this.rawBodyEl.replaceChildren(frag);
    this.rawBodyEl.scrollTop = 0;
  }

  // Construye el cuerpo del detalle a demanda (lazy, Fase 7): diff para
  // Edit/Write, comando para Bash, y la salida si ya llegó.
  _toolDetailBody(rec) {
    const body = document.createElement('div');
    body.className = 'ct-body';
    const d = rec.detail;
    if (d && (d.old != null || d.new != null)) body.appendChild(renderDiff(d));
    else if (d?.command || rec.summary) {
      // Con el chip mínimo (solo íconos), el resumen del server es la única
      // pista del input para tools sin detalle propio (Read, etc.).
      // Comandos Bash: resaltados como en un editor (ui/code.js).
      const pre = document.createElement('pre');
      pre.className = 'ct-cmd';
      fillCode(pre, d?.command || rec.summary, d?.command ? 'bash' : null);
      body.appendChild(pre);
    }
    if (rec.output) {
      const pre = document.createElement('pre');
      pre.className = 'ct-out' + (rec.output.ok ? '' : ' err');
      if (rec.output.text) {
        // Salida con sintaxis SOLO si la extensión del archivo es confiable
        // (Read/Write de un .js, .css, etc.); logs/errores quedan planos.
        fillCode(pre, rec.output.text, rec.output.ok ? langForPath(rec.summary) : null);
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

  _toolResult(m) {
    if (!m.id) return;
    const hit = this._toolIndex.get(m.id);
    if (!hit) return;
    const { rec, group } = hit;
    if (rec.isDelegate && !rec.delegateDone) {
      rec.delegateDone = true; // guarda: un tool_result por id, nunca decrementar dos veces
      this._delegatingCount = Math.max(0, this._delegatingCount - 1);
      this._renderPacState();
    }
    rec.output = { ok: !!m.ok, text: m.output || '' };
    this._toolGroupSync(group);
    // Imágenes que DEVOLVIÓ la herramienta (Read de un PNG, screenshot…): se
    // muestran como miniatura clickeable BAJO el grupo, no escondidas en el
    // panel — se VEN sin tocar nada. Guard por id: un replay no las duplica.
    if (Array.isArray(m.images) && m.images.length
        && !this.msgsEl.querySelector(`.chat-toolimgs[data-tool-id="${CSS.escape(m.id)}"]`)) {
      const strip = this._attsEl(m.images);
      strip.classList.add('chat-toolimgs');
      strip.dataset.toolId = m.id;
      group.after(strip);
      this._scroll();
    }
    // Si el panel de ESTE grupo está abierto, el detalle se refresca en vivo.
    if (this._rawGroup === group) this._rawRender();
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
    this._aiHost().appendChild(el);
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

    this._aiHost().appendChild(el);
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

  // Al decidir, la tarjeta colapsa a un chip de registro del permiso. Queda
  // fuera de los grupos de tools: esos grupos ahora muestran solo su Pac-Man
  // y reservan el panel lateral exclusivamente para ejecuciones.
  _permClose(m) {
    const el = this.msgsEl.querySelector(`[data-perm-id="${m.id}"]`);
    if (!el) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chat-toolchip chat-permchip ${m.allow ? 'ok' : 'no'}`;
    chip.innerHTML = `${icon(m.allow ? 'check' : 'close', { size: 13 })}<span class="ct-name"></span>`;
    chip.querySelector('.ct-name').textContent = m.allow ? t('chat.perm.allowed', 'Permitido') : t('chat.perm.denied', 'Denegado');
    chip.title = `${el._tool || ''} ${el._summary || ''}`.trim();
    const row = document.createElement('div');
    row.className = 'chat-perm-row';
    row.appendChild(chip);
    el.replaceWith(row);
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
      this._aiHost().appendChild(el);
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

  _applyDocMode(on) {
    document.body.classList.toggle('doc-mode', on);
    this.docModeBtn?.classList.toggle('is-on', on);
    this.docModeBtn?.setAttribute('aria-pressed', String(on));
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

  _isNearMessagesBottom() {
    if (!this.msgsEl) return false;
    return this.msgsEl.scrollHeight - this.msgsEl.scrollTop - this.msgsEl.clientHeight < 80;
  }

  _markRead() {
    if (!this.isSala || this._lastSayTs == null || document.visibilityState !== 'visible') return;
    if (this._lastSayTs === this._lastReadTs) return;
    this._markReadQueuedTs = this._lastSayTs;
    this._scheduleMarkRead();
  }

  _scheduleMarkRead() {
    if (this._markReadTimer || this._markReadInFlight || this._markReadQueuedTs == null) return;
    const wait = Math.max(0, 3000 - (Date.now() - this._markReadLastAt));
    if (wait > 0) {
      this._markReadTimer = setTimeout(() => {
        this._markReadTimer = null;
        this._scheduleMarkRead();
      }, wait);
      return;
    }
    this._flushMarkRead();
  }

  async _flushMarkRead() {
    const ts = this._markReadQueuedTs;
    if (!this.isSala || ts == null || ts === this._lastReadTs) {
      this._markReadQueuedTs = null;
      return;
    }
    this._markReadQueuedTs = null;
    this._markReadInFlight = true;
    this._markReadLastAt = Date.now();
    const generation = this._readGeneration;
    try {
      const res = await fetch('/api/chat/collab/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: this.id, ts }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok || generation !== this._readGeneration) return;
      this._lastReadTs = ts;
      this._unreadAtOpen = 0;
      // Marcar leído actualiza el contador, no la marca visual de esta apertura:
      // el separador permanece hasta que un nuevo history repinte todo el hilo.
    } catch {
      // El próximo say elegible o una nueva apertura vuelve a intentar.
    } finally {
      this._markReadInFlight = false;
      this._scheduleMarkRead();
    }
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

  _enqueuePrMilestones(items) {
    for (const milestone of Array.isArray(items) ? items : []) {
      if (!milestone?.key || this._prKeys.has(milestone.key)) continue;
      this._prKeys.add(milestone.key);
      this._prQueue.push(milestone);
    }
    this._drainPrMilestones();
  }

  _drainPrMilestones() {
    if (this._prCurrent || !this._prQueue.length || !this._active || document.visibilityState !== 'visible') return;
    const milestone = this._prQueue.shift();
    this._prCurrent = milestone;
    const toast = document.createElement('div');
    toast.className = 'hito-toast';
    toast.dataset.kind = milestone.kind;
    toast.setAttribute('role', 'link');
    toast.tabIndex = 0;
    toast.innerHTML = `
      <span class="hito-toast-mark">${milestoneGlyph(milestone.kind, { size: 16 })}</span>
      <span class="hito-toast-copy">
        <span class="hito-toast-title">${milestoneToastTitle(milestone.kind)} <span>${t('chat.prMilestone.prNumber', '· PR #{number}', { number: milestone.number })}</span></span>
        <span class="hito-track">${milestoneTrackHtml(milestone)}</span>
      </span>
      <button type="button" class="hito-toast-close" title="${t('chat.prMilestone.close', 'Cerrar')}" aria-label="${t('chat.prMilestone.close', 'Cerrar')}">×</button>
      <span class="hito-toast-drain" aria-hidden="true"></span>`;
    const open = () => {
      if (milestone.url) window.open(milestone.url, '_blank', 'noopener');
    };
    toast.addEventListener('click', (event) => { if (!event.target.closest('.hito-toast-close')) open(); });
    toast.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    });
    toast.querySelector('.hito-toast-close').addEventListener('click', () => this._dismissPrMilestone());
    this.prToastHost.replaceChildren(toast);
    this._ackPrMilestones([milestone.key]);
    this._prToastTimer = setTimeout(() => this._dismissPrMilestone(), 5000);
  }

  _dismissPrMilestone() {
    clearTimeout(this._prToastTimer);
    this._prToastTimer = null;
    this._prCurrent = null;
    this.prToastHost?.replaceChildren();
    this._drainPrMilestones();
  }

  _ackPrMilestones(keys) {
    void fetch(`/api/chat/${encodeURIComponent(this.id)}/pr-milestones/seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    }).catch(() => { /* el poll conserva el chip y permite reintentar tras recargar */ });
  }

  setActive(active) {
    this._active = !!active;
    if (this._active) this._drainPrMilestones();
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
    this.setActive(true);
    // Re-anclar SIEMPRE al final al activar la pestaña: mientras el panel está
    // oculto (display:none) scrollTop se pierde (scrollHeight=0), así que el
    // historial re-renderizado o los eventos llegados en background dejaban la
    // vista arriba de todo al volver a este chat. setActive() nos llama justo
    // DESPUÉS de mostrar el panel, con el layout ya medible.
    this._scroll();
    this._autosize();
    if (this.isSala && this.salaId) {
      this._startPreviewPolling();
      this._refreshPreview();
    }
    // En táctil no auto-enfocamos: abriría el teclado sin que lo pidas.
    if (!window.matchMedia('(pointer: coarse)').matches) this.inputEl.focus();
  }

  dispose() {
    this.closedByUser = true;
    window.removeEventListener(DOC_MODE_EVENT, this._onDocMode);
    document.removeEventListener('visibilitychange', this._onPrVisibility);
    clearTimeout(this._prToastTimer);
    this._slashClose();
    this._clearTyping();
    this._stopPreviewPolling();
    this._msgsResizeObs?.disconnect();
    clearTimeout(this._markReadTimer);
    clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch { /* noop */ }
  }
}
