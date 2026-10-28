// modules/learning/help.js — ayuda contextual para el panel de Aprendizaje.
//
// Se exporta una función para resolver las traducciones al abrir el tema.
import { t } from '../../ui/i18n.js';

export default function learningHelp() {
  return {
    title: t('learning.help.title', 'Aprendizaje'),
    icon: 'eye',
    intro: t('learning.help.intro', 'Aprendizaje es tu pizarrón personal para ordenar temas que querés entender y reforzar. Temas y rutas viven en el Pad LOCAL (temas-de-aprendizaje y rutas-de-aprendizaje) y las guías leen el código real en modo solo lectura.'),
    sections: [
      {
        title: t('learning.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('learning.help.first.step1', 'Abrí el Banco de conocimiento y entrá en la pestaña “🎓 Aprendizaje”.'),
              t('learning.help.first.step2', 'Tocá “Nuevo tema” y escribí qué querés entender, el alcance y una pregunta puntual si la tenés.'),
              t('learning.help.first.step3', 'Elegí el estado y, si varios temas forman un recorrido, asignales una ruta.'),
              t('learning.help.first.step4', 'Abrí la tarjeta del tema y sumá notas o contexto antes de generar la guía.'),
              t('learning.help.first.step5', 'Tocá “🎓 Generar guía completa” —la acción “Explicame esto”— o “Regenerar” para que la IA navegue el código en solo lectura y guarde una explicación guiada.'),
            ],
          },
        ],
      },
      {
        title: t('learning.help.legend.title', 'Estados y señales'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              {
                emoji: t('learning.help.legend.toLearn.emoji', '🔴'),
                name: t('learning.help.legend.toLearn.name', 'Por aprender'),
                desc: t('learning.help.legend.toLearn.desc', 'tema todavía no trabajado'),
              },
              {
                emoji: t('learning.help.legend.reinforcing.emoji', '🟡'),
                name: t('learning.help.legend.reinforcing.name', 'Reforzando'),
                desc: t('learning.help.legend.reinforcing.desc', 'tema en práctica o repaso'),
              },
              {
                emoji: t('learning.help.legend.mastered.emoji', '🟢'),
                name: t('learning.help.legend.mastered.name', 'Dominado'),
                desc: t('learning.help.legend.mastered.desc', 'tema que ya manejás'),
              },
              {
                emoji: t('learning.help.legend.high.emoji', '🔴'),
                name: t('learning.help.legend.high.name', 'Prioridad alta'),
                desc: t('learning.help.legend.high.desc', 'conviene estudiarlo primero'),
              },
              {
                emoji: t('learning.help.legend.medium.emoji', '🟡'),
                name: t('learning.help.legend.medium.name', 'Prioridad media'),
                desc: t('learning.help.legend.medium.desc', 'prioridad normal'),
              },
              {
                emoji: t('learning.help.legend.low.emoji', '🟢'),
                name: t('learning.help.legend.low.name', 'Prioridad baja'),
                desc: t('learning.help.legend.low.desc', 'puede esperar'),
              },
              {
                emoji: t('learning.help.legend.console.emoji', '🖥️'),
                name: t('learning.help.legend.console.name', 'Mi Consola'),
                desc: t('learning.help.legend.console.desc', 'la explicación navega el código de la consola'),
              },
              {
                emoji: t('learning.help.legend.tolkien.emoji', '🌳'),
                name: t('learning.help.legend.tolkien.name', 'Tolkien'),
                desc: t('learning.help.legend.tolkien.desc', 'la explicación navega el código del proyecto Tolkien'),
              },
              {
                emoji: t('learning.help.legend.routeActive.emoji', '🟢'),
                name: t('learning.help.legend.routeActive.name', 'Ruta activa'),
                desc: t('learning.help.legend.routeActive.desc', 'recorrido de estudio en marcha'),
              },
              {
                emoji: t('learning.help.legend.routeProposed.emoji', '💭'),
                name: t('learning.help.legend.routeProposed.name', 'Ruta propuesta'),
                desc: t('learning.help.legend.routeProposed.desc', 'recorrido todavía por decidir'),
              },
              {
                emoji: t('learning.help.legend.routeDone.emoji', '✅'),
                name: t('learning.help.legend.routeDone.name', 'Ruta completada'),
                desc: t('learning.help.legend.routeDone.desc', 'recorrido terminado'),
              },
              {
                emoji: t('learning.help.legend.routeArchived.emoji', '🗃️'),
                name: t('learning.help.legend.routeArchived.name', 'Ruta archivada'),
                desc: t('learning.help.legend.routeArchived.desc', 'recorrido guardado fuera del trabajo activo'),
              },
              {
                emoji: t('learning.help.legend.guide.emoji', '📖'),
                name: t('learning.help.legend.guide.name', 'Guía disponible'),
                desc: t('learning.help.legend.guide.desc', 'el tema ya tiene una explicación guiada'),
              },
              {
                emoji: t('learning.help.legend.aiContext.emoji', '🎙️'),
                name: t('learning.help.legend.aiContext.name', 'Contexto de IA'),
                desc: t('learning.help.legend.aiContext.desc', 'entrada nacida de interpretar una charla'),
              },
              {
                emoji: t('learning.help.legend.manualContext.emoji', '✍️'),
                name: t('learning.help.legend.manualContext.name', 'Contexto manual'),
                desc: t('learning.help.legend.manualContext.desc', 'nota agregada por vos'),
              },
              {
                emoji: t('learning.help.legend.chatContext.emoji', '💬'),
                name: t('learning.help.legend.chatContext.name', 'Contexto de chat'),
                desc: t('learning.help.legend.chatContext.desc', 'resumen que volvió al cerrar una sesión de profundización'),
              },
            ],
          },
        ],
      },
      {
        title: t('learning.help.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('learning.help.buttons.filters.k', 'Aprendiendo · Dominados · Todos'),
                v: t('learning.help.buttons.filters.v', 'Filtran las tarjetas sin cambiar el estado de los temas.'),
              },
              {
                k: t('learning.help.buttons.newTopic.k', 'Nuevo tema'),
                v: t('learning.help.buttons.newTopic.v', 'Crea un tema con alcance, estado, prioridad, ruta, pregunta y notas.'),
              },
              {
                k: t('learning.help.buttons.analyze.k', 'Analizar'),
                v: t('learning.help.buttons.analyze.v', 'Disponible para administradores: organiza todo el aprendizaje con IA y propone duplicados, rutas y próximos temas. Consume tokens; nada se aplica sin tu aprobación.'),
              },
              {
                k: t('learning.help.buttons.routes.k', '🗺️ Rutas de aprendizaje'),
                v: t('learning.help.buttons.routes.v', 'Despliega los recorridos y su progreso calculado por temas dominados.'),
              },
              {
                k: t('learning.help.buttons.newRoute.k', 'Nueva ruta'),
                v: t('learning.help.buttons.newRoute.v', 'Crea un recorrido para agrupar temas relacionados.'),
              },
              {
                k: t('learning.help.buttons.routeTitle.k', 'Título de una ruta'),
                v: t('learning.help.buttons.routeTitle.v', 'Filtra la grilla para mostrar sólo sus temas.'),
              },
              {
                k: t('learning.help.buttons.routeEdit.k', 'Editar ruta'),
                v: t('learning.help.buttons.routeEdit.v', 'Cambia título, estado y descripción del recorrido.'),
              },
              {
                k: t('learning.help.buttons.routeDelete.k', 'Eliminar ruta'),
                v: t('learning.help.buttons.routeDelete.v', 'Borra la ruta, pero deja sus temas sin ruta.'),
              },
              {
                k: t('learning.help.buttons.card.k', 'Tarjeta de tema'),
                v: t('learning.help.buttons.card.v', 'Abre notas, contexto adicional, guía, secciones y acciones del tema.'),
              },
              {
                k: t('learning.help.buttons.notes.k', 'Editar · Escribir notas'),
                v: t('learning.help.buttons.notes.v', 'Guarda tu propio contexto en Markdown; no consume tokens.'),
              },
              {
                k: t('learning.help.buttons.addNote.k', 'Agregar nota'),
                v: t('learning.help.buttons.addNote.v', 'Suma una entrada manual al contexto adicional.'),
              },
              {
                k: t('learning.help.buttons.interpret.k', 'Interpretar con IA'),
                v: t('learning.help.buttons.interpret.v', 'Convierte una charla pegada en una entrada de contexto. Consume tokens.'),
              },
              {
                k: t('learning.help.buttons.explain.k', '🎓 Generar guía completa · Regenerar'),
                v: t('learning.help.buttons.explain.v', 'Disponible para administradores: navega el código real con herramientas de solo lectura y guarda la explicación. Consume tokens sólo si hace falta generarla o adaptarla.'),
              },
              {
                k: t('learning.help.buttons.force.k', 'Forzar regeneración completa'),
                v: t('learning.help.buttons.force.v', 'Ignora la guía anterior y la genera desde cero. Consume tokens.'),
              },
              {
                k: t('learning.help.buttons.chat.k', '💬 Profundizar en chat'),
                v: t('learning.help.buttons.chat.v', 'Abre una sesión de trabajo aparte con todo el contexto del tema; la sesión usa tokens al trabajar y, al cerrarla, su resumen vuelve al pizarrón.'),
              },
              {
                k: t('learning.help.buttons.advance.k', 'Marcar reforzando · Marcar dominado'),
                v: t('learning.help.buttons.advance.v', 'Avanza el estado de estudio del tema.'),
              },
              {
                k: t('learning.help.buttons.edit.k', 'Editar'),
                v: t('learning.help.buttons.edit.v', 'Cambia los datos generales del tema.'),
              },
              {
                k: t('learning.help.buttons.delete.k', 'Eliminar'),
                v: t('learning.help.buttons.delete.v', 'Borra el tema y su explicación guiada después de pedir confirmación.'),
              },
            ],
          },
        ],
      },
      {
        title: t('learning.help.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'danger',
            text: t('learning.help.warning.text', 'Esto es un pizarrón, no un taller: el código de la guía es demostrativo; no se ejecuta ni persiste cambios en archivos. Generar o adaptar una guía consume tokens y navega el repo en modo solo lectura. Para ejecutar o cambiar código de verdad, abrí “Profundizar en chat” o una sesión de trabajo aparte. Eliminar un tema también elimina su guía y no se puede deshacer.'),
          },
        ],
      },
    ],
  };
}
