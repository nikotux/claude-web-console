// Herramientas de coordinación entre salas de Aduana (PLAN-3368).
// La lógica y la autoridad viven en el server; este MCP sólo valida, envía la
// operación por el runner y presenta el resultado a Cucho.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

function textResult(text, isError = false) {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(error) {
  return textResult(String(error || 'La operación de sala falló sin dar un motivo.'), true);
}

function jsonText(value) {
  return JSON.stringify(value ?? {}, null, 2);
}

export function createSalaToolServer({ request }) {
  async function run(op, args, successText) {
    try {
      const response = await request(op, args);
      if (!response?.ok) return errorResult(response?.error);
      return textResult(successText(response.result ?? {}));
    } catch (err) {
      return errorResult(err?.message || err);
    }
  }

  const abrirSubsala = tool(
    'abrir_subsala',
    'Abre una sub-sala de Aduana hija de esta sala, con los mismos participantes, que ARRANCA SOLA con el encargo. Usala cuando un participante te pida abrir sesiones, bloques o subsesiones. Hacé un llamado por sub-sala. Máximo 3500 caracteres: si el detalle es más largo, poné lo esencial y referenciá el ítem de Pad con `ref`. `entorno: true` le provisiona un entorno de preview de Tolkien, solo si el anfitrión lo permite.',
    {
      titulo: z.string().min(1).max(60).describe('Título de la nueva sub-sala.'),
      encargo: z.string().min(1).max(3500).describe('Encargo con el que la sub-sala debe arrancar sola.'),
      ref: z.string().max(40).optional().describe('Referencia opcional, por ejemplo PLAN-54.'),
      entorno: z.boolean().optional().describe('Solicita un entorno de preview de Tolkien para la sub-sala.'),
    },
    async (args) => run('abrir_subsala', args, (result) => {
      const chatId = String(result.chatId || 'desconocido');
      const titulo = String(result.titulo || result.title || args.titulo);
      return `Sub-sala creada: ${titulo} (chatId: ${chatId}).`;
    }),
    { alwaysLoad: true },
  );

  const listarSubsalas = tool(
    'listar_subsalas',
    'Lista las sub-salas hijas de esta sala de Aduana con su estado actual.',
    {},
    async () => run('listar_subsalas', {}, (result) => jsonText(result)),
    { alwaysLoad: true },
  );

  const avisarSubsala = tool(
    'avisar_subsala',
    'Le manda un mensaje a una sub-sala hija y la despierta para que Cucho reaccione.',
    {
      chatId: z.string().min(1).describe('ID de la sub-sala hija destinataria.'),
      texto: z.string().min(1).max(4000).describe('Mensaje para la sub-sala.'),
    },
    async (args) => run('avisar_subsala', args, (result) => (
      result?.mensaje || `Aviso enviado a la sub-sala ${args.chatId}.`
    )),
    { alwaysLoad: true },
  );

  const avisarSalaMadre = tool(
    'avisar_sala_madre',
    'Desde una sub-sala, avisa a la sala madre que terminaste el encargo, te bloqueaste o necesitás una decisión. La despierta para que Cucho reaccione.',
    {
      texto: z.string().min(1).max(4000).describe('Mensaje para la sala madre.'),
    },
    async (args) => run('avisar_sala_madre', args, (result) => (
      result?.mensaje || 'Aviso enviado a la sala madre.'
    )),
    { alwaysLoad: true },
  );

  return createSdkMcpServer({
    name: 'sala',
    version: '1.0.0',
    tools: [abrirSubsala, listarSubsalas, avisarSubsala, avisarSalaMadre],
  });
}
