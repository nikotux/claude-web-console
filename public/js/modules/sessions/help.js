// modules/sessions/help.js — contenido contextual de ayuda para Sesiones.
//
// Exporta una función para que todos los textos pasen por t() al abrir el tema
// y reflejen el idioma ya inicializado de la consola.
import { t } from '../../ui/i18n.js';

export default function sessionsHelp() {
  return {
    title: t('sessions.help.title', 'Sesiones'),
    icon: 'terminal',
    intro: t('sessions.help.intro', 'Sesiones es el radar del trabajo vivo: reúne conversaciones, terminales y procesos en segundo plano. Cada tarjeta permite reconocer el estado y retomar el trabajo sin perder contexto.'),
    sections: [
      {
        title: t('sessions.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('sessions.help.first.step1', 'Buscá la tarjeta por su nombre, proyecto y modelo.'),
              t('sessions.help.first.step2', 'Mirá el Pac-Man para saber si está trabajando, esperando o dormida.'),
              t('sessions.help.first.step3', 'Tocá la tarjeta para abrirla o enfocar su pestaña si ya estaba abierta.'),
              t('sessions.help.first.step4', 'Usá el contador desplegable para revisar trabajos que siguen corriendo en segundo plano.'),
            ],
          },
          {
            type: 'note',
            tone: 'info',
            text: t('sessions.help.first.otherUsers', 'Si sos administrador, las sesiones de otros usuarios aparecen agrupadas por dueño en una sección aparte que nace colapsada.'),
          },
        ],
      },
      {
        title: t('sessions.help.states.title', 'Estados del Pac-Man'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              {
                emoji: t('sessions.help.states.working.emoji', '🟡'),
                name: t('sessions.help.states.working.name', 'Trabajando'),
                desc: t('sessions.help.states.working.desc', 'dorado, mordisco rápido: un turno corriendo ahora'),
              },
              {
                emoji: t('sessions.help.states.delegating.emoji', '🟣'),
                name: t('sessions.help.states.delegating.name', 'Delegando'),
                desc: t('sessions.help.states.delegating.desc', 'violeta con el ícono del interfono: esperando que vuelva un subagente (Task) u otro proceso'),
              },
              {
                emoji: t('sessions.help.states.queued.emoji', '🟠'),
                name: t('sessions.help.states.queued.name', 'En cola'),
                desc: t('sessions.help.states.queued.desc', 'ámbar que respira: esperando su turno detrás de otro paso'),
              },
              {
                emoji: t('sessions.help.states.waiting.emoji', '🟢'),
                name: t('sessions.help.states.waiting.name', 'Tu turno'),
                desc: t('sessions.help.states.waiting.desc', 'verde, parpadeo lento: esperando tu mensaje o tu decisión'),
              },
              {
                emoji: t('sessions.help.states.stale.emoji', '🟤'),
                name: t('sessions.help.states.stale.name', 'Sin señales'),
                desc: t('sessions.help.states.stale.desc', 'ámbar apagado y quieto: se perdió el rastro, no se sabe si sigue activo'),
              },
              {
                emoji: t('sessions.help.states.error.emoji', '🔴'),
                name: t('sessions.help.states.error.name', 'Falló'),
                desc: t('sessions.help.states.error.desc', 'rojo y quieto: se detuvo por un error'),
              },
              {
                emoji: t('sessions.help.states.dormant.emoji', '⚪'),
                name: t('sessions.help.states.dormant.name', 'Dormido'),
                desc: t('sessions.help.states.dormant.desc', 'gris y quieto: nada activo ni delegado — el único estado sin animación'),
              },
              {
                emoji: t('sessions.help.legend.env.emoji', '⧉'),
                name: t('sessions.help.legend.env.name', 'Entorno aislado'),
                desc: t('sessions.help.legend.env.desc', 'azul frío: la conversación corre en un worktree efímero de Tolkien, no en el Tolkien principal — sus cambios y su base de datos están separados'),
              },
            ],
          },
        ],
      },
      {
        title: t('sessions.help.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('sessions.help.buttons.card.k', 'Tarjeta'),
                v: t('sessions.help.buttons.card.v', 'Abre la sesión o enfoca la pestaña que ya la muestra.'),
              },
              {
                k: t('sessions.help.buttons.background.k', 'Trabajos en segundo plano'),
                v: t('sessions.help.buttons.background.v', 'Abre el resumen global de subagentes, tareas y procesos del servidor; el número indica cuántos siguen vivos.'),
              },
              {
                k: t('sessions.help.buttons.refresh.k', 'Refrescar'),
                v: t('sessions.help.buttons.refresh.v', 'Vuelve a consultar sesiones y trabajos sin iniciar una tarea de IA ni consumir tokens.'),
              },
              {
                k: t('sessions.help.buttons.jobs.k', '▸ + número'),
                v: t('sessions.help.buttons.jobs.v', 'Despliega los subagentes y trabajos en segundo plano de esa conversación.'),
              },
              {
                k: t('sessions.help.buttons.intercom.k', 'Interfono + número'),
                v: t('sessions.help.buttons.intercom.v', 'Muestra mensajes pendientes. Entregarlos despierta el chat como un turno nuevo y consume tokens.'),
              },
              {
                k: t('sessions.help.buttons.menu.k', '⋯ Opciones'),
                v: t('sessions.help.buttons.menu.v', 'Permite renombrar, cambiar modo o modelo, mover, archivar, abrir la carpeta o cerrar.'),
              },
              {
                k: t('sessions.help.buttons.help.k', '?'),
                v: t('sessions.help.buttons.help.v', 'Abre esta ayuda sin refrescar ni modificar las sesiones.'),
              },
            ],
          },
        ],
      },
      {
        title: t('sessions.help.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'warn',
            text: t('sessions.help.warning.text', 'Cerrar una conversación conserva su historial para retomarla; matar una sesión tmux termina todo lo que esté corriendo adentro y puede interrumpir trabajo externo.'),
          },
        ],
      },
    ],
  };
}
