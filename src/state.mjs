import { INITIAL_RENDER_LIMIT } from './constants.mjs';

// DID cache to avoid duplicate lookups: key -> { did, timestamp }
export const didCache = new Map();
// Search results cache: key -> { data, timestamp }
export const searchCache = new Map();

export const state = {
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
