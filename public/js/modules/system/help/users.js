// modules/system/help/users.js — ayuda contextual de Usuarios.
import { t } from '../../../ui/i18n.js';

export default function usersHelp() {
  return {
    title: t('system.help.users.title', 'Usuarios'),
    icon: 'gear',
    intro: t('system.help.users.intro', 'Este panel administra las cuentas que pueden entrar a la consola y sus permisos de administrador. También crea invitaciones de un solo uso para el alta guiada; todo es admin-only.'),
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
            { k: t('system.help.users.buttons.password.k', 'Contraseña'), v: t('system.help.users.buttons.password.v', 'Reemplaza la contraseña de la cuenta elegida.') },
            { k: t('system.help.users.buttons.delete.k', 'Eliminar usuario'), v: t('system.help.users.buttons.delete.v', 'Borra la cuenta y hace que sus sesiones de autenticación dejen de valer.') },
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
          text: t('system.help.users.warning.text', 'Todo este panel es admin-only. Dar rol admin habilita backups, actualizaciones, reinicios y otras acciones sensibles. Eliminar una cuenta invalida sus sesiones; una invitación admin entrega esos mismos privilegios al completarse.'),
        }],
      },
    ],
  };
}
