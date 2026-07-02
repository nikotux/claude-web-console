// core/wss.js — router de WebSocket con auth en el handshake.
//
// Un único WebSocketServer en modo noServer. En el evento 'upgrade' del HTTP
// server validamos el token ANTES de aceptar el socket: sin token válido, el
// WS se rechaza (401) y no se crea ningún PTY. Luego se despacha por path al
// handler que registró el módulo correspondiente.
import { WebSocketServer } from 'ws';
import { isAuthenticated } from './auth.js';

export function createWsRouter() {
  const wss = new WebSocketServer({
    noServer: true,
    // Comprime la salida del terminal (muy comprimible) para ahorrar ancho de
    // banda en enlaces lentos. `threshold` deja pasar sin comprimir los frames
    // chicos (tecleos), así no se agrega latencia a la interacción. Sin
    // "context takeover" para acotar el uso de memoria por conexión.
    perMessageDeflate: {
      threshold: 512,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      concurrencyLimit: 10,
      zlibDeflateOptions: { level: 6 },
    },
  });
  const routes = []; // { prefix, handler }

  // API que usan los módulos: wss.route('/ws/terminal', (ws, req) => {...})
  wss.route = (prefix, handler) => routes.push({ prefix, handler });

  function attach(httpServer) {
    httpServer.on('upgrade', (req, socket, head) => {
      // 1) Auth dura antes de cualquier cosa.
      if (!isAuthenticated(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      // 2) Ruteo por path.
      const url = new URL(req.url, 'http://localhost');
      const route = routes.find((r) => url.pathname.startsWith(r.prefix));
      if (!route) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Un handler que lance no debe tirar abajo el proceso entero.
        try {
          route.handler(ws, req, url);
        } catch (err) {
          console.error('[wss] Error en handler de WebSocket:', err);
          try { ws.close(); } catch { /* noop */ }
        }
      });
    });
  }

  return { wss, attach };
}
