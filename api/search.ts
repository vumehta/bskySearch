// All types are defined locally to keep the API route self-contained
// (Vercel compiles API routes independently from the frontend bundle).

type SortMode = 'top' | 'latest';

interface BskySession {
  accessJwt: string;
  refreshJwt: string;
  did?: string;
  handle?: string;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

interface UpstreamTimeoutError extends Error {
  code: string;
}

interface SearchPayload {
  posts?: unknown[];
  cursor?: string;
  message?: string;
  error?: string;
  [key: string]: unknown;
}

interface RuntimeContext {
  env?: Record<string, string | undefined>;
}

interface TestUtils {
  getQueryString: typeof getQueryString;
  stripControlChars: typeof stripControlChars;
  getSearchCacheKey: typeof getSearchCacheKey;
  isSessionExpired: typeof isSessionExpired;
  getCachedSearchResult: typeof getCachedSearchResult;
  cleanupSearchCache: typeof cleanupSearchCache;
  enforceSearchCacheLimit: typeof enforceSearchCacheLimit;
  searchResultsCache: Map<string, CacheEntry<SearchPayload>>;
  SEARCH_CACHE_TTL_MS: number;
  MAX_SEARCH_CACHE_SIZE: number;
  UPSTREAM_TIMEOUT_MS: number;
  UPSTREAM_TIMEOUT_ERROR_CODE: string;
  fetchWithTimeout: typeof fetchWithTimeout;
  isUpstreamTimeoutError: typeof isUpstreamTimeoutError;
  resetModuleStateForTests: typeof resetModuleStateForTests;
}

function normalizeSortValue(raw: string): SortMode {
  return raw === 'latest' ? 'latest' : 'top';
}

const BSKY_SERVICE = 'https://bsky.social/xrpc';

// Upstream fetch timeout (8s) keeps tail latency bounded and maps to 504.
const UPSTREAM_TIMEOUT_MS = 8000;
const UPSTREAM_TIMEOUT_ERROR_CODE = 'UPSTREAM_TIMEOUT';

function createUpstreamTimeoutError(): UpstreamTimeoutError {
  const error = new Error('Upstream request timed out.') as UpstreamTimeoutError;
  error.code = UPSTREAM_TIMEOUT_ERROR_CODE;
  return error;
}

function isUpstreamTimeoutError(error: unknown): error is UpstreamTimeoutError {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as UpstreamTimeoutError).code === UPSTREAM_TIMEOUT_ERROR_CODE);
}

function mergeAbortSignals(primarySignal: AbortSignal | undefined | null, secondarySignal: AbortSignal): AbortSignal {
  if (!primarySignal) return secondarySignal;
  if (!secondarySignal) return primarySignal;

  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([primarySignal, secondarySignal]);
  }

  const mergedController = new AbortController();
  const abortMerged = (): void => mergedController.abort();
  primarySignal.addEventListener('abort', abortMerged, { once: true });
  secondarySignal.addEventListener('abort', abortMerged, { once: true });
  if (primarySignal.aborted || secondarySignal.aborted) {
    mergedController.abort();
  }

  return mergedController.signal;
}

