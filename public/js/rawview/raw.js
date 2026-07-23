// Vista Raw v3 — de wallpaper a monitor cardíaco (PLAN-544).
//
// La queja de v2: la lluvia se sentía como fondo estático, desconectada de los
// flujos — todo caía parejo, trabajés o no. v3 conecta el MOVIMIENTO a los
// momentos reales, con 5 mecanismos:
//   1. ENERGÍA POR SESIÓN — cada banda tiene su propia energía (0..1) que decae;
//      en reposo cae lenta y tenue (casi congelada), trabajando cae rápida,
//      brillante y densa. El contraste hace legible "qué sesión trabaja".
//   2. IGNICIÓN al nacer + DISOLUCIÓN al morir — abrir/cerrar una sesión se SIENTE.
//   3. CABEZA blanca incandescente (cursor tipeando) + RIPPLE en cada fragmento
//      nuevo (columnas frescas que caen desde arriba) — el texto que llega = onda.
//   4. ESTADO manda el modo (GET /api/chat/list: working/delegando/waiting/alive),
//      no solo el texto → la banda enciende al abrir la sesión aunque aún no
//      escriba; delegando = pulso propio (respira).
//   5. AMBIENTE recede fuerte (lento y oscuro) para que el texto real POP.
//
// Identidad (de v2): TONO=mundo · MATIZ=sesión · el char REAL sale incandescente.
// SOLO-LECTURA. Datos: /api/tokens/stream (texto real) + /api/tokens/flow (tps
// global, HUD) + /api/chat/list (estado de sesión). Cierre con Esc/✕.

const POLL_MS = 800;
const FEED_MAX = 30;
const FEED_LIFE_MS = 7000;
const FEED_PER_SESSION_MS = 2200;
const TEXT_TTL_MS = 22000;      // sin texto y sin runner vivo → empieza a morir
const IGNITE_MS = 1100;         // duración del destello de nacimiento
const DIE_MS = 1000;            // duración de la disolución
const ENERGY_TAU = 1.0;         // constante de decaimiento de energía (s)
const PENDING_CAP = 6000;
const LOG_CAP = 4000;           // chars del log legible por sesión
const LOG_TICK_MS = 90;         // cadencia de la máquina de escribir
const IDLE_VEL = 1.2;           // filas/s de una banda en reposo
const FAST_VEL = 30;            // filas/s a energía plena
const AMBIENT_VEL = 1.0;        // columnas sin dueño
const FADE_ALPHA = 0.12;
const FONT_SIZE = 16;
const TERM_POLL_MS = 3000;
const PROC_POLL_MS = 1500;
const HEALTH_POLL_MS = 60000;
const HEALTH_SERVICES = { systemd: 'Consola web', 'pad-backbone': 'Pad local', tmux: 'tmux' };
const SHELL_GLYPHS = '$#~/\\|<>[](){};:=+-*.,_% abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const IDLE_GLYPHS =
  'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン' +
  '0123456789ABCDEF$#%&@*+-/<>[]{}=;:';

const WORLD = {
  console: { hue: 18, label: 'consola', ico: '🖥️' },
  tolkien: { hue: 140, label: 'tolkien', ico: '🌳' },
  otros: { hue: 210, label: 'otros', ico: '·' },
  unknown: { hue: 190, label: 'codex?', ico: '🤖' },
  terminal: { hue: 130, label: 'bash', ico: '▸' },
  proc: { hue: 45, label: 'proc', ico: '⚙' },
};

const canvas = document.getElementById('raw-canvas');
const ctx = canvas.getContext('2d');
const feedEl = document.getElementById('raw-feed');
const labelsEl = document.getElementById('raw-labels');
const logsEl = document.getElementById('raw-logs');
const procsEl = document.getElementById('raw-procs');
const closeBtn = document.getElementById('raw-close');
const rcSessions = document.getElementById('rc-sessions');
const rcClaudeNum = document.getElementById('rc-claude-num');
const rcClaudeTps = document.getElementById('rc-claude-tps');
const rcCodexNum = document.getElementById('rc-codex-num');
const rcCodexTps = document.getElementById('rc-codex-tps');

