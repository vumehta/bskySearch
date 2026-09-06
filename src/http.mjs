export class HttpError extends Error {
  constructor(status, payload) {
    super(payload?.message || payload?.error || `Request failed: ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.payload = payload;
  }
}

export class RequestTimeoutError extends Error {
  constructor() {
    super('Request timed out. Please try again.');
    this.name = 'RequestTimeoutError';
  }
}

// A deadline covers both headers and body consumption. Racing the operation
// also bounds adapters that do not implement AbortSignal themselves.
export async function fetchJson(url, { signal, timeoutMs = 10000, ...options } = {}) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal.reason);
  if (signal?.aborted) {
    abortFromCaller();
  } else {
    signal?.addEventListener('abort', abortFromCaller, { once: true });
  }

  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason || new DOMException('Request aborted.', 'AbortError'));
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new RequestTimeoutError()), timeoutMs);

  try {
    if (controller.signal.aborted) return await aborted;
    const operation = (async () => {
      const response = await fetch(url, { ...options, signal: controller.signal });
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!response.ok) throw new HttpError(response.status, null);
        throw new HttpError(502, { error: 'The server returned an invalid response.' });
      }
      if (!response.ok) throw new HttpError(response.status, payload);
      return payload;
    })();
    return await Promise.race([operation, aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
