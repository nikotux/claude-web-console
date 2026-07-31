// modules/system/help/interfono.js — ayuda contextual del Interfono.
import { t } from '../../../ui/i18n.js';

export default function interfonoHelp() {
  return {
    title: t('system.help.interfono.title', 'Interfono'),
    icon: 'terminal',
    intro: t('system.help.interfono.intro', 'El Interfono muestra cómo se coordinan las sesiones y te deja mandarles mensajes manuales. Un administrador ve todas y puede hacer broadcast o liberar claims; el resto ve y contacta únicamente sus propias sesiones.'),
    sections: [
      {
        title: t('system.help.interfono.first.title', 'Primeros pasos'),
        blocks: [{
          type: 'steps',
          items: [
            t('system.help.interfono.first.step1', 'Elegí una sesión concreta en el selector. Si sos administrador, también podés elegir Todas para hacer broadcast.'),
            t('system.help.interfono.first.step2', 'Escribí el mensaje y, si corresponde, agregá un paquete PKG-N.'),
            t('system.help.interfono.first.step3', 'Tocá Enviar y comprobá el resultado junto al botón.'),
            t('system.help.interfono.first.step4', 'Abrí Reservas de archivo antes de tocar un archivo compartido.'),
            t('system.help.interfono.first.step5', 'Usá Mensajes recientes y Bitácora de entrega para confirmar qué pasó.'),
          ],
        }],
      },
      {
        title: t('system.help.interfono.legend.title', 'Leyenda'),
        wide: true,
        blocks: [{
          type: 'legend',
          items: [
            { emoji: t('system.help.interfono.legend.red.emoji', '🔴'), name: t('system.help.interfono.legend.red.name', 'Editando / trabajando'), desc: t('system.help.interfono.legend.red.desc', 'claim de menos de 5 minutos o sesión activa: bloquea la edición ajena') },
            { emoji: t('system.help.interfono.legend.yellow.emoji', '🟡'), name: t('system.help.interfono.legend.yellow.name', 'Inactiva'), desc: t('system.help.interfono.legend.yellow.desc', 'la sesión conserva el claim pero lleva entre 5 y 30 minutos sin editar') },
            { emoji: t('system.help.interfono.legend.green.emoji', '🟢'), name: t('system.help.interfono.legend.green.name', 'Liberable'), desc: t('system.help.interfono.legend.green.desc', 'sesión terminada, tmux caída o claim vencido después de 30 minutos') },
            { emoji: t('system.help.interfono.legend.chat.emoji', '💬'), name: t('system.help.interfono.legend.chat.name', 'Chat'), desc: t('system.help.interfono.legend.chat.desc', 'sesión de conversación web o TUI de chat') },
            { emoji: t('system.help.interfono.legend.tui.emoji', '🖥️'), name: t('system.help.interfono.legend.tui.name', 'TUI'), desc: t('system.help.interfono.legend.tui.desc', 'sesión interactiva en terminal') },
            { emoji: t('system.help.interfono.legend.console.emoji', '🏠'), name: t('system.help.interfono.legend.console.name', 'Mi Consola'), desc: t('system.help.interfono.legend.console.desc', 'mundo de esta consola') },
            { emoji: t('system.help.interfono.legend.tolkien.emoji', '🌳'), name: t('system.help.interfono.legend.tolkien.name', 'Tolkien'), desc: t('system.help.interfono.legend.tolkien.desc', 'mundo del proyecto Tolkien') },
            { emoji: t('system.help.interfono.legend.package.emoji', '📦'), name: t('system.help.interfono.legend.package.name', 'Paquete'), desc: t('system.help.interfono.legend.package.desc', 'referencia PKG-N transferida con el mensaje o sesión archivada') },
            { emoji: t('system.help.interfono.legend.auto.emoji', '📨'), name: t('system.help.interfono.legend.auto.name', 'Auto-entregado'), desc: t('system.help.interfono.legend.auto.desc', 'el backend inyectó el mensaje en un chat abierto y ocioso') },
            { emoji: t('system.help.interfono.legend.badge.emoji', '🔔'), name: t('system.help.interfono.legend.badge.name', 'Badge'), desc: t('system.help.interfono.legend.badge.desc', 'el mensaje quedó como señal pasiva para esa sesión') },
            { emoji: t('system.help.interfono.legend.hook.emoji', '🪝'), name: t('system.help.interfono.legend.hook.name', 'Inyectado'), desc: t('system.help.interfono.legend.hook.desc', 'un hook lo entregó al iniciar un turno') },
            { emoji: t('system.help.interfono.legend.expired.emoji', '⌛'), name: t('system.help.interfono.legend.expired.name', 'Vencido'), desc: t('system.help.interfono.legend.expired.desc', 'el mensaje caducó antes de ser consumido') },
          ],
        }],
      },
      {
        title: t('system.help.interfono.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [{
          type: 'kv',
          items: [
            { k: t('system.help.interfono.buttons.target.k', 'Selector de sesión'), v: t('system.help.interfono.buttons.target.v', 'Elige una de tus sesiones; el broadcast a Todas aparece solo para administradores.') },
            { k: t('system.help.interfono.buttons.message.k', 'Mensaje'), v: t('system.help.interfono.buttons.message.v', 'Texto manual que se entrega por el bus persistido. No consume tokens por sí solo.') },
            { k: t('system.help.interfono.buttons.package.k', 'Paquete PKG-N'), v: t('system.help.interfono.buttons.package.v', 'Adjunta una referencia estable de paquete-sesión al mensaje.') },
            { k: t('system.help.interfono.buttons.send.k', 'Enviar'), v: t('system.help.interfono.buttons.send.v', 'Escribe el mensaje en el bus para la sesión elegida; no lanza IA desde este panel.') },
            { k: t('system.help.interfono.buttons.refresh.k', 'Refrescar'), v: t('system.help.interfono.buttons.refresh.v', 'Vuelve a leer directorio, mensajes, claims y bitácora. El panel también actualiza solo cada 5 segundos.') },
            { k: t('system.help.interfono.buttons.release.k', 'Liberar'), v: t('system.help.interfono.buttons.release.v', 'Libera manualmente una reserva zombi o vencida. Admin-only; verificá el semáforo antes.') },
            { k: t('system.help.interfono.buttons.groups.k', 'Secciones desplegables'), v: t('system.help.interfono.buttons.groups.v', 'Abren sesiones activas, claims, mensajes y la bitácora sin cambiar el bus. La bitácora distingue mensajes note de avisos heads-up enviados con /btw --kind.') },
          ],
        }],
      },
      {
        title: t('system.help.interfono.warning.title', 'Ojo con esto'),
        blocks: [{
          type: 'note',
          tone: 'warn',
          text: t('system.help.interfono.warning.text', 'No liberes un claim rojo: indica edición reciente o trabajo activo y podrías provocar una colisión. Amarillo es una zona de duda; coordiná primero. Verde significa que la sesión terminó, la tmux cayó o el claim venció y ya puede recuperarse.'),
        }],
      },
    ],
  };
}
