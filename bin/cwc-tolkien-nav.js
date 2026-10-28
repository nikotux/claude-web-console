/**
 * Primitivas compartidas de sesión y navegación de Tolkien.
 *
 * Las consumen cwc-tolkien.js y cwc-tolkien-schema.js. Este módulo nace de
 * console:BUG-2555 y console:CONVE-2085: las dos copias, aunque se declaraban
 * gemelas en un comentario, ya habían divergido.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resolveDataDir } from '../src/core/data-dir.js';

const require = createRequire(import.meta.url);

export const BASE_URL = 'https://app.tolkien.mordorstaffing.com';
export function chromiumPath() {
  return process.env.CWC_TOLKIEN_CHROMIUM_PATH?.trim() || path.join(
    os.homedir(),
    '.cache',
    'ms-playwright',
    'chromium-1228',
    'chrome-linux64',
    'chrome',
  );
}
export const NAVIGATION_TIMEOUT_MS = 30_000;
// Los DOS cascarones observados en Tolkien vivo (medidos 2026-08-01, no supuestos).
// El segundo no contiene la cadena larga: por eso «listo» no puede definirse sólo
// por la ausencia de un texto.
export const LOADING_SHELL_TEXTS = ['Loading ticket workboard', 'Loading…'];
export const LOADING_SHELL_TEXT = LOADING_SHELL_TEXTS[0];

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export class InvalidSessionError extends CliError {
  constructor() {
    super(
      'La cookie venció o es inválida: volvé a copiarla del navegador con '
        + '`node bin/cwc-tolkien.js login --cookie <valor>`.',
      2,
    );
    this.name = 'InvalidSessionError';
  }
}

export class WorkboardNotReadyError extends CliError {
  constructor(url, timeoutMs, cause) {
    super(
      `La página de Tolkien no terminó de montar en ${timeoutMs} ms al abrir ${url}: `
        + 'se aborta la lectura para no leer el cascarón vacío (console:BUG-2557).',
      1,
      { cause },
    );
    this.name = 'WorkboardNotReadyError';
    this.url = url;
    this.timeoutMs = timeoutMs;
    // CliError conserva su constructor histórico; este respaldo mantiene cause
    // disponible aunque ese constructor no reenvíe todavía las opciones a Error.
    if (cause !== undefined && this.cause === undefined) this.cause = cause;
  }
}

export function identityAliasesPath() {
  return path.join(resolveDataDir(), 'tolkien', 'identity.json');
}

function normalizedIdentityEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Carga la equivalencia de identidades Tolkien/Zoho. La inyección opcional de
 * I/O sólo existe para que los tests ejerciten archivos ausentes y corruptos
 * sin escribir fixtures fuera del repo.
 */
export function loadIdentityAliases({
  identityPath = identityAliasesPath(),
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
} = {}) {
  if (!existsSync(identityPath)) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(identityPath, 'utf8'));
  } catch (error) {
    throw new CliError(
      `El archivo de aliases de identidad ${identityPath} no contiene JSON válido: `
        + `${errorMessage(error)}.`,
    );
  }
  const aliases = parsed?.aliases;
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || !aliases
    || typeof aliases !== 'object'
    || Array.isArray(aliases)
  ) {
    throw new CliError(
      `El archivo de aliases de identidad ${identityPath} debe tener el formato `
        + '`{"aliases":{"email@canonico":["alias@email"]}}`.',
    );
  }
  const aliasMap = new Map();
  for (const [canonicalValue, aliasValues] of Object.entries(aliases)) {
    const canonical = normalizedIdentityEmail(canonicalValue);
    if (
      !canonical
      || !Array.isArray(aliasValues)
      || aliasValues.some((alias) => typeof alias !== 'string' || !normalizedIdentityEmail(alias))
    ) {
      throw new CliError(
        `El archivo de aliases de identidad ${identityPath} tiene una entrada inválida `
          + `para "${canonicalValue}"; cada clave debe ser un email no vacío y su valor `
          + 'un array de emails no vacíos.',
      );
    }
    aliasMap.set(canonical, new Set(aliasValues.map(normalizedIdentityEmail)));
  }
  return aliasMap;
}

export function aliasSetFor(email, aliasMap) {
  const initial = normalizedIdentityEmail(email);
  const result = new Set(initial ? [initial] : []);
  const pending = [...result];
  const entries = aliasMap instanceof Map ? [...aliasMap.entries()] : [];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const [canonicalValue, aliasValues] of entries) {
      const canonical = normalizedIdentityEmail(canonicalValue);
      const aliases = new Set(
        [...(aliasValues instanceof Set ? aliasValues : aliasValues ?? [])]
          .map(normalizedIdentityEmail)
          .filter(Boolean),
      );
      if (canonical !== current && !aliases.has(current)) continue;
      for (const candidate of [canonical, ...aliases]) {
        if (!candidate || result.has(candidate)) continue;
        result.add(candidate);
        pending.push(candidate);
      }
    }
  }
  return result;
}

