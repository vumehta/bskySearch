import { isDatetimeString } from '@atproto/syntax';
import { isRenderablePost } from '../src/post-data.mjs';
import { SEARCH_JOB_TIMEOUT_MS } from '../src/constants.mjs';

const BSKY_SERVICE = 'https://bsky.social/xrpc';
const APPVIEW_PROXY = 'did:web:api.bsky.app#bsky_appview';

const UPSTREAM_TIMEOUT_MS = 8000;
const UPSTREAM_TIMEOUT_ERROR_CODE = 'UPSTREAM_TIMEOUT';

export const SEARCH_ADMISSION_LIMITS = Object.freeze({
  maxConcurrent: 16,
  burst: 60,
  refillPerSecond: 1,
});

function proxyError(message, status, headers = {}) {
  const error = new Error(message);
  error.status = status;
  error.headers = headers;
  return error;
}

function abortError() {
  return new DOMException('Request cancelled.', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function createUpstreamTimeoutError() {
  const error = new Error('Upstream request timed out.');
  error.code = UPSTREAM_TIMEOUT_ERROR_CODE;
  return error;
}

function isUpstreamTimeoutError(error) {
  return Boolean(error && error.code === UPSTREAM_TIMEOUT_ERROR_CODE);
}

async function fetchWithTimeout(url, { onResponse, ...options } = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  throwIfAborted(options.signal);
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  let rejectOnAbort;
  const aborted = new Promise((_, reject) => {
    rejectOnAbort = () => reject(timedOut ? createUpstreamTimeoutError() : abortError());
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...options, signal: controller.signal });
        try {
          onResponse?.(response);
        } catch (error) {
          void response.body?.cancel().catch(() => {});
          throw error;
        }
        let payload;
        try {
          payload = await response.json();
        } catch {
          throwIfAborted(controller.signal);
          if (response.ok) throw proxyError('Invalid response from Bluesky.', 502);
          payload = null;
        }
        throwIfAborted(controller.signal);
        return { response, payload };
      })(),
      aborted,
    ]);
  } catch (error) {
    if (timedOut) throw createUpstreamTimeoutError();
    throwIfAborted(controller.signal);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectOnAbort);
  }
}

function createSharedOperation(start, onSettled, timeoutMs) {
  const operation = {
    controller: new AbortController(),
    subscribers: 0,
    settled: false,
    promise: null,
  };
  const work = Promise.resolve()
    .then(() => {
      throwIfAborted(operation.controller.signal);
      return start(operation.controller.signal);
    });
  let timer;
  const deadline = timeoutMs === undefined ? null : new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(createUpstreamTimeoutError());
      operation.controller.abort();
    }, timeoutMs);
  });
  operation.promise = (deadline ? Promise.race([work, deadline]) : work)
    .finally(() => {
      clearTimeout(timer);
      operation.settled = true;
      onSettled(operation);
    });
  return operation;
}

