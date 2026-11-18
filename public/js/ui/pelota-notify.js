// Preferencia de este navegador: push real o respaldo local mientras la página vive.
import { t } from './i18n.js';

const PREF = 'cwc.pelotaNotify';
const API = '/api/projects/me/push';
let pushActive = false;
let swOk = false;
let initialized = false;
let polling = false;
let cachedRegistration = null;
let cachedVapidKey = null;
let prefetching = null;
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
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return (cachedRegistration = existing);
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    if (reg) return (cachedRegistration = reg);
  } catch { /* Si el registro falla, esperar al worker disponible con timeout. */ }
  let timer;
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 5000); }),
    ]);
    if (reg) cachedRegistration = reg;
    return reg;
  } finally { clearTimeout(timer); }
}

// Preparar todo antes del clic: Safari necesita subscribe dentro del gesto.
function prefetchPush() {
  if (prefetching) return prefetching;
  prefetching = Promise.allSettled([
    registration().then((reg) => { swOk = !!reg; }),
    cachedVapidKey ? Promise.resolve() : request('vapid-key').then(({ key }) => {
      cachedVapidKey = urlBase64ToUint8Array(key);
    }),
  ]).finally(() => { prefetching = null; });
  return prefetching;
}

function urlBase64ToUint8Array(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), (c) => c.charCodeAt(0));
}

export async function status() {
  await prefetchPush();
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
  let sub;
  if (cachedRegistration?.pushManager && cachedVapidKey) {
    try {
      // Primera operación asíncrona: el permiso lo pide subscribe implícitamente.
      sub = await cachedRegistration.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: cachedVapidKey,
      });
    } catch { /* Sin caché utilizable o permiso: seguir con el respaldo habitual. */ }
  }
  if (!sub) {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      localStorage.setItem(PREF, 'off');
      return { mode: 'denied' };
    }
  }
  localStorage.setItem(PREF, 'on');
  try {
    if (!sub) {
      const reg = await registration();
      swOk = !!reg;
      if (!reg?.pushManager) throw new Error('service-worker');
      if (!cachedVapidKey) {
        const { key } = await request('vapid-key');
        cachedVapidKey = urlBase64ToUint8Array(key);
      }
      sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: cachedVapidKey,
      });
    }
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
    body, tag: chatId ? `pelota-${chatId}` : 'pelota-test', icon: '/img/app-192.png',
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
  if (initialized) return;
  initialized = true;
  void prefetchPush();
  if (new URLSearchParams(location.search).has('solo')) return;
  setInterval(poll, 15000);
  void poll();
}
