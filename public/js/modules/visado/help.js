// modules/visado/help.js — ayuda contextual para peticiones y aprobaciones.
//
// Exporta una función para evaluar todos los textos al abrir el tema, una vez
// que la consola ya inicializó el idioma elegido.
import { t } from '../../ui/i18n.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
));

function stateItem(color, name, desc) {
  return `<div class="hlp-leg"><span class="hlp-leg-ic" aria-hidden="true" style="color:${color}">●</span><b>${escapeHtml(name)}</b><span>${escapeHtml(desc)}</span></div>`;
}

export default function visadoHelp() {
  return {
    title: t('visado.help.title', 'Visados'),
    icon: 'check',
    intro: t('visado.help.intro', 'Visados es un canal para pedir operaciones. Si alguien invitado a una sala necesita actuar sobre la infraestructura del anfitrión, no ejecuta la operación: la pide. El dueño ve exactamente qué se va a ejecutar y decide.'),
    sections: [
      {
        title: t('visado.help.what.title', 'Qué es: capacidad y petición'),
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('visado.help.what.capability.k', 'Capacidad'),
                v: t('visado.help.what.capability.v', 'Es lo que podés hacer por tu cuenta, sin permiso de otra persona.'),
              },
              {
                k: t('visado.help.what.request.k', 'Petición'),
                v: t('visado.help.what.request.v', 'Es lo que no podés ejecutar por tu cuenta, pero sí podés pedirle al dueño que revise y autorice.'),
              },
            ],
          },
          {
            type: 'note',
            tone: 'info',
            text: t('visado.help.what.note', 'Endurecer permisos sin un canal de petición deja al invitado sin poder hacerlo ni pedirlo. Visados es esa segunda mitad: mantiene el límite y abre una vía controlada para pedir.'),
          },
        ],
      },
      {
        title: t('visado.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('visado.help.first.step1', 'Desde una sala, elegí la operación de la lista.'),
              t('visado.help.first.step2', 'Elegí sus datos: siempre de una lista, nunca escribiendo.'),
              t('visado.help.first.step3', 'Explicá por qué lo pedís.'),
              t('visado.help.first.step4', 'Esperá: el dueño recibe la petición y decide.'),
            ],
          },
        ],
      },
      {
        title: t('visado.help.icons.title', 'Leyenda de íconos'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              {
                icon: 'chevronRight',
                name: t('visado.help.icons.closed.name', 'Panel plegado'),
                desc: t('visado.help.icons.closed.desc', 'abre la cola de peticiones'),
              },
              {
                icon: 'chevronDown',
                name: t('visado.help.icons.open.name', 'Panel desplegado'),
                desc: t('visado.help.icons.open.desc', 'cierra la cola de peticiones'),
              },
              {
                icon: 'clock',
                name: t('visado.help.icons.loading.name', 'Cargando'),
                desc: t('visado.help.icons.loading.desc', 'el catálogo de operaciones se está preparando'),
              },
              {
                icon: 'check',
                name: t('visado.help.icons.check.name', 'Confirmar'),
                desc: t('visado.help.icons.check.desc', 'envía una petición o aprueba una operación'),
              },
              {
                icon: 'close',
                name: t('visado.help.icons.close.name', 'Rechazar'),
                desc: t('visado.help.icons.close.desc', 'rechaza la petición revisada'),
              },
              {
                icon: 'help',
                name: t('visado.help.icons.help.name', 'Ayuda'),
                desc: t('visado.help.icons.help.desc', 'abre esta explicación'),
              },
            ],
          },
        ],
      },
      {
        title: t('visado.help.states.title', 'Estados'),
        wide: true,
        blocks: [
          {
            type: 'html',
            html: [
              stateItem('var(--cwc-warn)', t('visado.estado.pendiente', 'Pendiente'), t('visado.help.states.pending', 'espera la decisión del dueño')),
              stateItem('var(--cwc-info)', t('visado.estado.aprobada', 'Aprobada'), t('visado.help.states.approved', 'el dueño autorizó una ejecución')),
              stateItem('var(--cwc-accent)', t('visado.estado.ejecutando', 'Ejecutando'), t('visado.help.states.running', 'la operación está en curso')),
              stateItem('var(--cwc-ok)', t('visado.estado.ejecutada', 'Ejecutada'), t('visado.help.states.completed', 'la única ejecución autorizada terminó')),
              stateItem('var(--cwc-danger-strong)', t('visado.estado.fallida', 'Fallida'), t('visado.help.states.failed', 'la ejecución terminó con un error')),
              stateItem('var(--cwc-danger)', t('visado.estado.rechazada', 'Rechazada'), t('visado.help.states.rejected', 'el dueño decidió no autorizarla')),
              stateItem('var(--cwc-text-dim)', t('visado.estado.caducada', 'Caducada'), t('visado.help.states.expired', 'pasaron 24 horas sin una decisión')),
              stateItem('var(--cwc-text-dimmer)', t('visado.estado.cancelada', 'Cancelada'), t('visado.help.states.cancelled', 'la petición fue retirada antes de ejecutarse')),
            ].join(''),
          },
        ],
      },
      {
        title: t('visado.help.actions.title', 'Botones y acciones'),
        wide: true,
        blocks: [
          {
            type: 'kv',
            items: [
              {
                k: t('visado.help.actions.request.k', 'Pedir'),
                v: t('visado.help.actions.request.v', 'Envía al dueño la operación elegida, sus datos y tu explicación.'),
              },
              {
                k: t('visado.help.actions.open.k', 'Petición pendiente'),
                v: t('visado.help.actions.open.v', 'Abre el detalle para ver el método, la ruta, el cuerpo, los argumentos, las advertencias y la explicación antes de decidir.'),
              },
              {
                k: t('visado.help.actions.approve.k', 'Aprobar'),
                v: t('visado.help.actions.approve.v', 'Autoriza una sola ejecución de la operación exacta mostrada.'),
              },
              {
                k: t('visado.help.actions.reject.k', 'Rechazar'),
                v: t('visado.help.actions.reject.v', 'Niega la petición; podés dejar un motivo opcional.'),
              },
              {
                k: t('visado.help.actions.cancel.k', 'Cancelar'),
                v: t('visado.help.actions.cancel.v', 'Cierra el formulario o retira una petición, según dónde aparezca.'),
              },
              {
                k: t('visado.help.actions.help.k', '?'),
                v: t('visado.help.actions.help.v', 'Abre esta ayuda.'),
              },
            ],
          },
          {
            type: 'note',
            tone: 'info',
            text: t('visado.help.actions.tokens', 'Ninguna acción de este panel consume tokens. Es determinístico de punta a punta: el catálogo es código, la validación es código y la ejecución usa un runner sin IA.'),
          },
        ],
      },
      {
        title: t('visado.help.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'warn',
            text: t('visado.help.warning.expiry', 'Una petición sin respuesta caduca a las 24 horas y no ejecuta nada. El silencio nunca aprueba.'),
          },
          {
            type: 'note',
            tone: 'warn',
            text: t('visado.help.warning.once', 'Una aprobación sirve para una sola ejecución. Si hace falta de nuevo, se pide de nuevo.'),
          },
          {
            type: 'note',
            tone: 'danger',
            text: t('visado.help.warning.self', 'Nadie puede aprobar su propia petición, ni siquiera siendo administrador.'),
          },
        ],
      },
    ],
  };
}
