import { DID_CACHE_TTL_MS, SEARCH_CACHE_TTL_MS } from './constants.mjs';
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
