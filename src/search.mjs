import {
  INITIAL_MAX_PAGES,
  RENDER_STEP,
  SEARCH_API,
  SEARCH_DEBOUNCE_MS,
} from './constants.mjs';
import { isCurrentSearchGeneration, searchCache, state } from './state.mjs';
import {
  autoRefreshToggle,
  expandSummary,
  expandTermsToggle,
  minLikesInput,
  refreshIntervalSelect,
  refreshLastDiv,
  refreshNextDiv,
  refreshStateDiv,
  resultsDiv,
  searchBtn,
  sortSelect,
  termsInput,
  timeFilterSelect,
} from './dom.mjs';
import {
  deduplicatePosts,
  expandSearchTerms,
  filterByDate,
  filterByLikes,
  formatDuration,
  formatTime,
  getSearchCacheKey,
  normalizeTerm,
  sortPosts,
} from './utils.mjs';
import { enforceSearchCacheLimit, getCachedSearch } from './cache.mjs';
import { setQueryParam, updateURLWithParams } from './url.mjs';
import {
  clearNewPostHighlightsFromDOM,
  hideStatus,
  renderNewPosts,
  renderResults,
  resetRenderLimit,
  scheduleRender,
  showStatus,
} from './search-render.mjs';

function getRenderHandlers() {
  return {
    onLoadMore: loadMore,
    onMergePending: mergePendingPosts,
    onDismissPending: dismissPendingPosts,
  };
}

function renderAllResults() {
  renderResults(getRenderHandlers());
}

function renderPendingPanel() {
  renderNewPosts(getRenderHandlers());
}

// --- URL & Expansion ---

export function updateSearchURL() {
  const params = new URLSearchParams(window.location.search);
  setQueryParam(params, 'terms', termsInput.value.trim());
  setQueryParam(params, 'minLikes', minLikesInput.value);
  setQueryParam(params, 'time', timeFilterSelect.value !== '24' ? timeFilterSelect.value : '');
  setQueryParam(params, 'sort', state.searchSort !== 'top' ? state.searchSort : '');
  setQueryParam(params, 'expand', expandTermsToggle.checked ? '1' : '');
  updateURLWithParams(params);
}

export function updateExpansionSummary() {
  const inputValue = termsInput.value.trim();
  if (!inputValue) {
    expandSummary.textContent = 'Enter terms to preview expansion.';
    return;
  }

  const rawTerms = inputValue.split(',').map(normalizeTerm).filter(Boolean);
  if (rawTerms.length === 0) {
    expandSummary.textContent = 'Enter terms to preview expansion.';
    return;
  }

  if (!expandTermsToggle.checked) {
    expandSummary.textContent = `Expansion is off. Searching only: ${rawTerms.join(', ')}`;
    return;
  }

  const expanded = expandSearchTerms(rawTerms, true);
  const rawSet = new Set(rawTerms.map((term) => term.toLowerCase()));
  const extras = expanded.filter((term) => !rawSet.has(term.toLowerCase()));

  if (extras.length === 0) {
    expandSummary.textContent = `No multi-word phrases detected. Searching: ${rawTerms.join(', ')}`;
    return;
  }

  expandSummary.textContent = `Typed: ${rawTerms.join(', ')}. Expanded: ${expanded.join(', ')}`;
}

// --- API / Fetching ---

async function searchTerm(term, cursor = null, sort = state.searchSort) {
  const sortValue = sort === 'latest' ? 'latest' : 'top';
  const cacheKey = getSearchCacheKey(term, cursor, sortValue);

  const cached = getCachedSearch(cacheKey);
  if (cached) {
    return cached;
  }

  const params = new URLSearchParams({ term, sort: sortValue });
  if (cursor) {
    params.set('cursor', cursor);
  }

  const response = await fetch(`${SEARCH_API}?${params}`);

  if (!response.ok) {
    let errorMsg = `Search failed for "${term}": ${response.status}`;
    try {
      const errorData = await response.json();
      if (errorData.message) errorMsg += ` - ${errorData.message}`;
      if (errorData.error) errorMsg += ` - ${errorData.error}`;
    } catch (e) {}
    throw new Error(errorMsg);
  }

  const data = await response.json();

  searchCache.set(cacheKey, { data, timestamp: Date.now() });
  enforceSearchCacheLimit();

  return data;
}

