import {
  INITIAL_MAX_PAGES,
  INITIAL_RENDER_LIMIT,
  RENDER_STEP,
  SEARCH_API,
  SEARCH_DEBOUNCE_MS,
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
  isValidBskyUrl,
  normalizeSortValue,
  normalizeTerm,
  setText,
  sortPosts,
} from './utils.mjs';
import { appendEngagementStats, SEARCH_STAT_CLASSES } from './post-stats.mjs';
import { enforceSearchCacheLimit, getCachedSearch } from './cache.mjs';
import { consumePendingSearch } from './search-state.mjs';
import { setQueryParam, updateURLWithParams } from './url.mjs';
import { isReplyPost, toggleThread } from './thread.mjs';

const DERIVE_THROTTLE_MS = 120;

let ingestedPostsByUri = new Map();
let deriveTimerId = null;

// Coalesce render updates into a single frame.
let pendingRenderFrame = null;

// Search results rendering cache.
let resultsHeaderEl = null;
let resultsCountEl = null;
let resultsSortEl = null;
let resultsEmptyEl = null;
let resultsEmptyPrimaryEl = null;
let resultsEmptySecondaryEl = null;
let resultsListEl = null;
let showMoreBtnEl = null;
let loadMoreBtnEl = null;
const renderedPostElements = new Map();
const renderedPostFingerprints = new Map();

// Highlight matcher cache for a single active term set.
let highlightMatcherCache = { key: '', regex: null, termSet: null };

