/**
 * Frontend pure function tests for bskySearch
 *
 * These tests cover the core utility functions that don't depend on DOM or network.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Import pure utilities from the refactored modules
const app = await import('../src/testing.mjs');

const {
  isValidBskyUrl,
  parseBlueskyPostUrl,
  deduplicatePosts,
  trackQuoteCursor,
  getSearchCacheKey,
  getCachedDid,
  filterByLikes,
  sortPosts,
  normalizeTerm,
  expandSearchTerms,
  formatDuration,
  didCache,
  state,
  isCurrentSearchGeneration,
  searchCache,
  DID_CACHE_TTL_MS,
  MAX_SEARCH_CACHE_SIZE,
  MAX_DID_CACHE_SIZE,
  enforceSearchCacheLimit,
  enforceDidCacheLimit,
  resolveSearchSortParam,
  resolveQuoteSortParam,
  isSearchSort,
  isQuoteSort,
} = app;

// ============================================================================
// isValidBskyUrl
// ============================================================================
describe('isValidBskyUrl', () => {
  it('returns true for valid bsky.app URLs', () => {
    expect(isValidBskyUrl('https://bsky.app/profile/someone')).toBe(true);
  });

  it('returns true for CDN URLs', () => {
    expect(isValidBskyUrl('https://cdn.bsky.app/img/something')).toBe(true);
  });

  it('returns true for subdomains of bsky.app', () => {
    expect(isValidBskyUrl('https://sub.bsky.app/page')).toBe(true);
  });

  it('returns true for subdomains of cdn.bsky.app', () => {
    expect(isValidBskyUrl('https://img.cdn.bsky.app/something')).toBe(true);
  });

  it('returns false for http (non-https)', () => {
    expect(isValidBskyUrl('http://bsky.app/profile/someone')).toBe(false);
  });

  it('returns false for other domains', () => {
    expect(isValidBskyUrl('https://twitter.com/someone')).toBe(false);
    expect(isValidBskyUrl('https://evil-bsky.app/profile')).toBe(false);
  });

  it('returns false for null/undefined/empty', () => {
    expect(isValidBskyUrl(null)).toBe(false);
    expect(isValidBskyUrl(undefined)).toBe(false);
    expect(isValidBskyUrl('')).toBe(false);
  });

  it('returns false for invalid URLs', () => {
    expect(isValidBskyUrl('not a url')).toBe(false);
    expect(isValidBskyUrl('bsky.app/profile')).toBe(false);
  });
});

// ============================================================================
// parseBlueskyPostUrl
// ============================================================================
describe('parseBlueskyPostUrl', () => {
  it('parses valid post URL with handle', () => {
    const result = parseBlueskyPostUrl('https://bsky.app/profile/alice.bsky.social/post/abc123');
    expect(result.actor).toBe('alice.bsky.social');
    expect(result.postId).toBe('abc123');
    expect(result.rawHandle).toBe('alice.bsky.social');
  });

  it('parses valid post URL with custom domain', () => {
    const result = parseBlueskyPostUrl('https://bsky.app/profile/alice.example.com/post/xyz789');
    expect(result.actor).toBe('alice.example.com');
    expect(result.postId).toBe('xyz789');
  });

  it('parses URL with DID as handle', () => {
    const result = parseBlueskyPostUrl('https://bsky.app/profile/did:plc:abc123/post/xyz');
    expect(result.actor).toBe('did:plc:abc123');
    expect(result.postId).toBe('xyz');
  });

  it('adds .bsky.social to simple handles without dot', () => {
    const result = parseBlueskyPostUrl('https://bsky.app/profile/alice/post/123');
    expect(result.actor).toBe('alice.bsky.social');
    expect(result.rawHandle).toBe('alice');
  });

  it('throws for invalid URL format', () => {
    expect(() => parseBlueskyPostUrl('not a url')).toThrow('Please enter a valid URL.');
  });

  it('throws for non-bsky.app domain', () => {
    expect(() => parseBlueskyPostUrl('https://twitter.com/user/status/123')).toThrow('URL must be from https://bsky.app');
  });

  it('throws for http (non-https)', () => {
    expect(() => parseBlueskyPostUrl('http://bsky.app/profile/alice/post/123')).toThrow('URL must be from https://bsky.app');
  });

  it('throws for malformed path', () => {
    expect(() => parseBlueskyPostUrl('https://bsky.app/some/other/path')).toThrow('Use https://bsky.app/profile/{handle}/post/{postId}');
  });

  it('throws for missing post ID', () => {
    expect(() => parseBlueskyPostUrl('https://bsky.app/profile/alice/post/')).toThrow();
  });
});

// ============================================================================
// deduplicatePosts
// ============================================================================
describe('deduplicatePosts', () => {
  it('returns empty array for empty input', () => {
    expect(deduplicatePosts([])).toEqual([]);
  });

  it('returns posts unchanged if no duplicates', () => {
    const posts = [
      { uri: 'at://1', matchedTerm: 'term1' },
      { uri: 'at://2', matchedTerm: 'term2' },
    ];
    const result = deduplicatePosts(posts);
    expect(result).toHaveLength(2);
    expect(result[0].matchedTerms).toEqual(['term1']);
    expect(result[1].matchedTerms).toEqual(['term2']);
  });

  it('deduplicates by URI', () => {
    const posts = [
      { uri: 'at://1', matchedTerm: 'term1' },
      { uri: 'at://1', matchedTerm: 'term1' },
      { uri: 'at://2', matchedTerm: 'term2' },
    ];
    const result = deduplicatePosts(posts);
    expect(result).toHaveLength(2);
  });

  it('merges matchedTerms for duplicate URIs', () => {
    const posts = [
      { uri: 'at://1', matchedTerm: 'term1' },
      { uri: 'at://1', matchedTerm: 'term2' },
      { uri: 'at://1', matchedTerm: 'term3' },
    ];
    const result = deduplicatePosts(posts);
    expect(result).toHaveLength(1);
    expect(result[0].matchedTerms).toContain('term1');
    expect(result[0].matchedTerms).toContain('term2');
    expect(result[0].matchedTerms).toContain('term3');
  });

  it('does not add duplicate matchedTerms', () => {
    const posts = [
      { uri: 'at://1', matchedTerm: 'term1' },
      { uri: 'at://1', matchedTerm: 'term1' },
    ];
    const result = deduplicatePosts(posts);
    expect(result[0].matchedTerms).toEqual(['term1']);
  });

  it('preserves other post properties', () => {
    const posts = [
      { uri: 'at://1', matchedTerm: 'term1', likeCount: 42, author: { handle: 'alice' } },
    ];
    const result = deduplicatePosts(posts);
    expect(result[0].likeCount).toBe(42);
    expect(result[0].author.handle).toBe('alice');
  });
});

// ============================================================================
// trackQuoteCursor (stateless behavior only)
// ============================================================================
describe('trackQuoteCursor', () => {
  it('returns null for null input', () => {
    expect(trackQuoteCursor(null)).toBe(null);
  });

  it('returns null for empty string', () => {
    expect(trackQuoteCursor('')).toBe(null);
  });

  it('returns null for undefined', () => {
    expect(trackQuoteCursor(undefined)).toBe(null);
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
});

// ============================================================================
// getCachedDid
// ============================================================================
describe('getCachedDid', () => {
  beforeEach(() => {
    didCache.clear();
  });

  it('returns null for missing key', () => {
    expect(getCachedDid('nonexistent')).toBe(null);
  });

  it('returns null for expired entry', () => {
    const expiredTimestamp = Date.now() - DID_CACHE_TTL_MS - 1000;
    didCache.set('alice', { did: 'did:plc:abc', timestamp: expiredTimestamp });
    expect(getCachedDid('alice')).toBe(null);
    // Should also delete the expired entry
    expect(didCache.has('alice')).toBe(false);
  });

  it('returns did for fresh entry', () => {
    const freshTimestamp = Date.now() - 1000; // 1 second ago
    didCache.set('bob', { did: 'did:plc:xyz', timestamp: freshTimestamp });
    expect(getCachedDid('bob')).toBe('did:plc:xyz');
  });

  it('returns did for entry at TTL boundary', () => {
    const boundaryTimestamp = Date.now() - DID_CACHE_TTL_MS + 1000; // Just under TTL
    didCache.set('carol', { did: 'did:plc:boundary', timestamp: boundaryTimestamp });
    expect(getCachedDid('carol')).toBe('did:plc:boundary');
  });
});

// ============================================================================
// expandSearchTerms
// ============================================================================
describe('expandSearchTerms', () => {
  it('returns single-word terms unchanged', () => {
    const result = expandSearchTerms(['hello', 'world'], false);
    expect(result).toEqual(['hello', 'world']);
  });

  it('does not expand when shouldExpandWords is false', () => {
    const result = expandSearchTerms(['hello world'], false);
    expect(result).toEqual(['hello world']);
  });

  it('expands multi-word terms when shouldExpandWords is true', () => {
    const result = expandSearchTerms(['hello world'], true);
    expect(result).toContain('hello world');
    expect(result).toContain('hello');
    expect(result).toContain('world');
  });

  it('deduplicates expanded terms (case-insensitive)', () => {
    const result = expandSearchTerms(['Hello', 'hello'], true);
    expect(result).toHaveLength(1);
  });

  it('handles empty terms array', () => {
    expect(expandSearchTerms([], true)).toEqual([]);
    expect(expandSearchTerms([], false)).toEqual([]);
  });

  it('filters out empty strings', () => {
    const result = expandSearchTerms(['', '  ', 'valid'], false);
    expect(result).toEqual(['valid']);
  });

  it('preserves original phrase before individual words', () => {
    const result = expandSearchTerms(['foo bar'], true);
    expect(result[0]).toBe('foo bar');
    expect(result).toContain('foo');
    expect(result).toContain('bar');
  });
});

// ============================================================================
// filterByLikes
// ============================================================================
describe('filterByLikes', () => {
  it('filters posts below minimum likes threshold', () => {
    const posts = [
      { uri: 'at://1', likeCount: 5 },
      { uri: 'at://2', likeCount: 15 },
      { uri: 'at://3', likeCount: 10 },
    ];
    const result = filterByLikes(posts, 10);
    expect(result).toHaveLength(2);
    expect(result.map(p => p.uri)).toEqual(['at://2', 'at://3']);
  });

  it('treats missing likeCount as 0', () => {
    const posts = [
      { uri: 'at://1' },
      { uri: 'at://2', likeCount: 10 },
    ];
    const result = filterByLikes(posts, 5);
    expect(result).toHaveLength(1);
    expect(result[0].uri).toBe('at://2');
  });

  it('returns all posts when minLikes is 0', () => {
    const posts = [
      { uri: 'at://1', likeCount: 0 },
      { uri: 'at://2' },
    ];
    const result = filterByLikes(posts, 0);
    expect(result).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(filterByLikes([], 10)).toEqual([]);
  });

  it('includes posts with exactly the minimum likes', () => {
    const posts = [{ uri: 'at://1', likeCount: 10 }];
    const result = filterByLikes(posts, 10);
    expect(result).toHaveLength(1);
  });
});

// ============================================================================
// sortPosts
// ============================================================================
describe('sortPosts', () => {
  const posts = [
    { uri: 'at://1', likeCount: 10, indexedAt: '2024-01-03T00:00:00Z', record: { createdAt: '2024-01-03T00:00:00Z' } },
    { uri: 'at://2', likeCount: 50, indexedAt: '2024-01-01T00:00:00Z', record: { createdAt: '2024-01-01T00:00:00Z' } },
    { uri: 'at://3', likeCount: 25, indexedAt: '2024-01-02T00:00:00Z', record: { createdAt: '2024-01-02T00:00:00Z' } },
  ];

  it('sorts by likes (high to low) for top mode', () => {
    const result = sortPosts(posts, 'top');
    expect(result[0].likeCount).toBe(50);
    expect(result[1].likeCount).toBe(25);
    expect(result[2].likeCount).toBe(10);
  });

  it('sorts by time (newest first) for latest mode', () => {
    const result = sortPosts(posts, 'latest');
    expect(result[0].uri).toBe('at://1');
    expect(result[1].uri).toBe('at://3');
    expect(result[2].uri).toBe('at://2');
  });

  it('does not mutate original array', () => {
    const original = [...posts];
    sortPosts(posts, 'top');
    expect(posts).toEqual(original);
  });

  it('defaults to top sorting', () => {
    const result = sortPosts(posts);
    expect(result[0].likeCount).toBe(50);
  });

  it('handles missing likeCount', () => {
    const postsWithMissing = [
      { uri: 'at://1' },
      { uri: 'at://2', likeCount: 10 },
    ];
    const result = sortPosts(postsWithMissing, 'top');
    expect(result[0].likeCount).toBe(10);
  });
});

// ============================================================================
// normalizeTerm
// ============================================================================
describe('normalizeTerm', () => {
  it('trims whitespace', () => {
    expect(normalizeTerm('  hello  ')).toBe('hello');
  });

  it('removes double quotes', () => {
    expect(normalizeTerm('"hello world"')).toBe('hello world');
  });

  it('removes single quotes', () => {
    expect(normalizeTerm("'hello world'")).toBe('hello world');
  });

  it('trims after removing quotes', () => {
    expect(normalizeTerm('" hello "')).toBe('hello');
  });

  it('does not remove unmatched quotes', () => {
    expect(normalizeTerm('"hello')).toBe('"hello');
    expect(normalizeTerm("hello'")).toBe("hello'");
  });

  it('handles empty string', () => {
    expect(normalizeTerm('')).toBe('');
    expect(normalizeTerm('   ')).toBe('');
  });

  it('preserves internal quotes', () => {
    expect(normalizeTerm('hello "world"')).toBe('hello "world"');
  });

  it('strips control characters', () => {
    expect(normalizeTerm('he\u0000l\u001Flo\u007F')).toBe('hello');
  });
});

// ============================================================================
// formatDuration
// ============================================================================
describe('formatDuration', () => {
  it('formats seconds only', () => {
    expect(formatDuration(45000)).toBe('0:45');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(125000)).toBe('2:05');
  });

  it('pads seconds with leading zero', () => {
    expect(formatDuration(65000)).toBe('1:05');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(3660000)).toBe('1h 1m');
  });

  it('formats multiple hours', () => {
    expect(formatDuration(7320000)).toBe('2h 2m');
  });

  it('handles zero', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  it('handles negative values as zero', () => {
    expect(formatDuration(-1000)).toBe('0:00');
  });

  it('handles exactly one hour', () => {
    expect(formatDuration(3600000)).toBe('1h 0m');
  });
});

// ============================================================================
// isCurrentSearchGeneration
// ============================================================================
describe('isCurrentSearchGeneration', () => {
  const originalGeneration = state.searchGeneration;

  beforeEach(() => {
    state.searchGeneration = originalGeneration;
  });

  it('returns true when generation matches current state', () => {
    state.searchGeneration = 42;
    expect(isCurrentSearchGeneration(42)).toBe(true);
  });

  it('returns false when generation is stale', () => {
    state.searchGeneration = 42;
    expect(isCurrentSearchGeneration(41)).toBe(false);
  });
});

// ============================================================================
// enforceSearchCacheLimit
// ============================================================================
describe('enforceSearchCacheLimit', () => {
  beforeEach(() => {
    searchCache.clear();
  });

  it('trims search cache to MAX_SEARCH_CACHE_SIZE', () => {
    for (let i = 0; i < MAX_SEARCH_CACHE_SIZE + 10; i++) {
      searchCache.set(`key-${i}`, { data: { id: i }, timestamp: Date.now() });
    }

    enforceSearchCacheLimit();

    expect(searchCache.size).toBe(MAX_SEARCH_CACHE_SIZE);
  });

  it('removes oldest entries first', () => {
    for (let i = 0; i < MAX_SEARCH_CACHE_SIZE + 5; i++) {
      searchCache.set(`key-${i}`, { data: { id: i }, timestamp: Date.now() });
    }

    enforceSearchCacheLimit();

    // Oldest 5 entries should be gone
    for (let i = 0; i < 5; i++) {
      expect(searchCache.has(`key-${i}`)).toBe(false);
    }
    // Newest entries should remain
    expect(searchCache.has(`key-${MAX_SEARCH_CACHE_SIZE + 4}`)).toBe(true);
  });

  it('does nothing when under limit', () => {
    searchCache.set('a', { data: {}, timestamp: Date.now() });
    searchCache.set('b', { data: {}, timestamp: Date.now() });

    enforceSearchCacheLimit();

    expect(searchCache.size).toBe(2);
  });
});

// ============================================================================
// enforceDidCacheLimit
// ============================================================================
describe('enforceDidCacheLimit', () => {
  beforeEach(() => {
    didCache.clear();
  });

  it('trims DID cache to MAX_DID_CACHE_SIZE', () => {
    for (let i = 0; i < MAX_DID_CACHE_SIZE + 10; i++) {
      didCache.set(`handle-${i}`, { did: `did:plc:${i}`, timestamp: Date.now() });
    }

    enforceDidCacheLimit();

    expect(didCache.size).toBe(MAX_DID_CACHE_SIZE);
  });

  it('removes oldest entries first', () => {
    for (let i = 0; i < MAX_DID_CACHE_SIZE + 3; i++) {
      didCache.set(`handle-${i}`, { did: `did:plc:${i}`, timestamp: Date.now() });
    }

    enforceDidCacheLimit();

    // Oldest 3 entries should be gone
    for (let i = 0; i < 3; i++) {
      expect(didCache.has(`handle-${i}`)).toBe(false);
    }
    // Newest entries should remain
    expect(didCache.has(`handle-${MAX_DID_CACHE_SIZE + 2}`)).toBe(true);
  });

  it('does nothing when under limit', () => {
    didCache.set('alice', { did: 'did:plc:1', timestamp: Date.now() });

    enforceDidCacheLimit();

    expect(didCache.size).toBe(1);
  });
});

// ============================================================================
// sort query param helpers
// ============================================================================
describe('sort query param helpers', () => {
  it('identifies valid search sorts', () => {
    expect(isSearchSort('top')).toBe(true);
    expect(isSearchSort('latest')).toBe(true);
    expect(isSearchSort('recent')).toBe(false);
    expect(isSearchSort(null)).toBe(false);
  });

  it('identifies valid quote sorts', () => {
    expect(isQuoteSort('likes')).toBe(true);
    expect(isQuoteSort('recent')).toBe(true);
    expect(isQuoteSort('oldest')).toBe(true);
    expect(isQuoteSort('latest')).toBe(false);
    expect(isQuoteSort(null)).toBe(false);
  });

  it('prefers searchSort over legacy sort for search state', () => {
    const params = new URLSearchParams('searchSort=latest&sort=top');
    expect(resolveSearchSortParam(params)).toBe('latest');
  });

  it('uses legacy sort for search state when searchSort is absent', () => {
    const params = new URLSearchParams('sort=latest');
    expect(resolveSearchSortParam(params)).toBe('latest');
  });

  it('ignores quote-only legacy sort for search state', () => {
    const params = new URLSearchParams('sort=recent');
    expect(resolveSearchSortParam(params)).toBe(null);
  });

  it('prefers quoteSort over legacy sort for quote state', () => {
    const params = new URLSearchParams('quoteSort=recent&sort=likes');
    expect(resolveQuoteSortParam(params)).toBe('recent');
  });

  it('uses legacy sort for quote state when quoteSort is absent', () => {
    const params = new URLSearchParams('sort=oldest');
    expect(resolveQuoteSortParam(params)).toBe('oldest');
  });

  it('ignores search-only legacy sort for quote state', () => {
    const params = new URLSearchParams('sort=latest');
    expect(resolveQuoteSortParam(params)).toBe(null);
  });
});
