// modules/system/help/news.js — ayuda contextual de Novedades.
import { t } from '../../../ui/i18n.js';

export default function newsHelp() {
  return {
    title: t('system.help.news.title', 'Novedades'),
    icon: 'sparkle',
    intro: t('system.help.news.intro', 'Este changelog cuenta qué mejoró en Mi Consola con lenguaje cotidiano y, sobre todo, cómo probar cada cambio por tu cuenta.'),
    sections: [
      {
        title: t('system.help.news.first.title', 'Primeros pasos'),
        blocks: [{
          type: 'steps',
          items: [
            t('system.help.news.first.step1', 'Abrí una de las tarjetas destacadas como nueva; las tres más recientes no leídas ya aparecen desplegadas.'),
            t('system.help.news.first.step2', 'Leé el resumen y las viñetas para entender qué cambió.'),
            t('system.help.news.first.step3', 'Seguí en orden el bloque 🧪 Probalo así para comprobar la función.'),
            t('system.help.news.first.step4', 'Si querés contexto de desarrollo, desplegá Detalle técnico al final de la tarjeta.'),
          ],
        }],
      },
      {
        title: t('system.help.news.legend.title', 'Leyenda'),
        wide: true,
        blocks: [{
          type: 'legend',
          items: [
            { emoji: t('system.help.news.legend.unread.emoji', '🆕'), name: t('system.help.news.legend.unread.name', 'No leída'), desc: t('system.help.news.legend.unread.desc', 'se publicó después de tu última visita a esta sección') },
            { emoji: t('system.help.news.legend.new.emoji', '✨'), name: t('system.help.news.legend.new.name', 'Nuevo'), desc: t('system.help.news.legend.new.desc', 'una función que antes no estaba disponible') },
            { emoji: t('system.help.news.legend.improvement.emoji', '🔧'), name: t('system.help.news.legend.improvement.name', 'Mejora'), desc: t('system.help.news.legend.improvement.desc', 'una función existente ahora resulta más útil, clara o rápida') },
            { emoji: t('system.help.news.legend.fix.emoji', '🐞'), name: t('system.help.news.legend.fix.name', 'Arreglo'), desc: t('system.help.news.legend.fix.desc', 'un problema conocido quedó corregido') },
            { emoji: t('system.help.news.legend.try.emoji', '🧪'), name: t('system.help.news.legend.try.name', 'Probalo así'), desc: t('system.help.news.legend.try.desc', 'pasos concretos y ordenados para experimentar el cambio') },
            { emoji: t('system.help.news.legend.hidden.emoji', '🙈'), name: t('system.help.news.legend.hidden.name', 'Oculta'), desc: t('system.help.news.legend.hidden.desc', 'solo los administradores ven esta entrada mientras no esté publicada') },
          ],
        }],
      },
      {
        title: t('system.help.news.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [{
          type: 'kv',
          items: [
            { k: t('system.help.news.buttons.card.k', 'Tarjeta de novedad'), v: t('system.help.news.buttons.card.v', 'Expande o contrae el resumen, los pasos de prueba y el detalle técnico. No consume tokens.') },
            { k: t('system.help.news.buttons.tech.k', 'Detalle técnico'), v: t('system.help.news.buttons.tech.v', 'Muestra commits y archivos relacionados; nace cerrado y no consume tokens.') },
            { k: t('system.help.news.buttons.generate.k', '✍️ Redactar ahora'), v: t('system.help.news.buttons.generate.v', 'Pide a la IA que redacte nuevas entradas a partir del progreso reciente. CONSUME TOKENS y es admin-only.') },
            { k: t('system.help.news.buttons.edit.k', '✏️ Editar'), v: t('system.help.news.buttons.edit.v', 'Cambia emoji, categoría, título, resumen, viñetas y pasos. No consume tokens y es admin-only.') },
            { k: t('system.help.news.buttons.hide.k', '🙈 Ocultar / 👁 Mostrar'), v: t('system.help.news.buttons.hide.v', 'Retira o publica una entrada para el resto de los usuarios. No consume tokens y es admin-only.') },
            { k: t('system.help.news.buttons.delete.k', '🗑️ Borrar'), v: t('system.help.news.buttons.delete.v', 'Pide confirmación y elimina la entrada. No consume tokens y es admin-only.') },
          ],
        }],
      },
      {
        title: t('system.help.news.warning.title', 'Ojo con esto'),
        blocks: [{
          type: 'note',
          tone: 'warn',
          text: t('system.help.news.warning.text', 'Entrar a Novedades marca como vistas las publicaciones pendientes y apaga el badge, aunque no abras todas las tarjetas. Ocultar conserva la entrada para que un administrador pueda revisarla; Borrar la elimina definitivamente. La redacción automática puede tardar: el Pac-Man indica que el trabajo sigue en curso.'),
        }],
      },
    ],
  };
}
