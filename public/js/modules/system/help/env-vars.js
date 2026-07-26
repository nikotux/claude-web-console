// modules/system/help/env-vars.js — ayuda contextual de Variables de entorno.
import { t } from '../../../ui/i18n.js';

export default function envVarsHelp() {
  return {
    title: t('system.help.env.title', 'Variables de entorno'),
    icon: 'gear',
    intro: t('system.help.env.intro', 'Acá se define la identidad y los datos del cliente propios de esta instalación. Es configuración visible de la instancia: nunca guarda tokens, contraseñas ni otras credenciales.'),
    sections: [
      {
        title: t('system.help.env.first.title', 'Primeros pasos'),
        blocks: [{
          type: 'steps',
          items: [
            t('system.help.env.first.step1', 'Revisá Identidad para confirmar nombre, email, GitHub y firma.'),
            t('system.help.env.first.step2', 'Completá Cliente / proyecto con el MCP y el proyecto Infisical que correspondan.'),
            t('system.help.env.first.step3', 'Agregá o quitá las filas de departamentos de Zoho Desk.'),
            t('system.help.env.first.step4', 'Tocá Guardar y, si el aviso lo pide, reiniciá el servidor desde Backup para aplicar todo.'),
          ],
        }],
      },
      {
        title: t('system.help.env.buttons.title', 'Botones y acciones'),
        blocks: [{
          type: 'kv',
          items: [
            { k: t('system.help.env.buttons.fields.k', 'Campos de identidad y cliente'), v: t('system.help.env.buttons.fields.v', 'Editan la configuración activa de esta instalación. Solo los puede cambiar un administrador.') },
            { k: t('system.help.env.buttons.add.k', 'Agregar departamento'), v: t('system.help.env.buttons.add.v', 'Suma una fila clave → ID para Zoho Desk. Admin-only.') },
            { k: t('system.help.env.buttons.remove.k', 'Quitar'), v: t('system.help.env.buttons.remove.v', 'Elimina esa fila del formulario; el cambio se persiste recién al guardar. Admin-only.') },
            { k: t('system.help.env.buttons.save.k', 'Guardar'), v: t('system.help.env.buttons.save.v', 'Persiste la configuración permitida en la capa de instancia. Admin-only y 0 tokens.') },
          ],
        }],
      },
      {
        title: t('system.help.env.warning.title', 'Ojo con esto'),
        blocks: [{
          type: 'note',
          tone: 'warn',
          text: t('system.help.env.warning.text', 'Este panel NUNCA guarda secretos. CWC_TOKEN y otros secretos viven en .env; las credenciales viven bajo ~/.claude. Algunos motores leen la configuración al arrancar y necesitan reinicio del servidor para tomarla.'),
        }],
      },
    ],
  };
}
