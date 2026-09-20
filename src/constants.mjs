export const PUBLIC_API = 'https://public.api.bsky.app/xrpc';
export const SEARCH_API = '/api/search';
// The browser allows transport time beyond the proxy's complete search budget.
export const SEARCH_JOB_TIMEOUT_MS = 20000;
export const SEARCH_REQUEST_TIMEOUT_MS = SEARCH_JOB_TIMEOUT_MS + 2000;
export const INITIAL_RENDER_LIMIT = 200;
export const RENDER_STEP = 100;
export const SEARCH_DEBOUNCE_MS = 300;
export const INITIAL_MAX_PAGES = 2;
export const SEARCH_CONCURRENCY = 4;
export const SEARCH_CACHE_TTL_MS = 30000;
export const DID_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
export const MAX_SEARCH_CACHE_SIZE = 200;
export const MAX_DID_CACHE_SIZE = 500;
export const THEME_STORAGE_KEY = 'bsky-theme';
export const CLASSIFY_API = '/api/classify';
// The API bounds one topic job; the browser allows a little longer for transport.
export const TOPIC_JOB_TIMEOUT_MS = 20000;
export const TOPIC_REQUEST_TIMEOUT_MS = TOPIC_JOB_TIMEOUT_MS + 2000;
export const TOPIC_REQUEST_CONCURRENCY = 2;
// A post is off-topic when every keyword it matched scores below this.
export const TOPIC_SCORE_THRESHOLD = 0.3;
// Scores retained between scoring sessions; active searches keep all their scores.
export const MAX_TOPIC_SCORE_CACHE_SIZE = 5000;
