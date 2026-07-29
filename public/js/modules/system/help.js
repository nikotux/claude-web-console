// modules/system/help.js — ayuda contextual de Mi configuración.
import { t } from '../../ui/i18n.js';

export default function myConfigHelp() {
  return {
    title: t('system.myconfig.help.title', 'Mi configuración'),
    icon: 'checklist',
    intro: t('system.myconfig.help.intro', 'Es el checklist personal de las cuentas y herramientas que necesita tu usuario. Lee tu sesión normal: ni un administrador puede usar esta ruta para mirar la configuración de otra persona.'),
    sections: [
      {
        title: t('system.myconfig.help.first.title', 'Primeros pasos'),
        blocks: [{
          type: 'steps',
          items: [
            t('system.myconfig.help.first.step1', 'Desplegá Mi configuración para ver el resumen de capacidades y provisioning.'),
            t('system.myconfig.help.first.step2', 'Abrí Capacidades para identificar conexiones pendientes u opcionales.'),
            t('system.myconfig.help.first.step3', 'Si falta una capacidad, tocá Conectar y continuá solo si conservás una invitación válida.'),
            t('system.myconfig.help.first.step4', 'Abrí Provisioning y usá Reintentar si Pad, workspace, skills o Tolkien MCP fallaron o quedaron pendientes.'),
          ],
        }],
      },
      {
        title: t('system.myconfig.help.legend.title', 'Leyenda'),
        wide: true,
        blocks: [{
          type: 'legend',
          items: [
            { icon: 'check', name: t('system.myconfig.help.legend.ready.name', 'Lista'), desc: t('system.myconfig.help.legend.ready.desc', 'la capacidad o el paso fue detectado correctamente') },
            { icon: 'clock', name: t('system.myconfig.help.legend.pending.name', 'Pendiente'), desc: t('system.myconfig.help.legend.pending.desc', 'todavía falta completar o verificar ese elemento') },
            { icon: 'externalLink', name: t('system.myconfig.help.legend.connect.name', 'Conectar'), desc: t('system.myconfig.help.legend.connect.desc', 'abre el asistente protegido por token de invitación') },
            { icon: 'refresh', name: t('system.myconfig.help.legend.retry.name', 'Reintentar'), desc: t('system.myconfig.help.legend.retry.desc', 'vuelve a lanzar los pasos idempotentes de provisioning') },
          ],
        }],
      },
      {
        title: t('system.myconfig.help.buttons.title', 'Botones y acciones'),
        blocks: [{
          type: 'kv',
          items: [
            { k: t('system.myconfig.help.buttons.panel.k', 'Mi configuración'), v: t('system.myconfig.help.buttons.panel.v', 'Expande o contrae el panel. Consultar el estado no consume tokens.') },
            { k: t('system.myconfig.help.buttons.group.k', 'Capacidades / Provisioning'), v: t('system.myconfig.help.buttons.group.v', 'Expande cada rama del checklist. No consume tokens.') },
            { k: t('system.myconfig.help.buttons.connect.k', 'Conectar'), v: t('system.myconfig.help.buttons.connect.v', 'Te lleva al asistente público, que exige una invitación y nunca saltea su autenticación. La conexión no consume tokens de IA.') },
            { k: t('system.myconfig.help.buttons.retry.k', 'Reintentar'), v: t('system.myconfig.help.buttons.retry.v', 'Relanza Pad, workspace, skills y Tolkien MCP para tu usuario. Es idempotente y no consume tokens de IA.') },
            { k: t('system.myconfig.help.buttons.help.k', 'Ayuda'), v: t('system.myconfig.help.buttons.help.v', 'Abre esta guía contextual. No consume tokens.') },
          ],
        }],
      },
      {
        title: t('system.myconfig.help.warning.title', 'Ojo con esto'),
        blocks: [{
          type: 'note',
          tone: 'warn',
          text: t('system.myconfig.help.warning.text', 'Mi configuración nunca acepta un nombre de usuario: siempre usa la cuenta de tu sesión. Las conexiones siguen protegidas por el token de invitación; si lo perdiste, pedile una invitación al administrador. Reintentar provisioning no reemplaza credenciales faltantes.'),
        }],
      },
    ],
  };
}