function subscribe(operation, signal, { abortWhenIdle = true } = {}) {
  throwIfAborted(signal);
  operation.subscribers += 1;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (complete, value) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      operation.subscribers -= 1;
      if (abortWhenIdle && !operation.settled && operation.subscribers === 0) {
        operation.controller.abort();
      }
      complete(value);
    };
    const onAbort = () => finish(reject, abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

const SESSION_TTL_MS = 120 * 60 * 1000;
let cachedSession = null;
let sessionCreatedAt = null;
let sessionOperation = null;

const AUTH_RETRY_DEFAULT_MS = 60 * 1000;
const AUTH_RETRY_MAX_MS = 24 * 60 * 60 * 1000;
let authBlockedUntil = 0;
let searchBlockedUntil = 0;

const SEARCH_CACHE_TTL_MS = 30000;
const SEARCH_CACHE_CLEANUP_INTERVAL_MS = 5000;
const MAX_SEARCH_CACHE_SIZE = 500;
const searchResultsCache = new Map();
let lastSearchCacheCleanupAt = 0;
const pendingSearches = new Map();
let admissionTokens = SEARCH_ADMISSION_LIMITS.burst;
let admissionUpdatedAt = null;

function getRuntimeEnv(context) {
  if (context && typeof context === 'object' && 'env' in context) {
    return context.env || {};
  }
  return process.env;
}

function stripControlChars(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_PREFIX_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function hasValidCalendarDate(value) {
  const match = ISO_DATE_PREFIX_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;

  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day >= 1 && day <= maxDay;
}

function isValidSince(value) {
  if (!hasValidCalendarDate(value)) return false;
  return ISO_DATE_PATTERN.test(value) || isDatetimeString(value);
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
  const term = stripControlChars(url.searchParams.get('term')).trim();
  const cursor = stripControlChars(url.searchParams.get('cursor'));
  const sort = stripControlChars(url.searchParams.get('sort')).trim().toLowerCase() || 'top';
  const since = stripControlChars(url.searchParams.get('since')).trim();
  return { term, cursor, sort, since };
}

function retryHeaders(response) {
  const retryAfter = response.headers?.get('Retry-After');
  return retryAfter ? { 'Retry-After': retryAfter } : {};
}

function getRetryDelayMs(response) {
  const now = Date.now();
  const retryAfter = response.headers?.get('Retry-After')?.trim() || '';
  const reset = response.headers?.get('RateLimit-Reset')?.trim() || '';
  const resetSeconds = /^\d+$/.test(reset) ? Number(reset) : NaN;
  const delays = [
    /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now,
    resetSeconds > 1e9 ? resetSeconds * 1000 - now : resetSeconds * 1000,
  ];
  const delay = delays.find((ms) => Number.isFinite(ms) && ms > 0) ?? AUTH_RETRY_DEFAULT_MS;
  return Math.min(delay, AUTH_RETRY_MAX_MS);
}

function authRateLimitError(delayMs) {
  return proxyError('Bluesky login is rate limited. Please try again later.', 429, {
    'Retry-After': String(Math.ceil(delayMs / 1000)),
  });
}

function searchRateLimitError(delayMs) {
  return proxyError('Bluesky search is rate limited. Please try again later.', 429, {
    'Retry-After': String(Math.ceil(delayMs / 1000)),
  });
}

function throwIfSearchBlocked() {
  const blockedMs = searchBlockedUntil - Date.now();
  if (blockedMs > 0) throw searchRateLimitError(blockedMs);
}

function checkAuthRateLimit(response) {
  if (response.status === 429) {
    const delay = getRetryDelayMs(response);
    authBlockedUntil = Date.now() + delay;
    throw authRateLimitError(delay);
  }
}

function validateSession({ response, payload }) {
  if (!response.ok) {
    const error = proxyError('Bluesky authentication failed.', 502, retryHeaders(response));
    error.upstreamStatus = response.status;
    throw error;
  }
  if (
    !payload ||
    typeof payload.accessJwt !== 'string' ||
    !payload.accessJwt ||
    typeof payload.refreshJwt !== 'string' ||
    !payload.refreshJwt
  ) {
    throw proxyError('Invalid authentication response from Bluesky.', 502);
  }
  return payload;
}

async function createSession(handle, appPassword, signal) {
  const result = await fetchWithTimeout(`${BSKY_SERVICE}/com.atproto.server.createSession`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      identifier: handle,
      password: appPassword,
    }),
    signal,
    onResponse: checkAuthRateLimit,
  });
  return validateSession(result);
}

