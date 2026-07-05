// board/actions.js — handlers y endpoints del tablero.
//
// Regla de la arquitectura (R1/R2): las acciones NUNCA tocan el DOM — leen y
// escriben el store; el render (suscripto en index.js) pinta. Lo lento
// (runners desacoplados server-side) se encuesta vía polls.js POR CLAVE: los
// loops sobreviven a cualquier re-render y el resultado queda en el store.
// Confirms de tokens y de acciones destructivas: intactos (regla 6/7).

import * as store from './store.js';
import { poll } from './polls.js';
import { rowKey, warningsFor } from './labels.js';
import { pendingOf } from './render.js';
import {
  fetchContexts, workPrompt, featurePrompt, deskChatPrompt, triagePrompt,
  invTextOfPr, invTextOfTicket,
} from './prompts.js';

let deps = null; // { dialog, openChat, projectRel, updateRepo }
export function initActions(d) { deps = d; }

// ===== Lecturas persistidas (0 tokens: solo disco del server) =====
const deskGet = (ticket) => fetch(`/api/bugfixes/desk-live/${encodeURIComponent(ticket)}`)
  .then((r) => r.json()).catch(() => null);
const getInv = (pr) => fetch(`/api/bugfixes/investigation/${encodeURIComponent(pr)}`).then((r) => r.json()).catch(() => null);
const getTktInv = (n) => fetch(`/api/bugfixes/ticket-investigation/${encodeURIComponent(n)}`).then((r) => r.json()).catch(() => null);

// ===== Carga principal: tickets del motor + triage =====
export async function reload() {
  try {
    // FUENTE = el MOTOR: tickets consolidados (1 por número, attempts
    // embebidos, estado derivado). Se aplanan con ticketToRow para labels/render.
    const [bf, tk] = await Promise.all([
      fetch('/api/bugfixes/tickets').then((r) => r.json()),
      fetch('/api/bugs').then((r) => r.json()).catch(() => store.get().triage),
    ]);
    store.mutate((s) => {
      s.entries = (bf.tickets || []).map(store.ticketToRow);
      s.triage = tk || s.triage;
      s.loadError = false;
    });
  } catch {
    store.mutate((s) => { s.loadError = true; });
  }
}

