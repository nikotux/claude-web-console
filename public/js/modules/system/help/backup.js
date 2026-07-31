// modules/system/help/backup.js — ayuda contextual de Backup.
import { t } from '../../../ui/i18n.js';

export default function backupHelp() {
  return {
    title: t('system.help.backup.title', 'Backup'),
    icon: 'download',
    intro: t('system.help.backup.intro', 'Desde acá podés crear un tar.gz de la consola junto con un respaldo separado de la base de Pad, guardar el código con commit/push y restaurar la consola desde disco o GitHub. También reúne los reinicios de mantenimiento; toda la pestaña es admin-only.'),
    sections: [
      {
        title: t('system.help.backup.first.title', 'Primeros pasos'),
        blocks: [{
          type: 'steps',
          items: [
            t('system.help.backup.first.step1', 'Tocá Crear backup ahora y esperá a que aparezca en la lista.'),
            t('system.help.backup.first.step2', 'Si querés respaldar código, revisá remote, rama, exclusiones y archivos nuevos.'),
            t('system.help.backup.first.step3', 'Elegí Commit sin push para guardar localmente o Push para enviar al remote personal.'),
            t('system.help.backup.first.step4', 'Usá Restaurar o Pull únicamente después de leer la confirmación y entender qué estado cambia.'),
            t('system.help.backup.first.step5', 'En Mantenimiento, elegí Reiniciar sesiones o Reiniciar el servidor según lo que necesite refrescarse.'),
          ],
        }],
      },
      {
        title: t('system.help.backup.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [{
          type: 'kv',
          items: [
            { k: t('system.help.backup.buttons.create.k', 'Crear backup ahora'), v: t('system.help.backup.buttons.create.v', 'Genera un tar.gz de la consola y, best-effort, un .db separado de Pad. Se conservan los últimos backups de cada tipo. Admin-only.') },
            { k: t('system.help.backup.buttons.restore.k', 'Restaurar'), v: t('system.help.backup.buttons.restore.v', 'Sobrescribe el estado actual con ese tar.gz y reinicia la web. Acción destructiva y admin-only.') },
            { k: t('system.help.backup.buttons.delete.k', 'Eliminar backup'), v: t('system.help.backup.buttons.delete.v', 'Borra definitivamente ese archivo de respaldo después de confirmar. Admin-only.') },
            { k: t('system.help.backup.buttons.commit.k', 'Commit (sin push)'), v: t('system.help.backup.buttons.commit.v', 'Crea un commit local con los cambios seleccionados; no toca GitHub. Admin-only.') },
            { k: t('system.help.backup.buttons.generate.k', 'Generar con IA'), v: t('system.help.backup.buttons.generate.v', 'Propone un mensaje de commit editable con una corrida corta de Haiku. CONSUME TOKENS y es admin-only.') },
            { k: t('system.help.backup.buttons.push.k', 'Push a GitHub ahora'), v: t('system.help.backup.buttons.push.v', 'Commitea y empuja solo al remote personal permitido; cada archivo nuevo exige selección humana. Admin-only.') },
            { k: t('system.help.backup.buttons.pull.k', 'Pull desde GitHub'), v: t('system.help.backup.buttons.pull.v', 'Hace fetch + fast-forward y protege cambios locales con stash; instala dependencias si cambiaron y reinicia solo con árbol sano. Admin-only.') },
            { k: t('system.help.backup.buttons.sessions.k', 'Reiniciar sesiones'), v: t('system.help.backup.buttons.sessions.v', 'Manda SIGTERM a los runners de chat vivos. No toca el servicio, no pierde historial y se relanzan con --resume. Admin-only.') },
            { k: t('system.help.backup.buttons.server.k', 'Reiniciar el servidor'), v: t('system.help.backup.buttons.server.v', 'Reinicia el proceso web; tmux y runners sobreviven y la página espera hasta que vuelva. Admin-only.') },
          ],
        }],
      },
      {
        title: t('system.help.backup.warning.title', 'Ojo con esto'),
        blocks: [{
          type: 'note',
          tone: 'danger',
          text: t('system.help.backup.warning.text', 'Restaurar y Eliminar actúan sobre el tar.gz de la consola; el .db de Pad se conserva como respaldo separado y no se restaura desde este panel. El push está bloqueado fuera del remote personal y jamás incluye .env, users.json ni certs; los untracked no viajan sin tu tilde. Reiniciar sesiones no es lo mismo que reiniciar el servidor.'),
        }],
      },
    ],
  };
}
