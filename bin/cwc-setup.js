#!/usr/bin/env node
// bin/cwc-setup.js — INSTALADOR guiado de una instancia independiente de la
// consola (PLAN-476/PEND-381, C2). Pensado para que un compañero levante SU
// propia consola sin heredar la identidad de nadie:
//   1. Preflight: verifica requisitos (Node/tmux/git/openssl/ZeroTier/Claude).
//   2. Genera .env (token maestro, puerto, home) si no existe.
//   3. Fija la IDENTIDAD de ESTA instancia (nombre/email/GitHub) en la capa de
//      config de instancia (~/.cwc-data/instance.json) — NO la de Nico.
//   4. Instala/arranca el servicio systemd de usuario (WorkingDirectory real).
//   5. Ofrece los hooks opcionales (observador / interfono / pelota).
//   6. Crea el primer usuario admin.
//
// NO importa core/config.js a propósito: config.js hace exit si falta
// CWC_TOKEN, y una instalación fresca todavía no tiene .env.
//
// Modos:
//   node bin/cwc-setup.js           -> wizard interactivo completo
//   node bin/cwc-setup.js --check   -> SOLO el preflight (sin prompts), para CI/verificación
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findZeroTierIp } from '../src/core/zerotier.js';
import { saveInstance } from '../src/core/instance-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');           // raíz del repo
const ENV_FILE = path.join(ROOT, '.env');
const UNIT_SRC = path.join(ROOT, 'systemd', 'claude-web-console.service');
const UNIT_DST = path.join(os.homedir(), '.config', 'systemd', 'user', 'claude-web-console.service');

const CHECK_ONLY = process.argv.includes('--check');
const C = { ok: '\x1b[32m', warn: '\x1b[33m', crit: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m', bold: '\x1b[1m' };
const mark = { ok: `${C.ok}✓${C.reset}`, warn: `${C.warn}⚠${C.reset}`, crit: `${C.crit}✗${C.reset}` };

// ---- Preflight ----------------------------------------------------------
function tryCmd(cmd, args) {
  try { return String(execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] })).trim(); }
  catch { return null; }
}

function preflight() {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  // Node: crítico si < 20 (probado con v24).
  const major = parseInt(process.versions.node.split('.')[0], 10);
  add('Node.js', major >= 20 ? 'ok' : 'crit', `v${process.versions.node}${major >= 20 ? '' : ' (se requiere >= 20)'}`);

  // git y openssl: críticos (panel del proyecto + generación del cert TLS).
  const git = tryCmd('git', ['--version']);
  add('git', git ? 'ok' : 'crit', git || 'no encontrado');
  const ssl = tryCmd('openssl', ['version']);
  add('openssl', ssl ? 'ok' : 'crit', ssl || 'no encontrado (necesario para el cert TLS)');

  // tmux: warn (sin él no hay terminales, pero el server arranca).
  const tmux = tryCmd('tmux', ['-V']);
  add('tmux', tmux ? 'ok' : 'warn', tmux || 'no encontrado (las terminales no funcionarán)');

  // Claude Code CLI: prerrequisito real del chat/SDK. Warn fuerte.
  const claude = tryCmd('claude', ['--version']);
  add('Claude Code', claude ? 'ok' : 'warn', claude || 'no encontrado — instalalo antes de usar el chat');

  // ZeroTier: warn (el server espera la interfaz, no crashea).
  const zt = findZeroTierIp();
  add('ZeroTier', zt ? 'ok' : 'warn', zt ? `${zt.iface} -> ${zt.ip}` : 'sin interfaz zt* con IP (el server esperará)');

  // Dependencias npm.
  const hasModules = fs.existsSync(path.join(ROOT, 'node_modules'));
  add('node_modules', hasModules ? 'ok' : 'warn', hasModules ? 'instaladas' : 'faltan (corré: npm install)');

  return checks;
}

function printPreflight(checks) {
  console.log(`\n${C.bold}Requisitos:${C.reset}`);
  for (const c of checks) console.log(`  ${mark[c.status]} ${c.name.padEnd(14)} ${C.dim}${c.detail}${C.reset}`);
  const crit = checks.filter((c) => c.status === 'crit');
  const warn = checks.filter((c) => c.status === 'warn');
  if (crit.length) console.log(`\n${C.crit}Hay ${crit.length} requisito(s) crítico(s) sin cumplir — resolvelos antes de seguir.${C.reset}`);
  else if (warn.length) console.log(`\n${C.warn}Todo lo crítico está OK; hay ${warn.length} aviso(s) no bloqueante(s).${C.reset}`);
  else console.log(`\n${C.ok}Todos los requisitos OK.${C.reset}`);
  return crit.length === 0;
}

