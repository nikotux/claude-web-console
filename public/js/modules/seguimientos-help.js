// modules/seguimientos-help.js — ayuda contextual del dashboard Seguimientos.
//
// Se construye al abrir para respetar el idioma activo de la consola.
import { t } from '../ui/i18n.js';

export default function seguimientosHelp() {
  return {
    title: t('seguimientos.help.title', 'Seguimientos'),
    icon: 'list',
    intro: t('seguimientos.help.intro', 'Seguimientos ordena el trabajo que necesita una acción humana: decisiones, respuestas, aprobaciones y próximos pasos. La pantalla siempre lee una copia guardada en disco, nunca consulta Zoho en vivo mientras la mirás.'),
    sections: [
      {
        title: t('seguimientos.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('seguimientos.help.first.step1', 'Leé el Resumen del día para ubicar vencidos, trabados y cambios desde tu última visita.'),
              t('seguimientos.help.first.step2', 'Ordená o filtrá Tickets Niko y abrí una fila para revisar su detalle.'),
              t('seguimientos.help.first.step3', 'Marcá los tickets que querés tratar con las casillas de la tabla.'),
              t('seguimientos.help.first.step4', 'Revisá vencimientos y reuniones en el Calendario; cada punto abre el detalle del día.'),
              t('seguimientos.help.first.step5', 'Usá Actualizaciones, Trabajar seleccionados o Standup cuando quieras abrir una sesión con ese contexto.'),
            ],
          },
        ],
      },
      {
        title: t('seguimientos.help.legend.title', 'Leyenda'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              {
                emoji: t('seguimientos.help.legend.home.emoji', '🏠'),
                name: t('seguimientos.help.legend.home.name', 'Casa'),
                desc: t('seguimientos.help.legend.home.desc', 'frente de la vida personal'),
              },
              {
                emoji: t('seguimientos.help.legend.office.emoji', '🏢'),
                name: t('seguimientos.help.legend.office.name', 'Oficina'),
                desc: t('seguimientos.help.legend.office.desc', 'frente de trabajo'),
              },
              {
                emoji: t('seguimientos.help.legend.vendor.emoji', '🔴'),
                name: t('seguimientos.help.legend.vendor.name', 'Proveedor'),
                desc: t('seguimientos.help.legend.vendor.desc', 'la pelota está del lado de un proveedor'),
              },
              {
                emoji: t('seguimientos.help.legend.approval.emoji', '🟠'),
                name: t('seguimientos.help.legend.approval.name', 'Aprobación'),
                desc: t('seguimientos.help.legend.approval.desc', 'hay una aprobación humana pendiente'),
              },
              {
                emoji: t('seguimientos.help.legend.decision.emoji', '🟡'),
                name: t('seguimientos.help.legend.decision.name', 'Decisión M/C'),
                desc: t('seguimientos.help.legend.decision.desc', 'espera una decisión de Mark o Chris'),
              },
              {
                emoji: t('seguimientos.help.legend.mine.emoji', '✅'),
                name: t('seguimientos.help.legend.mine.name', 'Mío'),
                desc: t('seguimientos.help.legend.mine.desc', 'la próxima acción te corresponde'),
              },
              {
                emoji: t('seguimientos.help.legend.unassigned.emoji', '⚪'),
                name: t('seguimientos.help.legend.unassigned.name', 'Sin tipo'),
                desc: t('seguimientos.help.legend.unassigned.desc', 'el snapshot todavía no asignó una categoría de pelota'),
              },
              {
                emoji: t('seguimientos.help.legend.ticket.emoji', '🟤'),
                name: t('seguimientos.help.legend.ticket.name', 'Punto cálido'),
                desc: t('seguimientos.help.legend.ticket.desc', 'vencimiento de un ticket tomado del snapshot de Zoho'),
              },
              {
                emoji: t('seguimientos.help.legend.meeting.emoji', '🔵'),
                name: t('seguimientos.help.legend.meeting.name', 'Punto frío'),
                desc: t('seguimientos.help.legend.meeting.desc', 'reunión real del calendario de Outlook'),
              },
            ],
          },
        ],
      },
      {
        title: t('seguimientos.help.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('seguimientos.help.buttons.aiview.k', 'Vista con IA'),
                v: t('seguimientos.help.buttons.aiview.v', 'Filtra el tablero a partir de una frase. Usa IA y consume tokens.'),
              },
              {
                k: t('seguimientos.help.buttons.scan.k', 'Actualizaciones'),
                v: t('seguimientos.help.buttons.scan.v', 'Abre una sesión para revisar novedades de las fuentes; esa sesión consume tokens.'),
              },
              {
                k: t('seguimientos.help.buttons.bulk.k', 'Trabajar seleccionados'),
                v: t('seguimientos.help.buttons.bulk.v', 'Abre una sesión con los tickets marcados y consume tokens mientras trabaja.'),
              },
              {
                k: t('seguimientos.help.buttons.refresh.k', '↻ Refrescar datos'),
                v: t('seguimientos.help.buttons.refresh.v', 'Pide actualizar la copia de Desk y después vuelve a leer el snapshot guardado.'),
              },
              {
                k: t('seguimientos.help.buttons.classify.k', '🧠 Re-clasificar'),
                v: t('seguimientos.help.buttons.classify.v', 'Vuelve a clasificar el snapshot con IA; consume tokens.'),
              },
              {
                k: t('seguimientos.help.buttons.project.k', 'Proyecto'),
                v: t('seguimientos.help.buttons.project.v', 'Agrupa las filas por proyecto sin modificar los tickets.'),
              },
              {
                k: t('seguimientos.help.buttons.mine.k', 'Míos'),
                v: t('seguimientos.help.buttons.mine.v', 'Muestra solo los tickets asignados a vos o marcados como tuyos.'),
              },
              {
                k: t('seguimientos.help.buttons.table.k', 'Tabla y filtros'),
                v: t('seguimientos.help.buttons.table.v', 'Los encabezados ordenan; la segunda fila filtra; las casillas arman la selección de trabajo.'),
              },
              {
                k: t('seguimientos.help.buttons.row.k', 'Fila de ticket'),
                v: t('seguimientos.help.buttons.row.v', 'Abre propiedades, personas, tiempos, descripción y enlace al ticket en Zoho.'),
              },
              {
                k: t('seguimientos.help.buttons.resolve.k', 'Resolver en sesión'),
                v: t('seguimientos.help.buttons.resolve.v', 'Abre una sesión con el ticket del detalle; consume tokens.'),
              },
              {
                k: t('seguimientos.help.buttons.calendar.k', '‹ › y ampliar'),
                v: t('seguimientos.help.buttons.calendar.v', 'Cambia de mes o abre el calendario grande con vencimientos y reuniones.'),
              },
              {
                k: t('seguimientos.help.buttons.day.k', 'Día del calendario'),
                v: t('seguimientos.help.buttons.day.v', 'Abre los tickets y reuniones de ese día; los eventos de Outlook son informativos.'),
              },
              {
                k: t('seguimientos.help.buttons.standup.k', 'Abrir reunión del día'),
                v: t('seguimientos.help.buttons.standup.v', 'Abre una sesión con el panorama del standup y consume tokens.'),
              },
              {
                k: t('seguimientos.help.buttons.collapse.k', 'Títulos de cuadrante'),
                v: t('seguimientos.help.buttons.collapse.v', 'Pliegan o despliegan Resumen, Tickets, Métricas, Calendario y Standup.'),
              },
              {
                k: t('seguimientos.help.buttons.help.k', '? Ayuda'),
                v: t('seguimientos.help.buttons.help.v', 'Abre esta guía sin cambiar filtros ni selecciones.'),
              },
            ],
          },
        ],
      },
      {
        title: t('seguimientos.help.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'warn',
            text: t('seguimientos.help.warning.text', 'El tablero no resuelve ni publica nada por su cuenta. Las sesiones abiertas desde acá pueden leer varias fuentes, pero solo pueden escribir en el ticket y siempre deben pedir tu aprobación explícita antes de hacerlo.'),
          },
        ],
      },
    ],
  };
}
