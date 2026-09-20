import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, SEARCH_ADMISSION_LIMITS, testUtils } from '../api/search.mjs';

const context = { env: { BSKY_HANDLE: 'test-handle', BSKY_APP_PASSWORD: 'test-password' } };
const {
  resetModuleStateForTests,
  UPSTREAM_TIMEOUT_MS,
  SESSION_TTL_MS,
  AUTH_RETRY_DEFAULT_MS,
  AUTH_RETRY_MAX_MS,
  searchResultsCache,
} = testUtils;
const originalFetch = globalThis.fetch;
const limitedAt = Date.UTC(2026, 0, 1);
const session = (suffix = 'a') => ({ accessJwt: `access-${suffix}`, refreshJwt: `refresh-${suffix}` });
const post = {
  uri: 'at://did:plc:test/app.bsky.feed.post/one',
  author: { did: 'did:plc:test', handle: 'test.bsky.social' },
  record: { text: 'A post' },
};
const posts = { posts: [post], cursor: 'next-page' };

function request(term = 'topic', options = {}) {
  return new Request(`https://example.com/api/search?term=${encodeURIComponent(term)}`, options);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function upstream({ create, refresh, search } = {}) {
  const handlers = {
    create: vi.fn(create || (() => Response.json(session()))),
    refresh: vi.fn(refresh || (() => Response.json(session('b')))),
    search: vi.fn(search || (() => Response.json(posts))),
  };
  globalThis.fetch = vi.fn((url, options) => {
    if (url.includes('/com.atproto.server.createSession')) return handlers.create(options);
    if (url.includes('/com.atproto.server.refreshSession')) return handlers.refresh(options);
    if (url.includes('/app.bsky.feed.searchPosts')) return handlers.search(new URL(url), options);
    throw new Error(`Unexpected upstream endpoint: ${url}`);
  });
  return handlers;
}

beforeEach(() => resetModuleStateForTests());

afterEach(() => {
  resetModuleStateForTests();
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('upstream bodies and response validation', () => {
  it.each(['headers', 'JSON body'])('times out pending search %s without caching and clears its timer', async (phase) => {
    vi.useFakeTimers();
    let signal;
    upstream({
      search: (_url, options) => {
        signal = options.signal;
        if (phase === 'headers') {
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
          });
        }
        return { ok: true, status: 200, json: () => new Promise(() => {}) };
      },
    });
    const pending = GET(request(), context);
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS + 1);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(signal.aborted).toBe(true);
    expect(searchResultsCache.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out shared authentication bodies and permits a later login', async () => {
    vi.useFakeTimers();
    const handlers = upstream({
      create: () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }),
    });
    const pending = [GET(request('one'), context), GET(request('two'), context)];
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS + 1);
    expect((await Promise.all(pending)).map((response) => response.status)).toEqual([504, 504]);
    expect(handlers.create).toHaveBeenCalledTimes(1);
    expect(handlers.search).not.toHaveBeenCalled();
    handlers.create.mockImplementation(() => Response.json(session()));
    expect((await GET(request('one'), context)).status).toBe(200);
    expect(handlers.create).toHaveBeenCalledTimes(2);
  });

  it('times out refresh bodies without falling back to another login', async () => {
    vi.useFakeTimers();
    const handlers = upstream({
      refresh: () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }),
    });
    await GET(request('warm'), context);
    vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1);
    const pending = GET(request('expired'), context);
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS + 1);
    expect((await pending).status).toBe(504);
    expect(handlers.create).toHaveBeenCalledTimes(1);
    expect(handlers.refresh).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed successful refresh data without creating another login', async () => {
    vi.useFakeTimers();
    const handlers = upstream({ refresh: () => Response.json({}) });
    await GET(request('warm'), context);
    vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1);
    expect((await GET(request('expired'), context)).status).toBe(502);
    expect(handlers.create).toHaveBeenCalledTimes(1);
    expect(handlers.refresh).toHaveBeenCalledTimes(1);
  });

  it('returns 502 for invalid JSON and does not cache the failure', async () => {
    const handlers = upstream({ search: () => new Response('<html>Unavailable</html>') });
    const response = await GET(request(), context);
    expect(response.status).toBe(502);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(searchResultsCache.size).toBe(0);
    handlers.search.mockImplementation(() => Response.json(posts));
    expect((await GET(request(), context)).status).toBe(200);
    expect(handlers.search).toHaveBeenCalledTimes(2);
  });

  it.each([
    null,
    { posts: null },
    { posts: [null] },
    { posts: [{}] },
    { posts: [{ ...post, author: null }] },
    { posts: [{ ...post, author: { handle: 'test.bsky.social' } }] },
    { posts: [{ ...post, record: {} }] },
    { posts: [], cursor: 42 },
    { posts: Array.from({ length: 101 }, () => post) },
  ])('rejects invalid successful search data: %j', async (payload) => {
    upstream({ search: () => Response.json(payload) });
    const response = await GET(request(), context);
    expect(response.status).toBe(502);
    expect(searchResultsCache.size).toBe(0);
  });

  it('rejects malformed rendered data before caching and allows retry', async () => {
    const malformed = structuredClone(post);
    malformed.author.displayName = { toString: 1, valueOf: 1 };
    const handlers = upstream({ search: () => Response.json({ posts: [malformed] }) });
    expect((await GET(request(), context)).status).toBe(502);
    expect(searchResultsCache.size).toBe(0);
    handlers.search.mockImplementation(() => Response.json(posts));
    expect((await GET(request(), context)).status).toBe(200);
    expect(handlers.search).toHaveBeenCalledTimes(2);
  });

  it.each([
    null,
    { accessJwt: 'access' },
    { refreshJwt: 'refresh' },
    { accessJwt: 1, refreshJwt: 'refresh' },
  ])('rejects invalid successful session data: %j', async (payload) => {
    const handlers = upstream({ create: () => Response.json(payload) });
    expect((await GET(request(), context)).status).toBe(502);
    expect((await GET(request(), context)).status).toBe(502);
    expect(handlers.create).toHaveBeenCalledTimes(2);
    expect(handlers.search).not.toHaveBeenCalled();
  });

  it('preserves upstream error status and Retry-After even for an HTML body', async () => {
    const handlers = upstream({
      search: () => new Response('Rate limited', { status: 429, headers: { 'Retry-After': '30' } }),
    });
    const response = await GET(request(), context);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(handlers.refresh).not.toHaveBeenCalled();
    expect(searchResultsCache.size).toBe(0);
  });

  it('preserves an upstream server error and its message', async () => {
    upstream({ search: () => Response.json({ message: 'Upstream failure' }, { status: 500 }) });
    const response = await GET(request(), context);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Upstream failure' });
  });

  it('returns 502 for a network failure without caching it', async () => {
    upstream({ search: () => Promise.reject(new TypeError('fetch failed')) });
    expect((await GET(request(), context)).status).toBe(502);
    expect(searchResultsCache.size).toBe(0);
  });
});