// ---- Wizard interactivo -------------------------------------------------
async function runWizard() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def = '') => {
    const a = (await rl.question(`${q}${def ? ` [${def}]` : ''}: `)).trim();
    return a || def;
  };
  const yes = async (q, def = true) => {
    const a = (await rl.question(`${q} ${def ? '(S/n)' : '(s/N)'}: `)).trim().toLowerCase();
    if (!a) return def;
    return a === 's' || a === 'si' || a === 'sí' || a === 'y';
  };

  console.log(`\n${C.bold}=== Instalación de Mi Consola (instancia independiente) ===${C.reset}`);

  // 1) .env
  if (fs.existsSync(ENV_FILE)) {
    console.log(`\n${mark.ok} Ya existe ${ENV_FILE} — lo dejo como está.`);
  } else if (await yes('\n¿Generar el archivo .env ahora?')) {
    const token = crypto.randomBytes(32).toString('hex');
    const port = await ask('Puerto HTTPS', '8092');
    const home = await ask('Directorio raíz permitido (CWC_HOME)', os.homedir());
    const projDir = await ask('Proyecto principal trackeado (CWC_PROJECT_DIR, vacío = ninguno)', '');
    const projName = projDir ? await ask('Nombre visible de ese proyecto (CWC_PROJECT_NAME)', path.basename(projDir)) : '';
    const lines = [
      '# Generado por bin/cwc-setup.js — NUNCA commitees este archivo.',
      `CWC_TOKEN=${token}`,
      `CWC_PORT=${port}`,
      'CWC_ZT_IFACE=',
      `CWC_HOME=${home}`,
      'CWC_TMUX_SOCKET=cwc',
      'CWC_SCROLLBACK=5000',
      'CWC_SESSION_DAYS=30',
      ...(projDir ? [`CWC_PROJECT_DIR=${projDir}`, `CWC_PROJECT_NAME=${projName}`] : []),
      '',
    ];
    fs.writeFileSync(ENV_FILE, lines.join('\n'), { mode: 0o600 });
    fs.chmodSync(ENV_FILE, 0o600);
    console.log(`${mark.ok} .env creado (token maestro generado, permisos 600).`);
  }

  // 2) Identidad de ESTA instancia (capa de config de instancia)
  if (await yes('\n¿Configurar la identidad de ESTA instancia ahora? (podés cambiarla luego en ⚙ Sistema → Variables de entorno)')) {
    const name = await ask('Tu nombre');
    const email = await ask('Tu email');
    const github = await ask('Tu usuario de GitHub');
    const signature = await ask('Firma para notas externas (ej. Desk)', name ? `— ${name.split(' ')[0]}` : '');
    const patch = { identity: {} };
    if (name) patch.identity.name = name;
    if (email) patch.identity.email = email;
    if (github) patch.identity.github = github;
    if (signature) patch.identity.signature = signature;
    if (Object.keys(patch.identity).length) {
      saveInstance(patch);
      console.log(`${mark.ok} Identidad guardada en ~/.cwc-data/instance.json.`);
    }
  }

  // 3) Primer usuario admin (ANTES de arrancar el servicio, así lo toma al iniciar)
  if (await yes('\n¿Crear el primer usuario administrador ahora?')) {
    console.log(`${C.dim}(se te pedirá la contraseña de forma oculta)${C.reset}`);
    const user = await ask('Nombre de usuario admin');
    if (user) {
      rl.pause();
      const r = spawnSync(process.execPath, [path.join(__dirname, 'cwc-adduser.js'), user, '--admin'], { stdio: 'inherit' });
      rl.resume();
      if (r.status !== 0) console.log(`${mark.warn} No se creó el usuario (podés reintentar: node bin/cwc-adduser.js ${user} --admin).`);
    }
  }

  // 4) systemd
  if (await yes('\n¿Instalar y arrancar el servicio systemd de usuario?')) {
    try {
      // WorkingDirectory/Documentation del template asumen ~/claude-web-console;
      // los reescribimos a la ruta REAL del repo para que sea portable.
      const unit = fs.readFileSync(UNIT_SRC, 'utf8').replace(/%h\/claude-web-console/g, ROOT);
      fs.mkdirSync(path.dirname(UNIT_DST), { recursive: true });
      fs.writeFileSync(UNIT_DST, unit);
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
      execFileSync('systemctl', ['--user', 'enable', '--now', 'claude-web-console'], { stdio: 'inherit' });
      try { execFileSync('loginctl', ['enable-linger', os.userInfo().username], { stdio: 'inherit' }); }
      catch { console.log(`${mark.warn} No se pudo activar linger (el servicio no arrancará solo tras un reboot sin login). Corré: loginctl enable-linger $USER`); }
      console.log(`${mark.ok} Servicio instalado y arrancado (WorkingDirectory=${ROOT}).`);
    } catch (e) {
      console.log(`${mark.warn} No se pudo instalar el servicio: ${String(e.message || e).slice(0, 200)}`);
    }
  }

  // 5) Hooks opcionales de Claude Code (aditivos y reversibles)
  if (await yes('\n¿Instalar los hooks opcionales de Claude Code (observador de estado, interfono entre sesiones, "la pelota")?')) {
    for (const script of ['install-observer.js', 'install-interfono.js', 'install-pelota.js']) {
      const p = path.join(__dirname, script);
      if (!fs.existsSync(p)) { console.log(`${mark.warn} ${script} no existe, salteado.`); continue; }
      const r = spawnSync(process.execPath, [p], { stdio: 'inherit' });
      console.log(r.status === 0 ? `${mark.ok} ${script}` : `${mark.warn} ${script} devolvió error (no bloqueante)`);
    }
  }

  rl.close();

  // Cierre con la URL de acceso
  const zt = findZeroTierIp();
  console.log(`\n${C.bold}${C.ok}Listo.${C.reset}`);
  if (zt) console.log(`Entrá desde un dispositivo de tu red ZeroTier a:  ${C.bold}https://${zt.ip}:${(process.env.CWC_PORT || '8092')}${C.reset}`);
  else console.log('Cuando ZeroTier levante su interfaz, el server escuchará en https://<ip-zerotier>:<puerto>.');
  console.log(`${C.dim}(la primera vez, aceptá el aviso de certificado self-signed)${C.reset}`);
}

// ---- Main ---------------------------------------------------------------
(async () => {
  const checks = preflight();
  const okCrit = printPreflight(checks);
  if (CHECK_ONLY) process.exit(okCrit ? 0 : 1);
  if (!okCrit) {
    console.log('\nResolvé los requisitos críticos y volvé a correr: node bin/cwc-setup.js');
    process.exit(1);
  }
  await runWizard();
  process.exit(0);
})();
