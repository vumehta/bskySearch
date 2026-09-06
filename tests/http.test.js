import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson, HttpError, RequestTimeoutError } from '../src/http.mjs';

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

  it('does not fetch an already aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn());
    await expect(fetchJson('/cancel', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves useful HTTP error payloads and rejects malformed successful JSON', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"Try later"}', { status: 429 }))
      .mockResolvedValueOnce(new Response('<html>broken</html>')));
    await expect(fetchJson('/limited')).rejects.toMatchObject({ status: 429, message: 'Try later' });
    await expect(fetchJson('/broken')).rejects.toBeInstanceOf(HttpError);
  });

  it('clears its timer after a successful body read', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"posts":[]}')));
    await expect(fetchJson('/success')).resolves.toEqual({ posts: [] });
    expect(vi.getTimerCount()).toBe(0);
  });
});
