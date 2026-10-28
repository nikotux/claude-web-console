// modules/tasks/help.js — ayuda contextual del tablero de Pendientes.
//
// Exporta una función para evaluar todos los textos al abrir la ayuda y
// respetar el idioma que ya eligió la persona.
import { t } from '../../ui/i18n.js';

export default function tasksHelp() {
  return {
    title: t('tasks.help.title', 'Pendientes'),
    icon: 'list',
    intro: t('tasks.help.intro', 'Pendientes es el lugar para ordenar lo que falta hacer y convertirlo en trabajo concreto. Su fuente de verdad es el Pad LOCAL, en las colecciones pendientes y planes; no usa archivos como backend ni saca nada de este tablero privado.'),
    sections: [
      {
        title: t('tasks.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('tasks.help.first.step1', 'Tocá “Abrir tablero” en la tarjeta Banco de conocimiento.'),
              t('tasks.help.first.step2', 'Entrá en “📋 Tareas” y tocá “Nueva” para cargar qué hay que hacer.'),
              t('tasks.help.first.step3', 'Elegí tipo, prioridad, estado, fecha comprometida (ETA) y, si corresponde, un plan.'),
              t('tasks.help.first.step4', 'Abrí la tarjeta de la tarea para avanzar su estado, editarla, relacionarla o dejar comentarios.'),
              t('tasks.help.first.step5', 'Volvé a “📊 Panel” para ver qué está en curso, qué necesita atención y por dónde conviene seguir.'),
            ],
          },
        ],
      },
      {
        title: t('tasks.help.tabs.title', 'Las cinco pestañas'),
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('tasks.help.tabs.panel.k', '📊 Panel'),
                v: t('tasks.help.tabs.panel.v', 'Resume clasificación, trabajo en curso, alertas, próximos pasos, planes activos y actividad reciente. Se calcula con datos del tablero y no consume tokens.'),
              },
              {
                k: t('tasks.help.tabs.tasks.k', '📋 Tareas'),
                v: t('tasks.help.tabs.tasks.v', 'Lista los PEND individuales, permite filtrarlos y abrir su detalle para trabajar con ellos.'),
              },
              {
                k: t('tasks.help.tabs.plans.k', '🗺️ Planes'),
                v: t('tasks.help.tabs.plans.v', 'Agrupa tareas bajo registros PLAN y calcula su progreso según cuántas tareas hijas están hechas.'),
              },
              {
                k: t('tasks.help.tabs.learning.k', '🎓 Aprendizaje'),
                v: t('tasks.help.tabs.learning.v', 'Muestra el pizarrón de temas y rutas de estudio; sus datos viven en sus propias colecciones de Pad LOCAL.'),
              },
              {
                k: t('tasks.help.tabs.reports.k', '🎙️ Informes'),
                v: t('tasks.help.tabs.reports.v', 'Guarda los análisis de transcripciones de audio; desde cada informe podés revisar hallazgos y crear las tareas propuestas.'),
              },
            ],
          },
        ],
      },
      {
        title: t('tasks.help.legend.title', 'Estados, tipos y prioridades'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              {
                emoji: t('tasks.help.legend.pend.emoji', 'PEND'),
                name: t('tasks.help.legend.pend.name', 'Pendiente'),
                desc: t('tasks.help.legend.pend.desc', 'una tarea, idea, nota o feature individual'),
              },
              {
                emoji: t('tasks.help.legend.plan.emoji', 'PLAN'),
                name: t('tasks.help.legend.plan.name', 'Plan'),
                desc: t('tasks.help.legend.plan.desc', 'un grupo de tareas con progreso calculado'),
              },
              {
                emoji: t('tasks.help.legend.pending.emoji', '⚪'),
                name: t('tasks.help.legend.pending.name', 'Pendiente'),
                desc: t('tasks.help.legend.pending.desc', 'todavía no se empezó'),
              },
              {
                emoji: t('tasks.help.legend.progress.emoji', '🔵'),
                name: t('tasks.help.legend.progress.name', 'En progreso'),
                desc: t('tasks.help.legend.progress.desc', 'se está trabajando'),
              },
              {
                emoji: t('tasks.help.legend.done.emoji', '✅'),
                name: t('tasks.help.legend.done.name', 'Hecha'),
                desc: t('tasks.help.legend.done.desc', 'trabajo terminado'),
              },
              {
                emoji: t('tasks.help.legend.high.emoji', '🔴'),
                name: t('tasks.help.legend.high.name', 'Prioridad alta'),
                desc: t('tasks.help.legend.high.desc', 'requiere atención antes que las demás'),
              },
              {
                emoji: t('tasks.help.legend.medium.emoji', '🟡'),
                name: t('tasks.help.legend.medium.name', 'Prioridad media'),
                desc: t('tasks.help.legend.medium.desc', 'prioridad normal'),
              },
              {
                emoji: t('tasks.help.legend.low.emoji', '🟢'),
                name: t('tasks.help.legend.low.name', 'Prioridad baja'),
                desc: t('tasks.help.legend.low.desc', 'puede esperar'),
              },
              {
                emoji: t('tasks.help.legend.task.emoji', '🔹'),
                name: t('tasks.help.legend.task.name', 'Tarea'),
                desc: t('tasks.help.legend.task.desc', 'una acción concreta'),
              },
              {
                emoji: t('tasks.help.legend.idea.emoji', '💡'),
                name: t('tasks.help.legend.idea.name', 'Idea'),
                desc: t('tasks.help.legend.idea.desc', 'algo para evaluar o desarrollar'),
              },
              {
                emoji: t('tasks.help.legend.note.emoji', '📝'),
                name: t('tasks.help.legend.note.name', 'Nota'),
                desc: t('tasks.help.legend.note.desc', 'información que conviene conservar'),
              },
              {
                emoji: t('tasks.help.legend.feature.emoji', '✨'),
                name: t('tasks.help.legend.feature.name', 'Feature'),
                desc: t('tasks.help.legend.feature.desc', 'una mejora o capacidad nueva'),
              },
              {
                emoji: t('tasks.help.legend.planActive.emoji', '🟢'),
                name: t('tasks.help.legend.planActive.name', 'Plan activo'),
                desc: t('tasks.help.legend.planActive.desc', 'plan en ejecución'),
              },
              {
                emoji: t('tasks.help.legend.planProposed.emoji', '💭'),
                name: t('tasks.help.legend.planProposed.name', 'Plan propuesto'),
                desc: t('tasks.help.legend.planProposed.desc', 'plan todavía por decidir'),
              },
              {
                emoji: t('tasks.help.legend.planDone.emoji', '✅'),
                name: t('tasks.help.legend.planDone.name', 'Plan completado'),
                desc: t('tasks.help.legend.planDone.desc', 'plan terminado'),
              },
              {
                emoji: t('tasks.help.legend.planCancelled.emoji', '🚫'),
                name: t('tasks.help.legend.planCancelled.name', 'Plan cancelado'),
                desc: t('tasks.help.legend.planCancelled.desc', 'plan que ya no se seguirá'),
              },
              {
                emoji: t('tasks.help.legend.audio.emoji', '🎙️'),
                name: t('tasks.help.legend.audio.name', 'Desde audio'),
                desc: t('tasks.help.legend.audio.desc', 'tarea nacida de una propuesta de un informe'),
              },
              {
                emoji: t('tasks.help.legend.overdue.emoji', '🔴'),
                name: t('tasks.help.legend.overdue.name', 'Vencida'),
                desc: t('tasks.help.legend.overdue.desc', 'la fecha comprometida ya pasó; el tablero también muestra el total vencido'),
              },
              {
                emoji: t('tasks.help.legend.today.emoji', '🟡'),
                name: t('tasks.help.legend.today.name', 'Vence hoy'),
                desc: t('tasks.help.legend.today.desc', 'la fecha comprometida es hoy'),
              },
            ],
          },
        ],
      },
      {
        title: t('tasks.help.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('tasks.help.buttons.sidebarNew.k', '＋ del sidebar'),
                v: t('tasks.help.buttons.sidebarNew.v', 'Crea una tarea sin abrir primero el tablero.'),
              },
              {
                k: t('tasks.help.buttons.openBoard.k', 'Abrir tablero'),
                v: t('tasks.help.buttons.openBoard.v', 'Abre el Banco de conocimiento con sus pestañas.'),
              },
              {
                k: t('tasks.help.buttons.filters.k', 'Activas · Todas · Hechas'),
                v: t('tasks.help.buttons.filters.v', 'Filtran la grilla de tareas sin cambiar los datos.'),
              },
              {
                k: t('tasks.help.buttons.card.k', 'Tarjeta de tarea'),
                v: t('tasks.help.buttons.card.v', 'Abre propiedades, descripción, relaciones, timeline y comentarios.'),
              },
              {
                k: t('tasks.help.buttons.newTask.k', 'Nueva'),
                v: t('tasks.help.buttons.newTask.v', 'Crea un PEND con tipo, prioridad, estado y plan opcional.'),
              },
              {
                k: t('tasks.help.buttons.advance.k', 'En progreso · Marcar hecha · Reabrir'),
                v: t('tasks.help.buttons.advance.v', 'Mueve una tarea por su ciclo de estados.'),
              },
              {
                k: t('tasks.help.buttons.edit.k', 'Editar'),
                v: t('tasks.help.buttons.edit.v', 'Cambia los datos de una tarea o un plan.'),
              },
              {
                k: t('tasks.help.buttons.relations.k', '＋ en Relaciones · ✕'),
                v: t('tasks.help.buttons.relations.v', 'Vincula lo que este ítem bloquea o quita ese vínculo; “Bloqueado por” se calcula solo.'),
              },
              {
                k: t('tasks.help.buttons.comment.k', 'Comentar'),
                v: t('tasks.help.buttons.comment.v', 'Agrega una entrada al timeline; Ctrl+Enter también la envía.'),
              },
              {
                k: t('tasks.help.buttons.newPlan.k', 'Nuevo plan'),
                v: t('tasks.help.buttons.newPlan.v', 'Crea un PLAN; después asignale tareas desde el campo “Plan” de cada PEND.'),
              },
              {
                k: t('tasks.help.buttons.openPlan.k', 'Abrir'),
                v: t('tasks.help.buttons.openPlan.v', 'Muestra el detalle, las tareas hijas y el progreso del plan.'),
              },
              {
                k: t('tasks.help.buttons.audio.k', 'Audio'),
                v: t('tasks.help.buttons.audio.v', 'Disponible para administradores: abre el análisis de una transcripción. Consume tokens al tocar “Analizar”.'),
              },
              {
                k: t('tasks.help.buttons.analysis.k', 'Análisis general'),
                v: t('tasks.help.buttons.analysis.v', 'Disponible para administradores: busca duplicados y datos incompletos con IA. Consume tokens; cada propuesta se aprueba o descarta por separado.'),
              },
              {
                k: t('tasks.help.buttons.reorganize.k', 'Reorganizar todo con IA'),
                v: t('tasks.help.buttons.reorganize.v', 'Disponible para administradores: analiza tareas, planes e informes juntos. Consume tokens y no aplica propuestas sin aprobación.'),
              },
              {
                k: t('tasks.help.buttons.delete.k', 'Eliminar'),
                v: t('tasks.help.buttons.delete.v', 'Borra la tarea o el plan después de pedir confirmación.'),
              },
            ],
          },
        ],
      },
      {
        title: t('tasks.help.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'danger',
            text: t('tasks.help.warning.text', 'Las tareas y planes viven en Pad LOCAL, no en archivos. Eliminar una tarea no se puede deshacer; eliminar un plan deja sus tareas sin plan. Los análisis con IA consumen tokens, pero sus propuestas nunca se aplican solas.'),
          },
        ],
      },
    ],
  };
}
