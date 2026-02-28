import {
  DID_CACHE_TTL_MS,
  MAX_DID_CACHE_SIZE,
  MAX_SEARCH_CACHE_SIZE,
  SEARCH_CACHE_TTL_MS,
} from './constants';
import { didCache, searchCache } from './state';

// Check if cached result is still valid
export function getCachedSearch(cacheKey: string): unknown | null {
  const cached = searchCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(cacheKey);
    return null;
  }
  return cached.data;
}

// Check if cached DID is still valid
export function getCachedDid(cacheKey: string): string | null {
  const cached = didCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > DID_CACHE_TTL_MS) {
    didCache.delete(cacheKey);
    return null;
  }
  return cached.did;
}

// Evict oldest search cache entries when over limit
export function enforceSearchCacheLimit(): void {
  while (searchCache.size > MAX_SEARCH_CACHE_SIZE) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey === undefined) break;
    searchCache.delete(oldestKey);
  }
}

// Evict oldest DID cache entries when over limit
export function enforceDidCacheLimit(): void {
  while (didCache.size > MAX_DID_CACHE_SIZE) {
    const oldestKey = didCache.keys().next().value;
    if (oldestKey === undefined) break;
    didCache.delete(oldestKey);
  }
}
