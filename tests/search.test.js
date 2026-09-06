import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testUtils } from '../api/search.mjs';

const {
  isValidSince,
  getCachedSearchResult,
  cleanupSearchCache,
  enforceSearchCacheLimit,
  searchResultsCache,
  SEARCH_CACHE_TTL_MS,
  MAX_SEARCH_CACHE_SIZE,
  resetModuleStateForTests,
} = testUtils;

beforeEach(() => resetModuleStateForTests());

afterEach(() => vi.restoreAllMocks());

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
