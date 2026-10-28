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
              t('forja.help.first.step1', 'Desplegá La Forja desde su fila al final de la barra lateral. La consola recuerda si la dejaste abierta o cerrada.'),
              t('forja.help.first.step2', 'Si todavía no participás, elegí “Forjá tu ficha”. Escribí tu @usuario de GitHub: verificamos que exista y guardamos la capitalización canónica.'),
              t('forja.help.first.stepChangeLogin', '¿Pusiste mal tu usuario? Abrí La Forja y tocá @tu-usuario → Cambiar usuario de GitHub. La ficha se vuelve a forjar sin reiniciar nada.'),
              t('forja.help.first.step3', 'Cambiá a Arena para ver el podio y las misiones de la temporada actual.'),
            ],
          },
        ],
      },
      {
        title: t('forja.help.festejos.title', 'Festejos de merge y producción'),
        blocks: [
          {
            type: 'note',
            tone: 'info',
            text: t('forja.help.festejos.text', 'La Forja festeja dos hitos privados: cuando tu PR se mergea y cuando ese anillo llega en un deploy exitoso de producción. Un deploy agrupa todos tus PRs incluidos. El overlay aparece incluso en móvil con el drawer cerrado; se cierra solo a los 12 segundos salvo mientras interactuás, y cualquier cierre lo marca como visto.'),
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
              { icon: 'upload', name: t('forja.help.legend.production.name', 'Producción'), desc: t('forja.help.legend.production.desc', 'un deploy exitoso que ya incluye uno o más de tus anillos') },
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
              { k: t('forja.help.actions.configure.k', 'Forjar mi ficha'), v: t('forja.help.actions.configure.v', 'Valida que tu @usuario exista en GitHub, guarda el login canónico sin alterar nombre, email ni firma, y pide un refresco. No usa tokens.') },
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
