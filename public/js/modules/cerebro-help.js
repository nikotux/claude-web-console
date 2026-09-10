// modules/cerebro-help.js — ayuda contextual del Cerebro del Pad.
//
// Mantiene todo texto visible detrás de t() y conserva el tema como función.
import { t } from '../ui/i18n.js';

export default function cerebroHelp() {
  return {
    title: t('cerebro.help.title', 'Cerebro del Pad'),
    icon: 'brain',
    intro: t('cerebro.help.intro', 'Cerebro del Pad es una vista 3D de solo lectura del banco de conocimientos local. Representa cada ítem como una neurona, distingue el tipo y la dirección de sus relaciones reales y muestra la actividad del Pad como pulsos, sin usar tokens de IA ni escribir datos.'),
    sections: [
      {
        title: t('cerebro.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('cerebro.help.first.step1', 'Mirá cómo la nube gira sola con una órbita lenta.'),
              t('cerebro.help.first.step2', 'Identificá cada colección por su color usando la leyenda de la esquina.'),
              t('cerebro.help.first.step3', 'Reconocé los nodos grandes: son los ítems que tienen más conexiones.'),
              t('cerebro.help.first.stepFilters', 'Abrí la leyenda para filtrar relaciones; activá «Ocultar jerarquía» para aislar la red lateral.'),
              t('cerebro.help.first.step4', 'Esperá o provocá actividad real en el Pad: la neurona se enciende y una partícula viaja por las conexiones que toca.'),
              t('cerebro.help.first.step5', 'Hacé clic en una neurona para centrar la cámara sobre ella.'),
              t('cerebro.help.first.step6', 'Cerrá la ventana con ✕ o Esc cuando termines de observar.'),
            ],
          },
        ],
      },
      {
        title: t('cerebro.help.legend.title', 'Leyenda'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              {
                emoji: t('cerebro.help.legend.neuron.emoji', '🔵'),
                name: t('cerebro.help.legend.neuron.name', 'Neurona'),
                desc: t('cerebro.help.legend.neuron.desc', 'un ítem del Pad; el color indica su colección y el tamaño, cuántas conexiones tiene'),
              },
              {
                emoji: t('cerebro.help.legend.parent.emoji', '⚫'),
                name: t('cerebro.help.legend.parent.name', 'Jerarquía · gris tenue'),
                desc: t('cerebro.help.legend.parent.desc', 'origen → destino significa que el ítem de origen pertenece al padre de destino'),
              },
              {
                emoji: t('cerebro.help.legend.implements.emoji', '🔵'),
                name: t('cerebro.help.legend.implements.name', 'Implementa · azul'),
                desc: t('cerebro.help.legend.implements.desc', 'origen → destino significa que el ítem de origen implementa al ítem de destino'),
              },
              {
                emoji: t('cerebro.help.legend.blocks.emoji', '🔴'),
                name: t('cerebro.help.legend.blocks.name', 'Bloquea · rojo'),
                desc: t('cerebro.help.legend.blocks.desc', 'origen → destino significa que el ítem de origen bloquea al ítem de destino'),
              },
              {
                emoji: t('cerebro.help.legend.supersedes.emoji', '🟡'),
                name: t('cerebro.help.legend.supersedes.name', 'Reemplaza · amarillo'),
                desc: t('cerebro.help.legend.supersedes.desc', 'origen → destino significa que el ítem de origen reemplaza al ítem de destino'),
              },
              {
                emoji: t('cerebro.help.legend.splitFrom.emoji', '🟣'),
                name: t('cerebro.help.legend.splitFrom.name', 'Separada de · violeta'),
                desc: t('cerebro.help.legend.splitFrom.desc', 'origen → destino significa que el ítem de origen se separó del ítem de destino'),
              },
              {
                emoji: t('cerebro.help.legend.wiki.emoji', '🟢'),
                name: t('cerebro.help.legend.wiki.name', 'Wiki-link · verde'),
                desc: t('cerebro.help.legend.wiki.desc', 'origen → destino significa que el texto del ítem de origen enlaza al ítem de destino'),
              },
              {
                emoji: t('cerebro.help.legend.strongPulse.emoji', '✨'),
                name: t('cerebro.help.legend.strongPulse.name', 'Pulso fuerte'),
                desc: t('cerebro.help.legend.strongPulse.desc', 'una escritura: el ítem fue creado, actualizado o comentado'),
              },
              {
                emoji: t('cerebro.help.legend.softPulse.emoji', '💫'),
                name: t('cerebro.help.legend.softPulse.name', 'Pulso suave'),
                desc: t('cerebro.help.legend.softPulse.desc', 'una lectura que hizo la propia consola sobre ese ítem'),
              },
              {
                emoji: t('cerebro.help.legend.cluster.emoji', '🌊'),
                name: t('cerebro.help.legend.cluster.name', 'Clúster encendido'),
                desc: t('cerebro.help.legend.cluster.desc', 'una lectura a nivel colección, sin un ítem puntual'),
              },
              {
                emoji: t('cerebro.help.legend.particle.emoji', '⚡'),
                name: t('cerebro.help.legend.particle.name', 'Partícula en la arista'),
                desc: t('cerebro.help.legend.particle.desc', 'viaja de origen a destino con el color del tipo de relación cuando pulsa uno de sus nodos'),
              },
              {
                emoji: t('cerebro.help.legend.heartbeat.emoji', '🫧'),
                name: t('cerebro.help.legend.heartbeat.name', 'Latido lento'),
                desc: t('cerebro.help.legend.heartbeat.desc', 'reposo: la vista está viva, pero no hay actividad'),
              },
              {
                emoji: t('cerebro.help.legend.live.emoji', '🟢'),
                name: t('cerebro.help.legend.live.name', 'En vivo'),
                desc: t('cerebro.help.legend.live.desc', 'el encabezado confirma que el Pad responde y el flujo de eventos está conectado'),
              },
              {
                emoji: t('cerebro.help.legend.padDown.emoji', '🟡'),
                name: t('cerebro.help.legend.padDown.name', 'Pad sin responder'),
                desc: t('cerebro.help.legend.padDown.desc', 'el encabezado avisa que el Pad no responde; la vista conserva el dibujo y reintenta sola'),
              },
              {
                emoji: t('cerebro.help.legend.reconnecting.emoji', '🔴'),
                name: t('cerebro.help.legend.reconnecting.name', 'Reconectando'),
                desc: t('cerebro.help.legend.reconnecting.desc', 'el flujo de eventos se cortó y la vista intenta recuperarlo sin perder el dibujo'),
              },
            ],
          },
        ],
      },
      {
        title: t('cerebro.help.buttons.title', 'Botones y acciones'),
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('cerebro.help.buttons.help.k', '? Ayuda'),
                v: t('cerebro.help.buttons.help.v', 'Abre esta guía. Ninguna acción de esta vista consume tokens de IA ni escribe en el Pad.'),
              },
              {
                k: t('cerebro.help.buttons.legend.k', 'Leyenda'),
                v: t('cerebro.help.buttons.legend.v', 'Abre o cierra colores y filtros por tipo. «Ocultar jerarquía» retira parent y deja expuesta la red lateral. No consume tokens.'),
              },
              {
                k: t('cerebro.help.buttons.center.k', 'Clic en una neurona'),
                v: t('cerebro.help.buttons.center.v', 'Centra la cámara sobre ese nodo. No consume tokens.'),
              },
              {
                k: t('cerebro.help.buttons.orbit.k', 'Arrastrar / rueda'),
                v: t('cerebro.help.buttons.orbit.v', 'Gira la vista y acerca o aleja la cámara; los nodos no se pueden arrastrar. No consume tokens.'),
              },
              {
                k: t('cerebro.help.buttons.close.k', '✕ / Esc'),
                v: t('cerebro.help.buttons.close.v', 'Cierra la ventana. No consume tokens.'),
              },
            ],
          },
        ],
      },
      {
        title: t('cerebro.help.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'warn',
            text: t('cerebro.help.warning.text', 'El endpoint del Pad limita el grafo a unos 1000 nodos y no permite ampliar ese límite: si el banco crece más, vas a ver un recorte y no se dibujarán las aristas hacia ítems que quedaron afuera. La vista es de solo lectura y nunca escribe en el Pad. Además, el latido ambiente solo indica que la escena está viva: no representa actividad.'),
          },
        ],
      },
    ],
  };
}