describe('authentication lifecycle', () => {
  it('refreshes an expired cached session before creating another login', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const handlers = upstream();
    expect((await GET(request('first'), context)).status).toBe(200);
    expect((await GET(request('still-fresh'), context)).status).toBe(200);
    expect(handlers.refresh).not.toHaveBeenCalled();
    vi.setSystemTime(SESSION_TTL_MS + 1);
    expect((await GET(request('second'), context)).status).toBe(200);
    expect(handlers.create).toHaveBeenCalledTimes(1);
    expect(handlers.refresh).toHaveBeenCalledTimes(1);
    expect(handlers.refresh.mock.calls[0][0].headers.Authorization).toBe('Bearer refresh-a');
    expect(handlers.search.mock.calls.at(-1)[1].headers.Authorization).toBe('Bearer access-b');
  });

  it.each([400, 401])('creates a new session when refresh credentials are rejected with %i', async (status) => {
    vi.useFakeTimers();
    const handlers = upstream({
      refresh: () => Response.json({ error: 'ExpiredToken' }, { status }),
    });
    await GET(request('first'), context);
    vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1);
    expect((await GET(request('second'), context)).status).toBe(200);
    expect(handlers.create).toHaveBeenCalledTimes(2);
    expect(handlers.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503])('does not turn refresh status %i into another login', async (status) => {
    vi.useFakeTimers();
    const handlers = upstream({
      refresh: () => Response.json({ error: 'Unavailable' }, { status, headers: { 'Retry-After': '20' } }),
    });
    await GET(request('first'), context);
    vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1);
    const response = await GET(request('second'), context);
    expect(response.status).toBe(status === 429 ? 429 : 502);
    expect(response.headers.get('Retry-After')).toBe('20');
    expect(handlers.create).toHaveBeenCalledTimes(1);
    expect(handlers.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Retry-After seconds', { 'Retry-After': '30' }, 30],
    ['a Retry-After date', { 'Retry-After': new Date(limitedAt + 45_000).toUTCString() }, 45],
    ['a RateLimit-Reset timestamp', { 'RateLimit-Reset': String(limitedAt / 1000 + 90) }, 90],
    ['RateLimit-Reset seconds', { 'RateLimit-Reset': '15' }, 15],
    [
      'RateLimit-Reset behind a malformed Retry-After',
      { 'Retry-After': 'soon', 'RateLimit-Reset': String(limitedAt / 1000 + 7200) },
      7200,
    ],
    ['RateLimit-Reset behind a zero Retry-After', { 'Retry-After': '0', 'RateLimit-Reset': '120' }, 120],
    ['no reset header', {}, AUTH_RETRY_DEFAULT_MS / 1000],
    ['an oversized reset', { 'Retry-After': '999999' }, AUTH_RETRY_MAX_MS / 1000],
  ])('blocks new logins for %s after a rate-limited login', async (_label, headers, seconds) => {
    vi.useFakeTimers();
    vi.setSystemTime(limitedAt);
    const handlers = upstream({
      create: () => Response.json({ error: 'RateLimitExceeded' }, { status: 429, headers }),
    });
    const first = await GET(request('one'), context);
    expect(first.status).toBe(429);
    expect(first.headers.get('Retry-After')).toBe(String(seconds));
    vi.setSystemTime(limitedAt + seconds * 1000 - 1);
    const blocked = await GET(request('two'), context);
    expect(blocked.status).toBe(429);
    expect(handlers.create).toHaveBeenCalledTimes(1);
    expect(handlers.search).not.toHaveBeenCalled();
    handlers.create.mockImplementation(() => Response.json(session()));
    vi.setSystemTime(limitedAt + seconds * 1000);
    expect((await GET(request('three'), context)).status).toBe(200);
    expect(handlers.create).toHaveBeenCalledTimes(2);
  });

  it('fails fast after a rate-limited refresh and reports the remaining wait', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(limitedAt);
    const handlers = upstream({
      refresh: () =>
        Response.json({ error: 'RateLimitExceeded' }, { status: 429, headers: { 'Retry-After': '20' } }),
    });
    await GET(request('warm'), context);
    const expiredAt = limitedAt + SESSION_TTL_MS + 1;
    vi.setSystemTime(expiredAt);
    expect((await GET(request('first'), context)).status).toBe(429);
    vi.setSystemTime(expiredAt + 5000);
    const blocked = await GET(request('second'), context);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('15');
    expect(handlers.refresh).toHaveBeenCalledTimes(1);
    handlers.refresh.mockImplementation(() => Response.json(session('b')));
    vi.setSystemTime(expiredAt + 20_000);
    expect((await GET(request('third'), context)).status).toBe(200);
    expect(handlers.refresh).toHaveBeenCalledTimes(2);
    expect(handlers.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['create', 'stalls'],
    ['create', 'rejects'],
    ['refresh', 'stalls'],
    ['refresh', 'rejects'],
  ])('handles a %s 429 without consuming its body when cancellation %s', async (operation, cancellation) => {
    vi.useFakeTimers();
    vi.setSystemTime(limitedAt);
    const cancel = vi.fn(() => cancellation === 'stalls'
      ? new Promise(() => {})
      : Promise.reject(new Error('Body cancellation failed')));
    const limited = new Response(new ReadableStream({ cancel }), {
      status: 429,
      headers: { 'Retry-After': '20' },
    });
    const json = vi.spyOn(limited, 'json');
    const handlers = upstream({ [operation]: () => limited });
    if (operation === 'refresh') {
      await GET(request('warm'), context);
      vi.setSystemTime(limitedAt + SESSION_TTL_MS + 1);
    }
    const blockedAt = Date.now();
    let response;
    const pending = GET(request('limited'), context).then((result) => { response = result; });
    await vi.advanceTimersByTimeAsync(0);
    expect(response?.status).toBe(429);
    await pending;
    expect(response.headers.get('Retry-After')).toBe('20');
    expect(json).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    vi.setSystemTime(blockedAt + 5000);
    const blocked = await GET(request('blocked'), context);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('15');
    expect(handlers[operation]).toHaveBeenCalledTimes(1);
    expect(handlers.search).toHaveBeenCalledTimes(operation === 'refresh' ? 1 : 0);

    handlers[operation].mockImplementation(() => Response.json(session('b')));
    vi.setSystemTime(blockedAt + 20_000);
    expect((await GET(request('recovered'), context)).status).toBe(200);
    expect(handlers[operation]).toHaveBeenCalledTimes(2);
    expect(handlers.create).toHaveBeenCalledTimes(operation === 'refresh' ? 1 : 2);
    expect(handlers.search.mock.calls.at(-1)[1].headers.Authorization).toBe('Bearer access-b');
  });

  it.each(['create', 'refresh'])('retains %s backoff when its caller cancels after 429 headers arrive', async (operation) => {
    vi.useFakeTimers();
    vi.setSystemTime(limitedAt);
    const controller = new AbortController();
    const cancel = vi.fn(() => {
      controller.abort();
      return Promise.reject(new Error('Body cancellation failed'));
    });
    const limited = new Response(new ReadableStream({ cancel }), {
      status: 429,
      headers: { 'Retry-After': '20' },
    });
    const handlers = upstream({ [operation]: () => limited });
    if (operation === 'refresh') {
      await GET(request('warm'), context);
      vi.setSystemTime(limitedAt + SESSION_TTL_MS + 1);
    }
    let response;
    const pending = GET(request('limited', { signal: controller.signal }), context)
      .then((result) => { response = result; });
    await vi.advanceTimersByTimeAsync(0);
    expect(response?.status).toBe(499);
    await pending;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const blocked = await GET(request('blocked'), context);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('20');
    expect(handlers[operation]).toHaveBeenCalledTimes(1);
    expect(handlers.search).toHaveBeenCalledTimes(operation === 'refresh' ? 1 : 0);
  });

  it.each([400, 401])('stops reusing a token rejected with %i during refresh backoff while serving cached results', async (status) => {
    vi.useFakeTimers();
    vi.setSystemTime(limitedAt);
    const handlers = upstream({
      refresh: () => Response.json({ error: 'RateLimitExceeded' }, {
        status: 429,
        headers: { 'Retry-After': '20' },
      }),
      search: (url, options) =>
        url.searchParams.get('q') !== 'warm' && options.headers.Authorization === 'Bearer access-a'
          ? Response.json({ error: 'ExpiredToken' }, { status })
          : Response.json(posts),
    });
    expect((await GET(request('warm'), context)).status).toBe(200);
    expect((await GET(request('rejected'), context)).status).toBe(429);
    expect(handlers.search).toHaveBeenCalledTimes(2);

    vi.setSystemTime(limitedAt + 5000);
    const [cached, ...blocked] = await Promise.all([
      GET(request('warm'), context),
      GET(request('blocked-one'), context),
      GET(request('blocked-two'), context),
    ]);
    expect(cached.status).toBe(200);
    await expect(cached.json()).resolves.toEqual(posts);
    expect(blocked.map((response) => response.status)).toEqual([429, 429]);
    expect(blocked.map((response) => response.headers.get('Retry-After'))).toEqual(['15', '15']);
    expect(handlers.search).toHaveBeenCalledTimes(2);
    expect(handlers.refresh).toHaveBeenCalledTimes(1);
    expect(handlers.create).toHaveBeenCalledTimes(1);

    handlers.refresh.mockImplementation(() => Response.json(session('b')));
    vi.setSystemTime(limitedAt + 20_000);
    expect((await GET(request('recovered'), context)).status).toBe(200);
    expect(handlers.search).toHaveBeenCalledTimes(3);
    expect(handlers.refresh).toHaveBeenCalledTimes(2);
    expect(handlers.create).toHaveBeenCalledTimes(1);
    expect(handlers.refresh.mock.calls.at(-1)[0].headers.Authorization).toBe('Bearer refresh-a');
    expect(handlers.search.mock.calls.at(-1)[1].headers.Authorization).toBe('Bearer access-b');
  });

  it.each([400, 401])('shares an in-progress refresh after %i among distinct searches', async (status) => {
    const refresh = deferred();
    const handlers = upstream({
      refresh: () => refresh.promise,
      search: (url, options) =>
        url.searchParams.get('q') !== 'warm' && options.headers.Authorization === 'Bearer access-a'
          ? Response.json({ error: 'ExpiredToken' }, { status })
          : Response.json(posts),
    });
    await GET(request('warm'), context);
    const pending = [GET(request('one'), context), GET(request('two'), context)];
    await vi.waitFor(() => expect(handlers.refresh).toHaveBeenCalledTimes(1));
    refresh.resolve(Response.json(session('b')));
    expect((await Promise.all(pending)).map((response) => response.status)).toEqual([200, 200]);
    expect(handlers.create).toHaveBeenCalledTimes(1);
    expect(handlers.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401])('reuses the new session for a delayed %i from an older token', async (status) => {
    const late = deferred();
    const handlers = upstream({
      search: (url, options) => {
        const term = url.searchParams.get('q');
        if (term === 'warm' || options.headers.Authorization === 'Bearer access-b') {
          return Response.json(posts);
        }
        if (term === 'late') return late.promise;
        return Response.json({ error: 'ExpiredToken' }, { status });
      },
    });
    await GET(request('warm'), context);
    const early = GET(request('early'), context);
    const later = GET(request('late'), context);
    expect((await early).status).toBe(200);
    late.resolve(Response.json({ error: 'ExpiredToken' }, { status }));
    expect((await later).status).toBe(200);
    expect(handlers.refresh).toHaveBeenCalledTimes(1);
    expect(handlers.create).toHaveBeenCalledTimes(1);
  });

  it.each([[400, 'ExpiredToken'], [401, 'Unauthorized']])('retries a search rejected with %i %s only once', async (status, error) => {
    const handlers = upstream({ search: () => Response.json({ error }, { status }) });
    expect((await GET(request(), context)).status).toBe(status);
    expect(handlers.search).toHaveBeenCalledTimes(2);
    expect(handlers.refresh).toHaveBeenCalledTimes(1);
    expect(handlers.create).toHaveBeenCalledTimes(1);
  });

  it('does not refresh a session for an ordinary bad search request', async () => {
    const handlers = upstream({ search: () => Response.json({ error: 'InvalidRequest', message: 'Invalid cursor' }, { status: 400 }) });
    const response = await GET(request(), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid cursor' });
    expect(handlers.refresh).not.toHaveBeenCalled();
    expect(handlers.search).toHaveBeenCalledTimes(1);
  });
});

describe('coalescing and cancellation', () => {
  it('coalesces simultaneous identical searches and caches their validated result', async () => {
    const body = deferred();
    const handlers = upstream({ search: () => body.promise });
    const pending = Array.from({ length: 25 }, () => GET(request(), context));
    await vi.waitFor(() => expect(handlers.search).toHaveBeenCalledTimes(1));
    body.resolve(Response.json(posts));
    const responses = await Promise.all(pending);
    expect(responses.map((response) => response.status)).toEqual(Array(25).fill(200));
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual(Array(25).fill(posts));
    expect((await GET(request(), context)).status).toBe(200);
    expect((await GET(new Request(`${request().url}&cursor=&sort=top`), context)).status).toBe(200);
    expect(handlers.create).toHaveBeenCalledTimes(1);
    expect(handlers.search).toHaveBeenCalledTimes(1);
  });

  it('removes failed shared work so a later request can retry', async () => {
    const handlers = upstream({ search: () => Response.json({ error: 'Unavailable' }, { status: 503 }) });
    const responses = await Promise.all([GET(request(), context), GET(request(), context)]);
    expect(responses.map((response) => response.status)).toEqual([503, 503]);
    expect(handlers.search).toHaveBeenCalledTimes(1);
    handlers.search.mockImplementation(() => Response.json(posts));
    expect((await GET(request(), context)).status).toBe(200);
    expect(handlers.search).toHaveBeenCalledTimes(2);
  });

  it('does not start work for an already-cancelled request', async () => {
    const handlers = upstream();
    const controller = new AbortController();
    controller.abort();
    const response = await GET(request('topic', { signal: controller.signal }), context);
    expect(response.status).toBe(499);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(handlers.create).not.toHaveBeenCalled();
    expect(handlers.search).not.toHaveBeenCalled();
  });

  it('detaches one cancelled subscriber while keeping its shared search alive', async () => {
    const body = deferred();
    const handlers = upstream({ search: () => body.promise });
    const controller = new AbortController();
    const cancelled = GET(request('topic', { signal: controller.signal }), context);
    const active = GET(request(), context);
    await vi.waitFor(() => expect(handlers.search).toHaveBeenCalledTimes(1));
    const signal = handlers.search.mock.calls[0][1].signal;
    controller.abort();
    expect((await cancelled).status).toBe(499);
    expect(signal.aborted).toBe(false);
    body.resolve(Response.json(posts));
    expect((await active).status).toBe(200);
    expect(searchResultsCache.size).toBe(1);
  });

  it('aborts a search after all subscribers cancel and allows replacement work', async () => {
    const handlers = upstream({ search: () => new Promise(() => {}) });
    const controllers = [new AbortController(), new AbortController()];
    const pending = controllers.map((controller) => GET(request('topic', { signal: controller.signal }), context));
    await vi.waitFor(() => expect(handlers.search).toHaveBeenCalledTimes(1));
    const signal = handlers.search.mock.calls[0][1].signal;
    controllers.forEach((controller) => controller.abort());
    expect((await Promise.all(pending)).map((response) => response.status)).toEqual([499, 499]);
    expect(signal.aborted).toBe(true);
    expect(searchResultsCache.size).toBe(0);
    handlers.search.mockImplementation(() => Response.json(posts));
    expect((await GET(request(), context)).status).toBe(200);
    expect(handlers.search).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending search body and never caches its later completion', async () => {
    const body = deferred();
    const handlers = upstream({
      search: () => ({ ok: true, status: 200, json: () => body.promise }),
    });
    const controller = new AbortController();
    const pending = GET(request('topic', { signal: controller.signal }), context);
    await vi.waitFor(() => expect(handlers.search).toHaveBeenCalledTimes(1));
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(handlers.search.mock.calls[0][1].signal.aborted).toBe(true);
    body.resolve(posts);
    await Promise.resolve();
    await Promise.resolve();
    expect(searchResultsCache.size).toBe(0);
  });

  it('keeps shared authentication alive for a different active search', async () => {
    const auth = deferred();
    const handlers = upstream({ create: () => ({ ok: true, status: 200, json: () => auth.promise }) });
    const controller = new AbortController();
    const cancelled = GET(request('cancelled', { signal: controller.signal }), context);
    const active = GET(request('active'), context);
    await vi.waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    controller.abort();
    expect((await cancelled).status).toBe(499);
    expect(handlers.create.mock.calls[0][0].signal.aborted).toBe(false);
    auth.resolve(session());
    expect((await active).status).toBe(200);
    expect(handlers.search).toHaveBeenCalledTimes(1);
    expect(handlers.search.mock.calls[0][0].searchParams.get('q')).toBe('active');
  });

  it('aborts abandoned authentication and can immediately start a fresh login', async () => {
    const handlers = upstream({ create: () => new Promise(() => {}) });
    const controller = new AbortController();
    const cancelled = GET(request('cancelled', { signal: controller.signal }), context);
    await vi.waitFor(() => expect(handlers.create).toHaveBeenCalledTimes(1));
    controller.abort();
    expect((await cancelled).status).toBe(499);
    expect(handlers.create.mock.calls[0][0].signal.aborted).toBe(true);
    handlers.create.mockImplementation(() => Response.json(session()));
    expect((await GET(request('replacement'), context)).status).toBe(200);
    expect(handlers.create).toHaveBeenCalledTimes(2);
  });
});

describe('bounded search admission', () => {
  it('bounds distinct pending jobs while letting callers join existing work', async () => {
    const body = deferred();
    const handlers = upstream({ search: () => body.promise.then(() => Response.json(posts)) });
    const pending = Array.from({ length: SEARCH_ADMISSION_LIMITS.maxConcurrent }, (_, index) =>
      GET(request(`topic-${index}`), context),
    );
    const joined = GET(request('topic-0'), context);
    const rejected = await GET(request('overflow'), context);
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('Retry-After')).toBe('1');
    expect(rejected.headers.get('Cache-Control')).toBe('no-store');
    await vi.waitFor(() => expect(handlers.search).toHaveBeenCalledTimes(SEARCH_ADMISSION_LIMITS.maxConcurrent));
    body.resolve();
    expect((await Promise.all([...pending, joined])).every((response) => response.status === 200)).toBe(true);
    expect((await GET(request('overflow'), context)).status).toBe(200);
  });

  it('limits new work across changing IP headers, preserves cache hits, and refills', async () => {
    vi.useFakeTimers();
    const handlers = upstream();
    for (let index = 0; index < SEARCH_ADMISSION_LIMITS.burst; index += 1) {
      const response = await GET(request(`topic-${index}`, { headers: { 'X-Forwarded-For': `192.0.2.${index}` } }), context);
      expect(response.status).toBe(200);
    }
    const denied = await GET(request('overflow', { headers: { 'X-Forwarded-For': '198.51.100.1' } }), context);
    expect(denied.status).toBe(429);
    expect(denied.headers.get('Retry-After')).toBe('1');
    expect((await GET(request('topic-0'), context)).status).toBe(200);
    expect(handlers.search).toHaveBeenCalledTimes(SEARCH_ADMISSION_LIMITS.burst);
    vi.setSystemTime(Date.now() + 1000 / SEARCH_ADMISSION_LIMITS.refillPerSecond);
    expect((await GET(request('overflow'), context)).status).toBe(200);
    expect(handlers.search).toHaveBeenCalledTimes(SEARCH_ADMISSION_LIMITS.burst + 1);
  });
});

