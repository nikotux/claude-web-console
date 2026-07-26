// modules/system/help/language.js — ayuda contextual de Idioma.
import { t } from '../../../ui/i18n.js';

export default function languageHelp() {
  return {
    title: t('system.help.language.title', 'Idioma'),
    icon: 'gear',
    intro: t('system.help.language.intro', 'Elegís el idioma que ve tu propia cuenta, sin cambiarle la consola a nadie más. Al cambiarlo, la página se recarga para aplicar la preferencia.'),
    sections: [
      {
        title: t('system.help.language.first.title', 'Primeros pasos'),
        blocks: [{
          type: 'steps',
          items: [
            t('system.help.language.first.step1', 'Mirá cuál opción tiene la marca de idioma actual.'),
            t('system.help.language.first.step2', 'Tocá Español o English.'),
            t('system.help.language.first.step3', 'Confirmá la recarga de la página.'),
            t('system.help.language.first.step4', 'Volvé a la misma sección después de la recarga si querés comprobar la selección.'),
          ],
        }],
      },
      {
        title: t('system.help.language.legend.title', 'Leyenda'),
        blocks: [{
          type: 'legend',
          items: [
            { emoji: t('system.help.language.legend.es.emoji', '🇪🇸'), name: t('system.help.language.legend.es.name', 'Español'), desc: t('system.help.language.legend.es.desc', 'usa los textos españoles incluidos en la interfaz') },
            { emoji: t('system.help.language.legend.en.emoji', '🇬🇧'), name: t('system.help.language.legend.en.name', 'English'), desc: t('system.help.language.legend.en.desc', 'usa el diccionario inglés cuando existe una traducción') },
            { icon: 'check', name: t('system.help.language.legend.current.name', 'Idioma actual'), desc: t('system.help.language.legend.current.desc', 'la opción marcada es la preferencia guardada para tu cuenta') },
          ],
        }],
      },
      {
        title: t('system.help.language.buttons.title', 'Botones y acciones'),
        blocks: [{
          type: 'kv',
          items: [
            { k: t('system.help.language.buttons.spanish.k', 'Español'), v: t('system.help.language.buttons.spanish.v', 'Guarda español como preferencia personal y recarga la página.') },
            { k: t('system.help.language.buttons.english.k', 'English'), v: t('system.help.language.buttons.english.v', 'Guarda inglés como preferencia personal y recarga la página.') },
            { k: t('system.help.language.buttons.confirm.k', 'Confirmar'), v: t('system.help.language.buttons.confirm.v', 'Aplica el cambio; no requiere permisos de administrador.') },
          ],
        }],
      },
      {
        title: t('system.help.language.warning.title', 'Ojo con esto'),
        blocks: [{
          type: 'note',
          tone: 'warn',
          text: t('system.help.language.warning.text', 'La traducción al inglés todavía está incompleta. Cuando falta una clave, ese texto cae solo al español y la pantalla sigue funcionando.'),
        }],
      },
    ],
  };
}
