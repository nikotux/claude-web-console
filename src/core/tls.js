// core/tls.js — HTTPS con CA local y hoja del servidor separadas.
//
// Apple limita a 825 días la vigencia de los certificados de servidor: la
// hoja dura 397 días y se renueva al arrancar, conservando la CA instalada.
// La CA dura 10 años; sus nameConstraints limitan la confianza a ZeroTier y
// localhost, sin habilitar la firma de certificados para otros dominios.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { isIPv4 } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CERT_DIR = path.join(__dirname, '..', '..', 'certs');
const VERSION = '3';
const RENEW_BEFORE_MS = 30 * 86400000;

export function caCertPath(dir = CERT_DIR) {
  return path.join(dir, 'ca.pem');
}

// Devuelve la clave y la cadena completa (hoja + CA). dir sólo se cambia en tests.
export function ensureCert(ip, { dir = CERT_DIR } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  const caPath = caCertPath(dir);
  const caKeyPath = path.join(dir, 'ca-key.pem');
  const ipmark = path.join(dir, '.ip');
  const versionmark = path.join(dir, '.v');
  const matches = (file, value) => {
    try { return fs.readFileSync(file, 'utf8').trim() === value; } catch { return false; }
  };
  const renewCa = !fs.existsSync(caPath) || !fs.existsSync(caKeyPath)
    || !matches(ipmark, ip) || !matches(versionmark, VERSION);
  let renewLeaf = renewCa || !fs.existsSync(keyPath) || !fs.existsSync(certPath);
  if (!renewLeaf) {
    try {
      const leaf = new crypto.X509Certificate(fs.readFileSync(certPath));
      const ca = new crypto.X509Certificate(fs.readFileSync(caPath));
      const expires = Date.parse(leaf.validTo);
      renewLeaf = !Number.isFinite(expires) || expires - Date.now() < RENEW_BEFORE_MS
        || !leaf.checkIssued(ca) || !leaf.verify(ca.publicKey);
    } catch { renewLeaf = true; }
  }

  if (renewLeaf) {
    const files = (renewCa ? [caPath, caKeyPath, certPath, keyPath] : [certPath, keyPath])
      .filter((file) => fs.existsSync(file));
    // Si hay dos renovaciones en el mismo segundo, no pisar ningún backup.
    let backupTime = Date.now();
    let timestamp;
    do {
      timestamp = new Date(backupTime).toISOString().replace(/\D/g, '').slice(0, 14);
      backupTime += 1000;
    } while (files.some((file) => fs.existsSync(`${file}.bak-${timestamp}`)));
    for (const file of files) {
      const backup = `${file}.bak-${timestamp}`;
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      if (file === keyPath || file === caKeyPath) fs.chmodSync(backup, 0o600);
    }

    const openssl = (args) => execFileSync('openssl', args, { stdio: 'ignore' });
    const tmp = fs.mkdtempSync(path.join(dir, '.tls-'));
    try {
      if (renewCa) {
        const validIPv4 = isIPv4(ip);
        if (!validIPv4) console.warn(`[tls] IP no válida como IPv4 (${ip}); se omite la restricción de IP en nameConstraints.`);
        const names = `${validIPv4 ? `permitted;IP:${ip}/255.255.255.255,` : ''}permitted;DNS:localhost`;
        openssl([
          'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
          '-keyout', caKeyPath, '-out', caPath, '-days', '3650',
          '-subj', '/CN=Claude Web Console CA',
          '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
          '-addext', `nameConstraints=critical,${names}`,
          '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
          '-addext', 'subjectKeyIdentifier=hash',
        ]);
        fs.chmodSync(caKeyPath, 0o600);
      }
      const csr = path.join(tmp, 'server.csr');
      const ext = path.join(tmp, 'server.ext');
      fs.writeFileSync(ext, [
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
        `subjectAltName=IP:${ip},DNS:localhost`,
        'subjectKeyIdentifier=hash',
        'authorityKeyIdentifier=keyid',
        '',
      ].join('\n'));
      openssl([
        'req', '-new', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', csr, '-subj', '/CN=Claude Web Console',
      ]);
      fs.chmodSync(keyPath, 0o600);
      openssl([
        'x509', '-req', '-in', csr, '-CA', caPath, '-CAkey', caKeyPath,
        '-set_serial', `0x${crypto.randomBytes(16).toString('hex')}`,
        '-out', certPath, '-days', '397', '-extfile', ext,
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    // Best-effort: una marca fallida sólo causa otra migración al arrancar.
    if (renewCa) {
      try { fs.writeFileSync(ipmark, ip); } catch (e) { console.warn('[tls] No se pudo escribir la marca de IP:', e?.message); }
      try { fs.writeFileSync(versionmark, VERSION); } catch (e) { console.warn('[tls] No se pudo escribir la marca de versión:', e?.message); }
      console.log(`[tls] CA local nueva (solo ${ip} y localhost): instalá certs/ca.pem como confiable en cada dispositivo (descarga: /consola-ca.crt).`);
    } else {
      const leaf = new crypto.X509Certificate(fs.readFileSync(certPath));
      console.log(`[tls] Certificado del servidor renovado (vence ${leaf.validTo}); la CA instalada sigue sirviendo.`);
    }
  }

  return {
    key: fs.readFileSync(keyPath),
    cert: Buffer.concat([fs.readFileSync(certPath), Buffer.from('\n'), fs.readFileSync(caPath)]),
  };
}