const logPanels = new Map(); // sessionId -> <div.raw-log>
const labelPanels = new Map(); // sessionId -> <div.raw-label>
const seeded = new Set();    // sesiones ya sembradas con su texto reciente
let stripHealth = [];   // servicios desde /api/health/checks (LED por status)
let stripDaemons = [];  // procesos-servicio desde /active-runners (WhatsApp)

let totalCols = 0;
let cols = [];          // { y, headRow, headCh, headReal }
let owner = [];         // sessionId | null por columna
let bands = [];         // { sid, start, width }
let bandBySid = new Map();
let layoutSig = '';
let lastTs = 0;

function restoreCounter(k) {
  const v = Number(localStorage.getItem('cwc:rawcount:' + k));
  return Number.isFinite(v) && v > 0 ? v : 0;
}
const state = {
  claudeTps: 0,
  codexTps: 0,
  lastSeq: 0,
  sessions: new Map(),  // sessionId -> sesión (ver upsert)
  prevTotals: new Map(), // key -> último total visto (para deltas monotónicos)
  tok: { claude: restoreCounter('claude'), codex: restoreCounter('codex') }, // real acumulado (persistente)
  shown: { claude: 0, codex: 0 },  // valor mostrado (trepa suave hacia tok)
  lastSaveTs: 0,
  stopped: false,
};
state.shown.claude = state.tok.claude;
state.shown.codex = state.tok.codex;

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function worldKey(w) { return w && WORLD[w] ? w : 'unknown'; }
function worldFromCwd(cwd) {
  if (!cwd) return null;
  if (/tolkien/i.test(cwd)) return 'tolkien';
  if (/claude-web-console/i.test(cwd)) return 'console';
  return 'otros';
}

// hue del mundo + jitter/lightness estables por sesión.
function sessionHSL(sid, world, kind) {
  const wk = worldKey(world);
  const base = WORLD[wk].hue;
  const h = hashStr(sid);
  const hue = base + ((h % 26) - 13);
  const sat = wk === 'otros' ? 14 : 66;
  const light = 44 + (h % 20);
  if (kind === 'head') return `hsl(${hue}, 80%, 90%)`;                 // cabeza incandescente
  if (kind === 'real') return `hsl(${hue}, ${Math.min(100, sat + 26)}%, ${Math.min(84, light + 26)}%)`;
  if (kind === 'idle') return `hsl(${hue}, ${sat}%, ${light}%)`;
  return `hsl(${hue}, ${Math.min(90, sat + 18)}%, ${Math.min(86, light + 24)}%)`; // label
}
function idleGlyph(source) {
  const set = source === 'term' ? SHELL_GLYPHS : IDLE_GLYPHS;
  return set[(Math.random() * set.length) | 0];
}

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  totalCols = Math.ceil(canvas.width / FONT_SIZE) + 1;
  const prev = cols;
  cols = new Array(totalCols).fill(null).map((_, i) => prev[i] || { y: Math.random() * -30, headRow: -1, headCh: '', headReal: false });
  ctx.font = `${FONT_SIZE}px monospace`;
  ctx.textBaseline = 'top';
  layoutSig = '';
  relayout();
}

// Bandas contiguas por sesión, intercaladas a lo ancho (incluye las que agonizan
// para que la disolución se vea en su lugar).
function relayout() {
  const active = [...state.sessions.keys()].sort();
  const sig = active.join('|') + '@' + totalCols;
  if (sig === layoutSig) return;
  layoutSig = sig;

  owner = new Array(totalCols).fill(null);
  bands = [];
  bandBySid = new Map();
  if (active.length) {
    const weights = active.map((sid) => {
      const s = state.sessions.get(sid);
      return s && s.isSub ? 0.6 : 1;
    });
    const totalW = weights.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    active.forEach((sid, i) => {
      // Slot proporcional al peso (subagente = banda más angosta), borde a borde.
      const s0 = Math.floor((acc / totalW) * totalCols);
      acc += weights[i];
      const s1 = Math.floor((acc / totalW) * totalCols);
      const gut = active.length > 1 ? Math.min(4, Math.max(1, Math.floor((s1 - s0) * 0.12))) : 0;
      const start = s0;
      const width = Math.max(3, (s1 - s0) - gut);
      for (let c = start; c < start + width && c < totalCols; c++) owner[c] = sid;
      const b = { sid, start, width };
      bands.push(b);
      bandBySid.set(sid, b);
    });
  }
  layoutLabels();
  syncLogPanels();
}

