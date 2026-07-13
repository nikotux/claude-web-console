// board/actions.js — handlers/endpoints del tablero de Comunicaciones. Escriben
// al store, JAMÁS al DOM (patrón bugs/board/actions.js).
import * as store from './store.js';
import { poll } from './polls.js';

let deps = {};
export function initActions(d) { deps = d; }

async function jget(url) {
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Error');
  return d;
}
async function jpost(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Error');
  return d;
}
function showError(message) { deps.dialog?.alertDialog?.({ title: 'Error', message: String(message) }); }

export async function reload() {
  try {
    const idx = await jget('/api/comms/index');
    const patch = {
      threads: idx.threads || [],
      contacts: idx.contacts || [],
      projects: idx.projects || [],
      self: idx.self || null,
      scannedAt: idx.scannedAt || null,
      running: !!idx.running,
      teamsRunning: !!idx.teamsRunning,
      chatbotRunning: !!idx.chatbotRunning,
      loadError: false,
    };
    const cur = store.get().tab;
    if (!cur || !patch.contacts.some((c) => c.id === cur)) patch.tab = patch.contacts[0]?.id || null;
    store.set(patch);
  } catch { store.set({ loadError: true }); }
}

export async function scan() {
  if (store.get().busy.scan) return;
  const ok = await deps.dialog.confirmDialog({
    title: 'Escanear comunicaciones',
    message: 'Trae de GitHub (gh) las reviews y comentarios de tus contactos sobre Tolkien.\nEs de SOLO LECTURA y NO consume tokens.',
    confirmLabel: 'Escanear',
  });
  if (!ok) return;
  store.mutate((s) => { s.busy.scan = true; s.running = true; });
  try {
    await jpost('/api/comms/refresh');
    await poll('scan', {
      tick: async () => {
        const st = await jget('/api/comms/index').catch(() => null);
        if (!st) return false;
        if (!st.running) {
          store.set({ threads: st.threads || [], contacts: st.contacts || [], projects: st.projects || [], scannedAt: st.scannedAt || null, running: false });
          return true;
        }
        store.set({ threads: st.threads || [], running: true });
        return false;
      },
      intervalMs: 2500,
      timeoutMs: 4 * 60000,
    });
  } catch (e) { showError(e.message); }
  finally { store.mutate((s) => { s.busy.scan = false; s.running = false; }); }
}

export async function scanTeams() {
  if (store.get().busy.scanTeams) return;
  const ok = await deps.dialog.confirmDialog({
    title: 'Escanear Teams',
    message: 'Lee de Microsoft Teams (MCP de Tolkien, SOLO lectura) los mensajes directos recientes con tus contactos.\nCONSUME TOKENS y puede tardar 1-3 min. No envía ni modifica nada.',
    confirmLabel: 'Escanear Teams',
  });
  if (!ok) return;
  store.mutate((s) => { s.busy.scanTeams = true; s.teamsRunning = true; });
  try {
    await jpost('/api/comms/teams-refresh');
    await poll('teams-scan', {
      tick: async () => {
        const st = await jget('/api/comms/index').catch(() => null);
        if (!st) return false;
        if (!st.teamsRunning) {
          store.set({ threads: st.threads || [], scannedAt: st.scannedAt || null, teamsRunning: false });
          return true;
        }
        store.set({ threads: st.threads || [], teamsRunning: true });
        return false;
      },
      intervalMs: 3000,
      timeoutMs: 5 * 60000,
    });
  } catch (e) { showError(e.message); }
  finally { store.mutate((s) => { s.busy.scanTeams = false; s.teamsRunning = false; }); }
}

// Deriva la sección "🤖 Chatbot" de lo que ya escaneamos del bot de Teams:
// (1) lee los mensajes relayados del bot (Graph, read-only) y (2) interpreta con
// IA quién es la persona REAL detrás de cada uno, atribuyéndolo a un contacto.
// CONSUME TOKENS (Graph read + interpretación). No solo Chris: cualquier contacto.
export async function scanChatbot() {
  if (store.get().busy.scanChatbot) return;
  const ok = await deps.dialog.confirmDialog({
    title: 'Actualizar chatbot',
    message: 'Lee los mensajes que el bot Tolkien (TheEye) te relayó en Teams e interpreta con IA quién es la persona real detrás de cada uno (Chris u otros contactos), alimentando la sección 🤖 Chatbot.\nCONSUME TOKENS y puede tardar 1-3 min. Es SOLO LECTURA: no envía ni modifica nada. Suma sin pisar lo anterior.',
    confirmLabel: 'Actualizar chatbot',
  });
  if (!ok) return;
  store.mutate((s) => { s.busy.scanChatbot = true; s.chatbotRunning = true; });
  try {
    await jpost('/api/comms/chatbot-refresh');
    await poll('chatbot-scan', {
      tick: async () => {
        const st = await jget('/api/comms/index').catch(() => null);
        if (!st) return false;
        if (!st.chatbotRunning) {
          store.set({ threads: st.threads || [], contacts: st.contacts || [], scannedAt: st.scannedAt || null, chatbotRunning: false });
          return true;
        }
        store.set({ threads: st.threads || [], chatbotRunning: true });
        return false;
      },
      intervalMs: 3000,
      timeoutMs: 6 * 60000,
    });
  } catch (e) { showError(e.message); }
  finally { store.mutate((s) => { s.busy.scanChatbot = false; s.chatbotRunning = false; }); }
}

