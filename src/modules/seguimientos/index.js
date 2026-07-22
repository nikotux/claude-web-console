// modules/seguimientos/index.js — Dashboard "Seguimientos" (PLAN-553).
// Primer habitante de LIMBO (Regla dura #13 / CONVE-554): mapea el trabajo
// HUMANO-accionable de Niko (tareas que requieren su intervención) — NUNCA
// backend/dev. Se alimenta del mundo externo (Zoho Desk, correos) por la
// ADUANA read-only → snapshot interno; el dashboard lee SIEMPRE del snapshot.
// Regla de resolución (PLAN-553): el dashboard NO resuelve nada solo — lanza
// una SESIÓN y la sesión reporta los avances de vuelta al snapshot.
//
// Ruta: /api/seguimientos.  Estado: F0 (esqueleto) — sirve el snapshot; la
// ingesta (F1), las vistas (F2) y el bucle de resolución (F3) se agregan encima.
import express from 'express';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { config } from '../../core/config.js';
import { principalOf } from '../../core/auth.js';
import { hostUser } from '../../core/user-space.js';
import { manager } from '../chat/index.js';
import { textOnlyQuery } from '../../core/text-only-query.js';
import { ensureDir, readSnapshot, writeSnapshot } from './store.js';
import { refreshNow, isRefreshing } from './refresher.js';
import { readHistory } from './history-store.js';
import { fetchCalendar } from './calendar-source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONSOLE_ROOT = path.join(__dirname, '..', '..', '..');
const RUNNER = path.join(__dirname, '..', '..', '..', 'bin', 'cwc-seguimientos-runner.js');
const WHATSAPP_FILE = path.join(os.homedir(), '.cwc-data', 'comms', 'whatsapp.json');
const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function userOf(req) {
  const p = principalOf(req);
  // El token maestro no identifica a Niko en particular; mantenemos la misma
  // caída al usuario host que usan las conexiones OAuth.
  return p?.username || hostUser();
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function defaultCalendarRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  from.setDate(from.getDate() - 7);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  to.setDate(to.getDate() + 7);
  return { from: dateKey(from), to: dateKey(to) };
}

function utcDayMs(dayKey) {
  const y = Number(dayKey.slice(0, 4));
  const m = Number(dayKey.slice(5, 7));
  const d = Number(dayKey.slice(8, 10));
  return Date.UTC(y, m - 1, d);
}

// Disciplina de la SESIÓN-LIMBO (Regla 13): herramientas de ambos mundos, con
// límites duros. Se apendea al prompt de toda sesión lanzada desde el dashboard.
function limboFooter() {
  return [
    '',
    '--- SESIÓN EN LIMBO (herramientas de ambos mundos) ---',
    'Para triangular podés consultar las 4 fuentes:',
    '• Tickets/Desk, Correo y Teams: usá las tools del MCP (desk_*, graph_read_email, graph_read_chat_messages).',
    `• WhatsApp: leé ${WHATSAPP_FILE} con Read (mensajes indexados por la consola; media en la carpeta whatsapp-media/).`,
    'DISCIPLINA (Regla 13 / Limbo): leé libremente de las 4 fuentes; para ESCRIBIR en Desk NO uses las tools desk_* del MCP, porque publican a nombre de otro agente.',
    'Usá el CLI de la consola, que escribe con la identidad de Niko:',
    `• node ${CONSOLE_ROOT}/bin/cwc-desk.js comment <nroTicket> "<texto>"  (nota interna; agregá --public para visible al cliente)`,
    `• node ${CONSOLE_ROOT}/bin/cwc-desk.js assign <nroTicket>`,
    `• node ${CONSOLE_ROOT}/bin/cwc-desk.js attach <nroTicket> <rutaArchivo>`,
    `• node ${CONSOLE_ROOT}/bin/cwc-desk.js update <nroTicket> --status="..."`,
    'Para el CALENDARIO de Niko (conexión Microsoft propia, identidad de Niko — NO uses tools del MCP para esto):',
    `• node ${CONSOLE_ROOT}/bin/cwc-calendar.js list [--from=YYYY-MM-DD --to=YYYY-MM-DD]`,
    `• node ${CONSOLE_ROOT}/bin/cwc-calendar.js create --subject="..." --start="2026-07-23T09:00:00" --end="2026-07-23T09:30:00" [--reminder=<min>] [--body="..."]`,
    `• node ${CONSOLE_ROOT}/bin/cwc-calendar.js delete <eventId>`,
    'Zona horaria por defecto America/Bogota. Los ETA/dueDate de tickets deberían reflejarse acá.',
    'SIEMPRE esperá mi aprobación explícita antes de escribir.',
    'NUNCA sincronices los dos Pad ni escribas fuera del ticket. El ticket es la columna vertebral.',
  ].join('\n');
}

