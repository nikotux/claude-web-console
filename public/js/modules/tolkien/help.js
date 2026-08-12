// modules/tolkien/help.js — contenido contextual de ayuda para Tolkien.
//
// Exporta una función para que todos los textos pasen por t() al abrir el tema
// y reflejen el idioma ya inicializado de la consola.
import { t } from '../../ui/i18n.js';

export default function tolkienHelp() {
  return {
    title: t('tolkien.help.title', 'Tolkien'),
    icon: 'gitBranch',
    intro: t('tolkien.help.intro', 'Tolkien muestra de un vistazo si tu copia local está al día con GitHub y qué trabajo sigue abierto. También reúne accesos a la app y los entornos aislados de cada sesión.'),
    sections: [
      {
        title: t('tolkien.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('tolkien.help.first.step1', 'Mirá el punto de color y el texto de main para saber si hay cambios nuevos por traer.'),
              t('tolkien.help.first.step2', 'Tocá Buscar cambios para consultar GitHub sin modificar tu código local.'),
              t('tolkien.help.first.step3', 'Si aparece ↓N main, tocá Actualizar y confirmá para adelantar tu main local.'),
              t('tolkien.help.first.step4', 'Desplegá Entornos de sesión: cada entorno efímero combina un worktree, una DB clonada y un dev-server systemd propio de esa sesión.'),
              t('tolkien.help.first.step5', 'Tocá entrar en el entorno que necesitás o usá Tolkien local para abrir la base compartida.'),
            ],
          },
        ],
      },
      {
        title: t('tolkien.help.access.title', 'Acceso y chequeos automáticos'),
        blocks: [
          {
            type: 'note',
            tone: 'info',
            text: t('tolkien.help.access.text', 'Cada usuario ve el estado, hace fetch, actualiza y gestiona ramas sobre su propio clon. Vista fresca, Entornos de sesión y Tolkien local son sólo para administradores. Los chequeos automáticos fallan en silencio; sólo Buscar cambios muestra un error si la consulta manual falla.'),
          },
        ],
      },
      {
        title: t('tolkien.help.legend.title', 'Leyenda del pulso'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              {
                emoji: t('tolkien.help.legend.green.emoji', '🟢'),
                name: t('tolkien.help.legend.green.name', 'Main al día'),
                desc: t('tolkien.help.legend.green.desc', 'tu main local ya contiene lo último de origin/main'),
              },
              {
                emoji: t('tolkien.help.legend.amber.emoji', '🟡'),
                name: t('tolkien.help.legend.amber.name', 'Hay cambios por traer'),
                desc: t('tolkien.help.legend.amber.desc', 'GitHub tiene commits de main que tu main local todavía no tiene'),
              },
              {
                emoji: t('tolkien.help.legend.sha.emoji', '#'),
                name: t('tolkien.help.legend.sha.name', 'Versión'),
                desc: t('tolkien.help.legend.sha.desc', 'SHA corto del commit actual; se puede tocar para copiarlo'),
              },
              {
                icon: 'gitBranch',
                name: t('tolkien.help.legend.branch.name', 'Rama'),
                desc: t('tolkien.help.legend.branch.desc', 'aparece cuando estás en una rama distinta de main; el mismo ícono identifica PRs y entornos'),
              },
              {
                emoji: t('tolkien.help.legend.behind.emoji', '↓N'),
                name: t('tolkien.help.legend.behind.name', 'Por traer'),
                desc: t('tolkien.help.legend.behind.desc', 'cantidad de commits que le faltan a tu main local'),
              },
              {
                emoji: t('tolkien.help.legend.prBehind.emoji', '⚠'),
                name: t('tolkien.help.legend.prBehind.name', 'PR atrasado'),
                desc: t('tolkien.help.legend.prBehind.desc', 'al menos una rama con PR abierto quedó detrás de main'),
              },
              {
                emoji: t('tolkien.help.legend.envError.emoji', '⚠️'),
                name: t('tolkien.help.legend.envError.name', 'Entorno con error'),
                desc: t('tolkien.help.legend.envError.desc', 'falló alguna parte del worktree, la DB clonada o el dev-server'),
              },
              {
                emoji: t('tolkien.help.legend.envDown.emoji', '💤'),
                name: t('tolkien.help.legend.envDown.name', 'Entorno apagado'),
                desc: t('tolkien.help.legend.envDown.desc', 'el entorno existe, pero su dev-server no está sirviendo'),
              },
            ],
          },
        ],
      },
      {
        title: t('tolkien.help.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('tolkien.help.buttons.version.k', '#versión'),
                v: t('tolkien.help.buttons.version.v', 'Copia el SHA corto del commit actual al portapapeles.'),
              },
              {
                k: t('tolkien.help.buttons.fetch.k', 'Buscar cambios (fetch)'),
                v: t('tolkien.help.buttons.fetch.v', 'Hace fetch y vuelve a medir el remoto; no adelanta main ni modifica tu árbol de trabajo.'),
              },
              {
                k: t('tolkien.help.buttons.update.k', 'Actualizar'),
                v: t('tolkien.help.buttons.update.v', 'Trae lo último de GitHub y deja tu main local al día; también intenta rebasar los entornos vivos, salvo los que tengan cambios sin commitear.'),
              },
              {
                k: t('tolkien.help.buttons.fresh.k', 'Vista fresca'),
                v: t('tolkien.help.buttons.fresh.v', 'Borra los datos operativos de la DB local, los reimporta desde Zoho y refresca la plantilla y las DB clonadas. No toca producción ni el código.'),
              },
              {
                k: t('tolkien.help.buttons.prs.k', 'PRs sin mergear'),
                v: t('tolkien.help.buttons.prs.v', 'Abre tus PRs pendientes; Poner al día sólo aparece para la rama actual cuando necesita rebase.'),
              },
              {
                k: t('tolkien.help.buttons.local.k', 'Tolkien local'),
                v: t('tolkien.help.buttons.local.v', 'Abre el entorno base local con la sesión de desarrollo inyectada.'),
              },
              {
                k: t('tolkien.help.buttons.official.k', 'Tolkien oficial'),
                v: t('tolkien.help.buttons.official.v', 'Abre la aplicación de producción en una pestaña nueva.'),
              },
              {
                k: t('tolkien.help.buttons.pad.k', 'GetPad local'),
                v: t('tolkien.help.buttons.pad.v', 'Abre el Pad local; es sólo un atajo y no cruza datos con Tolkien.'),
              },
              {
                k: t('tolkien.help.buttons.envs.k', 'Entornos de sesión'),
                v: t('tolkien.help.buttons.envs.v', 'Despliega los entornos efímeros y muestra rama, puerto y estado de cada uno.'),
              },
              {
                k: t('tolkien.help.buttons.enter.k', 'Entrar'),
                v: t('tolkien.help.buttons.enter.v', 'Abre el dev-server del entorno elegido y reinyecta su acceso local.'),
              },
              {
                k: t('tolkien.help.buttons.close.k', 'Cerrar entorno'),
                v: t('tolkien.help.buttons.close.v', 'Detiene el dev-server, borra su DB clonada y elimina el worktree; pide una confirmación extra si hay cambios sin commitear.'),
              },
            ],
          },
        ],
      },
      {
        title: t('tolkien.help.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'danger',
            text: t('tolkien.help.warning.text', 'Actualizar adelanta tu main LOCAL aunque estés parado en una rama feature. Vista fresca reemplaza los datos operativos locales con un snapshot de Zoho, y forzar el cierre de un entorno descarta sus cambios sin commitear. Ninguna de estas acciones consume tokens de IA.'),
          },
        ],
      },
    ],
  };
}
