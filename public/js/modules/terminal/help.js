// modules/terminal/help.js — contenido contextual de ayuda para Terminal.
//
// Exporta una función para que los textos respeten el idioma activo cuando
// el tema se carga bajo demanda desde la guía.
import { t } from '../../ui/i18n.js';

export default function terminalHelp() {
  return {
    title: t('terminal.help.title', 'Terminal'),
    icon: 'terminal',
    intro: t('terminal.help.intro', 'Terminal es una consola real del servidor dentro del navegador. Cada pestaña se apoya en tmux, así que podés salir y volver sin cortar lo que quedó corriendo.'),
    sections: [
      {
        title: t('terminal.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('terminal.help.first.step1', 'Abrí “Nueva sesión” y elegí Claude TUI o Terminal.'),
              t('terminal.help.first.step2', 'Elegí el proyecto o la carpeta donde querés trabajar.'),
              t('terminal.help.first.step3', 'Escribí comandos como en cualquier terminal; en Claude TUI, escribí tus pedidos para el asistente.'),
              t('terminal.help.first.step4', 'Cambiá de pestaña tocando una tarjeta de Sesiones o un chip del rail angosto.'),
              t('terminal.help.first.step5', 'En el celular, desplegá la barra ⌨ para usar Esc, Tab, Ctrl, flechas, pegar o dictar.'),
            ],
          },
        ],
      },
      {
        title: t('terminal.help.legend.title', 'Leyenda'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              {
                icon: 'terminal',
                name: t('terminal.help.legend.terminal.name', 'Terminal con Claude'),
                desc: t('terminal.help.legend.terminal.desc', 'el rail detectó un modelo de Claude dentro de la sesión'),
              },
              {
                icon: 'ghost',
                name: t('terminal.help.legend.shell.name', 'Shell'),
                desc: t('terminal.help.legend.shell.desc', 'terminal común sin Claude detectado'),
              },
              {
                icon: 'sparkle',
                name: t('terminal.help.legend.chat.name', 'Chat'),
                desc: t('terminal.help.legend.chat.desc', 'conversación visual; puede alternar a TUI sin cambiar de sesión'),
              },
              {
                emoji: t('terminal.help.legend.working.emoji', '🟡'),
                name: t('terminal.help.legend.working.name', 'Trabajando'),
                desc: t('terminal.help.legend.working.desc', 'punto animado: la sesión está produciendo actividad'),
              },
              {
                emoji: t('terminal.help.legend.waiting.emoji', '🟢'),
                name: t('terminal.help.legend.waiting.name', 'Esperando'),
                desc: t('terminal.help.legend.waiting.desc', 'punto verde: la sesión espera tu entrada'),
              },
              {
                emoji: t('terminal.help.legend.idle.emoji', '⚪'),
                name: t('terminal.help.legend.idle.name', 'En reposo'),
                desc: t('terminal.help.legend.idle.desc', 'punto tenue: no hay trabajo activo detectado'),
              },
              {
                emoji: t('terminal.help.legend.close.emoji', '×'),
                name: t('terminal.help.legend.close.name', 'Cerrar pestaña'),
                desc: t('terminal.help.legend.close.desc', 'quita la vista del navegador, pero no mata la sesión tmux'),
              },
            ],
          },
        ],
      },
      {
        title: t('terminal.help.actions.title', 'Botones y acciones'),
        wide: true,
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('terminal.help.actions.input.k', 'Teclado'),
                v: t('terminal.help.actions.input.v', 'Todo lo que tipeás se envía al proceso real del servidor. Un pedido a Claude TUI consume tokens.'),
              },
              {
                k: t('terminal.help.actions.link.k', 'Enlaces'),
                v: t('terminal.help.actions.link.v', 'Los enlaces reconocidos en la salida se pueden tocar o hacer clic.'),
              },
              {
                k: t('terminal.help.actions.paste.k', 'Clic derecho'),
                v: t('terminal.help.actions.paste.v', 'Intenta pegar el texto del portapapeles en la terminal.'),
              },
              {
                k: t('terminal.help.actions.scroll.k', 'Arrastrar con un dedo'),
                v: t('terminal.help.actions.scroll.v', 'Recorre el historial; si la aplicación captura el mouse, envía rueda a ese programa.'),
              },
              {
                k: t('terminal.help.actions.card.k', 'Tarjeta de Sesiones'),
                v: t('terminal.help.actions.card.v', 'Abre la terminal o enfoca su pestaña si ya está visible.'),
              },
              {
                k: t('terminal.help.actions.chip.k', 'Chip del rail'),
                v: t('terminal.help.actions.chip.v', 'Cambia de pestaña cuando la barra derecha está contraída en escritorio.'),
              },
              {
                k: t('terminal.help.actions.close.k', '×'),
                v: t('terminal.help.actions.close.v', 'Cierra solo la pestaña local. La sesión sigue viva para retomarla desde Sesiones.'),
              },
              {
                k: t('terminal.help.actions.aux.k', '⌨ Barra móvil'),
                v: t('terminal.help.actions.aux.v', 'Despliega Esc, Tab, ⇧Tab, Ctrl, flechas, ^C, /, pegar y dictado para una Terminal o TUI.'),
              },
            ],
          },
        ],
      },
      {
        title: t('terminal.help.compare.title', 'Cuándo usar cada una'),
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('terminal.help.compare.chat.k', 'Chat'),
                v: t('terminal.help.compare.chat.v', 'Conviene para conversar, revisar herramientas y permisos, adjuntar archivos y leer el historial con formato.'),
              },
              {
                k: t('terminal.help.compare.tui.k', 'Claude TUI'),
                v: t('terminal.help.compare.tui.v', 'Conviene si necesitás la interfaz completa de Claude Code, sus comandos slash o un flujo interactivo de terminal. Consume tokens al responder pedidos.'),
              },
              {
                k: t('terminal.help.compare.shell.k', 'Terminal'),
                v: t('terminal.help.compare.shell.v', 'Conviene para shell, logs y programas interactivos. No usa IA salvo que vos inicies una dentro.'),
              },
            ],
          },
        ],
      },
      {
        title: t('terminal.help.persistence.title', 'Por qué sobrevive'),
        blocks: [
          {
            type: 'p',
            text: t('terminal.help.persistence.text', 'La pestaña es solo una ventana hacia una sesión tmux que vive en el servidor. Cerrar el navegador corta esa ventana, no el proceso; si la consola web reinicia, vuelve a detectar las sesiones propias y se adjunta otra vez.'),
          },
        ],
      },
      {
        title: t('terminal.help.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'danger',
            text: t('terminal.help.warning.text', '“Matar sesión” desde el menú ⋯ termina tmux y todo lo que corre adentro. Claude TUI arranca sin pedir permisos, y una Terminal ejecuta los comandos tal como los escribís. La persistencia cubre cerrar el navegador o reiniciar la consola web, no reiniciar la máquina.'),
          },
        ],
      },
    ],
  };
}