async function fetchAllPostsForTerm(term, maxPages = INITIAL_MAX_PAGES, sort = state.searchSort) {
  let allTermPosts = [];
  let cursor = null;
  let pages = 0;

  while (pages < maxPages) {
    const data = await searchTerm(term, cursor, sort);

    if (data.posts && data.posts.length > 0) {
      const taggedPosts = data.posts.map((post) => ({
        ...post,
        matchedTerm: term,
      }));
      allTermPosts = allTermPosts.concat(taggedPosts);
    }

    if (!data.cursor) break;
    cursor = data.cursor;
    pages += 1;
  }

  state.currentCursors[term] = cursor;
  return allTermPosts;
}

async function fetchLatestPostsForTerm(term, sort = state.searchSort) {
  const data = await searchTerm(term, null, sort);
  if (data.posts && data.posts.length > 0) {
    return data.posts.map((post) => ({
      ...post,
      matchedTerm: term,
    }));
  }
  return [];
}

// --- Post pipeline helper ---

function applyPostPipeline(posts) {
  let result = deduplicatePosts(posts);
  result = filterByDate(result, state.timeFilterHours);
  result = filterByLikes(result, state.minLikes);
  return sortPosts(result, state.searchSort);
}

// --- Auto-refresh ---

function clearRefreshTimers() {
  if (state.refreshTimerId) {
    clearTimeout(state.refreshTimerId);
    state.refreshTimerId = null;
  }
  if (state.refreshCountdownId) {
    clearInterval(state.refreshCountdownId);
    state.refreshCountdownId = null;
  }
}

export function updateRefreshInterval() {
  const minutes = parseInt(refreshIntervalSelect.value, 10);
  state.refreshIntervalMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60000 : 5 * 60000;
}

export function updateRefreshMeta() {
  if (state.autoRefreshEnabled) {
    refreshStateDiv.textContent = state.isRefreshing ? 'Refreshing…' : 'Auto-refresh on';
  } else {
    refreshStateDiv.textContent = 'Auto-refresh off';
  }

  if (state.lastRefreshError) {
    refreshLastDiv.textContent = `Last update failed: ${state.lastRefreshError}`;
  } else if (state.lastRefreshAt) {
    const suffix = Number.isFinite(state.lastRefreshNewCount)
      ? ` (+${state.lastRefreshNewCount} new)`
      : '';
    refreshLastDiv.textContent = `Last updated: ${formatTime(state.lastRefreshAt)}${suffix}`;
  } else {
    refreshLastDiv.textContent = 'Last updated: --';
  }

  if (state.autoRefreshEnabled && state.nextRefreshAt) {
    refreshNextDiv.textContent = `Next refresh in ${formatDuration(state.nextRefreshAt - Date.now())}`;
  } else {
    refreshNextDiv.textContent = '';
  }
}

export function scheduleNextRefresh() {
  clearRefreshTimers();
  if (!state.autoRefreshEnabled) {
    state.nextRefreshAt = null;
    updateRefreshMeta();
    return;
  }
  state.nextRefreshAt = Date.now() + state.refreshIntervalMs;
  state.refreshTimerId = setTimeout(runAutoRefresh, state.refreshIntervalMs);
  state.refreshCountdownId = setInterval(updateRefreshMeta, 1000);
  updateRefreshMeta();
}

function clearNewPostHighlights() {
  state.newPostUris.clear();
  if (state.clearHighlightsTimeout) {
    clearTimeout(state.clearHighlightsTimeout);
    state.clearHighlightsTimeout = null;
  }
}

function scheduleNewPostHighlightClear() {
  if (state.clearHighlightsTimeout) {
    clearTimeout(state.clearHighlightsTimeout);
  }
  state.clearHighlightsTimeout = setTimeout(() => {
    state.newPostUris.clear();
    state.clearHighlightsTimeout = null;
    // Remove highlight class directly — avoids full DOM rebuild
    clearNewPostHighlightsFromDOM();
  }, 8000);
}

function mergePendingPosts() {
  if (state.pendingPosts.length === 0) {
    return;
  }

  state.allPosts = applyPostPipeline([...state.pendingPosts, ...state.allPosts]);

  clearNewPostHighlights();
  state.newPostUris = new Set(state.pendingPosts.map((post) => post.uri));
  scheduleNewPostHighlightClear();
  state.pendingPosts = [];
  renderPendingPanel();
  renderAllResults();
}