export function toggleExpand(id) {
  const wasOpen = store.get().expanded.has(id);
  store.mutate((s) => { if (wasOpen) s.expanded.delete(id); else s.expanded.add(id); });
  if (!wasOpen) markSeen(id);
}

export async function markSeen(id) {
  try {
    await jpost(`/api/comms/thread/${encodeURIComponent(id)}/seen`);
    store.mutate((s) => { const t = s.threads.find((x) => x.id === id); if (t) t.newFromContact = false; });
  } catch { /* noop */ }
}

export async function archive(id, archived) {
  try { await jpost(`/api/comms/thread/${encodeURIComponent(id)}/archive`, { archived }); await reload(); }
  catch (e) { showError(e.message); }
}

export async function assignProject(id) {
  const name = await deps.dialog.promptDialog({
    title: 'Asignar proyecto',
    message: 'Nombre del proyecto (existente o nuevo). Vacío = sin proyecto.',
    placeholder: 'Ej: Tolkien · Auth · Facturación',
  });
  if (name === null) return;
  const clean = String(name).trim();
  try {
    await jpost(`/api/comms/thread/${encodeURIComponent(id)}/project`, { project: clean || null });
    const exists = store.get().projects.some((p) => p.name.toLowerCase() === clean.toLowerCase());
    if (clean && !exists) await jpost('/api/comms/project', { name: clean }).catch(() => {});
    await reload();
  } catch (e) { showError(e.message); }
}

export async function addContact() {
  const name = await deps.dialog.promptDialog({ title: 'Nuevo contacto', message: 'Nombre del contacto:', placeholder: 'Ej: Chris' });
  if (name === null || !String(name).trim()) return;
  const github = await deps.dialog.promptDialog({ title: 'Nuevo contacto', message: `Usuario de GitHub de ${name} (opcional, sin @):`, placeholder: 'cswenor' });
  const email = await deps.dialog.promptDialog({ title: 'Nuevo contacto', message: `Email de ${name} para Teams (opcional):`, placeholder: 'nombre@empresa.com' });
  try {
    const d = await jpost('/api/comms/contact', { name: String(name).trim(), github: github ? String(github).trim() : null, email: email ? String(email).trim() : null });
    await reload();
    store.set({ tab: d.contact.id });
  } catch (e) { showError(e.message); }
}

// Composer: ENVÍA de verdad un DM de Teams al contacto (vía el gateway
// GW.sendComm → runner de envío, que firma con "— Nicolás (dev team)" y deja
// el registro en el hilo con appendManual). A diferencia de logManual (que
// solo ANOTA), esto publica en Teams con tu identidad — por eso confirm duro,
// y por eso siempre pasa contactId (así el registro al hilo nunca se salta,
// que era el bug: un envío sin contacto quedaba solo en el outbox invisible).
export async function sendMessage(contactId) {
  if (!contactId) return;
  const s = store.get();
  if (s.busy.send) return;
  const c = s.contacts.find((x) => x.id === contactId);
  const text = (s.composer[contactId] || '').trim();
  if (!text) return;
  const ok = await deps.dialog.confirmDialog({
    title: 'Enviar por Teams',
    message: `Se ENVÍA de verdad este mensaje a ${c?.name || contactId} por Microsoft Teams (con tu identidad, firmado "— Nicolás (dev team)"). Consume tokens.\n\n${text.slice(0, 500)}`,
    confirmLabel: 'Enviar',
  });
  if (!ok) return;
  store.mutate((st) => { st.busy.send = true; });
  try {
    const started = await jpost('/api/comms/send', { channel: 'teams', action: 'dm', contactId, payload: { text }, actor: 'web' });
    // Teams es diferido (runner): encuestamos el job hasta que termine.
    const jobId = started.jobId;
    if (jobId) {
      await poll(`send:${jobId}`, {
        tick: async () => {
          const st = await jget(`/api/comms/send/${jobId}`).catch(() => null);
          if (!st) return false;
          if (st.status === 'done') return true;
          if (st.status === 'error') { showError(st.error || 'El envío falló.'); return true; }
          return false;
        },
        intervalMs: 2500,
        timeoutMs: 5 * 60000,
        onTimeout: () => showError('El envío no confirmó a tiempo (revisá el hilo en un rato).'),
      });
    }
    // Limpiar el composer y refrescar para traer el registro del hilo.
    store.mutate((st) => { st.composer[contactId] = ''; });
    await reload();
  } catch (e) { showError(e.message); }
  finally { store.mutate((st) => { st.busy.send = false; }); }
}

