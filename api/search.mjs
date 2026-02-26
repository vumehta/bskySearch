const BSKY_SERVICE = 'https://bsky.social/xrpc';

// Upstream fetch timeout (8s) keeps tail latency bounded and maps to 504.
const UPSTREAM_TIMEOUT_MS = 8000;
const UPSTREAM_TIMEOUT_ERROR_CODE = 'UPSTREAM_TIMEOUT';

function createUpstreamTimeoutError() {
  const error = new Error('Upstream request timed out.');
  error.code = UPSTREAM_TIMEOUT_ERROR_CODE;
  return error;
}

function isUpstreamTimeoutError(error) {
  return Boolean(error && error.code === UPSTREAM_TIMEOUT_ERROR_CODE);
}

function mergeAbortSignals(primarySignal, secondarySignal) {
  if (!primarySignal) return secondarySignal;
  if (!secondarySignal) return primarySignal;

  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([primarySignal, secondarySignal]);
  }

  const mergedController = new AbortController();
  const abortMerged = () => mergedController.abort();
  primarySignal.addEventListener('abort', abortMerged, { once: true });
  secondarySignal.addEventListener('abort', abortMerged, { once: true });
  if (primarySignal.aborted || secondarySignal.aborted) {
    mergedController.abort();
  }

  return mergedController.signal;
}

async function fetchWithTimeout(url, options, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const fetchOptions = { ...(options || {}) };
  fetchOptions.signal = mergeAbortSignals(fetchOptions.signal, timeoutController.signal);

  try {
    return await fetch(url, fetchOptions);
  } catch (error) {
    if (error?.name === 'AbortError' && timeoutController.signal.aborted) {
      throw createUpstreamTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Session cache with TTL (2 hours, refresh tokens last longer)
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
let cachedSession = null;
let sessionCreatedAt = null;
let sessionPromise = null;

// Search results cache with 30s TTL and size cap
const SEARCH_CACHE_TTL_MS = 30000;
const SEARCH_CACHE_CLEANUP_INTERVAL_MS = 5000;
const MAX_SEARCH_CACHE_SIZE = 500;
const searchResultsCache = new Map();
let lastSearchCacheCleanupAt = 0;

function getRuntimeEnv(context) {
  if (context && typeof context === 'object' && 'env' in context) {
    return context.env || {};
  }
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

function getRuntimeCredentials(context) {
  const env = getRuntimeEnv(context);
  return {
    handle: normalizeHandle(env.BSKY_HANDLE),
    appPassword: normalizeAppPassword(env.BSKY_APP_PASSWORD),
  };
}

function getQueryString(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === 'string' ? value : '';
}

function stripControlChars(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
}

function trimOptionalWrappingQuotes(value) {
  const match = value.match(/^(['"])([\s\S]*)\1$/);
  return match ? match[2] : value;
}

function normalizeCredentialValue(rawValue) {
  if (typeof rawValue !== 'string') return '';
  return trimOptionalWrappingQuotes(stripControlChars(rawValue).trim()).trim();
}

function normalizeHandle(rawValue) {
  const normalized = normalizeCredentialValue(rawValue);
  return normalized.startsWith('@') ? normalized.slice(1) : normalized;
}

function normalizeAppPassword(rawValue) {
  return normalizeCredentialValue(rawValue).replace(/\s+/g, '');
}

function jsonNoStore(payload, status = 200, extraHeaders = {}) {
  return Response.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function parseSearchInput(request) {
  const url = new URL(request.url);
  const term = stripControlChars(getQueryString(url.searchParams.get('term'))).trim();
  const cursor = stripControlChars(getQueryString(url.searchParams.get('cursor')));
  const sort = stripControlChars(getQueryString(url.searchParams.get('sort'))).trim().toLowerCase();
  return { term, cursor, sort };
}

async function createSession(handle, appPassword) {
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
    const message = errorData.message || `Create session failed: ${response.status}`;
    throw new Error(message);
  }

  return response.json();
}

async function refreshSession() {
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
    const message = errorData.message || `Refresh session failed: ${response.status}`;
    throw new Error(message);
  }

  return response.json();
}

function isSessionExpired() {
  if (!cachedSession || !sessionCreatedAt) return true;
  return Date.now() - sessionCreatedAt > SESSION_TTL_MS;
}

async function ensureSession(handle, appPassword) {
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

async function refreshOrCreateSession(handle, appPassword) {
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
          refreshError && typeof refreshError.message === 'string'
            ? refreshError.message
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

function getSearchCacheKey(term, cursor, sort) {
  return JSON.stringify([term, cursor || '', sort]);
}

function getCachedSearchResult(cacheKey) {
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

function enforceSearchCacheLimit() {
  while (searchResultsCache.size > MAX_SEARCH_CACHE_SIZE) {
    const oldestKey = searchResultsCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    searchResultsCache.delete(oldestKey);
  }
}

function cleanupSearchCache() {
  const now = Date.now();
  for (const [key, value] of searchResultsCache.entries()) {
    if (now - value.timestamp > SEARCH_CACHE_TTL_MS) {
      searchResultsCache.delete(key);
    }
  }
  enforceSearchCacheLimit();
}

function resetModuleStateForTests() {
  cachedSession = null;
  sessionCreatedAt = null;
  sessionPromise = null;
  searchResultsCache.clear();
  lastSearchCacheCleanupAt = 0;
}

async function searchPosts(term, cursor, accessJwt, sort) {
  const sortValue = sort === 'latest' ? 'latest' : 'top';
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

export async function GET(request, context) {
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

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.message || payload?.error || `Search failed: ${response.status}`;
      return jsonNoStore({ error: message }, response.status);
    }

    searchResultsCache.set(cacheKey, { data: payload, timestamp: Date.now() });
    enforceSearchCacheLimit();
    return jsonNoStore(payload, 200);
  } catch (error) {
    console.error('Search proxy error:', error.message || 'Unknown error');
    if (isUpstreamTimeoutError(error)) {
      return jsonNoStore({ error: error.message }, 504);
    }
    const errorMessage = error && typeof error.message === 'string' ? error.message : 'Unknown error';
    return jsonNoStore({ error: `Search proxy failed: ${errorMessage}` }, 500);
  }
}

// Test utilities for unit/integration coverage.
export const testUtils =
  (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test')
    ? {
        getQueryString,
        stripControlChars,
        trimOptionalWrappingQuotes,
        normalizeCredentialValue,
        normalizeHandle,
        normalizeAppPassword,
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
