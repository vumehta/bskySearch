const BSKY_SERVICE = 'https://bsky.social/xrpc';

const BSKY_HANDLE = process.env.BSKY_HANDLE;
const BSKY_APP_PASSWORD = process.env.BSKY_APP_PASSWORD;

// Upstream fetch timeout — fits within Vercel Hobby 10s limit with 2s headroom
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

async function createSession() {
  const response = await fetchWithTimeout(`${BSKY_SERVICE}/com.atproto.server.createSession`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      identifier: BSKY_HANDLE,
      password: BSKY_APP_PASSWORD,
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

async function ensureSession() {
  if (cachedSession && !isSessionExpired()) {
    return cachedSession;
  }

  if (!sessionPromise) {
    sessionPromise = createSession()
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

async function refreshOrCreateSession() {
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

    if (!BSKY_HANDLE || !BSKY_APP_PASSWORD) {
      throw new Error('Cannot create session: missing credentials');
    }

    const created = await createSession();
    cachedSession = created;
    sessionCreatedAt = Date.now();
    return created;
  })().finally(() => {
    sessionPromise = null;
  });

  return sessionPromise;
}

// Generate cache key for search results
function getSearchCacheKey(term, cursor, sort) {
  return JSON.stringify([term, cursor || '', sort]);
}

// Get cached search result if valid
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

// Clean up expired cache entries periodically
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

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  if (!BSKY_HANDLE || !BSKY_APP_PASSWORD) {
    return res.status(500).json({
      error: 'Server missing BSKY_HANDLE or BSKY_APP_PASSWORD.',
    });
  }

  const term = stripControlChars(getQueryString(req.query.term)).trim();
  const cursor = stripControlChars(getQueryString(req.query.cursor));
  const sort = stripControlChars(getQueryString(req.query.sort)).trim().toLowerCase();

  if (!term) {
    return res.status(400).json({ error: 'Missing term parameter.' });
  }

  if (term.length > 500) {
    return res.status(400).json({ error: 'Search term is too long.' });
  }

  if (cursor && cursor.length > 1000) {
    return res.status(400).json({ error: 'Cursor is too long.' });
  }

  if (sort && !['top', 'latest'].includes(sort)) {
    return res.status(400).json({ error: 'Invalid sort parameter.' });
  }

  const sortValue = sort || 'top';
  const cacheKey = getSearchCacheKey(term, cursor, sortValue);

  // Check server-side cache first
  const cachedResult = getCachedSearchResult(cacheKey);
  if (cachedResult) {
    return res.status(200).json(cachedResult);
  }

  // Periodically clean up expired cache entries
  const now = Date.now();
  if (
    searchResultsCache.size > 100 ||
    now - lastSearchCacheCleanupAt > SEARCH_CACHE_CLEANUP_INTERVAL_MS
  ) {
    cleanupSearchCache();
    lastSearchCacheCleanupAt = now;
  }

  try {
    let session = await ensureSession();
    let response = await searchPosts(term, cursor, session.accessJwt, sortValue);

    if (response.status === 401) {
      session = await refreshOrCreateSession();
      response = await searchPosts(term, cursor, session.accessJwt, sortValue);
    }

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const message = payload?.message || payload?.error || `Search failed: ${response.status}`;
      return res.status(response.status).json({ error: message });
    }

    // Cache the successful result
    searchResultsCache.set(cacheKey, { data: payload, timestamp: Date.now() });
    enforceSearchCacheLimit();

    return res.status(200).json(payload);
  } catch (error) {
    console.error('Search proxy error:', error.message || 'Unknown error');
    if (isUpstreamTimeoutError(error)) {
      return res.status(504).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Search proxy failed.' });
  }
};

// Test utilities export (must be after module.exports assignment)
// Only exposed for test consumption; gated to avoid leaking internals in production.
if (process.env.NODE_ENV === 'test') {
  module.exports.testUtils = {
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
  };
}