async function fetchWithTimeout(url: string, options?: RequestInit, timeoutMs: number = UPSTREAM_TIMEOUT_MS): Promise<Response> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const fetchOptions: RequestInit = { ...(options || {}) };
  fetchOptions.signal = mergeAbortSignals(fetchOptions.signal, timeoutController.signal);

  try {
    return await fetch(url, fetchOptions);
  } catch (error) {
    if ((error as Error)?.name === 'AbortError' && timeoutController.signal.aborted) {
      throw createUpstreamTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Session cache with TTL (2 hours, refresh tokens last longer)
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
let cachedSession: BskySession | null = null;
let sessionCreatedAt: number | null = null;
let sessionPromise: Promise<BskySession> | null = null;

// Search results cache with 30s TTL and size cap
const SEARCH_CACHE_TTL_MS = 30000;
const SEARCH_CACHE_CLEANUP_INTERVAL_MS = 5000;
const MAX_SEARCH_CACHE_SIZE = 500;
const searchResultsCache = new Map<string, CacheEntry<SearchPayload>>();
let lastSearchCacheCleanupAt = 0;

function getRuntimeEnv(context: RuntimeContext | undefined): Record<string, string | undefined> {
  if (context && typeof context === 'object' && 'env' in context) {
    return context.env || {};
  }
  return process.env as Record<string, string | undefined>;
}

function getRuntimeCredentials(context: RuntimeContext | undefined): { handle: string | undefined; appPassword: string | undefined } {
  const env = getRuntimeEnv(context);
  return {
    handle: env.BSKY_HANDLE,
    appPassword: env.BSKY_APP_PASSWORD,
  };
}

function getQueryString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === 'string' ? value : '';
}

function stripControlChars(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
}

function jsonNoStore(payload: unknown, status: number = 200, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function parseSearchInput(request: Request): { term: string; cursor: string; sort: string } {
  const url = new URL(request.url);
  const term = stripControlChars(getQueryString(url.searchParams.get('term'))).trim();
  const cursor = stripControlChars(getQueryString(url.searchParams.get('cursor')));
  const sort = stripControlChars(getQueryString(url.searchParams.get('sort'))).trim().toLowerCase();
  return { term, cursor, sort };
}

async function createSession(handle: string, appPassword: string): Promise<BskySession> {
  const response = await fetchWithTimeout(`${BSKY_SERVICE}/com.atproto.server.createSession`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      identifier: handle,
      password: appPassword,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const message = (errorData as { message?: string }).message || `Create session failed: ${response.status}`;
    throw new Error(message);
  }

  return response.json();
}

async function refreshSession(): Promise<BskySession> {
  if (!cachedSession?.refreshJwt) {
    throw new Error('Missing refresh token.');
  }

  const response = await fetchWithTimeout(`${BSKY_SERVICE}/com.atproto.server.refreshSession`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cachedSession.refreshJwt}`,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const message = (errorData as { message?: string }).message || `Refresh session failed: ${response.status}`;
    throw new Error(message);
  }

  return response.json();
}

function isSessionExpired(): boolean {
  if (!cachedSession || !sessionCreatedAt) return true;
  return Date.now() - sessionCreatedAt > SESSION_TTL_MS;
}

async function ensureSession(handle: string, appPassword: string): Promise<BskySession> {
  if (cachedSession && !isSessionExpired()) {
    return cachedSession;
  }

  if (!sessionPromise) {
    sessionPromise = createSession(handle, appPassword)
      .then((session) => {
        cachedSession = session;
        sessionCreatedAt = Date.now();
        return session;
      })
      .finally(() => {
        sessionPromise = null;
      });
  }

  return sessionPromise;
}

async function refreshOrCreateSession(handle: string, appPassword: string): Promise<BskySession> {
  if (sessionPromise) {
    return sessionPromise;
  }

  sessionPromise = (async () => {
    if (cachedSession?.refreshJwt) {
      try {
        const refreshed = await refreshSession();
        cachedSession = refreshed;
        sessionCreatedAt = Date.now();
        return refreshed;
      } catch (refreshError) {
        const refreshMessage =
          refreshError && typeof (refreshError as Error).message === 'string'
            ? (refreshError as Error).message
            : 'Unknown refresh error';
        console.error('Session refresh failed:', refreshMessage);
        cachedSession = null;
        sessionCreatedAt = null;
      }
    }

    if (!handle || !appPassword) {
      throw new Error('Cannot create session: missing credentials');
    }

    const created = await createSession(handle, appPassword);
    cachedSession = created;
    sessionCreatedAt = Date.now();
    return created;
  })().finally(() => {
    sessionPromise = null;
  });

  return sessionPromise;
}

function getSearchCacheKey(term: string, cursor: string, sort: string): string {
  return JSON.stringify([term, cursor || '', sort]);
}

function getCachedSearchResult(cacheKey: string): SearchPayload | null {
  const cached = searchResultsCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > SEARCH_CACHE_TTL_MS) {
    searchResultsCache.delete(cacheKey);
    return null;
  }

  // Refresh order for LRU-style eviction without extending TTL.
  searchResultsCache.delete(cacheKey);
  searchResultsCache.set(cacheKey, cached);
  return cached.data;
}

function enforceSearchCacheLimit(): void {
  while (searchResultsCache.size > MAX_SEARCH_CACHE_SIZE) {
    const oldestKey = searchResultsCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    searchResultsCache.delete(oldestKey);
  }
}

function cleanupSearchCache(): void {
  const now = Date.now();
  for (const [key, value] of searchResultsCache.entries()) {
    if (now - value.timestamp > SEARCH_CACHE_TTL_MS) {
      searchResultsCache.delete(key);
    }
  }
  enforceSearchCacheLimit();
}

function resetModuleStateForTests(): void {
  cachedSession = null;
  sessionCreatedAt = null;
  sessionPromise = null;
  searchResultsCache.clear();
  lastSearchCacheCleanupAt = 0;
}

async function searchPosts(term: string, cursor: string, accessJwt: string, sort: string): Promise<Response> {
  const sortValue = normalizeSortValue(sort);
  const params = new URLSearchParams({
    q: term,
    sort: sortValue,
    limit: '100',
    lang: 'en', // Intentionally English-only; do not make configurable
  });

  if (cursor) {
    params.set('cursor', cursor);
  }

  return fetchWithTimeout(`${BSKY_SERVICE}/app.bsky.feed.searchPosts?${params}`, {
    headers: {
      Authorization: `Bearer ${accessJwt}`,
    },
  });
}

export async function GET(request: Request, context?: RuntimeContext): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonNoStore({ error: 'Method not allowed.' }, 405, { Allow: 'GET' });
  }

  const { handle, appPassword } = getRuntimeCredentials(context);
  if (!handle || !appPassword) {
    return jsonNoStore({ error: 'Server missing BSKY_HANDLE or BSKY_APP_PASSWORD.' }, 500);
  }

  const { term, cursor, sort } = parseSearchInput(request);

  if (!term) {
    return jsonNoStore({ error: 'Missing term parameter.' }, 400);
  }

  if (term.length > 500) {
    return jsonNoStore({ error: 'Search term is too long.' }, 400);
  }

  if (cursor && cursor.length > 1000) {
    return jsonNoStore({ error: 'Cursor is too long.' }, 400);
  }

  if (sort && !['top', 'latest'].includes(sort)) {
    return jsonNoStore({ error: 'Invalid sort parameter.' }, 400);
  }

  const sortValue = sort || 'top';
  const cacheKey = getSearchCacheKey(term, cursor, sortValue);
  const cachedResult = getCachedSearchResult(cacheKey);
  if (cachedResult) {
    return jsonNoStore(cachedResult, 200);
  }

  const now = Date.now();
  if (
    searchResultsCache.size > 100 ||
    now - lastSearchCacheCleanupAt > SEARCH_CACHE_CLEANUP_INTERVAL_MS
  ) {
    cleanupSearchCache();
    lastSearchCacheCleanupAt = now;
  }

  try {
    let session = await ensureSession(handle, appPassword);
    let response = await searchPosts(term, cursor, session.accessJwt, sortValue);

    if (response.status === 401) {
      session = await refreshOrCreateSession(handle, appPassword);
      response = await searchPosts(term, cursor, session.accessJwt, sortValue);
    }

    const payload = await response.json().catch(() => null) as SearchPayload | null;
    if (!response.ok) {
      const message = payload?.message || payload?.error || `Search failed: ${response.status}`;
      return jsonNoStore({ error: message }, response.status);
    }

    searchResultsCache.set(cacheKey, { data: payload!, timestamp: Date.now() });
    enforceSearchCacheLimit();
    return jsonNoStore(payload, 200);
  } catch (error) {
    console.error('Search proxy error:', (error as Error).message || 'Unknown error');
    if (isUpstreamTimeoutError(error)) {
      return jsonNoStore({ error: (error as Error).message }, 504);
    }
    return jsonNoStore({ error: 'Search proxy failed.' }, 500);
  }
}

// Test utilities for unit/integration coverage.
export const testUtils: TestUtils | undefined =
  process.env.NODE_ENV === 'test'
    ? {
        getQueryString,
        stripControlChars,
        getSearchCacheKey,
        isSessionExpired,
        getCachedSearchResult,
        cleanupSearchCache,
        enforceSearchCacheLimit,
        searchResultsCache,
        SEARCH_CACHE_TTL_MS,
        MAX_SEARCH_CACHE_SIZE,
        UPSTREAM_TIMEOUT_MS,
        UPSTREAM_TIMEOUT_ERROR_CODE,
        fetchWithTimeout,
        isUpstreamTimeoutError,
        resetModuleStateForTests,
      }
    : undefined;
