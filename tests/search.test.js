/**
 * Backend utility tests for bskySearch API
 *
 * Tests pure utility functions from the search API module.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Import test utilities from the search module
const { testUtils } = await import('../api/search.js');
const {
  getQueryString,
  getSearchCacheKey,
  isSessionExpired,
  getCachedSearchResult,
  cleanupSearchCache,
  enforceSearchCacheLimit,
  searchResultsCache,
  SEARCH_CACHE_TTL_MS,
  MAX_SEARCH_CACHE_SIZE,
} = testUtils;

beforeEach(() => {
  searchResultsCache.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
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
});
