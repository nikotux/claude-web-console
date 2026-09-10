// modules/system/help/users.js — ayuda contextual de Usuarios.
import { t } from '../../../ui/i18n.js';

export default function usersHelp() {
  return {
    title: t('system.help.users.title', 'Usuarios'),
    icon: 'gear',
    intro: t('system.help.users.intro', 'Este panel administra las cuentas que pueden entrar a la consola, su rol de administrador y sus capacidades. También crea invitaciones de un solo uso para el alta guiada; todo es admin-only.'),
    sections: [
      {
        title: t('system.help.users.first.title', 'Primeros pasos'),
        blocks: [{
          type: 'steps',
          items: [
            t('system.help.users.first.step1', 'Para un alta directa, escribí usuario y contraseña y decidí si será admin.'),
            t('system.help.users.first.step2', 'Tocá Crear y comprobá que la cuenta aparezca en la lista.'),
            t('system.help.users.first.step3', 'Para alta self-service, generá una invitación y copiá el texto para la persona.'),
            t('system.help.users.first.step4', 'Usá los controles de cada fila para cambiar rol, contraseña o acceso.'),
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
            { k: t('system.help.users.buttons.delete.k', 'Eliminar usuario'), v: t('system.help.users.buttons.delete.v', 'Borra la cuenta, cierra sus sesiones, mueve su espacio privado a la papelera por 30 días y pide borrar su workspace de Pad. El usuario host no se puede eliminar desde esta pantalla.') },
            { k: t('system.help.users.buttons.invite.k', 'Generar invitación'), v: t('system.help.users.buttons.invite.v', 'Crea un token de un solo uso, válido por 24 horas, para /onboard.') },
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
          text: t('system.help.users.warning.text', 'Todo este panel es admin-only. Dar rol admin habilita backups, actualizaciones, reinicios y otras acciones sensibles. Dar la capacidad de supervisión entrega la lectura de las conversaciones privadas de todos los usuarios de la consola, por eso viene apagada por default incluso para las cuentas admin. Al eliminar una cuenta, sus credenciales quedan dentro de la papelera recuperable durante 30 días y la limpieza de Pad puede quedar pendiente si falta su credencial. Una invitación admin entrega esos mismos privilegios al completarse.'),
        }],
      },
    ],
  };
}
