// modules/audio/help.js — ayuda contextual para interpretar transcripciones.
//
// El tema se construye al abrirse para que t() use el idioma ya inicializado.
import { t } from '../../ui/i18n.js';

export default function audioHelp() {
  return {
    title: t('audio.help.title', 'Analizar audio'),
    icon: 'play',
    intro: t('audio.help.intro', 'Analizar audio convierte una transcripción ya escrita en un resumen ordenado de lo que se habló. Vive dentro de Pendientes y propone tareas, pero sos vos quien decide cuáles crear.'),
    sections: [
      {
        title: t('audio.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('audio.help.first.step1', 'Abrí Pendientes, entrá en “📋 Tareas” o “🎙️ Informes” y tocá “Audio” o “Analizar audio”.'),
              t('audio.help.first.step2', 'Pegá la transcripción ya convertida a texto en el campo grande.'),
              t('audio.help.first.step3', 'Tocá “Analizar” y confirmá la corrida con IA, que consume tokens.'),
              t('audio.help.first.step4', 'Recorré el árbol de resumen, segmentos, plan, hablantes, tareas propuestas y Raw.'),
              t('audio.help.first.step5', 'Creá sólo las tareas que quieras, crealas todas o pasalas juntas a un plan.'),
            ],
          },
        ],
      },
      {
        title: t('audio.help.legend.title', 'Leyenda del análisis'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              {
                emoji: t('audio.help.legend.action.emoji', '🎯'),
                name: t('audio.help.legend.action.name', 'Acción'),
                desc: t('audio.help.legend.action.desc', 'algo concreto que alguien debe hacer'),
              },
              {
                emoji: t('audio.help.legend.plan.emoji', '🗺️'),
                name: t('audio.help.legend.plan.name', 'Plan'),
                desc: t('audio.help.legend.plan.desc', 'una secuencia o intención de trabajo'),
              },
              {
                emoji: t('audio.help.legend.decision.emoji', '✅'),
                name: t('audio.help.legend.decision.name', 'Decisión'),
                desc: t('audio.help.legend.decision.desc', 'algo que quedó resuelto'),
              },
              {
                emoji: t('audio.help.legend.problem.emoji', '⚠️'),
                name: t('audio.help.legend.problem.name', 'Problema'),
                desc: t('audio.help.legend.problem.desc', 'un bloqueo, riesgo o dificultad'),
              },
              {
                emoji: t('audio.help.legend.question.emoji', '❓'),
                name: t('audio.help.legend.question.name', 'Pregunta'),
                desc: t('audio.help.legend.question.desc', 'algo que quedó por responder'),
              },
              {
                emoji: t('audio.help.legend.info.emoji', 'ℹ️'),
                name: t('audio.help.legend.info.name', 'Info'),
                desc: t('audio.help.legend.info.desc', 'contexto útil que no es una acción'),
              },
              {
                emoji: t('audio.help.legend.high.emoji', '🔴'),
                name: t('audio.help.legend.high.name', 'Prioridad alta'),
                desc: t('audio.help.legend.high.desc', 'propuesta urgente'),
              },
              {
                emoji: t('audio.help.legend.medium.emoji', '🟡'),
                name: t('audio.help.legend.medium.name', 'Prioridad media'),
                desc: t('audio.help.legend.medium.desc', 'propuesta de prioridad normal'),
              },
              {
                emoji: t('audio.help.legend.low.emoji', '🟢'),
                name: t('audio.help.legend.low.name', 'Prioridad baja'),
                desc: t('audio.help.legend.low.desc', 'propuesta que puede esperar'),
              },
              {
                emoji: t('audio.help.legend.raw.emoji', '🧾'),
                name: t('audio.help.legend.raw.name', 'Raw'),
                desc: t('audio.help.legend.raw.desc', 'transcripción original y JSON interpretado, sin el formato visual'),
              },
            ],
          },
        ],
      },
      {
        title: t('audio.help.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('audio.help.buttons.transcript.k', 'Campo de transcripción'),
                v: t('audio.help.buttons.transcript.v', 'Recibe texto; este módulo no convierte una grabación de voz a texto.'),
              },
              {
                k: t('audio.help.buttons.analyze.k', 'Analizar'),
                v: t('audio.help.buttons.analyze.v', 'Interpreta el texto con IA. Consume tokens y pide confirmación antes de empezar.'),
              },
              {
                k: t('audio.help.buttons.history.k', 'Análisis anteriores'),
                v: t('audio.help.buttons.history.v', 'Abre un informe previo sin volver a gastar tokens.'),
              },
              {
                k: t('audio.help.buttons.editTitle.k', '✏️ Editar título'),
                v: t('audio.help.buttons.editTitle.v', 'Cambia el título que generó la IA; Enter o salir del campo guarda y Esc cancela.'),
              },
              {
                k: t('audio.help.buttons.createOne.k', '＋ Crear tarea'),
                v: t('audio.help.buttons.createOne.v', 'Crea en Pendientes únicamente esa propuesta.'),
              },
              {
                k: t('audio.help.buttons.createAll.k', 'Crear todas'),
                v: t('audio.help.buttons.createAll.v', 'Crea todas las propuestas que todavía no figuran como creadas.'),
              },
              {
                k: t('audio.help.buttons.toPlan.k', '🗺️ Pasar a plan'),
                v: t('audio.help.buttons.toPlan.v', 'Crea un plan con el título y resumen del informe y le asigna todas las tareas propuestas.'),
              },
              {
                k: t('audio.help.buttons.tree.k', 'Segmentos · Plan · Hablantes'),
                v: t('audio.help.buttons.tree.v', 'Despliega o contrae cada rama de la interpretación.'),
              },
              {
                k: t('audio.help.buttons.raw.k', '🧾 Raw'),
                v: t('audio.help.buttons.raw.v', 'Muestra el texto original y el resultado técnico completo.'),
              },
            ],
          },
        ],
      },
      {
        title: t('audio.help.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'warn',
            text: t('audio.help.warning.text', '“Analizar” consume tokens reales. La interpretación es de solo lectura y ninguna tarea se crea automáticamente: cada propuesta necesita que toques “Crear tarea”, “Crear todas” o “Pasar a plan”.'),
          },
        ],
      },
    ],
  };
}
