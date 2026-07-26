// modules/system/help/skills.js — ayuda contextual de Skills.
import { t } from '../../../ui/i18n.js';

export default function skillsHelp() {
  return {
    title: t('system.help.skills.title', 'Skills'),
    icon: 'sparkle',
    intro: t('system.help.skills.intro', 'Este panel inventaría las instrucciones especializadas disponibles para Claude Code y las cruza con los playbooks de Pad. Es un censo deliberadamente de solo lectura y no consume tokens.'),
    sections: [
      {
        title: t('system.help.skills.first.title', 'Primeros pasos'),
        blocks: [{
          type: 'steps',
          items: [
            t('system.help.skills.first.step1', 'Abrí el mundo que querés revisar: Mi Consola, Tolkien o Global.'),
            t('system.help.skills.first.step2', 'Tocá una skill para ver su descripción, argumentos, herramientas y archivo real.'),
            t('system.help.skills.first.step3', 'Mirá el badge para saber si su playbook de Pad existe y está vinculado.'),
            t('system.help.skills.first.step4', 'Revisá Candidatos de Pad para ver playbooks activos que todavía no tienen SKILL.md.'),
          ],
        }],
      },
      {
        title: t('system.help.skills.legend.title', 'Leyenda'),
        wide: true,
        blocks: [{
          type: 'legend',
          items: [
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
          text: t('system.help.skills.warning.text', 'Todo el panel es read-only y usa 0 tokens a propósito. Si Pad local está caído, las skills igual aparecen, pero sin estado confiable de vínculo.'),
        }],
      },
    ],
  };
}
