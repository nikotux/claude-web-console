#!/usr/bin/env node
// Test funcional, determinista y aislado de la navegación de Tolkien.
// No usa red, Chromium ni el SDK, y no toca ~/.cwc-data.

import { inspect } from 'node:util';
import {
  InvalidSessionError,
  LOADING_SHELL_TEXT,
  LOADING_SHELL_TEXTS,
  WorkboardNotReadyError,
  gotoReadOnly,
  waitForMain,
  waitForWorkboard,
} from './cwc-tolkien-nav.js';

let pass = 0;
let fail = 0;

function ok(name, condition, detail = null) {
  if (condition) {
    pass += 1;
    console.log(`✅ ${name}`);
  } else {
    fail += 1;
    const suffix = detail === null ? '' : `\n   detalle: ${inspect(detail, { depth: null })}`;
    console.log(`❌ ${name}${suffix}`);
  }
}

function normalAuthPage(overrides = {}) {
  return {
    url: () => 'https://app.tolkien.mordorstaffing.com/',
    evaluate: async () => false,
    ...overrides,
  };
}

function mainCascaron(texto) {
  return { textContent: texto, querySelector: () => null };
}

function mainMontado(texto) {
  return {
    textContent: texto,
    querySelector: (selector) => (selector === 'h1'
      ? {}
      : (selector.includes('section') ? {} : null)),
  };
}

async function capturePredicate(timeoutMs) {
  let args = null;
  const page = normalAuthPage({
    waitForFunction: async (...received) => { args = received; },
  });
  await waitForWorkboard(page, timeoutMs === undefined ? {} : { timeoutMs });
  return args;
}

