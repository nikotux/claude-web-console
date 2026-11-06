#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  applyCodexEvent,
  createCodexProgress,
  describeCommand,
  serializeCodexProgress,
} from '../src/modules/chat/codex-progress.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`ok ${pass} - ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`not ok ${pass + fail} - ${name}`);
    console.error(error.stack || error);
  }
}

const event = (type, item) => ({ type, item });

test('describe comandos en español simple y respeta el orden de reglas', () => {
  assert.equal(describeCommand("bash -lc 'npm test && npm run build'"), 'probando que el código funcione');
  assert.equal(describeCommand(['/bin/bash', '-lc', 'node --check src/app.js']), 'revisando que todo compile');
  assert.equal(describeCommand('pnpm install'), 'instalando dependencias');
  assert.equal(describeCommand('git status --short'), 'revisando qué cambió');
  assert.equal(describeCommand('gh pr create --fill'), 'trabajando con el PR');
  assert.equal(describeCommand('rg -n "runCodex" src'), 'leyendo el código');
  assert.equal(describeCommand('comando-desconocido --flag'), 'ejecutando una acción');
});

test('todo_list crea hasta 12 pasos limpios y devuelve changed correctamente', () => {
  const state = createCodexProgress();
  const todo = event('item.updated', {
    type: 'todo_list',
    items: [
      { text: '  Escribir   el código nuevo  ', completed: false },
      { text: 'Correr las pruebas', completed: true },
    ],
  });
  assert.equal(applyCodexEvent(state, todo, 100), true);
  assert.deepEqual(state.steps, [
    { text: 'Escribir el código nuevo', done: false },
    { text: 'Correr las pruebas', done: true },
  ]);
  assert.equal(state.updatedAt, 100);
  assert.equal(applyCodexEvent(state, todo, 200), false);
  assert.equal(state.updatedAt, 100);
});

test('agent_message usa el primer párrafo, colapsa espacios y recorta a 280', () => {
  const state = createCodexProgress();
  const long = `  ${'avance '.repeat(50)}\n\nEste párrafo no debe aparecer.`;
  assert.equal(applyCodexEvent(state, event('item.completed', {
    type: 'agent_message', text: long,
  }), 300), true);
  assert.equal(state.lastMessage.length, 280);
  assert.equal(state.lastMessage.endsWith('…'), true);
  assert.equal(state.lastMessage.includes('Este párrafo'), false);
});

test('agent_message extrae planes plain, bold y numerados con paréntesis', () => {
  const plain = createCodexProgress();
  assert.equal(applyCodexEvent(plain, event('item.completed', {
    type: 'agent_message',
    text: 'PLAN:\n1. Revisar el código\n2. Escribir el cambio\n3. Correr las pruebas',
  }), 310), true);
  assert.deepEqual(plain.steps, [
    { text: 'Revisar el código', done: false },
    { text: 'Escribir el cambio', done: false },
    { text: 'Correr las pruebas', done: false },
  ]);

  const bold = createCodexProgress();
  applyCodexEvent(bold, event('item.updated', {
    type: 'agent_message',
    text: '**PLAN:**\n1) Leer la implementación\n2) Ajustar el parser',
  }), 311);
  assert.deepEqual(bold.steps, [
    { text: 'Leer la implementación', done: false },
    { text: 'Ajustar el parser', done: false },
  ]);
});

test('marcadores Paso avanzan al mayor paso válido sin completar el actual', () => {
  const state = createCodexProgress();
  applyCodexEvent(state, event('item.completed', {
    type: 'agent_message',
    text: 'PLAN:\n1. Uno\n2. Dos\n3. Tres\n4. Cuatro\n5. Cinco',
  }), 320);
  assert.equal(applyCodexEvent(state, event('item.updated', {
    type: 'agent_message', text: 'Paso 2: sigo.\n\n**Paso 3:** ahora hago esto.',
  }), 321), true);
  assert.deepEqual(state.steps.map((step) => step.done), [true, true, false, false, false]);
  assert.equal(applyCodexEvent(state, event('item.completed', {
    type: 'agent_message', text: '**Paso 2 de 5** — vuelvo a comprobar.',
  }), 322), true);
  assert.deepEqual(state.steps.map((step) => step.done), [true, false, false, false, false]);
});

