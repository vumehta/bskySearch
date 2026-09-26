import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, testUtils } from '../api/search.mjs';
import { SEARCH_JOB_TIMEOUT_MS, SEARCH_REQUEST_TIMEOUT_MS } from '../src/constants.mjs';
import { fetchJson } from '../src/http.mjs';

const context = { env: { BSKY_HANDLE: 'test-handle', BSKY_APP_PASSWORD: 'test-password' } };
const session = (token) => ({ accessJwt: token, refreshJwt: `refresh-${token}` });
const results = { posts: [] };

function respondAfter(ms, payload, signal, status = 200) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(Response.json(payload, { status }));
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function connectProxy(upstream) {
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    if (String(url).startsWith('/api/search?')) {
      return GET(new Request(`https://example.test${url}`, options), context);
    }
    return upstream(new URL(url), options);
  }));
}

const search = (term, signal) => fetchJson(`/api/search?term=${term}`, {
  timeoutMs: SEARCH_REQUEST_TIMEOUT_MS,
  signal,
});

beforeEach(() => {
  testUtils.resetModuleStateForTests();
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  testUtils.resetModuleStateForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('browser and proxy search deadlines', () => {
  it('allows six seconds of login followed by six seconds of search', async () => {
    connectProxy((url, options) => respondAfter(6000,
      url.pathname.endsWith('createSession') ? session('access-a') : results,
      options.signal));
    const pending = search('slow-success');
    const checked = expect(pending).resolves.toEqual(results);
    await vi.advanceTimersByTimeAsync(12000);
    await checked;
    expect(testUtils.searchResultsCache.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds the complete login, rejected search, refresh and retry by one server deadline', async () => {
    const requests = [];
    connectProxy((url, options) => {
      requests.push({ url, signal: options.signal });
      if (url.pathname.endsWith('createSession')) return respondAfter(6000, session('access-a'), options.signal);
      if (url.pathname.endsWith('refreshSession')) return respondAfter(6000, session('access-b'), options.signal);
      return options.headers.Authorization === 'Bearer access-a'
        ? respondAfter(6000, { error: 'ExpiredToken' }, options.signal, 400)
        : respondAfter(6000, results, options.signal);
    });
    let error;
    const pending = search('too-slow').catch((failure) => { error = failure; });
    await vi.advanceTimersByTimeAsync(SEARCH_JOB_TIMEOUT_MS - 1);
    expect(error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(error).toMatchObject({ name: 'HttpError', status: 504, message: 'Upstream request timed out.' });
    expect(requests).toHaveLength(4);
    expect(requests.at(-1).signal.aborted).toBe(true);
    expect(testUtils.searchResultsCache.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the browser request immediately and lets its login finish for later searches', async () => {
    const upstreamCalls = [];
    connectProxy((url, options) => {
      upstreamCalls.push({ path: url.pathname, signal: options.signal });
      return respondAfter(6000, url.pathname.endsWith('createSession') ? session('access-a') : results, options.signal);
    });
    const controller = new AbortController();
    const pending = search('cancelled', controller.signal);
    const checked = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await checked;
    expect(upstreamCalls.map(({ path }) => path)).toEqual(['/xrpc/com.atproto.server.createSession']);
    expect(upstreamCalls[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(upstreamCalls).toHaveLength(1);
    expect(testUtils.searchResultsCache.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    const next = search('next');
    const nextChecked = expect(next).resolves.toEqual(results);
    await vi.advanceTimersByTimeAsync(6000);
    await nextChecked;
    expect(upstreamCalls.map(({ path }) => path)).toEqual([
      '/xrpc/com.atproto.server.createSession',
      '/xrpc/app.bsky.feed.searchPosts',
    ]);
  });
});
