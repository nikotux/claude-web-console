// modules/stats/help.js — contenido contextual de ayuda para Estado del server.
//
// Este widget no tiene una cabecera propia: el tema se descubre desde el hub
// general de ayuda, sin forzar un botón dentro de la fila compacta.
import { t } from '../../ui/i18n.js';

export default function statsHelp() {
  return {
    title: t('stats.help.title', 'Estado del server'),
    icon: 'gear',
    intro: t('stats.help.intro', 'Estado del server muestra cuánta CPU, memoria y capacidad de disco está usando la máquina que corre la consola. Es un vistazo rápido para detectar presión sostenida antes de que la experiencia se vuelva lenta o inestable.'),
    sections: [
      {
        title: t('stats.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('stats.help.first.step1', 'Buscá CPU, RAM y DSK en el pie de la barra derecha.'),
              t('stats.help.first.step2', 'Leé el porcentaje y el color de cada barra; con el rail colapsado, mirá el relleno de los anillos-ícono.'),
              t('stats.help.first.step3', 'Pasá el cursor por el widget para ver hostname, RAM usada y total, carga y tiempo encendido.'),
              t('stats.help.first.step4', 'Prestá atención a valores ámbar o rojos que se mantengan durante varios refrescos, no a un pico aislado.'),
            ],
          },
        ],
      },
      {
        title: t('stats.help.legend.title', 'Leyenda'),
        blocks: [
          {
            type: 'legend',
            items: [
              {
                icon: 'cpu',
                name: t('stats.help.legend.cpu.name', 'CPU'),
                desc: t('stats.help.legend.cpu.desc', 'porcentaje de trabajo del procesador en ese momento; un pico corto puede ser normal'),
              },
              {
                icon: 'ram',
                name: t('stats.help.legend.ram.name', 'RAM'),
                desc: t('stats.help.legend.ram.desc', 'memoria realmente ocupada según la memoria disponible del sistema'),
              },
              {
                icon: 'disk',
                name: t('stats.help.legend.disk.name', 'DSK'),
                desc: t('stats.help.legend.disk.desc', 'porcentaje de capacidad usada en el disco donde vive la consola'),
              },
              {
                emoji: t('stats.help.legend.low.emoji', '🟢'),
                name: t('stats.help.legend.low.name', 'Menos de 60%'),
                desc: t('stats.help.legend.low.desc', 'zona tranquila según el criterio del widget'),
              },
              {
                emoji: t('stats.help.legend.mid.emoji', '🟡'),
                name: t('stats.help.legend.mid.name', '60% a 84%'),
                desc: t('stats.help.legend.mid.desc', 'conviene observar si se sostiene o sigue subiendo'),
              },
              {
                emoji: t('stats.help.legend.high.emoji', '🔴'),
                name: t('stats.help.legend.high.name', '85% o más'),
                desc: t('stats.help.legend.high.desc', 'presión alta; en disco es especialmente urgente liberar espacio'),
              },
            ],
          },
        ],
      },
      {
        title: t('stats.help.buttons.title', 'Botones y acciones'),
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('stats.help.buttons.hover.k', 'Pasar el cursor'),
                v: t('stats.help.buttons.hover.v', 'Muestra datos complementarios del host. El widget se refresca solo cada 2,5 segundos, no tiene botones y no consume tokens.'),
              },
            ],
          },
        ],
      },
      {
        title: t('stats.help.cpuDelta.title', 'Cómo se mide la CPU'),
        blocks: [
          {
            type: 'note',
            tone: 'info',
            text: t('stats.help.cpuDelta.text', 'CPU es el cambio entre dos lecturas globales del servidor: la primera lectura después de arrancar da 0%. El widget (/api/stats) y el chequeo de salud comparten la lectura anterior, así que cualquiera de los dos puede mover el punto de comparación del siguiente valor.'),
          },
        ],
      },
      {
        title: t('stats.help.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'warn',
            text: t('stats.help.warning.text', 'Estos anillos miden recursos de la máquina, no consumo de tokens: eso vive en Uso y tokens. Un pico breve de CPU suele ser normal; preocupate por rojo sostenido, RAM que no baja o disco cerca del límite.'),
          },
        ],
      },
    ],
  };
}