function dismissPendingPosts() {
  if (state.pendingPosts.length === 0) {
    return;
  }
  state.pendingPosts = [];
  clearNewPostHighlights();
  renderPendingPanel();
  renderAllResults();
}

async function refreshSearch() {
  if (state.searchTerms.length === 0) {
    return 0;
  }

  state.allPosts = applyPostPipeline(state.allPosts);
  state.pendingPosts = filterByDate(state.pendingPosts, state.timeFilterHours);
  state.pendingPosts = filterByLikes(state.pendingPosts, state.minLikes);

  const existingUris = new Set([...state.allPosts, ...state.pendingPosts].map((post) => post.uri));
  const results = await Promise.all(
    state.searchTerms.map((term) => fetchLatestPostsForTerm(term, state.searchSort))
  );
  let latestPosts = applyPostPipeline(results.flat());

  const newPosts = latestPosts.filter((post) => !existingUris.has(post.uri));

  if (newPosts.length > 0) {
    state.pendingPosts = deduplicatePosts([...state.pendingPosts, ...newPosts]);
  }

  clearNewPostHighlights();
  if (newPosts.length > 0) {
    state.newPostUris = new Set(newPosts.map((post) => post.uri));
    scheduleNewPostHighlightClear();
  }

  renderPendingPanel();
  renderAllResults();
  return newPosts.length;
}

async function runAutoRefresh() {
  if (!state.autoRefreshEnabled) {
    return;
  }
  if (state.isLoading || state.isRefreshing) {
    scheduleNextRefresh();
    return;
  }
  if (state.searchTerms.length === 0) {
    state.autoRefreshEnabled = false;
    autoRefreshToggle.checked = false;
    state.nextRefreshAt = null;
    state.lastRefreshError = 'Run a search first.';
    updateRefreshMeta();
    clearRefreshTimers();
    return;
  }

  state.isRefreshing = true;
  state.lastRefreshError = null;
  state.lastRefreshNewCount = null;
  updateRefreshMeta();

  try {
    const newCount = await refreshSearch();
    state.lastRefreshAt = new Date();
    state.lastRefreshNewCount = newCount;
  } catch (error) {
    console.error('Auto-refresh error:', error);
    state.lastRefreshError = error.message || 'Refresh failed.';
  } finally {
    state.isRefreshing = false;
    scheduleNextRefresh();
  }
}

export function enableAutoRefresh() {
  if (state.searchTerms.length === 0) {
    autoRefreshToggle.checked = false;
    state.lastRefreshError = 'Run a search first.';
    updateRefreshMeta();
    return;
  }
  state.autoRefreshEnabled = true;
  state.lastRefreshError = null;
  updateRefreshInterval();
  scheduleNextRefresh();
}

export function disableAutoRefresh() {
  state.autoRefreshEnabled = false;
  clearRefreshTimers();
  state.nextRefreshAt = null;
  updateRefreshMeta();
}

// --- Core search ---

