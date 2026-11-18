// core/tls.js — certificado self-signed para servir por HTTPS (contexto seguro).
//
// El portapapeles del navegador (copiar/pegar) solo funciona en contexto
// seguro. Servimos HTTPS con un cert self-signed atado a la IP de ZeroTier.
// Se regenera automáticamente si cambia la IP o la versión del formato.
// Los nameConstraints restringen la CA a la IP de ZeroTier y localhost:
// instalarla como raíz confiable no habilita a firmar otros dominios.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { isIPv4 } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CERT_DIR = path.join(__dirname, '..', '..', 'certs');
const KEY = path.join(CERT_DIR, 'key.pem');
const CERT = path.join(CERT_DIR, 'cert.pem');
const IPMARK = path.join(CERT_DIR, '.ip');
const VERSIONMARK = path.join(CERT_DIR, '.v');
const VERSION = '2';

// Devuelve { key, cert } (Buffers), generando el certificado si hace falta.
export function ensureCert(ip) {
  fs.mkdirSync(CERT_DIR, { recursive: true });

  const have = fs.existsSync(KEY) && fs.existsSync(CERT);
  let sameIp = false;
  let sameVersion = false;
  if (have) {
    try { sameIp = fs.readFileSync(IPMARK, 'utf8').trim() === ip; } catch { sameIp = false; }
    try { sameVersion = fs.readFileSync(VERSIONMARK, 'utf8').trim() === VERSION; } catch { sameVersion = false; }
  }

  if (!have || !sameIp || !sameVersion) {
    const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    if (fs.existsSync(CERT)) fs.copyFileSync(CERT, `${CERT}.bak-${timestamp}`, fs.constants.COPYFILE_EXCL);
    if (fs.existsSync(KEY)) {
      const backup = `${KEY}.bak-${timestamp}`;
      fs.copyFileSync(KEY, backup, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(backup, 0o600);
    }

    const validIPv4 = isIPv4(ip);
    if (!validIPv4) console.warn(`[tls] IP no válida como IPv4 (${ip}); se omite la restricción de IP en nameConstraints.`);
    const nameConstraints = `nameConstraints=critical,${validIPv4 ? `permitted;IP:${ip}/255.255.255.255,` : ''}permitted;DNS:localhost`;
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', KEY, '-out', CERT, '-days', '3650',
      '-subj', '/CN=claude-web-console',
      '-addext', `subjectAltName=IP:${ip},DNS:localhost`,
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext', nameConstraints,
      '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
      '-addext', 'extendedKeyUsage=serverAuth',
    ], { stdio: 'ignore' });
    try { fs.chmodSync(KEY, 0o600); } catch { /* noop */ }
    // Best-effort: si una marca no se puede escribir NO se aborta el boot (el
    // cert ya existe); solo se regenerará de más en el próximo arranque.
    try { fs.writeFileSync(IPMARK, ip); } catch (e) { console.warn('[tls] No se pudo escribir la marca de IP:', e?.message); }
    try { fs.writeFileSync(VERSIONMARK, VERSION); } catch (e) { console.warn('[tls] No se pudo escribir la marca de versión:', e?.message); }
    console.log(`[tls] Certificado regenerado con restricción de nombres (solo ${ip} y localhost): aceptalo/instalalo de nuevo en cada dispositivo.`);
  }

  return { key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) };
}