test('marcador fuera de rango se ignora', () => {
  const state = createCodexProgress();
  applyCodexEvent(state, event('item.completed', {
    type: 'agent_message', text: 'PLAN:\n1. Uno\n2. Dos',
  }), 330);
  assert.equal(applyCodexEvent(state, event('item.completed', {
    type: 'agent_message', text: 'Paso 7: no existe.',
  }), 331), true);
  assert.deepEqual(state.steps.map((step) => step.done), [false, false]);
  assert.equal(state.lastMessage, 'no existe.');
});

test('re-plan con distinta cantidad reemplaza textos y conserva pasos anteriores al actual', () => {
  const state = createCodexProgress();
  applyCodexEvent(state, event('item.completed', {
    type: 'agent_message', text: 'PLAN:\n1. Uno\n2. Dos\n3. Tres',
  }), 340);
  applyCodexEvent(state, event('item.completed', {
    type: 'agent_message', text: 'Paso 3: trabajando.',
  }), 341);
  applyCodexEvent(state, event('item.completed', {
    type: 'agent_message', text: '**PLAN**:\n1) Nuevo uno\n2) Nuevo dos\n3) Nuevo tres\n4) Nuevo cuatro',
  }), 342);
  assert.deepEqual(state.steps, [
    { text: 'Nuevo uno', done: true },
    { text: 'Nuevo dos', done: true },
    { text: 'Nuevo tres', done: false },
    { text: 'Nuevo cuatro', done: false },
  ]);
});

test('turn.completed completa todos los pasos salvo que hubo una señal de fallo', () => {
  const state = createCodexProgress();
  applyCodexEvent(state, event('item.completed', {
    type: 'agent_message', text: 'PLAN:\n1. Uno\n2. Dos',
  }), 350);
  assert.equal(applyCodexEvent(state, { type: 'turn.completed' }, 351), true);
  assert.equal(state.steps.every((step) => step.done), true);

  const failed = createCodexProgress();
  applyCodexEvent(failed, event('item.completed', {
    type: 'agent_message', text: 'PLAN:\n1. Uno\n2. Dos',
  }), 352);
  applyCodexEvent(failed, { type: 'turn.failed', error: { message: 'boom' } }, 353);
  assert.equal(applyCodexEvent(failed, { type: 'turn.completed' }, 354), false);
  assert.equal(failed.steps.some((step) => step.done), false);
});

test('lastMessage quita el plan y el marcador, y un mensaje solo con plan conserva el anterior', () => {
  const state = createCodexProgress();
  applyCodexEvent(state, event('item.completed', {
    type: 'agent_message', text: 'Avance anterior.',
  }), 360);
  applyCodexEvent(state, event('item.completed', {
    type: 'agent_message', text: 'PLAN:\n1. Uno\n2. Dos',
  }), 361);
  assert.equal(state.lastMessage, 'Avance anterior.');
  applyCodexEvent(state, event('item.completed', {
    type: 'agent_message', text: '**PLAN:**\n1) Uno\n2) Dos\n\n**Paso 2 de 2** — Voy a probar.',
  }), 362);
  assert.equal(state.lastMessage, 'Voy a probar.');
});

test('todo_list conserva prioridad sobre planes y marcadores de texto', () => {
  const state = createCodexProgress();
  applyCodexEvent(state, event('item.completed', {
    type: 'agent_message', text: 'PLAN:\n1. Texto uno\n2. Texto dos',
  }), 370);
  applyCodexEvent(state, event('item.updated', {
    type: 'todo_list',
    items: [
      { text: 'Todo uno', completed: true },
      { text: 'Todo dos', completed: false },
    ],
  }), 371);
  applyCodexEvent(state, event('item.completed', {
    type: 'agent_message', text: 'PLAN:\n1. Otro uno\n2. Otro dos\n3. Otro tres\n\nPaso 2: sigo.',
  }), 372);
  assert.deepEqual(state.steps, [
    { text: 'Todo uno', done: true },
    { text: 'Todo dos', done: false },
  ]);
});

test('file_change cuenta rutas únicas y registra la edición reciente', () => {
  const state = createCodexProgress();
  applyCodexEvent(state, event('item.completed', {
    type: 'file_change',
    changes: [
      { path: 'src/a.js', kind: 'update' },
      { path: 'src/b.js', kind: 'add' },
      { path: 'src/a.js', kind: 'update' },
    ],
  }), 400);
  applyCodexEvent(state, event('item.completed', {
    type: 'file_change', changes: [{ path: 'src/b.js', kind: 'update' }],
  }), 500);
  assert.equal(state.counts.files, 2);
  assert.deepEqual(state.now, { kind: 'edit', label: 'editando b.js', at: 500 });
  assert.equal(state.recent.length, 2);
});

