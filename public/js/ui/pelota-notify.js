// Preferencia de este navegador: push real o respaldo local mientras la página vive.
import { t } from './i18n.js';

const PREF = 'cwc.pelotaNotify';
const API = '/api/projects/me/push';
let pushActive = false;
let swOk = false;
let initialized = false;
let polling = false;
const observed = new Map();
const notified = new Set();
const enabledHere = () => localStorage.getItem(PREF) === 'on';
const supported = () => 'Notification' in window;

async function request(action, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${API}/${action}`, {
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(t('system.projectContext.pushRequestFailed', 'No se pudo actualizar las notificaciones.'));
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function registration() {
  if (!('serviceWorker' in navigator)) return null;
  let timer;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}

function urlBase64ToUint8Array(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), (c) => c.charCodeAt(0));
}

export async function status() {
  const permission = supported() ? Notification.permission : 'unsupported';
  if (permission !== 'granted') pushActive = false;
  else {
    try {
      const reg = await registration();
      swOk = !!reg;
      const sub = await reg?.pushManager?.getSubscription();
      pushActive = sub ? !!(await request('status', { endpoint: sub.endpoint })).subscribed : false;
    } catch { /* Conservar la última confirmación si la red falla. */ }
  }
  const enabled = enabledHere();
  return { permission, enabled, mode: !supported() ? 'unsupported'
    : permission === 'denied' ? 'denied' : !enabled ? 'off' : pushActive ? 'push' : 'local', swOk };
}

export async function enable() {
  if (!supported()) return { mode: 'unsupported' };
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    localStorage.setItem(PREF, 'off');
    return { mode: 'denied' };
  }
  localStorage.setItem(PREF, 'on');
  try {
    const reg = await registration();
    swOk = !!reg;
    if (!reg?.pushManager) throw new Error('service-worker');
    const { key } = await request('vapid-key');
    const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key),
    });
    await request('subscribe', { subscription: sub.toJSON() });
    pushActive = true;
    return { mode: 'push' };
  } catch {
    pushActive = false;
    return { mode: 'local', reason: 'push-unavailable' };
  }
}

export async function disable() {
  const reg = await registration();
  const sub = await reg?.pushManager?.getSubscription();
  if (sub) {
    await request('unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  pushActive = false;
  localStorage.setItem(PREF, 'off');
  observed.clear();
  notified.clear();
}

function localNotification(body, chatId) {
  const notification = new Notification(t('system.projectContext.pushTitle', '🎾 La pelota es tuya'), {
    body, tag: chatId ? `pelota-${chatId}` : 'pelota-test',
  });
  notification.onclick = () => {
    notification.close();
    window.focus();
    if (chatId) location.href = `/?focus=${encodeURIComponent(chatId)}`;
  };
}

export async function test() {
  const current = await status();
  if (!current.enabled || current.permission !== 'granted') return;
  if (current.mode === 'push') return request('test', {});
  localNotification(t('system.projectContext.pushTestBody', 'Las notificaciones locales funcionan.'));
}

async function poll() {
  if (polling || !enabledHere() || !supported() || Notification.permission !== 'granted'
    || !(document.hidden || !document.hasFocus())) return;
  polling = true;
  let listTimer;
  try {
    const current = await status();
    if (current.mode !== 'local') return;
    const controller = new AbortController();
    listTimer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch('/api/chat/list', { signal: controller.signal });
    if (!res.ok) return;
    const { chats } = await res.json();
    if (!enabledHere() || pushActive || !(document.hidden || !document.hasFocus())) return;
    const present = new Set();
    for (const chat of chats || []) {
      present.add(chat.id);
      const key = `${chat.id}:${chat.lastActivity}`;
      const eligible = chat.lastPelota === 'tuya' && chat.status !== 'working';
      const previous = observed.get(chat.id);
      observed.set(chat.id, { key, eligible });
      // La primera observación sólo fija la base: nunca avisar por chats antiguos.
      if (!previous || !eligible || (previous.key === key && previous.eligible) || notified.has(key)) continue;
      localNotification(chat.title, chat.id);
      notified.add(key);
      if (notified.size > 500) notified.delete(notified.values().next().value);
    }
    for (const id of observed.keys()) if (!present.has(id)) observed.delete(id);
  } catch { /* Red o permisos transitorios: reintentar en la próxima observación. */ }
  finally { clearTimeout(listTimer); polling = false; }
}

export function initPelotaNotify() {
  if (initialized || new URLSearchParams(location.search).has('solo')) return;
  initialized = true;
  setInterval(poll, 15000);
  void poll();
}
