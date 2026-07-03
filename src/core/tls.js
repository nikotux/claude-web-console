// core/tls.js — certificado self-signed para servir por HTTPS (contexto seguro).
//
// El portapapeles del navegador (copiar/pegar) solo funciona en contexto
// seguro. Servimos HTTPS con un cert self-signed atado a la IP de ZeroTier.
// Se genera una sola vez; si la IP cambia, se regenera automáticamente.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CERT_DIR = path.join(__dirname, '..', '..', 'certs');
const KEY = path.join(CERT_DIR, 'key.pem');
const CERT = path.join(CERT_DIR, 'cert.pem');
const IPMARK = path.join(CERT_DIR, '.ip');

// Devuelve { key, cert } (Buffers), generando el certificado si hace falta.
export function ensureCert(ip) {
  fs.mkdirSync(CERT_DIR, { recursive: true });

  const have = fs.existsSync(KEY) && fs.existsSync(CERT);
  let sameIp = false;
  if (have) {
    try { sameIp = fs.readFileSync(IPMARK, 'utf8').trim() === ip; } catch { sameIp = false; }
  }

  if (!have || !sameIp) {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', KEY, '-out', CERT, '-days', '3650',
      '-subj', '/CN=claude-web-console',
      '-addext', `subjectAltName=IP:${ip},DNS:localhost`,
    ], { stdio: 'ignore' });
    try { fs.chmodSync(KEY, 0o600); } catch { /* noop */ }
    // Best-effort: si la marca no se puede escribir NO se aborta el boot (el
    // cert ya existe); solo se regenerará de más en el próximo arranque.
    try { fs.writeFileSync(IPMARK, ip); } catch (e) { console.warn('[tls] No se pudo escribir la marca de IP:', e?.message); }
    console.log(`[tls] Certificado self-signed generado para ${ip} (aceptalo una vez en cada dispositivo).`);
  }

  return { key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) };
}
