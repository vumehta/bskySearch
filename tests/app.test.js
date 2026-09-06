import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  isValidBskyUrl,
  parseBlueskyPostUrl,
  getSearchCacheKey,
  getSearchSince,
  filterByDate,
  filterByLikes,
  sortPosts,
  normalizeTerm,
  expandSearchTerms,
  getPostTimestamp,
} from '../src/utils.mjs';
import { enforceDidCacheLimit, enforceSearchCacheLimit, getCachedDid } from '../src/cache.mjs';
import { didCache, searchCache } from '../src/state.mjs';
import { DID_CACHE_TTL_MS, MAX_DID_CACHE_SIZE, MAX_SEARCH_CACHE_SIZE } from '../src/constants.mjs';

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

describe('getSearchCacheKey', () => {
  it('keeps each search dimension isolated in the cache', () => {
    const searches = [
      ['term', 'cursor', 'top', '2026-08-31T00:00:00Z'],
      ['other', 'cursor', 'top', '2026-08-31T00:00:00Z'],
      ['term', 'next', 'top', '2026-08-31T00:00:00Z'],
      ['term', 'cursor', 'latest', '2026-08-31T00:00:00Z'],
      ['term', 'cursor', 'top', '2026-08-30T00:00:00Z'],
    ];
    expect(new Set(searches.map((args) => getSearchCacheKey(...args))).size).toBe(searches.length);
  });

  it('normalizes missing pagination and date filters', () => {
    expect(getSearchCacheKey('term', null, 'top')).toBe(getSearchCacheKey('term', '', 'top'));
    expect(getSearchCacheKey('term', null, 'top')).toBe(getSearchCacheKey('term', null, 'top', ''));
  });
});

describe('getSearchSince', () => {
  const now = Date.UTC(2026, 8, 1, 18, 34, 56, 789); // 2026-09-01T18:34:56.789Z

  it('returns the window start rounded down to the minute in UTC', () => {
    expect(getSearchSince(24, now)).toBe('2026-08-31T18:34:00Z');
    expect(getSearchSince(1, now)).toBe('2026-09-01T17:34:00Z');
    expect(getSearchSince(168, now)).toBe('2026-08-25T18:34:00Z');
  });

  it('falls back to 24 hours for invalid windows', () => {
    expect(getSearchSince(0, now)).toBe('2026-08-31T18:34:00Z');
    expect(getSearchSince(NaN, now)).toBe('2026-08-31T18:34:00Z');
    expect(getSearchSince(-5, now)).toBe('2026-08-31T18:34:00Z');
  });

  it('is stable within a minute so cache keys can be shared', () => {
    expect(getSearchSince(24, now)).toBe(getSearchSince(24, now + 3000));
    expect(getSearchSince(24, now)).not.toBe(getSearchSince(24, now + 60000));
  });
});

describe('getCachedDid', () => {
  afterEach(() => {
    didCache.clear();
    vi.useRealTimers();
  });

  it('reuses a DID through its TTL boundary and removes it once expired', () => {
    vi.useFakeTimers();
    expect(getCachedDid('alice')).toBeNull();
    didCache.set('alice', { did: 'did:plc:abc', timestamp: Date.now() });
    expect(getCachedDid('alice')).toBe('did:plc:abc');
    vi.advanceTimersByTime(DID_CACHE_TTL_MS);
    expect(getCachedDid('alice')).toBe('did:plc:abc');
    vi.advanceTimersByTime(1);
    expect(getCachedDid('alice')).toBeNull();
    expect(didCache.has('alice')).toBe(false);
  });
});

describe('expandSearchTerms', () => {
  it('keeps phrases and single words intact when expansion is off', () => {
    expect(expandSearchTerms(['hello world', 'single'], false)).toEqual(['hello world', 'single']);
  });

  it('expands phrases in order without repeated or empty terms', () => {
    expect(expandSearchTerms(['Hello world', 'hello', '', 'WORLD', '  '], true))
      .toEqual(['Hello world', 'Hello', 'world']);
  });

  it('handles empty terms arrays', () => {
    expect(expandSearchTerms([], true)).toEqual([]);
    expect(expandSearchTerms([], false)).toEqual([]);
  });

  it('filters empty terms with expansion off', () => {
    expect(expandSearchTerms(['', '  ', 'valid'], false)).toEqual(['valid']);
  });
});