// Un panel de log legible por banda, bajo su rótulo, hasta cerca del fondo.
// Preserva el contenido tipeado entre relayouts (solo reposiciona).
function syncLogPanels() {
  const slotPx = bands.length ? canvas.width / bands.length : canvas.width;
  const panelW = Math.max(60, slotPx - 16);
  const top = 22; // pegado bajo el rótulo (márgenes 0)
  const height = Math.max(120, window.innerHeight - top - 30); // llena casi todo el alto
  const present = new Set();
  for (const b of bands) {
    present.add(b.sid);
    let el = logPanels.get(b.sid);
    let born = false;
    if (!el) {
      el = document.createElement('div'); el.className = 'raw-log';
      const gut = document.createElement('div'); gut.className = 'raw-log-gut';
      const code = document.createElement('div'); code.className = 'raw-log-code';
      el.append(gut, code); el._gut = gut; el._code = code;
      logsEl.appendChild(el); logPanels.set(b.sid, el); born = true;
    }
    const s = state.sessions.get(b.sid);
    const left = Math.min(b.start * FONT_SIZE, Math.max(0, canvas.width - panelW)); // clamp al borde
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${panelW}px`;
    el.style.height = `${height}px`;
    if (s) el.style.color = sessionHSL(b.sid, s.world, 'idle');
    if (born) requestAnimationFrame(() => el.classList.add('raw-log--in'));
    else if (el._out) { el._out = false; clearTimeout(el._outT); el.classList.remove('raw-log--out'); el.classList.add('raw-log--in'); }
  }
  for (const [sid, el] of logPanels) {
    if (!present.has(sid) && !el._out) {
      el._out = true;
      el.classList.remove('raw-log--in');
      el.classList.add('raw-log--out');
      el._outT = setTimeout(() => { el.remove(); logPanels.delete(sid); }, 520);
    }
  }
  for (const b of bands) seedSession(b.sid); // poblar bandas ociosas con su texto reciente
}

// Trae UNA vez el texto reciente de una sesión para que su banda no arranque vacía.
async function seedSession(sid) {
  if (seeded.has(sid)) return;
  if (/[:~]/.test(sid)) { seeded.add(sid); return; }
  seeded.add(sid);
  const r = await fetchJson(`/api/tokens/stream/seed?sid=${encodeURIComponent(sid)}`);
  const s = state.sessions.get(sid);
  if (s && r && r.text && !s.log) s.log = r.text.slice(-LOG_CAP);
}

// Máquina de escribir: escribe el texto real de corrido (más rápido si la sesión
// tiene energía) y hace tail-scroll. Al llegar al final del log RECICLA desde el
// principio (cursor circular) → siempre hay texto de consola fluyendo en cada
// banda, aunque la sesión deje de producir salida nueva.
function typewriterTick() {
  if (state.stopped) return;
  for (const [sid, el] of logPanels) {
    const s = state.sessions.get(sid);
    if (!s || !s.log.length) continue;
    const rate = 2 + Math.round(7 * Math.min(1, s.energy));
    let add = '';
    for (let k = 0; k < rate; k++) { add += s.log[s.cursor % s.log.length]; s.cursor++; }
    s.cursor %= s.log.length;
    s.display = (s.display + add).slice(-1600);
    if (el._txt === s.display) continue;
    el._txt = s.display;
    const code = el._code, gut = el._gut;
    if (!code || !gut) continue;
    code.textContent = s.display;
    const nLines = s.display.split('\n').length;
    if (el._nLines !== nLines) {
      el._nLines = nLines;
      let g = '';
      for (let ln = 1; ln <= nLines; ln++) g += ln + '\n';
      gut.textContent = g;
    }
    code.scrollTop = code.scrollHeight;
    gut.scrollTop = code.scrollTop; // el gutter sigue al código (misma altura de línea)
  }
}

function statusGlyph(sess) {
  if (sess.phase === 'dying') return '·';
  if (sess.delegating) return '⟳';
  if (sess.status === 'working') return '▶';
  if (sess.chatAlive) return '◦';
  return '»';
}
function bandLabel(s, sid) {
  const wk = worldKey(s.world);
  if (s.source === 'term') {
    const nm = s.title || sid.replace(/^term:/, '').replace(/^cwc-/, '');
    return `▸ ${nm.slice(0, 22)}`;
  }
  if (s.source === 'proc') return `⚙ ${s.procLabel || 'proc'}`;
  if (s.isSub) {
    const parent = state.sessions.get(sid.replace(/~sub$/, ''));
    const pname = (parent && parent.title) || sid.slice(0, 4);
    return `↳ ${WORLD[wk].ico} ${pname.slice(0, 20)} · sub`;
  }
  const name = s.title || `${WORLD[wk].label} · ${sid.slice(0, 4)}`;
  return `${statusGlyph(s)} ${WORLD[wk].ico} ${name.slice(0, 24)} · ${s.model || s.source}`;
}
function layoutLabels() {
  const present = new Set();
  for (const b of bands) {
    const s = state.sessions.get(b.sid);
    if (!s) continue;
    present.add(b.sid);
    const wk = worldKey(s.world);
    let el = labelPanels.get(b.sid);
    let born = false;
    if (!el) { el = document.createElement('div'); el.className = 'raw-label'; labelsEl.appendChild(el); labelPanels.set(b.sid, el); born = true; }
    else if (el._out) { el._out = false; clearTimeout(el._outT); el.classList.remove('raw-label--out'); }
    el.style.left = `${Math.min(b.start * FONT_SIZE, Math.max(0, canvas.width - 210))}px`;
    el.style.color = sessionHSL(b.sid, s.world, 'label');
    el.style.borderLeftColor = sessionHSL(b.sid, s.world, 'idle');
    const txt = bandLabel(s, b.sid);
    if (el.textContent !== txt) el.textContent = txt;
    if (born) requestAnimationFrame(() => el.classList.add('raw-label--in'));
  }
  for (const [sid, el] of labelPanels) {
    if (!present.has(sid) && !el._out) {
      el._out = true;
      el.classList.remove('raw-label--in');
      el.classList.add('raw-label--out');
      el._outT = setTimeout(() => { el.remove(); labelPanels.delete(sid); }, 520);
    }
  }
}

function nextChar(sess) {
  if (sess.read < sess.buf.length) {
    const ch = sess.buf[sess.read++];
    if (sess.read > 4000) { sess.buf = sess.buf.slice(sess.read); sess.read = 0; }
    return ch;
  }
  return null;
}

// ---- energía ----
function energyFloor(sess) {
  if (sess.phase === 'dying') return 0;
  if (sess.phase === 'igniting') return 0.92;
  if (sess.delegating) return 0.5;
  if (sess.status === 'working') return 0.62;
  if (sess.chatAlive) return 0.15;
  return 0.06;
}
function updateEnergy(sess, dt, ts) {
  const floor = energyFloor(sess);
  sess.energy = floor + (sess.energy - floor) * Math.exp(-dt / ENERGY_TAU);
  if (sess.phase === 'igniting' && ts - sess.bornAt > IGNITE_MS) sess.phase = 'live';
}
// energía efectiva para la caída (delegando respira).
function effEnergy(sess, ts) {
  let e = Math.min(1, sess.energy);
  if (sess.delegating) e *= 0.72 + 0.28 * Math.abs(Math.sin(ts / 360));
  return e;
}

// visibilidad 0..1: ramp de aparición (igniting) y disolución (dying) para el fade real de la lluvia.
function sessVis(sess, ts) {
  if (sess.phase === 'igniting') return Math.min(1, (ts - sess.bornAt) / IGNITE_MS);
  if (sess.phase === 'dying') return Math.max(0, 1 - (performance.now() - sess.dyingAt) / DIE_MS);
  return 1;
}

function cell(colX, row, ch, style) {
  ctx.fillStyle = style;
  ctx.fillText(ch, colX * FONT_SIZE, row * FONT_SIZE);
}

function drawFrame(dt, ts) {
  ctx.fillStyle = `rgba(0,0,0,${FADE_ALPHA})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < totalCols; i++) {
    const col = cols[i];
    if (!col) continue;
    const sid = owner[i];
    const sess = sid ? state.sessions.get(sid) : null;
    const vis = sess ? sessVis(sess, ts) : 1;
    ctx.globalAlpha = vis;
    const e = sess ? effEnergy(sess, ts) : 0.04;
    const vel = (sess ? IDLE_VEL : AMBIENT_VEL) + (FAST_VEL - (sess ? IDLE_VEL : AMBIENT_VEL)) * e;

    const prevRow = Math.floor(col.y);
    col.y += vel * dt;
    const newRow = Math.floor(col.y);

    if (newRow > prevRow) {
      // el head anterior pasa a trail (coloreado); real deja veta más brillante.
      if (col.headRow >= 0 && col.headCh) {
        const trail = sess
          ? sessionHSL(sid, sess.world, col.headReal ? 'real' : 'idle')
          : (Math.random() > 0.5 ? 'hsl(0,0%,26%)' : 'hsl(0,0%,16%)');
        cell(i, col.headRow, col.headCh, trail);
      }
      // nuevo head
      let ch, real = false;
      if (sess) {
        const r = nextChar(sess);
        if (r != null) { ch = r; real = true; } else ch = idleGlyph(sess.source);
      } else ch = idleGlyph();
      const headColor = sess
        ? (e > 0.22 ? sessionHSL(sid, sess.world, 'head') : sessionHSL(sid, sess.world, real ? 'real' : 'idle'))
        : 'hsl(0,0%,32%)';
      cell(i, newRow, ch, headColor);
      col.headRow = newRow;
      col.headCh = ch;
      col.headReal = real;
    }

    if (col.y * FONT_SIZE > canvas.height) {
      if (Math.random() > 0.985 - e * 0.02) { col.y = Math.random() * -12; col.headRow = -1; }
    }
    ctx.globalAlpha = 1;
  }
}

