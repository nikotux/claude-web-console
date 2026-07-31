// Reintento común ante límites transitorios del proveedor. Vive en core/
// porque lo comparten runners desacoplados de bin/ y no debe arrastrar config
// ni ninguna otra dependencia del proyecto a sus entornos limpios.

export const RETRY_BACKOFF_MS = 15000;
export const MAX_RETRIES = 3;

export function isRateLimit(err) {
  return /429|rate.?limit|overloaded|too many requests|529|503/.test(
    String(err?.message || err).toLowerCase(),
  );
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRateLimitRetry(fn, opts = {}) {
  const {
    attempts = MAX_RETRIES,
    backoffMs = RETRY_BACKOFF_MS,
    shouldRetry,
    onRetry,
    sleep = defaultSleep,
  } = opts;
  let attempt = 0;

  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (!isRateLimit(error) || attempt >= attempts) throw error;
      const retry = { attempt: attempt + 1, error };
      if (shouldRetry && !(await shouldRetry(retry))) throw error;
      attempt = retry.attempt;
      if (onRetry) await onRetry(retry);
      await sleep(backoffMs);
    }
  }
}
