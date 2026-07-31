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
          text: t('chat.help.sala.what.text', 'Aduana es una sala colaborativa: varias personas comparten un único hilo y conversan entre ellas. La IA arranca muda: los mensajes humanos no la llaman y solo habla después de que alguien toca el botón de corte.'),
        },
      ],
    },
    {
      title: t('chat.help.sala.first.title', 'Primeros pasos en la sala'),
      blocks: [
        {
          type: 'steps',
          items: [
            t('chat.help.sala.first.step1', 'Escribí un mensaje y tocá Enviar: viaja por el canal say, aparece en el hilo compartido y cuesta 0 tokens; no llama a la IA.'),
            t('chat.help.sala.first.step2', 'Esperá o conversá hasta reunir el contexto que necesiten. El contador muestra cuántos mensajes hay desde el último corte.'),
            t('chat.help.sala.first.step3', 'Tocá ✦ Enviar a la IA cuando quieran iniciar un turno. Si está ocupada, el corte queda pendiente.'),
            t('chat.help.sala.first.step4', 'Seguí la respuesta en el mismo hilo; cualquier participante ve la conversación completa.'),
          ],
        },
      ],
    },
    {
      title: t('chat.help.sala.controls.title', 'Controles de la sala'),
      blocks: [
        {
          type: 'kv',
          items: [
            {
              k: t('chat.help.sala.controls.compose.k', 'Adjuntar, Referenciar y Enviar'),
              v: t('chat.help.sala.controls.compose.v', 'Podés sumar archivos o una referencia de otra sesión y después publicar el say. Preparar ese contenido cuesta 0 tokens; queda esperando el corte.'),
            },
            {
              k: t('chat.help.sala.controls.stop.k', 'Detener'),
              v: t('chat.help.sala.controls.stop.v', 'Durante un turno de IA, pide confirmación y corta lo que sigue sin deshacer acciones terminadas. Solo puede decidir quien hizo el corte o, como respaldo, el dueño.'),
            },
            {
              k: t('chat.help.sala.controls.acta.k', 'Acta'),
              v: t('chat.help.sala.controls.acta.v', 'Tocá su encabezado para desplegarla o plegarla; el aviso indica si puede estar desactualizada.'),
            },
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
              desc: t('chat.help.sala.legend.ai.desc', 'manda lo acumulado; si hay preguntas @cucho, manda solo esas y deja el resto esperando'),
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
      title: t('chat.help.sala.people.title', 'Personas, menciones y lectura'),
      blocks: [
        {
          type: 'p',
          text: t('chat.help.sala.people.identity', 'Cada participante tiene un avatar y un color propios. Ese color se repite en su nombre, en sus mensajes y en las menciones dirigidas a esa persona; los mensajes seguidos de un mismo autor se agrupan en un solo bloque.'),
        },
        {
          type: 'p',
          text: t('chat.help.sala.people.reply', 'La respuesta de la IA indica a quién le está contestando. Si responde a varias personas, vas a ver los colores de todas.'),
        },
        {
          type: 'p',
          text: t('chat.help.sala.people.mentions', 'Escribí @ para abrir la lista de participantes y mencionar a alguien. A la persona mencionada le queda un aviso más fuerte que el de “mensajes nuevos”.'),
        },
        {
          type: 'p',
          text: t('chat.help.sala.people.cucho', 'La IA de la sala se llama Cucho. Escribir @cucho marca ese mensaje como una pregunta para ella, pero no la despierta: todavía hace falta tocar el botón. Cuando hay preguntas marcadas, el botón envía solo esas y el resto de la charla queda esperando el próximo corte.'),
        },
        {
          type: 'p',
          text: t('chat.help.sala.people.unread', 'El separador “mensajes nuevos” marca el punto donde arrancaste a leer esta vez. Queda en el hilo aunque el contador ya se haya marcado como leído.'),
        },
        {
          type: 'p',
          text: t('chat.help.sala.people.reactions', 'Podés reaccionar a un mensaje con 👍, ❓ o 🔴 para alinearse sin escribir. Reaccionar no consume tokens ni entra al contexto de la IA; en cambio, un mensaje escrito sí entra al próximo corte.'),
        },
        {
          type: 'p',
          text: t('chat.help.sala.people.quoteReply', 'El cuarto botón de esa fila permite responder citando un mensaje. La cita queda visible y, al tocarla, te lleva al original. Publicar la respuesta cuesta 0 tokens, como cualquier say; queda esperando y recién entra al contexto pago cuando alguien hace el próximo corte.'),
        },
      ],
    },
    {
      title: t('chat.help.sala.minutes.title', 'Acta de la sala'),
      blocks: [
        {
          type: 'p',
          text: t('chat.help.sala.minutes.text', 'Arriba del hilo está el acta con lo acordado, lo pendiente y lo que quedó abierto. La IA la actualiza en cada corte cuando hay algo nuevo que anotar; si pasa mucho tiempo sin actualizarse, la sala te avisa.'),
        },
      ],
    },
    {
      title: t('chat.help.sala.permissions.title', 'Permisos y dueño'),
      blocks: [
        {
          type: 'kv',
          items: [
            {
              k: t('chat.help.sala.permissions.owner.k', 'Quién fija el modo'),
              v: t('chat.help.sala.permissions.owner.v', 'Solo el dueño de la sala fija el modo de permisos. Un invitado nunca lo cambia, aunque vea el selector.'),
            },
            {
              k: t('chat.help.sala.permissions.all.k', 'Modo Todo'),
              v: t('chat.help.sala.permissions.all.v', 'La sala sí puede correr en Todo (bypassPermissions), pero únicamente por decisión explícita del dueño. Acepta comandos, ediciones y red sin preguntar y conserva el mismo riesgo alto del chat común.'),
            },
          ],
        },
      ],
    },
    {
      title: t('chat.help.sala.orchestrate.title', 'Orquestar una respuesta'),
      blocks: [
        {
          type: 'note',
          tone: 'info',
          text: t('chat.help.sala.orchestrate.text', 'El botón Orquestar crea una conversación nueva en el mundo que elijas y deja ese texto esperando en el composer para que puedas revisarlo o editarlo. No ejecuta nada hasta que vos abras esa conversación y envíes el mensaje.'),
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
              k: t('chat.help.sala.tokens.people.k', 'Enviar en la sala (say)'),
              v: t('chat.help.sala.tokens.people.v', 'Cuesta 0 tokens: se difunde y se guarda como conversación interna. Solo pasa a ser contexto pago si después alguien hace un corte.'),
            },
            {
              k: t('chat.help.sala.tokens.reactions.k', 'Reaccionar con 👍, ❓ o 🔴'),
              v: t('chat.help.sala.tokens.reactions.v', 'No consume tokens: las reacciones no entran al próximo corte ni viajan como contexto a la IA.'),
            },
            {
              k: t('chat.help.sala.tokens.quoteReply.k', 'Responder citando'),
              v: t('chat.help.sala.tokens.quoteReply.v', 'Cuesta 0 tokens al publicarse; como es un say, queda para el próximo corte. La cita visible enlaza al mensaje original.'),
            },
            {
              k: t('chat.help.sala.tokens.ai.k', '✦ Enviar a la IA'),
              v: t('chat.help.sala.tokens.ai.v', 'Sí consume tokens: inicia un turno con todo lo acumulado desde el último corte.'),
            },
            {
              k: t('chat.help.sala.tokens.orchestrate.k', 'Orquestar'),
              v: t('chat.help.sala.tokens.orchestrate.v', 'No consume tokens por sí mismo: el consumo empieza después, si enviás el mensaje desde la conversación nueva.'),
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
          text: t('chat.help.sala.warning.text', 'Los turnos de IA los paga el anfitrión de la sala, sin importar quién apriete el corte. Las personas invitadas ven todo el hilo compartido, incluidos los mensajes anteriores y las respuestas de la IA.'),
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
              t('chat.help.first.step4', 'Respondé las preguntas y permisos que aparezcan; tocá el Pac-Man de cada bloque para ver en el panel lateral qué herramientas se ejecutaron.'),
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
            text: t('chat.help.iconsIntro', 'Las herramientas que ejecuta el asistente ya no ocupan el hilo: cada bloque de trabajo se resume en un Pac-Man con el número de herramientas que corrió. Tocalo y el detalle completo —comando, cambios y resultado— se abre en un panel a la derecha. El Pac-Man se mueve mientras el bloque trabaja, queda quieto al terminar y se pone rojo si algo falló.'),
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
            text: t('chat.help.viz.mermaid', 'Los diagramas Mermaid se leen a ancho completo; el botón “Ampliar” abre un visor con zoom y paneo: acercá con los botones, la rueda o pinch, arrastrá para recorrerlo y usá “Ajustar” para volver al encuadre.'),
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
            text: t('chat.help.pacIntro', 'El Pac-Man del header muestra el turno; el de cada bloque resume sus herramientas. El color y el movimiento indican qué está pasando.'),
          },
          {
            type: 'html',
            html: [
              pacmanRow('working', t('chat.help.pacWorkingName', 'Trabajando'), t('chat.help.pacWorkingDesc', 'dorado, mordisco rápido: un turno corriendo ahora')),
              pacmanRow('delegating', t('chat.help.pacDelegatingName', 'Delegando'), t('chat.help.pacDelegatingDesc', 'violeta con el ícono del interfono: esperando que vuelva un subagente (Task) u otro proceso')),
              pacmanRow('waiting', t('chat.help.pacWaitingName', 'Tu turno'), t('chat.help.pacWaitingDesc', 'verde, parpadeo lento: esperando tu mensaje o tu decisión')),
              pacmanRow('error', t('chat.help.pacErrorName', 'Falló'), t('chat.help.pacErrorDesc', 'rojo y quieto: alguna herramienta del bloque falló')),
              pacmanRow('dormant', t('chat.help.pacDormantName', 'Terminado'), t('chat.help.pacDormantDesc', 'gris y quieto: todas las herramientas del bloque terminaron bien')),
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
                v: t('chat.help.tandem.what.v', 'Claude (Opus con esfuerzo alto) razona, planea y verifica; Codex GPT-5.6 Sol con esfuerzo alto ejecuta los cambios de código.'),
              },
              {
                k: t('chat.help.tandem.badge.k', 'Insignia del modelo'),
                v: t('chat.help.tandem.badge.v', 'El header muestra “Tándem” cuando está activo. El modelo se cambia desde el menú de la conversación en Sesiones, no desde esta insignia.'),
              },
              {
                k: t('chat.help.tandem.inactive.k', 'Tándem · inactivo'),
                v: t('chat.help.tandem.inactive.v', 'La elección cambió pero el motor actual arrancó antes. Usá “Reabrir para cambios” en el menú de Sesiones.'),
              },
              {
                k: t('chat.help.tandem.parallel.k', 'Delegaciones en paralelo'),
                v: t('chat.help.tandem.parallel.v', 'Claude puede lanzar varias delegaciones de Codex al mismo tiempo si tocan archivos disjuntos. Dos delegaciones sobre el mismo archivo no deben correr en paralelo porque pueden pisarse.'),
              },
              {
                k: t('chat.help.tandem.restart.k', 'Sobreviven a la web'),
                v: t('chat.help.tandem.restart.v', 'Cada delegación corre en un proceso propio y persiste en disco: sigue viva aunque se reinicie la interfaz web, y Claude puede recuperar después su estado y resultado.'),
              },
            ],
          },
        ],
      },
      {
        title: t('chat.help.continuity.title', 'Continuidad y autonomía'),
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('chat.help.continuity.runner.k', 'Código nuevo y runner vivo'),
                v: t('chat.help.continuity.runner.v', 'Un runner que ya está vivo conserva el código que cargó al arrancar. Para que tome cambios nuevos, usá “Reabrir para cambios” en el menú de Sesiones; el contexto se conserva.'),
              },
              {
                k: t('chat.help.continuity.ball.k', '🎾 Pelota: MÍA'),
                v: t('chat.help.continuity.ball.v', 'La línea final es un contrato, no decoración: si el asistente cierra con “🎾 Pelota: MÍA”, el sistema le devuelve el control y el chat sigue solo sin esperar otro mensaje tuyo.'),
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
              { k: t('chat.help.buttons.attach.k', 'Adjuntar'), v: t('chat.help.buttons.attach.v', 'Sube hasta 8 imágenes, PDF, textos u otros archivos; también podés pegar o arrastrar. Adjuntar, quitar o abrir una vista previa no consume tokens: el consumo empieza al enviar el mensaje que los incluye.') },
              { k: t('chat.help.buttons.package.k', 'Referenciar paquete'), v: t('chat.help.buttons.package.v', 'Abre un buscador de sesiones e inserta la referencia elegida en el mensaje. Atajo: F5. Buscar o insertar cuesta 0 tokens; enviar el mensaje sí consume.') },
              { k: t('chat.help.buttons.input.k', 'Mensaje'), v: t('chat.help.buttons.input.v', 'Escribí o dictá. Enter envía; Shift+Enter agrega una línea. “/” abre comandos con flechas, Tab o Enter para elegir y Esc para cerrar.') },
              { k: t('chat.help.buttons.send.k', 'Enviar'), v: t('chat.help.buttons.send.v', 'Manda el mensaje y pone a trabajar al asistente; ese trabajo consume tokens.') },
              { k: t('chat.help.buttons.stop.k', 'Detener'), v: t('chat.help.buttons.stop.v', 'Interrumpe la respuesta en curso después de confirmar. No consume otro turno ni deshace acciones ya completadas.') },
              { k: t('chat.help.buttons.permission.k', 'Permitir / Denegar'), v: t('chat.help.buttons.permission.v', 'Tocá el chip para desplegar la herramienta, el comando o el diff exacto; después aprobá o rechazá la acción puntual. Los comandos peligrosos ya aparecen abiertos.') },
              { k: t('chat.help.buttons.tool.k', 'Pac-Man del bloque'), v: t('chat.help.buttons.tool.v', 'Abre el panel lateral con el comando, archivo, resultado o error de cada herramienta de ese bloque. Volvé a tocarlo (o usá ✕ / Esc) para cerrarlo.') },
              {
                k: t('chat.help.buttons.rawpanel.k', 'Panel de detalle'),
                v: t('chat.help.buttons.rawpanel.v', 'Ocupa un tercio a la derecha; en el teléfono se abre casi a pantalla completa. Muestra solo las herramientas del bloque que tocaste.'),
              },
              { k: t('chat.help.buttons.answer.k', 'Responder pregunta'), v: t('chat.help.buttons.answer.v', 'Elegí una opción o escribí otra respuesta; Enviar se habilita al completar todas. Cancelar rechaza la pregunta. Enviar permite que el turno continúe y esa continuación consume tokens.') },
              { k: t('chat.help.buttons.pending.k', 'Texto orquestado / Descartar'), v: t('chat.help.buttons.pending.v', 'Una instrucción creada desde Aduana queda editable en el composer y no ejecuta nada sola. Enviar inicia un turno y consume tokens; Descartar la elimina sin consumo.') },
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
            text: t('chat.help.warning.text', '“Todo” puede ejecutar comandos, editar archivos y usar la red sin volver a preguntarte. Detener corta lo que sigue, pero no deshace acciones ya completadas; revisá el detalle en el panel lateral antes de aprobar algo sensible.'),
          },
        ],
      },
    ],
  };
}