function loop(ts) {
  if (state.stopped) return;
  if (!lastTs) lastTs = ts;
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;
  for (const s of state.sessions.values()) updateEnergy(s, dt, ts);
  drawFrame(dt, ts);
  renderCounters(dt);
  persistCounters(ts);
  requestAnimationFrame(loop);
}

// ---- feed ----
function pushFeed(text, world) {
  const wk = worldKey(world);
  const el = document.createElement('div');
  el.className = 'raw-line';
  el.style.color = `hsl(${WORLD[wk].hue}, ${wk === 'otros' ? 16 : 62}%, 66%)`;
  el.style.borderLeftColor = `hsl(${WORLD[wk].hue}, ${wk === 'otros' ? 16 : 62}%, 34%)`;
  el.textContent = text;
  feedEl.prepend(el);
  requestAnimationFrame(() => el.classList.add('raw-line--in'));
  setTimeout(() => { el.classList.add('raw-line--out'); setTimeout(() => el.remove(), 900); }, FEED_LIFE_MS);
  while (feedEl.children.length > FEED_MAX) feedEl.removeChild(feedEl.lastChild);
}

// ---- sesiones ----
function upsertSession(sid, patch) {
  let s = state.sessions.get(sid);
  let born = false;
  if (!s) {
    s = {
      source: 'claude', world: null, model: null,
      buf: '', read: 0, energy: 0.92,
      log: '', cursor: 0, display: '',
      status: 'text', chatAlive: false, delegating: false,
      phase: 'igniting', bornAt: performance.now(), dyingAt: 0,
      lastTextTs: 0, lastFeedTs: 0,
    };
    state.sessions.set(sid, s);
    born = true;
  }
  Object.assign(s, patch);
  if (s.phase === 'dying' && (s.chatAlive || Date.now() - s.lastTextTs < TEXT_TTL_MS)) s.phase = 'live'; // revivió
  return { s, born };
}