export async function performSearch() {
  if (state.isLoading) {
    state.pendingSearch = true;
    return;
  }
  state.pendingSearch = false;
  state.searchGeneration++;
  const currentGeneration = state.searchGeneration;
  const termsValue = termsInput.value.trim();
  if (!termsValue) {
    showStatus('Please enter at least one search term.', 'error');
    return;
  }

  state.rawSearchTerms = termsValue.split(',').map(normalizeTerm).filter((t) => t.length > 0);
  state.searchTerms = expandSearchTerms(state.rawSearchTerms, expandTermsToggle.checked);
  state.minLikes = parseInt(minLikesInput.value) || 0;
  state.timeFilterHours = parseInt(timeFilterSelect.value) || 24;
  state.searchSort = sortSelect.value === 'latest' ? 'latest' : 'top';

  if (state.rawSearchTerms.length === 0) {
    showStatus('Please enter at least one search term.', 'error');
    return;
  }

  state.isLoading = true;
  searchBtn.disabled = true;
  let searchCompleted = false;
  state.allPosts = [];
  state.currentCursors = {};
  resultsDiv.textContent = '';
  clearNewPostHighlights();
  state.pendingPosts = [];
  renderPendingPanel();
  resetRenderLimit();

  updateSearchURL();

  try {
    showStatus(`Searching for: ${state.rawSearchTerms.join(', ')}…`, 'loading');

    let completedTerms = 0;
    const totalTerms = state.searchTerms.length;

    const promises = state.searchTerms.map(async (term) => {
      const posts = await fetchAllPostsForTerm(term, INITIAL_MAX_PAGES, state.searchSort);

      if (!isCurrentSearchGeneration(currentGeneration)) return posts;

      completedTerms++;
      state.allPosts = applyPostPipeline([...state.allPosts, ...posts]);

      if (completedTerms < totalTerms) {
        showStatus(`Loaded ${completedTerms}/${totalTerms} terms…`, 'loading');
      }
      scheduleRender(getRenderHandlers());

      return posts;
    });

    const results = await Promise.allSettled(promises);

    if (!isCurrentSearchGeneration(currentGeneration)) return;

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      const errorMsg =
        failures.length === totalTerms
          ? `Search failed: ${failures[0].reason.message}`
          : `${failures.length}/${totalTerms} terms failed to load`;
      showStatus(errorMsg, 'error');
    } else {
      hideStatus();
    }

    renderAllResults();
    state.lastRefreshAt = new Date();
    state.lastRefreshNewCount = null;
    state.lastRefreshError = null;
    searchCompleted = true;
    updateRefreshMeta();
  } catch (error) {
    console.error('Search error:', error);
    showStatus(`Error: ${error.message}`, 'error');
  } finally {
    state.isLoading = false;
    searchBtn.disabled = false;
    if (state.autoRefreshEnabled && searchCompleted) {
      scheduleNextRefresh();
    }
    if (state.pendingSearch) {
      state.pendingSearch = false;
      performSearch();
    }
  }
}

export async function loadMore() {
  if (state.isLoading) return;

  const prevCount = state.allPosts.length;
  state.isLoading = true;
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = 'Loading…';
  }

  try {
    const promises = state.searchTerms
      .filter((term) => state.currentCursors[term])
      .map(async (term) => {
        const data = await searchTerm(term, state.currentCursors[term], state.searchSort);
        state.currentCursors[term] = data.cursor || null;

        if (data.posts && data.posts.length > 0) {
          return data.posts.map((post) => ({
            ...post,
            matchedTerm: term,
          }));
        }
        return [];
      });

    const settled = await Promise.allSettled(promises);

    const failures = settled.filter((r) => r.status === 'rejected');
    const newPosts = settled
      .filter((r) => r.status === 'fulfilled')
      .flatMap((r) => r.value);

    if (newPosts.length > 0) {
      state.allPosts = applyPostPipeline([...state.allPosts, ...newPosts]);
      if (state.allPosts.length > prevCount) {
        state.renderLimit = Math.min(state.allPosts.length, state.renderLimit + RENDER_STEP);
      }
      renderAllResults();
    } else {
      if (loadMoreBtn) {
        loadMoreBtn.remove();
      }
    }

    if (failures.length > 0) {
      showStatus(`${failures.length} term(s) failed to load more`, 'error');
    }
  } catch (error) {
    console.error('Load more error:', error);
    showStatus(`Error loading more: ${error.message}`, 'error');
  } finally {
    state.isLoading = false;
  }
}

// --- Debounce & UI ---

export function debouncedSearch() {
  if (state.searchDebounceTimer) {
    clearTimeout(state.searchDebounceTimer);
  }
  state.searchDebounceTimer = setTimeout(() => {
    state.searchDebounceTimer = null;
    performSearch();
  }, SEARCH_DEBOUNCE_MS);
}

export function cancelDebouncedSearch() {
  if (state.searchDebounceTimer) {
    clearTimeout(state.searchDebounceTimer);
    state.searchDebounceTimer = null;
  }
}

export function focusSearchInput() {
  if (!termsInput) return;
  if (typeof termsInput.focus === 'function') {
    termsInput.focus();
  }
  if (typeof termsInput.select === 'function') {
    termsInput.select();
  }
}

export function renderSearchResults() {
  renderAllResults();
}

export function renderPendingPosts() {
  renderPendingPanel();
}
