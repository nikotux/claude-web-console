// modules/system/help/dashboard.js — ayuda contextual del Dashboard.
import { t } from '../../../ui/i18n.js';

export default function dashboardHelp() {
  return {
    title: t('system.help.dashboard.title', 'Dashboard'),
    icon: 'pulse',
    intro: t('system.help.dashboard.intro', 'Es una foto gratuita del servidor, el código y el trabajo rastreado en Pad. Sirve para orientarte y detectar huecos de registro sin lanzar ningún análisis de IA.'),
    sections: [
      {
        title: t('system.help.dashboard.first.title', 'Primeros pasos'),
        blocks: [{
          type: 'steps',
          items: [
            t('system.help.dashboard.first.step1', 'Revisá arriba CPU, RAM, disco, carga y uptime del servidor.'),
            t('system.help.dashboard.first.step2', 'Abrí Pad local para ver colecciones e ítems vivos.'),
            t('system.help.dashboard.first.step3', 'Abrí Backend y Frontend para comprobar qué módulos existen y cómo se montan.'),
            t('system.help.dashboard.first.step4', 'Abrí Runners y Motores IA si necesitás ubicar procesos o modelos.'),
            t('system.help.dashboard.first.step5', 'Tocá Re-escanear ahora para regenerar la foto cuando cambió el proyecto.'),
          ],
        }],
      },
      {
        title: t('system.help.dashboard.legend.title', 'Leyenda'),
        wide: true,
        blocks: [{
          type: 'legend',
          items: [
            { emoji: t('system.help.dashboard.legend.green.emoji', '🟢'), name: t('system.help.dashboard.legend.green.name', 'Registrado / normal'), desc: t('system.help.dashboard.legend.green.desc', 'el módulo está conectado o el recurso está en rango sano') },
            { emoji: t('system.help.dashboard.legend.yellow.emoji', '🟡'), name: t('system.help.dashboard.legend.yellow.name', 'Atención'), desc: t('system.help.dashboard.legend.yellow.desc', 'hay un módulo sin registrar o un recurso en zona de aviso') },
            { emoji: t('system.help.dashboard.legend.gray.emoji', '⚪'), name: t('system.help.dashboard.legend.gray.name', 'Montaje manual'), desc: t('system.help.dashboard.legend.gray.desc', 'el frontend se monta desde código y no con data-module') },
            { emoji: t('system.help.dashboard.legend.backend.emoji', '🧩'), name: t('system.help.dashboard.legend.backend.name', 'Backend'), desc: t('system.help.dashboard.legend.backend.desc', 'módulos del servidor, endpoints y registro') },
            { emoji: t('system.help.dashboard.legend.frontend.emoji', '🖥'), name: t('system.help.dashboard.legend.frontend.name', 'Frontend'), desc: t('system.help.dashboard.legend.frontend.desc', 'módulos visibles del navegador') },
            { emoji: t('system.help.dashboard.legend.runner.emoji', '🏃'), name: t('system.help.dashboard.legend.runner.name', 'Runners'), desc: t('system.help.dashboard.legend.runner.desc', 'procesos desacoplados que sobreviven reinicios de la web') },
            { emoji: t('system.help.dashboard.legend.ai.emoji', '🤖'), name: t('system.help.dashboard.legend.ai.name', 'Motores IA'), desc: t('system.help.dashboard.legend.ai.desc', 'puntos del proyecto que invocan modelos') },
            { emoji: t('system.help.dashboard.legend.pad.emoji', '🗂️'), name: t('system.help.dashboard.legend.pad.name', 'Pad local'), desc: t('system.help.dashboard.legend.pad.desc', 'backbone de colecciones del workspace console') },
          ],
        }],
      },
      {
        title: t('system.help.dashboard.buttons.title', 'Botones y acciones'),
        blocks: [{
          type: 'kv',
          items: [
            { k: t('system.help.dashboard.buttons.groups.k', 'Secciones desplegables'), v: t('system.help.dashboard.buttons.groups.v', 'Muestran tablas de módulos, runners, motores y Pad sin cambiar nada.') },
            { k: t('system.help.dashboard.buttons.rescan.k', 'Re-escanear ahora'), v: t('system.help.dashboard.buttons.rescan.v', 'Regenera el inventario y la foto de recursos. No consume tokens y no requiere admin.') },
          ],
        }],
      },
      {
        title: t('system.help.dashboard.warning.title', 'Ojo con esto'),
        blocks: [{
          type: 'note',
          tone: 'warn',
          text: t('system.help.dashboard.warning.text', 'El Dashboard es informativo: no arregla registros ni recursos. Si Pad local no responde, muestra la degradación de tareas, aprendizaje, mejora continua y metadatos de tickets, pero el resto del censo sigue disponible.'),
        }],
      },
    ],
  };
}
