// modules/system/help.js — ayudas contextuales de Mi configuración y Patrocinio.
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

export function sponsorshipHelp() {
  return {
    title: t('system.sponsorship.help.title', 'Patrocinio'),
    icon: 'checklist',
    intro: t('system.sponsorship.help.intro', 'Este panel te permite generar una credencial dedicada y revocable, y decidir a quién se la prestás. Nunca comparte tu .credentials.json y conserva separados el espacio y los datos de cada persona.'),
    sections: [
      {
        title: t('system.sponsorship.help.what.title', 'Qué es'),
        blocks: [{
          type: 'p',
          text: t('system.sponsorship.help.what.text', 'El token de patrocinio es un claude setup-token dedicado: la consola se lo presta a quienes adoptes. Sin ese token, la persona existe pero no puede trabajar. Cuando la adoptás, su consumo se carga a tu suscripción hasta que decidas soltarla.'),
        }],
      },
      {
        title: t('system.sponsorship.help.first.title', 'Primeros pasos'),
        blocks: [{
          type: 'steps',
          items: [
            t('system.sponsorship.help.first.step1', 'Desplegá Patrocinio y comprobá si tu token figura listo o pendiente.'),
            t('system.sponsorship.help.first.step2', 'Si está pendiente, tocá Generar mi token de patrocinio y completá el login antes de adoptar a alguien. Generarlo no consume tokens de IA.'),
            t('system.sponsorship.help.first.step3', 'Abrí Esperando que alguien los adopte y revisá el nombre de la persona.'),
            t('system.sponsorship.help.first.step4', 'Tocá Adoptar y confirmá que aceptás pagar su consumo con tu llave.'),
          ],
        }],
      },
      {
        title: t('system.sponsorship.help.legend.title', 'Leyenda'),
        wide: true,
        blocks: [{
          type: 'legend',
          items: [
            { icon: 'checklist', name: t('system.sponsorship.help.legend.panel.name', 'Patrocinio'), desc: t('system.sponsorship.help.legend.panel.desc', 'resume tu estado y cuántas personas patrocinás o esperan') },
            { icon: 'check', name: t('system.sponsorship.help.legend.tokenReady.name', '🔑 Token listo'), desc: t('system.sponsorship.help.legend.tokenReady.desc', 'la credencial dedicada ya puede usarse para las personas que patrocines') },
            { icon: 'clock', name: t('system.sponsorship.help.legend.tokenPending.name', '⚠️ Token pendiente'), desc: t('system.sponsorship.help.legend.tokenPending.desc', 'generalo y completá el login antes de adoptar a alguien') },
            { icon: 'check', name: t('system.sponsorship.help.legend.sponsored.name', 'Patrocinado'), desc: t('system.sponsorship.help.legend.sponsored.desc', 'esa persona ya trabaja usando tu llave') },
            { icon: 'clock', name: t('system.sponsorship.help.legend.waiting.name', 'Esperando'), desc: t('system.sponsorship.help.legend.waiting.desc', 'todavía necesita que alguien la adopte') },
            { icon: 'plus', name: t('system.sponsorship.help.legend.adopt.name', 'Adoptar'), desc: t('system.sponsorship.help.legend.adopt.desc', 'vincula a la persona con tu llave') },
            { icon: 'minus', name: t('system.sponsorship.help.legend.release.name', 'Soltar'), desc: t('system.sponsorship.help.legend.release.desc', 'termina el patrocinio actual') },
          ],
        }],
      },
      {
        title: t('system.sponsorship.help.buttons.title', 'Botones y acciones'),
        blocks: [{
          type: 'kv',
          items: [
            { k: t('system.sponsorship.help.buttons.panel.k', 'Patrocinio'), v: t('system.sponsorship.help.buttons.panel.v', 'Expande o contrae el panel. Consultar estas listas no consume tokens.') },
            { k: t('system.sponsorship.help.buttons.generate.k', 'Generar mi token de patrocinio'), v: t('system.sponsorship.help.buttons.generate.v', 'Abre el login para crear la credencial dedicada. Generarla no consume tokens de IA.') },
            { k: t('system.sponsorship.help.buttons.sendCode.k', 'Enviar código'), v: t('system.sponsorship.help.buttons.sendCode.v', 'Envía el código que copiaste de la autorización para terminar el login. No consume tokens de IA.') },
            { k: t('system.sponsorship.help.buttons.retry.k', 'Reintentar'), v: t('system.sponsorship.help.buttons.retry.v', 'Vuelve a iniciar el login si falló. No consume tokens de IA.') },
            { k: t('system.sponsorship.help.buttons.cancel.k', 'Cancelar'), v: t('system.sponsorship.help.buttons.cancel.v', 'Detiene el login en curso y cierra el asistente. No consume tokens de IA.') },
            { k: t('system.sponsorship.help.buttons.adopt.k', 'Adoptar'), v: t('system.sponsorship.help.buttons.adopt.v', 'Después de confirmar, esa persona empieza a usar tu llave. La acción no consume tokens por sí misma; el trabajo posterior de esa persona sí.') },
            { k: t('system.sponsorship.help.buttons.release.k', 'Soltar'), v: t('system.sponsorship.help.buttons.release.v', 'Después de confirmar, corta el acceso de esa persona hasta que otro sponsor la adopte. No consume tokens.') },
            { k: t('system.sponsorship.help.buttons.help.k', 'Ayuda'), v: t('system.sponsorship.help.buttons.help.v', 'Abre esta guía contextual. No consume tokens.') },
          ],
        }],
      },
      {
        title: t('system.sponsorship.help.warning.title', 'Ojo con esto'),
        blocks: [{
          type: 'note',
          tone: 'warn',
          text: t('system.sponsorship.help.warning.text', 'El token sale de TU suscripción de Claude: quien patrocinás consume con tu cuenta y vos pagás sus turnos. Generar el token es solamente un login y no consume tokens de IA. Si soltás a la persona, deja de poder trabajar inmediatamente. Una cuenta patrocinada no puede patrocinar a otra.'),
        }],
      },
    ],
  };
}
