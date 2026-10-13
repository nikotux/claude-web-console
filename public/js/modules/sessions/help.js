// modules/sessions/help.js — contenido contextual de ayuda para Sesiones.
//
// Exporta una función para que todos los textos pasen por t() al abrir el tema
// y reflejen el idioma ya inicializado de la consola.
import { t } from '../../ui/i18n.js';

export default function sessionsHelp() {
  return {
    title: t('sessions.help.title', 'Sesiones'),
    icon: 'terminal',
    intro: t('sessions.help.intro', 'Sesiones es el radar del trabajo vivo: reúne conversaciones, terminales y trabajos en segundo plano. Cada tarjeta permite reconocer el estado y retomar el trabajo sin perder contexto.'),
    sections: [
      {
        title: t('sessions.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('sessions.help.first.step1', 'Buscá la tarjeta por su nombre, proyecto y modelo.'),
              t('sessions.help.first.step2', 'Mirá el Pac-Man para saber si está trabajando, delegando, esperando o dormida.'),
              t('sessions.help.first.step3', 'Tocá la tarjeta para abrirla o enfocar su pestaña si ya estaba abierta; si estaba archivada, se revive y abre.'),
              t('sessions.help.first.step4', 'Usá el contador desplegable de una conversación para revisar sus subagentes y trabajos en segundo plano.'),
            ],
          },
          {
            type: 'note',
            tone: 'info',
            text: t('sessions.help.first.otherUsers', 'Si sos administrador, las sesiones de otros usuarios aparecen agrupadas por dueño en una sección aparte que nace colapsada.'),
          },
        ],
      },
      {
        title: t('sessions.help.place.title', 'Lugar y tipo de tarjeta'),
        blocks: [
          {
            type: 'legend',
            items: [
              {
                icon: 'console',
                name: t('sessions.help.place.console.name', 'Mi Consola'),
                desc: t('sessions.help.place.console.desc', 'mini-ícono de lugar con acento: la sesión corre en Mi Consola'),
              },
              {
                icon: 'gitBranch',
                name: t('sessions.help.place.tolkien.name', 'Tolkien'),
                desc: t('sessions.help.place.tolkien.desc', 'mini-ícono de lugar tenue: la sesión corre en el Tolkien principal'),
              },
              {
                icon: 'isolated',
                name: t('sessions.help.place.isolated.name', 'Tolkien aislado'),
                desc: t('sessions.help.place.isolated.desc', 'azul frío: corre en un worktree efímero de Tolkien, con cambios y base de datos separados'),
              },
              {
                icon: 'relay',
                name: t('sessions.help.place.aduana.name', 'Aduana'),
                desc: t('sessions.help.place.aduana.desc', 'sala neutral compartida: ya no usa las herramientas del mundo de origen'),
              },
              {
                icon: 'sparkle',
                name: t('sessions.help.place.chat.name', 'Chat'),
                desc: t('sessions.help.place.chat.desc', 'conversación visual; el chip TUI y el ícono de terminal aparecen cuando cambia a Terminal'),
              },
            ],
          },
        ],
      },
      {
        title: t('sessions.help.folder.title', '📁 Carpetas'),
        blocks: [
          {
            type: 'p',
            text: t('sessions.help.folder.intro', 'Son agrupaciones que creás dentro de un mundo para juntar las conversaciones y terminales de un mismo trabajo. Son tuyas y privadas: otro usuario no las ve.'),
          },
          {
            type: 'legend',
            items: [
              {
                icon: 'folder',
                name: t('sessions.help.folder.create.name', 'Crear una carpeta'),
                desc: t('sessions.help.folder.create.desc', 'usá el botón de carpeta del encabezado del panel o el ＋ de cada mundo'),
              },
              {
                icon: 'more',
                name: t('sessions.help.folder.move.name', 'Meter o sacar algo'),
                desc: t('sessions.help.folder.move.desc', 'abrí el menú ⋯ de la tarjeta y elegí “Mover a carpeta…”; la opción “(ninguna)” la saca'),
              },
              {
                icon: 'folder',
                name: t('sessions.help.folder.drag.name', 'Arrastrar tarjetas'),
                desc: t('sessions.help.folder.drag.desc', 'dentro del mismo mundo, soltá una tarjeta sobre una carpeta para guardarla ahí —aunque esté plegada— o sobre el nombre del mundo para sacarla, sin confirmación. Una terminal solo se organiza así; nunca muda de mundo. En pantallas táctiles usá ⋯ → “Mover a carpeta…”'),
              },
              {
                icon: 'menu',
                name: t('sessions.help.folder.reorder.name', 'Reordenar tarjetas'),
                desc: t('sessions.help.folder.reorder.desc', 'arrastrá una tarjeta sobre otra: la línea indica dónde va a quedar. El orden es tuyo y se guarda; lo nuevo aparece al final sin desarmar lo que ya acomodaste'),
              },
              {
                icon: 'gitBranch',
                name: t('sessions.help.folder.dragWorld.name', 'Mudar una conversación'),
                desc: t('sessions.help.folder.dragWorld.desc', 'soltarla sobre el nombre de otro mundo válido o sobre 🛃 Aduana la muda y siempre pide confirmación: la mudanza no se deshace arrastrándola de vuelta'),
              },
              {
                icon: 'folder',
                name: t('sessions.help.folder.dragCrossFolder.name', 'Mudar y guardar'),
                desc: t('sessions.help.folder.dragCrossFolder.desc', 'soltar una conversación sobre una carpeta de otro mundo hace las dos cosas: después de confirmar y completar la mudanza, la guarda dentro de esa carpeta'),
              },
              {
                icon: 'chevronRight',
                name: t('sessions.help.folder.collapse.name', 'Plegar y desplegar'),
                desc: t('sessions.help.folder.collapse.desc', 'las carpetas recuerdan si quedaron abiertas o cerradas, igual que los mundos'),
              },
            ],
          },
          {
            type: 'note',
            tone: 'info',
            text: t('sessions.help.folder.dragBlocked', 'Si una zona de destino se ve apagada, no es válida para esa tarjeta; al soltarla ahí, la consola te explica el motivo.'),
          },
          {
            type: 'note',
            tone: 'warn',
            text: t('sessions.help.folder.warning', 'Borrar una carpeta NO borra ninguna conversación: sus elementos solo salen de ella. Un chat archivado se muestra en “Archivados” aunque tenga carpeta, y si mudás un chat a otro mundo, sale de la carpeta.'),
          },
        ],
      },
      {
        title: t('sessions.help.states.title', 'Estados del Pac-Man'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              {
                emoji: t('sessions.help.states.working.emoji', '🟡'),
                name: t('sessions.help.states.working.name', 'Trabajando'),
                desc: t('sessions.help.states.working.desc', 'dorado, mordisco rápido: un turno corriendo ahora'),
              },
              {
                icon: 'relay',
                name: t('sessions.help.states.delegating.name', 'Delegando'),
                desc: t('sessions.help.states.delegating.desc', 'violeta con el ícono del Interfono: esperando que vuelva un subagente (Task) u otro proceso'),
              },
              {
                emoji: t('sessions.help.states.waiting.emoji', '🟢'),
                name: t('sessions.help.states.waiting.name', 'Tu turno'),
                desc: t('sessions.help.states.waiting.desc', 'verde, parpadeo lento: esperando tu mensaje, permiso o decisión'),
              },
              {
                emoji: t('sessions.help.states.stale.emoji', '🟤'),
                name: t('sessions.help.states.stale.name', 'Sin señales'),
                desc: t('sessions.help.states.stale.desc', 'ámbar apagado y quieto: se perdió el rastro, no se sabe si sigue activo'),
              },
              {
                emoji: t('sessions.help.states.dormant.emoji', '⚪'),
                name: t('sessions.help.states.dormant.name', 'Dormido'),
                desc: t('sessions.help.states.dormant.desc', 'gris y quieto: no hay nada activo ni delegado'),
              },
            ],
          },
        ],
      },
      {
        title: t('sessions.help.header.title', 'Controles del panel'),
        blocks: [
          {
            type: 'legend',
            items: [
              {
                icon: 'relay',
                name: t('sessions.help.header.background.name', 'Trabajos en segundo plano'),
                desc: t('sessions.help.header.background.desc', 'abre el resumen global de subagentes, tareas y procesos del servidor; el número indica cuántos siguen vivos'),
              },
              {
                icon: 'refresh',
                name: t('sessions.help.header.refresh.name', 'Refrescar'),
                desc: t('sessions.help.header.refresh.desc', 'vuelve a consultar sesiones y trabajos; no inicia IA ni consume tokens'),
              },
              {
                icon: 'trash',
                name: t('sessions.help.header.trash.name', 'Papelera'),
                desc: t('sessions.help.header.trash.desc', 'muestra conversaciones cerradas por 30 días; permite Restaurar o Eliminar ya de forma irreversible'),
              },
              {
                icon: 'help',
                name: t('sessions.help.header.help.name', 'Ayuda'),
                desc: t('sessions.help.header.help.desc', 'abre esta guía sin refrescar ni modificar sesiones'),
              },
            ],
          },
        ],
      },
      {
        title: t('sessions.help.card.title', 'Controles de cada tarjeta'),
        blocks: [
          {
            type: 'legend',
            items: [
              {
                icon: 'sparkle',
                name: t('sessions.help.card.open.name', 'Tocar la tarjeta'),
                desc: t('sessions.help.card.open.desc', 'abre el chat o terminal, o enfoca su pestaña; una conversación archivada se revive y abre'),
              },
              {
                icon: 'chevronRight',
                name: t('sessions.help.card.jobs.name', 'Trabajos + número'),
                desc: t('sessions.help.card.jobs.desc', 'despliega u oculta los subagentes y trabajos en segundo plano de esa conversación'),
              },
              {
                icon: 'relay',
                name: t('sessions.help.card.intercom.name', 'Interfono + número'),
                desc: t('sessions.help.card.intercom.desc', 'abre los mensajes pendientes para Archivarlos o Entregarlos'),
              },
              {
                icon: 'more',
                name: t('sessions.help.card.options.name', 'Opciones'),
                desc: t('sessions.help.card.options.desc', 'abre el menú de acciones disponible para ese tipo y estado de tarjeta'),
              },
            ],
          },
        ],
      },
      {
        title: t('sessions.help.chatMenu.title', 'Opciones de una conversación'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              {
                icon: 'sparkle',
                name: t('sessions.help.chatMenu.open.name', 'Abrir / Pasar a Chat'),
                desc: t('sessions.help.chatMenu.open.desc', 'abre el Chat; desde TUI vuelve a la vista Chat sin perder la conversación'),
              },
              {
                icon: 'externalLink',
                name: t('sessions.help.chatMenu.popout.name', 'Abrir en ventana'),
                desc: t('sessions.help.chatMenu.popout.desc', 'desancla la conversación en una ventana propia sin paneles, para pantalla dividida; también con doble-click en la tarjeta. La conversación es la MISMA: sigue abierta acá y lo que escribas en cualquiera de las dos va al mismo turno.'),
              },
              {
                icon: 'terminal',
                name: t('sessions.help.chatMenu.tui.name', 'Pasar a TUI'),
                desc: t('sessions.help.chatMenu.tui.desc', 'cambia la conversación a Terminal y conserva su contexto'),
              },
              {
                icon: 'refresh',
                name: t('sessions.help.chatMenu.revive.name', 'Revivir / Reabrir para cambios'),
                desc: t('sessions.help.chatMenu.revive.desc', 'reactiva una archivada o reinicia su motor para tomar código nuevo; reabrir corta el turno si estaba trabajando'),
              },
              {
                icon: 'edit',
                name: t('sessions.help.chatMenu.rename.name', 'Renombrar'),
                desc: t('sessions.help.chatMenu.rename.desc', 'cambia solo el nombre visible de la conversación'),
              },
              {
                icon: 'sparkle',
                name: t('sessions.help.chatMenu.model.name', 'Cambiar modelo'),
                desc: t('sessions.help.chatMenu.model.desc', 'elige AutoTux, Tándem o Manual y sus esfuerzos; aplicar no dispara un turno ni consume tokens'),
              },
              {
                icon: 'gitBranch',
                name: t('sessions.help.chatMenu.world.name', 'Mover a otro mundo'),
                desc: t('sessions.help.chatMenu.world.desc', 'mueve la misma conversación, contexto, carpeta y paquete-sesión; podés dejar una tarea para el destino y la mudanza no consume tokens'),
              },
              {
                icon: 'relay',
                name: t('sessions.help.chatMenu.aduana.name', '🛃 Pasar a la Aduana'),
                desc: t('sessions.help.chatMenu.aduana.desc', 'muda el chat a una sala neutral en modo de permisos Preguntar y luego permite invitar participantes; la mudanza no consume tokens'),
              },
              {
                icon: 'folder',
                name: t('sessions.help.chatMenu.archive.name', 'Archivar'),
                desc: t('sessions.help.chatMenu.archive.desc', 'duerme la conversación y la deja revivible en Archivados; no la manda a la Papelera'),
              },
              {
                icon: 'folder',
                name: t('sessions.help.chatMenu.folder.name', 'Abrir carpeta del chat'),
                desc: t('sessions.help.chatMenu.folder.desc', 'abre la carpeta de trabajo propia de este chat en el Explorador'),
              },
              {
                icon: 'trash',
                name: t('sessions.help.chatMenu.close.name', 'Cerrar conversación'),
                desc: t('sessions.help.chatMenu.close.desc', 'la mueve a la Papelera por 30 días con su historial y los archivos de su paquete'),
              },
            ],
          },
        ],
      },
      {
        title: t('sessions.help.room.title', 'Salas e Interfono'),
        blocks: [
          {
            type: 'legend',
            items: [
              {
                icon: 'relay',
                name: t('sessions.help.room.invite.name', 'Invitar a la sala'),
                desc: t('sessions.help.room.invite.desc', 'el dueño o un administrador invita y revoca participantes; quienes entren ven todo el hilo y los adjuntos'),
              },
              {
                icon: 'close',
                name: t('sessions.help.room.leave.name', 'Salir de la sala'),
                desc: t('sessions.help.room.leave.desc', 'un participante abandona la sala y pierde acceso a la conversación'),
              },
              {
                emoji: t('sessions.help.room.subsala.emoji', '🛃'),
                name: t('sessions.help.room.subsala.name', 'Sub-sala'),
                desc: t('sessions.help.room.subsala.desc', 'aparece anidada bajo su sala madre; el chip de la madre pliega o despliega todas sus hijas'),
              },
              {
                emoji: t('sessions.help.room.eco.emoji', '📨'),
                name: t('sessions.help.room.eco.name', 'Aviso entre salas'),
                desc: t('sessions.help.room.eco.desc', 'conecta el hilo de una sala madre con el de una hija y cuenta como contenido pendiente para el próximo corte'),
              },
              {
                icon: 'close',
                name: t('sessions.help.room.dismiss.name', 'Archivar Interfono'),
                desc: t('sessions.help.room.dismiss.desc', 'marca los mensajes pendientes como tomados; no despierta el chat ni consume tokens'),
              },
              {
                icon: 'play',
                name: t('sessions.help.room.deliver.name', 'Entregar Interfono'),
                desc: t('sessions.help.room.deliver.desc', 'inyecta los mensajes como un turno nuevo, despierta el chat y SÍ consume tokens'),
              },
            ],
          },
          {
            type: 'note',
            tone: 'warn',
            text: t('sessions.help.room.tokens', 'En una sala, los mensajes entre personas no llaman a la IA. “Preguntar a la IA” sí ejecuta un turno y consume tokens de la credencial del dueño de la sala.'),
          },
          {
            type: 'p',
            text: t('sessions.help.room.badges', 'Los contadores de la tarjeta distinguen menciones y mensajes nuevos; un permiso pendiente tiene prioridad en el estado del Pac-Man.'),
          },
        ],
      },
      {
        title: t('sessions.help.tmux.title', 'Terminales tmux'),
        blocks: [
          {
            type: 'legend',
            items: [
              {
                icon: 'sparkle',
                name: t('sessions.help.tmux.toChat.name', 'Pasar a Chat'),
                desc: t('sessions.help.tmux.toChat.desc', 'si Claude corre en una terminal propia, lo cierra y continúa como Chat con la misma memoria; la terminal queda como shell'),
              },
              {
                icon: 'edit',
                name: t('sessions.help.tmux.rename.name', 'Renombrar'),
                desc: t('sessions.help.tmux.rename.desc', 'cambia el nombre visible de la sesión tmux'),
              },
              {
                icon: 'sparkle',
                name: t('sessions.help.tmux.model.name', 'Cambiar modelo'),
                desc: t('sessions.help.tmux.model.desc', 'envía /model a la terminal; solo tiene efecto si ahí corre Claude Code'),
              },
              {
                icon: 'trash',
                name: t('sessions.help.tmux.kill.name', 'Matar sesión'),
                desc: t('sessions.help.tmux.kill.desc', 'termina definitivamente la tmux y todo lo que esté corriendo adentro'),
              },
            ],
          },
          {
            type: 'note',
            tone: 'info',
            text: t('sessions.help.tmux.rehydrate', 'Tras un reinicio del servidor de la consola, las sesiones tmux propias que siguen vivas se rehidratan y reaparecen con su carpeta, dueño y nombre guardado. Las tmux externas quedan aparte en “Otras sesiones tmux”.'),
          },
        ],
      },
      {
        title: t('sessions.help.package.title', 'El paquete-sesión'),
        blocks: [
          {
            type: 'p',
            text: t('sessions.help.package.text', 'Cada conversación tiene un paquete-sesión con referencia estable PKG-N: reúne identidad, historial, contexto y su carpeta de archivos de trabajo. “Abrir carpeta del chat” muestra ese escritorio; al mover la conversación a otro mundo o a la Aduana, el paquete viaja con ella.'),
          },
          {
            type: 'note',
            tone: 'warn',
            text: t('sessions.help.package.warning', 'Cerrar conserva el paquete en la Papelera durante 30 días. “Eliminar ya” borra definitivamente historial y archivos; matar una tmux también interrumpe todo lo que corra adentro y puede afectar trabajo externo.'),
          },
        ],
      },
    ],
  };
}