export async function ghSync(silent) {
  if (store.get().busy.ghsync) return; // dedup (el auto-refresh puede pisar un click)
  store.mutate((s) => { s.busy.ghsync = true; });
  try {
    const res = await fetch('/api/bugfixes/refresh-prs', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Falló la consulta a GitHub.');
    store.mutate((s) => { s.ghRows = data.github || []; });
    await reload(); // re-deriva los tickets del motor (ghRows ya enganchados server-side)
    store.mutate((s) => { s.lastGhAt = Date.now(); s.ghError = false; });
    if (data.errors?.length && !silent) {
      await deps.dialog.alertDialog({ title: 'GitHub', message: `Algunos PRs no se pudieron consultar:\n${data.errors.join('\n')}` });
    }
  } catch (err) {
    store.mutate((s) => { s.ghError = true; });
    if (!silent) await deps.dialog.alertDialog({ title: 'GitHub', message: err.message });
  } finally {
    store.mutate((s) => { s.busy.ghsync = false; });
  }
}

// ===== Enviar pendientes: advertencias + repo al día + subida =====
export async function sendPending() {
  const state = store.get();
  const pendientes = pendingOf(state.entries);
  if (!pendientes.length) return;
  // PLAN DE PUSH por fix (pedido 2026-07-05: aprobar sabiendo QUÉ viaja):
  // destino (PR nuevo → branch calculado con la MISMA fórmula que pushPr, o
  // actualización del branch real del PR) + lista de archivos (tope 5).
  const lineas = pendientes.map((b) => {
    const w = warningsFor(b, state);
    const safeNum = String(b.ticketNumber || 'sn').replace(/[^\w.-]/g, '').slice(0, 20) || 'sn';
    const branch = b.prNumber
      ? (b.branch || '(branch del PR)')
      : (b.kind === 'feature' ? `feature/${safeNum.toLowerCase()}-${(b.sessionId || '').slice(0, 8)}` : `bugfix/tkt-${safeNum}-${(b.sessionId || '').slice(0, 8)}`);
    const files = b.files || [];
    const lista = files.slice(0, 5).map((f) => `\n       - ${f}`).join('') + (files.length > 5 ? `\n       … +${files.length - 5} más` : '');
    return `   • ${b.kind === 'feature' ? b.ticketNumber : `TKT #${b.ticketNumber}`} — ${b.prNumber ? `ACTUALIZA el PR #${b.prNumber}` : 'PR nuevo'} → ${branch} (${files.length} archivo/s)${lista}${w.length ? `\n     ⚠ ${w.join(' · ')}` : ''}`;
  });
  const conDeskAuto = pendientes.filter((b) => !b.sentAt && !b.prNumber && b.ticketNumber);
  const ok = await deps.dialog.confirmDialog({
    title: 'Enviar PR a Tolkien',
    message: `1. Se actualiza el repo (stash → pull → stash pop).\n2. Por cada fix pendiente (${pendientes.length}):\n${lineas.join('\n')}\n${conDeskAuto.length ? `\n3. Los PRs NUEVOS actualizan su ticket en Desk automáticamente (On Hold + nota corta en inglés): ${conDeskAuto.map((b) => `#${b.ticketNumber}`).join(', ')}.` : ''}\n\nSolo se toca ~/tolkien; tu árbol no cambia de branch.`,
    confirmLabel: `Actualizar y subir ${pendientes.length} PR(s)`,
    danger: pendientes.some((b) => warningsFor(b, state).length > 0),
  });
  if (!ok) return;
  store.mutate((s) => { s.busy.send = true; });
  try {
    const up = await deps.updateRepo();
    if (!up.ok) return await deps.dialog.alertDialog({ title: 'Enviar PR — actualización falló', message: up.message });
    const results = [];
    for (const b of pendientes) {
      try {
        const res = await fetch('/api/bugfixes/pr', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: b.sessionId }),
        });
        const data = await res.json().catch(() => ({}));
        results.push(res.ok
          ? `✓ TKT #${b.ticketNumber}: ${data.updated
            ? `PR ACTUALIZADO · commit ${data.commit || '?'}${data.commitCount ? ` (${data.commitCount}º del branch)` : ''} — el ticket NO se tocó: usá "Actualizar ticket (chat)"`
            : `PR nuevo${data.deskAuto ? ' · ticket de Desk actualizándose (auto)' : ''}`} → ${data.prUrl || data.branch}`
          : `✗ TKT #${b.ticketNumber}: ${data.error || 'falló'}`);
      } catch { results.push(`✗ TKT #${b.ticketNumber}: error de red`); }
    }
    await deps.dialog.alertDialog({ title: 'Enviar PR — resultado', message: results.join('\n') });
  } finally {
    store.mutate((s) => { s.busy.send = false; });
    await reload();
    ghSync(true);
  }
}

