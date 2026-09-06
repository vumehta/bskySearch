import {
  INITIAL_MAX_PAGES,
  INITIAL_RENDER_LIMIT,
  RENDER_STEP,
  SEARCH_API,
  SEARCH_DEBOUNCE_MS,
  SEARCH_CONCURRENCY,
} from './constants.mjs';
import { isCurrentSearchGeneration, searchCache, state } from './state.mjs';
import {
  expandSummary,
  expandTermsToggle,
  minLikesInput,
  resultsDiv,
  searchBtn,
  sortSelect,
  statusDiv,
  termsInput,
  timeFilterSelect,
} from './dom.mjs';
import {
  expandSearchTerms,
  filterByDate,
  filterByLikes,
  formatRelativeTime,
  getPostUrl,
  getSearchCacheKey,
  getSearchSince,
  isValidBskyUrl,
  normalizeSortValue,
  normalizeTerm,
  sortPosts,
} from './utils.mjs';
import { appendEngagementStats, SEARCH_STAT_CLASSES } from './post-stats.mjs';
import { enforceSearchCacheLimit, getCachedSearch } from './cache.mjs';
import { fetchJson } from './http.mjs';
import { createHighlightMatcher, getMatchedTermsForPost, getPostRenderFingerprint, ingestSearchPosts, nextSearchCursor, settleWithConcurrency, validateSearchPage } from './search-model.mjs';
import { setQueryParam, updateURLWithParams } from './url.mjs';
import { cancelThreadRequest, cancelThreadRequests, initializeThreadToggle, isReplyPost, toggleThread } from './thread.mjs';

const DERIVE_THROTTLE_MS = 120;

const ingestedPostsByUri = new Map();
let activeSearchController = null;
const searchSeenCursors = new Map();
let deriveTimerId = null;

let pendingRenderFrame = null;

let resultsHeaderEl = null;
let resultsCountEl = null;
let resultsSortEl = null;
let resultsEmptyEl = null;
let resultsEmptyPrimaryEl = null;
let resultsEmptySecondaryEl = null;
let resultsListEl = null;
let showMoreBtnEl = null;
let loadMoreBtnEl = null;
const renderedPosts = new Map();

// Highlight matcher cache for a single active term set.
let highlightMatcherCache = { key: '', regex: null, termSet: null };

function showStatus(message, type) {
  statusDiv.className = `status ${type}`;
  statusDiv.textContent = message;
  statusDiv.style.display = 'block';
}

function hideStatus() {
  statusDiv.style.display = 'none';
}

export function updateSearchURL() {
  const params = new URLSearchParams(window.location.search);
  setQueryParam(params, 'terms', termsInput.value.trim());
  setQueryParam(params, 'minLikes', minLikesInput.value);
  setQueryParam(params, 'time', timeFilterSelect.value !== '24' ? timeFilterSelect.value : '');
  setQueryParam(params, 'searchSort', state.searchSort !== 'top' ? state.searchSort : '');
  setQueryParam(params, 'expand', expandTermsToggle.checked ? '1' : '');
  params.delete('sort');
  updateURLWithParams(params);
}

