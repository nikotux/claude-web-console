// modules/tickets/help.js — contenido contextual de ayuda para Tickets.
//
// Describe el tablero determinístico y las acciones de detalle; distingue de
// forma explícita las dos acciones que inician trabajo de IA y consumen tokens.
import { pacman } from '../../ui/pacman.js';
import { t } from '../../ui/i18n.js';

function esc(value) {
  return String(value ?? '').replace(/[&<>"]/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]
  ));
}

function pacmanRow() {
  const name = t('tickets.help.signals.pacman.name', 'Pac-Man trabajando');
  const desc = t('tickets.help.signals.pacman.desc', 'un refresco o una carga sigue corriendo; el tablero continúa cuando termina');
  return `<div class="hlp-leg">
    <span class="hlp-leg-ic">${pacman({ state: 'working', size: 'sm', title: name })}</span>
    <b>${esc(name)}</b><span>${esc(desc)}</span>
  </div>`;
}

export default function ticketsHelp() {
  return {
    title: t('tickets.help.title', 'Tickets & Features'),
    icon: 'list',
    intro: t('tickets.help.intro', 'Este tablero junta tickets de Zoho Desk y pull requests de GitHub en una sola puerta de entrada. Sirve para filtrar lo urgente, ver el contexto real y empezar a trabajar sin pisarse con otra persona.'),
    sections: [
      {
        title: t('tickets.help.first.title', 'Primeros pasos'),
        blocks: [
          {
            type: 'steps',
            items: [
              t('tickets.help.first.step1', 'Elegí Activos o Resueltos y filtrá por carril, dueño o Míos.'),
              t('tickets.help.first.step2', 'Tocá una tarjeta de ticket o PR para abrir su detalle completo.'),
              t('tickets.help.first.step3', 'Tocá Tomar antes de trabajar para que el resto vea que está en uso.'),
              t('tickets.help.first.step4', 'Revisá descripción, estado, conversaciones, CI, contexto adicional e histórico según el tipo de ítem.'),
              t('tickets.help.first.step5', 'Tocá Continuar/Trabajar en chat para iniciar el trabajo con todo ese contexto, o abrí Zoho/GitHub para consultar la fuente.'),
            ],
          },
        ],
      },
      {
        title: t('tickets.help.lanes.title', 'Leyenda · carriles'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              { emoji: t('tickets.help.lanes.bug.emoji', '🐞'), name: t('tickets.help.lanes.bug.name', 'Bug'), desc: t('tickets.help.lanes.bug.desc', 'falla de software') },
              { emoji: t('tickets.help.lanes.feature.emoji', '💡'), name: t('tickets.help.lanes.feature.name', 'Feature'), desc: t('tickets.help.lanes.feature.desc', 'mejora o capacidad nueva') },
              { emoji: t('tickets.help.lanes.hardware.emoji', '🖥'), name: t('tickets.help.lanes.hardware.name', 'Hardware'), desc: t('tickets.help.lanes.hardware.desc', 'equipos físicos') },
              { emoji: t('tickets.help.lanes.access.emoji', '🔑'), name: t('tickets.help.lanes.access.name', 'Acceso'), desc: t('tickets.help.lanes.access.desc', 'permisos, cuentas o credenciales') },
              { emoji: t('tickets.help.lanes.platform.emoji', '⚙️'), name: t('tickets.help.lanes.platform.name', 'Plataforma'), desc: t('tickets.help.lanes.platform.desc', 'servicios y configuración técnica') },
              { emoji: t('tickets.help.lanes.onboarding.emoji', '🌱'), name: t('tickets.help.lanes.onboarding.name', 'Onboarding'), desc: t('tickets.help.lanes.onboarding.desc', 'altas e incorporación') },
              { emoji: t('tickets.help.lanes.house.emoji', '🏠'), name: t('tickets.help.lanes.house.name', 'Infraestructura Casa'), desc: t('tickets.help.lanes.house.desc', 'asuntos de la casa') },
              { emoji: t('tickets.help.lanes.office.emoji', '🏢'), name: t('tickets.help.lanes.office.name', 'Infraestructura Oficina'), desc: t('tickets.help.lanes.office.desc', 'asuntos de la oficina') },
              { emoji: t('tickets.help.lanes.other.emoji', '🏷️'), name: t('tickets.help.lanes.other.name', 'Otro'), desc: t('tickets.help.lanes.other.desc', 'ticket sin un carril específico') },
            ],
          },
        ],
      },
      {
        title: t('tickets.help.status.title', 'Leyenda · estados y prioridad'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              { emoji: t('tickets.help.status.new.emoji', '🆕'), name: t('tickets.help.status.new.name', 'Nuevo'), desc: t('tickets.help.status.new.desc', 'todavía sin asignar') },
              { emoji: t('tickets.help.status.triaged.emoji', '📌'), name: t('tickets.help.status.triaged.name', 'Asignado'), desc: t('tickets.help.status.triaged.desc', 'ya pasó por clasificación') },
              { emoji: t('tickets.help.status.progress.emoji', '🔧'), name: t('tickets.help.status.progress.name', 'En progreso'), desc: t('tickets.help.status.progress.desc', 'hay trabajo en curso') },
              { emoji: t('tickets.help.status.waiting.emoji', '⏸️'), name: t('tickets.help.status.waiting.name', 'Espera cliente'), desc: t('tickets.help.status.waiting.desc', 'falta una respuesta del solicitante') },
              { emoji: t('tickets.help.status.closed.emoji', '✅'), name: t('tickets.help.status.closed.name', 'Resuelto'), desc: t('tickets.help.status.closed.desc', 'ticket cerrado o PR mergeado') },
              { emoji: t('tickets.help.status.p1.emoji', '🔴'), name: t('tickets.help.status.p1.name', 'P1'), desc: t('tickets.help.status.p1.desc', 'prioridad alta; rojo también marca vencido o error') },
              { emoji: t('tickets.help.status.p2.emoji', '🟠'), name: t('tickets.help.status.p2.name', 'P2'), desc: t('tickets.help.status.p2.desc', 'prioridad media o falta de actualización') },
              { emoji: t('tickets.help.status.p3.emoji', '🟡'), name: t('tickets.help.status.p3.name', 'P3'), desc: t('tickets.help.status.p3.desc', 'prioridad baja') },
            ],
          },
        ],
      },
      {
        title: t('tickets.help.signals.title', 'Leyenda · PRs y señales'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              { emoji: t('tickets.help.signals.yours.emoji', '🟡'), name: t('tickets.help.signals.yours.name', 'Pelota tuya'), desc: t('tickets.help.signals.yours.desc', 'el próximo movimiento del PR te corresponde') },
              { emoji: t('tickets.help.signals.chris.emoji', '🔵'), name: t('tickets.help.signals.chris.name', 'Pelota de Chris'), desc: t('tickets.help.signals.chris.desc', 'el PR espera una acción de Chris') },
              { icon: 'check', name: t('tickets.help.signals.ciOk.name', 'CI verde'), desc: t('tickets.help.signals.ciOk.desc', 'los checks pasaron') },
              { icon: 'close', name: t('tickets.help.signals.ciFail.name', 'CI roja'), desc: t('tickets.help.signals.ciFail.desc', 'algún check falló') },
              { icon: 'clock', name: t('tickets.help.signals.ciPending.name', 'CI corriendo'), desc: t('tickets.help.signals.ciPending.desc', 'los checks todavía no terminaron') },
              { emoji: t('tickets.help.signals.lock.emoji', '🔒'), name: t('tickets.help.signals.lock.name', 'En uso'), desc: t('tickets.help.signals.lock.desc', 'alguien tomó el ticket o PR; verde es tuyo, ámbar es de otra persona') },
              { emoji: t('tickets.help.signals.owner.emoji', '👤'), name: t('tickets.help.signals.owner.name', 'Dueño'), desc: t('tickets.help.signals.owner.desc', 'las iniciales identifican al agente asignado') },
              { emoji: t('tickets.help.signals.stale.emoji', '◷'), name: t('tickets.help.signals.stale.name', 'Dato en caché'), desc: t('tickets.help.signals.stale.desc', 'no llegó en el último refresco y se conserva el último valor conocido') },
              { emoji: t('tickets.help.signals.warning.emoji', '⚠️'), name: t('tickets.help.signals.warning.name', 'Advertencia'), desc: t('tickets.help.signals.warning.desc', 'la fuente está incompleta, vieja o limitada') },
              { emoji: t('tickets.help.signals.pr.emoji', '🔀'), name: t('tickets.help.signals.pr.name', 'Dev-lane'), desc: t('tickets.help.signals.pr.desc', 'pull requests abiertos o mergeados') },
              { emoji: t('tickets.help.signals.all.emoji', '📋'), name: t('tickets.help.signals.all.name', 'Todos'), desc: t('tickets.help.signals.all.desc', 'vista unificada de tickets abiertos') },
              { emoji: t('tickets.help.signals.active.emoji', '🟢'), name: t('tickets.help.signals.active.name', 'Activo / al día'), desc: t('tickets.help.signals.active.desc', 'vista de abiertos o SLA sin atraso, según dónde aparezca') },
            ],
          },
          { type: 'html', html: pacmanRow() },
        ],
      },
      {
        title: t('tickets.help.icons.title', 'Leyenda · íconos de acciones'),
        wide: true,
        blocks: [
          {
            type: 'legend',
            items: [
              { icon: 'play', name: t('tickets.help.icons.play.name', 'Tomar o trabajar'), desc: t('tickets.help.icons.play.desc', 'reclama el ítem o inicia un chat') },
              { icon: 'close', name: t('tickets.help.icons.close.name', 'Soltar o borrar'), desc: t('tickets.help.icons.close.desc', 'libera un ítem o elimina contexto, según el botón') },
              { icon: 'edit', name: t('tickets.help.icons.edit.name', 'Editar'), desc: t('tickets.help.icons.edit.desc', 'modifica el contexto adicional guardado') },
              { icon: 'sparkle', name: t('tickets.help.icons.ai.name', 'IA'), desc: t('tickets.help.icons.ai.desc', 'interpreta una transcripción; consume tokens') },
              { icon: 'gitBranch', name: t('tickets.help.icons.github.name', 'GitHub'), desc: t('tickets.help.icons.github.desc', 'abre o busca el PR en GitHub') },
              { icon: 'upload', name: t('tickets.help.icons.zoho.name', 'Zoho Desk'), desc: t('tickets.help.icons.zoho.desc', 'abre el ticket y sus conversaciones en Zoho') },
              { icon: 'search', name: t('tickets.help.icons.search.name', 'Buscar'), desc: t('tickets.help.icons.search.desc', 'abre la búsqueda por número') },
              { icon: 'refresh', name: t('tickets.help.icons.refresh.name', 'Actualizar'), desc: t('tickets.help.icons.refresh.desc', 'fuerza una relectura de la fuente') },
              { icon: 'maximize', name: t('tickets.help.icons.expand.name', 'Tabla ancha'), desc: t('tickets.help.icons.expand.desc', 'abre todos los tickets de una cola en tabla') },
              { icon: 'chevronDown', name: t('tickets.help.icons.collapse.name', 'Desplegar'), desc: t('tickets.help.icons.collapse.desc', 'abre o cierra una sección') },
              { icon: 'help', name: t('tickets.help.icons.help.name', 'Ayuda'), desc: t('tickets.help.icons.help.desc', 'abre esta guía') },
            ],
          },
        ],
      },
      {
        title: t('tickets.help.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [
          {
            type: 'kv',
            items: [
              { k: t('tickets.help.buttons.search.k', 'Buscar'), v: t('tickets.help.buttons.search.v', 'Abre un campo: escribí el número y presioná Enter para ir directo al ticket.') },
              { k: t('tickets.help.buttons.refresh.k', 'Actualizar'), v: t('tickets.help.buttons.refresh.v', 'Sólo para admin: fuerza una relectura de Zoho/GitHub. El resto del equipo ve el snapshot compartido, actualizado cada 60 s.') },
              { k: t('tickets.help.buttons.lane.k', 'Carriles'), v: t('tickets.help.buttons.lane.v', 'Filtran las tarjetas por categoría; tocá de nuevo el carril activo para quitar el filtro desde el resumen.') },
              { k: t('tickets.help.buttons.mine.k', 'Míos'), v: t('tickets.help.buttons.mine.v', 'Muestra sólo los ítems que tenés tomados.') },
              { k: t('tickets.help.buttons.owner.k', 'Dueño'), v: t('tickets.help.buttons.owner.v', 'Filtra tickets por agente de Desk y PRs por autor de GitHub.') },
              { k: t('tickets.help.buttons.views.k', 'Activos / Resueltos'), v: t('tickets.help.buttons.views.v', 'Cambia entre colas abiertas y la base persistente de tickets cerrados y PRs mergeados.') },
              { k: t('tickets.help.buttons.all.k', 'Todos · N'), v: t('tickets.help.buttons.all.v', 'Abre una tabla ancha con la unión de las colas y respeta los filtros activos.') },
              { k: t('tickets.help.buttons.expand.k', '⤢ en una columna'), v: t('tickets.help.buttons.expand.v', 'Abre todos los tickets de esa cola en una tabla ordenable; “+N más” hace lo mismo.') },
              { k: t('tickets.help.buttons.block.k', 'Encabezado de columna'), v: t('tickets.help.buttons.block.v', 'Abre o cierra el bloque de tarjetas.') },
              { k: t('tickets.help.buttons.card.k', 'Tarjeta de ticket o PR'), v: t('tickets.help.buttons.card.v', 'Abre el detalle con propiedades, fuente, contexto y acciones disponibles.') },
              { k: t('tickets.help.buttons.table.k', 'Tabla: filtro y encabezados'), v: t('tickets.help.buttons.table.v', 'Filtra por número/asunto y ordena al tocar cualquier encabezado; una fila abre el detalle.') },
              { k: t('tickets.help.buttons.claim.k', 'Tomar'), v: t('tickets.help.buttons.claim.v', 'Marca el ítem como tuyo para evitar trabajo duplicado. No consume tokens.') },
              { k: t('tickets.help.buttons.release.k', 'Soltar'), v: t('tickets.help.buttons.release.v', 'Libera un ítem que habías tomado. No consume tokens.') },
              { k: t('tickets.help.buttons.steal.k', 'Robar'), v: t('tickets.help.buttons.steal.v', 'Te transfiere un ítem tomado por otra persona después de confirmar.') },
              { k: t('tickets.help.buttons.force.k', 'Forzar liberación'), v: t('tickets.help.buttons.force.v', 'Sólo para admin: quita el lock de otra persona.') },
              { k: t('tickets.help.buttons.detailRefresh.k', 'Actualizar detalle'), v: t('tickets.help.buttons.detailRefresh.v', 'Relee ese ticket o PR desde su fuente. No consume tokens de IA.') },
              { k: t('tickets.help.buttons.chat.k', 'Continuar / Trabajar en chat'), v: t('tickets.help.buttons.chat.v', 'Abre un runner IA con el detalle, contexto e histórico del ítem. CONSUME TOKENS; si estaba libre, además lo toma automáticamente.') },
              { k: t('tickets.help.buttons.github.k', 'Verificar / Abrir en GitHub'), v: t('tickets.help.buttons.github.v', 'Abre GitHub en otra pestaña. No inicia IA ni consume tokens.') },
              { k: t('tickets.help.buttons.zoho.k', 'Conversaciones en Zoho Desk'), v: t('tickets.help.buttons.zoho.v', 'Abre la fuente original del ticket en otra pestaña. No consume tokens.') },
              { k: t('tickets.help.buttons.contextOpen.k', 'Interpretar una charla'), v: t('tickets.help.buttons.contextOpen.v', 'Despliega el campo donde pegás una transcripción; abrirlo no consume tokens.') },
              { k: t('tickets.help.buttons.interpret.k', 'Interpretar con IA'), v: t('tickets.help.buttons.interpret.v', 'Dispara un runner IA y guarda el resultado como contexto adicional. CONSUME TOKENS y pide confirmación.') },
              { k: t('tickets.help.buttons.edit.k', 'Editar / Guardar edición'), v: t('tickets.help.buttons.edit.v', 'Carga el contexto existente en el campo y lo guarda directamente, sin IA ni tokens.') },
              { k: t('tickets.help.buttons.delete.k', 'Borrar contexto'), v: t('tickets.help.buttons.delete.v', 'Elimina el contexto adicional guardado después de confirmar.') },
              { k: t('tickets.help.buttons.history.k', 'Entrada de histórico'), v: t('tickets.help.buttons.history.v', 'Despliega el resumen y los archivos de una sesión anterior; se genera al cerrar el chat sin usar IA.') },
            ],
          },
        ],
      },
      {
        title: t('tickets.help.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'danger',
            text: t('tickets.help.warning.locks', 'Robar o forzar la liberación cambia quién puede trabajar el ítem; Borrar contexto elimina la nota persistida. Las tres acciones piden confirmación, pero coordiná antes de pisar trabajo ajeno.'),
          },
          {
            type: 'note',
            tone: 'warn',
            text: t('tickets.help.warning.sources', 'Zoho puede limitar la carga de resueltos a unas 100 filas por departamento y el tablero conserva datos viejos cuando una fuente falla: mirá ◷, ⚠️ y la hora del snapshot antes de decidir.'),
          },
          {
            type: 'note',
            tone: 'warn',
            text: t('tickets.help.warning.pad', 'Los datos de Pad de un PR dependen de un token OAuth de alrededor de una hora y no tienen refresco propio; si están viejos, GitHub y Zoho siguen siendo las fuentes para verificar.'),
          },
        ],
      },
    ],
  };
}
