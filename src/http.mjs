export class HttpError extends Error {
  constructor(status, payload, retryAfter = null) {
    super(payload?.message || payload?.error || `Request failed: ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.payload = payload;
    this.retryAfter = retryAfter;
  }
}

export class RequestTimeoutError extends Error {
  constructor() {
    super('Request timed out. Please try again.');
    this.name = 'RequestTimeoutError';
  }
}

const abortError = () => new DOMException('Request aborted.', 'AbortError');

export function throwIfAborted(signal) {
  if (signal.aborted) throw abortError();
}

export function isRetryableError(error) {
  if (error instanceof HttpError) return error.status === 408 || error.status === 429 || error.status >= 500;
  return error instanceof RequestTimeoutError || error instanceof TypeError;
}

export async function fetchJson(url, { signal, timeoutMs = 10000, ...options } = {}) {
  const controller = new AbortController();
  let abortReason = null;
  const abort = (reason) => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    controller.abort(reason);
  };
  const abortFromCaller = () => abort(signal.reason || abortError());
  if (signal?.aborted) {
    abortFromCaller();
  } else {
    signal?.addEventListener('abort', abortFromCaller, { once: true });
  }

  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortReason);
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => abort(new RequestTimeoutError()), timeoutMs);

  try {
    if (controller.signal.aborted) return await aborted;
    const operation = (async () => {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const retryAfter = response.headers?.get?.('Retry-After') ?? null;
      let payload;
      try {
        payload = await response.json();
      } catch {
        if (controller.signal.aborted) throw abortReason;
        if (!response.ok) throw new HttpError(response.status, null, retryAfter);
        throw new HttpError(502, { error: 'The server returned an invalid response.' });
      }
      if (!response.ok) throw new HttpError(response.status, payload, retryAfter);
      return payload;
    })();
    return await Promise.race([operation, aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
