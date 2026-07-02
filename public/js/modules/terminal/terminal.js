// modules/terminal/terminal.js — cliente de una terminal (xterm.js + WebSocket).
//
// Cada instancia representa una pestaña = un PTY del servidor. Maneja:
//   - render de xterm con addon fit (resize) y web-links.
//   - WebSocket: binario = salida del PTY; texto JSON = control.
//   - reconexión automática con re-adjuntado (el PTY sobrevive en el server).
const { Terminal } = window;
const FitAddonNS = window.FitAddon;
const WebLinksNS = window.WebLinksAddon;
const ClipboardNS = window.ClipboardAddon;

export class TerminalTab {
  constructor({ id, title, container }) {
    this.id = id;
    this.title = title || 'terminal';
    this.container = container; // div contenedor de esta terminal
    this.ws = null;
    this.reconnectTimer = null;
    this.closedByUser = false;

    this.term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 14,
      allowProposedApi: true,
      scrollback: 5000,
      theme: { background: '#0b0e14', foreground: '#c5c8c6' },
    });
    this.fit = new FitAddonNS.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksNS.WebLinksAddon());
    // OSC52: cuando tmux copia (seleccionar con el mouse), el texto va al
    // portapapeles del sistema. Requiere contexto seguro (HTTPS).
    if (ClipboardNS?.ClipboardAddon) this.term.loadAddon(new ClipboardNS.ClipboardAddon());

    this.term.open(this.container);
    this._safeFit();

    // Ctrl "armado" por la barra táctil: el próximo carácter se convierte en
    // su Ctrl+<char>. Funciona en teclados virtuales (opera sobre el carácter
    // ya resultante, no sobre keydown, que en móvil no es fiable).
    this.ctrlArmed = false;
    this.onCtrlAutoClear = null; // callback para que la UI apague el resalte

    // Entrada del usuario -> servidor.
    this.term.onData((data) => this._send({ type: 'input', data: this._applyCtrl(data) }));

    // Resize del navegador -> PTY (para que Claude Code / tmux se redibujen).
    this._resizeObserver = new ResizeObserver(() => this._safeFit());
    this._resizeObserver.observe(this.container);

    // Scroll táctil: en canvas, el arrastre con el dedo no scrollea el viewport
    // de xterm (el mouse wheel sí). Convertimos el arrastre en scrollLines().
    this._setupTouchScroll();

    // Click derecho = pegar del portapapeles (sin comandos especiales).
    this.container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.pasteFromClipboard();
    });
  }

  // Pega texto respetando bracketed-paste (term.paste) hacia el PTY.
  pasteText(text) {
    if (text) this.term.paste(text);
  }

  async pasteFromClipboard() {
    try {
      const text = await navigator.clipboard?.readText?.();
      if (text) this.term.paste(text);
    } catch { /* portapapeles no disponible / permiso denegado */ }
  }

  _setupTouchScroll() {
    let lastY = null;
    let touchX = 0;
    let acc = 0; // acumulador de píxeles sobrantes entre movimientos

    const rowH = () => Math.max(8, this.container.clientHeight / (this.term.rows || 24));

    // Coordenada de celda (1-based) bajo el toque, para el reporte de mouse.
    const cellAt = (clientX, clientY) => {
      const r = this.container.getBoundingClientRect();
      const cw = Math.max(1, r.width / (this.term.cols || 80));
      const ch = Math.max(1, r.height / (this.term.rows || 24));
      const col = Math.min(this.term.cols || 80, Math.max(1, Math.ceil((clientX - r.left) / cw)));
      const row = Math.min(this.term.rows || 24, Math.max(1, Math.ceil((clientY - r.top) / ch)));
      return { col, row };
    };

    this.container.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        lastY = e.touches[0].clientY;
        touchX = e.touches[0].clientX;
        acc = 0;
      } else {
        lastY = null; // multi-touch (pinch): no interferimos
      }
    }, { passive: true });

    this.container.addEventListener('touchmove', (e) => {
      if (lastY == null || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      touchX = e.touches[0].clientX;
      acc += lastY - y; // dedo hacia arriba => acc>0 => hacia abajo (contenido nuevo)
      lastY = y;

      const lines = Math.trunc(acc / rowH());
      if (lines === 0) return;
      acc -= lines * rowH();
      e.preventDefault(); // evita rubber-band / scroll de la página

      const mode = this.term.modes?.mouseTrackingMode;
      if (mode && mode !== 'none') {
        // El app captura el mouse (p.ej. tmux mouse on): mandamos eventos de
        // rueda al PTY, igual que hace el mouse wheel. btn 64=arriba, 65=abajo.
        const btn = lines > 0 ? 65 : 64;
        const { col, row } = cellAt(touchX, y);
        const n = Math.min(Math.abs(lines), 8);
        for (let i = 0; i < n; i++) this.sendData(`\x1b[<${btn};${col};${row}M`);
      } else {
        // Sin mouse tracking: scrolleamos el scrollback propio de xterm.
        this.term.scrollLines(lines);
      }
    }, { passive: false });

    this.container.addEventListener('touchend', () => { lastY = null; }, { passive: true });
  }

  _safeFit() {
    try {
      this.fit.fit();
      const { cols, rows } = this.term;
      this._send({ type: 'resize', cols, rows });
    } catch { /* contenedor no visible aún */ }
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/terminal?id=${encodeURIComponent(this.id)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this._safeFit();
      this.term.focus();
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        // Mensaje de control JSON.
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'exit') {
            this.term.write('\r\n\x1b[33m[sesión terminada]\x1b[0m\r\n');
            this.closedByUser = true;
          } else if (msg.type === 'error') {
            this.term.write(`\r\n\x1b[31m[error] ${msg.message}\x1b[0m\r\n`);
          }
        } catch { /* noop */ }
      } else {
        // Salida binaria del PTY.
        this.term.write(new Uint8Array(ev.data));
      }
    };

    ws.onclose = () => {
      if (this.closedByUser) return;
      // Reconexión: el PTY sigue vivo en el servidor, nos re-adjuntamos.
      this.term.write('\r\n\x1b[90m[reconectando...]\x1b[0m\r\n');
      this.reconnectTimer = setTimeout(() => this.connect(), 1500);
    };

    ws.onerror = () => ws.close();
  }

  _applyCtrl(data) {
    if (!this.ctrlArmed || data.length !== 1) return data;
    const code = data.charCodeAt(0);
    let out = data;
    // Ctrl+A..Z (min/may) y Ctrl+@ [ \ ] ^ _  -> caracteres de control 0..31.
    if (code >= 97 && code <= 122) out = String.fromCharCode(code - 96);
    else if (code >= 64 && code <= 95) out = String.fromCharCode(code & 0x1f);
    this.ctrlArmed = false;
    this.onCtrlAutoClear?.();
    return out;
  }

  // Envía datos crudos al PTY (barra táctil, pegar, dictado).
  sendData(data) {
    this._send({ type: 'input', data });
  }

  setCtrlArmed(on) {
    this.ctrlArmed = on;
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  focus() {
    this._safeFit();
    this.term.focus();
  }

  dispose() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    this._resizeObserver?.disconnect();
    try { this.ws?.close(); } catch { /* noop */ }
    this.term.dispose();
  }
}