export async function scan() {
  store.mutate((s) => { s.busy.scan = true; });
  try {
    const res = await fetch('/api/bugfixes/scan', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Falló la búsqueda.');
    await reload(); // re-deriva del motor
    await deps.dialog.alertDialog({
      title: 'Buscar bugfixes',
      message: data.added ? `Se registraron ${data.added} fix(es) nuevos (${data.scanned} transcripts revisados).`
        : `Nada nuevo (${data.scanned} transcripts revisados).`,
    });
  } catch (err) { await deps.dialog.alertDialog({ title: 'Buscar bugfixes', message: err.message }); }
  finally { store.mutate((s) => { s.busy.scan = false; }); }
}

// ===== Sincronización Desk BULK de los tickets activos (CONSUME TOKENS) =====
// Un solo POST lanza el runner desacoplado para TODOS los tickets; luego se
// encuesta el lock hasta que la corrida termine (sobrevive al cambio de
// pestaña y a un reinicio del server). Desk NUNCA se consulta solo.
export async function deskSyncBulk() {
  const activos = store.get().entries.filter((b) => b.ticketNumber && b.resolution !== 'complete');
  if (!activos.length) return deps.dialog.alertDialog({ title: 'Desk', message: 'No hay tickets activos para consultar.' });
  const ok = await deps.dialog.confirmDialog({
    title: 'Sincronizar Desk',
    message: `Se consulta Zoho Desk el estado real de ${activos.length} ticket(s) activo(s) (respuesta publicada, resuelto).\n\nCONSUME TOKENS (una corrida de lectura por ticket). Los resueltos no se re-consultan.`,
    confirmLabel: `Consultar ${activos.length}`,
  });
  if (!ok) return;
  store.mutate((s) => { s.busy.desksync = true; s.deskSyncProgress = null; });
  const tickets = [...new Set(activos.map((b) => String(b.ticketNumber)))];
  try {
    const kickRes = await fetch('/api/bugfixes/desk-refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickets }),
    });
    const kick = await kickRes.json().catch(() => ({}));
    if (!kickRes.ok) throw new Error(kick.error || 'No se pudo lanzar la consulta a Zoho Desk.');
    await poll('desk:bulk', {
      timeoutMs: 6 * 60000,
      tick: async () => {
        const st = await deskGet(tickets[0]);
        store.mutate((s) => { s.deskSyncProgress = st?.progress || null; });
        return !st?.running;
      },
    });
  } catch (err) {
    store.mutate((s) => { s.busy.desksync = false; s.deskSyncProgress = null; });
    await deps.dialog.alertDialog({ title: 'Desk', message: err.message });
    return; // el lanzamiento falló: no hubo ciclo real, no tocar lastDeskAt/reload
  }
  store.mutate((s) => { s.busy.desksync = false; s.deskSyncProgress = null; s.lastDeskAt = Date.now(); });
  await reload(); // el motor ya lee los deskReplied/deskResolved recién persistidos
}

// ===== Desk por fila: dispara el runner y encuesta el resultado persistido =====
// (resiliente a re-render, colapso del panel y cambio de pestaña — clave R2)
export async function deskLoad(ticket, fresh) {
  store.mutate((s) => { s.desk[ticket] = { loading: true }; });
  let lastD = null;
  const finish = (d) => {
    store.mutate((s) => {
      // El backend ya persistió el snapshot en los registros del ticket;
      // reflejamos EN MEMORIA para que el render muestre pipeline/celda/chip
      // actualizados sin re-consultar (el re-render total ahora es seguro).
      for (const en of s.entries) {
        if (String(en.ticketNumber) === String(ticket) && d.found !== false) {
          en.deskResolved = d.resolved; en.deskClosed = d.closed;
          en.deskReplied = d.replied; en.deskStatusText = d.status; en.deskCheckedAt = d.fetchedAt;
          en.resolution = d.resolved ? 'complete' : (en.prState === 'merged' ? 'partial' : 'active');
        }
      }
      s.desk[ticket] = { data: d };
    });
  };
  try {
    // Estado previo persistido (para distinguir un resultado NUEVO del viejo).
    const prevAt = (await deskGet(ticket))?.desk?.fetchedAt || 0;
    // Disparar el runner (o reusar caché fresca si no es fresh). Responde YA.
    const kickRes = await fetch('/api/bugfixes/desk-refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickets: [ticket], fresh: !!fresh }),
    });
    const kick = await kickRes.json().catch(() => ({}));
    if (!kickRes.ok) throw new Error(kick.error || 'No se pudo lanzar la consulta a Zoho Desk.');
    const expectFresh = !!(kick.launched && kick.launched.length) || !!kick.started;
    await poll(`desk:${ticket}`, {
      timeoutMs: 5 * 60000, // tope defensivo (= timeout del runner)
      tick: async () => {
        const st = await deskGet(ticket);
        const running = !!st?.running;
        lastD = st?.desk || null;
        // Listo si hay resultado y ya no corre. Si RELANZAMOS, esperar el nuevo
        // (fetchedAt más nuevo que el previo): así no mostramos el dato viejo
        // en el hueco entre el POST y el primer heartbeat del runner.
        if (lastD && !running && (!expectFresh || (lastD.fetchedAt || 0) > prevAt)) {
          finish(lastD);
          return true;
        }
        store.mutate((s) => { s.desk[ticket] = { loading: true, progress: st?.progress || null }; });
        return false;
      },
      onTimeout: () => finish(lastD || { found: false, error: 'La consulta tardó demasiado.', fetchedAt: Date.now() }),
    });
  } catch (err) {
    store.mutate((s) => { s.desk[ticket] = { error: err.message }; });
  }
}

