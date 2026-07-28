// modules/system/help/skills.js — ayuda contextual de Skills.
import { t } from '../../../ui/i18n.js';

export default function skillsHelp() {
  return {
    title: t('system.help.skills.title', 'Skills'),
    icon: 'sparkle',
    intro: t('system.help.skills.intro', 'Este panel combina un catálogo de skills compartidas que podés instalar en tu espacio con el censo informativo de Claude Code y sus vínculos con los playbooks de Pad. Todo es determinístico y no consume tokens.'),
    sections: [
      {
        title: t('system.help.skills.first.title', 'Primeros pasos'),
        blocks: [{
          type: 'steps',
          items: [
            t('system.help.skills.first.step1', 'Desplegá 📦 Catálogo para ver cuántas skills están disponibles, instaladas o pendientes de actualización.'),
            t('system.help.skills.first.step2', 'Abrí una tarjeta y elegí Instalar, Actualizar o Quitar según su estado.'),
            t('system.help.skills.first.step3', 'Después de instalar o actualizar, reiniciá las sesiones de chat que necesiten usar esa skill.'),
            t('system.help.skills.first.step4', 'Para auditar lo que existe, abrí el mundo del censo que querés revisar: Mi Consola, Tolkien o Global.'),
            t('system.help.skills.first.step5', 'Revisá Candidatos de Pad para ver playbooks activos que todavía no tienen SKILL.md.'),
          ],
        }],
      },
      {
        title: t('system.help.skills.legend.title', 'Leyenda'),
        wide: true,
        blocks: [{
          type: 'legend',
          items: [
            { emoji: t('system.help.skills.legend.catalog.emoji', '📦'), name: t('system.help.skills.legend.catalog.name', 'Catálogo'), desc: t('system.help.skills.legend.catalog.desc', 'skills compartidas por Mi Consola que podés copiar a tu espacio') },
            { emoji: t('system.help.skills.legend.installed.emoji', '✅'), name: t('system.help.skills.legend.installed.name', 'Instalada'), desc: t('system.help.skills.legend.installed.desc', 'tu copia coincide con la versión actual del catálogo') },
            { emoji: t('system.help.skills.legend.outdated.emoji', '⬆️'), name: t('system.help.skills.legend.outdated.name', 'Actualización'), desc: t('system.help.skills.legend.outdated.desc', 'hay una versión más nueva lista para copiar') },
            { emoji: t('system.help.skills.legend.notInstalled.emoji', '⬜'), name: t('system.help.skills.legend.notInstalled.name', 'No instalada'), desc: t('system.help.skills.legend.notInstalled.desc', 'todavía no existe una copia del catálogo en tu espacio') },
            { emoji: t('system.help.skills.legend.default.emoji', '⭐'), name: t('system.help.skills.legend.default.name', 'Predeterminada'), desc: t('system.help.skills.legend.default.desc', 'se instala automáticamente a los usuarios nuevos') },
            { emoji: t('system.help.skills.legend.console.emoji', '🏠'), name: t('system.help.skills.legend.console.name', 'Mi Consola'), desc: t('system.help.skills.legend.console.desc', 'skills del repositorio de esta consola') },
            { emoji: t('system.help.skills.legend.tolkien.emoji', '🌳'), name: t('system.help.skills.legend.tolkien.name', 'Tolkien'), desc: t('system.help.skills.legend.tolkien.desc', 'skills del proyecto Tolkien, leídas sin modificarlo') },
            { emoji: t('system.help.skills.legend.global.emoji', '🌐'), name: t('system.help.skills.legend.global.name', 'Global'), desc: t('system.help.skills.legend.global.desc', 'skills personales disponibles para todos tus proyectos') },
            { emoji: t('system.help.skills.legend.linked.emoji', '✅'), name: t('system.help.skills.legend.linked.name', 'Vinculada'), desc: t('system.help.skills.legend.linked.desc', 'el PLAYB-n referenciado existe en Pad') },
            { emoji: t('system.help.skills.legend.broken.emoji', '⚠'), name: t('system.help.skills.legend.broken.name', 'Ref rota'), desc: t('system.help.skills.legend.broken.desc', 'el SKILL.md nombra un playbook que no se encontró') },
            { emoji: t('system.help.skills.legend.none.emoji', '—'), name: t('system.help.skills.legend.none.name', 'Sin Pad'), desc: t('system.help.skills.legend.none.desc', 'la skill no declara playbook; es informativo, no un problema') },
            { emoji: t('system.help.skills.legend.candidate.emoji', '🆕'), name: t('system.help.skills.legend.candidate.name', 'Candidato'), desc: t('system.help.skills.legend.candidate.desc', 'playbook activo con invocation_slug que aún no tiene SKILL.md') },
          ],
        }],
      },
      {
        title: t('system.help.skills.buttons.title', 'Botones y acciones'),
        blocks: [{
          type: 'kv',
          items: [
            { k: t('system.help.skills.buttons.catalog.k', '📦 Catálogo'), v: t('system.help.skills.buttons.catalog.v', 'Expande o contrae la lista accionable; el encabezado resume sus tres estados.') },
            { k: t('system.help.skills.buttons.install.k', 'Instalar'), v: t('system.help.skills.buttons.install.v', 'Copia la skill del catálogo a tu espacio personal. No consume tokens.') },
            { k: t('system.help.skills.buttons.update.k', 'Actualizar'), v: t('system.help.skills.buttons.update.v', 'Reemplaza tu copia administrada por la versión actual del catálogo. No consume tokens.') },
            { k: t('system.help.skills.buttons.remove.k', 'Quitar'), v: t('system.help.skills.buttons.remove.v', 'Pide confirmación y borra únicamente tu copia administrada por el catálogo.') },
            { k: t('system.help.skills.buttons.world.k', 'Grupo de mundo'), v: t('system.help.skills.buttons.world.v', 'Expande o contrae el inventario de ese origen.') },
            { k: t('system.help.skills.buttons.card.k', 'Tarjeta de skill'), v: t('system.help.skills.buttons.card.v', 'Muestra descripción, argumentos, herramientas permitidas, vínculo con Pad y ruta del SKILL.md.') },
            { k: t('system.help.skills.buttons.candidates.k', 'Candidatos de Pad'), v: t('system.help.skills.buttons.candidates.v', 'Despliega los playbooks aptos para una futura skill. No crea ni edita nada.') },
          ],
        }],
      },
      {
        title: t('system.help.skills.warning.title', 'Ojo con esto'),
        blocks: [{
          type: 'note',
          tone: 'warn',
          text: t('system.help.skills.warning.text', 'Instalar copia la skill solo a TU espacio y no afecta a otros usuarios. Si ya tenés una skill propia con el mismo nombre, Mi Consola nunca la pisa ni la borra. Las sesiones abiertas cargaron sus skills al nacer: reinicialas para que tomen una instalación o actualización nueva. Si Pad local está caído, el censo igual aparece, pero sin estado confiable de vínculo.'),
        }],
      },
    ],
  };
}
