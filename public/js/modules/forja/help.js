import { t } from '../../ui/i18n.js';

export default function forjaHelp() {
  return {
    title: t('forja.help.title', 'La Forja'),
    icon: 'flame',
    intro: t('forja.help.intro', 'La Forja convierte tus pull requests mergeados en Tolkien en una ficha de personaje, un recorrido privado y una arena mensual. El cálculo es determinístico y no usa IA.'),
    sections: [
      {
        title: t('forja.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('forja.help.first.step1', 'Si todavía no participás, elegí “Forjá tu ficha” y guardá tu login de GitHub.'),
              t('forja.help.first.step2', 'Abrí la ficha para entrar a Mi salón, donde están tu impacto, crónica, trofeos y anillos recientes.'),
              t('forja.help.first.step3', 'Cambiá a Arena para ver el podio y las misiones de la temporada actual.'),
            ],
          },
        ],
      },
      {
        title: t('forja.help.festejos.title', 'Festejos de merge'),
        blocks: [
          {
            type: 'note',
            tone: 'info',
            text: t('forja.help.festejos.text', 'Cuando La Forja detecta un PR nuevo mergeado, muestra un festejo privado en una pestaña visible. Se cierra solo a los 12 segundos, salvo mientras interactuás con él; también podés cerrarlo con un clic, Escape o el botón de cierre. Cualquier cierre lo marca como visto. Si hay varios, aparecen en orden y el badge +N indica cuántos esperan.'),
          },
        ],
      },
      {
        title: t('forja.help.legend.title', 'Leyenda'),
        blocks: [
          {
            type: 'legend',
            items: [
              { icon: 'flame', name: t('forja.help.legend.ring.name', 'Anillo'), desc: t('forja.help.legend.ring.desc', 'un PR mergeado en Tolkien') },
              { icon: 'trophy', name: t('forja.help.legend.trophy.name', 'Trofeo'), desc: t('forja.help.legend.trophy.desc', 'un logro forjado o un objetivo en progreso') },
              { icon: 'swords', name: t('forja.help.legend.arena.name', 'Arena'), desc: t('forja.help.legend.arena.desc', 'ranking mensual basado en anillos de la temporada') },
              { icon: 'lock', name: t('forja.help.legend.private.name', 'Privado'), desc: t('forja.help.legend.private.desc', 'los títulos y detalles de tus PRs solo aparecen en tu salón') },
            ],
          },
        ],
      },
      {
        title: t('forja.help.actions.title', 'Botones y acciones'),
        blocks: [
          {
            type: 'kv',
            items: [
              { k: t('forja.help.actions.enter.k', 'Entrar a la Forja'), v: t('forja.help.actions.enter.v', 'Abre el salón privado. No usa tokens.') },
              { k: t('forja.help.actions.tabs.k', 'Mi salón / Arena'), v: t('forja.help.actions.tabs.v', 'Alterna entre tu recorrido privado y las métricas públicas de la temporada. No usa tokens.') },
              { k: t('forja.help.actions.configure.k', 'Forjar mi ficha'), v: t('forja.help.actions.configure.v', 'Guarda tu login de GitHub sin alterar nombre, email ni firma, y pide un refresco de tus datos. No usa tokens.') },
            ],
          },
        ],
      },
      {
        title: t('forja.help.privacy.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'warn',
            text: t('forja.help.privacy.text', 'La participación es voluntaria. La Arena comparte nombre visible, iniciales y métricas agregadas; nunca publica tu login, títulos ni URLs de PR. Si aparece “datos de hace…”, estás viendo el último snapshot bueno mientras GitHub se recupera.'),
          },
        ],
      },
    ],
  };
}
