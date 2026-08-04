const INICIALIZAR = Object.freeze({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'ntux-mcps', version: '0.1.0' },
  },
});

function milisegundos(desde) {
  return Math.max(0, Date.now() - desde);
}

function jsonRpcDesdeTexto(texto) {
  const candidatos = [texto];
  for (const linea of String(texto).split(/\r?\n/)) {
    if (linea.startsWith('data:')) candidatos.push(linea.slice(5).trim());
  }
  for (const candidato of candidatos) {
    if (!candidato) continue;
    try {
      const valor = JSON.parse(candidato);
      if (valor?.jsonrpc === '2.0' && valor?.id === 1) return valor;
    } catch {
      // Un stream SSE puede traer comentarios o mas de un evento; se prueban todos.
    }
  }
  return null;
}

async function cuerpoRespuesta(respuesta) {
  if (typeof respuesta?.text === 'function') return respuesta.text();
  if (typeof respuesta?.json === 'function') return JSON.stringify(await respuesta.json());
  return '';
}

/**
 * La configuracion saneada conserva nombres de cabeceras, no valores. Por eso no
 * se envia autenticacion: un 401/403 es `requiere_auth`, nunca un falso `caido`.
 */
export async function sondaHttp({
  servidor,
  timeoutMs,
  pedir,
  ahora = Date.now,
  registrarCancelacion = null,
}) {
  const inicio = typeof ahora === 'function' ? ahora() : Date.now();
  const inicioMs = typeof inicio === 'number' ? inicio : Date.parse(inicio) || Date.now();
  const control = new AbortController();
  let timer = null;
  let resolverPlazo = null;
  const cancelar = () => {
    control.abort();
    resolverPlazo?.({ estado: 'timeout', ms: milisegundos(inicioMs), motivo: 'sondeo cancelado' });
  };
  const liberar = registrarCancelacion?.(cancelar);

  try {
    const solicitud = Promise.resolve()
      .then(() => pedir(servidor.url, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify(INICIALIZAR),
        signal: control.signal,
      }))
      .then(async (respuesta) => {
        const ms = milisegundos(inicioMs);
        if (respuesta?.status === 401 || respuesta?.status === 403) {
          return { estado: 'requiere_auth', ms, motivo: `HTTP ${respuesta.status}` };
        }
        if (!respuesta || respuesta.status < 200 || respuesta.status >= 300) {
          return { estado: 'caido', ms, motivo: `HTTP ${respuesta?.status ?? 'sin respuesta'}` };
        }
        const texto = await cuerpoRespuesta(respuesta);
        if (!jsonRpcDesdeTexto(texto)) {
          return { estado: 'caido', ms: milisegundos(inicioMs), motivo: 'respuesta JSON-RPC invalida' };
        }
        return { estado: 'ok', ms: milisegundos(inicioMs), motivo: null };
      })
      .catch((error) => {
        const timeout = error?.name === 'AbortError' || control.signal.aborted;
        return {
          estado: timeout ? 'timeout' : 'caido',
          ms: milisegundos(inicioMs),
          motivo: timeout ? `timeout de ${timeoutMs} ms` : (error?.message ?? 'error de red'),
        };
      });

    const plazo = new Promise((resolve) => {
      resolverPlazo = resolve;
      // Excepcion acotada: esta carrera no sobrevive a la promesa y se limpia abajo.
      timer = setTimeout(() => {
        control.abort();
        resolve({ estado: 'timeout', ms: milisegundos(inicioMs), motivo: `timeout de ${timeoutMs} ms` });
      }, timeoutMs);
    });
    return await Promise.race([solicitud, plazo]);
  } catch (error) {
    return { estado: 'caido', ms: milisegundos(inicioMs), motivo: error?.message ?? 'fallo de sonda HTTP' };
  } finally {
    clearTimeout(timer);
    if (typeof liberar === 'function') liberar();
  }
}

export async function sondaStdio({
  servidor,
  timeoutMs,
  proceso,
  permitido,
  registrarCancelacion = null,
}) {
  if (!permitido) {
    return {
      estado: 'no_sondeado',
      ms: null,
      motivo: 'NTUX_MCPS_SONDEO_STDIO esta en false',
    };
  }

  const inicio = Date.now();
  let hijo = null;
  let timer = null;
  let liberar = null;
  let limpiarOyentes = () => {};
  try {
    if (!servidor.comando) {
      return { estado: 'caido', ms: 0, motivo: 'el transporte stdio no declara comando' };
    }
    hijo = proceso.lanzar(servidor.comando, servidor.argumentos ?? [], { stdio: 'pipe' });

    const resultado = new Promise((resolve) => {
      let resuelto = false;
      let pendiente = '';
      const finalizar = (valor) => {
        if (resuelto) return;
        resuelto = true;
        resolve(valor);
      };
      const alError = (error) => finalizar({
        estado: 'caido', ms: milisegundos(inicio), motivo: error?.message ?? 'el proceso no arranco',
      });
      const alSalir = (codigo, senal) => finalizar({
        estado: 'caido',
        ms: milisegundos(inicio),
        motivo: `el proceso termino antes de responder (${codigo ?? senal ?? 'sin codigo'})`,
      });
      const alStderr = (trozo) => finalizar({
        estado: 'caido',
        ms: milisegundos(inicio),
        motivo: `stderr: ${String(trozo).trim() || 'salida de error'}`,
      });
      const alDato = (trozo) => {
        pendiente += String(trozo);
        const lineas = pendiente.split(/\r?\n/);
        pendiente = lineas.pop() ?? '';
        for (const linea of lineas) {
          if (!linea.trim()) continue;
          let respuesta;
          try {
            respuesta = JSON.parse(linea);
          } catch {
            finalizar({ estado: 'caido', ms: milisegundos(inicio), motivo: 'respuesta JSON invalida' });
            return;
          }
          if (respuesta?.jsonrpc === '2.0' && respuesta?.id === 1) {
            finalizar({ estado: 'ok', ms: milisegundos(inicio), motivo: null });
            return;
          }
        }
      };

      hijo.once?.('error', alError);
      hijo.once?.('exit', alSalir);
      hijo.stdout?.on?.('data', alDato);
      hijo.stderr?.on?.('data', alStderr);
      limpiarOyentes = () => {
        hijo.off?.('error', alError);
        hijo.off?.('exit', alSalir);
        hijo.stdout?.off?.('data', alDato);
        hijo.stderr?.off?.('data', alStderr);
      };
      liberar = registrarCancelacion?.(() => finalizar({
        estado: 'timeout', ms: milisegundos(inicio), motivo: 'sondeo cancelado',
      }));

      // Excepcion acotada: la carrera pertenece a esta sonda y siempre se limpia.
      timer = setTimeout(() => finalizar({
        estado: 'timeout', ms: milisegundos(inicio), motivo: `timeout de ${timeoutMs} ms`,
      }), timeoutMs);

      try {
        hijo.stdin?.write?.(`${JSON.stringify(INICIALIZAR)}\n`);
      } catch (error) {
        alError(error);
      }
    });

    return await resultado;
  } catch (error) {
    return { estado: 'caido', ms: milisegundos(inicio), motivo: error?.message ?? 'fallo de sonda stdio' };
  } finally {
    clearTimeout(timer);
    limpiarOyentes();
    if (typeof liberar === 'function') liberar();
    if (hijo) {
      try {
        proceso.terminar(hijo);
      } catch {
        // Terminar es la ultima barrera: el resultado ya esta saneado y no se relanza.
      }
    }
  }
}
