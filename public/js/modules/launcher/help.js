// modules/launcher/help.js — contenido contextual de ayuda para Nueva sesión.
//
// Exporta una función para evaluar todos los textos al abrir el tema, una vez
// que la consola ya inicializó el idioma elegido.
import { t } from '../../ui/i18n.js';

export default function launcherHelp() {
  return {
    title: t('launcher.help.title', 'Nueva sesión'),
    icon: 'plus',
    intro: t('launcher.help.intro', 'Nueva sesión es la puerta para empezar trabajo. Podés abrir un Chat, Claude en terminal, una terminal común o una Sala neutral de Aduana, y la consola deja la nueva sesión lista para usar.'),
    sections: [
      {
        title: t('launcher.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('launcher.help.first.step1', 'Tocá “Nueva sesión”.'),
              t('launcher.help.first.step2', 'Elegí Chat, Claude TUI, Terminal o 🛃 Sala según cómo quieras trabajar.'),
              t('launcher.help.first.step3', 'Para Chat, Claude TUI o Terminal, elegí Tolkien, Mi Consola (o Mi espacio) u Otra carpeta. Sala no pide destino.'),
              t('launcher.help.first.step4', 'Si corresponde, elegí el modelo que va a usar Claude; una Terminal común no muestra este selector.'),
              t('launcher.help.first.step5', 'Tocá “Iniciar en…” para crear y abrir la sesión.'),
            ],
          },
        ],
      },
      {
        title: t('launcher.help.legend.title', 'Leyenda'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              {
                icon: 'plus',
                name: t('launcher.help.legend.plus.name', 'Nueva sesión'),
                desc: t('launcher.help.legend.plus.desc', 'abre el lanzador'),
              },
              {
                icon: 'sparkle',
                name: t('launcher.help.legend.chat.name', 'Chat'),
                desc: t('launcher.help.legend.chat.desc', 'conversación visual con el asistente'),
              },
              {
                icon: 'keyboard',
                name: t('launcher.help.legend.tui.name', 'Claude TUI'),
                desc: t('launcher.help.legend.tui.desc', 'Claude Code completo dentro de una terminal'),
              },
              {
                icon: 'terminal',
                name: t('launcher.help.legend.terminal.name', 'Terminal'),
                desc: t('launcher.help.legend.terminal.desc', 'shell común, sin asistente iniciado'),
              },
              {
                icon: 'relay',
                name: t('launcher.help.legend.sala.name', '🛃 Sala'),
                desc: t('launcher.help.legend.sala.desc', 'Chat neutral de Aduana, sin elegir una carpeta propia'),
              },
              {
                icon: 'gitBranch',
                name: t('launcher.help.legend.tolkien.name', 'Tolkien'),
                desc: t('launcher.help.legend.tolkien.desc', 'abre en el proyecto Tolkien'),
              },
              {
                icon: 'console',
                name: t('launcher.help.legend.console.name', 'Mi Consola'),
                desc: t('launcher.help.legend.console.desc', 'atajo canónico al proyecto de esta consola, con identidad e ícono propios'),
              },
              {
                icon: 'home',
                name: t('launcher.help.legend.mySpace.name', 'Mi espacio'),
                desc: t('launcher.help.legend.mySpace.desc', 'destino aislado que reemplaza a Mi Consola para un inquilino no administrador'),
              },
              {
                icon: 'folder',
                name: t('launcher.help.legend.folder.name', 'Otra carpeta'),
                desc: t('launcher.help.legend.folder.desc', 'abre el navegador de carpetas'),
              },
              {
                icon: 'home',
                name: t('launcher.help.legend.home.name', 'Inicio'),
                desc: t('launcher.help.legend.home.desc', 'vuelve al comienzo del navegador de carpetas'),
              },
              {
                icon: 'chevronRight',
                name: t('launcher.help.legend.crumb.name', 'Separador'),
                desc: t('launcher.help.legend.crumb.desc', 'marca cada nivel de la ruta'),
              },
              {
                icon: 'chevronLeft',
                name: t('launcher.help.legend.back.name', 'Volver'),
                desc: t('launcher.help.legend.back.desc', 'regresa a los proyectos conocidos'),
              },
              {
                icon: 'play',
                name: t('launcher.help.legend.start.name', 'Iniciar'),
                desc: t('launcher.help.legend.start.desc', 'crea la sesión en el destino elegido'),
              },
              {
                icon: 'help',
                name: t('launcher.help.legend.help.name', 'Ayuda'),
                desc: t('launcher.help.legend.help.desc', 'abre esta explicación'),
              },
              {
                icon: 'close',
                name: t('launcher.help.legend.close.name', 'Cerrar'),
                desc: t('launcher.help.legend.close.desc', 'cierra el lanzador sin crear nada'),
              },
            ],
          },
        ],
      },
      {
        title: t('launcher.help.actions.title', 'Botones y acciones'),
        wide: true,
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('launcher.help.actions.open.k', 'Nueva sesión'),
                v: t('launcher.help.actions.open.v', 'Abre el lanzador; todavía no crea procesos ni consume tokens.'),
              },
              {
                k: t('launcher.help.actions.chat.k', 'Chat'),
                v: t('launcher.help.actions.chat.v', 'Crea una conversación con historial, permisos y herramientas. Consume tokens cuando enviás un mensaje.'),
              },
              {
                k: t('launcher.help.actions.tui.k', 'Claude TUI'),
                v: t('launcher.help.actions.tui.v', 'Inicia Claude Code dentro de tmux. Los pedidos que escribas ahí consumen tokens.'),
              },
              {
                k: t('launcher.help.actions.terminal.k', 'Terminal'),
                v: t('launcher.help.actions.terminal.v', 'Abre un shell sin modelo ni runner de IA; los comandos corren directamente en el servidor.'),
              },
              {
                k: t('launcher.help.actions.sala.k', '🛃 Sala'),
                v: t('launcher.help.actions.sala.v', 'Crea un Chat neutral de Aduana sin elegir carpeta. Los mensajes que envíes y sus respuestas consumen tokens.'),
              },
              {
                k: t('launcher.help.actions.tolkien.k', 'Tolkien'),
                v: t('launcher.help.actions.tolkien.v', 'Selecciona la carpeta del proyecto Tolkien.'),
              },
              {
                k: t('launcher.help.actions.console.k', 'Mi Consola'),
                v: t('launcher.help.actions.console.v', 'Selecciona la carpeta canónica del proyecto de la consola para host y administradores.'),
              },
              {
                k: t('launcher.help.actions.mySpace.k', 'Mi espacio'),
                v: t('launcher.help.actions.mySpace.v', 'Selecciona el espacio aislado del usuario cuando quien entra es un inquilino no administrador.'),
              },
              {
                k: t('launcher.help.actions.other.k', 'Otra carpeta'),
                v: t('launcher.help.actions.other.v', 'Permite recorrer directorios; la carpeta que estás viendo queda seleccionada.'),
              },
              {
                k: t('launcher.help.actions.back.k', 'Volver a proyectos'),
                v: t('launcher.help.actions.back.v', 'Sale del navegador y vuelve a los destinos conocidos.'),
              },
              {
                k: t('launcher.help.actions.breadcrumb.k', 'Ruta y carpetas'),
                v: t('launcher.help.actions.breadcrumb.v', 'Tocá un nivel de la ruta para volver o una carpeta para entrar y seleccionarla.'),
              },
              {
                k: t('launcher.help.actions.model.k', 'Modelo'),
                v: t('launcher.help.actions.model.v', 'Elige el modelo para Chat, Claude TUI o Sala. Las opciones cambian según el tipo y el selector no aparece en una Terminal común.'),
              },
              {
                k: t('launcher.help.actions.start.k', 'Iniciar en…'),
                v: t('launcher.help.actions.start.v', 'Crea y enfoca la sesión; se habilita después de elegir un destino.'),
              },
              {
                k: t('launcher.help.actions.help.k', '?'),
                v: t('launcher.help.actions.help.v', 'Abre esta ayuda sin cerrar el lanzador.'),
              },
              {
                k: t('launcher.help.actions.close.k', '×'),
                v: t('launcher.help.actions.close.v', 'Cierra el lanzador y descarta la selección actual.'),
              },
            ],
          },
        ],
      },
      {
        title: t('launcher.help.destinations.title', 'Destinos y carpetas'),
        blocks: [
          {
            type: 'note',
            tone: 'info',
            text: t('launcher.help.destinations.text', 'La lista actual no muestra carpetas recientes: ofrece Tolkien, el lugar propio (Mi Consola o Mi espacio) y Otra carpeta. En el navegador, la carpeta que estás viendo queda seleccionada; podés iniciar ahí aunque no tenga subcarpetas.'),
          },
        ],
      },
      {
        title: t('launcher.help.permissions.title', 'Modo de permisos del Chat'),
        blocks: [
          {
            type: 'p',
            text: t('launcher.help.permissions.intro', 'El lanzador actual no muestra este selector: el Chat nace en “Todo” y podés cambiarlo desde la cabecera de la conversación.'),
          },
          {
            type: 'kv',
            items: [
              {
                k: t('launcher.help.permissions.ask.k', 'Preguntar'),
                v: t('launcher.help.permissions.ask.v', 'Pide confirmación antes de usar herramientas sensibles; es la opción controlada.'),
              },
              {
                k: t('launcher.help.permissions.edits.k', 'Ediciones'),
                v: t('launcher.help.permissions.edits.v', 'Acepta ediciones de archivos con menos interrupciones; revisá el alcance del pedido.'),
              },
              {
                k: t('launcher.help.permissions.all.k', 'Todo'),
                v: t('launcher.help.permissions.all.v', 'Acepta todas las herramientas sin preguntar; es el modo de mayor riesgo.'),
              },
              {
                k: t('launcher.help.permissions.plan.k', 'Plan'),
                v: t('launcher.help.permissions.plan.v', 'Deja razonar y proponer sin ejecutar cambios.'),
              },
            ],
          },
        ],
      },
      {
        title: t('launcher.help.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'danger',
            text: t('launcher.help.warning.text', 'El lanzador actual crea los Chats y Claude TUI en modo “Todo”: pueden ejecutar herramientas o comandos sin pedir permiso. En Chat podés cambiar el modo desde la cabecera apenas abre; en Claude TUI, revisá cada orden antes de enviarla.'),
          },
        ],
      },
    ],
  };
}
