// modules/system/help/users.js — ayuda contextual de Usuarios.
import { t } from '../../../ui/i18n.js';

export default function usersHelp() {
  return {
    title: t('system.help.users.title', 'Usuarios'),
    icon: 'gear',
    intro: t('system.help.users.intro', 'Este panel separa administradores, accesos y patrocinios, y otros usuarios. Desde acá administrás cuentas, invitaciones, sponsors y conexiones; todo es admin-only.'),
    sections: [
      {
        title: t('system.help.users.first.title', 'Primeros pasos'),
        blocks: [{
          type: 'steps',
          items: [
            t('system.help.users.first.step1', 'Para un alta directa, escribí usuario y contraseña y decidí si será admin.'),
            t('system.help.users.first.step2', 'Abrí Accesos y patrocinios para generar una invitación común, admin o patrocinada; si corresponde, elegí el sponsor previsto.'),
            t('system.help.users.first.step3', 'Revisá Invitaciones pendientes y copiá o revocá los accesos según haga falta.'),
            t('system.help.users.first.step4', 'En Patrocinados u Otros usuarios, tocá ⚙ Gestionar para controlar patrocinio, conexiones y cuenta.'),
          ],
        }],
      },
      {
        title: t('system.help.users.legend.title', 'Leyenda'),
        blocks: [{
          type: 'legend',
          items: [
            { emoji: t('system.help.users.legend.admin.emoji', 'admin'), name: t('system.help.users.legend.admin.name', 'Administrador'), desc: t('system.help.users.legend.admin.desc', 'puede usar las acciones sensibles del sistema') },
            { emoji: t('system.help.users.legend.oversight.emoji', 'oversight'), name: t('system.help.users.legend.oversight.name', 'Supervisión'), desc: t('system.help.users.legend.oversight.desc', 'permite ver contenido ajeno; es una capacidad separada de admin, que administra la instancia, y viene apagada por default incluso para admins') },
            { emoji: t('system.help.users.legend.pending.emoji', '🎫'), name: t('system.help.users.legend.pending.name', 'Pendiente'), desc: t('system.help.users.legend.pending.desc', 'invitación válida que todavía no se consumió') },
            { emoji: t('system.help.users.legend.locked.emoji', '🔒'), name: t('system.help.users.legend.locked.name', 'En uso'), desc: t('system.help.users.legend.locked.desc', 'el onboarding reservó temporalmente esa invitación') },
            { emoji: t('system.help.users.legend.sponsored.emoji', '🟢'), name: t('system.help.users.legend.sponsored.name', 'Patrocinado'), desc: t('system.help.users.legend.sponsored.desc', 'la persona usa la credencial de Claude del sponsor asignado') },
            { emoji: t('system.help.users.legend.awaiting.emoji', '🟠'), name: t('system.help.users.legend.awaiting.name', 'Esperando sponsor'), desc: t('system.help.users.legend.awaiting.desc', 'el perfil patrocinado puede entrar, pero todavía no puede trabajar') },
            { emoji: t('system.help.users.legend.planned.emoji', '🤝'), name: t('system.help.users.legend.planned.name', 'Sponsor previsto'), desc: t('system.help.users.legend.planned.desc', 'la invitación ya tiene una persona asignada para patrocinar la cuenta') },
          ],
        }],
      },
      {
        title: t('system.help.users.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [{
          type: 'kv',
          items: [
            { k: t('system.help.users.buttons.adminBox.k', 'Checkbox admin'), v: t('system.help.users.buttons.adminBox.v', 'Define si la nueva cuenta o invitación tendrá privilegios de administrador.') },
            { k: t('system.help.users.buttons.create.k', 'Crear'), v: t('system.help.users.buttons.create.v', 'Da de alta inmediatamente una cuenta con usuario y contraseña.') },
            { k: t('system.help.users.buttons.role.k', 'Hacer / quitar admin'), v: t('system.help.users.buttons.role.v', 'Cambia el rol de una cuenta existente.') },
            { k: t('system.help.users.buttons.oversight.k', 'ver chats y terminales ajenos / dejar de ver contenido ajeno'), v: t('system.help.users.buttons.oversight.v', 'Al habilitarlo, permite ver los chats de otros usuarios en la barra lateral, abrirlos y adjuntarse a sus sesiones tmux, donde también se puede escribir. El cambio surte efecto en el request siguiente, sin que la persona tenga que volver a entrar; a diferencia de quitar el rol admin, no exige revocar sus sesiones.') },
            { k: t('system.help.users.buttons.password.k', 'Contraseña'), v: t('system.help.users.buttons.password.v', 'Reemplaza la contraseña de la cuenta elegida.') },
            { k: t('system.help.users.buttons.manage.k', '⚙ Gestionar'), v: t('system.help.users.buttons.manage.v', 'Abre el árbol de Patrocinio, Conexiones y Cuenta para un usuario no-admin.') },
            { k: t('system.help.users.buttons.sponsorship.k', 'Patrocinar / Cambiar sponsor / Liberar patrocinio'), v: t('system.help.users.buttons.sponsorship.v', 'Asigna, reemplaza o quita la persona cuya credencial de Claude consume el perfil patrocinado.') },
            { k: t('system.help.users.buttons.convert.k', 'Convertir en patrocinado'), v: t('system.help.users.buttons.convert.v', 'Cambia un perfil estándar a patrocinado y le asigna el sponsor elegido.') },
            { k: t('system.help.users.buttons.delete.k', 'Eliminar usuario'), v: t('system.help.users.buttons.delete.v', 'Borra la cuenta, cierra sus sesiones, mueve su espacio privado a la papelera por 30 días y pide borrar su workspace de Pad. El usuario host no se puede eliminar desde esta pantalla.') },
            { k: t('system.help.users.buttons.invite.k', 'Generar invitación'), v: t('system.help.users.buttons.invite.v', 'Crea un token de un solo uso, válido por 24 horas, para /onboard.') },
            { k: t('system.help.users.buttons.inviteSponsor.k', 'Select de sponsor en la invitación'), v: t('system.help.users.buttons.inviteSponsor.v', 'En una invitación patrocinada, permite dejar el sponsor pendiente o asignar desde el inicio uno de los candidatos elegibles.') },
            { k: t('system.help.users.buttons.connections.k', 'Semáforo de conexiones'), v: t('system.help.users.buttons.connections.v', 'Resume Microsoft y Zoho: 🟢 conectado, 🔵 en curso, 🔴 error y ⚪ sin conectar. El detalle permite conectar, renovar, desconectar o cancelar.') },
            { k: t('system.help.users.buttons.connectionGuide.k', '📖 Cómo conectar'), v: t('system.help.users.buttons.connectionGuide.v', 'Abre el instructivo paso a paso de Microsoft y Zoho; no consume tokens.') },
            { k: t('system.help.users.buttons.copy.k', 'Copiar invitación'), v: t('system.help.users.buttons.copy.v', 'Copia la URL de onboarding y el token para compartirlos con la persona.') },
            { k: t('system.help.users.buttons.revoke.k', 'Revocar'), v: t('system.help.users.buttons.revoke.v', 'Invalida una invitación pendiente para que ya no se pueda usar.') },
          ],
        }],
      },
      {
        title: t('system.help.users.warning.title', 'Ojo con esto'),
        blocks: [{
          type: 'note',
          tone: 'danger',
          text: t('system.help.users.warning.text', 'Todo este panel es admin-only. Dar rol admin habilita backups, actualizaciones, reinicios y otras acciones sensibles. Dar la capacidad de supervisión entrega la lectura de las conversaciones privadas de todos los usuarios de la consola, por eso viene apagada por default incluso para las cuentas admin. Patrocinar hace que esa persona consuma la credencial de Claude del sponsor elegido. Al conectar una cuenta ajena, verificá que la sesión sea la de esa persona y no la propia. Al eliminar una cuenta, sus credenciales quedan dentro de la papelera recuperable durante 30 días y la limpieza de Pad puede quedar pendiente si falta su credencial. Una invitación admin entrega esos mismos privilegios al completarse.'),
        }],
      },
    ],
  };
}
