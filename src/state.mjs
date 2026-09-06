import { INITIAL_RENDER_LIMIT } from './constants.mjs';

// DID cache to avoid duplicate lookups: key -> { did, timestamp }
export const didCache = new Map();
// Search results cache: key -> { data, timestamp }
export const searchCache = new Map();

export const state = {
  allPosts: [],
  currentCursors: Object.create(null),
  rawSearchTerms: [],
  searchTerms: [],
  searchSort: 'top',
  minLikes: 10,
  timeFilterHours: 24,
  searchSince: null,
  searchGeneration: 0,
  isLoading: false,
  renderLimit: INITIAL_RENDER_LIMIT,
  allQuotes: [],
  quoteSort: 'likes',
  isQuoteLoading: false,
  quoteCursor: null,
  quoteSeenCursors: new Set(),
  quoteTotalCount: null,
  activeQuoteUri: null,
  searchDebounceTimer: null,
};

export function isCurrentSearchGeneration(generation) {
  return state.searchGeneration === generation;
}
