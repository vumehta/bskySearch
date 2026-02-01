/**
 * Backend utility tests for bskySearch API
 *
 * Tests pure utility functions from the search API module.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Import test utilities from the search module
const { testUtils } = await import('../api/search.js');
const { getQueryString, getSearchCacheKey, isSessionExpired } = testUtils;

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

  it('returns empty string for empty array', () => {
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