async function main() {
  const previousTimeout = process.env.CWC_TOLKIEN_WORKBOARD_TIMEOUT_MS;
  delete process.env.CWC_TOLKIEN_WORKBOARD_TIMEOUT_MS;
  try {
    console.log('\nT1 — posición de los argumentos');
    const t1Args = await capturePredicate();
    ok(
      'T1 — waitForFunction recibe función, textos y opciones en tres posiciones',
      t1Args.length === 3
        && t1Args[1] === LOADING_SHELL_TEXTS
        && t1Args[1][0] === LOADING_SHELL_TEXT
        && !(typeof t1Args[1] === 'object' && t1Args[1]?.timeout)
        && t1Args[2]?.timeout === 10_000
        && Object.keys(t1Args[2]).length === 1,
      t1Args,
    );

    console.log('\nT2 — el timeout es configurable');
    process.env.CWC_TOLKIEN_WORKBOARD_TIMEOUT_MS = '250';
    const t2Args = await capturePredicate();
    ok(
      'T2 — CWC_TOLKIEN_WORKBOARD_TIMEOUT_MS cambia el tercer argumento',
      t2Args[2]?.timeout === 250,
      t2Args,
    );
    delete process.env.CWC_TOLKIEN_WORKBOARD_TIMEOUT_MS;

    console.log('\nT3 — el predicado con DOM simulado');
    const [predicate, shellTexts] = await capturePredicate();
    const previousDocument = globalThis.document;
    const hadDocument = Object.hasOwn(globalThis, 'document');
    try {
      let mains = [];
      globalThis.document = {
        querySelectorAll: (selector) => (selector === 'main' ? mains : []),
      };
      const results = [];
      mains = [];
      results.push(predicate(shellTexts));
      mains = [mainCascaron(LOADING_SHELL_TEXT)];
      results.push(predicate(shellTexts));
      mains = [mainMontado('Contenido real'), mainCascaron(LOADING_SHELL_TEXT)];
      results.push(predicate(shellTexts));
      mains = [mainMontado('Contenido real')];
      results.push(predicate(shellTexts));
      ok(
        'T3 — bloquea sin main o con cascarón y habilita el contenido real',
        results.join(',') === 'false,false,false,true',
        results,
      );
    } finally {
      if (hadDocument) globalThis.document = previousDocument;
      else delete globalThis.document;
    }

    console.log('\nT4 — dos <main> legítimos no bloquean');
    const previousDocumentT4 = globalThis.document;
    const hadDocumentT4 = Object.hasOwn(globalThis, 'document');
    try {
      globalThis.document = {
        querySelectorAll: () => [
          mainMontado('Contenido principal'),
          mainMontado('Panel auxiliar estable'),
        ],
      };
      ok(
        'T4 — dos mains sin cascarón satisfacen la guarda',
        predicate(shellTexts) === true,
      );
    } finally {
      if (hadDocumentT4) globalThis.document = previousDocumentT4;
      else delete globalThis.document;
    }

    console.log('\nT5 — caso negativo obligatorio (console:CONVE-2458)');
    const t5Url = 'https://app.tolkien.mordorstaffing.com/tickets/negativo';
    const t5Page = normalAuthPage({
      url: () => t5Url,
      waitForFunction: async () => { throw new Error('timeout simulado'); },
    });
    let t5Error = null;
    try {
      await waitForWorkboard(t5Page);
    } catch (error) {
      t5Error = error;
    }
    ok(
      'T5 — el timeout lanza WorkboardNotReadyError con URL y límite',
      t5Error instanceof WorkboardNotReadyError
        && t5Error.message.includes(t5Url)
        && t5Error.message.includes('10000 ms'),
      t5Error,
    );

    console.log('\nT6 — la falla corta la navegación');
    let t6EvaluateCalls = 0;
    let t6Returned = false;
    const t6Page = normalAuthPage({
      goto: async () => ({ status: () => 200 }),
      waitForLoadState: async () => {},
      waitForFunction: async () => { throw new Error('timeout simulado'); },
      evaluate: async () => {
        t6EvaluateCalls += 1;
        return false;
      },
    });
    let t6Error = null;
    try {
      await gotoReadOnly(t6Page, 'https://app.tolkien.mordorstaffing.com/tickets/x');
      t6Returned = true;
    } catch (error) {
      t6Error = error;
    }
    ok(
      'T6 — gotoReadOnly no retorna ni llega al chequeo autenticado posterior',
      t6Error instanceof WorkboardNotReadyError && !t6Returned && t6EvaluateCalls === 2,
      { t6Error, t6Returned, t6EvaluateCalls },
    );

    console.log('\nT7 — cookie vencida gana sobre fallo de carga');
    const t7Page = normalAuthPage({
      url: () => 'https://app.tolkien.mordorstaffing.com/api/auth/signin',
      waitForFunction: async () => { throw new Error('timeout simulado'); },
    });
    let t7Error = null;
    try {
      await waitForWorkboard(t7Page);
    } catch (error) {
      t7Error = error;
    }
    ok(
      'T7 — la URL de login propaga InvalidSessionError',
      t7Error instanceof InvalidSessionError && !(t7Error instanceof WorkboardNotReadyError),
      t7Error,
    );

    console.log('\nT8 — waitForMain mide todos los mains');
    const previousDocumentT8 = globalThis.document;
    const hadDocumentT8 = Object.hasOwn(globalThis, 'document');
    let evaluated = null;
    try {
      globalThis.document = {
        querySelectorAll: (selector) => (selector === 'main'
          ? [{ innerHTML: '' }, { innerHTML: '<section>contenido estable del segundo main</section>' }]
          : []),
      };
      const t8Page = {
        waitForSelector: async () => {},
        evaluate: async (fn) => {
          evaluated = fn;
          return fn();
        },
      };
      await waitForMain(t8Page);
      ok(
        'T8 — el segundo main aporta longitud y permite estabilizar el DOM',
        typeof evaluated === 'function',
      );
    } catch (error) {
      ok('T8 — el segundo main aporta longitud y permite estabilizar el DOM', false, error);
    } finally {
      if (hadDocumentT8) globalThis.document = previousDocumentT8;
      else delete globalThis.document;
    }

    console.log('\nT9 — recolección de formularios en todos los <main>');
    // Prueba del criterio usado por extractForms, no de la función (no está exportada).
    const recolectarFormularios = (documento) => {
      const mains = [...documento.querySelectorAll('main')];
      return [...new Set(mains.flatMap((main) => [...main.querySelectorAll('form')]))];
    };
    const formA = { id: 'a' };
    const formB = { id: 'b' };
    const conCascaron = recolectarFormularios({
      querySelectorAll: () => [
        { querySelectorAll: () => [] },
        { querySelectorAll: () => [formA, formB] },
      ],
    });
    const formCompartido = { id: 'compartido' };
    const conMainsAnidados = recolectarFormularios({
      querySelectorAll: () => [
        { querySelectorAll: () => [formCompartido] },
        { querySelectorAll: () => [formCompartido] },
      ],
    });
    ok(
      'T9 — omite el cascarón vacío y no duplica forms de mains anidados',
      conCascaron.length === 2
        && conCascaron[0] === formA
        && conCascaron[1] === formB
        && conMainsAnidados.length === 1
        && conMainsAnidados[0] === formCompartido,
      { conCascaron, conMainsAnidados },
    );

    console.log('\nT10 — el segundo cascarón medido no tiene contenido montado');
    const previousDocumentT10 = globalThis.document;
    const hadDocumentT10 = Object.hasOwn(globalThis, 'document');
    try {
      // Tras el arreglo A, el cascarón B medido se bloquea porque no tiene contenido
      // montado; su texto «Loading…» ya no es una condición independiente.
      globalThis.document = {
        querySelectorAll: () => [mainCascaron('Loading…')],
      };
      ok(
        'T10 — el cascarón corto queda bloqueado por falta de contenido montado, no por su texto',
        predicate(shellTexts) === false,
      );
    } finally {
      if (hadDocumentT10) globalThis.document = previousDocumentT10;
      else delete globalThis.document;
    }

    console.log('\nT11 — un spinner sin texto tampoco pasa');
    const previousDocumentT11 = globalThis.document;
    const hadDocumentT11 = Object.hasOwn(globalThis, 'document');
    try {
      globalThis.document = {
        querySelectorAll: () => [mainCascaron('')],
      };
      ok(
        'T11 — la guarda no depende de adivinar strings ni idiomas',
        predicate(shellTexts) === false,
      );
    } finally {
      if (hadDocumentT11) globalThis.document = previousDocumentT11;
      else delete globalThis.document;
    }

    console.log('\nT12 — un main montado no oculta otro cascarón');
    const previousDocumentT12 = globalThis.document;
    const hadDocumentT12 = Object.hasOwn(globalThis, 'document');
    try {
      globalThis.document = {
        querySelectorAll: () => [
          mainMontado('Contenido real'),
          mainCascaron(''),
        ],
      };
      ok(
        'T12 — la convivencia de un main montado y un cascarón queda bloqueada',
        predicate(shellTexts) === false,
      );
    } finally {
      if (hadDocumentT12) globalThis.document = previousDocumentT12;
      else delete globalThis.document;
    }

    console.log('\nT13 — gotoReadOnly no admite opt-out');
    let t13WaitCalls = 0;
    const t13Page = normalAuthPage({
      goto: async () => ({ status: () => 200 }),
      waitForLoadState: async () => {},
      waitForFunction: async () => {
        t13WaitCalls += 1;
        throw new Error('timeout simulado');
      },
    });
    let t13Error = null;
    try {
      await gotoReadOnly(
        t13Page,
        'https://app.tolkien.mordorstaffing.com/tickets/sin-opt-out',
        { workboard: false },
      );
    } catch (error) {
      t13Error = error;
    }
    ok(
      'T13 — la aridad es 2 y un tercer argumento no evita la espera',
      gotoReadOnly.length === 2
        && t13WaitCalls === 1
        && t13Error instanceof WorkboardNotReadyError,
      { aridad: gotoReadOnly.length, t13WaitCalls, t13Error },
    );

    console.log('\nT14 — un texto legítimo de carga no veta contenido montado');
    const previousDocumentT14 = globalThis.document;
    const hadDocumentT14 = Object.hasOwn(globalThis, 'document');
    try {
      // Hallazgo del tercer sello: un ticket montado puede mencionar «Loading…»
      // legítimamente y no debe quedar bloqueado hasta el timeout por ese substring.
      globalThis.document = {
        querySelectorAll: () => [
          mainMontado('WORK-999 Loading dock repair — Loading… mencionado en el chat'),
        ],
      };
      ok(
        'T14 — un main montado con «Loading…» pasa la guarda',
        predicate(shellTexts) === true,
      );
    } finally {
      if (hadDocumentT14) globalThis.document = previousDocumentT14;
      else delete globalThis.document;
    }

    console.log('\nT15 — una sesión vencida corta antes de esperar el workboard');
    let t15WaitCalls = 0;
    const t15Page = {
      url: () => 'https://app.tolkien.mordorstaffing.com/api/auth/signin',
      goto: async () => ({ status: () => 200 }),
      waitForLoadState: async () => {},
      waitForFunction: async () => { t15WaitCalls += 1; },
    };
    let t15Error = null;
    try {
      await gotoReadOnly(t15Page, 'https://app.tolkien.mordorstaffing.com/tickets/vencida');
    } catch (error) {
      t15Error = error;
    }
    ok(
      'T15 — gotoReadOnly lanza InvalidSessionError sin llamar waitForFunction',
      t15Error instanceof InvalidSessionError && t15WaitCalls === 0,
      { t15Error, t15WaitCalls },
    );

    console.log('\nT16 — una sesión vencida no imprime un diagnóstico engañoso');
    const previousStderrWrite = process.stderr.write;
    let t16Stderr = '';
    let t16Error = null;
    try {
      process.stderr.write = (chunk) => {
        t16Stderr += String(chunk);
        return true;
      };
      await waitForWorkboard({
        url: () => 'https://app.tolkien.mordorstaffing.com/api/auth/signin',
        waitForFunction: async () => { throw new Error('timeout simulado'); },
      });
    } catch (error) {
      t16Error = error;
    } finally {
      process.stderr.write = previousStderrWrite;
    }
    ok(
      'T16 — waitForWorkboard propaga InvalidSessionError sin escribir a stderr',
      t16Error instanceof InvalidSessionError && t16Stderr === '',
      { t16Error, t16Stderr },
    );
  } finally {
    if (previousTimeout === undefined) delete process.env.CWC_TOLKIEN_WORKBOARD_TIMEOUT_MS;
    else process.env.CWC_TOLKIEN_WORKBOARD_TIMEOUT_MS = previousTimeout;
  }

  console.log(`\n${pass} pass / ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