// Show status message
function showStatus(message, type = 'info') {
  statusDiv.className = `status ${type}`;
  setText(statusDiv, message);
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

// Search posts for a single term (server-side proxy)
async function searchTerm(term, cursor = null, sort = state.searchSort) {
  const sortValue = normalizeSortValue(sort);
  const cacheKey = getSearchCacheKey(term, cursor, sortValue);

  // Check cache first
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

  // Cache the result
  searchCache.set(cacheKey, { data, timestamp: Date.now() });
  enforceSearchCacheLimit();

  return data;
}

// Fetch all posts for a term (with pagination)
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

function resetRenderLimit() {
  state.renderLimit = INITIAL_RENDER_LIMIT;
}

function increaseRenderLimit(step = RENDER_STEP) {
  state.renderLimit = Math.min(state.allPosts.length, state.renderLimit + step);
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

function getMatchedTermsForPost(post) {
  if (Array.isArray(post.matchedTerms) && post.matchedTerms.length > 0) {
    return post.matchedTerms.filter(Boolean);
  }
  if (post.matchedTerm) {
    return [post.matchedTerm];
  }
  return [];
}

function mergeMatchedTerms(existingTerms, incomingTerms) {
  const merged = [];
  const seen = new Set();

  const add = (term) => {
    if (!term) return;
    const normalized = term.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    merged.push(term);
  };

  existingTerms.forEach(add);
  incomingTerms.forEach(add);
  return merged;
}

function ingestPosts(posts) {
  for (const post of posts) {
    if (!post?.uri) continue;

    const incomingTerms = getMatchedTermsForPost(post);
    const existing = ingestedPostsByUri.get(post.uri);

    if (!existing) {
      const normalized = { ...post };
      normalized.matchedTerms = incomingTerms;
      normalized.matchedTerm = normalized.matchedTerms[0] || '';
      ingestedPostsByUri.set(post.uri, normalized);
      continue;
    }

    const mergedTerms = mergeMatchedTerms(getMatchedTermsForPost(existing), incomingTerms);
    Object.assign(existing, post);
    existing.matchedTerms = mergedTerms;
    existing.matchedTerm = existing.matchedTerms[0] || '';
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

function flushDerivedPostsRebuild({ render = false } = {}) {
  clearDerivedPostsTimer();
  recomputeDerivedPosts();
  if (render) {
    cancelScheduledRender();
    renderResults();
  }
}

function clearIngestedPosts() {
  ingestedPostsByUri.clear();
}

function getHighlightMatcher(terms) {
  const key = terms.map((term) => term.toLowerCase()).join('\u0001');
  if (key === highlightMatcherCache.key) {
    return highlightMatcherCache;
  }

  if (terms.length === 0) {
    highlightMatcherCache = { key, regex: null, termSet: new Set() };
    return highlightMatcherCache;
  }

  const escapedTerms = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi');
  const termSet = new Set(terms.map((term) => term.toLowerCase()));
  highlightMatcherCache = { key, regex, termSet };
  return highlightMatcherCache;
}

// Create text with highlighted search terms using DOM methods (safe)
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

// Create a post element using safe DOM methods
function createPostElement(post) {
  const postUrl = getPostUrl(post);
  const handle = post.author.handle;
  const displayName = post.author.displayName || handle;
  const text = post.record?.text || '';

  const postDiv = document.createElement('div');
  postDiv.className = 'post';

  // Search terms tags
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

  // Header
  const header = document.createElement('div');
  header.className = 'post-header';

  // Avatar
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

  // Author info
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

  // Time
  const timeSpan = document.createElement('span');
  timeSpan.className = 'post-time';
  timeSpan.textContent = formatRelativeTime(post.indexedAt);
  header.appendChild(timeSpan);

  postDiv.appendChild(header);

  // Post text with highlights
  const textDiv = document.createElement('div');
  textDiv.className = 'post-text';
  textDiv.appendChild(createHighlightedText(text, state.searchTerms));
  postDiv.appendChild(textDiv);

  // Images (hidden by default)
  if (post.embed?.$type === 'app.bsky.embed.images#view' && post.embed.images) {
    const validImages = post.embed.images.filter((img) => img.thumb && isValidBskyUrl(img.thumb));

    if (validImages.length > 0) {
      const imagesContainer = document.createElement('div');
      imagesContainer.className = 'post-images-container';

      // Create placeholder
      const placeholder = document.createElement('div');
      placeholder.className = 'image-placeholder';

      const showBtn = document.createElement('button');
      showBtn.type = 'button';
      const count = validImages.length;
      showBtn.textContent = `Show ${count} image${count !== 1 ? 's' : ''}`;
      showBtn.addEventListener('click', () => {
        // Replace placeholder with actual images
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

  // Stats
  const statsDiv = document.createElement('div');
  statsDiv.className = 'post-stats';
  appendEngagementStats(statsDiv, post, SEARCH_STAT_CLASSES);
  postDiv.appendChild(statsDiv);

  // Links container
  const linksDiv = document.createElement('div');
  linksDiv.className = 'link-actions';

  // Thread link (View Thread for replies, View Replies for standalone posts)
  if (postUrl) {
    if (isReplyPost(post)) {
      const threadLink = document.createElement('button');
      threadLink.className = 'thread-link';
      threadLink.textContent = 'View Thread';
      threadLink.addEventListener('click', () => toggleThread(post, postDiv));
      linksDiv.appendChild(threadLink);

      const blueskyLink = document.createElement('a');
      blueskyLink.className = 'thread-link';
      blueskyLink.href = postUrl;
      blueskyLink.target = '_blank';
      blueskyLink.rel = 'noopener noreferrer';
      blueskyLink.textContent = 'View on Bluesky';
      linksDiv.appendChild(blueskyLink);
    } else {
      const repliesLink = document.createElement('a');
      repliesLink.className = 'thread-link';
      repliesLink.href = postUrl;
      repliesLink.target = '_blank';
      repliesLink.rel = 'noopener noreferrer';
      repliesLink.textContent = 'View Replies \u2192';
      linksDiv.appendChild(repliesLink);
    }
  }

  postDiv.appendChild(linksDiv);

  return postDiv;
}

function resetResultsRenderCache() {
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
  renderedPostElements.clear();
  renderedPostFingerprints.clear();
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
  resultsListEl.className = 'results-list';

  showMoreBtnEl = document.createElement('button');
  showMoreBtnEl.className = 'load-more';
  showMoreBtnEl.id = 'showMoreBtn';
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

function getPostRenderFingerprint(post) {
  const matchedTerms = getMatchedTermsForPost(post).join('\u0001');
  return [
    post.uri || '',
    post.author?.handle || '',
    post.author?.displayName || '',
    post.author?.avatar || '',
    post.indexedAt || '',
    post.record?.text || '',
    post.likeCount || 0,
    post.repostCount || 0,
    post.replyCount || 0,
    matchedTerms,
  ].join('\u0002');
}

function syncVisibleResultPosts(visiblePosts) {
  const visibleUris = new Set();
  let renderedCount = 0;

  visiblePosts.forEach((post) => {
    const uri = post.uri;
    if (!uri) return;
    visibleUris.add(uri);

    const nextFingerprint = getPostRenderFingerprint(post);
    const previousFingerprint = renderedPostFingerprints.get(uri);
    let postElement = renderedPostElements.get(uri);

    if (!postElement || previousFingerprint !== nextFingerprint) {
      const nextElement = createPostElement(post);
      nextElement.dataset.uri = uri;

      if (postElement?.parentNode === resultsListEl) {
        resultsListEl.replaceChild(nextElement, postElement);
      }

      postElement = nextElement;
      renderedPostElements.set(uri, postElement);
      renderedPostFingerprints.set(uri, nextFingerprint);
    }

    const currentAtIndex = resultsListEl.children[renderedCount];
    if (currentAtIndex !== postElement) {
      resultsListEl.insertBefore(postElement, currentAtIndex || null);
    }
    renderedCount += 1;
  });

  for (const [uri, element] of renderedPostElements.entries()) {
    if (visibleUris.has(uri)) {
      continue;
    }
    if (element.parentNode === resultsListEl) {
      element.remove();
    }
    renderedPostElements.delete(uri);
    renderedPostFingerprints.delete(uri);
  }

  while (resultsListEl.children.length > renderedCount) {
    resultsListEl.lastElementChild?.remove();
  }
}

// Render all results using safe DOM methods
function renderResults() {
  ensureResultsShell();

  const totalCount = state.allPosts.length;
  const visibleCount = Math.min(state.renderLimit, totalCount);

  if (totalCount === 0) {
    resultsHeaderEl.style.display = 'none';
    resultsListEl.style.display = 'none';
    showMoreBtnEl.style.display = 'none';
    loadMoreBtnEl.style.display = 'none';
    resultsEmptyEl.style.display = 'block';
    resultsEmptyPrimaryEl.textContent = 'No posts found matching your criteria.';
    resultsEmptySecondaryEl.textContent = 'Try different search terms or lower the minimum likes.';
    if (resultsListEl.children.length > 0) {
      resultsListEl.textContent = '';
      renderedPostElements.clear();
      renderedPostFingerprints.clear();
    }
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
    showMoreBtnEl.textContent =
      remaining <= RENDER_STEP
        ? remaining === 1
          ? 'Show 1 more loaded result'
          : `Show ${remaining} more loaded results`
        : `Show ${RENDER_STEP} more loaded results`;
  } else {
    showMoreBtnEl.style.display = 'none';
  }

  const hasMoreResults = Object.values(state.currentCursors).some((cursor) => cursor !== null);
  if (hasMoreResults) {
    loadMoreBtnEl.style.display = '';
    if (state.isLoading) {
      loadMoreBtnEl.disabled = true;
      if (!loadMoreBtnEl.textContent || loadMoreBtnEl.textContent === 'Load More Results') {
        loadMoreBtnEl.textContent = 'Loading…';
      }
    } else {
      loadMoreBtnEl.disabled = false;
      loadMoreBtnEl.textContent = 'Load More Results';
    }
  } else {
    loadMoreBtnEl.style.display = 'none';
    loadMoreBtnEl.disabled = false;
    loadMoreBtnEl.textContent = 'Load More Results';
  }
}

// Main search function
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
  state.searchSort = normalizeSortValue(sortSelect.value);

  if (state.rawSearchTerms.length === 0) {
    showStatus('Please enter at least one search term.', 'error');
    return;
  }

  state.isLoading = true;
  searchBtn.disabled = true;
  state.allPosts = [];
  state.currentCursors = {};
  clearDerivedPostsTimer();
  clearIngestedPosts();
  resetResultsRenderCache();
  highlightMatcherCache = { key: '', regex: null, termSet: null };
  resetRenderLimit();

  updateSearchURL();

  try {
    showStatus(`Searching for: ${state.rawSearchTerms.join(', ')}…`, 'loading');

    // Track progress for progressive rendering
    let completedTerms = 0;
    const totalTerms = state.searchTerms.length;

    // Fetch all terms in parallel, but render progressively as each completes
    const promises = state.searchTerms.map(async (term) => {
      const posts = await fetchAllPostsForTerm(term, INITIAL_MAX_PAGES, state.searchSort);

      // Bail if a newer search has started — prevents stale data corruption
      if (!isCurrentSearchGeneration(currentGeneration)) return posts;

      // Immediately merge and render as this term completes
      completedTerms++;
      ingestPosts(posts);

      // Update status and render immediately
      if (completedTerms < totalTerms) {
        showStatus(`Loaded ${completedTerms}/${totalTerms} terms…`, 'loading');
      }
      scheduleDerivedPostsRebuild();

      return posts;
    });

    // Use allSettled to wait for ALL promises before continuing
    // This prevents race conditions where failed promises' siblings
    // continue updating state after error handling
    const results = await Promise.allSettled(promises);

    // Bail if a newer search has started
    if (!isCurrentSearchGeneration(currentGeneration)) return;

    // Check for failures
    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      const errorMsg =
        failures.length === totalTerms
          ? `Search failed: ${failures[0].reason.message}`
          : `${failures.length}/${totalTerms} terms failed to load`;
      showStatus(errorMsg, 'error');
      // Continue - we may have partial results from successful terms
    } else {
      hideStatus();
    }

    flushDerivedPostsRebuild({ render: true });
  } catch (error) {
    console.error('Search error:', error);
    showStatus(`Error: ${error.message}`, 'error');
  } finally {
    state.isLoading = false;
    searchBtn.disabled = false;
    if (consumePendingSearch(state)) {
      performSearch();
    }
  }
}

// Load more results
export async function loadMore() {
  if (state.isLoading) return;

  const currentGeneration = state.searchGeneration;
  const prevCount = state.allPosts.length;
  state.isLoading = true;
  const loadMoreBtn = loadMoreBtnEl || document.getElementById('loadMoreBtn');
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = 'Loading…';
  }

  try {
    const searchSort = state.searchSort;
    const requests = state.searchTerms
      .map((term) => ({ term, cursor: state.currentCursors[term] }))
      .filter((request) => request.cursor);
    const promises = requests
      .map(async ({ term, cursor }) => {
        const data = await searchTerm(term, cursor, searchSort);

        if (data.posts && data.posts.length > 0) {
          return {
            cursor: data.cursor || null,
            posts: data.posts.map((post) => ({
              ...post,
              matchedTerm: term,
            })),
            term,
          };
        }
        return { cursor: data.cursor || null, posts: [], term };
      });

    const results = await Promise.all(promises);
    if (!isCurrentSearchGeneration(currentGeneration)) {
      return;
    }

    results.forEach((result) => {
      state.currentCursors[result.term] = result.cursor;
    });

    const newPosts = results.flatMap((result) => result.posts);

    if (newPosts.length > 0) {
      ingestPosts(newPosts);
      flushDerivedPostsRebuild();
      if (state.allPosts.length > prevCount) {
        state.renderLimit = Math.min(state.allPosts.length, state.renderLimit + RENDER_STEP);
      }
    }
    renderResults();
  } catch (error) {
    console.error('Load more error:', error);
    showStatus(`Error loading more: ${error.message}`, 'error');
  } finally {
    state.isLoading = false;
    if (loadMoreBtn) {
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = 'Load More Results';
    }
    if (consumePendingSearch(state)) {
      performSearch();
    }
  }
}

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

export function clearSearchResults() {
  state.pendingSearch = false;
  state.searchGeneration++;
  state.allPosts = [];
  state.currentCursors = {};
  state.rawSearchTerms = [];
  state.searchTerms = [];
  clearDerivedPostsTimer();
  clearIngestedPosts();
  resetRenderLimit();
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
  if (state.searchTerms.length === 0) {
    return;
  }
  flushDerivedPostsRebuild({ render: true });
}

export function renderSearchResults() {
  renderResults();
}
