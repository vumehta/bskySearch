import {
  DID_CACHE_TTL_MS,
  MAX_DID_CACHE_SIZE,
  MAX_SEARCH_CACHE_SIZE,
  SEARCH_CACHE_TTL_MS,
} from './constants.mjs';
import { didCache, searchCache } from './state.mjs';

export function getCachedSearch(cacheKey) {
  const cached = searchCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(cacheKey);
    return null;
  }
  return cached.data;
}

export function getCachedDid(cacheKey) {
  const cached = didCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > DID_CACHE_TTL_MS) {
    didCache.delete(cacheKey);
    return null;
  }
  return cached.did;
}

export function enforceSearchCacheLimit() {
  while (searchCache.size > MAX_SEARCH_CACHE_SIZE) {
    searchCache.delete(searchCache.keys().next().value);
  }
}

export function enforceDidCacheLimit() {
  while (didCache.size > MAX_DID_CACHE_SIZE) {
    didCache.delete(didCache.keys().next().value);
  }
}
