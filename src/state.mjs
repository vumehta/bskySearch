import { INITIAL_RENDER_LIMIT } from './constants.mjs';

export const didCache = new Map();
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
  hideOffTopic: false,
  showOffTopic: false,
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
