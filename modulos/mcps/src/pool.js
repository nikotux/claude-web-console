/**
 * Sin este pool, N MCP colgados dejan al proceso con N conexiones o procesos en
 * vuelo. Los workers conservan el paralelismo pero ponen un techo verificable.
 */
export async function enPool(items, limite, tarea) {
  const lista = Array.from(items ?? []);
  const resultados = new Array(lista.length);
  const cantidad = Math.max(1, Math.min(lista.length || 1, Number(limite) || 1));
  let siguiente = 0;

  async function worker() {
    while (true) {
      const indice = siguiente;
      siguiente += 1;
      if (indice >= lista.length) return;
      try {
        resultados[indice] = { ok: true, valor: await tarea(lista[indice], indice), error: null };
      } catch (error) {
        resultados[indice] = { ok: false, valor: null, error };
      }
    }
  }

  await Promise.all(Array.from({ length: cantidad }, () => worker()));
  return resultados;
}

export default enPool;