export default {
  name: 'seguimientos',

  init() { ensureDir(); },

  registerHttp(router) {
    const r = express.Router();

    // Snapshot completo del dashboard (frentes + conteos). 0 tokens: solo disco.
    r.get('/', (req, res) => {
      res.json({ ...readSnapshot(), refreshing: isRefreshing() });
    });

    // Dispara la ADUANA (Zoho Desk read-only → snapshot). Responde YA; el front
    // encuesta GET / hasta que `refreshing` pase a false. 0 tokens (determinístico).
    r.post('/refresh', (req, res) => {
      if (isRefreshing()) return res.json({ started: false, running: true });
      refreshNow().catch((e) => console.error('[seguimientos] refresh:', e.message));
      res.json({ started: true });
    });

    // Dispara el CLASIFICADOR IA (runner desacoplado, regla de oro — consume
    // tokens Haiku). Responde YA; el front encuesta GET / hasta `classifying`=false.
    r.post('/classify', (req, res) => {
      const child = spawn(process.execPath, [RUNNER], { detached: true, stdio: 'ignore', cwd: path.join(__dirname, '..', '..', '..') });
      child.unref();
      res.json({ started: true });
    });

    // BUCLE DE RESOLUCIÓN (F3, PLAN-553): el dashboard NO resuelve solo — lanza
    // una SESIÓN con el contexto del frente. Si implica escribir al mundo externo
    // (proveedor/colega), la sesión redacta y ESPERA aprobación (Limbo Ley 3).
    // Los frentes de Desk son del mundo externo → la sesión abre en cwd Tolkien
    // (ahí viven las tools para actuar el ticket).
    r.post('/resolve', (req, res) => {
      const key = String(req.body?.key || '');
      const snap = readSnapshot();
      const f = (snap.frentes || []).find((x) => String(x.key) === key);
      if (!f) return res.status(404).json({ error: 'Frente no encontrado.' });
      const prompt = [
        'Estoy trabajando este pendiente desde mi dashboard "Seguimientos":',
        `- Frente: #${f.key} — ${f.title}`,
        `- Dominio: ${f.domain}`,
        `- Pelota / bloqueador: ${f.ownerBall || '?'} (${f.ownerType || '?'})`,
        f.nextAction ? `- Próxima acción sugerida: ${f.nextAction}` : '',
        f.webUrl ? `- Ticket: ${f.webUrl}` : '',
        '',
        'Ayudame a avanzarlo. Si implica escribir a alguien externo (proveedor/colega),',
        'redactá el mensaje y ESPERÁ mi aprobación antes de enviar (regla de mundos / Limbo).',
      ].filter(Boolean).join('\n');
      const chat = manager.create({
        cwd: f.world === 'externo' ? config.projectDir : process.cwd(),
        model: 'auto',
        permissionMode: 'default',
        limbo: true,
        title: `#${f.key} ${String(f.title).slice(0, 22)}`,
      });
      try { chat.sendUser(prompt); } catch { /* el chat queda creado igual */ }
      f.sessionRef = chat.info().id;
      writeSnapshot(snap);
      res.json({ chatId: chat.info().id });
    });

    // RESOLVER EN LOTE (F5): varios frentes seleccionados → UNA sesión con el
    // contexto de TODOS (p.ej. si me bloquea la misma persona en varios ítems).
    r.post('/resolve-bulk', (req, res) => {
      const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : [];
      const snap = readSnapshot();
      const sel = (snap.frentes || []).filter((f) => keys.includes(String(f.key)));
      if (!sel.length) return res.status(404).json({ error: 'Sin frentes seleccionados.' });
      const lines = sel.map((f) => `- #${f.key} — ${f.title} · pelota: ${f.ownerBall || '?'} (${f.ownerType || '?'})${f.nextAction ? ` · próxima: ${f.nextAction}` : ''}${f.webUrl ? ` · ${f.webUrl}` : ''}`);
      const prompt = [
        `Estoy trabajando ESTOS ${sel.length} pendientes JUNTOS desde mi dashboard "Seguimientos" (suelen compartir bloqueador/tema):`,
        ...lines,
        '',
        'Ayudame a avanzarlos en conjunto. Si implica escribir a alguien externo, redactá UN mensaje que los cubra a todos y ESPERÁ mi aprobación antes de enviar.',
        limboFooter(),
      ].join('\n');
      const chat = manager.create({ cwd: config.projectDir, model: 'auto', permissionMode: 'default', limbo: true, title: `${sel.length} frentes seleccionados` });
      try { chat.sendUser(prompt); } catch { /* noop */ }
      const id = chat.info().id;
      for (const f of sel) f.sessionRef = id;
      writeSnapshot(snap);
      res.json({ chatId: id, count: sel.length });
    });

    // ACTUALIZACIONES (G4/G5): abre una SESIÓN-LIMBO que escanea las 4 fuentes
    // por updates de mis tickets y propone un plan de actualización (aplica con OK).
    r.post('/scan-updates', (req, res) => {
      const keys = Array.isArray(req.body?.keys) && req.body.keys.length ? req.body.keys.map(String) : null;
      const snap = readSnapshot();
      const sel = keys ? (snap.frentes || []).filter((f) => keys.includes(String(f.key))) : (snap.frentes || []);
      const lines = sel.slice(0, 40).map((f) => `- #${f.key} — ${f.title}${f.ownerBall ? ` · pelota: ${f.ownerBall}` : ''}`);
      const prompt = [
        `Escaneá ACTUALIZACIONES para MIS tickets (${sel.length}). Por cada uno, revisá si hay novedades en Correo, Teams o WhatsApp que todavía NO se reflejaron en el ticket de Zoho Desk, cruzando por el CONTEXTO del ticket (sin reglas duras: usá tu razonamiento).`,
        'Tickets:',
        ...lines,
        (sel.length > 40 ? `… y ${sel.length - 40} más (empezá por estos).` : ''),
        '',
        'Presentame un PLAN de actualización por ticket (qué comentario/cambio aplicar y de qué fuente salió). Aplicá los updates a Desk SOLO con mi OK. Si aparece un pedido SIN ticket, ofrecé convertirlo en ticket.',
        limboFooter(),
      ].filter(Boolean).join('\n');
      const chat = manager.create({ cwd: config.projectDir, model: 'opus', permissionMode: 'default', limbo: true, title: `Actualizaciones (${sel.length})` });
      try { chat.sendUser(prompt); } catch { /* noop */ }
      res.json({ chatId: chat.info().id });
    });

    // STANDUP (reunión diaria): abre una SESIÓN con el panorama del día ya
    // masticado (0 tokens para armarlo: sale del snapshot). El chat repasa qué
    // hay por hacer / qué llegó / qué terminamos / qué está trabado y puede
    // actualizar tickets SOLO con aprobación (Limbo). `digest` opcional del front.
    r.post('/standup', (req, res) => {
      const snap = readSnapshot();
      const frentes = snap.frentes || [];
      const c = snap.counts || {};
      const digest = req.body?.digest && typeof req.body.digest === 'object' ? req.body.digest : null;
      // Top trabados: más días sin señal (proxy de "atascado").
      const stuck = frentes.slice().sort((a, b) => (b.daysIdle || 0) - (a.daysIdle || 0)).slice(0, 6)
        .map((f) => `- #${f.key} — ${f.title} · ${f.daysIdle || 0}d sin señal${f.ownerBall ? ` · pelota: ${f.ownerBall}` : ''}`);
      // Reparto por proyecto.
      const byProj = {};
      for (const f of frentes) { const p = f.project || '—'; byProj[p] = (byProj[p] || 0) + 1; }
      const projLines = Object.entries(byProj).sort((a, b) => b[1] - a[1]).map(([p, n]) => `- ${p}: ${n}`);
      const deltaLines = digest ? [
        `- Nuevos desde la última visita: ${digest.nuevos ?? 0}`,
        `- Terminados desde la última visita: ${digest.terminados ?? 0}`,
        `- Por vencer (vencidos/hoy/semana): ${digest.porVencer ?? 0}`,
        `- Trabados: ${digest.trabados ?? 0}`,
      ] : [];
      const prompt = [
        'Reunión diaria (standup) de mis Seguimientos. Este es el panorama de HOY, ya armado:',
        `Total abiertos: ${c.total ?? frentes.length} · míos (asignados/tag Niko): ${c.mine ?? 0} · con deadline: ${c.withDeadline ?? 0} · completados (ventana): ${c.done ?? 0}.`,
        ...(deltaLines.length ? ['', 'Cambios desde la última vez:', ...deltaLines] : []),
        '',
        'Reparto por proyecto:',
        ...projLines,
        '',
        'Frentes más atascados (por días sin señal):',
        ...stuck,
        '',
        'Repasemos como en una reunión diaria: qué debería hacer hoy, qué llegó nuevo, qué terminamos, qué está trabado y de quién es la pelota.',
        'Si algo amerita actualizar un ticket, redactá el cambio y ESPERÁ mi aprobación antes de escribir a Desk.',
        limboFooter(),
      ].join('\n');
      const chat = manager.create({ cwd: config.projectDir, model: 'opus', permissionMode: 'default', limbo: true, title: 'Standup del día' });
      try { chat.sendUser(prompt); } catch { /* noop */ }
      res.json({ chatId: chat.info().id });
    });

    // VISTA CON IA (G6): filtro por lenguaje natural → devuelve las keys que matchean.
    r.post('/ai-filter', async (req, res) => {
      const q = String(req.body?.query || '').slice(0, 500).trim();
      if (!q) return res.status(400).json({ error: 'Pedido vacío.' });
      const snap = readSnapshot();
      const items = (snap.frentes || []).map((f) => ({ key: f.key, title: f.title, domain: f.domain, ownerBall: f.ownerBall, ownerType: f.ownerType, involucrados: f.involucrados, nextAction: f.nextAction, daysIdle: f.daysIdle, status: f.status }));
      const prompt = `Tenés estos frentes (tickets). Devolvé SOLO un array JSON con los "key" que matcheen este pedido en lenguaje natural, sin explicación.\nPedido: "${q}"\n\nFrentes:\n${JSON.stringify(items)}\n\nSalida: ["key",...] (solo los que matchean; [] si ninguno).`;
      try {
        const text = await textOnlyQuery(prompt, { model: 'haiku', maxTurns: 1, timeoutMs: 60000 });
        const m = text.replace(/```(?:json)?/gi, '').match(/\[[\s\S]*\]/);
        const keys = m ? JSON.parse(m[0]).map(String) : [];
        res.json({ keys });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Historia diaria para los gráficos de tendencia de Métricas (0 tokens).
    r.get('/history', (req, res) => {
      res.json({ days: readHistory() });
    });

    // Calendario Microsoft: HTTP determinístico y best-effort. Si Graph falla,
    // el dashboard sigue vivo y muestra el calendario de tickets con un aviso.
    r.get('/calendar', async (req, res) => {
      const defaults = defaultCalendarRange();
      const from = String(req.query.from || defaults.from);
      const to = String(req.query.to || defaults.to);
      if (!DATE_RE.test(from) || !DATE_RE.test(to)) return res.status(400).json({ error: 'Rango inválido.' });
      if (utcDayMs(to) < utcDayMs(from) || (utcDayMs(to) - utcDayMs(from)) / DAY_MS > 120) {
        return res.status(400).json({ error: 'Rango inválido.' });
      }
      try {
        const out = await fetchCalendar(userOf(req), {
          from: `${from}T00:00:00-05:00`,
          to: `${to}T23:59:59-05:00`,
          fresh: req.query.fresh === '1',
        });
        res.json(out);
      } catch (e) {
        res.json({ connected: false, byDay: {}, count: 0, error: e.message });
      }
    });

    // Ping del módulo (diagnóstico de que cargó y hay snapshot).
    r.get('/health', (req, res) => {
      const snap = readSnapshot();
      res.json({ ok: true, frentes: snap.frentes.length, updatedAt: snap.updatedAt });
    });

    router.use('/seguimientos', r);
  },
};
