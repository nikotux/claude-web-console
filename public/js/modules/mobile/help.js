// modules/mobile/help.js — contenido de ayuda para navegación y barra móvil.
//
// Se descubre desde la Guía de la consola: la barra auxiliar no tiene una
// cabecera propia donde sumar un botón sin forzar el diseño.
import { t } from '../../ui/i18n.js';

export default function mobileHelp() {
  return {
    title: t('mobile.help.title', 'Barra móvil'),
    icon: 'menu',
    intro: t('mobile.help.intro', 'La barra móvil pone a mano las teclas que suelen faltar en el teclado del celular. También abre los dos paneles laterales para que puedas moverte por toda la consola sin salir de la sesión.'),
    sections: [
      {
        title: t('mobile.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('mobile.help.first.step1', 'Abrí una Terminal o una conversación en modo TUI; la barra no aparece en el Chat visual.'),
              t('mobile.help.first.step2', 'Tocá el tirador ⌨ para desplegar las teclas auxiliares.'),
              t('mobile.help.first.step3', 'Usá las teclas, pegá o abrí “abc” para dictar y enviar texto.'),
              t('mobile.help.first.step4', 'Tocá el asa izquierda para abrir los módulos o la derecha para abrir Sesiones.'),
              t('mobile.help.first.step5', 'Elegí una sesión o una acción y tocá fuera del drawer para volver al contenido.'),
            ],
          },
        ],
      },
      {
        title: t('mobile.help.legend.title', 'Leyenda'),
        blocks: [
          {
            type: 'legend',
            items: [
              {
                icon: 'keyboard',
                name: t('mobile.help.legend.keyboard.name', 'Tirador de teclado'),
                desc: t('mobile.help.legend.keyboard.desc', 'despliega u oculta la barra auxiliar'),
              },
              {
                icon: 'menu',
                name: t('mobile.help.legend.modules.name', 'Asa izquierda'),
                desc: t('mobile.help.legend.modules.desc', 'abre los módulos y paneles de control'),
              },
              {
                icon: 'sparkle',
                name: t('mobile.help.legend.sessions.name', 'Asa derecha'),
                desc: t('mobile.help.legend.sessions.desc', 'abre Sesiones y Nueva sesión'),
              },
              {
                icon: 'clipboard',
                name: t('mobile.help.legend.clipboard.name', 'Portapapeles'),
                desc: t('mobile.help.legend.clipboard.desc', 'pega texto en la terminal activa'),
              },
              {
                icon: 'keyboard',
                name: t('mobile.help.legend.active.name', 'Control resaltado'),
                desc: t('mobile.help.legend.active.desc', 'el borde y texto de acento indican que Ctrl, abc o Enter quedaron activos'),
              },
            ],
          },
        ],
      },
      {
        title: t('mobile.help.actions.title', 'Botones y acciones'),
        wide: true,
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('mobile.help.actions.handle.k', '⌨'),
                v: t('mobile.help.actions.handle.v', 'Muestra u oculta la fila de teclas y vuelve a enfocar la terminal al abrirla.'),
              },
              {
                k: t('mobile.help.actions.menu.k', '☰'),
                v: t('mobile.help.actions.menu.v', 'Abre el drawer izquierdo de módulos.'),
              },
              {
                k: t('mobile.help.actions.esc.k', 'Esc'),
                v: t('mobile.help.actions.esc.v', 'Cancela o sale del modo actual de la aplicación que corre en la terminal.'),
              },
              {
                k: t('mobile.help.actions.tab.k', 'Tab'),
                v: t('mobile.help.actions.tab.v', 'Envía Tab: completa comandos o avanza al siguiente campo.'),
              },
              {
                k: t('mobile.help.actions.shiftTab.k', '⇧Tab'),
                v: t('mobile.help.actions.shiftTab.v', 'Envía Shift+Tab: retrocede entre campos o cambia de modo si la aplicación lo usa.'),
              },
              {
                k: t('mobile.help.actions.ctrl.k', 'Ctrl'),
                v: t('mobile.help.actions.ctrl.v', 'Queda armado: el próximo carácter se envía como Ctrl+carácter y luego se apaga solo.'),
              },
              {
                k: t('mobile.help.actions.up.k', '↑'),
                v: t('mobile.help.actions.up.v', 'Envía flecha arriba.'),
              },
              {
                k: t('mobile.help.actions.down.k', '↓'),
                v: t('mobile.help.actions.down.v', 'Envía flecha abajo.'),
              },
              {
                k: t('mobile.help.actions.left.k', '←'),
                v: t('mobile.help.actions.left.v', 'Envía flecha izquierda.'),
              },
              {
                k: t('mobile.help.actions.right.k', '→'),
                v: t('mobile.help.actions.right.v', 'Envía flecha derecha.'),
              },
              {
                k: t('mobile.help.actions.ctrlC.k', '^C'),
                v: t('mobile.help.actions.ctrlC.v', 'Envía Ctrl+C para interrumpir el proceso que está en primer plano.'),
              },
              {
                k: t('mobile.help.actions.slash.k', '/'),
                v: t('mobile.help.actions.slash.v', 'Escribe una barra; en una TUI sirve para empezar comandos slash.'),
              },
              {
                k: t('mobile.help.actions.paste.k', 'Portapapeles'),
                v: t('mobile.help.actions.paste.v', 'Lee y pega el portapapeles con permiso del navegador.'),
              },
              {
                k: t('mobile.help.actions.dictate.k', 'abc'),
                v: t('mobile.help.actions.dictate.v', 'Abre o cierra el campo normal de texto y dictado.'),
              },
              {
                k: t('mobile.help.actions.input.k', 'Campo de dictado'),
                v: t('mobile.help.actions.input.v', 'Recibe texto escrito o dictado antes de enviarlo a la terminal.'),
              },
              {
                k: t('mobile.help.actions.enter.k', '⏎'),
                v: t('mobile.help.actions.enter.v', 'Activo agrega Enter al envío; apagado pega el texto sin ejecutarlo.'),
              },
              {
                k: t('mobile.help.actions.send.k', 'Enviar'),
                v: t('mobile.help.actions.send.v', 'Manda el texto a la terminal. En una TUI, enviar un pedido con Enter puede disparar una respuesta que consume tokens.'),
              },
              {
                k: t('mobile.help.actions.leftHandle.k', 'Asa izquierda'),
                v: t('mobile.help.actions.leftHandle.v', 'Abre Tickets, Pendientes, Mejora Continua y los accesos del pie.'),
              },
              {
                k: t('mobile.help.actions.rightHandle.k', 'Asa derecha'),
                v: t('mobile.help.actions.rightHandle.v', 'Abre Nueva sesión, Sesiones, Tolkien y el estado del servidor.'),
              },
            ],
          },
        ],
      },
      {
        title: t('mobile.help.navigation.title', 'Navegar desde el celular'),
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('mobile.help.navigation.left.k', 'Drawer izquierdo'),
                v: t('mobile.help.navigation.left.v', 'Usalo para entrar a módulos, tableros y herramientas generales.'),
              },
              {
                k: t('mobile.help.navigation.right.k', 'Drawer derecho'),
                v: t('mobile.help.navigation.right.v', 'Usalo para crear una sesión, revisar estados y cambiar a otra conversación o terminal.'),
              },
              {
                k: t('mobile.help.navigation.close.k', 'Tocar afuera'),
                v: t('mobile.help.navigation.close.v', 'Cierra el drawer abierto y devuelve el foco al área central.'),
              },
            ],
          },
        ],
      },
      {
        title: t('mobile.help.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'warn',
            text: t('mobile.help.warning.text', '^C interrumpe el proceso activo. Pegar o dictar con ⏎ encendido agrega Enter, así que puede ejecutar un comando o enviar un pedido a Claude de inmediato; apagalo si primero querés revisar el texto.'),
          },
        ],
      },
    ],
  };
}
