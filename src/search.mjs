import {
  INITIAL_MAX_PAGES,
  INITIAL_RENDER_LIMIT,
  RENDER_STEP,
  SEARCH_API,
  SEARCH_DEBOUNCE_MS,
} from './constants.mjs';
import { searchCache, state } from './state.mjs';
import {
  autoRefreshToggle,
  expandSummary,
  expandTermsToggle,
  minLikesInput,
  newPostsDiv,
  refreshIntervalSelect,
  refreshLastDiv,
  refreshNextDiv,
  refreshStateDiv,
  resultsDiv,
  searchBtn,
  sortSelect,
  statusDiv,
  termsInput,
  timeFilterSelect,
} from './dom.mjs';
import {
  deduplicatePosts,
  expandSearchTerms,
  filterByDate,
  filterByLikes,
  formatDuration,
  formatRelativeTime,
  formatTime,
  getPostTimestamp,
  getPostUrl,
  getSearchCacheKey,
  isValidBskyUrl,
  normalizeTerm,
  setText,
  sortPosts,
} from './utils.mjs';
import { getCachedSearch } from './cache.mjs';
import { setQueryParam, updateURLWithParams } from './url.mjs';
import { isReplyPost, toggleThread } from './thread.mjs';

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

// Search posts for a single term (server-side proxy)
async function searchTerm(term, cursor = null, sort = state.searchSort) {
  const sortValue = sort === 'latest' ? 'latest' : 'top';
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

function resetRenderLimit() {
  state.renderLimit = INITIAL_RENDER_LIMIT;
}

function increaseRenderLimit(step = RENDER_STEP) {
  state.renderLimit = Math.min(state.allPosts.length, state.renderLimit + step);
}

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
    renderResults();
  }, 8000);
}