describe('handler input boundaries', () => {
  it('returns 400 for a missing term without contacting upstream', async () => {
    upstream();
    const response = await GET(new Request('https://example.com/api/search'), context);
    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 405 with the allowed method without contacting upstream', async () => {
    upstream();
    const response = await GET(request('topic', { method: 'POST' }), context);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['term', 'a'.repeat(501)],
    ['cursor', 'a'.repeat(1001)],
    ['sort', 'popular'],
    ['since', '2026-02-30'],
  ])('rejects an invalid %s without contacting upstream', async (key, value) => {
    upstream();
    const url = new URL('https://example.com/api/search?term=topic');
    url.searchParams.set(key, value);
    const response = await GET(new Request(url), context);
    expect(response.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('strips C0 and C1 control characters before forwarding the term', async () => {
    const handlers = upstream();
    const response = await GET(request('  he\u0000l\u001Flo\u007F\u0085  '), context);
    expect(response.status).toBe(200);
    expect(handlers.search.mock.calls[0][0].searchParams.get('q')).toBe('hello');
  });

  it('forwards the since datetime and its timezone offset unchanged', async () => {
    const since = '2026-08-31T18:00:00+02:00';
    const handlers = upstream();
    const url = new URL(request().url);
    url.searchParams.set('since', since);
    expect((await GET(new Request(url), context)).status).toBe(200);
    expect(handlers.search).toHaveBeenCalledTimes(1);
    const params = handlers.search.mock.calls[0][0].searchParams;
    expect(params.get('since')).toBe(since);
    expect(params.get('q')).toBe('topic');
  });

  it('accepts exact length boundaries, normalizes sort, and keeps English-only search', async () => {
    const handlers = upstream();
    const url = new URL('https://example.com/api/search');
    url.searchParams.set('term', 'a'.repeat(500));
    url.searchParams.set('cursor', 'b'.repeat(1000));
    url.searchParams.set('sort', ' LATEST ');
    url.searchParams.set('lang', 'fr');
    expect((await GET(new Request(url), context)).status).toBe(200);
    const params = handlers.search.mock.calls[0][0].searchParams;
    expect(params.get('q')).toBe('a'.repeat(500));
    expect(params.get('cursor')).toBe('b'.repeat(1000));
    expect(params.get('sort')).toBe('latest');
    expect(params.get('lang')).toBe('en');
    expect(params.get('limit')).toBe('100');
    expect(params.has('since')).toBe(false);
  });

  it('names the AppView on the proxied search request', async () => {
    const handlers = upstream();
    await GET(request(), context);
    expect(handlers.search.mock.calls[0][1].headers['atproto-proxy']).toBe('did:web:api.bsky.app#bsky_appview');
  });

  it('uses process credentials when no runtime context is supplied', async () => {
    vi.stubEnv('BSKY_HANDLE', 'process-handle');
    vi.stubEnv('BSKY_APP_PASSWORD', 'process-password');
    const handlers = upstream();
    expect((await GET(request())).status).toBe(200);
    expect(JSON.parse(handlers.create.mock.calls[0][0].body)).toEqual({
      identifier: 'process-handle',
      password: 'process-password',
    });
  });

  it('rejects missing runtime credentials without using process credentials or upstream', async () => {
    vi.stubEnv('BSKY_HANDLE', 'process-handle');
    vi.stubEnv('BSKY_APP_PASSWORD', 'process-password');
    upstream();
    const response = await GET(request(), { env: {} });
    expect(response.status).toBe(500);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('search cache isolation', () => {
  it.each([
    ['term', 'one', 'two'],
    ['cursor', 'cursor-1', 'cursor-2'],
    ['sort', 'top', 'latest'],
    ['since', '2026-08-31T18:00:00Z', '2026-08-30T18:00:00Z'],
  ])('caches %s variants separately (%s / %s)', async (key, firstValue, secondValue) => {
    const handlers = upstream();
    const first = new URL(request().url);
    first.searchParams.set(key, firstValue);
    const second = new URL(first);
    second.searchParams.set(key, secondValue);

    for (const url of [first, second, first, second]) {
      expect((await GET(new Request(url), context)).status).toBe(200);
    }
    expect(handlers.search).toHaveBeenCalledTimes(2);
    expect(handlers.search.mock.calls.map(([url]) => url.searchParams.get(key === 'term' ? 'q' : key)))
      .toEqual([firstValue, secondValue]);
  });
});
