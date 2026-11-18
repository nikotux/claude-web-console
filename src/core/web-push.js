// Push puntual del server: VAPID global del host y suscripciones privadas por dueño.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as webpush from 'web-push';
import { config } from './config.js';
import { userDataDir } from './user-space.js';
import { writeJsonAtomic } from './atomic-write.js';

let vapid;
function vapidDetails() {
  if (vapid) return vapid;
  const file = path.join(os.homedir(), '.cwc-data', 'vapid.json');
  let keys;
  try { keys = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT') throw err; // Nunca rotar silenciosamente una clave existente.
    keys = webpush.generateVAPIDKeys();
    writeJsonAtomic(file, keys, { mode: 0o600 });
  }
  fs.chmodSync(file, 0o600);
  const email = config.instance?.identity?.email;
  const subject = typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    ? `mailto:${email.trim()}` : 'mailto:admin@localhost';
  vapid = { ...keys, subject };
  return vapid;
}

export function vapidPublicKey() { return vapidDetails().publicKey; }

const fileFor = (userId) => path.join(userDataDir(userId), 'push-subscriptions.json');
function readSubscriptions(userId) {
  try {
    const data = JSON.parse(fs.readFileSync(fileFor(userId), 'utf8'));
    if (!Array.isArray(data)) throw new Error('Formato de suscripciones inválido');
    return data;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function validSubscription(sub) {
  try {
    const url = new URL(sub?.endpoint);
    return url.protocol === 'https:' && !url.username && !url.password
      && typeof sub.endpoint === 'string' && sub.endpoint.length <= 4096
      && ['p256dh', 'auth'].every((k) => typeof sub.keys?.[k] === 'string'
        && sub.keys[k].length > 0 && sub.keys[k].length <= 512);
  } catch { return false; }
}

export function addSubscription(userId, sub, ua = '') {
  if (!validSubscription(sub)) {
    const err = new Error('Suscripción push inválida.');
    err.badRequest = true;
    throw err;
  }
  const entries = readSubscriptions(userId);
  const previous = entries.find((s) => s.endpoint === sub.endpoint);
  const next = entries.filter((s) => s.endpoint !== sub.endpoint);
  next.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    ua: String(ua).slice(0, 500), createdAt: previous?.createdAt || Date.now() });
  next.sort((a, b) => a.createdAt - b.createdAt);
  writeJsonAtomic(fileFor(userId), next.slice(-10));
}

export function removeSubscription(userId, endpoint) {
  const entries = readSubscriptions(userId);
  const next = entries.filter((s) => s.endpoint !== endpoint);
  if (next.length !== entries.length) writeJsonAtomic(fileFor(userId), next);
}

export function hasSubscription(userId, endpoint) {
  return typeof endpoint === 'string' && readSubscriptions(userId).some((s) => s.endpoint === endpoint);
}

// Nunca rechaza: el turno no depende del servicio push ni de su disponibilidad.
export async function sendPushToUser(userId, payload) {
  try {
    const entries = readSubscriptions(userId);
    if (!entries.length) return 0; // Sin suscripciones, tampoco generar VAPID.
    const vapidDetailsForSend = vapidDetails();
    const body = JSON.stringify(payload);
    await Promise.all(entries.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body, {
          vapidDetails: vapidDetailsForSend, TTL: 3600, urgency: 'high', timeout: 10000,
        });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) removeSubscription(userId, sub.endpoint);
        else console.warn('[web-push] envío fallido', { status: Number(err.statusCode) || 0 });
      }
    }));
    return entries.length;
  } catch {
    console.warn('[web-push] no se pudo preparar el envío');
    return 0;
  }
}
