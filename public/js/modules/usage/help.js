// modules/usage/help.js — contenido contextual de ayuda para Uso y tokens.
//
// Exporta una función para que todos los textos pasen por t() al abrir el tema
// y reflejen el idioma ya inicializado de la consola.
import { t } from '../../ui/i18n.js';

export default function usageHelp() {
  return {
    title: t('usage.help.title', 'Uso y tokens'),
    icon: 'pulse',
    intro: t('usage.help.intro', 'Uso reúne el consumo encontrado en los transcripts locales y los límites que reportan los planes. Sirve para entender el ritmo, los modelos y los proyectos que concentran la actividad.'),
    sections: [
      {
        title: t('usage.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('usage.help.first.step1', 'Tocá hoy en el pie de la barra izquierda para abrir Uso.'),
              t('usage.help.first.step2', 'Revisá arriba cuánto queda en cada ventana del plan y cuándo se reinicia.'),
              t('usage.help.first.step3', 'Elegí Día, Semana o Mes y después filtrá por proyecto.'),
              t('usage.help.first.step4', 'Alterná entre $ y tok para leer General y Tendencia con la misma métrica.'),
              t('usage.help.first.step5', 'Tocá la gráfica de Tendencia si necesitás verla ampliada.'),
            ],
          },
        ],
      },
      {
        title: t('usage.help.legend.title', 'Leyenda'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              {
                emoji: t('usage.help.legend.gradient.emoji', '🟢🟡🔴'),
                name: t('usage.help.legend.gradient.name', 'Barra del límite'),
                desc: t('usage.help.legend.gradient.desc', 'verde, ámbar y rojo marcan de menor a mayor porcentaje usado'),
              },
              {
                emoji: t('usage.help.legend.tick.emoji', '│'),
                name: t('usage.help.legend.tick.name', 'Marca de ritmo'),
                desc: t('usage.help.legend.tick.desc', 'en Sesión (5h), señala cuánto llevarías usado si gastaras parejo hasta el reinicio'),
              },
              {
                emoji: t('usage.help.legend.pacman.emoji', '🟡'),
                name: t('usage.help.legend.pacman.name', 'Pac-Man'),
                desc: t('usage.help.legend.pacman.desc', 'ese modelo está consumiendo tokens ahora o tuvo actividad muy reciente'),
              },
              {
                emoji: t('usage.help.legend.dot.emoji', '●'),
                name: t('usage.help.legend.dot.name', 'Color del modelo'),
                desc: t('usage.help.legend.dot.desc', 'identifica el mismo modelo en General, la leyenda y las barras apiladas'),
              },
              {
                emoji: t('usage.help.legend.general.emoji', '📊'),
                name: t('usage.help.legend.general.name', 'General'),
                desc: t('usage.help.legend.general.desc', 'total del período elegido y desglose por modelo'),
              },
              {
                emoji: t('usage.help.legend.trend.emoji', '📈'),
                name: t('usage.help.legend.trend.name', 'Tendencia'),
                desc: t('usage.help.legend.trend.desc', 'evolución por hora en Día y por día en Semana o Mes, apilada por modelo'),
              },
              {
                emoji: t('usage.help.legend.credits.emoji', '💳'),
                name: t('usage.help.legend.credits.name', 'Créditos de uso'),
                desc: t('usage.help.legend.credits.desc', 'uso extra que reporta el plan; la fila se puede desplegar'),
              },
              {
                emoji: t('usage.help.legend.codex.emoji', 'Codex'),
                name: t('usage.help.legend.codex.name', 'Codex CLI'),
                desc: t('usage.help.legend.codex.desc', 'si hay datos, aparece con sus propias ventanas de límite y como un modelo más en General y Tendencia'),
              },
              {
                emoji: t('usage.help.legend.stale.emoji', '⚠'),
                name: t('usage.help.legend.stale.name', 'Datos guardados'),
                desc: t('usage.help.legend.stale.desc', 'el medidor remoto falló y se está mostrando el último dato bueno'),
              },
              {
                emoji: t('usage.help.legend.reached.emoji', '⛔'),
                name: t('usage.help.legend.reached.name', 'Límite alcanzado'),
                desc: t('usage.help.legend.reached.desc', 'Codex informó que una de sus ventanas ya llegó al tope'),
              },
            ],
          },
        ],
      },
      {
        title: t('usage.help.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('usage.help.buttons.today.k', 'Hoy'),
                v: t('usage.help.buttons.today.v', 'Abre el modal y muestra en el pie el total de tokens locales del día.'),
              },
              {
                k: t('usage.help.buttons.reload.k', 'Actualizar'),
                v: t('usage.help.buttons.reload.v', 'Vuelve a leer transcripts y límites en ese momento; no dispara un runner de IA ni consume tokens.'),
              },
              {
                k: t('usage.help.buttons.connect.k', 'Conectar mi cuenta de Claude'),
                v: t('usage.help.buttons.connect.v', 'Aparece cuando la credencial actual no permite leer el medidor de Anthropic. Abre la autorización de tu cuenta para mostrar los porcentajes reales del plan; el proceso no consume tokens.'),
              },
              {
                k: t('usage.help.buttons.range.k', 'Día · Semana · Mes'),
                v: t('usage.help.buttons.range.v', 'Cambia el período de General y Tendencia: hoy por hora, últimos 7 días o últimos 30 días.'),
              },
              {
                k: t('usage.help.buttons.project.k', 'Todos · Consola · Tolkien · Aprendizaje · Otros'),
                v: t('usage.help.buttons.project.v', 'Filtra el consumo local por proyecto; los límites del plan siempre siguen siendo los de toda la cuenta.'),
              },
              {
                k: t('usage.help.buttons.cost.k', '$'),
                v: t('usage.help.buttons.cost.v', 'Muestra el costo equivalente a precios de API y ordena los modelos por tarifa.'),
              },
              {
                k: t('usage.help.buttons.tokens.k', 'tok'),
                v: t('usage.help.buttons.tokens.v', 'Muestra el volumen de tokens registrado en los transcripts.'),
              },
              {
                k: t('usage.help.buttons.credits.k', 'Créditos de uso'),
                v: t('usage.help.buttons.credits.v', 'Despliega el detalle de crédito extra, si el plan lo reporta.'),
              },
              {
                k: t('usage.help.buttons.chart.k', 'Gráfica de Tendencia'),
                v: t('usage.help.buttons.chart.v', 'Abre una copia amplia de la gráfica con el rango, proyecto y métrica actuales.'),
              },
            ],
          },
          {
            type: 'note',
            tone: 'info',
            text: t('usage.help.buttons.note', 'Todas estas acciones sólo consultan, filtran o presentan datos: no ejecutan IA ni consumen tokens.'),
          },
        ],
      },
      {
        title: t('usage.help.history.title', 'Histórico persistente'),
        blocks: [
          {
            type: 'p',
            text: t('usage.help.history.text', 'Día se arma con los transcripts disponibles. Semana y Mes se apoyan en usage-history.json: ese histórico sobrevive a la poda de transcripts del CLI y alimenta las gráficas de Tendencia.'),
          },
        ],
      },
      {
        title: t('usage.sponsored.help.title', 'Patrocinados'),
        blocks: [
          {
            type: 'p',
            text: t('usage.sponsored.help.text', 'Un patrocinado es una persona que trabaja con la credencial de Claude que le presta su sponsor, quien paga ese consumo. El umbral es sólo un aviso informativo: no hay ningún tope que corte el trabajo de esa persona.'),
          },
        ],
      },
      {
        title: t('usage.help.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'warn',
            text: t('usage.help.warning.text', 'El COSTO mostrado es equivalente a precios de API, NO gasto real de la suscripción. Todo está agrupado en hora local de Medellín. Cada cache read se pondera ×0.1 frente a un token normal: NUNCA compares tokens crudos entre sí; la métrica honesta es el costo equivalente. Codex aparece si hay datos locales o límites disponibles, pero sin una tarifa pública verificada muestra “sin tarifa” y no suma al total en dólares.'),
          },
        ],
      },
    ],
  };
}
