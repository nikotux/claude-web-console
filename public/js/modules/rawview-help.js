// modules/rawview-help.js — ayuda contextual de la Vista Raw.
//
// Mantiene todo texto visible detrás de t() y conserva el tema como función.
import { t } from '../ui/i18n.js';

export default function rawviewHelp() {
  return {
    title: t('rawview.help.title', 'Vista Raw'),
    icon: 'pulse',
    intro: t('rawview.help.intro', 'Vista Raw es un monitor de solo lectura del trabajo que está vivo en la consola. Convierte texto, estados y ritmo de actividad en bandas visuales para que puedas ver qué se mueve en tiempo real.'),
    sections: [
      {
        title: t('rawview.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('rawview.help.first.step1', 'Ubicá cada sesión por el rótulo tenue que aparece arriba de su banda.'),
              t('rawview.help.first.step2', 'Leé tono, matiz, textura y brillo para reconocer mundo, sesión, proveedor y ritmo.'),
              t('rawview.help.first.step3', 'Usá los paneles de texto de cada banda y el feed inferior para leer fragmentos reales.'),
              t('rawview.help.first.step4', 'Mirá el odómetro abajo a la derecha y los latidos de servicios arriba a la derecha.'),
              t('rawview.help.first.step5', 'Cerrá la pestaña con ✕ o Esc cuando termines de observar.'),
            ],
          },
        ],
      },
      {
        title: t('rawview.help.legend.title', 'Leyenda'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              {
                emoji: t('rawview.help.legend.console.emoji', '🖥️'),
                name: t('rawview.help.legend.console.name', 'Tono cálido'),
                desc: t('rawview.help.legend.console.desc', 'mundo Mi Consola'),
              },
              {
                emoji: t('rawview.help.legend.tolkien.emoji', '🌳'),
                name: t('rawview.help.legend.tolkien.name', 'Tono verde'),
                desc: t('rawview.help.legend.tolkien.desc', 'mundo Tolkien'),
              },
              {
                emoji: t('rawview.help.legend.other.emoji', '🤖'),
                name: t('rawview.help.legend.other.name', 'Tono frío'),
                desc: t('rawview.help.legend.other.desc', 'otros mundos o una sesión Codex cuyo mundo no se pudo reconocer'),
              },
              {
                emoji: t('rawview.help.legend.shade.emoji', '◐'),
                name: t('rawview.help.legend.shade.name', 'Matiz'),
                desc: t('rawview.help.legend.shade.desc', 'una variación estable distingue cada sesión dentro del mismo mundo'),
              },
              {
                emoji: t('rawview.help.legend.texture.emoji', '▧'),
                name: t('rawview.help.legend.texture.name', 'Textura'),
                desc: t('rawview.help.legend.texture.desc', 'el texto real hace visible el proveedor: lenguaje de Claude o código de Codex'),
              },
              {
                emoji: t('rawview.help.legend.energy.emoji', '✦'),
                name: t('rawview.help.legend.energy.name', 'Brillo y densidad'),
                desc: t('rawview.help.legend.energy.desc', 'suben con los tokens por segundo; una banda activa cae más rápido y brillante'),
              },
              {
                emoji: t('rawview.help.legend.working.emoji', '▶'),
                name: t('rawview.help.legend.working.name', 'Trabajando'),
                desc: t('rawview.help.legend.working.desc', 'la sesión está ejecutando un turno'),
              },
              {
                emoji: t('rawview.help.legend.delegating.emoji', '⟳'),
                name: t('rawview.help.legend.delegating.name', 'Delegando'),
                desc: t('rawview.help.legend.delegating.desc', 'espera a un subagente o proceso y la banda respira'),
              },
              {
                emoji: t('rawview.help.legend.alive.emoji', '◦'),
                name: t('rawview.help.legend.alive.name', 'Viva'),
                desc: t('rawview.help.legend.alive.desc', 'la sesión sigue abierta aunque no esté trabajando'),
              },
              {
                emoji: t('rawview.help.legend.headless.emoji', '»'),
                name: t('rawview.help.legend.headless.name', 'Texto sin sesión viva'),
                desc: t('rawview.help.legend.headless.desc', 'llegó texto real, pero no hay un chat vivo asociado'),
              },
              {
                emoji: t('rawview.help.legend.dying.emoji', '·'),
                name: t('rawview.help.legend.dying.name', 'Muriendo'),
                desc: t('rawview.help.legend.dying.desc', 'la fuente dejó de estar viva y su banda se está disolviendo'),
              },
              {
                emoji: t('rawview.help.legend.subagent.emoji', '↳'),
                name: t('rawview.help.legend.subagent.name', 'Subagente'),
                desc: t('rawview.help.legend.subagent.desc', 'banda angosta separada del trabajo delegado de una sesión'),
              },
              {
                emoji: t('rawview.help.legend.terminal.emoji', '▸'),
                name: t('rawview.help.legend.terminal.name', 'Terminal bash'),
                desc: t('rawview.help.legend.terminal.desc', 'banda verde de una terminal viva que produce texto'),
              },
              {
                emoji: t('rawview.help.legend.job.emoji', '⚙'),
                name: t('rawview.help.legend.job.name', 'Proceso'),
                desc: t('rawview.help.legend.job.desc', 'banda ámbar de un trabajo determinístico en ejecución'),
              },
              {
                emoji: t('rawview.help.legend.health.emoji', '🟢'),
                name: t('rawview.help.legend.health.name', 'Latido verde'),
                desc: t('rawview.help.legend.health.desc', 'servicio saludable'),
              },
              {
                emoji: t('rawview.help.legend.warn.emoji', '🟠'),
                name: t('rawview.help.legend.warn.name', 'Latido ámbar'),
                desc: t('rawview.help.legend.warn.desc', 'servicio con advertencia'),
              },
              {
                emoji: t('rawview.help.legend.fail.emoji', '🔴'),
                name: t('rawview.help.legend.fail.name', 'Latido rojo'),
                desc: t('rawview.help.legend.fail.desc', 'servicio que falló su chequeo'),
              },
            ],
          },
        ],
      },
      {
        title: t('rawview.help.buttons.title', 'Botones y acciones'),
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('rawview.help.buttons.help.k', '? Ayuda'),
                v: t('rawview.help.buttons.help.v', 'Abre esta guía sin cambiar la actividad observada.'),
              },
              {
                k: t('rawview.help.buttons.close.k', '✕ Cerrar'),
                v: t('rawview.help.buttons.close.v', 'Intenta cerrar la pestaña; funciona cuando la vista se abrió desde la consola.'),
              },
              {
                k: t('rawview.help.buttons.escape.k', 'Esc'),
                v: t('rawview.help.buttons.escape.v', 'Hace la misma acción que ✕. Si el navegador no permite cerrar la pestaña, cerrala manualmente.'),
              },
            ],
          },
        ],
      },
      {
        title: t('rawview.help.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'warn',
            text: t('rawview.help.warning.text', 'Es una vista personal y de solo lectura: muestra texto real únicamente de tus sesiones, terminales y procesos, pero no permite editar ni ejecutar acciones ni inicia IA por sí sola. El odómetro estima caudal en vivo: no representa facturación; para cifras de consumo usá el panel Uso.'),
          },
        ],
      },
    ],
  };
}
