// modules/system/help/projects.js — ayuda contextual de Proyectos.
import { t } from '../../../ui/i18n.js';

export default function projectsHelp() {
  return {
    title: t('system.help.projects.title', 'Proyectos'),
    icon: 'folder',
    intro: t('system.help.projects.intro', 'Esta pantalla abre el contexto y las memorias reales que Claude Code usa en cada proyecto. La navegación es lista → detalle, y cada cambio guardado puede modificar cómo se comporta la próxima sesión.'),
    sections: [
      {
        title: t('system.help.projects.first.title', 'Primeros pasos'),
        blocks: [{
          type: 'steps',
          items: [
            t('system.help.projects.first.step1', 'Elegí una tarjeta de proyecto, contexto de Tickets o personalización.'),
            t('system.help.projects.first.step2', 'En el detalle, abrí la sección de CLAUDE.md o la memoria que querés revisar.'),
            t('system.help.projects.first.step3', 'Tocá el lápiz para editar solo esa sección o nota.'),
            t('system.help.projects.first.step4', 'Al editar una sección de CLAUDE.md, revisá el análisis con IA y tocá Confirmar y guardar solo si es correcto. Las memorias, contextos, hooks y preferencias tienen guardado directo.'),
            t('system.help.projects.first.step5', 'Usá ‹ Proyectos para volver a la lista y elegir otra entrada.'),
          ],
        }],
      },
      {
        title: t('system.help.projects.legend.title', 'Leyenda'),
        blocks: [{
          type: 'legend',
          items: [
            { icon: 'console', name: t('system.help.projects.legend.console.name', 'Mi Consola'), desc: t('system.help.projects.legend.console.desc', 'contexto y memorias reales de esta consola') },
            { icon: 'gitBranch', name: t('system.help.projects.legend.tolkien.name', 'Tolkien / PR'), desc: t('system.help.projects.legend.tolkien.desc', 'proyecto Tolkien o contexto de redacción de pull requests') },
            { icon: 'edit', name: t('system.help.projects.legend.edit.name', 'Texto editable'), desc: t('system.help.projects.legend.edit.desc', 'contexto, nota o identidad que se puede modificar') },
            { icon: 'sparkle', name: t('system.help.projects.legend.personal.name', 'Comportamiento personal'), desc: t('system.help.projects.legend.personal.desc', 'reglas globales que afectan tus sesiones') },
            { icon: 'gear', name: t('system.help.projects.legend.hooks.name', 'Hooks'), desc: t('system.help.projects.legend.hooks.desc', 'automatizaciones personales que se pueden activar o desactivar') },
          ],
        }],
      },
      {
        title: t('system.help.projects.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [{
          type: 'kv',
          items: [
            { k: t('system.help.projects.buttons.card.k', 'Tarjeta de la lista'), v: t('system.help.projects.buttons.card.v', 'Abre el detalle de esa entrada; es el primer nivel de navegación.') },
            { k: t('system.help.projects.buttons.back.k', '‹ Proyectos / Personalización'), v: t('system.help.projects.buttons.back.v', 'Vuelve al nivel anterior sin modificar archivos.') },
            { k: t('system.help.projects.buttons.section.k', 'Editar sección'), v: t('system.help.projects.buttons.section.v', 'Edita solo un fragmento de CLAUDE.md; una revisión IA consume tokens antes de confirmar. Admin-only para proyectos.') },
            { k: t('system.help.projects.buttons.note.k', 'Editar nota'), v: t('system.help.projects.buttons.note.v', 'Abre una memoria real del proyecto. Admin-only.') },
            { k: t('system.help.projects.buttons.index.k', 'Editar índice'), v: t('system.help.projects.buttons.index.v', 'Modifica MEMORY.md, que ordena y describe las notas. Admin-only.') },
            { k: t('system.help.projects.buttons.context.k', 'Editar contexto de Tickets'), v: t('system.help.projects.buttons.context.v', 'Cambia el texto que se inyecta al trabajar tickets o redactar PRs. Admin-only.') },
            { k: t('system.help.projects.buttons.resync.k', 'Re-sincronizar'), v: t('system.help.projects.buttons.resync.v', 'Vuelve a publicar el contexto de Tickets en el espejo local de Tolkien. Admin-only.') },
            { k: t('system.help.projects.buttons.review.k', 'Confirmar y guardar'), v: t('system.help.projects.buttons.review.v', 'Es el único botón del revisor que escribe el cambio; antes muestra lo agregado, quitado y modificado.') },
            { k: t('system.help.projects.buttons.keep.k', 'Seguir editando'), v: t('system.help.projects.buttons.keep.v', 'Cierra la revisión sin guardar y devuelve el texto al editor.') },
            { k: t('system.help.projects.buttons.hooks.k', 'Activar / Desactivar hook'), v: t('system.help.projects.buttons.hooks.v', 'Cambia una automatización de tu espacio personal.') },
            { k: t('system.help.projects.buttons.prefs.k', 'Guardar preferencias'), v: t('system.help.projects.buttons.prefs.v', 'Guarda tus defaults de modelo, esfuerzo y permisos para chats nuevos.') },
          ],
        }],
      },
      {
        title: t('system.help.projects.warning.title', 'Ojo con esto'),
        blocks: [{
          type: 'note',
          tone: 'danger',
          text: t('system.help.projects.warning.text', 'No son copias: guardar acá cambia los CLAUDE.md y las memorias que leerá la próxima sesión de Claude Code. El guard de hash frena el guardado si otra sesión cambió el mismo contenido mientras lo tenías abierto.'),
        }],
      },
    ],
  };
}
