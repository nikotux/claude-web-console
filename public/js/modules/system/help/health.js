// modules/system/help/health.js — ayuda contextual de Salud.
import { t } from '../../../ui/i18n.js';

export default function healthHelp() {
  return {
    title: t('system.help.health.title', 'Salud'),
    icon: 'pulse',
    intro: t('system.help.health.intro', 'Salud combina chequeos rápidos del sistema con una auditoría profunda asistida por IA. Los chequeos son gratis; el Escaneo de Salud consume tokens y reúne Revisión, Optimización y Coherencia en una sola corrida.'),
    sections: [
      {
        title: t('system.help.health.first.title', 'Primeros pasos'),
        blocks: [{
          type: 'steps',
          items: [
            t('system.help.health.first.step1', 'Mirá primero los Chequeos rápidos para detectar fallas operativas sin gastar tokens.'),
            t('system.help.health.first.step2', 'Tocá Abrir Escaneo de Salud y elegí Incremental para analizar solo lo que cambió.'),
            t('system.help.health.first.step3', 'Confirmá la corrida: Revisión, Optimización, Coherencia y el cruce con Pad corren juntas y consumen tokens.'),
            t('system.help.health.first.step4', 'Abrí cada sección para revisar hallazgos y propuestas antes de aprobar o resolver algo.'),
            t('system.help.health.first.step5', 'Usá Resolver todo solo si querés abrir un chat supervisado que agrupe el trabajo pendiente.'),
          ],
        }],
      },
      {
        title: t('system.help.health.legend.title', 'Leyenda'),
        wide: true,
        blocks: [{
          type: 'legend',
          items: [
            { emoji: t('system.help.health.legend.ok.emoji', '🟢'), name: t('system.help.health.legend.ok.name', 'OK'), desc: t('system.help.health.legend.ok.desc', 'el chequeo o veredicto está en orden') },
            { emoji: t('system.help.health.legend.warn.emoji', '🟡'), name: t('system.help.health.legend.warn.name', 'Atención'), desc: t('system.help.health.legend.warn.desc', 'hay algo para revisar, pero la consola puede seguir') },
            { emoji: t('system.help.health.legend.fail.emoji', '🔴'), name: t('system.help.health.legend.fail.name', 'Crítico / falla'), desc: t('system.help.health.legend.fail.desc', 'hay una falla real o un hallazgo de máxima severidad') },
            { emoji: t('system.help.health.legend.new.emoji', '🆕'), name: t('system.help.health.legend.new.name', 'Nuevo'), desc: t('system.help.health.legend.new.desc', 'el hallazgo no coincide con ningún BUG de Pad') },
            { emoji: t('system.help.health.legend.tracked.emoji', '🔗'), name: t('system.help.health.legend.tracked.name', 'Rastreado'), desc: t('system.help.health.legend.tracked.desc', 'ya existe en el backlog de Pad y no hace falta recrearlo') },
            { emoji: t('system.help.health.legend.regression.emoji', '⚠️'), name: t('system.help.health.legend.regression.name', 'Regresión'), desc: t('system.help.health.legend.regression.desc', 'coincide con un BUG cerrado como fixed o wontfix que reapareció') },
            { emoji: t('system.help.health.legend.locked.emoji', '🔒'), name: t('system.help.health.legend.locked.name', 'Protegido'), desc: t('system.help.health.legend.locked.desc', 'superficie o severidad crítica: no admite auto-fix y va por chat supervisado') },
            { emoji: t('system.help.health.legend.recurrent.emoji', '🔁'), name: t('system.help.health.legend.recurrent.name', 'Recurrente'), desc: t('system.help.health.legend.recurrent.desc', 'ya se había resuelto y volvió a aparecer') },
            { emoji: t('system.help.health.legend.resolved.emoji', '✅'), name: t('system.help.health.legend.resolved.name', 'Resuelto'), desc: t('system.help.health.legend.resolved.desc', 'el hallazgo cerró su ciclo y quedó registrado') },
            { emoji: t('system.help.health.legend.dismissed.emoji', '⊘'), name: t('system.help.health.legend.dismissed.name', 'No era bug'), desc: t('system.help.health.legend.dismissed.desc', 'se revisó y quedó descartado como falso positivo') },
          ],
        }],
      },
      {
        title: t('system.help.health.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [{
          type: 'kv',
          items: [
            { k: t('system.help.health.buttons.refresh.k', 'Refrescar chequeos'), v: t('system.help.health.buttons.refresh.v', 'Vuelve a correr los chequeos determinísticos de servicio, tmux, runners, TLS, git, sintaxis, disco, Pad y cruces. 0 tokens.') },
            { k: t('system.help.health.buttons.open.k', 'Abrir Escaneo de Salud'), v: t('system.help.health.buttons.open.v', 'Abre el detalle unificado; consultar resultados no consume tokens.') },
            { k: t('system.help.health.buttons.incremental.k', 'Escaneo incremental'), v: t('system.help.health.buttons.incremental.v', 'Corre Revisión + Optimización + Coherencia y reutiliza módulos sin cambios. CONSUME TOKENS y es admin-only.') },
            { k: t('system.help.health.buttons.full.k', 'Completo'), v: t('system.help.health.buttons.full.v', 'Ignora cachés y vuelve a auditar todo desde cero. CONSUME MÁS TOKENS y es admin-only.') },
            { k: t('system.help.health.buttons.createBug.k', 'Crear BUG'), v: t('system.help.health.buttons.createBug.v', 'Registra en Pad un hallazgo nuevo, solo después de tu confirmación. Admin-only.') },
            { k: t('system.help.health.buttons.analyzeAi.k', 'Analizar con IA'), v: t('system.help.health.buttons.analyzeAi.v', 'En Optimización o Coherencia, genera propuestas leyendo el código en modo read-only. CONSUME TOKENS y es admin-only.') },
            { k: t('system.help.health.buttons.apply.k', 'En chat / Aplicar en chat / Explorar en chat'), v: t('system.help.health.buttons.apply.v', 'Abre un chat supervisado o en modo plan. La propuesta no toca código por sí sola, pero el trabajo del chat CONSUME TOKENS.') },
            { k: t('system.help.health.buttons.approve.k', 'Aprobar / Descartar / Restaurar a la cola'), v: t('system.help.health.buttons.approve.v', 'Decide el destino de propuestas e invariantes o recupera un falso positivo mal descartado. No aplica código automáticamente.') },
            { k: t('system.help.health.buttons.tandem.k', '«Automático» usa Tándem'), v: t('system.help.health.buttons.tandem.v', 'Hace que Codex escriba el fix y Claude diagnostique y verifique. Afecta solo Automático de a uno, se reinicia al cerrar la ventana y CONSUME TOKENS.') },
            { k: t('system.help.health.buttons.auto.k', 'Automático'), v: t('system.help.health.buttons.auto.v', 'Lanza el auto-fix autónomo para un hallazgo permitido: edita y corre node --check sin supervisión. CONSUME TOKENS, es admin-only y los críticos quedan bloqueados.') },
            { k: t('system.help.health.buttons.safe.k', 'Resolver seguros'), v: t('system.help.health.buttons.safe.v', 'Resuelve hallazgos no críticos en sandboxes paralelos y los integra en serie con chequeo de sintaxis. CONSUME TOKENS y es admin-only.') },
            { k: t('system.help.health.buttons.mark.k', 'Marcar resuelto'), v: t('system.help.health.buttons.mark.v', 'Actualiza el tablero sin tocar código cuando el arreglo ya se hizo por otro camino. Admin-only.') },
            { k: t('system.help.health.buttons.resolveAll.k', 'Resolver todo'), v: t('system.help.health.buttons.resolveAll.v', 'Abre un chat supervisado con el Orquestador Interno para agrupar hallazgos y propuestas. El trabajo del chat consume tokens.') },
          ],
        }],
      },
      {
        title: t('system.help.health.warning.title', 'Ojo con esto'),
        blocks: [{
          type: 'note',
          tone: 'danger',
          text: t('system.help.health.warning.text', 'Nada de Optimización, Coherencia ni invariantes se auto-aplica sin aprobación humana. La excepción es Automático: puede escribir código sin supervisión, nunca reinicia el servicio y el backend bloquea server, bind, auth, config, TLS, registry, runners y otras superficies críticas.'),
        }],
      },
    ],
  };
}
