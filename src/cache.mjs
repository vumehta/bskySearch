import {
  DID_CACHE_TTL_MS,
  MAX_DID_CACHE_SIZE,
  MAX_SEARCH_CACHE_SIZE,
  SEARCH_CACHE_TTL_MS,
} from './constants.mjs';
import { didCache, searchCache } from './state.mjs';

// Check if cached result is still valid
export function getCachedSearch(cacheKey) {
  const cached = searchCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(cacheKey);
    return null;
  }
  return cached.data;
}

// Check if cached DID is still valid
export function getCachedDid(cacheKey) {
  const cached = didCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > DID_CACHE_TTL_MS) {
    didCache.delete(cacheKey);
    return null;
  }
  return cached.did;
}

// Evict oldest search cache entries when over limit
export function enforceSearchCacheLimit() {
  while (searchCache.size > MAX_SEARCH_CACHE_SIZE) {
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey === undefined) break;
    searchCache.delete(oldestKey);
  }
}

// Evict oldest DID cache entries when over limit
export function enforceDidCacheLimit() {
  while (didCache.size > MAX_DID_CACHE_SIZE) {
    const oldestKey = didCache.keys().next().value;
    if (oldestKey === undefined) break;
    didCache.delete(oldestKey);
  }
}
