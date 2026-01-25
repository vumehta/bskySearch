const BSKY_SERVICE = 'https://bsky.social/xrpc';

const BSKY_HANDLE = process.env.BSKY_HANDLE;
const BSKY_APP_PASSWORD = process.env.BSKY_APP_PASSWORD;

// Session cache with TTL (2 hours, refresh tokens last longer)
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
let cachedSession = null;
let sessionCreatedAt = null;
let sessionPromise = null;

// Search results cache with 30s TTL
const SEARCH_CACHE_TTL_MS = 30000;
const SEARCH_CACHE_CLEANUP_INTERVAL_MS = 5000;
const searchResultsCache = new Map();
let lastSearchCacheCleanupAt = 0;

function getQueryString(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === 'string' ? value : '';
}

async function createSession() {
  const response = await fetch(`${BSKY_SERVICE}/com.atproto.server.createSession`, {
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

  const response = await fetch(`${BSKY_SERVICE}/com.atproto.server.refreshSession`, {
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
      } catch (error) {
        cachedSession = null;
        sessionCreatedAt = null;
      }
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
  return `${term}|${cursor || ''}|${sort}`;
}

// Get cached search result if valid
function getCachedSearchResult(cacheKey) {
  const cached = searchResultsCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > SEARCH_CACHE_TTL_MS) {
    searchResultsCache.delete(cacheKey);
    return null;
  }
  return cached.data;
}

// Clean up expired cache entries periodically
function cleanupSearchCache() {
  const now = Date.now();
  for (const [key, value] of searchResultsCache.entries()) {
    if (now - value.timestamp > SEARCH_CACHE_TTL_MS) {
      searchResultsCache.delete(key);
    }
  }
}

async function searchPosts(term, cursor, accessJwt, sort) {
  const sortValue = sort === 'latest' ? 'latest' : 'top';
  const params = new URLSearchParams({
    q: term,
    sort: sortValue,
    limit: '100',
    lang: 'en',
  });

  if (cursor) {
    params.set('cursor', cursor);
  }

  return fetch(`${BSKY_SERVICE}/app.bsky.feed.searchPosts?${params}`, {
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

  const term = getQueryString(req.query.term).trim();
  const cursor = getQueryString(req.query.cursor);
  const sort = getQueryString(req.query.sort).trim().toLowerCase();

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

    return res.status(200).json(payload);
  } catch (error) {
    console.error('Search proxy error:', error);
    return res.status(500).json({ error: 'Search proxy failed.' });
  }
};
