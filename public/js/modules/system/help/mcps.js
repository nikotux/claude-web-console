// modules/system/help/mcps.js — ayuda contextual de Conexiones (MCP).
import { t } from '../../../ui/i18n.js';

export default function mcpsHelp() {
  return {
    title: t('system.help.mcps.title', 'Conexiones (MCP)'),
    icon: 'gear',
    intro: t('system.help.mcps.intro', 'Acá ves qué conexiones externas pueden usar los agentes y si sus llaves siguen funcionando. Cada servidor se controla por separado, así que uno caído no bloquea el resto del panel.'),
    sections: [
      {
        title: t('system.help.mcps.first.title', 'Primeros pasos'),
        blocks: [{
          type: 'steps',
          items: [
            t('system.help.mcps.first.step1', 'Abrí el Llavero para revisar motores, credenciales y servicios de los que dependen las conexiones.'),
            t('system.help.mcps.first.step2', 'Abrí el mundo que te interesa y buscá la tarjeta del servidor MCP.'),
            t('system.help.mcps.first.step3', 'Tocá Verificar este si querés actualizar solo ese estado, sin esperar a los demás.'),
            t('system.help.mcps.first.step4', 'Si pide autorización, tocá Reconectar y seguí el enlace y los pasos guiados.'),
            t('system.help.mcps.first.step5', 'Después de renovar credenciales, reciclá los runners para que los chats vivos las vuelvan a leer.'),
          ],
        }],
      },
      {
        title: t('system.help.mcps.tolkien.title', 'Conectar tu sesión de Tolkien'),
        blocks: [{
          type: 'steps',
          items: [
            t('system.help.mcps.tolkien.step1', 'Buscá la tarjeta 🌳 Tolkien dentro de «Cuentas conectadas».'),
            t('system.help.mcps.tolkien.step2', 'Tocá «Conectar»: el asistente te indica dónde copiar el valor de __Secure-tolkien.session desde las herramientas de desarrollo de tu propio navegador.'),
            t('system.help.mcps.tolkien.step3', 'La conexión es por usuario: cada persona conecta su propia sesión y nunca se comparte ni se hereda la cuenta de otra.'),
            t('system.help.mcps.tolkien.step4', 'Leé el semáforo de la tarjeta: 🟢 está al día, 🟡 vence en 3 días o menos y 🔴 está vencida o sin conectar.'),
            t('system.help.mcps.tolkien.step5', '«Desconectar» solo borra la copia guardada en la consola; no cierra tu sesión en Tolkien.'),
          ],
        }],
      },
      {
        title: t('system.help.mcps.legend.title', 'Leyenda de estados'),
        wide: true,
        blocks: [{
          type: 'legend',
          items: [
            { emoji: t('system.help.mcps.legend.green.emoji', '🟢'), name: t('system.help.mcps.legend.green.name', 'Conectado'), desc: t('system.help.mcps.legend.green.desc', 'la conexión respondió y está lista') },
            { emoji: t('system.help.mcps.legend.blue.emoji', '🔵'), name: t('system.help.mcps.legend.blue.name', 'En curso'), desc: t('system.help.mcps.legend.blue.desc', 'se está verificando o completando una conexión') },
            { emoji: t('system.help.mcps.legend.yellow.emoji', '🟡'), name: t('system.help.mcps.legend.yellow.name', 'Requiere tu acción'), desc: t('system.help.mcps.legend.yellow.desc', 'falta autenticar, renovar o completar un paso') },
            { emoji: t('system.help.mcps.legend.timeout.emoji', '⏱️'), name: t('system.help.mcps.legend.timeout.name', 'No respondió'), desc: t('system.help.mcps.legend.timeout.desc', 'ese MCP agotó su tiempo propio; los demás siguen operables') },
            { emoji: t('system.help.mcps.legend.red.emoji', '🔴'), name: t('system.help.mcps.legend.red.name', 'Error'), desc: t('system.help.mcps.legend.red.desc', 'falló la verificación o la conexión') },
            { emoji: t('system.help.mcps.legend.gray.emoji', '⚪'), name: t('system.help.mcps.legend.gray.name', 'Sin configurar'), desc: t('system.help.mcps.legend.gray.desc', 'todavía no hay datos o credenciales suficientes') },
            { emoji: t('system.help.mcps.legend.stale.emoji', '⚠'), name: t('system.help.mcps.legend.stale.name', 'Dato guardado'), desc: t('system.help.mcps.legend.stale.desc', 'se muestra el último estado conocido mientras vuelve la fuente') },
          ],
        }],
      },
      {
        title: t('system.help.mcps.buttons.title', 'Botones y acciones'),
        wide: true,
        blocks: [{
          type: 'kv',
          items: [
            { k: t('system.help.mcps.buttons.reverify.k', 'Re-verificar'), v: t('system.help.mcps.buttons.reverify.v', 'Actualiza el censo y dispara chequeos por servidor. No consume tokens.') },
            { k: t('system.help.mcps.buttons.check.k', 'Verificar este'), v: t('system.help.mcps.buttons.check.v', 'Comprueba solo la tarjeta elegida; un timeout no bloquea las demás.') },
            { k: t('system.help.mcps.buttons.reconnect.k', 'Reconectar'), v: t('system.help.mcps.buttons.reconnect.v', 'Abre la reconexión OAuth guiada y verifica el resultado al terminar. Admin-only para MCP de instancia.') },
            { k: t('system.help.mcps.buttons.infisical.k', 'Reconectar Infisical'), v: t('system.help.mcps.buttons.infisical.v', 'Repara la llave real de un MCP que arranca con Infisical. El token pegado no se guarda en el job. Admin-only.') },
            { k: t('system.help.mcps.buttons.disconnect.k', 'Desconectar'), v: t('system.help.mcps.buttons.disconnect.v', 'Limpia las credenciales OAuth de ese MCP; después habrá que autorizarlo de nuevo. Admin-only.') },
            { k: t('system.help.mcps.buttons.copy.k', 'Copiar comando'), v: t('system.help.mcps.buttons.copy.v', 'Copia la alternativa manual para correrla en una terminal interactiva.') },
            { k: t('system.help.mcps.buttons.keyring.k', 'Reconectar / Verificar del Llavero'), v: t('system.help.mcps.buttons.keyring.v', 'Guía la reparación disponible o vuelve a medir una llave o servicio concreto.') },
            { k: t('system.help.mcps.buttons.serviceRestart.k', 'Reiniciar y verificar'), v: t('system.help.mcps.buttons.serviceRestart.v', 'Reinicia el servicio indicado por el Llavero y comprueba que vuelva activo. Es admin-only y no consume tokens; si reinicia la consola, la web se reconecta sola.') },
            { k: t('system.help.mcps.buttons.accounts.k', 'Conectar / Renovar cuenta'), v: t('system.help.mcps.buttons.accounts.v', 'Conecta tu cuenta personal de Microsoft, Zoho o Codex; los tokens son por usuario.') },
            { k: t('system.help.mcps.buttons.tolkienConnect.k', 'Conectar / Reconectar (Tolkien)'), v: t('system.help.mcps.buttons.tolkienConnect.v', 'Abre el asistente para guardar y verificar tu sesión personal de Tolkien. No consume tokens de IA.') },
            { k: t('system.help.mcps.buttons.tolkienDisconnect.k', 'Desconectar (Tolkien)'), v: t('system.help.mcps.buttons.tolkienDisconnect.v', 'Borra de la consola la copia de tu sesión, sin cerrar Tolkien en el navegador. No consume tokens de IA.') },
            { k: t('system.help.mcps.buttons.recycle.k', 'Reciclar runners'), v: t('system.help.mcps.buttons.recycle.v', 'Manda SIGTERM a los motores de chat vivos para que relean credenciales; conserva el historial y es admin-only.') },
          ],
        }],
      },
      {
        title: t('system.help.mcps.warning.title', 'Ojo con esto'),
        blocks: [
          {
            type: 'note',
            tone: 'warn',
            text: t('system.help.mcps.warning.text', 'Si el mismo MCP aparece en varios scopes con endpoints distintos, la consola muestra el conflicto y comandos para copiar, pero nunca decide cuál borrar. Una credencial renovada no llega a runners ya vivos hasta reciclarlos.'),
          },
          {
            type: 'note',
            tone: 'warn',
            text: t('system.help.mcps.tolkien.warning', 'La sesión de Tolkien vence sola (aproximadamente cada 30 días) y hay que reconectarla desde acá. Cuando la consola no pudo confirmar la fecha con Tolkien, la muestra como estimada y conviene reconectar antes de que moleste. La herramienta que censa y cierra tickets lee la sesión desde el directorio de datos del usuario: para el usuario anfitrión es la misma ruta donde este asistente la guarda y funciona sin más; un usuario invitado que ejecute esa herramienta desde una terminal suelta necesita tener CWC_DATA_DIR en su entorno, mientras que desde sus chats de la consola ya viene configurado.'),
          },
        ],
      },
    ],
  };
}
