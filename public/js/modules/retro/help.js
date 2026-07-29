// modules/retro/help.js — ayuda contextual para Mejora Continua.
//
// Exporta una función para que las traducciones se resuelvan al abrir el tema.
import { t } from '../../ui/i18n.js';

export default function retroHelp() {
  return {
    title: t('retro.help.title', 'Mejora Continua'),
    icon: 'sparkle',
    intro: t('retro.help.intro', 'Mejora Continua junta lecciones sobre cómo trabajar mejor, destiladas al cerrar chats con sustancia. La consola propone; vos decidís si adoptar, guardar o descartar cada aprendizaje de proceso.'),
    sections: [
      {
        title: t('retro.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('retro.help.first.step1', 'Mirá el número de propuestas nuevas en la tarjeta de Mejora Continua.'),
              t('retro.help.first.step2', 'Tocá “Abrir tablero” y abrí una lección del grupo “🟡 Nuevas”.'),
              t('retro.help.first.step3', 'Leé la lección, su recurrencia y el destino que sugiere la IA.'),
              t('retro.help.first.step4', 'Tocá “Adoptar” para enviarla a ese destino, “Guardar” para decidir después o “Descartar” si no sirve.'),
              t('retro.help.first.step5', 'Revisá las adoptadas: si una vuelve a ocurrir, el badge “reincide” permite escalarla a un destino más fuerte.'),
            ],
          },
        ],
      },
      {
        title: t('retro.help.legend.title', 'Leyenda de las lecciones'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              {
                emoji: t('retro.help.legend.new.emoji', '🟡'),
                name: t('retro.help.legend.new.name', 'Nueva'),
                desc: t('retro.help.legend.new.desc', 'propuesta todavía por decidir'),
              },
              {
                emoji: t('retro.help.legend.saved.emoji', '🔖'),
                name: t('retro.help.legend.saved.name', 'Guardada'),
                desc: t('retro.help.legend.saved.desc', 'reservada para decidir más adelante'),
              },
              {
                emoji: t('retro.help.legend.adopted.emoji', '✅'),
                name: t('retro.help.legend.adopted.name', 'Adoptada'),
                desc: t('retro.help.legend.adopted.desc', 'ya enviada a un destino de trabajo real'),
              },
              {
                emoji: t('retro.help.legend.discarded.emoji', '🗑️'),
                name: t('retro.help.legend.discarded.name', 'Descartada'),
                desc: t('retro.help.legend.discarded.desc', 'conservada en el registro, pero fuera del flujo activo'),
              },
              {
                emoji: t('retro.help.legend.rule.emoji', '⛔'),
                name: t('retro.help.legend.rule.name', 'Regla'),
                desc: t('retro.help.legend.rule.desc', 'límite que el proceso debe respetar'),
              },
              {
                emoji: t('retro.help.legend.convention.emoji', '📏'),
                name: t('retro.help.legend.convention.name', 'Convención'),
                desc: t('retro.help.legend.convention.desc', 'forma acordada de hacer algo'),
              },
              {
                emoji: t('retro.help.legend.method.emoji', '🧭'),
                name: t('retro.help.legend.method.name', 'Metodología'),
                desc: t('retro.help.legend.method.desc', 'criterio general para encarar el trabajo'),
              },
              {
                emoji: t('retro.help.legend.procedure.emoji', '📋'),
                name: t('retro.help.legend.procedure.name', 'Procedimiento'),
                desc: t('retro.help.legend.procedure.desc', 'pasos repetibles'),
              },
              {
                emoji: t('retro.help.legend.tool.emoji', '🔧'),
                name: t('retro.help.legend.tool.name', 'Herramienta'),
                desc: t('retro.help.legend.tool.desc', 'lección sobre el uso de una herramienta'),
              },
              {
                emoji: t('retro.help.legend.note.emoji', '📝'),
                name: t('retro.help.legend.note.name', 'Nota'),
                desc: t('retro.help.legend.note.desc', 'recordatorio de proceso'),
              },
              {
                emoji: t('retro.help.legend.feedback.emoji', '💬'),
                name: t('retro.help.legend.feedback.name', 'Feedback de Chris'),
                desc: t('retro.help.legend.feedback.desc', 'comentario puntual de cliente o revisión, vinculado cuando corresponde a un ticket o PR'),
              },
              {
                emoji: t('retro.help.legend.recurrence.emoji', '×N'),
                name: t('retro.help.legend.recurrence.name', 'Recurrencia'),
                desc: t('retro.help.legend.recurrence.desc', 'cantidad de chats en los que volvió a aparecer la misma lección'),
              },
              {
                emoji: t('retro.help.legend.watching.emoji', '⚪'),
                name: t('retro.help.legend.watching.name', 'Observando'),
                desc: t('retro.help.legend.watching.desc', 'recién adoptada; todavía no hay suficiente tiempo para medirla'),
              },
              {
                emoji: t('retro.help.legend.effective.emoji', '🟢'),
                name: t('retro.help.legend.effective.name', 'Efectiva'),
                desc: t('retro.help.legend.effective.desc', 'no volvió a ocurrir después de adoptarla'),
              },
              {
                emoji: t('retro.help.legend.recurs.emoji', '🔴'),
                name: t('retro.help.legend.recurs.name', 'Reincide'),
                desc: t('retro.help.legend.recurs.desc', 'volvió a pasar pese a estar adoptada'),
              },
            ],
          },
        ],
      },
      {
        title: t('retro.pool.help.title', '🌍 De la comunidad'),
        blocks: [
          {
            type: 'note',
            text: t('retro.pool.help.what', 'El pozo reúne lecciones de proceso que otras personas compartieron. Publicar es automático únicamente para lecciones de Tolkien, salvo que apagues el interruptor.'),
          },
          {
            type: 'kv',
            items: [
              {
                k: t('retro.pool.help.adopt.k', '👍 Adoptar'),
                v: t('retro.pool.help.adopt.v', 'Siempre es manual: nada que venga de otra persona se aplica solo a tu registro ni a tus destinos de trabajo.'),
              },
              {
                k: t('retro.pool.help.adoptAll.k', '👍 Adoptar todas (N)'),
                v: t('retro.pool.help.adoptAll.v', 'Trae como propuestas solo las lecciones que no son tuyas ni tenés ya. Adoptar no es aplicar: cada lección queda en tu lista y vos decidís después su destino.'),
              },
              {
                k: t('retro.pool.help.recurrence.k', 'le pasó a N'),
                v: t('retro.pool.help.recurrence.v', 'Indica cuántas personas o veces vivieron la misma lección; un número mayor ayuda a reconocer patrones compartidos.'),
              },
              {
                k: t('retro.pool.help.unshare.k', 'Retirar del pozo'),
                v: t('retro.pool.help.unshare.v', 'Retira tu donación sin borrar tu lección. La decisión vale hacia adelante: no vuelve a publicarse sola, aunque después podés compartir una versión futura.'),
              },
            ],
          },
        ],
      },
      {
        title: t('retro.help.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('retro.help.buttons.refresh.k', '↻ Refrescar'),
                v: t('retro.help.buttons.refresh.v', 'Actualiza el badge y los conteos de la tarjeta. No consume tokens.'),
              },
              {
                k: t('retro.help.buttons.open.k', 'Abrir tablero'),
                v: t('retro.help.buttons.open.v', 'Muestra las lecciones agrupadas por estado.'),
              },
              {
                k: t('retro.help.buttons.adopt.k', '👍 Adoptar → destino'),
                v: t('retro.help.buttons.adopt.v', 'Promueve la lección al destino sugerido y la deja como adoptada.'),
              },
              {
                k: t('retro.help.buttons.more.k', '▾'),
                v: t('retro.help.buttons.more.v', 'Muestra otros destinos aplicables para esa lección.'),
              },
              {
                k: t('retro.help.buttons.save.k', '🔖 Guardar'),
                v: t('retro.help.buttons.save.v', 'La guarda para decidir más adelante, sin promoverla.'),
              },
              {
                k: t('retro.help.buttons.dismiss.k', '👎 Descartar'),
                v: t('retro.help.buttons.dismiss.v', 'La mueve al grupo Descartadas.'),
              },
              {
                k: t('retro.help.buttons.reopen.k', '↩️ Reabrir'),
                v: t('retro.help.buttons.reopen.v', 'Devuelve una descartada al grupo de propuestas.'),
              },
              {
                k: t('retro.help.buttons.acceptAll.k', '👍 Aceptar todo'),
                v: t('retro.help.buttons.acceptAll.v', 'Adopta en lote todas las pendientes, cada una en su destino sugerido; escribe en destinos reales.'),
              },
              {
                k: t('retro.help.buttons.curate.k', '🧹 Ordenar el registro'),
                v: t('retro.help.buttons.curate.v', 'Busca duplicados, contradicciones, redundancias y huecos con IA. Consume tokens y cada cambio se decide aparte.'),
              },
              {
                k: t('retro.help.buttons.email.k', '📧 Traer feedback de correo'),
                v: t('retro.help.buttons.email.v', 'Lee el correo de Chris, interpreta feedback y lo suma al registro. Consume tokens; nunca envía mensajes.'),
              },
              {
                k: t('retro.help.buttons.teams.k', '📨 Traer feedback de Teams'),
                v: t('retro.help.buttons.teams.v', 'Lee el chat de Teams con Chris, interpreta feedback y lo suma al mismo registro. Consume tokens; nunca envía mensajes.'),
              },
              {
                k: t('retro.help.buttons.ref.k', 'Chip TKT/PR/FEAT'),
                v: t('retro.help.buttons.ref.v', 'Filtra el tablero por esa referencia para ver el feedback relacionado.'),
              },
              {
                k: t('retro.help.buttons.escalate.k', '⬆️ Escalar'),
                v: t('retro.help.buttons.escalate.v', 'Aparece si una lección adoptada reincide y permite moverla a un destino más fuerte.'),
              },
              {
                k: t('retro.help.buttons.delete.k', '✕ Eliminar'),
                v: t('retro.help.buttons.delete.v', 'Elimina para siempre una lección descartada, después de pedir confirmación.'),
              },
            ],
          },
        ],
      },
      {
        title: t('retro.help.difference.title', 'Mejora Continua y Aprendizaje'),
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('retro.help.difference.retro.k', 'Mejora Continua'),
                v: t('retro.help.difference.retro.v', 'El sistema aprende lecciones de proceso para que las próximas sesiones trabajen mejor.'),
              },
              {
                k: t('retro.help.difference.learning.k', 'Aprendizaje'),
                v: t('retro.help.difference.learning.v', 'Es tu espacio de estudio personal para entender temas y código; no cambia las reglas del proceso.'),
              },
            ],
          },
        ],
      },
      {
        title: t('retro.help.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'danger',
            text: t('retro.help.warning.text', 'Nada se auto-aplica. “Adoptar” y “Aceptar todo” escriben en el destino real indicado; revisalo antes de confirmar. “Eliminar” borra definitivamente una lección descartada. Las búsquedas y la curaduría con IA consumen tokens.'),
          },
        ],
      },
    ],
  };
}