describe('filterByLikes', () => {
  it('includes the threshold and treats missing counts as zero', () => {
    const posts = [
      { uri: 'at://1', likeCount: 5 },
      { uri: 'at://2', likeCount: 15 },
      { uri: 'at://3', likeCount: 10 },
      { uri: 'at://4' },
      { uri: 'at://5', likeCount: 0 },
    ];
    expect(filterByLikes(posts, 10).map((post) => post.uri)).toEqual(['at://2', 'at://3']);
    expect(filterByLikes(posts, 0)).toEqual(posts);
  });
});

describe('filterByDate', () => {
  const fixedNow = Date.parse('2026-01-01T12:00:00.000Z');

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults invalid/non-positive hours to 24', () => {
    const posts = [
      {
        uri: 'at://fresh',
        indexedAt: '2025-12-31T14:00:00.000Z', // 22h before fixedNow
      },
      {
        uri: 'at://stale',
        indexedAt: '2025-12-31T10:00:00.000Z', // 26h before fixedNow
      },
    ];

    const zeroHours = filterByDate(posts, 0);
    const negativeHours = filterByDate(posts, -6);
    const nanHours = filterByDate(posts, Number.NaN);

    expect(zeroHours.map((post) => post.uri)).toEqual(['at://fresh']);
    expect(negativeHours.map((post) => post.uri)).toEqual(['at://fresh']);
    expect(nanHours.map((post) => post.uri)).toEqual(['at://fresh']);
  });

  it('filters by creation time when it differs from indexing time', () => {
    const posts = [
      {
        uri: 'at://fallback-recent',
        indexedAt: '2025-12-31T08:00:00.000Z', // stale if used directly
        record: { createdAt: '2026-01-01T11:00:00.000Z' }, // fresh
      },
      {
        uri: 'at://stale',
        indexedAt: '2025-12-31T07:00:00.000Z',
      },
    ];

    const result = filterByDate(posts, 24);
    expect(result.map((post) => post.uri)).toEqual(['at://fallback-recent']);
  });
});

describe('getPostTimestamp', () => {
  it('prefers record.createdAt when present', () => {
    const post = {
      indexedAt: '2025-01-01T00:00:00.000Z',
      record: { createdAt: '2026-01-01T00:00:00.000Z' },
    };
    expect(getPostTimestamp(post)).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  it('falls back to indexedAt when createdAt is missing', () => {
    const post = { indexedAt: '2026-01-02T00:00:00.000Z' };
    expect(getPostTimestamp(post)).toBe(Date.parse('2026-01-02T00:00:00.000Z'));
  });

  it('returns 0 for invalid timestamps', () => {
    const post = {
      indexedAt: 'not-a-date',
      record: { createdAt: 'also-not-a-date' },
    };
    expect(getPostTimestamp(post)).toBe(0);
  });
});

describe('sortPosts', () => {
  const posts = Object.freeze([
    { uri: 'at://4', indexedAt: '2023-12-31T00:00:00Z' },
    { uri: 'at://1', likeCount: 10, record: { createdAt: '2024-01-03T00:00:00Z' } },
    { uri: 'at://2', likeCount: 50, record: { createdAt: '2024-01-01T00:00:00Z' } },
    { uri: 'at://3', likeCount: 25, record: { createdAt: '2024-01-02T00:00:00Z' } },
  ]);

  it('defaults to descending likes, treating missing counts as zero, without changing the input', () => {
    const expected = [posts[2], posts[3], posts[1], posts[0]];
    expect(sortPosts(posts, 'top')).toEqual(expected);
    expect(sortPosts(posts)).toEqual(expected);
  });

  it('sorts by newest time without changing the input', () => {
    expect(sortPosts(posts, 'latest')).toEqual([posts[1], posts[3], posts[2], posts[0]]);
  });
});

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

describe.each([
  ['search', searchCache, MAX_SEARCH_CACHE_SIZE, enforceSearchCacheLimit],
  ['DID', didCache, MAX_DID_CACHE_SIZE, enforceDidCacheLimit],
])('%s cache capacity', (_, cache, limit, enforceLimit) => {
  afterEach(() => cache.clear());

  it('leaves small caches intact and evicts the oldest entries on overflow', () => {
    cache.set('key-0', {});
    cache.set('key-1', {});
    enforceLimit();
    expect([...cache.keys()]).toEqual(['key-0', 'key-1']);

    for (let index = 2; index < limit + 4; index++) cache.set('key-' + index, {});
    enforceLimit();
    expect([...cache.keys()]).toEqual(Array.from({ length: limit }, (_, index) => 'key-' + (index + 4)));
  });
});