export function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function workboardTimeoutMs() {
  const configured = Number(process.env.CWC_TOLKIEN_WORKBOARD_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 10_000;
}

export function requireSessionFile(sessionFile) {
  if (!fs.existsSync(sessionFile)) {
    throw new CliError(
      'No hay una sesión guardada. Corré exactamente: '
        + '`node bin/cwc-tolkien.js login --cookie <valor>`.',
    );
  }
}

export async function launchContext(sessionFile) {
  requireSessionFile(sessionFile);
  const executablePath = chromiumPath();
  if (!fs.existsSync(executablePath)) {
    throw new CliError(`No se encontró Chromium en ${executablePath}.`);
  }
  // La carga diferida mantiene importables los comandos de ayuda y los tests
  // aislados aun cuando este proceso no vaya a lanzar Chromium.
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({
    headless: true,
    executablePath,
  });
  try {
    const context = await browser.newContext({ storageState: sessionFile });
    context.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    return { browser, context };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

export async function waitForWorkboard(page, { timeoutMs } = {}) {
  const limite = timeoutMs ?? workboardTimeoutMs();
  try {
    // console:BUG-2557: la medición de Tolkien vivo mostró dos cascarones distintos.
    // La lista se conserva como documentación de esos cascarones y como red si la
    // definición de «montado» se afloja; hoy la condición de montaje la vuelve redundante.
    await page.waitForFunction(
      (textos) => {
        const mains = [...document.querySelectorAll('main')];
        if (mains.length === 0) return false;
        const montado = (main) => Boolean(main.querySelector('h1'))
          && Boolean(main.querySelector('section, form, dl, ul, table'));
        for (const main of mains) {
          // Un main montado NUNCA se veta por su texto: un ticket cuyo contenido diga
          // «Loading…» bloquearía una página ya lista hasta el timeout.
          if (montado(main)) continue;
          // Un main sin montar descalifica la página, tenga cartel o no: eso es lo que
          // atrapa al spinner mudo sin depender de ningún string.
          return false;
        }
        return true;
      },
      LOADING_SHELL_TEXTS,
      { timeout: limite },
    );
  } catch (error) {
    try {
      await assertAuthenticated(page);
    } catch (authError) {
      // La sesión vencida es el diagnóstico real y debe salir sin un mensaje previo
      // que culpe engañosamente al montaje del workboard.
      if (authError instanceof InvalidSessionError) throw authError;
    }
    let url = '(url desconocida)';
    try {
      url = page.url();
    } catch {
      // La página puede haberse cerrado mientras vencía la espera.
    }
    process.stderr.write(
      `[cwc-tolkien-nav] La página de Tolkien no terminó de montar en ${limite} ms al abrir ${url}: `
        + 'se aborta la lectura para no leer el cascarón vacío (console:BUG-2557).\n',
    );
    throw new WorkboardNotReadyError(url, limite, error);
  }
}

export async function assertAuthenticated(page) {
  const current = new URL(page.url());
  const authPath =
    current.pathname.startsWith('/api/auth/signin')
    || current.pathname.startsWith('/auth/');
  const homeHasLogin = current.pathname === '/'
    ? await page.evaluate(() => {
        const text = [...document.querySelectorAll('main')]
          .map((main) => main.textContent ?? '')
          .join('\n');
        return /\bSign in\b/i.test(text)
          && (/Microsoft/i.test(text) || Boolean(document.querySelector('input[type="email"]')));
      })
    : false;
  if (authPath || homeHasLogin) throw new InvalidSessionError();
}

export async function readIdentity(page) {
  return page.evaluate(() => {
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const appHeader = [...document.querySelectorAll('body > div > header, header')]
      .find((header) => header.querySelector('a[href="/"]'));
    if (!appHeader) return { email: null, roles: [] };
    const leaves = [...appHeader.querySelectorAll('*')]
      .filter((element) => element.children.length === 0);
    const emailNode = leaves.find((element) =>
      emailPattern.test((element.textContent ?? '').trim()),
    );
    const email = (emailNode?.textContent ?? '').trim() || null;
    const rolesText = emailNode?.nextElementSibling?.textContent?.trim() ?? '';
    const roles = rolesText && rolesText !== 'no roles'
      ? rolesText.split('·').map((role) => role.trim()).filter(Boolean)
      : [];
    return { email, roles };
  });
}

export async function gotoReadOnly(page, url) {
  let response;
  // La app puede re-navegar sola a la misma URL e interrumpir nuestro goto; como el destino
  // es idéntico, reintentar es seguro (medido: 18 ocurrencias en una corrida, 0 en la siguiente).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      break;
    } catch (error) {
      if (attempt > 0 || !/interrupted by another navigation/i.test(errorMessage(error))) {
        throw error;
      }
      await page.waitForTimeout(500);
    }
  }
  if (response && response.status() >= 500) {
    throw new Error(`Tolkien respondió HTTP ${response.status()} en ${url}`);
  }
  await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
  // La guarda es incondicional a propósito: ningún camino de lectura puede olvidarla
  // ni debe agregársele un opt-out (sello independiente de console:BUG-2557).
  // Se chequea la sesión antes para cortar barato un redirect al login, y también
  // después porque el estado de autenticación puede recién revelarse al montar.
  await assertAuthenticated(page);
  await waitForWorkboard(page);
  await assertAuthenticated(page);
  return response;
}

export async function waitForMain(page) {
  await page.waitForSelector('main', { state: 'attached', timeout: NAVIGATION_TIMEOUT_MS });
  await page.evaluate(async () => {
    let previousLength = -1;
    let stableReads = 0;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const length = [...document.querySelectorAll('main')]
        .reduce((total, main) => total + main.innerHTML.length, 0);
      stableReads = length > 20 && length === previousLength ? stableReads + 1 : 0;
      if (stableReads >= 2) return;
      previousLength = length;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('El DOM de main no se estabilizó después de la navegación.');
  });
}
