import {
  DID_CACHE_TTL_MS,
  MAX_DID_CACHE_SIZE,
  MAX_SEARCH_CACHE_SIZE,
  PUBLIC_API,
  SEARCH_API,
  SEARCH_CACHE_TTL_MS,
} from './constants';
import type { Post, QuotePage, SearchResponse, SearchSort } from './types';
import { getSearchCacheKey } from './utils';

interface TimedValue<T> {
  value: T;
  timestamp: number;
}

const searchCache = new Map<string, TimedValue<SearchResponse>>();
const didCache = new Map<string, TimedValue<string>>();
const inFlightSearch = new Map<string, Promise<SearchResponse>>();
const inFlightDid = new Map<string, Promise<string>>();

function getCachedSearch(cacheKey: string): SearchResponse | null {
  const cached = searchCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(cacheKey);
    return null;
  }
  return cached.value;
}

function getCachedDid(cacheKey: string): string | null {
  const cached = didCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > DID_CACHE_TTL_MS) {
    didCache.delete(cacheKey);
    return null;
  }
  return cached.value;
}

function enforceMapLimit(map: Map<string, unknown>, maxSize: number) {
  while (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    if (!oldestKey) {
      return;
    }
    map.delete(oldestKey);
  }
}

async function parseError(response: Response, fallback: string): Promise<Error> {
  try {
    const data = await response.json();
    const message = data?.message || data?.error;
    if (typeof message === 'string' && message.trim()) {
      return new Error(`${fallback} - ${message}`);
    }
  } catch {
    // ignore parse failure and fall back to status-only message
  }
  return new Error(fallback);
}

export async function searchTerm(
  term: string,
  cursor: string | null,
  sort: SearchSort,
): Promise<SearchResponse> {
  const sortMode = sort === 'latest' ? 'latest' : 'top';
  const cacheKey = getSearchCacheKey(term, cursor, sortMode);
  const cached = getCachedSearch(cacheKey);
  if (cached) {
    return cached;
  }

  const existing = inFlightSearch.get(cacheKey);
  if (existing) {
    return existing;
  }

  const params = new URLSearchParams({ term, sort: sortMode });
  if (cursor) {
    params.set('cursor', cursor);
  }

  const request = (async () => {
    const response = await fetch(`${SEARCH_API}?${params}`);
    if (!response.ok) {
      throw await parseError(response, `Search failed for "${term}": ${response.status}`);
    }

    const data = await response.json();
    const payload: SearchResponse = {
      posts: Array.isArray(data.posts) ? (data.posts as Post[]) : [],
      cursor: typeof data.cursor === 'string' ? data.cursor : null,
    };

    searchCache.set(cacheKey, { value: payload, timestamp: Date.now() });
    enforceMapLimit(searchCache, MAX_SEARCH_CACHE_SIZE);

    return payload;
  })();

  inFlightSearch.set(cacheKey, request);

  try {
    return await request;
  } finally {
    inFlightSearch.delete(cacheKey);
  }
}

export async function fetchDid(actor: string): Promise<string> {
  const cacheKey = actor.toLowerCase();
  const cached = getCachedDid(cacheKey);
  if (cached) {
    return cached;
  }

  const existing = inFlightDid.get(cacheKey);
  if (existing) {
    return existing;
  }

  const request = (async () => {
    const response = await fetch(
      `${PUBLIC_API}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`,
    );
    if (!response.ok) {
      throw await parseError(response, `Profile fetch failed: ${response.status}`);
    }

    const data = await response.json();
    const did = data?.did || data?.profile?.did;
    if (typeof did !== 'string' || !did) {
      throw new Error('Could not resolve DID for that handle.');
    }

    didCache.set(cacheKey, { value: did, timestamp: Date.now() });
    enforceMapLimit(didCache, MAX_DID_CACHE_SIZE);
    return did;
  })();

  inFlightDid.set(cacheKey, request);

  try {
    return await request;
  } finally {
    inFlightDid.delete(cacheKey);
  }
}

export async function fetchOriginalPost(atUri: string): Promise<Post> {
  const response = await fetch(
    `${PUBLIC_API}/app.bsky.feed.getPosts?uris=${encodeURIComponent(atUri)}`,
  );
  if (!response.ok) {
    throw await parseError(response, `Original post fetch failed: ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data.posts) || data.posts.length === 0) {
    throw new Error('Post not found.');
  }

  return data.posts[0] as Post;
}

export async function fetchQuotesPage(
  atUri: string,
  cursor: string | null = null,
): Promise<QuotePage> {
  const params = new URLSearchParams({
    uri: atUri,
    limit: '100',
  });
  if (cursor) {
    params.set('cursor', cursor);
  }

  const response = await fetch(`${PUBLIC_API}/app.bsky.feed.getQuotes?${params}`);
  if (!response.ok) {
    throw await parseError(response, `Quotes fetch failed: ${response.status}`);
  }

  const data = await response.json();
  return {
    posts: Array.isArray(data.posts) ? (data.posts as Post[]) : [],
    cursor: typeof data.cursor === 'string' ? data.cursor : null,
  };
}

interface ThreadResponse {
  thread?: {
    parent?: ThreadNode;
  };
}

interface ThreadNode {
  post?: Post;
  parent?: ThreadNode;
}

export const testUtils = {
  get didCache() {
    return didCache;
  },
  get searchCache() {
    return searchCache;
  },
  getCachedDid,
  enforceSearchCacheLimit(maxSize: number = MAX_SEARCH_CACHE_SIZE) {
    enforceMapLimit(searchCache, maxSize);
  },
  enforceDidCacheLimit(maxSize: number = MAX_DID_CACHE_SIZE) {
    enforceMapLimit(didCache, maxSize);
  },
};

export async function fetchThreadParents(atUri: string): Promise<Post[]> {
  const params = new URLSearchParams({
    uri: atUri,
    depth: '0',
    parentHeight: '100',
  });

  const response = await fetch(`${PUBLIC_API}/app.bsky.feed.getPostThread?${params}`);
  if (!response.ok) {
    throw await parseError(response, `Failed to fetch thread: ${response.status}`);
  }

  const data = (await response.json()) as ThreadResponse;
  const parents: Post[] = [];

  let current = data.thread?.parent;
  while (current?.post) {
    parents.unshift(current.post);
    current = current.parent;
  }

  return parents;
}
