// modules/system/help/updates.js — ayuda contextual de Actualizaciones.
import { t } from '../../../ui/i18n.js';

export default function updatesHelp() {
  return {
    title: t('system.help.updates.title', 'Actualizaciones'),
    icon: 'download',
    intro: t('system.help.updates.intro', 'Este panel compara las versiones instaladas de dependencias externas con las disponibles y señala vulnerabilidades. El flujo orquestado ordena, aplica, verifica y reinicia de forma recuperable.'),
    sections: [
      {
        title: t('system.help.updates.first.title', 'Primeros pasos'),
        blocks: [{
          type: 'steps',
          items: [
            t('system.help.updates.first.step1', 'Revisá el resumen y abrí Motor, Seguridad, Librerías, Sistema operativo, Servicios y Vigiladas.'),
            t('system.help.updates.first.step2', 'Si hay saltos mayores, tocá Analizar riesgo para que la IA lea changelogs y el uso real del código.'),
            t('system.help.updates.first.step3', 'Incluí manualmente solo los majors con veredicto favorable y que aceptás probar.'),
            t('system.help.updates.first.step4', 'Preferí Actualizar con sesión para que un chat explique el plan y espere tu OK concreto antes de ejecutar.'),
            t('system.help.updates.first.step5', 'Usá Modo automático solo si querés el runner determinístico; seguí sus fases hasta Listo y revisá el censo fresco.'),
          ],
        }],
      },
      {
        title: t('system.help.updates.legend.title', 'Leyenda de riesgo y fases'),
        wide: true,
        blocks: [{
          type: 'legend',
          items: [
            { emoji: t('system.help.updates.legend.core.emoji', '🧬'), name: t('system.help.updates.legend.core.name', 'Motor crítico'), desc: t('system.help.updates.legend.core.desc', 'dependencia central del chat o los runners') },
            { emoji: t('system.help.updates.legend.watch.emoji', '🔴'), name: t('system.help.updates.legend.watch.name', 'Vigilada'), desc: t('system.help.updates.legend.watch.desc', 'pieza frágil o no oficial que no se actualiza desde el panel') },
            { emoji: t('system.help.updates.legend.lib.emoji', '📦'), name: t('system.help.updates.legend.lib.name', 'Librería'), desc: t('system.help.updates.legend.lib.desc', 'dependencia npm normal y reversible') },
            { emoji: t('system.help.updates.legend.safe.emoji', '🟢'), name: t('system.help.updates.legend.safe.name', 'Seguro / baja'), desc: t('system.help.updates.legend.safe.desc', 'veredicto favorable o vulnerabilidad de baja severidad, según la sección') },
            { emoji: t('system.help.updates.legend.risky.emoji', '🟡'), name: t('system.help.updates.legend.risky.name', 'Riesgoso / media'), desc: t('system.help.updates.legend.risky.desc', 'requiere leer el detalle y decidir con cuidado') },
            { emoji: t('system.help.updates.legend.breaks.emoji', '🔒'), name: t('system.help.updates.legend.breaks.name', 'Major bloqueado'), desc: t('system.help.updates.legend.breaks.desc', 'sin veredicto favorable, rompe, tiene confianza insuficiente o es pre-release') },
            { emoji: t('system.help.updates.legend.queued.emoji', '⏳'), name: t('system.help.updates.legend.queued.name', 'En cola'), desc: t('system.help.updates.legend.queued.desc', 'el job fue reservado y espera comenzar') },
            { emoji: t('system.help.updates.legend.planning.emoji', '🧭'), name: t('system.help.updates.legend.planning.name', 'Planeando'), desc: t('system.help.updates.legend.planning.desc', 'arma el orden conservador y valida lo permitido') },
            { emoji: t('system.help.updates.legend.draining.emoji', '📨'), name: t('system.help.updates.legend.draining.name', 'Drenando / reanudando'), desc: t('system.help.updates.legend.draining.desc', 'avisa por Interfono antes y después del cambio') },
            { emoji: t('system.help.updates.legend.applying.emoji', '⚙️'), name: t('system.help.updates.legend.applying.name', 'Aplicando'), desc: t('system.help.updates.legend.applying.desc', 'instala los pasos del plan') },
            { emoji: t('system.help.updates.legend.verifying.emoji', '🩺'), name: t('system.help.updates.legend.verifying.name', 'Verificando'), desc: t('system.help.updates.legend.verifying.desc', 'corre sintaxis y luego comprueba que la web responda de verdad') },
            { emoji: t('system.help.updates.legend.restarting.emoji', '🔁'), name: t('system.help.updates.legend.restarting.name', 'Reiniciando'), desc: t('system.help.updates.legend.restarting.desc', 'reinicia únicamente el servicio de la consola') },
            { emoji: t('system.help.updates.legend.reverting.emoji', '↩️'), name: t('system.help.updates.legend.reverting.name', 'Revirtiendo'), desc: t('system.help.updates.legend.reverting.desc', 'deshace cambios npm ante evidencia positiva de falla') },
            { emoji: t('system.help.updates.legend.done.emoji', '✅'), name: t('system.help.updates.legend.done.name', 'Listo'), desc: t('system.help.updates.legend.done.desc', 'terminó y el censo puede refrescarse') },
          ],
        }],
      },
      {
        title: t('system.help.updates.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [{
          type: 'kv',
          items: [
            { k: t('system.help.updates.buttons.expand.k', 'Tarjeta desplegable'), v: t('system.help.updates.buttons.expand.v', 'Muestra qué es la pieza, para qué se usa y en qué archivos aparece.') },
            { k: t('system.help.updates.buttons.analyze.k', 'Analizar riesgo (majors)'), v: t('system.help.updates.buttons.analyze.v', 'Hace un análisis IA read-only de changelog + uso real. CONSUME TOKENS y es admin-only.') },
            { k: t('system.help.updates.buttons.major.k', 'Checkbox de major'), v: t('system.help.updates.buttons.major.v', 'Incluye un salto mayor no bloqueado en la próxima corrida; siempre exige decisión humana y admin.') },
            { k: t('system.help.updates.buttons.run.k', 'Actualizar con sesión'), v: t('system.help.updates.buttons.run.v', 'Abre un chat Opus con Bash que explica el plan y espera tu confirmación antes de ejecutar. CONSUME TOKENS y es admin-only.') },
            { k: t('system.help.updates.buttons.automatic.k', 'Modo automático'), v: t('system.help.updates.buttons.automatic.v', 'Lanza el runner determinístico: drena, aplica, verifica, reinicia el servicio y reanuda. 0 tokens, admin-only y nunca reinicia la máquina.') },
            { k: t('system.help.updates.buttons.audit.k', 'Arreglar vulnerabilidades'), v: t('system.help.updates.buttons.audit.v', 'Corre npm audit fix sin --force, solo dentro de rangos reversibles. 0 tokens y admin-only.') },
            { k: t('system.help.updates.buttons.refresh.k', 'Re-escanear'), v: t('system.help.updates.buttons.refresh.v', 'Regenera el censo de versiones de terceros. No consume tokens.') },
            { k: t('system.help.updates.buttons.verify.k', 'Verificar salud'), v: t('system.help.updates.buttons.verify.v', 'Corre chequeos de salud determinísticos después de cambios. No consume tokens.') },
            { k: t('system.help.updates.buttons.npm.k', '→ versión estable'), v: t('system.help.updates.buttons.npm.v', 'Actualiza una librería reversible de forma individual en modo avanzado. Admin-only.') },
            { k: t('system.help.updates.buttons.dismiss.k', 'Cerrar y ver estado'), v: t('system.help.updates.buttons.dismiss.v', 'Sale del progreso terminado y vuelve al censo actualizado.') },
          ],
        }],
      },
      {
        title: t('system.help.updates.warning.title', 'Ojo con esto'),
        blocks: [{
          type: 'note',
          tone: 'danger',
          text: t('system.help.updates.warning.text', 'Un major nunca entra sin un veredicto IA favorable y una selección humana; sin veredicto, si rompe, si es riesgoso con confianza baja o si es beta/RC queda bloqueado. Las piezas críticas exigen confirmación humana siempre: la sesión espera tu OK del plan y el modo automático pide confirmación fuerte. Node --check no detecta imports rotos: el orquestador también verifica la web y auto-revierte npm si confirma una falla.'),
        }],
      },
    ],
  };
}
