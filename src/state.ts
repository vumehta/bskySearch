import { INITIAL_RENDER_LIMIT } from './constants';
import type { BskyPost, CacheEntry, DidCacheEntry, QuoteSortMode, SortMode } from './types';

export interface AppState {
  allPosts: BskyPost[];
  currentCursors: Record<string, string | null>;
  rawSearchTerms: string[];
  searchTerms: string[];
  searchSort: SortMode;
  minLikes: number;
  timeFilterHours: number;
  searchGeneration: number;
  isLoading: boolean;
  isRefreshing: boolean;
  pendingSearch: boolean;
  renderLimit: number;
  autoRefreshEnabled: boolean;
  refreshIntervalMs: number;
  refreshTimerId: ReturnType<typeof setTimeout> | null;
  refreshCountdownId: ReturnType<typeof setInterval> | null;
  nextRefreshAt: number | null;
  lastRefreshAt: Date | null;
  lastRefreshNewCount: number | null;
  lastRefreshError: string | null;
  pendingPosts: BskyPost[];
  newPostUris: Set<string>;
  clearHighlightsTimeout: ReturnType<typeof setTimeout> | null;
  allQuotes: BskyPost[];
  quoteSort: QuoteSortMode;
  isQuoteLoading: boolean;
  quoteCursor: string | null;
  quoteSeenCursors: Set<string>;
  quoteTotalCount: number | null;
  activeQuoteUri: string | null;
  searchDebounceTimer: ReturnType<typeof setTimeout> | null;
}

// DID cache to avoid duplicate lookups: key -> { did, timestamp }
export const didCache = new Map<string, DidCacheEntry>();
// Search results cache: key -> { data, timestamp }
export const searchCache = new Map<string, CacheEntry<unknown>>();

export const state: AppState = {
  allPosts: [],
  currentCursors: {},
  rawSearchTerms: [],
  searchTerms: [],
  searchSort: 'top',
  minLikes: 10,
  timeFilterHours: 24,
  searchGeneration: 0,
  isLoading: false,
  isRefreshing: false,
  pendingSearch: false,
  renderLimit: INITIAL_RENDER_LIMIT,
  autoRefreshEnabled: false,
  refreshIntervalMs: 5 * 60 * 1000,
  refreshTimerId: null,
  refreshCountdownId: null,
  nextRefreshAt: null,
  lastRefreshAt: null,
  lastRefreshNewCount: null,
  lastRefreshError: null,
  pendingPosts: [],
  newPostUris: new Set(),
  clearHighlightsTimeout: null,
  allQuotes: [],
  quoteSort: 'likes',
  isQuoteLoading: false,
  quoteCursor: null,
  quoteSeenCursors: new Set(),
  quoteTotalCount: null,
  activeQuoteUri: null,
  searchDebounceTimer: null,
};

export function isCurrentSearchGeneration(generation: number): boolean {
  return state.searchGeneration === generation;
}