async function refreshSession(refreshJwt, signal) {
  const result = await fetchWithTimeout(`${BSKY_SERVICE}/com.atproto.server.refreshSession`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${refreshJwt}`,
    },
    signal,
    onResponse: checkAuthRateLimit,
  });
  return validateSession(result);
}

function isSessionExpired() {
  if (!cachedSession || sessionCreatedAt === null) return true;
  return Date.now() - sessionCreatedAt > SESSION_TTL_MS;
}

async function ensureSession(handle, appPassword, signal, rejectedAccessJwt = null) {
  throwIfAborted(signal);
  if (rejectedAccessJwt && cachedSession?.accessJwt === rejectedAccessJwt) {
    sessionCreatedAt = null;
  }
  if (sessionOperation && !sessionOperation.controller.signal.aborted) {
    return subscribe(sessionOperation, signal, { abortWhenIdle: false });
  }
  if (
    cachedSession &&
    !isSessionExpired() &&
    (!rejectedAccessJwt || cachedSession.accessJwt !== rejectedAccessJwt)
  ) {
    return cachedSession;
  }
  const blockedMs = authBlockedUntil - Date.now();
  if (blockedMs > 0) throw authRateLimitError(blockedMs);

  const previous = cachedSession;
  sessionOperation = createSharedOperation(
    async (sessionSignal) => {
      let session;
      if (previous?.refreshJwt) {
        try {
          session = await refreshSession(previous.refreshJwt, sessionSignal);
        } catch (error) {
          if (![400, 401].includes(error.upstreamStatus)) throw error;
          cachedSession = null;
          sessionCreatedAt = null;
        }
      }
      if (!session) session = await createSession(handle, appPassword, sessionSignal);
      throwIfAborted(sessionSignal);
      cachedSession = session;
      sessionCreatedAt = Date.now();
      return session;
    },
    (operation) => {
      if (sessionOperation === operation) sessionOperation = null;
    },
  );
  return subscribe(sessionOperation, signal, { abortWhenIdle: false });
}

function getSearchCacheKey(term, cursor, sort, since = '') {
  return JSON.stringify([term, cursor || '', sort, since || '']);
}

function getCachedSearchResult(cacheKey) {
  const cached = searchResultsCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > SEARCH_CACHE_TTL_MS) {
    searchResultsCache.delete(cacheKey);
    return null;
  }

  searchResultsCache.delete(cacheKey);
  searchResultsCache.set(cacheKey, cached);
  return cached.data;
}

function enforceSearchCacheLimit() {
  while (searchResultsCache.size > MAX_SEARCH_CACHE_SIZE) {
    searchResultsCache.delete(searchResultsCache.keys().next().value);
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
  for (const operation of pendingSearches.values()) operation.controller.abort();
  sessionOperation?.controller.abort();
  cachedSession = null;
  sessionCreatedAt = null;
  sessionOperation = null;
  authBlockedUntil = 0;
  searchBlockedUntil = 0;
  searchResultsCache.clear();
  pendingSearches.clear();
  lastSearchCacheCleanupAt = 0;
  admissionTokens = SEARCH_ADMISSION_LIMITS.burst;
  admissionUpdatedAt = null;
}

async function searchPosts({ term, cursor, sort, since }, accessJwt, signal) {
  throwIfSearchBlocked();
  const params = new URLSearchParams({
    q: term,
    sort,
    limit: '100',
    lang: 'en',
  });

  if (cursor) {
    params.set('cursor', cursor);
  }

  if (since) {
    params.set('since', since);
  }

  return fetchWithTimeout(`${BSKY_SERVICE}/app.bsky.feed.searchPosts?${params}`, {
    headers: {
      Authorization: `Bearer ${accessJwt}`,
      'atproto-proxy': APPVIEW_PROXY,
    },
    signal,
  });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidSearchResult(payload) {
  return (
    isObject(payload) &&
    Array.isArray(payload.posts) &&
    payload.posts.length <= 100 &&
    payload.posts.every(
      (post) =>
        isRenderablePost(post) &&
        isObject(post.record) &&
        typeof post.record.text === 'string',
    ) &&
    (payload.cursor === undefined || typeof payload.cursor === 'string')
  );
}

function admitSearch() {
  const now = Date.now();
  if (admissionUpdatedAt !== null) {
    admissionTokens = Math.min(
      SEARCH_ADMISSION_LIMITS.burst,
      admissionTokens +
        (Math.max(0, now - admissionUpdatedAt) / 1000) * SEARCH_ADMISSION_LIMITS.refillPerSecond,
    );
  }
  admissionUpdatedAt = Math.max(admissionUpdatedAt ?? now, now);
  if (pendingSearches.size >= SEARCH_ADMISSION_LIMITS.maxConcurrent) {
    throw proxyError('Search is busy. Please try again shortly.', 429, { 'Retry-After': '1' });
  }
  if (admissionTokens < 1) {
    const retryAfter = Math.ceil((1 - admissionTokens) / SEARCH_ADMISSION_LIMITS.refillPerSecond);
    throw proxyError('Too many searches. Please try again shortly.', 429, {
      'Retry-After': String(retryAfter),
    });
  }
  admissionTokens -= 1;
}

async function runSearch(input, handle, appPassword, signal) {
  let session = await ensureSession(handle, appPassword, signal);
  let result = await searchPosts(input, session.accessJwt, signal);
  if (
    result.response.status === 401 ||
    (result.response.status === 400 && ['ExpiredToken', 'InvalidToken'].includes(result.payload?.error))
  ) {
    session = await ensureSession(handle, appPassword, signal, session.accessJwt);
    result = await searchPosts(input, session.accessJwt, signal);
  }
  const { response, payload } = result;
  if (response.status === 429) {
    const now = Date.now();
    searchBlockedUntil = Math.max(searchBlockedUntil, now + getRetryDelayMs(response));
    throw searchRateLimitError(searchBlockedUntil - now);
  }
  if (!response.ok) {
    const message =
      (typeof payload?.message === 'string' && payload.message) ||
      (typeof payload?.error === 'string' && payload.error) ||
      `Search failed: ${response.status}`;
    throw proxyError(message, response.status, retryHeaders(response));
  }
  if (!isValidSearchResult(payload)) {
    throw proxyError('Invalid search response from Bluesky.', 502);
  }
  throwIfAborted(signal);
  return payload;
}

export async function GET(request, context) {
  if (request.method !== 'GET') {
    return jsonNoStore({ error: 'Method not allowed.' }, 405, { Allow: 'GET' });
  }

  const { BSKY_HANDLE: handle, BSKY_APP_PASSWORD: appPassword } = getRuntimeEnv(context);
  if (!handle || !appPassword) {
    return jsonNoStore({ error: 'Server missing BSKY_HANDLE or BSKY_APP_PASSWORD.' }, 500);
  }

  const input = parseSearchInput(request);
  const { term, cursor, sort, since } = input;

  if (!term) {
    return jsonNoStore({ error: 'Missing term parameter.' }, 400);
  }

  if (term.length > 500) {
    return jsonNoStore({ error: 'Search term is too long.' }, 400);
  }

  if (cursor && cursor.length > 1000) {
    return jsonNoStore({ error: 'Cursor is too long.' }, 400);
  }

  if (!['top', 'latest'].includes(sort)) {
    return jsonNoStore({ error: 'Invalid sort parameter.' }, 400);
  }

  if (since && !isValidSince(since)) {
    return jsonNoStore({ error: 'Invalid since parameter.' }, 400);
  }

  if (request.signal.aborted) {
    return jsonNoStore({ error: 'Request cancelled.' }, 499);
  }

  const cacheKey = getSearchCacheKey(term, cursor, sort, since);
  const cachedResult = getCachedSearchResult(cacheKey);
  if (cachedResult) {
    return jsonNoStore(cachedResult, 200);
  }

  const now = Date.now();
  if (now - lastSearchCacheCleanupAt > SEARCH_CACHE_CLEANUP_INTERVAL_MS) {
    cleanupSearchCache();
    lastSearchCacheCleanupAt = now;
  }

  try {
    let operation = pendingSearches.get(cacheKey);
    if (operation?.controller.signal.aborted) {
      pendingSearches.delete(cacheKey);
      operation = null;
    }
    if (!operation) {
      throwIfSearchBlocked();
      admitSearch();
      operation = createSharedOperation(
        async (signal) => {
          const payload = await runSearch(input, handle, appPassword, signal);
          throwIfAborted(signal);
          searchResultsCache.set(cacheKey, { data: payload, timestamp: Date.now() });
          enforceSearchCacheLimit();
          return payload;
        },
        (completed) => {
          if (pendingSearches.get(cacheKey) === completed) pendingSearches.delete(cacheKey);
        },
        SEARCH_JOB_TIMEOUT_MS,
      );
      pendingSearches.set(cacheKey, operation);
    }
    const payload = await subscribe(operation, request.signal);
    return jsonNoStore(payload, 200);
  } catch (error) {
    if (error?.name === 'AbortError') {
      return jsonNoStore({ error: 'Request cancelled.' }, 499);
    }
    if (isUpstreamTimeoutError(error)) {
      return jsonNoStore({ error: error.message }, 504);
    }
    if (error?.status >= 400 && error.status <= 599) {
      return jsonNoStore({ error: error.message }, error.status, error.headers);
    }
    if (error instanceof TypeError) {
      return jsonNoStore({ error: 'Could not reach Bluesky.' }, 502);
    }
    console.error('Search proxy error:', error?.message || 'Unknown error');
    return jsonNoStore({ error: 'Search proxy failed.' }, 500);
  }
}

export const testUtils =
  process.env.NODE_ENV === 'test'
    ? {
        isValidSince,
        getCachedSearchResult,
        cleanupSearchCache,
        enforceSearchCacheLimit,
        searchResultsCache,
        SEARCH_CACHE_TTL_MS,
        MAX_SEARCH_CACHE_SIZE,
        UPSTREAM_TIMEOUT_MS,
        SESSION_TTL_MS,
        AUTH_RETRY_DEFAULT_MS,
        AUTH_RETRY_MAX_MS,
        resetModuleStateForTests,
      }
    : undefined;
