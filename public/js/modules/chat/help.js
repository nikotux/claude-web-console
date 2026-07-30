// modules/chat/help.js — contenido contextual de ayuda para el Chat.
//
// Exporta una función para que todos los textos pasen por t() al abrir el tema
// y usa los componentes reales para mostrar íconos dobles y Pac-Man vivos.
import { icon } from '../../ui/icons.js';
import { pacman } from '../../ui/pacman.js';
import { t } from '../../ui/i18n.js';

function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]
  ));
}

function actionRow(actionIcon, name, desc) {
  return `<div class="hlp-leg">
    <span class="hlp-leg-ic">${icon('terminal', { size: 13 })}${icon(actionIcon, { size: 12 })}</span>
    <b>${esc(name)}</b><span>${esc(desc)}</span>
  </div>`;
}

function pacmanRow(state, name, desc) {
  return `<div class="hlp-leg">
    <span class="hlp-leg-ic">${pacman({ state, size: 'sm', title: name })}</span>
    <b>${esc(name)}</b><span>${esc(desc)}</span>
  </div>`;
}

function peerColorsRow(name, desc) {
  const dots = Array.from({ length: 6 }, (_, i) => `<i class="chat-help-peer-dot peer-${i + 1}"></i>`).join('');
  return `<div class="hlp-leg">
    <span class="hlp-leg-ic chat-help-peer-colors" aria-hidden="true">${dots}</span>
    <b>${esc(name)}</b><span>${esc(desc)}</span>
  </div>`;
}

function salaSections() {
  return [
    {
      title: t('chat.help.sala.what.title', 'Qué es una sala'),
      blocks: [
        {
          type: 'p',
          text: t('chat.help.sala.what.text', 'Aduana es una sala colaborativa: varias personas comparten un único hilo, conversan entre ellas y deciden cuándo enviar todo lo hablado desde el último corte a la IA.'),
        },
      ],
    },
    {
      title: t('chat.help.sala.first.title', 'Primeros pasos en la sala'),
      blocks: [
        {
          type: 'steps',
          items: [
            t('chat.help.sala.first.step1', 'Escribí un mensaje y tocá Enviar: aparece en el hilo compartido sin llamar a la IA.'),
            t('chat.help.sala.first.step2', 'Esperá o conversá hasta reunir el contexto que necesiten. El contador muestra cuántos mensajes hay desde el último corte.'),
            t('chat.help.sala.first.step3', 'Tocá ✦ Enviar a la IA cuando quieran iniciar un turno. Si está ocupada, el corte queda pendiente.'),
            t('chat.help.sala.first.step4', 'Seguí la respuesta en el mismo hilo; cualquier participante ve la conversación completa.'),
          ],
        },
      ],
    },
    {
      title: t('chat.help.sala.legend.title', 'Leyenda de la sala'),
      blocks: [
        {
          type: 'legend',
          items: [
            {
              emoji: '✦',
              name: t('chat.help.sala.legend.ai.name', 'Enviar a la IA'),
              desc: t('chat.help.sala.legend.ai.desc', 'manda todos los mensajes acumulados desde el corte anterior'),
            },
            {
              emoji: '✂',
              name: t('chat.help.sala.legend.cut.name', 'Corte'),
              desc: t('chat.help.sala.legend.cut.desc', 'marca exactamente qué bloque de la conversación recibió la IA'),
            },
            {
              emoji: t('chat.help.sala.legend.origin.emoji', '🛃'),
              name: t('chat.help.sala.legend.origin.name', 'Entrada a la sala'),
              desc: t('chat.help.sala.legend.origin.desc', 'la barra del hilo marca desde qué mundo llegó la conversación y quién la trajo'),
            },
          ],
        },
        {
          type: 'html',
          html: peerColorsRow(
            t('chat.help.sala.legend.colors.name', 'Colores'),
            t('chat.help.sala.legend.colors.desc', 'identifican de forma estable a cada participante'),
          ),
        },
      ],
    },
    {
      title: t('chat.help.sala.tokens.title', 'Qué consume tokens'),
      blocks: [
        {
          type: 'kv',
          items: [
            {
              k: t('chat.help.sala.tokens.people.k', 'Hablar entre personas'),
              v: t('chat.help.sala.tokens.people.v', 'No consume tokens: son mensajes internos de la sala.'),
            },
            {
              k: t('chat.help.sala.tokens.ai.k', '✦ Enviar a la IA'),
              v: t('chat.help.sala.tokens.ai.v', 'Sí consume tokens: inicia un turno con todo lo acumulado desde el último corte.'),
            },
          ],
        },
      ],
    },
    {
      title: t('chat.help.sala.warning.title', 'Ojo con esto'),
      blocks: [
        {
          type: 'note',
          tone: 'warn',
          text: t('chat.help.sala.warning.text', 'Los turnos de IA los paga el anfitrión de la sala. Las personas invitadas ven todo el hilo compartido, incluidos los mensajes anteriores y las respuestas de la IA.'),
        },
      ],
    },
  ];
}