// ripple: al llegar texto, columnas frescas caen desde arriba en la banda.
function rippleBand(sid) {
  const b = bandBySid.get(sid);
  if (!b) return;
  const n = 1 + (Math.random() * 2 | 0);
  for (let k = 0; k < n; k++) {
    const c = b.start + (Math.random() * b.width | 0);
    if (cols[c]) { cols[c].y = Math.random() * -6; cols[c].headRow = -1; }
  }
}

function ingestFragment(f) {
  const { s, born } = upsertSession(f.sessionId, {
    source: f.source, world: f.world, model: f.model || undefined, isSub: f.sub === true,
  });
  s.lastTextTs = Date.now();
  s.buf += (s.buf ? '  ·  ' : '') + f.text;
  if (s.buf.length - s.read > PENDING_CAP) { s.buf = s.buf.slice(s.buf.length - PENDING_CAP); s.read = 0; }
  // log legible (una línea por fragmento): la máquina de escribir lo recicla.
  s.log += f.text + '\n';
  if (s.log.length > LOG_CAP) s.log = s.log.slice(s.log.length - LOG_CAP);
  s.energy = Math.min(1.15, s.energy + 0.5); // pico
  rippleBand(f.sessionId);
  const now = Date.now();
  if (now - s.lastFeedTs > FEED_PER_SESSION_MS) {
    s.lastFeedTs = now;
    const wk = worldKey(f.world);
    pushFeed(`${WORLD[wk].ico} ${f.model || f.source} · ${f.text.replace(/\s+/g, ' ').slice(0, 72)}`, f.world);
  }
  return born;
}

