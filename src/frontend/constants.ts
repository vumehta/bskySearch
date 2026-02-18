import type { QuoteSort, SearchSort } from './types';

export const PUBLIC_API = 'https://public.api.bsky.app/xrpc';
export const SEARCH_API = '/api/search';

export const INITIAL_RENDER_LIMIT = 200;
export const RENDER_STEP = 100;
export const SEARCH_DEBOUNCE_MS = 300;
export const INITIAL_MAX_PAGES = 2;

export const SEARCH_CACHE_TTL_MS = 30_000;
export const DID_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
export const MAX_SEARCH_CACHE_SIZE = 200;
export const MAX_DID_CACHE_SIZE = 500;

export const THEME_STORAGE_KEY = 'bsky-theme';

export const TIME_OPTIONS = ['1', '6', '12', '24', '48', '168'] as const;
export const SEARCH_SORT_OPTIONS: readonly SearchSort[] = ['top', 'latest'];
export const QUOTE_SORT_OPTIONS: readonly QuoteSort[] = ['likes', 'recent', 'oldest'];