export function salaHelp() {
  return {
    title: t('chat.help.sala.title', 'Sala de Aduana'),
    icon: 'sparkle',
    intro: t('chat.help.sala.intro', 'Una conversación compartida para coordinarse entre personas y llamar a la IA solamente cuando el grupo lo decide.'),
    sections: salaSections(),
  };
}

export default function chatHelp() {
  return {
    title: t('chat.help.title', 'Ayuda del chat'),
    icon: 'sparkle',
    intro: t('chat.help.intro', 'El chat es donde conversás con el asistente y ves cada acción que hace sobre tu proyecto. Podés elegir cuánto permiso darle, adjuntar contexto y seguir el trabajo mientras ocurre.'),
    sections: [
      {
        title: t('chat.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('chat.help.first.step1', 'Elegí el modo de permisos en el selector del header.'),
              t('chat.help.first.step2', 'Escribí o dictá el pedido; si hace falta, tocá Adjuntar o Referenciar paquete para sumar contexto.'),
              t('chat.help.first.step3', 'Tocá Enviar o presioná Enter. Usá Shift+Enter para agregar una línea sin enviar.'),
              t('chat.help.first.step4', 'Respondé las preguntas y permisos que aparezcan; tocá cada chip de acción para ver su detalle.'),
              t('chat.help.first.step5', 'Si querés cortar una respuesta en curso, tocá Detener y confirmá.'),
            ],
          },
        ],
      },
      {
        title: t('chat.help.modesSection', 'Modos de permisos'),
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('chat.mode.ask', 'Preguntar'),
                v: t('chat.help.askDesc', 'El modo estándar. Claude pide permiso antes de CADA acción que toque tu sistema (editar archivos, correr comandos): aparece una tarjeta y vos aprobás o denegás una por una.'),
              },
              {
                k: t('chat.mode.edits', 'Ediciones'),
                v: t('chat.help.editsDesc', 'Claude puede editar y crear archivos sin preguntar; todo lo demás (comandos de terminal, red, etc.) sigue pidiendo permiso. Cómodo cuando ya confiás en el rumbo del trabajo.'),
              },
              {
                k: t('chat.mode.all', 'Todo'),
                v: t('chat.help.allDesc', 'Aceptación avanzada: Claude ejecuta ABSOLUTAMENTE todo sin pedir permiso — comandos, ediciones, red. Es el modo más riesgoso y pide confirmación al activarlo.'),
              },
              {
                k: t('chat.mode.plan', 'Plan'),
                v: t('chat.help.planDesc', 'Claude no toca nada: solo lee el proyecto y arma un plan de trabajo. Ideal para explorar una idea o revisar qué haría antes de autorizar cambios.'),
              },
            ],
          },
          {
            type: 'p',
            text: t('chat.help.modesFoot', 'Podés cambiar de modo en cualquier momento; aplica desde la próxima acción. El color del selector marca el riesgo: verde = controlado · amarillo = medio · rojo = acepta todo.'),
          },
        ],
      },
      {
        title: t('chat.help.controlsLegend.title', 'Leyenda · controles'),
        blocks: [
          {
            type: 'legend',
            items: [
              {
                icon: 'menu',
                name: t('chat.help.controlsLegend.menu.name', 'Menú'),
                desc: t('chat.help.controlsLegend.menu.desc', 'abre el panel lateral en pantallas chicas'),
              },
              {
                icon: 'paperclip',
                name: t('chat.help.controlsLegend.attach.name', 'Adjuntar'),
                desc: t('chat.help.controlsLegend.attach.desc', 'suma archivos al próximo mensaje'),
              },
              {
                icon: 'externalLink',
                name: t('chat.help.controlsLegend.package.name', 'Paquete'),
                desc: t('chat.help.controlsLegend.package.desc', 'trae una referencia de otra sesión'),
              },
              {
                icon: 'play',
                name: t('chat.help.controlsLegend.send.name', 'Enviar'),
                desc: t('chat.help.controlsLegend.send.desc', 'manda el mensaje o inicia una acción'),
              },
              {
                icon: 'close',
                name: t('chat.help.controlsLegend.stop.name', 'Detener'),
                desc: t('chat.help.controlsLegend.stop.desc', 'interrumpe la respuesta que está corriendo'),
              },
              {
                icon: 'help',
                name: t('chat.help.controlsLegend.help.name', 'Ayuda'),
                desc: t('chat.help.controlsLegend.help.desc', 'abre esta guía'),
              },
            ],
          },
        ],
      },
      {
        title: t('chat.help.iconsSection', 'Íconos de acciones'),
        wide: true,
        blocks: [
          {
            type: 'p',
            text: t('chat.help.iconsIntro', 'Cada acción del asistente aparece en el hilo como un chip de dos íconos: la consola (ejecutó una herramienta) + el tipo. Tocá el chip para ver el detalle completo; el borde marca el resultado (verde ok · rojo error).'),
          },
          {
            type: 'html',
            html: [
              actionRow('play', t('chat.help.legBashName', 'Bash'), t('chat.help.legBashDesc', 'corre un comando')),
              actionRow('edit', t('chat.help.legEditName', 'Edit / Write'), t('chat.help.legEditDesc', 'edita o crea archivos')),
              actionRow('eye', t('chat.help.legReadName', 'Read'), t('chat.help.legReadDesc', 'lee archivos')),
              actionRow('search', t('chat.help.legGrepName', 'Grep / Glob'), t('chat.help.legGrepDesc', 'busca en el proyecto')),
              actionRow('download', t('chat.help.legWebName', 'Web'), t('chat.help.legWebDesc', 'consulta la web')),
              actionRow('list', t('chat.help.legTodoName', 'Todo'), t('chat.help.legTodoDesc', 'muestra la lista de tareas del agente')),
              actionRow('sparkle', t('chat.help.legTaskName', 'Task / Agent'), t('chat.help.legTaskDesc', 'lanza un subagente')),
              actionRow('help', t('chat.help.legQuestionName', 'Pregunta'), t('chat.help.legQuestionDesc', 'te pide elegir o escribir una respuesta')),
              actionRow('gear', t('chat.help.legOtherName', 'Otras'), t('chat.help.legOtherDesc', 'cualquier otra herramienta')),
            ].join(''),
          },
        ],
      },
      {
        title: t('chat.help.viz.title', 'Gráficos y diagramas'),
        icon: 'pulse',
        blocks: [
          {
            type: 'p',
            text: t('chat.help.viz.charts', 'Cuando la IA muestra datos cuantitativos, pueden aparecer gráficos dibujados directamente dentro del mensaje.'),
          },
          {
            type: 'p',
            text: t('chat.help.viz.mermaid', 'Los diagramas Mermaid se leen a ancho completo; el botón “Ampliar” los abre en grande para recorrer estructuras y flujos complejos.'),
          },
          {
            type: 'p',
            text: t('chat.help.viz.source', 'Debajo de cada visualización hay un desplegable “Ver datos del gráfico” o “Ver código Mermaid” con la fuente exacta para copiar.'),
          },
          {
            type: 'p',
            text: t('chat.help.viz.tokens', 'Los gráficos se dibujan en tu navegador y NO consumen tokens.'),
          },
        ],
      },
      {
        title: t('chat.help.pacSection', 'Estados del Pac-Man'),
        wide: true,
        blocks: [
          {
            type: 'p',
            text: t('chat.help.pacIntro', 'El mismo Pac-Man aparece acá arriba y en las tarjetas de Sesiones: el color y el movimiento dicen qué está haciendo la conversación en cada momento.'),
          },
          {
            type: 'html',
            html: [
              pacmanRow('working', t('chat.help.pacWorkingName', 'Trabajando'), t('chat.help.pacWorkingDesc', 'dorado, mordisco rápido: un turno corriendo ahora')),
              pacmanRow('delegating', t('chat.help.pacDelegatingName', 'Delegando'), t('chat.help.pacDelegatingDesc', 'violeta con el ícono del interfono: esperando que vuelva un subagente (Task) u otro proceso')),
              pacmanRow('queued', t('chat.help.pacQueuedName', 'En cola'), t('chat.help.pacQueuedDesc', 'ámbar que respira: esperando su turno detrás de otro paso')),
              pacmanRow('waiting', t('chat.help.pacWaitingName', 'Tu turno'), t('chat.help.pacWaitingDesc', 'verde, parpadeo lento: esperando tu mensaje o tu decisión')),
              pacmanRow('stale', t('chat.help.pacStaleName', 'Sin señales'), t('chat.help.pacStaleDesc', 'ámbar apagado y quieto: se perdió el rastro, no se sabe si sigue activo')),
              pacmanRow('error', t('chat.help.pacErrorName', 'Falló'), t('chat.help.pacErrorDesc', 'rojo y quieto: se detuvo por un error')),
              pacmanRow('dormant', t('chat.help.pacDormantName', 'Dormido'), t('chat.help.pacDormantDesc', 'gris y quieto: nada activo ni delegado — el único estado sin animación')),
            ].join(''),
          },
        ],
      },
      {
        title: t('chat.help.tandem.title', 'Modo Tándem'),
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('chat.help.tandem.what.k', '🤝 Tándem'),
                v: t('chat.help.tandem.what.v', 'Opus con esfuerzo alto razona y verifica; Codex GPT-5.6 Sol con esfuerzo alto ejecuta el código.'),
              },
              {
                k: t('chat.help.tandem.badge.k', 'Insignia del modelo'),
                v: t('chat.help.tandem.badge.v', 'El header muestra “Tándem” cuando está activo. El modelo se cambia desde el menú de la conversación en Sesiones, no desde esta insignia.'),
              },
              {
                k: t('chat.help.tandem.inactive.k', 'Tándem · inactivo'),
                v: t('chat.help.tandem.inactive.v', 'La elección cambió pero el motor actual arrancó antes. Usá “Reabrir para cambios” en el menú de Sesiones.'),
              },
            ],
          },
        ],
      },
      ...salaSections(),
      {
        title: t('chat.help.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [
          {
            type: 'kv',
            items: [
              { k: t('chat.help.buttons.menu.k', 'Menú lateral'), v: t('chat.help.buttons.menu.v', 'En móvil, abre la navegación de sesiones y herramientas.') },
              { k: t('chat.help.buttons.world.k', 'Mundo'), v: t('chat.help.buttons.world.v', 'Indica en qué proyecto y cuentas trabaja esta conversación; es informativo.') },
              { k: t('chat.help.buttons.flow.k', 'Caudal'), v: t('chat.help.buttons.flow.v', 'Muestra actividad y tokens aproximados de Claude y Codex; es informativo y sólo aparece cuando corresponde.') },
              { k: t('chat.help.buttons.pacman.k', 'Pac-Man'), v: t('chat.help.buttons.pacman.v', 'Resume si el chat está trabajando, delegando o esperando tu mensaje.') },
              { k: t('chat.help.buttons.model.k', 'Insignia de modelo'), v: t('chat.help.buttons.model.v', 'Muestra AutoTux, Tándem o el modelo forzado y el esfuerzo. No es un selector: cambialo desde Sesiones.') },
              { k: t('chat.help.buttons.mode.k', 'Modo de permisos'), v: t('chat.help.buttons.mode.v', 'Cambia cuánta autonomía tiene el asistente desde la próxima acción.') },
              { k: t('chat.help.buttons.attach.k', 'Adjuntar'), v: t('chat.help.buttons.attach.v', 'Sube imágenes, PDF, texto u otros archivos para el próximo mensaje; admite hasta 8. También podés pegar o arrastrar archivos.') },
              { k: t('chat.help.buttons.package.k', 'Referenciar paquete'), v: t('chat.help.buttons.package.v', 'Busca otra sesión e inserta una referencia con su contexto en el mensaje. Atajo: F5.') },
              { k: t('chat.help.buttons.input.k', 'Mensaje'), v: t('chat.help.buttons.input.v', 'Escribí o dictá. Enter envía; Shift+Enter agrega una línea. Los comandos “/” tienen autocompletado.') },
              { k: t('chat.help.buttons.send.k', 'Enviar'), v: t('chat.help.buttons.send.v', 'Manda el mensaje y pone a trabajar al asistente; ese trabajo consume tokens.') },
              { k: t('chat.help.buttons.stop.k', 'Detener'), v: t('chat.help.buttons.stop.v', 'Interrumpe la respuesta en curso después de confirmar.') },
              { k: t('chat.help.buttons.permission.k', 'Permitir / Denegar'), v: t('chat.help.buttons.permission.v', 'Aprueba o rechaza una acción puntual cuando el modo exige permiso.') },
              { k: t('chat.help.buttons.tool.k', 'Chip de acción'), v: t('chat.help.buttons.tool.v', 'Abre el comando, archivo, resultado o error completo de una herramienta.') },
              { k: t('chat.help.buttons.answer.k', 'Responder pregunta'), v: t('chat.help.buttons.answer.v', 'Elegí una opción o escribí otra respuesta; Enviar se habilita al completar todas. Cancelar rechaza la pregunta.') },
              { k: t('chat.help.buttons.retry.k', 'Reintentar / Ignorar'), v: t('chat.help.buttons.retry.v', 'Si aparece la sugerencia de un modelo más fuerte, vos decidís si rehacer el último turno; nunca cambia solo. Reintentar consume tokens.') },
            ],
          },
        ],
      },
      {
        title: t('chat.help.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'danger',
            text: t('chat.help.warning.text', '“Todo” puede ejecutar comandos, editar archivos y usar la red sin volver a preguntarte. Detener corta lo que sigue, pero no deshace acciones ya completadas; revisá los chips antes de aprobar algo sensible.'),
          },
        ],
      },
    ],
  };
}