// ===== Panel "GitHub en vivo" de un PR (gh, caché server 60 s) =====
export async function loadLive(prNumber, fresh) {
  store.mutate((s) => { s.live[prNumber] = { loading: true }; });
  try {
    const res = await fetch(`/api/bugfixes/pr-live/${prNumber}${fresh ? '?fresh=1' : ''}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'GitHub no disponible.');
    store.mutate((s) => { s.live[prNumber] = { data: data.live }; });
  } catch (err) {
    store.mutate((s) => { s.live[prNumber] = { error: err.message }; });
  }
}

// ===== Investigación a fondo de un PR (runner IA, bajo botón) =====
export async function loadInvestigation(pr) {
  store.mutate((s) => { s.inv[pr] = { loading: true }; });
  const st = await getInv(pr);
  store.mutate((s) => { s.inv[pr] = { st: st || {} }; });
}

export async function runInvestigation(pr, ticket) {
  const prevAt = (await getInv(pr))?.investigation?.fetchedAt || 0;
  store.mutate((s) => { s.inv[pr] = { running: true }; });
  try {
    const res = await fetch('/api/bugfixes/investigate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pr, ticket: ticket || null, fresh: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No se pudo lanzar la investigación.');
  } catch (err) {
    await deps.dialog.alertDialog({ title: 'Investigar PR', message: err.message });
    await loadInvestigation(pr); // restaura el botón (no quedó lanzada)
    return;
  }
  await poll(`inv:${pr}`, {
    timeoutMs: 5 * 60000,
    tick: async () => {
      const st = await getInv(pr);
      const inv = st?.investigation;
      return !!(inv && !st.running && (inv.fetchedAt || 0) > prevAt);
    },
  });
  await loadInvestigation(pr);
}

// ===== Investigación de CONTEXTO (ticket sin PR): lee Tolkien read-only =====
export async function loadTicketInvestigation(ticket) {
  store.mutate((s) => { s.tktInv[ticket] = { loading: true }; });
  const st = await getTktInv(ticket);
  store.mutate((s) => { s.tktInv[ticket] = { st: st || {} }; });
}

export async function runTicketInvestigation(ticket, problem) {
  const prevAt = (await getTktInv(ticket))?.investigation?.fetchedAt || 0;
  store.mutate((s) => { s.tktInv[ticket] = { running: true }; });
  try {
    const res = await fetch('/api/bugfixes/ticket-investigate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket, problem: problem || {}, fresh: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No se pudo lanzar la investigación.');
  } catch (err) {
    await deps.dialog.alertDialog({ title: 'Investigar ticket', message: err.message });
    await loadTicketInvestigation(ticket); // restaura el botón (no quedó lanzada)
    return;
  }
  await poll(`tktinv:${ticket}`, {
    timeoutMs: 6 * 60000,
    tick: async () => {
      const st = await getTktInv(ticket);
      const inv = st?.investigation;
      return !!(inv && !st.running && (inv.fetchedAt || 0) > prevAt);
    },
  });
  await loadTicketInvestigation(ticket);
}

// ===== Expansión (estado en el store, R1) + cargas lazy del detalle =====
export function toggleExpand(key, row) {
  const opening = !store.get().expanded.has(key);
  store.mutate((s) => { if (opening) s.expanded.add(key); else s.expanded.delete(key); });
  if (!opening || !row) return;
  // Al expandir por primera vez: panel GitHub en vivo + veredicto persistido
  // de la investigación (0 tokens). Los datos quedan en el store: colapsar y
  // re-expandir NO re-fetchea (↻ fuerza fresh).
  const s = store.get();
  if (row.prNumber && !s.live[row.prNumber]) loadLive(row.prNumber, false);
  if (row.prNumber && !s.inv[row.prNumber]) loadInvestigation(row.prNumber);
  if (!row.prNumber && row.ticketNumber && !s.tktInv[row.ticketNumber]) loadTicketInvestigation(row.ticketNumber);
}

export function toggleArch() {
  store.mutate((s) => { s.archOpen = !s.archOpen; });
}

// ===== Chats del ciclo (cierran el tablero y abren pestañas del SDK) =====
export async function workOn(b) {
  const [workContext, prContext] = await fetchContexts();
  const isFeature = b.kind === 'feature';
  // Veredicto de la investigación (si se corrió): sus pasos guían el trabajo.
  // Features sin PR no tienen investigación (el runner es de tickets de Desk).
  let invText = '';
  if (b.prNumber) {
    invText = invTextOfPr((await getInv(b.prNumber))?.investigation?.lectura);
  } else if (b.ticketNumber && !isFeature) {
    invText = invTextOfTicket((await getTktInv(b.ticketNumber))?.investigation?.lectura);
  }
  await deps.openChat({
    cwd: deps.projectRel(), mode: isFeature && !b.files?.length ? 'plan' : 'default',
    prompt: (isFeature ? featurePrompt : workPrompt)(b, { invText, workContext, prContext }),
    title: (isFeature ? `Feature ${b.ticketNumber}` : `PR en progreso · TKT #${b.ticketNumber}`).slice(0, 60),
    ticket: { number: b.ticketNumber, url: b.ticketUrl || null },
  });
}