// Create text with highlighted search terms using DOM methods (safe)
function createHighlightedText(text, terms) {
  const fragment = document.createDocumentFragment();
  if (!text) return fragment;

  const escapedTerms = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi');

  const parts = text.split(regex);

  parts.forEach((part) => {
    if (terms.some((term) => part.toLowerCase() === term.toLowerCase())) {
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
  if (state.newPostUris.has(post.uri)) {
    postDiv.classList.add('new-post');
  }

  // Search terms tags
  const termsDiv = document.createElement('div');
  termsDiv.className = 'search-terms';
  post.matchedTerms.forEach((term) => {
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

  const likeStat = document.createElement('span');
  likeStat.className = 'stat likes';
  likeStat.setAttribute('aria-label', `${post.likeCount || 0} likes`);
  const likeIcon = document.createElement('span');
  likeIcon.setAttribute('aria-hidden', 'true');
  likeIcon.textContent = '\u2665 ';
  likeStat.appendChild(likeIcon);
  likeStat.appendChild(document.createTextNode(post.likeCount || 0));
  statsDiv.appendChild(likeStat);

  const repostStat = document.createElement('span');
  repostStat.className = 'stat';
  repostStat.setAttribute('aria-label', `${post.repostCount || 0} reposts`);
  const repostIcon = document.createElement('span');
  repostIcon.setAttribute('aria-hidden', 'true');
  repostIcon.textContent = '\u21bb ';
  repostStat.appendChild(repostIcon);
  repostStat.appendChild(document.createTextNode(post.repostCount || 0));
  statsDiv.appendChild(repostStat);

  const replyStat = document.createElement('span');
  replyStat.className = 'stat';
  replyStat.setAttribute('aria-label', `${post.replyCount || 0} replies`);
  const replyIcon = document.createElement('span');
  replyIcon.setAttribute('aria-hidden', 'true');
  replyIcon.textContent = '\ud83d\udcac ';
  replyStat.appendChild(replyIcon);
  replyStat.appendChild(document.createTextNode(post.replyCount || 0));
  statsDiv.appendChild(replyStat);

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

// Render all results using safe DOM methods
function renderResults() {
  resultsDiv.textContent = '';

  if (state.allPosts.length === 0) {
    const noResults = document.createElement('div');
    noResults.className = 'no-results';

    const p1 = document.createElement('p');
    p1.textContent =
      state.pendingPosts.length > 0
        ? 'New posts are waiting above.'
        : 'No posts found matching your criteria.';
    noResults.appendChild(p1);

    const p2 = document.createElement('p');
    p2.textContent =
      state.pendingPosts.length > 0
        ? 'Use "Add to results" to merge them into the main list.'
        : 'Try different search terms or lower the minimum likes.';
    noResults.appendChild(p2);

    resultsDiv.appendChild(noResults);
    return;
  }

  // Header
  const headerDiv = document.createElement('div');
  headerDiv.className = 'results-header';

  const countSpan = document.createElement('span');
  countSpan.className = 'results-count';
  const totalCount = state.allPosts.length;
  const visibleCount = Math.min(state.renderLimit, totalCount);
  const totalLabel = totalCount === 1 ? 'post' : 'posts';
  if (visibleCount < totalCount) {
    countSpan.textContent = `Showing ${visibleCount} of ${totalCount} ${totalLabel}`;
  } else {
    countSpan.textContent = `${totalCount} ${totalLabel} found`;
  }
  headerDiv.appendChild(countSpan);

  const sortSpan = document.createElement('span');
  sortSpan.textContent =
    state.searchSort === 'latest'
      ? 'Sorted by time (newest first)'
      : 'Sorted by likes (high to low)';
  headerDiv.appendChild(sortSpan);

  resultsDiv.appendChild(headerDiv);

  // Posts
  const visiblePosts = state.allPosts.slice(0, visibleCount);
  visiblePosts.forEach((post) => {
    resultsDiv.appendChild(createPostElement(post));
  });

  if (visibleCount < totalCount) {
    const showMoreBtn = document.createElement('button');
    showMoreBtn.className = 'load-more';
    showMoreBtn.id = 'showMoreBtn';
    const remaining = totalCount - visibleCount;
    if (remaining <= RENDER_STEP) {
      showMoreBtn.textContent =
        remaining === 1 ? 'Show 1 more loaded result' : `Show ${remaining} more loaded results`;
    } else {
      showMoreBtn.textContent = `Show ${RENDER_STEP} more loaded results`;
    }
    showMoreBtn.addEventListener('click', () => {
      increaseRenderLimit();
      renderResults();
    });
    resultsDiv.appendChild(showMoreBtn);
  }

  // Load more button
  const hasMoreResults = Object.values(state.currentCursors).some((cursor) => cursor !== null);
  if (hasMoreResults) {
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.className = 'load-more';
    loadMoreBtn.id = 'loadMoreBtn';
    loadMoreBtn.textContent = 'Load More Results';
    loadMoreBtn.addEventListener('click', loadMore);
    resultsDiv.appendChild(loadMoreBtn);
  }
}

function renderNewPosts() {
  newPostsDiv.textContent = '';
  if (state.pendingPosts.length === 0) {
    newPostsDiv.classList.add('hidden');
    return;
  }

  newPostsDiv.classList.remove('hidden');

  const header = document.createElement('div');
  header.className = 'new-posts-header';

  const title = document.createElement('div');
  title.className = 'new-posts-title';
  title.textContent = `${state.pendingPosts.length} new post${state.pendingPosts.length !== 1 ? 's' : ''} from auto-refresh`;
  header.appendChild(title);

  const actions = document.createElement('div');
  actions.className = 'new-posts-actions';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'button-small';
  addBtn.textContent = 'Add to results';
  addBtn.addEventListener('click', mergePendingPosts);
  actions.appendChild(addBtn);

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'button-secondary button-small';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener('click', dismissPendingPosts);
  actions.appendChild(dismissBtn);

  header.appendChild(actions);
  newPostsDiv.appendChild(header);

  const list = document.createElement('div');
  list.className = 'new-posts-list';
  const sorted = [...state.pendingPosts].sort((a, b) => getPostTimestamp(b) - getPostTimestamp(a));
  sorted.forEach((post) => {
    list.appendChild(createPostElement(post));
  });
  newPostsDiv.appendChild(list);
}

function mergePendingPosts() {
  if (state.pendingPosts.length === 0) {
    return;
  }

  let combined = deduplicatePosts([...state.pendingPosts, ...state.allPosts]);
  combined = filterByDate(combined, state.timeFilterHours);
  combined = filterByLikes(combined, state.minLikes);
  state.allPosts = sortPosts(combined, state.searchSort);

  clearNewPostHighlights();
  state.newPostUris = new Set(state.pendingPosts.map((post) => post.uri));
  scheduleNewPostHighlightClear();
  state.pendingPosts = [];
  renderNewPosts();
  renderResults();
}

function dismissPendingPosts() {
  if (state.pendingPosts.length === 0) {
    return;
  }
  state.pendingPosts = [];
  clearNewPostHighlights();
  renderNewPosts();
  renderResults();
}

async function refreshSearch() {
  if (state.searchTerms.length === 0) {
    return 0;
  }

  let trimmed = filterByDate(state.allPosts, state.timeFilterHours);
  trimmed = filterByLikes(trimmed, state.minLikes);
  state.allPosts = sortPosts(trimmed, state.searchSort);

  state.pendingPosts = filterByDate(state.pendingPosts, state.timeFilterHours);
  state.pendingPosts = filterByLikes(state.pendingPosts, state.minLikes);

  const existingUris = new Set([...state.allPosts, ...state.pendingPosts].map((post) => post.uri));
  const results = await Promise.all(
    state.searchTerms.map((term) => fetchLatestPostsForTerm(term, state.searchSort))
  );
  let latestPosts = deduplicatePosts(results.flat());
  latestPosts = filterByDate(latestPosts, state.timeFilterHours);
  latestPosts = filterByLikes(latestPosts, state.minLikes);

  const newPosts = latestPosts.filter((post) => !existingUris.has(post.uri));

  if (newPosts.length > 0) {
    state.pendingPosts = deduplicatePosts([...state.pendingPosts, ...newPosts]);
  }

  clearNewPostHighlights();
  if (newPosts.length > 0) {
    state.newPostUris = new Set(newPosts.map((post) => post.uri));
    scheduleNewPostHighlightClear();
  }

  renderNewPosts();
  renderResults();
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

// Main search function
export async function performSearch() {
  if (state.isLoading) {
    state.pendingSearch = true;
    return;
  }
  state.pendingSearch = false;
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
  renderNewPosts();
  resetRenderLimit();

  updateSearchURL();

  try {
    showStatus(`Searching for: ${state.rawSearchTerms.join(', ')}…`, 'loading');

    // Fetch all terms in parallel (Bluesky API doesn't support OR queries)
    const promises = state.searchTerms.map((term) =>
      fetchAllPostsForTerm(term, INITIAL_MAX_PAGES, state.searchSort)
    );
    const results = await Promise.all(promises);
    let combinedPosts = results.flat();

    combinedPosts = deduplicatePosts(combinedPosts);
    combinedPosts = filterByDate(combinedPosts, state.timeFilterHours);
    combinedPosts = filterByLikes(combinedPosts, state.minLikes);
    state.allPosts = sortPosts(combinedPosts, state.searchSort);

    state.lastRefreshAt = new Date();
    state.lastRefreshNewCount = null;
    state.lastRefreshError = null;
    searchCompleted = true;
    updateRefreshMeta();

    hideStatus();
    renderResults();
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

// Load more results
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

    const results = await Promise.all(promises);
    let newPosts = results.flat();

    if (newPosts.length > 0) {
      let combined = [...state.allPosts, ...newPosts];
      combined = deduplicatePosts(combined);
      combined = filterByDate(combined, state.timeFilterHours);
      combined = filterByLikes(combined, state.minLikes);
      state.allPosts = sortPosts(combined, state.searchSort);
      if (state.allPosts.length > prevCount) {
        state.renderLimit = Math.min(state.allPosts.length, state.renderLimit + RENDER_STEP);
      }
      renderResults();
    } else {
      if (loadMoreBtn) {
        loadMoreBtn.remove();
      }
    }
  } catch (error) {
    console.error('Load more error:', error);
    showStatus(`Error loading more: ${error.message}`, 'error');
  } finally {
    state.isLoading = false;
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
  renderResults();
}

export function renderPendingPosts() {
  renderNewPosts();
}