function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [sid, s] of state.sessions) {
    const aliveNow = s.chatAlive || now - s.lastTextTs < TEXT_TTL_MS;
    if (!aliveNow && s.phase !== 'dying') { s.phase = 'dying'; s.dyingAt = performance.now(); changed = true; }
    if (s.phase === 'dying' && performance.now() - s.dyingAt > DIE_MS) { state.sessions.delete(sid); changed = true; }
  }
  return changed;
}

// Acumula tokens REALES (monotónico): suma solo los deltas positivos del `total`
// por sesión/cwd que reporta /flow. Primera vez que se ve una clave = baseline
// (delta 0), para no volcar el histórico de 6 h como una ráfaga falsa.
function accumTokens(map, side) {
  for (const k of Object.keys(map || {})) {
    const key = side + ':' + k;
    const total = map[k].total || 0;
    const prev = state.prevTotals.get(key);
    if (prev == null) { state.prevTotals.set(key, total); continue; }
    if (total > prev) state.tok[side] += total - prev;
    state.prevTotals.set(key, total);
  }
}

function updateSessionsLine() {
  const working = [...state.sessions.values()].filter((s) => s.status === 'working' || s.delegating).length;
  const n = state.sessions.size;
  rcSessions.textContent = `${n} sesión${n === 1 ? '' : 'es'} · ${working} activa${working === 1 ? '' : 's'}`;
}

function pad12(v) {
  return String(Math.floor(v)).padStart(12, '0').slice(-12); // odómetro de 12 dígitos
}

// El odómetro TREPA en tiempo real integrando el tps actual (movimiento continuo,
// "ver subir los tokens"); si la acumulación REAL por deltas (accumTokens) se
// adelanta, salta hacia arriba. Monotónico. `state.tok` guarda el máximo → es lo
// que se persiste. Es un contador de CAUDAL (estimación viva), no facturación
// exacta (para eso está el panel Uso).
function renderCounters(dt) {
  state.shown.claude += state.claudeTps * dt;
  state.shown.codex += state.codexTps * dt;
  if (state.shown.claude < state.tok.claude) state.shown.claude = state.tok.claude;
  if (state.shown.codex < state.tok.codex) state.shown.codex = state.tok.codex;
  state.tok.claude = Math.max(state.tok.claude, state.shown.claude);
  state.tok.codex = Math.max(state.tok.codex, state.shown.codex);
  rcClaudeNum.textContent = pad12(state.shown.claude);
  rcCodexNum.textContent = pad12(state.shown.codex);
  rcClaudeTps.textContent = `${state.claudeTps.toFixed(0)} t/s`;
  rcCodexTps.textContent = `${state.codexTps.toFixed(0)} t/s`;
}

