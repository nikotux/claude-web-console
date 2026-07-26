// modules/system/help/unifi.js — ayuda contextual de UniFi.
import { t } from '../../../ui/i18n.js';

export default function unifiHelp() {
  return {
    title: t('system.help.unifi.title', 'Red (UniFi)'),
    icon: 'pulse',
    intro: t('system.help.unifi.intro', 'Este panel lee el UDM Pro y resume si la red está bien preparada para voz y llamadas. Es un puente estrictamente de solo lectura: jamás cambia la configuración del router.'),
    sections: [
      {
        title: t('system.help.unifi.first.title', 'Primeros pasos'),
        blocks: [{
          type: 'steps',
          items: [
            t('system.help.unifi.first.step1', 'Leé el semáforo y el resumen superior.'),
            t('system.help.unifi.first.step2', 'Abrí Hallazgos para ver qué regla disparó y su recomendación.'),
            t('system.help.unifi.first.step3', 'Revisá Radios / APs para canales, utilización y reintentos.'),
            t('system.help.unifi.first.step4', 'Revisá WAN para balanceo, Smart Queue, disponibilidad y latencia.'),
            t('system.help.unifi.first.step5', 'Tocá Re-escanear ahora para leer datos frescos del UDM Pro.'),
          ],
        }],
      },
      {
        title: t('system.help.unifi.legend.title', 'Leyenda'),
        blocks: [{
          type: 'legend',
          items: [
            { emoji: t('system.help.unifi.legend.green.emoji', '🟢'), name: t('system.help.unifi.legend.green.name', 'Verde'), desc: t('system.help.unifi.legend.green.desc', 'sin hallazgos importantes para voz') },
            { emoji: t('system.help.unifi.legend.yellow.emoji', '🟡'), name: t('system.help.unifi.legend.yellow.name', 'Amarillo'), desc: t('system.help.unifi.legend.yellow.desc', 'hay condiciones que conviene revisar') },
            { emoji: t('system.help.unifi.legend.red.emoji', '🔴'), name: t('system.help.unifi.legend.red.name', 'Rojo'), desc: t('system.help.unifi.legend.red.desc', 'hay una condición que puede afectar seriamente llamadas') },
            { emoji: t('system.help.unifi.legend.check.emoji', '✓'), name: t('system.help.unifi.legend.check.name', 'Activo'), desc: t('system.help.unifi.legend.check.desc', 'Band Steering o Smart Queue está habilitado') },
            { emoji: t('system.help.unifi.legend.cross.emoji', '✗'), name: t('system.help.unifi.legend.cross.name', 'Inactivo'), desc: t('system.help.unifi.legend.cross.desc', 'esa función no está habilitada según la lectura') },
          ],
        }],
      },
      {
        title: t('system.help.unifi.buttons.title', 'Botones y acciones'),
        blocks: [{
          type: 'kv',
          items: [
            { k: t('system.help.unifi.buttons.groups.k', 'Hallazgos / Radios / WAN'), v: t('system.help.unifi.buttons.groups.v', 'Expanden las tablas de auditoría y telemetría leídas del router.') },
            { k: t('system.help.unifi.buttons.rescan.k', 'Re-escanear ahora'), v: t('system.help.unifi.buttons.rescan.v', 'Vuelve a consultar el UDM Pro y recalcula reglas determinísticas. 0 tokens.') },
            { k: t('system.help.unifi.buttons.snapshot.k', 'Guardar snapshot en Pad'), v: t('system.help.unifi.buttons.snapshot.v', 'Guarda el resultado de la auditoría en Pad para conservar historial. Admin-only; no escribe al router.') },
          ],
        }],
      },
      {
        title: t('system.help.unifi.warning.title', 'Ojo con esto'),
        blocks: [{
          type: 'note',
          tone: 'warn',
          text: t('system.help.unifi.warning.text', 'La auditoría usa reglas determinísticas y 0 tokens: orienta, pero no reemplaza una investigación de red. Ningún botón de esta pantalla escribe al UDM Pro; Guardar snapshot solo escribe el informe en Pad.'),
        }],
      },
    ],
  };
}