export function updateExpansionSummary() {
  const rawTerms = termsInput.value.split(',').map(normalizeTerm).filter(Boolean);
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

// Every page belongs to a fixed search generation, sort, and time window.
async function searchTerm(term, cursor, { sort, since, signal }) {
  signal.throwIfAborted();
  const cacheKey = getSearchCacheKey(term, cursor, sort, since);
  const cached = getCachedSearch(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({ term, sort });
  if (cursor) params.set('cursor', cursor);
  if (since) params.set('since', since);
  let data;
  try {
    data = validateSearchPage(await fetchJson(`${SEARCH_API}?${params}`, { signal }));
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(`Search failed for "${term}": ${error.message}`, { cause: error });
  }
  signal.throwIfAborted();
  searchCache.set(cacheKey, { data, timestamp: Date.now() });
  enforceSearchCacheLimit();
  return data;
}

function isActiveSearch(context) {
  return isCurrentSearchGeneration(context.generation) && !context.signal.aborted;
}

// Commit each successful page before requesting the next. A failed page leaves
// its request cursor available for retry, including an initial empty cursor.
async function fetchPagesForTerm(term, maxPages, context) {
  for (let page = 0; page < maxPages && isActiveSearch(context); page += 1) {
    const cursor = state.currentCursors[term];
    if (cursor === null) return;
    const data = await searchTerm(term, cursor, context);
    if (!isActiveSearch(context)) return;
    ingestSearchPosts(ingestedPostsByUri, data.posts.map((post) => ({ ...post, matchedTerm: term, matchedTerms: [term] })));
    const seen = searchSeenCursors.get(term) || new Set();
    const nextCursor = nextSearchCursor(data.cursor, cursor, seen);
    if (nextCursor) seen.add(nextCursor);
    searchSeenCursors.set(term, seen);
    state.currentCursors[term] = nextCursor;
    scheduleDerivedPostsRebuild();
    if (nextCursor === null) return;
  }
}

function cancelActiveSearch() {
  state.searchGeneration += 1;
  activeSearchController?.abort();
  activeSearchController = null;
  state.isLoading = false;
  searchBtn.disabled = false;
  clearDerivedPostsTimer();
  cancelScheduledRender();
}

function createSearchContext() {
  activeSearchController = new AbortController();
  return {
    generation: state.searchGeneration,
    signal: activeSearchController.signal,
    sort: state.searchSort,
    since: state.searchSince,
  };
}

async function runSearchPages(terms, maxPages, context, { loadingMore = false } = {}) {
  const previousCount = state.allPosts.length;
  state.isLoading = true;
  searchBtn.disabled = true;
  syncLoadMoreButton();
  try {
    let completed = 0;
    const results = await settleWithConcurrency(terms, SEARCH_CONCURRENCY, async (term) => {
      try {
        await fetchPagesForTerm(term, maxPages, context);
      } finally {
        completed += 1;
        if (isActiveSearch(context) && completed < terms.length) {
          showStatus(`Loaded ${completed}/${terms.length} terms…`, 'loading');
        }
      }
    }, context.signal);
    if (!isActiveSearch(context)) return;
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) {
      showStatus(`${failures.length}/${terms.length} terms could not finish. ${failures[0].reason.message}. Load more to retry.`, 'error');
    } else {
      hideStatus();
    }
    flushDerivedPostsRebuild();
    if (loadingMore && state.allPosts.length > previousCount) {
      increaseRenderLimit();
    }
    renderResults();
  } catch (error) {
    if (isActiveSearch(context)) showStatus(`Error: ${error.message}`, 'error');
  } finally {
    if (isActiveSearch(context)) {
      activeSearchController = null;
      state.isLoading = false;
      searchBtn.disabled = false;
      syncLoadMoreButton();
    }
  }
}

function increaseRenderLimit() {
  state.renderLimit = Math.min(state.allPosts.length, state.renderLimit + RENDER_STEP);
}

function cancelScheduledRender() {
  if (pendingRenderFrame !== null) {
    cancelAnimationFrame(pendingRenderFrame);
    pendingRenderFrame = null;
  }
}

function scheduleRender() {
  if (pendingRenderFrame !== null) return;
  pendingRenderFrame = requestAnimationFrame(() => {
    pendingRenderFrame = null;
    renderResults();
  });
}

function clearDerivedPostsTimer() {
  if (deriveTimerId) {
    clearTimeout(deriveTimerId);
    deriveTimerId = null;
  }
}

function recomputeDerivedPosts() {
  let derived = Array.from(ingestedPostsByUri.values());
  derived = filterByDate(derived, state.timeFilterHours);
  derived = filterByLikes(derived, state.minLikes);
  state.allPosts = sortPosts(derived, state.searchSort);
}

function scheduleDerivedPostsRebuild() {
  if (deriveTimerId) {
    return;
  }
  deriveTimerId = setTimeout(() => {
    deriveTimerId = null;
    recomputeDerivedPosts();
    scheduleRender();
  }, DERIVE_THROTTLE_MS);
}

function flushDerivedPostsRebuild() {
  clearDerivedPostsTimer();
  recomputeDerivedPosts();
}

function getHighlightMatcher(terms) {
  const key = terms.map((term) => term.toLowerCase()).join('\u0001');
  if (key === highlightMatcherCache.key) {
    return highlightMatcherCache;
  }

  highlightMatcherCache = { key, ...createHighlightMatcher(terms) };
  return highlightMatcherCache;
}

function createHighlightedText(text, terms) {
  const fragment = document.createDocumentFragment();
  if (!text) return fragment;

  const { regex, termSet } = getHighlightMatcher(terms);
  if (!regex) {
    fragment.appendChild(document.createTextNode(text));
    return fragment;
  }

  const parts = text.split(regex);

  parts.forEach((part) => {
    if (termSet.has(part.toLowerCase())) {
      const span = document.createElement('span');
      span.className = 'highlight';
      span.textContent = part;
      fragment.appendChild(span);
    } else {
      fragment.appendChild(document.createTextNode(part));
    }
  });

  return fragment;
}

function createPostElement(post) {
  const postUrl = getPostUrl(post);
  const handle = post.author.handle;
  const displayName = post.author.displayName || handle;
  const text = post.record?.text || '';

  const postDiv = document.createElement('div');
  postDiv.className = 'post';

  const termsDiv = document.createElement('div');
  termsDiv.className = 'search-terms';
  const matchedTerms = getMatchedTermsForPost(post);
  matchedTerms.forEach((term) => {
    const tag = document.createElement('span');
    tag.className = 'term-tag';
    tag.textContent = term;
    termsDiv.appendChild(tag);
  });
  postDiv.appendChild(termsDiv);

  const header = document.createElement('div');
  header.className = 'post-header';

  if (post.author.avatar && isValidBskyUrl(post.author.avatar)) {
    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    avatar.src = post.author.avatar;
    avatar.alt = '';
    avatar.loading = 'lazy';
    header.appendChild(avatar);
  } else {
    const avatarPlaceholder = document.createElement('div');
    avatarPlaceholder.className = 'avatar';
    header.appendChild(avatarPlaceholder);
  }

  const authorInfo = document.createElement('div');
  authorInfo.className = 'author-info';

  const authorUrl = `https://bsky.app/profile/${encodeURIComponent(handle)}`;
  const nameLink = document.createElement('a');
  nameLink.className = 'display-name';
  nameLink.href = authorUrl;
  nameLink.target = '_blank';
  nameLink.rel = 'noopener noreferrer';
  nameLink.textContent = displayName;
  authorInfo.appendChild(nameLink);

  const handleSpan = document.createElement('span');
  handleSpan.className = 'handle';
  handleSpan.textContent = `@${handle}`;
  authorInfo.appendChild(handleSpan);

  header.appendChild(authorInfo);

  const timeSpan = document.createElement('span');
  timeSpan.className = 'post-time';
  timeSpan.textContent = formatRelativeTime(post.record?.createdAt || post.indexedAt);
  header.appendChild(timeSpan);

  postDiv.appendChild(header);

  const textDiv = document.createElement('div');
  textDiv.className = 'post-text';
  textDiv.appendChild(createHighlightedText(text, state.searchTerms));
  postDiv.appendChild(textDiv);

  if (post.embed?.$type === 'app.bsky.embed.images#view' && Array.isArray(post.embed.images)) {
    const validImages = post.embed.images.filter((img) => img?.thumb && isValidBskyUrl(img.thumb));

    if (validImages.length > 0) {
      const imagesContainer = document.createElement('div');
      imagesContainer.className = 'post-images-container';

      const placeholder = document.createElement('div');
      placeholder.className = 'image-placeholder';

      const showBtn = document.createElement('button');
      showBtn.type = 'button';
      const count = validImages.length;
      showBtn.textContent = `Show ${count} image${count !== 1 ? 's' : ''}`;
      showBtn.addEventListener('click', () => {
        const imagesDiv = document.createElement('div');
        imagesDiv.className = `post-images ${validImages.length === 1 ? 'single' : 'multiple'}`;

        validImages.forEach((img) => {
          const imgEl = document.createElement('img');
          imgEl.className = 'post-image';
          imgEl.src = img.thumb;
          imgEl.alt = img.alt || '';
          imgEl.loading = 'lazy';
          imagesDiv.appendChild(imgEl);
        });

        imagesContainer.replaceChild(imagesDiv, placeholder);
      });

      placeholder.appendChild(showBtn);
      imagesContainer.appendChild(placeholder);
      postDiv.appendChild(imagesContainer);
    }
  }

  const statsDiv = document.createElement('div');
  statsDiv.className = 'post-stats';
  appendEngagementStats(statsDiv, post, SEARCH_STAT_CLASSES);
  postDiv.appendChild(statsDiv);

  const linksDiv = document.createElement('div');
  linksDiv.className = 'link-actions';

  if (postUrl) {
    const isReply = isReplyPost(post);
    if (isReply) {
      const threadLink = document.createElement('button');
      threadLink.className = 'thread-link';
      threadLink.textContent = 'View Thread';
      initializeThreadToggle(threadLink);
      threadLink.addEventListener('click', () => toggleThread(post, postDiv));
      linksDiv.appendChild(threadLink);
    }
    const blueskyLink = document.createElement('a');
    blueskyLink.className = 'thread-link';
    blueskyLink.href = postUrl;
    blueskyLink.target = '_blank';
    blueskyLink.rel = 'noopener noreferrer';
    blueskyLink.textContent = isReply ? 'View on Bluesky' : 'View Replies \u2192';
    linksDiv.appendChild(blueskyLink);
  }

  postDiv.appendChild(linksDiv);

  return postDiv;
}

function resetResultsRenderCache() {
  cancelThreadRequests();
  cancelScheduledRender();
  resultsHeaderEl = null;
  resultsCountEl = null;
  resultsSortEl = null;
  resultsEmptyEl = null;
  resultsEmptyPrimaryEl = null;
  resultsEmptySecondaryEl = null;
  resultsListEl = null;
  showMoreBtnEl = null;
  loadMoreBtnEl = null;
  renderedPosts.clear();
  resultsDiv.textContent = '';
}

function ensureResultsShell() {
  if (resultsHeaderEl) {
    return;
  }

  resetResultsRenderCache();

  resultsHeaderEl = document.createElement('div');
  resultsHeaderEl.className = 'results-header';
  resultsHeaderEl.setAttribute('role', 'status');
  resultsHeaderEl.setAttribute('aria-live', 'polite');
  resultsHeaderEl.setAttribute('aria-atomic', 'true');

  resultsCountEl = document.createElement('span');
  resultsCountEl.className = 'results-count';
  resultsHeaderEl.appendChild(resultsCountEl);

  resultsSortEl = document.createElement('span');
  resultsHeaderEl.appendChild(resultsSortEl);

  resultsEmptyEl = document.createElement('div');
  resultsEmptyEl.className = 'no-results';
  resultsEmptyPrimaryEl = document.createElement('p');
  resultsEmptySecondaryEl = document.createElement('p');
  resultsEmptyEl.appendChild(resultsEmptyPrimaryEl);
  resultsEmptyEl.appendChild(resultsEmptySecondaryEl);

  resultsListEl = document.createElement('div');

  showMoreBtnEl = document.createElement('button');
  showMoreBtnEl.className = 'load-more';
  showMoreBtnEl.type = 'button';
  showMoreBtnEl.addEventListener('click', () => {
    increaseRenderLimit();
    renderResults();
  });

  loadMoreBtnEl = document.createElement('button');
  loadMoreBtnEl.className = 'load-more';
  loadMoreBtnEl.id = 'loadMoreBtn';
  loadMoreBtnEl.type = 'button';
  loadMoreBtnEl.textContent = 'Load More Results';
  loadMoreBtnEl.addEventListener('click', loadMore);

  resultsDiv.appendChild(resultsHeaderEl);
  resultsDiv.appendChild(resultsEmptyEl);
  resultsDiv.appendChild(resultsListEl);
  resultsDiv.appendChild(showMoreBtnEl);
  resultsDiv.appendChild(loadMoreBtnEl);
}

function syncVisibleResultPosts(visiblePosts) {
  const visibleUris = new Set();
  let renderedCount = 0;

  visiblePosts.forEach((post) => {
    const uri = post.uri;
    if (!uri) return;
    visibleUris.add(uri);

    const nextFingerprint = getPostRenderFingerprint(post);
    const previous = renderedPosts.get(uri);
    let postElement = previous?.element;

    if (!postElement || previous.fingerprint !== nextFingerprint) {
      const nextElement = createPostElement(post);

      if (postElement?.parentNode === resultsListEl) {
        cancelThreadRequest(postElement);
        resultsListEl.replaceChild(nextElement, postElement);
      }

      postElement = nextElement;
      renderedPosts.set(uri, { element: postElement, fingerprint: nextFingerprint });
    }

    const currentAtIndex = resultsListEl.children[renderedCount];
    if (currentAtIndex !== postElement) {
      resultsListEl.insertBefore(postElement, currentAtIndex || null);
    }
    renderedCount += 1;
  });

  for (const [uri, { element }] of renderedPosts) {
    if (visibleUris.has(uri)) {
      continue;
    }
    if (element.parentNode === resultsListEl) {
      cancelThreadRequest(element);
      element.remove();
    }
    renderedPosts.delete(uri);
  }

  while (resultsListEl.children.length > renderedCount) {
    resultsListEl.lastElementChild?.remove();
  }
}

function syncLoadMoreButton() {
  if (!loadMoreBtnEl) return;

  const hasMoreResults = Object.values(state.currentCursors).some((cursor) => cursor !== null);
  if (!hasMoreResults) {
    loadMoreBtnEl.style.display = 'none';
    loadMoreBtnEl.disabled = false;
    loadMoreBtnEl.textContent = 'Load More Results';
    return;
  }

  loadMoreBtnEl.style.display = '';
  loadMoreBtnEl.disabled = state.isLoading || state.searchDebounceTimer !== null;
  loadMoreBtnEl.textContent = state.isLoading ? 'Loading…' : 'Load More Results';
}

function renderResults() {
  ensureResultsShell();

  const totalCount = state.allPosts.length;
  const visibleCount = Math.min(state.renderLimit, totalCount);

  if (totalCount === 0) {
    resultsHeaderEl.style.display = 'none';
    resultsListEl.style.display = 'none';
    showMoreBtnEl.style.display = 'none';
    syncLoadMoreButton();
    resultsEmptyEl.style.display = 'block';
    resultsEmptyPrimaryEl.textContent = 'No loaded posts match your criteria.';
    resultsEmptySecondaryEl.textContent = Object.values(state.currentCursors).some((cursor) => cursor !== null)
      ? 'Load more results to continue searching, or lower the minimum likes.'
      : 'Try different search terms or lower the minimum likes.';
    syncVisibleResultPosts([]);
    return;
  }

  resultsEmptyEl.style.display = 'none';
  resultsHeaderEl.style.display = '';
  resultsListEl.style.display = '';

  const totalLabel = totalCount === 1 ? 'post' : 'posts';
  resultsCountEl.textContent =
    visibleCount < totalCount
      ? `Showing ${visibleCount} of ${totalCount} ${totalLabel}`
      : `${totalCount} ${totalLabel} found`;
  resultsSortEl.textContent =
    state.searchSort === 'latest'
      ? 'Sorted by time (newest first)'
      : 'Sorted by likes (high to low)';

  const visiblePosts = state.allPosts.slice(0, visibleCount);
  syncVisibleResultPosts(visiblePosts);

  const remaining = totalCount - visibleCount;
  if (remaining > 0) {
    showMoreBtnEl.style.display = '';
    const nextCount = Math.min(remaining, RENDER_STEP);
    showMoreBtnEl.textContent = `Show ${nextCount} more loaded result${nextCount === 1 ? '' : 's'}`;
  } else {
    showMoreBtnEl.style.display = 'none';
  }

  syncLoadMoreButton();
}

// A new search replaces the previous one immediately, including its requests.
export async function performSearch() {
  cancelDebouncedSearch();
  cancelActiveSearch();
  const termsValue = termsInput.value.trim();
  state.rawSearchTerms = termsValue.split(',').map(normalizeTerm).filter(Boolean);
  state.searchTerms = expandSearchTerms(state.rawSearchTerms, expandTermsToggle.checked);
  state.minLikes = Math.max(0, parseInt(minLikesInput.value, 10) || 0);
  state.timeFilterHours = parseInt(timeFilterSelect.value, 10) || 24;
  state.searchSort = normalizeSortValue(sortSelect.value);
  state.searchSince = state.searchTerms.length ? getSearchSince(state.timeFilterHours) : null;
  state.allPosts = [];
  // Empty string means the first page needs loading; null means exhausted.
  state.currentCursors = Object.create(null);
  for (const term of state.searchTerms) state.currentCursors[term] = '';
  searchSeenCursors.clear();
  ingestedPostsByUri.clear();
  resetResultsRenderCache();
  highlightMatcherCache = { key: '', regex: null, termSet: null };
  state.renderLimit = INITIAL_RENDER_LIMIT;
  updateSearchURL();
  if (!state.searchTerms.length) {
    showStatus('Please enter at least one search term.', 'error');
    return;
  }
  showStatus(`Searching for: ${state.rawSearchTerms.join(', ')}…`, 'loading');
  await runSearchPages([...state.searchTerms], INITIAL_MAX_PAGES, createSearchContext());
}

export async function loadMore() {
  if (state.isLoading || state.searchDebounceTimer !== null) return;
  const terms = state.searchTerms.filter((term) =>
    Object.hasOwn(state.currentCursors, term) && state.currentCursors[term] !== null);
  if (!terms.length) return;
  showStatus('Loading more results…', 'loading');
  await runSearchPages(terms, 1, createSearchContext(), { loadingMore: true });
}

export function debouncedSearch() {
  if (!termsInput.value.trim()) {
    clearSearchResults();
    return;
  }
  cancelActiveSearch();
  hideStatus();
  cancelDebouncedSearch();
  state.searchDebounceTimer = setTimeout(() => {
    state.searchDebounceTimer = null;
    performSearch();
  }, SEARCH_DEBOUNCE_MS);
  syncLoadMoreButton();
}

export function cancelDebouncedSearch() {
  if (state.searchDebounceTimer) {
    clearTimeout(state.searchDebounceTimer);
    state.searchDebounceTimer = null;
  }
}

export function clearSearchResults() {
  cancelDebouncedSearch();
  cancelActiveSearch();
  state.allPosts = [];
  state.currentCursors = Object.create(null);
  searchSeenCursors.clear();
  state.rawSearchTerms = [];
  state.searchTerms = [];
  state.searchSince = null;
  ingestedPostsByUri.clear();
  state.renderLimit = INITIAL_RENDER_LIMIT;
  resetResultsRenderCache();
  hideStatus();
  updateSearchURL();
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

export function applySearchSortChange() {
  cancelDebouncedSearch();
  if (termsInput.value.trim()) return performSearch();
  updateSearchURL();
}
