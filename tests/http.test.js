import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson, RequestTimeoutError } from '../src/http.mjs';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('browser JSON requests', () => {
  it('keeps the deadline active after headers arrive', async () => {
    vi.useFakeTimers();
    let requestSignal;
    vi.stubGlobal('fetch', vi.fn(async (_, options) => {
      requestSignal = options.signal;
      return { ok: true, json: () => new Promise(() => {}) };
    }));
    const request = fetchJson('/slow-body', { timeoutMs: 50 });
    const failure = expect(request).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await failure;
    expect(requestSignal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a pending body when the caller aborts', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}) })));
    const request = fetchJson('/cancel', { signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

});
