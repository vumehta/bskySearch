import { INITIAL_RENDER_LIMIT } from './constants.mjs';

// DID cache to avoid duplicate lookups: key -> { did, timestamp }
export const didCache = new Map();
// Search results cache: key -> { data, timestamp }
export const searchCache = new Map();

// --- State slices ---
// Grouped by concern for maintainability. Each slice owns related properties.

const searchState = {
  allPosts: [],
  currentCursors: {},
  rawSearchTerms: [],
  searchTerms: [],
  searchSort: 'top',
  minLikes: 10,
  timeFilterHours: 24,
  searchGeneration: 0,
  isLoading: false,
  pendingSearch: false,
  renderLimit: INITIAL_RENDER_LIMIT,
  searchDebounceTimer: null,
};

const refreshState = {
  autoRefreshEnabled: false,
  isRefreshing: false,
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
};

const quoteState = {
  allQuotes: [],
  quoteSort: 'likes',
  isQuoteLoading: false,
  quoteCursor: null,
  quoteSeenCursors: new Set(),
  quoteTotalCount: null,
  activeQuoteUri: null,
};

// Unified state object — provides a single access point while keeping
// the conceptual grouping above for documentation.
export const state = Object.assign({}, searchState, refreshState, quoteState);

export function isCurrentSearchGeneration(generation) {
  return state.searchGeneration === generation;
}