function persistCounters(ts) {
  if (ts - state.lastSaveTs < 2000) return;
  state.lastSaveTs = ts;
  try {
    localStorage.setItem('cwc:rawcount:claude', String(Math.floor(state.tok.claude)));
    localStorage.setItem('cwc:rawcount:codex', String(Math.floor(state.tok.codex)));
  } catch { /* storage lleno/bloqueado: no crítico */ }
}

async function fetchJson(url) {
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function pollOnce() {
  const [flow, stream, chatList] = await Promise.all([
    fetchJson('/api/tokens/flow'),
    fetchJson(`/api/tokens/stream?since=${state.lastSeq}`),
    fetchJson('/api/chat/list'),
  ]);

  if (flow) {
    state.claudeTps = flow.claude?.tps || 0;
    state.codexTps = flow.codex?.tps || 0;
    accumTokens(flow.bySession, 'claude');
    accumTokens(flow.byCwd, 'codex');
  }

  let structuralChange = false;

  // Estado de sesión: una sesión de chat VIVA enciende su banda aunque aún no
  // haya escrito; las dormidas no crean banda (death las limpia si existían).
  if (chatList?.chats) {
    const aliveIds = new Set();
    for (const c of chatList.chats) {
      if (!c.sessionId) continue;
      const existed = state.sessions.has(c.sessionId);
      if (c.alive) {
        aliveIds.add(c.sessionId);
        const { born } = upsertSession(c.sessionId, {
          status: c.status === 'working' ? 'working' : (c.status || 'waiting'),
          chatAlive: true, delegating: !!c.delegating,
          world: worldFromCwd(c.cwd), model: c.model || c.modelChoice || undefined,
          title: c.title || undefined,
        });
        if (born) structuralChange = true;
      } else if (existed) {
        const s = state.sessions.get(c.sessionId);
        s.chatAlive = false; s.status = c.status || 'waiting'; s.delegating = false;
      }
    }
    // sesiones que teníamos como vivas por chat y ya no están → marcar no-vivas
    for (const [sid, s] of state.sessions) {
      if (s.chatAlive && !aliveIds.has(sid)) s.chatAlive = false;
    }
  }

  if (stream) {
    state.lastSeq = stream.lastSeq || state.lastSeq;
    for (const f of stream.fragments || []) {
      if (!f || !f.sessionId || !f.text) continue;
      if (ingestFragment(f)) structuralChange = true;
    }
  }

  if (pruneSessions()) structuralChange = true;
  if (structuralChange) relayout(); else layoutLabels(); // labels reflejan estado aunque no cambie el layout
  updateSessionsLine();
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

function renderStrip() {
  procsEl.innerHTML = '';
  const items = [...stripHealth, ...stripDaemons];
  for (const it of items) {
    const el = document.createElement('div'); el.className = 'raw-proc';
    const dot = document.createElement('span');
    dot.className = 'raw-proc-dot' + (it.status === 'fail' ? ' raw-proc-dot--fail' : it.status === 'warn' ? ' raw-proc-dot--warn' : '');
    const lab = document.createElement('span'); lab.className = 'raw-proc-lab'; lab.textContent = it.label;
    const meta = document.createElement('span'); meta.className = 'raw-proc-meta'; meta.textContent = it.meta || '';
    el.append(dot, lab, meta);
    procsEl.appendChild(el);
  }
  procsEl.style.display = items.length ? '' : 'none';
}

// A: procesos. role 'sdk' se ignora (ya llueve por transcript); 'job' llueve su
// fase como banda; 'service' va a la tira de latidos.
async function pollProcs() {
  if (state.stopped) return;
  const r = await fetchJson('/api/health/active-runners');
  const services = [];
  const jobIds = new Set();
  let changed = false;
  for (const p of (r && r.processes) || []) {
    if (p.role === 'sdk') continue;
    if (p.role === 'service') { services.push(p); continue; }
    const id = 'proc:' + p.key;
    jobIds.add(id);
    const { s, born } = upsertSession(id, { source: 'proc', world: 'proc', model: p.model || undefined });
    s.chatAlive = true; s.status = 'working'; s.lastTextTs = Date.now(); s.procLabel = p.label;
    const line = `${p.label} · ${p.phase || 'corriendo'}`;
    if (s._procLine !== line) { s._procLine = line; s.log = line; s.buf = (line + '   ').repeat(8); s.read = 0; s.energy = Math.min(1.1, s.energy + 0.2); }
    if (born) changed = true;
  }
  for (const [sid, s] of state.sessions) {
    if (s.source === 'proc' && !jobIds.has(sid)) { s.chatAlive = false; s.lastTextTs = 0; }
  }
  stripDaemons = services.map((p) => ({ label: p.label, meta: `${p.phase ? p.phase + ' · ' : ''}${fmtElapsed(p.startedAt)}`, status: 'ok' }));
  renderStrip();
  if (pruneSessions()) changed = true;
  if (changed) relayout(); else layoutLabels();
}

// C: terminales bash (capture-pane). Excluye isClaude (ya llueve por transcript).
async function pollTerminals() {
  if (state.stopped) return;
  const r = await fetchJson('/api/tmux/raw-feed');
  const present = new Set();
  let changed = false;
  for (const t of (r && r.terminals) || []) {
    if (t.isClaude) continue;
    const id = 'term:' + t.name;
    present.add(id);
    const { s, born } = upsertSession(id, { source: 'term', world: 'terminal', model: 'bash', title: t.customTitle || undefined });
    s.chatAlive = true; s.status = t.attached ? 'working' : 'waiting'; s.lastTextTs = Date.now();
    if (t.text && t.text !== s._pane) {
      s._pane = t.text;
      s.log = t.text.slice(-LOG_CAP);
      s.buf = t.text.slice(-PENDING_CAP); s.read = 0;
      s.energy = Math.min(1.1, s.energy + 0.25);
    }
    if (born) changed = true;
  }
  for (const [sid, s] of state.sessions) {
    if (s.source === 'term' && !present.has(sid)) { s.chatAlive = false; s.lastTextTs = 0; }
  }
  if (pruneSessions()) changed = true;
  if (changed) relayout(); else layoutLabels();
}

function scheduleProcs() { if (state.stopped) return; pollProcs().finally(() => { if (!state.stopped) setTimeout(scheduleProcs, PROC_POLL_MS); }); }
function scheduleTerminals() { if (state.stopped) return; pollTerminals().finally(() => { if (!state.stopped) setTimeout(scheduleTerminals, TERM_POLL_MS); }); }

// Servicios (signos vitales) desde los chequeos rápidos: 0 tokens pero /checks es
// pesado (corre node --check de todo) → poll lento (60s). LED por status.
async function pollHealth() {
  if (state.stopped) return;
  const r = await fetchJson('/api/health/checks');
  const checks = (r && r.checks) || [];
  stripHealth = checks
    .filter((c) => HEALTH_SERVICES[c.id])
    .map((c) => ({ label: HEALTH_SERVICES[c.id], meta: c.status === 'ok' ? '' : String(c.detail || c.status).slice(0, 22), status: c.status }));
  renderStrip();
}
function scheduleHealth() { if (state.stopped) return; pollHealth().finally(() => { if (!state.stopped) setTimeout(scheduleHealth, HEALTH_POLL_MS); }); }

function schedulePoll() {
  if (state.stopped) return;
  pollOnce().finally(() => { if (!state.stopped) setTimeout(schedulePoll, POLL_MS); });
}

function saveNow() {
  try {
    localStorage.setItem('cwc:rawcount:claude', String(Math.floor(state.tok.claude)));
    localStorage.setItem('cwc:rawcount:codex', String(Math.floor(state.tok.codex)));
  } catch { /* no crítico */ }
}
function stop() { state.stopped = true; saveNow(); window.close(); }

closeBtn.addEventListener('click', stop);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') stop(); });
window.addEventListener('beforeunload', saveNow);
// Responsive: recalcula canvas + bandas + rótulos + paneles + geometría al redimensionar.
let resizeT = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(resizeCanvas, 120);
});

resizeCanvas();
requestAnimationFrame(loop);
setInterval(typewriterTick, LOG_TICK_MS);
schedulePoll();
scheduleProcs();
scheduleTerminals();
scheduleHealth();
