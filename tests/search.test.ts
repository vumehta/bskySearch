/**
 * Backend utility tests for bskySearch API
 *
 * Tests pure utility functions from the search API module.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Import test utilities from the search module
process.env.BSKY_HANDLE = process.env.BSKY_HANDLE || 'test-handle';
process.env.BSKY_APP_PASSWORD = process.env.BSKY_APP_PASSWORD || 'test-app-password';

const searchModule = await import('../api/search');
const searchHandler = searchModule.GET;
const { testUtils } = searchModule;
const {
  getQueryString,
  stripControlChars,
  getSearchCacheKey,
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
} = testUtils!;

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

    global.fetch = vi.fn((_url: string | URL | Request, options?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener(
          'abort',
          () => {
            const abortError = new Error('Aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          },
          { once: true },
        );
      });
    }) as typeof global.fetch;

    const requestPromise = fetchWithTimeout('https://example.com/resource', {}, 10);
    const capturedErrorPromise = requestPromise.catch((requestError: Error) => requestError);
    await vi.advanceTimersByTimeAsync(11);

    const error = await capturedErrorPromise as Error;
    expect(isUpstreamTimeoutError(error)).toBe(true);
    expect((error as Error & { code: string }).code).toBe(UPSTREAM_TIMEOUT_ERROR_CODE);
    expect(error.message).toBe('Upstream request timed out.');
  });

  it('preserves caller abort signals as non-timeout aborts', async () => {
    global.fetch = vi.fn((_url: string | URL | Request, options?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener(
          'abort',
          () => {
            const abortError = new Error('Aborted');
            abortError.name = 'AbortError';
            reject(abortError);
          },
          { once: true },
        );
      });
    }) as typeof global.fetch;

    const callerController = new AbortController();
    const requestPromise = fetchWithTimeout(
      'https://example.com/resource',
      { signal: callerController.signal },
      10_000,
    );
    callerController.abort();

    const error = await requestPromise.catch((requestError: Error) => requestError) as Error;
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

    global.fetch = vi.fn((url: string | URL | Request, options: RequestInit = {}) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('/com.atproto.server.createSession')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            accessJwt: 'access-token',
            refreshJwt: 'refresh-token',
          }),
        } as Response);
      }

      if (urlStr.includes('/app.bsky.feed.searchPosts')) {
        return new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener(
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

      throw new Error(`Unexpected fetch URL in test: ${urlStr}`);
    }) as typeof global.fetch;

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
// getQueryString
// ============================================================================
describe('getQueryString', () => {
  it('returns string value as-is', () => {
    expect(getQueryString('hello')).toBe('hello');
  });

  it('returns first element of array', () => {
    expect(getQueryString(['first', 'second'])).toBe('first');
  });

  it('returns undefined for empty array', () => {
    expect(getQueryString([])).toBe(undefined);
  });

  it('returns empty string for non-string, non-array values', () => {
    expect(getQueryString(123)).toBe('');
    expect(getQueryString(null)).toBe('');
    expect(getQueryString(undefined)).toBe('');
    expect(getQueryString({})).toBe('');
  });

  it('handles array with single element', () => {
    expect(getQueryString(['only'])).toBe('only');
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
    const key1 = getSearchCacheKey('term1', null as unknown as string, 'top');
    const key2 = getSearchCacheKey('term2', null as unknown as string, 'top');
    expect(key1).not.toBe(key2);
  });

  it('generates different keys for different cursors', () => {
    const key1 = getSearchCacheKey('term', 'cursor1', 'top');
    const key2 = getSearchCacheKey('term', 'cursor2', 'top');
    expect(key1).not.toBe(key2);
  });

  it('generates different keys for different sort modes', () => {
    const key1 = getSearchCacheKey('term', null as unknown as string, 'top');
    const key2 = getSearchCacheKey('term', null as unknown as string, 'latest');
    expect(key1).not.toBe(key2);
  });

  it('treats null cursor as empty string', () => {
    const key1 = getSearchCacheKey('term', null as unknown as string, 'top');
    const key2 = getSearchCacheKey('term', '', 'top');
    expect(key1).toBe(key2);
  });

  it('returns valid JSON string', () => {
    const key = getSearchCacheKey('term', 'cursor', 'top');
    expect(() => JSON.parse(key)).not.toThrow();
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