test('command_execution cuenta acciones, conserva solo 10 recientes y marca errores', () => {
  const state = createCodexProgress();
  for (let index = 0; index < 12; index += 1) {
    applyCodexEvent(state, event('item.started', {
      type: 'command_execution', command: ['bash', '-lc', `node --test prueba-${index}.js`],
    }), 600 + index * 2);
    assert.equal(applyCodexEvent(state, event('item.completed', {
      type: 'command_execution',
      command: ['bash', '-lc', `node --test prueba-${index}.js`],
      exit_code: index === 11 ? 1 : 0,
      status: 'completed',
    }), 601 + index * 2), true);
  }
  assert.equal(state.counts.actions, 12);
  assert.equal(state.recent.length, 10);
  assert.equal(state.recent.at(-1).ok, false);
  assert.equal(state.recent.every((entry) => entry.label === 'probando que el código funcione'), true);
});

test('reasoning no tapa un comando en curso y herramientas sí actualizan now', () => {
  const state = createCodexProgress();
  applyCodexEvent(state, event('item.started', {
    type: 'command_execution', command: 'node --check app.js',
  }), 700);
  assert.equal(applyCodexEvent(state, event('item.started', { type: 'reasoning' }), 701), false);
  assert.equal(state.now.kind, 'command');
  applyCodexEvent(state, event('item.completed', {
    type: 'command_execution', command: 'node --check app.js', exit_code: 0,
  }), 702);
  assert.equal(applyCodexEvent(state, event('item.completed', { type: 'reasoning' }), 703), true);
  assert.deepEqual(state.now, { kind: 'thinking', label: 'pensando el próximo paso', at: 703 });
  assert.equal(applyCodexEvent(state, event('item.started', { type: 'mcp_tool_call' }), 704), true);
  assert.equal(state.now.label, 'consultando una herramienta');
  assert.equal(applyCodexEvent(state, event('item.started', { type: 'web_search' }), 705), true);
  assert.equal(state.now.label, 'buscando en la web');
});

test('eventos desconocidos y basura se ignoran sin lanzar', () => {
  const state = createCodexProgress();
  for (const value of [null, undefined, 7, {}, { type: 'otro' }, event('item.started', null)]) {
    assert.doesNotThrow(() => assert.equal(applyCodexEvent(state, value, 800), false));
  }
  assert.deepEqual(serializeCodexProgress(state), {
    updatedAt: null,
    steps: null,
    lastMessage: null,
    now: null,
    counts: { files: 0, actions: 0 },
    recent: [],
  });
});

test('una secuencia realista produce un snapshot JSON pequeño', () => {
  const state = createCodexProgress();
  const sequence = [
    event('item.started', {
      type: 'todo_list',
      items: [
        { text: 'Revisar el código existente', completed: true },
        { text: 'Escribir el código nuevo', completed: false },
        { text: 'Correr las pruebas', completed: false },
      ],
    }),
    event('item.started', { type: 'reasoning', text: 'We need inspect.' }),
    event('item.started', { type: 'command_execution', command: "/bin/bash -lc 'sed -n 1,120p app.js'" }),
    event('item.completed', {
      type: 'command_execution', command: "/bin/bash -lc 'sed -n 1,120p app.js'", exit_code: 0,
    }),
    event('item.completed', {
      type: 'file_change', changes: [{ path: 'src/app.js', kind: 'update' }],
    }),
    event('item.completed', {
      type: 'agent_message', text: 'La implementación quedó lista.\n\nAhora cierro con las pruebas.',
    }),
    event('item.completed', {
      type: 'todo_list',
      items: [
        { text: 'Revisar el código existente', completed: true },
        { text: 'Escribir el código nuevo', completed: true },
        { text: 'Correr las pruebas', completed: true },
      ],
    }),
  ];
  sequence.forEach((entry, index) => applyCodexEvent(state, entry, 1000 + index));
  const snapshot = serializeCodexProgress(state);
  const json = JSON.stringify(snapshot);
  assert.doesNotThrow(() => JSON.parse(json));
  assert.equal(json.length < 6 * 1024, true);
  assert.deepEqual(snapshot.counts, { files: 1, actions: 1 });
  assert.equal(snapshot.steps.every((step) => step.done), true);
  assert.equal(Object.getOwnPropertySymbols(snapshot).length, 0);
});

console.log(`${pass} pass / ${fail} fail`);
process.exitCode = fail ? 1 : 0;