// ===== Alta manual de un FEATURE (FEAT-n del motor, admin) =====
// REGLA de clasificación (2026-07-04): el tablero es SOLO Tolkien — features
// de la consola u otros proyectos NO se cargan acá (el hint lo recuerda).
export async function newFeature() {
  const title = await deps.dialog.promptDialog({
    title: 'Nuevo feature — Tolkien',
    message: 'Título corto del feature. OJO: el tablero es SOLO para features de TOLKIEN (los de la consola u otros proyectos van por su propio repo).',
    placeholder: 'p.ej. Export CSV del reporte de PTO',
  });
  if (!title || title.trim().length < 3) return;
  await deps.dialog.textEditorDialog({
    title: `Enunciado — ${title.trim().slice(0, 40)}`,
    hint: 'Describí QUÉ se quiere lograr y para quién (esto es lo que leerá el chat de trabajo como enunciado permanente del feature).',
    value: '',
    saveLabel: 'Crear feature',
    onSave: async (text) => {
      const res = await fetch('/api/bugfixes/feature', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description: String(text || '').trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo crear el feature.');
    },
  });
  await reload();
}

// Chat "Actualizar/Responder ticket": SIN ticket:{} a propósito — un chat de
// comunicación no debe re-registrar trabajo (recordBugfix devolvería el fix a
// 'pendiente'). La escritura en Desk la aprueba el usuario en el chat.
export async function deskChat(b) {
  const hasPr = !!b.prNumber;
  await deps.openChat({
    cwd: deps.projectRel(), mode: 'default',
    prompt: deskChatPrompt(b),
    title: `Ticket #${b.ticketNumber} · ${hasPr ? 'update' : 'respuesta'}`.slice(0, 60),
  });
}

// Ticket del triage sin trabajo: mismo flujo que la sección Bugs (modo plan).
export async function workOnTriage(t) {
  const [workContext, prContext] = await fetchContexts();
  const invText = invTextOfTicket((await getTktInv(t.ticketNumber))?.investigation?.lectura, { yaHecha: true });
  await deps.openChat({
    cwd: deps.projectRel(), mode: 'plan',
    prompt: triagePrompt(t, { invText, workContext, prContext }),
    title: `TKT #${t.ticketNumber} — ${t.whatBroke}`.slice(0, 60),
    ticket: { number: t.ticketNumber, url: t.webUrl || null },
  });
}

// ===== Acciones por fila (confirms destructivos intactos) =====
export async function cancelPr(b) {
  const ok = await deps.dialog.confirmDialog({
    title: `Cancelar PR — TKT #${b.ticketNumber || '?'}`,
    message: `Se cierra el PR${b.prNumber ? ` #${b.prNumber}` : ''} en GitHub (sin mergear), se borra el branch remoto${b.branch ? ` (${b.branch})` : ''} y el fix vuelve a PENDIENTE.\n\nNo se toca tu árbol de trabajo ni los archivos del fix.`,
    confirmLabel: 'Cancelar PR', danger: true,
  });
  if (!ok) return;
  const key = rowKey(b);
  store.mutate((s) => { s.busy[`act:${key}`] = true; });
  try {
    const res = await fetch('/api/bugfixes/cancel-pr', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: b.sessionId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'No se pudo cancelar el PR.');
    await deps.dialog.alertDialog({ title: 'PR cancelado', message: `${(data.steps || []).map((s) => `• ${s}`).join('\n') || '• Listo.'}` });
  } catch (err) {
    await deps.dialog.alertDialog({ title: 'Cancelar PR', message: err.message });
  } finally {
    store.mutate((s) => { delete s.busy[`act:${key}`]; });
    await reload(); ghSync(true);
  }
}

// Archivar / restaurar: solo organización del tablero (no toca código ni PRs).
// Un ticket puede tener varios intentos: archivar/restaurar TODOS para que el
// estado consolidado del motor quede coherente.
export async function archive(b, archived) {
  const key = rowKey(b);
  store.mutate((s) => { s.busy[`act:${key}`] = true; });
  const ids = b.allSessionIds?.length ? b.allSessionIds : [b.sessionId];
  try {
    for (const id of ids) {
      const res = await fetch('/api/bugfixes/archive', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, archived }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo archivar.');
    }
  } catch (err) {
    await deps.dialog.alertDialog({ title: 'Archivo', message: err.message });
  } finally {
    store.mutate((s) => { delete s.busy[`act:${key}`]; });
    await reload();
  }
}

export async function discard(b) {
  const ok = await deps.dialog.confirmDialog({
    title: `Descartar registro — TKT #${b.ticketNumber || '?'}`,
    message: 'Se borra SOLO el registro local del fix (no toca código, branches ni PRs en GitHub).',
    confirmLabel: 'Descartar', danger: true,
  });
  if (!ok) return;
  const key = rowKey(b);
  store.mutate((s) => { s.busy[`act:${key}`] = true; });
  const ids = b.allSessionIds?.length ? b.allSessionIds : [b.sessionId];
  try {
    for (const id of ids) {
      const res = await fetch('/api/bugfixes/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo descartar el registro.');
    }
  } catch (err) {
    await deps.dialog.alertDialog({ title: 'Descartar registro', message: err.message });
  } finally {
    store.mutate((s) => { delete s.busy[`act:${key}`]; });
    await reload();
  }
}
