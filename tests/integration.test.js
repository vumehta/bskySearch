/**
 * Integration tests for bskySearch
 *
 * Tests full request/response flows, caching, session
 * management, and the frontend filter pipeline.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ============================================================================
// Backend handler integration tests
// ============================================================================

process.env.BSKY_HANDLE = process.env.BSKY_HANDLE || 'test-handle';
process.env.BSKY_APP_PASSWORD = process.env.BSKY_APP_PASSWORD || 'test-app-password';

const searchModule = await import('../api/search.js');
const searchHandler = searchModule.default;
const { testUtils } = searchModule;
const {
  resetModuleStateForTests,
  searchResultsCache,
  getCachedSearchResult,
  SEARCH_CACHE_TTL_MS,
} = testUtils;

const originalFetch = global.fetch;

function createMockRequest(query = {}, options = {}) {
  return {
    method: options.method || 'GET',
    query,
    headers: options.headers || {},
    socket: options.socket || { remoteAddress: '127.0.0.1' },
  };
}

function createMockResponse() {
  const res = {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader: vi.fn((key, value) => {
      res.headers[key] = value;
      return res;
    }),
    status: vi.fn((code) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((payload) => {
      res.body = payload;
      return res;
    }),
  };
  return res;
}

function mockBlueskyAPI(posts = [], cursor = null) {
  global.fetch = vi.fn((url) => {
    if (url.includes('/com.atproto.server.createSession')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          accessJwt: 'test-access-jwt',
          refreshJwt: 'test-refresh-jwt',
        }),
      });
    }
    if (url.includes('/app.bsky.feed.searchPosts')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ posts, cursor }),
      });
    }
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  });
}

beforeEach(() => {
  resetModuleStateForTests();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ============================================================================
// Full search handler flow
// ============================================================================
describe('search handler full flow', () => {
  it('returns search results for a valid query', async () => {
    const mockPosts = [
      { uri: 'at://did:plc:1/app.bsky.feed.post/abc', text: 'hello world' },
      { uri: 'at://did:plc:2/app.bsky.feed.post/def', text: 'test post' },
    ];
    mockBlueskyAPI(mockPosts, 'next-cursor');

    const req = createMockRequest({ term: 'hello' });
    const res = createMockResponse();

    await searchHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body.posts).toHaveLength(2);
    expect(res.body.cursor).toBe('next-cursor');
  });

  it('sets no-store cache header', async () => {
    mockBlueskyAPI([]);
    const req = createMockRequest({ term: 'test' });
    const res = createMockResponse();

    await searchHandler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('passes sort parameter to upstream API', async () => {
    mockBlueskyAPI([]);
    const req = createMockRequest({ term: 'test', sort: 'latest' });
    const res = createMockResponse();

    await searchHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const searchCall = global.fetch.mock.calls.find((c) => c[0].includes('searchPosts'));
    expect(searchCall[0]).toContain('sort=latest');
  });

  it('passes cursor parameter for pagination', async () => {
    mockBlueskyAPI([]);
    const req = createMockRequest({ term: 'test', cursor: 'page2' });
    const res = createMockResponse();

    await searchHandler(req, res);

    const searchCall = global.fetch.mock.calls.find((c) => c[0].includes('searchPosts'));
    expect(searchCall[0]).toContain('cursor=page2');
  });
});

// ============================================================================
// Input validation
// ============================================================================
describe('search handler input validation', () => {
  it('rejects non-GET methods', async () => {
    const req = createMockRequest({ term: 'test' }, { method: 'POST' });
    const res = createMockResponse();

    await searchHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.body.error).toBe('Method not allowed.');
    expect(res.setHeader).toHaveBeenCalledWith('Allow', 'GET');
  });

  it('returns 400 for missing term', async () => {
    const req = createMockRequest({});
    const res = createMockResponse();

    await searchHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toBe('Missing term parameter.');
  });

  it('returns 400 for empty term', async () => {
    const req = createMockRequest({ term: '   ' });
    const res = createMockResponse();

    await searchHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toBe('Missing term parameter.');
  });

  it('returns 400 for term exceeding 500 chars', async () => {
    const req = createMockRequest({ term: 'a'.repeat(501) });
    const res = createMockResponse();

    await searchHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toBe('Search term is too long.');
  });

  it('returns 400 for cursor exceeding 1000 chars', async () => {
    const req = createMockRequest({ term: 'test', cursor: 'x'.repeat(1001) });
    const res = createMockResponse();

    await searchHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toBe('Cursor is too long.');
  });

  it('returns 400 for invalid sort parameter', async () => {
    const req = createMockRequest({ term: 'test', sort: 'invalid' });
    const res = createMockResponse();

    await searchHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.error).toBe('Invalid sort parameter.');
  });

  it('accepts valid sort values', async () => {
    mockBlueskyAPI([]);

    for (const sort of ['top', 'latest']) {
      resetModuleStateForTests();
      const req = createMockRequest({ term: 'test', sort });
      const res = createMockResponse();
      await searchHandler(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
    }
  });

  it('strips control characters from term', async () => {
    mockBlueskyAPI([]);
    const req = createMockRequest({ term: 'hel\u0000lo\u001F' });
    const res = createMockResponse();

    await searchHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    const searchCall = global.fetch.mock.calls.find((c) => c[0].includes('searchPosts'));
    expect(searchCall[0]).toContain('q=hello');
  });
});

// ============================================================================
// Server-side search cache
// ============================================================================
describe('server-side search cache', () => {
  it('caches results and returns cached data on repeat request', async () => {
    const mockPosts = [{ uri: 'at://1', text: 'cached result' }];
    mockBlueskyAPI(mockPosts);

    const req1 = createMockRequest({ term: 'cacheme' });
    const res1 = createMockResponse();
    await searchHandler(req1, res1);

    expect(res1.status).toHaveBeenCalledWith(200);
    expect(res1.body.posts).toHaveLength(1);

    // Second request should use cache (no new fetch calls after session creation)
    const fetchCountAfterFirst = global.fetch.mock.calls.length;

    const req2 = createMockRequest({ term: 'cacheme' });
    const res2 = createMockResponse();
    await searchHandler(req2, res2);

    expect(res2.status).toHaveBeenCalledWith(200);
    expect(res2.body.posts).toHaveLength(1);
    // No additional fetch calls — served from cache
    expect(global.fetch.mock.calls.length).toBe(fetchCountAfterFirst);
  });

  it('cache expires after TTL', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    searchResultsCache.set('test-key', {
      data: { posts: [], cursor: null },
      timestamp: now,
    });

    expect(getCachedSearchResult('test-key')).not.toBeNull();

    vi.setSystemTime(now + SEARCH_CACHE_TTL_MS + 1);
    expect(getCachedSearchResult('test-key')).toBeNull();
  });
});

// ============================================================================
// Session management integration
// ============================================================================
describe('session management', () => {
  it('refreshes session on 401 and retries search', async () => {
    let searchCallCount = 0;
    const mockPosts = [{ uri: 'at://1', text: 'after refresh' }];

    global.fetch = vi.fn((url) => {
      if (url.includes('/com.atproto.server.createSession')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            accessJwt: 'initial-jwt',
            refreshJwt: 'refresh-jwt',
          }),
        });
      }
      if (url.includes('/com.atproto.server.refreshSession')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            accessJwt: 'refreshed-jwt',
            refreshJwt: 'new-refresh-jwt',
          }),
        });
      }
      if (url.includes('/app.bsky.feed.searchPosts')) {
        searchCallCount++;
        if (searchCallCount === 1) {
          // First search returns 401
          return Promise.resolve({
            ok: false,
            status: 401,
            json: async () => ({ error: 'Unauthorized' }),
          });
        }
        // Second search (after refresh) succeeds
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ posts: mockPosts, cursor: null }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const req = createMockRequest({ term: 'test' });
    const res = createMockResponse();

    await searchHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body.posts).toHaveLength(1);
    expect(searchCallCount).toBe(2);

    // Verify refresh was called
    const refreshCall = global.fetch.mock.calls.find((c) =>
      c[0].includes('refreshSession')
    );
    expect(refreshCall).toBeDefined();
  });

  it('propagates upstream error status codes', async () => {
    global.fetch = vi.fn((url) => {
      if (url.includes('/com.atproto.server.createSession')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            accessJwt: 'jwt',
            refreshJwt: 'rjwt',
          }),
        });
      }
      if (url.includes('/app.bsky.feed.searchPosts')) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: async () => ({ message: 'Service Unavailable' }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    const req = createMockRequest({ term: 'test' });
    const res = createMockResponse();

    await searchHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.body.error).toBe('Service Unavailable');
  });
});

// ============================================================================
// Frontend filter pipeline integration
// ============================================================================
const app = await import('../src/testing.mjs');
const {
  deduplicatePosts,
  filterByLikes,
  sortPosts,
  expandSearchTerms,
  normalizeTerm,
} = app;

describe('filter pipeline integration', () => {
  const rawPosts = [
    { uri: 'at://1', matchedTerm: 'react', likeCount: 50, indexedAt: '2024-01-03T00:00:00Z', record: { createdAt: '2024-01-03T00:00:00Z' } },
    { uri: 'at://1', matchedTerm: 'javascript', likeCount: 50, indexedAt: '2024-01-03T00:00:00Z', record: { createdAt: '2024-01-03T00:00:00Z' } },
    { uri: 'at://2', matchedTerm: 'react', likeCount: 5, indexedAt: '2024-01-02T00:00:00Z', record: { createdAt: '2024-01-02T00:00:00Z' } },
    { uri: 'at://3', matchedTerm: 'javascript', likeCount: 25, indexedAt: '2024-01-01T00:00:00Z', record: { createdAt: '2024-01-01T00:00:00Z' } },
    { uri: 'at://4', matchedTerm: 'react', likeCount: 100, indexedAt: '2024-01-04T00:00:00Z', record: { createdAt: '2024-01-04T00:00:00Z' } },
  ];

  it('dedup → filter → sort pipeline produces correct results', () => {
    const deduped = deduplicatePosts(rawPosts);
    expect(deduped).toHaveLength(4);

    // Post at://1 should have both matched terms
    const merged = deduped.find((p) => p.uri === 'at://1');
    expect(merged.matchedTerms).toContain('react');
    expect(merged.matchedTerms).toContain('javascript');

    const filtered = filterByLikes(deduped, 10);
    expect(filtered).toHaveLength(3);
    expect(filtered.every((p) => p.likeCount >= 10)).toBe(true);

    const sortedByLikes = sortPosts(filtered, 'top');
    expect(sortedByLikes[0].likeCount).toBe(100);
    expect(sortedByLikes[1].likeCount).toBe(50);
    expect(sortedByLikes[2].likeCount).toBe(25);

    const sortedByTime = sortPosts(filtered, 'latest');
    expect(sortedByTime[0].uri).toBe('at://4');
    expect(sortedByTime[1].uri).toBe('at://1');
    expect(sortedByTime[2].uri).toBe('at://3');
  });

  it('handles empty input through the pipeline', () => {
    const deduped = deduplicatePosts([]);
    const filtered = filterByLikes(deduped, 10);
    const sorted = sortPosts(filtered, 'top');
    expect(sorted).toEqual([]);
  });

  it('handles all posts filtered out by likes', () => {
    const lowLikePosts = [
      { uri: 'at://1', matchedTerm: 'test', likeCount: 1 },
      { uri: 'at://2', matchedTerm: 'test', likeCount: 2 },
    ];
    const deduped = deduplicatePosts(lowLikePosts);
    const filtered = filterByLikes(deduped, 100);
    expect(filtered).toHaveLength(0);
  });
});

// ============================================================================
// Term expansion integration
// ============================================================================
describe('term normalization and expansion pipeline', () => {
  it('normalizes and expands quoted multi-word terms', () => {
    const raw = '"machine learning", AI';
    const terms = raw.split(',').map(normalizeTerm).filter(Boolean);
    expect(terms).toEqual(['machine learning', 'AI']);

    const expanded = expandSearchTerms(terms, true);
    expect(expanded).toContain('machine learning');
    expect(expanded).toContain('machine');
    expect(expanded).toContain('learning');
    expect(expanded).toContain('AI');
  });

  it('deduplicates case-insensitively across raw and expanded', () => {
    const raw = 'React, react native';
    const terms = raw.split(',').map(normalizeTerm).filter(Boolean);
    const expanded = expandSearchTerms(terms, true);

    // 'react' appears both as standalone and part of 'react native'
    const lowerTerms = expanded.map((t) => t.toLowerCase());
    const uniqueLower = new Set(lowerTerms);
    expect(uniqueLower.size).toBe(lowerTerms.length);
  });

  it('preserves original phrase before individual words', () => {
    const terms = ['hello world'];
    const expanded = expandSearchTerms(terms, true);
    expect(expanded[0]).toBe('hello world');
    const rest = expanded.slice(1);
    expect(rest).toContain('hello');
    expect(rest).toContain('world');
  });
});