export async function logManual(contactId) {
  if (!contactId) return;
  const text = await deps.dialog.promptDialog({
    title: 'Registrar comunicación',
    message: 'Anotá qué se dijo (queda indexado en el hilo del contacto):',
    placeholder: 'Ej: le pedí a Chris que revise el PR de auth',
  });
  if (text === null || !String(text).trim()) return;
  try { await jpost('/api/comms/log', { contactId, text: String(text).trim(), direction: 'out', channel: 'web' }); await reload(); }
  catch (e) { showError(e.message); }
}

// Abre un chat asistido con el contexto del hilo inyectado (patrón doWorkOn).
export function talkAbout(thread) {
  const c = store.get().contacts.find((x) => x.id === thread.contactId);
  deps.openChat?.({
    cwd: deps.projectRel?.() || 'tolkien',
    mode: 'default',
    prompt: buildChatPrompt(thread, c),
    title: `Comms · ${c?.name || ''} · ${thread.title}`.slice(0, 60),
  });
}

// Análisis IA del hilo (resumen + clasificación) — desacoplado, bajo botón.
export async function analyze(id) {
  const cur = store.get().analysis[id];
  if (cur && cur.status === 'running') return;
  store.mutate((s) => { s.analysis[id] = { status: 'running' }; });
  try {
    const started = await jpost(`/api/comms/thread/${encodeURIComponent(id)}/analyze`);
    if (started.status === 'done' && started.analysis) {
      store.mutate((s) => { s.analysis[id] = { status: 'done', data: started.analysis }; });
      return;
    }
    const jobId = started.id;
    await poll(`analyze:${id}`, {
      tick: async () => {
        const st = await jget(`/api/comms/thread/${encodeURIComponent(id)}/analyze/${jobId}`).catch(() => null);
        if (!st) return false;
        if (st.status === 'done') { store.mutate((s) => { s.analysis[id] = { status: 'done', data: st.analysis }; }); return true; }
        if (st.status === 'error') { store.mutate((s) => { s.analysis[id] = { status: 'error', error: st.error }; }); return true; }
        return false;
      },
      intervalMs: 2000,
      timeoutMs: 90000,
      onTimeout: () => { store.mutate((s) => { s.analysis[id] = { status: 'error', error: 'El análisis no respondió a tiempo.' }; }); },
    });
  } catch (e) {
    store.mutate((s) => { s.analysis[id] = { status: 'error', error: String(e.message) }; });
  }
}

// Aplica el proyecto SUGERIDO por la IA a un hilo (crea el proyecto si es nuevo).
export async function applySuggestedProject(id, name) {
  const clean = String(name || '').trim();
  if (!clean) return;
  try {
    await jpost(`/api/comms/thread/${encodeURIComponent(id)}/project`, { project: clean });
    const exists = store.get().projects.some((p) => p.name.toLowerCase() === clean.toLowerCase());
    if (!exists) await jpost('/api/comms/project', { name: clean }).catch(() => {});
    await reload();
  } catch (e) { showError(e.message); }
}

function buildChatPrompt(t, c) {
  const lines = [];
  lines.push(`Contexto: conversación indexada con ${c?.name || t.contactId} sobre "${t.title}".`);
  if (t.project) lines.push(`Proyecto: ${t.project}`);
  if (t.url) lines.push(`Link: ${t.url}`);
  lines.push('');
  lines.push('Historial de mensajes (más viejo → más nuevo):');
  for (const m of t.messages) lines.push(`- [${m.fromContact ? (c?.name || 'contacto') : 'yo'}] ${String(m.text).slice(0, 700)}`);
  lines.push('');
  lines.push('Ayudame a preparar la próxima comunicación con esta persona sobre este tema: resumí el estado actual, qué falta o qué está trabado, y proponé una respuesta clara. NO envíes ni publiques nada por tu cuenta.');
  lines.push('');
  lines.push('IMPORTANTE — si en algún momento SÍ te pido explícitamente que envíes el mensaje (por Teams u otro canal) y lo hacés con mi aprobación, DESPUÉS de enviarlo registrá el envío para que quede en el tablero de Comunicaciones (hoy un envío hecho por fuera del tablero no deja rastro visible). Corré exactamente:');
  lines.push(`  node /home/nmosquera/claude-web-console/bin/cwc-comms.js record teams dm ${c?.id || t.contactId} -- "<el texto que enviaste>"`);
  lines.push('(reemplazá el canal/acción si no fue Teams; el <texto> es el mensaje real que mandaste). Eso NO re-envía nada: solo deja el registro en el hilo del contacto.');
  return lines.join('\n');
}
