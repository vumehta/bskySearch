/**
 * Backend utility tests for bskySearch API
 *
 * Tests pure utility functions from the search API module.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Import test utilities from the search module
process.env.BSKY_HANDLE = process.env.BSKY_HANDLE || 'test-handle';
process.env.BSKY_APP_PASSWORD = process.env.BSKY_APP_PASSWORD || 'test-app-password';

const searchModule = await import('../api/search.mjs');
const searchHandler = searchModule.GET;
const { testUtils } = searchModule;
const {
  stripControlChars,
  getSearchCacheKey,
  isValidSince,
  isSessionExpired,
  getCachedSearchResult,
  cleanupSearchCache,
  enforceSearchCacheLimit,
  searchResultsCache,
  SEARCH_CACHE_TTL_MS,
  MAX_SEARCH_CACHE_SIZE,
  UPSTREAM_TIMEOUT_MS,
  UPSTREAM_TIMEOUT_ERROR_CODE,
  fetchWithTimeout,
  isUpstreamTimeoutError,
  resetModuleStateForTests,
} = testUtils;

const originalFetch = global.fetch;

beforeEach(() => {
  resetModuleStateForTests();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ============================================================================
// UPSTREAM_TIMEOUT_MS
// ============================================================================
describe('UPSTREAM_TIMEOUT_MS', () => {
  it('is a positive, bounded timeout value', () => {
    expect(UPSTREAM_TIMEOUT_MS).toBeGreaterThan(0);
    expect(UPSTREAM_TIMEOUT_MS).toBeLessThanOrEqual(10000);
  });

  it('is 8000ms', () => {
    expect(UPSTREAM_TIMEOUT_MS).toBe(8000);
  });
});

// ============================================================================
// fetchWithTimeout
// ============================================================================
describe('fetchWithTimeout', () => {
  it('throws a tagged timeout error when request times out', async () => {
    vi.useFakeTimers();

    global.fetch = vi.fn((_url, options) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            const abortError = new Error('Aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          },
          { once: true },
        );
      });
    });

    const requestPromise = fetchWithTimeout('https://example.com/resource', {}, 10);
    const capturedErrorPromise = requestPromise.catch((requestError) => requestError);
    await vi.advanceTimersByTimeAsync(11);

    const error = await capturedErrorPromise;
    expect(isUpstreamTimeoutError(error)).toBe(true);
    expect(error.code).toBe(UPSTREAM_TIMEOUT_ERROR_CODE);
    expect(error.message).toBe('Upstream request timed out.');
  });

  it('preserves caller abort signals as non-timeout aborts', async () => {
    global.fetch = vi.fn((_url, options) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            const abortError = new Error('Aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          },
          { once: true },
        );
      });
    });

    const callerController = new AbortController();
    const requestPromise = fetchWithTimeout(
      'https://example.com/resource',
      { signal: callerController.signal },
      10_000,
    );
    callerController.abort();

    const error = await requestPromise.catch((requestError) => requestError);
    expect(error.name).toBe('AbortError');
    expect(isUpstreamTimeoutError(error)).toBe(false);
  });
});

// ============================================================================
// handler timeout mapping
// ============================================================================
describe('search handler timeout mapping', () => {
  it('returns 504 when upstream search times out', async () => {
    vi.useFakeTimers();

    global.fetch = vi.fn((url, options = {}) => {
      if (url.includes('/com.atproto.server.createSession')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            accessJwt: 'access-token',
            refreshJwt: 'refresh-token',
          }),
        });
      }

      if (url.includes('/app.bsky.feed.searchPosts')) {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              const abortError = new Error('Aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            },
            { once: true },
          );
        });
      }

      throw new Error(`Unexpected fetch URL in test: ${url}`);
    });

    const request = new Request('https://example.com/api/search?term=timeout-test', {
      method: 'GET',
    });
    const handlerPromise = searchHandler(request);
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS + 1);
    const response = await handlerPromise;

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toEqual({ error: 'Upstream request timed out.' });
  });
});

describe('search handler request/response behavior', () => {
  it('returns 400 for missing term and keeps no-store cache policy', async () => {
    const response = await searchHandler(new Request('https://example.com/api/search', { method: 'GET' }));
    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ error: 'Missing term parameter.' });
  });

  it('returns 405 with Allow header for non-GET methods', async () => {
    const response = await searchHandler(
      new Request('https://example.com/api/search?term=test', { method: 'POST' }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET');
    await expect(response.json()).resolves.toEqual({ error: 'Method not allowed.' });
  });
});

// ============================================================================
// stripControlChars
// ============================================================================
describe('stripControlChars', () => {
  it('removes C0/C1 control characters', () => {
    expect(stripControlChars('he\u0000l\u001Flo\u007F')).toBe('hello');
  });

  it('returns empty string for non-string input', () => {
    expect(stripControlChars(null)).toBe('');
    expect(stripControlChars(undefined)).toBe('');
  });
});

// ============================================================================
// getSearchCacheKey
// ============================================================================
describe('getSearchCacheKey', () => {
  it('generates deterministic key for same inputs', () => {
    const key1 = getSearchCacheKey('term', 'cursor', 'top');
    const key2 = getSearchCacheKey('term', 'cursor', 'top');
    expect(key1).toBe(key2);
  });

  it('generates different keys for different terms', () => {
    const key1 = getSearchCacheKey('term1', null, 'top');
    const key2 = getSearchCacheKey('term2', null, 'top');
    expect(key1).not.toBe(key2);
  });

  it('generates different keys for different cursors', () => {
    const key1 = getSearchCacheKey('term', 'cursor1', 'top');
    const key2 = getSearchCacheKey('term', 'cursor2', 'top');
    expect(key1).not.toBe(key2);
  });

  it('generates different keys for different sort modes', () => {
    const key1 = getSearchCacheKey('term', null, 'top');
    const key2 = getSearchCacheKey('term', null, 'latest');
    expect(key1).not.toBe(key2);
  });

  it('treats null cursor as empty string', () => {
    const key1 = getSearchCacheKey('term', null, 'top');
    const key2 = getSearchCacheKey('term', '', 'top');
    expect(key1).toBe(key2);
  });

  it('returns valid JSON string', () => {
    const key = getSearchCacheKey('term', 'cursor', 'top');
    expect(() => JSON.parse(key)).not.toThrow();
  });

  it('generates different keys for different since windows', () => {
    const key1 = getSearchCacheKey('term', null, 'top', '2026-08-31T00:00:00Z');
    const key2 = getSearchCacheKey('term', null, 'top', '2026-08-30T00:00:00Z');
    const key3 = getSearchCacheKey('term', null, 'top');
    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
  });
});

// ============================================================================
// since parameter
// ============================================================================
describe('isValidSince', () => {
  it('accepts valid ISO dates and AT Protocol datetimes', () => {
    expect(isValidSince('2026-08-31')).toBe(true);
    expect(isValidSince('2024-02-29')).toBe(true);
    expect(isValidSince('2000-02-29')).toBe(true);
    expect(isValidSince('2026-08-31T18:00:00Z')).toBe(true);
    expect(isValidSince('2024-02-29T18:00:00Z')).toBe(true);
    expect(isValidSince('2026-08-31T18:00:00.123Z')).toBe(true);
    expect(isValidSince('2026-08-31T18:00:00.123456Z')).toBe(true);
    expect(isValidSince('2026-08-31T18:00:00+02:00')).toBe(true);
  });

  it('rejects free-form and malformed values', () => {
    expect(isValidSince('yesterday')).toBe(false);
    expect(isValidSince('2026-13-45')).toBe(false);
    expect(isValidSince('2026-08-31T18:00:00Z; DROP')).toBe(false);
  });

  it('rejects impossible calendar dates instead of normalizing them', () => {
    expect(isValidSince('2026-02-29')).toBe(false);
    expect(isValidSince('2026-02-30')).toBe(false);
    expect(isValidSince('2026-04-31')).toBe(false);
    expect(isValidSince('1900-02-29')).toBe(false);
    expect(isValidSince('2026-00-10')).toBe(false);
    expect(isValidSince('2026-01-00')).toBe(false);
    expect(isValidSince('2026-02-30T00:00:00Z')).toBe(false);
    expect(isValidSince('2026-04-31T12:00:00+02:00')).toBe(false);
  });

  it('rejects invalid AT Protocol timezone forms', () => {
    expect(isValidSince('2026-08-31T18:00:00-00:00')).toBe(false);
    expect(isValidSince('2026-08-31T18:00:00+24:00')).toBe(false);
    expect(isValidSince('2026-08-31T18:00:00+0200')).toBe(false);
    expect(isValidSince('2026-08-31T24:00:00Z')).toBe(false);
    expect(isValidSince('2026-08-31T18:60:00Z')).toBe(false);
    expect(isValidSince('2026-08-31T18:00:00')).toBe(false);
  });
});

describe('search handler since forwarding', () => {
  function mockUpstream() {
    const searchUrls = [];
    global.fetch = vi.fn((url) => {
      if (url.includes('/com.atproto.server.createSession')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ accessJwt: 'access-token', refreshJwt: 'refresh-token' }),
        });
      }
      if (url.includes('/app.bsky.feed.searchPosts')) {
        searchUrls.push(new URL(url));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ posts: [] }) });
      }
      throw new Error(`Unexpected fetch URL in test: ${url}`);
    });
    return searchUrls;
  }

  it('returns 400 for a malformed since value without calling upstream', async () => {
    const searchUrls = mockUpstream();
    const response = await searchHandler(
      new Request('https://example.com/api/search?term=trump&since=yesterday', { method: 'GET' }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid since parameter.' });
    expect(searchUrls).toHaveLength(0);
  });

  it('returns 400 for an impossible calendar date without calling upstream', async () => {
    const searchUrls = mockUpstream();
    const response = await searchHandler(
      new Request('https://example.com/api/search?term=trump&since=2026-02-30T00:00:00Z', {
        method: 'GET',
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid since parameter.' });
    expect(searchUrls).toHaveLength(0);
  });

  it('forwards a valid offset datetime to Bluesky', async () => {
    const searchUrls = mockUpstream();
    const response = await searchHandler(
      new Request('https://example.com/api/search?term=trump&since=2026-08-31T18:00:00%2B02:00', {
        method: 'GET',
      }),
    );
    expect(response.status).toBe(200);
    expect(searchUrls).toHaveLength(1);
    expect(searchUrls[0].searchParams.get('since')).toBe('2026-08-31T18:00:00+02:00');
  });

  it('forwards a valid since value to Bluesky', async () => {
    const searchUrls = mockUpstream();
    const response = await searchHandler(
      new Request('https://example.com/api/search?term=trump&since=2026-08-31T18:00:00Z', {
        method: 'GET',
      }),
    );
    expect(response.status).toBe(200);
    expect(searchUrls).toHaveLength(1);
    expect(searchUrls[0].searchParams.get('since')).toBe('2026-08-31T18:00:00Z');
    expect(searchUrls[0].searchParams.get('q')).toBe('trump');
  });

  it('omits since from the upstream request when not provided', async () => {
    const searchUrls = mockUpstream();
    await searchHandler(new Request('https://example.com/api/search?term=trump', { method: 'GET' }));
    expect(searchUrls).toHaveLength(1);
    expect(searchUrls[0].searchParams.has('since')).toBe(false);
  });

  it('caches results per since window', async () => {
    const searchUrls = mockUpstream();
    const base = 'https://example.com/api/search?term=trump';
    await searchHandler(new Request(`${base}&since=2026-08-31T18:00:00Z`, { method: 'GET' }));
    await searchHandler(new Request(`${base}&since=2026-08-31T18:00:00Z`, { method: 'GET' }));
    await searchHandler(new Request(`${base}&since=2026-08-30T18:00:00Z`, { method: 'GET' }));
    expect(searchUrls.map((url) => url.searchParams.get('since'))).toEqual([
      '2026-08-31T18:00:00Z',
      '2026-08-30T18:00:00Z',
    ]);
  });
});

// ============================================================================
// isSessionExpired
// ============================================================================
describe('isSessionExpired', () => {
  it('returns true when no session exists', () => {
    // The module starts with no session
    expect(isSessionExpired()).toBe(true);
  });
});

// ============================================================================
// searchResultsCache helpers
// ============================================================================
describe('searchResultsCache helpers', () => {
  it('evicts oldest entries when cache exceeds max size', () => {
    for (let i = 0; i < MAX_SEARCH_CACHE_SIZE + 2; i += 1) {
      searchResultsCache.set(`key-${i}`, { data: { id: i }, timestamp: 0 });
    }

    enforceSearchCacheLimit();

    expect(searchResultsCache.size).toBe(MAX_SEARCH_CACHE_SIZE);
    expect(searchResultsCache.has('key-0')).toBe(false);
    expect(searchResultsCache.has('key-1')).toBe(false);
    expect(searchResultsCache.has(`key-${MAX_SEARCH_CACHE_SIZE + 1}`)).toBe(true);
  });

  it('removes expired entries during cleanup', () => {
    const now = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    searchResultsCache.set('fresh', {
      data: { ok: true },
      timestamp: now - SEARCH_CACHE_TTL_MS + 1000,
    });
    searchResultsCache.set('stale', {
      data: { ok: false },
      timestamp: now - SEARCH_CACHE_TTL_MS - 1,
    });

    cleanupSearchCache();

    expect(searchResultsCache.has('fresh')).toBe(true);
    expect(searchResultsCache.has('stale')).toBe(false);
  });

  it('drops stale entries when reading cached results', () => {
    const now = 2_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    searchResultsCache.set('stale', {
      data: { ok: false },
      timestamp: now - SEARCH_CACHE_TTL_MS - 1,
    });

    expect(getCachedSearchResult('stale')).toBeNull();
    expect(searchResultsCache.has('stale')).toBe(false);
  });

  it('returns fresh entries and refreshes LRU order on read', () => {
    const now = 3_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    searchResultsCache.set('first', {
      data: { ok: 1 },
      timestamp: now,
    });
    searchResultsCache.set('second', {
      data: { ok: 2 },
      timestamp: now,
    });
    searchResultsCache.set('third', {
      data: { ok: 3 },
      timestamp: now,
    });

    expect(getCachedSearchResult('first')).toEqual({ ok: 1 });
    expect([...searchResultsCache.keys()]).toEqual(['second', 'third', 'first']);
  });
});
