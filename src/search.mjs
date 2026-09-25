import {
  INITIAL_MAX_PAGES,
  INITIAL_RENDER_LIMIT,
  MIN_LIKES_DEBOUNCE_MS,
  RENDER_STEP,
  SEARCH_API,
  SEARCH_DEBOUNCE_MS,
  SEARCH_CONCURRENCY,
  SEARCH_REQUEST_TIMEOUT_MS,
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
  getProfileUrl,
  getSearchCacheKey,
  getSearchSince,
  isValidBskyUrl,
  normalizeSortValue,
  normalizeTerm,
  sortPosts,
} from './utils.mjs';
import { appendAuthorBadges } from './author-badges.mjs';
import { appendPostEmbeds } from './post-embeds.mjs';
import { appendEngagementStats, SEARCH_STAT_CLASSES } from './post-stats.mjs';
import { enforceSearchCacheLimit, getCachedSearch } from './cache.mjs';
import { fetchJson } from './http.mjs';
import { getEmbedPreviews } from './post-data.mjs';
import { createHighlightMatcher, getMatchedTermsForPost, getPostRenderFingerprint, ingestSearchPosts, nextSearchCursor, settleWithConcurrency, validateSearchPage } from './search-model.mjs';
import { setQueryParam, updateURLWithParams } from './url.mjs';
import { cancelThreadRequest, cancelThreadRequests, initializeThreadToggle, isReplyPost, moveThreadContext, toggleThread } from './thread.mjs';
import { cancelTopicScoring, dropQueuedTopicScores, getTopicProgress, getTopicVerdict, requestTopicScores, resetTopicScoring } from './topic-filter.mjs';

const DERIVE_THROTTLE_MS = 120;
const SORT_LABELS = {
  top: 'Sorted by likes (high to low)',
  latest: 'Sorted by time (newest first)',
  bookmarks: 'Sorted by saves (high to low)',
};

const ingestedPostsByUri = new Map();
let activeSearchController = null;
const searchSeenCursors = new Map();
let deriveTimerId = null;
let minLikesTimerId = null;

let pendingRenderFrame = null;

let resultsHeaderEl = null;
let resultsCountEl = null;
let resultsSortEl = null;
let resultsEmptyEl = null;
let resultsEmptyPrimaryEl = null;
let resultsEmptySecondaryEl = null;
let resultsTopicEl = null;
let resultsTopicTextEl = null;
let resultsTopicBtnEl = null;
let resultsListEl = null;
let showMoreBtnEl = null;
let loadMoreBtnEl = null;
const renderedPosts = new Map();
let nextImagesId = 0;

let topicSummary = null;

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
  setQueryParam(params, 'topic', state.hideOffTopic ? '1' : '');
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
    data = validateSearchPage(await fetchJson(`${SEARCH_API}?${params}`, { signal, timeoutMs: SEARCH_REQUEST_TIMEOUT_MS }));
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
  cancelTopicScoring();
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
    sort: state.searchSort === 'latest' ? 'latest' : 'top',
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

function applyTopicFilter(posts) {
  if (!state.hideOffTopic) {
    topicSummary = null;
    return posts;
  }
  const kept = [];
  let hidden = 0;
  for (const post of posts) {
    const { verdict, score, keptFor } = getTopicVerdict(post);
    if (verdict !== 'off') {
      kept.push(score !== null ? { ...post, topicMatch: { offTopic: false, score, keptFor } } : post);
      continue;
    }
    hidden += 1;
    if (state.showOffTopic) kept.push({ ...post, topicMatch: { offTopic: true, score } });
  }
  const generation = state.searchGeneration;
  if (!minLikesTimerId) {
    requestTopicScores(posts, () => {
      if (isCurrentSearchGeneration(generation)) scheduleDerivedPostsRebuild();
    });
  }
  topicSummary = { checked: posts.length, hidden, ...getTopicProgress(posts) };
  return kept;
}

function recomputeDerivedPosts() {
  let derived = Array.from(ingestedPostsByUri.values());
  derived = filterByDate(derived, state.timeFilterHours);
  derived = filterByLikes(derived, state.minLikes);
  state.allPosts = applyTopicFilter(sortPosts(derived, state.searchSort));
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

function syncTopicMatch(postElement, topicMatch) {
  const offTopic = Boolean(topicMatch?.offTopic);
  postElement.classList.toggle('off-topic', offTopic);
  const termsDiv = postElement.querySelector('.search-terms');
  let tag = termsDiv.querySelector('.topic-score-tag') || termsDiv.querySelector('.off-topic-tag');
  if (!topicMatch) {
    tag?.remove();
    return;
  }
  if (!tag) {
    tag = document.createElement('span');
    termsDiv.appendChild(tag);
  }
  tag.className = offTopic ? 'term-tag off-topic-tag' : 'term-tag topic-score-tag';
  const match = `${Math.round(topicMatch.score * 100)}% match`;
  const label = offTopic ? 'Off-topic' : topicMatch.keptFor;
  tag.textContent = label ? `${label} \xB7 ${match}` : match;
}

function findByFocusKey(element, key) {
  if (element.dataset?.focusKey === key) return element;
  for (const child of Array.from(element.children || [])) {
    const found = findByFocusKey(child, key);
    if (found) return found;
  }
  return null;
}

function focusWithin(element) {
  const active = document.activeElement;
  return active && element.contains?.(active) ? active : null;
}

function focusCard(card) {
  if (!card) return;
  card.tabIndex = -1;
  card.focus();
}

function createPostElement(post, { imagesShown = false } = {}) {
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

  const nameLink = document.createElement('a');
  nameLink.className = 'display-name';
  nameLink.dataset.focusKey = 'profile';
  nameLink.href = getProfileUrl(post.author);
  nameLink.target = '_blank';
  nameLink.rel = 'noopener noreferrer';
  nameLink.textContent = displayName;
  authorInfo.appendChild(nameLink);

  const handleSpan = document.createElement('span');
  handleSpan.className = 'handle';
  handleSpan.textContent = `@${handle}`;
  authorInfo.appendChild(handleSpan);
  appendAuthorBadges(authorInfo, post.author);

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

  const previews = getEmbedPreviews(post.embed);
  const validImages = previews?.images.filter((img) => img.thumb && isValidBskyUrl(img.thumb)) ?? [];

  if (validImages.length > 0) {
    const imagesContainer = document.createElement('div');
    imagesContainer.className = 'post-images-container';

    const placeholder = document.createElement('div');
    placeholder.className = 'image-placeholder';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'image-toggle';
    toggle.dataset.focusKey = 'images';
    const count = validImages.length;
    const noun = previews.kind === 'video' ? 'video preview' : `${count} image${count !== 1 ? 's' : ''}`;
    let imagesDiv = null;
    const showImages = (shown) => {
      if (shown && !imagesDiv) {
        imagesDiv = document.createElement('div');
        imagesDiv.id = `post-images-${++nextImagesId}`;
        imagesDiv.className = `post-images ${count === 1 ? 'single' : 'multiple'}`;
        validImages.forEach((img) => {
          const imgEl = document.createElement('img');
          imgEl.className = 'post-image';
          imgEl.src = img.thumb;
          imgEl.alt = img.alt || '';
          imgEl.loading = 'lazy';
          imagesDiv.appendChild(imgEl);
        });
        imagesContainer.appendChild(imagesDiv);
        toggle.setAttribute('aria-controls', imagesDiv.id);
      }
      if (imagesDiv) imagesDiv.style.display = shown ? '' : 'none';
      placeholder.classList.toggle('revealed', shown);
      toggle.setAttribute('aria-expanded', String(shown));
      toggle.textContent = `${shown ? 'Hide' : 'Show'} ${noun}`;
    };
    toggle.addEventListener('click', () => showImages(toggle.getAttribute('aria-expanded') !== 'true'));
    showImages(imagesShown);

    placeholder.appendChild(toggle);
    imagesContainer.appendChild(placeholder);
    postDiv.appendChild(imagesContainer);
  }

  appendPostEmbeds(postDiv, post.embed, (value) => createHighlightedText(value, state.searchTerms));

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
      threadLink.dataset.focusKey = 'thread';
      threadLink.textContent = 'View Thread';
      initializeThreadToggle(threadLink);
      threadLink.addEventListener('click', () => toggleThread(post, postDiv));
      linksDiv.appendChild(threadLink);
    }
    const blueskyLink = document.createElement('a');
    blueskyLink.className = 'thread-link';
    blueskyLink.dataset.focusKey = 'bluesky';
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
  resultsTopicEl = null;
  resultsTopicTextEl = null;
  resultsTopicBtnEl = null;
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

  resultsTopicEl = document.createElement('div');
  resultsTopicEl.className = 'topic-summary';
  resultsTopicTextEl = document.createElement('span');
  resultsTopicEl.appendChild(resultsTopicTextEl);
  resultsTopicBtnEl = document.createElement('button');
  resultsTopicBtnEl.className = 'topic-reveal';
  resultsTopicBtnEl.type = 'button';
  resultsTopicBtnEl.addEventListener('click', () => {
    state.showOffTopic = !state.showOffTopic;
    flushDerivedPostsRebuild();
    renderResults();
  });
  resultsTopicEl.appendChild(resultsTopicBtnEl);

  resultsListEl = document.createElement('div');

  showMoreBtnEl = document.createElement('button');
  showMoreBtnEl.className = 'load-more';
  showMoreBtnEl.type = 'button';
  showMoreBtnEl.addEventListener('click', () => {
    const shownBefore = resultsListEl.children.length;
    const hadFocus = document.activeElement === showMoreBtnEl;
    increaseRenderLimit();
    renderResults();
    if (hadFocus && showMoreBtnEl.style.display === 'none') focusCard(resultsListEl.children[shownBefore]);
  });

  loadMoreBtnEl = document.createElement('button');
  loadMoreBtnEl.className = 'load-more';
  loadMoreBtnEl.id = 'loadMoreBtn';
  loadMoreBtnEl.type = 'button';
  loadMoreBtnEl.textContent = 'Load More Results';
  loadMoreBtnEl.addEventListener('click', loadMore);

  resultsDiv.appendChild(resultsHeaderEl);
  resultsDiv.appendChild(resultsTopicEl);
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
      const imagesShown = postElement?.querySelector('.image-toggle')?.getAttribute('aria-expanded') === 'true';
      const nextElement = createPostElement(post, { imagesShown });

      if (postElement?.parentNode === resultsListEl) {
        const focusKey = focusWithin(postElement)?.dataset?.focusKey;
        cancelThreadRequest(postElement);
        moveThreadContext(postElement, nextElement);
        resultsListEl.replaceChild(nextElement, postElement);
        if (focusKey) findByFocusKey(nextElement, focusKey)?.focus();
      }

      postElement = nextElement;
      renderedPosts.set(uri, { element: postElement, fingerprint: nextFingerprint });
    }
    syncTopicMatch(postElement, post.topicMatch);

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
    if (document.activeElement === loadMoreBtnEl && loadMoreBtnEl.style.display !== 'none') {
      focusCard(state.allPosts.length > 0 ? resultsListEl.lastElementChild : resultsEmptyEl);
    }
    loadMoreBtnEl.style.display = 'none';
    loadMoreBtnEl.removeAttribute('aria-disabled');
    loadMoreBtnEl.textContent = 'Load More Results';
    return;
  }

  loadMoreBtnEl.style.display = '';
  if (state.isLoading || state.searchDebounceTimer !== null) loadMoreBtnEl.setAttribute('aria-disabled', 'true');
  else loadMoreBtnEl.removeAttribute('aria-disabled');
  loadMoreBtnEl.textContent = state.isLoading ? 'Loading…' : 'Load More Results';
}

function syncTopicSummary() {
  const summary = topicSummary;
  if (!summary || (summary.checked === 0 && !summary.unavailableReason)) {
    resultsTopicEl.style.display = 'none';
    return;
  }
  const count = (value) => `${value} ${value === 1 ? 'post' : 'posts'}`;
  const parts = [];
  if (summary.pending > 0) parts.push(`Checking ${count(summary.pending)} for topic…`);
  if (summary.paused) parts.push('Pausing briefly to stay within the topic check rate limit.');
  if (summary.hidden > 0) {
    parts.push(`${summary.hidden} off-topic ${summary.hidden === 1 ? 'post' : 'posts'} ${state.showOffTopic ? 'shown dimmed' : 'hidden'}.`);
  }
  if (summary.unavailableReason) {
    parts.push(`Topic filter unavailable: ${summary.unavailableReason.replace(/\.$/, '')}. Unchecked posts stay visible.`);
  } else if (summary.failed > 0) {
    parts.push(`${count(summary.failed)} could not be checked and ${summary.failed === 1 ? 'stays' : 'stay'} visible.`);
  }
  if (parts.length === 0) parts.push('No off-topic posts found.');
  resultsTopicEl.style.display = '';
  resultsTopicTextEl.textContent = parts.join(' ');
  resultsTopicBtnEl.style.display = summary.hidden > 0 ? '' : 'none';
  resultsTopicBtnEl.textContent = state.showOffTopic ? 'Hide them again' : 'Show them';
  resultsTopicBtnEl.setAttribute('aria-pressed', String(state.showOffTopic));
}

function renderResults() {
  ensureResultsShell();
  syncTopicSummary();

  const totalCount = state.allPosts.length;
  const visibleCount = Math.min(state.renderLimit, totalCount);

  if (totalCount === 0) {
    resultsHeaderEl.style.display = 'none';
    resultsListEl.style.display = 'none';
    showMoreBtnEl.style.display = 'none';
    resultsEmptyEl.style.display = 'block';
    resultsEmptyPrimaryEl.textContent = 'No loaded posts match your criteria.';
    resultsEmptySecondaryEl.textContent = Object.values(state.currentCursors).some((cursor) => cursor !== null)
      ? 'Load more results to continue searching, or lower the minimum likes.'
      : 'Try different search terms or lower the minimum likes.';
    syncLoadMoreButton();
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
  resultsSortEl.textContent = SORT_LABELS[state.searchSort];

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

export async function performSearch() {
  cancelDebouncedSearch();
  cancelDebouncedMinLikesFilter();
  cancelActiveSearch();
  const termsValue = termsInput.value.trim();
  state.rawSearchTerms = termsValue.split(',').map(normalizeTerm).filter(Boolean);
  state.searchTerms = expandSearchTerms(state.rawSearchTerms, expandTermsToggle.checked);
  state.minLikes = Math.max(0, parseInt(minLikesInput.value, 10) || 0);
  state.timeFilterHours = parseInt(timeFilterSelect.value, 10) || 24;
  state.searchSort = normalizeSortValue(sortSelect.value);
  state.searchSince = state.searchTerms.length ? getSearchSince(state.timeFilterHours) : null;
  state.allPosts = [];
  state.currentCursors = Object.create(null);
  for (const term of state.searchTerms) state.currentCursors[term] = '';
  searchSeenCursors.clear();
  ingestedPostsByUri.clear();
  resetTopicScoring();
  state.showOffTopic = false;
  topicSummary = null;
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

function cancelDebouncedMinLikesFilter() {
  if (minLikesTimerId) {
    clearTimeout(minLikesTimerId);
    minLikesTimerId = null;
  }
}

export function debouncedMinLikesFilter() {
  cancelDebouncedMinLikesFilter();
  if (state.hideOffTopic) dropQueuedTopicScores();
  minLikesTimerId = setTimeout(() => {
    minLikesTimerId = null;
    applyMinLikesFilter();
  }, MIN_LIKES_DEBOUNCE_MS);
}

function syncMinLikes() {
  cancelDebouncedMinLikesFilter();
  const minLikes = Math.max(0, parseInt(minLikesInput.value, 10) || 0);
  if (state.hideOffTopic && minLikes > state.minLikes) {
    dropQueuedTopicScores();
  }
  state.minLikes = minLikes;
}

export function applyMinLikesFilter() {
  syncMinLikes();
  updateSearchURL();
  if (!state.searchTerms.length) return;
  flushDerivedPostsRebuild();
  renderResults();
}

export function applyTopicFilterChange(enabled) {
  syncMinLikes();
  state.hideOffTopic = Boolean(enabled);
  state.showOffTopic = false;
  resetTopicScoring();
  updateSearchURL();
  if (!state.searchTerms.length) return;
  flushDerivedPostsRebuild();
  renderResults();
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
  cancelDebouncedMinLikesFilter();
  cancelActiveSearch();
  state.allPosts = [];
  state.currentCursors = Object.create(null);
  searchSeenCursors.clear();
  state.rawSearchTerms = [];
  state.searchTerms = [];
  state.searchSince = null;
  ingestedPostsByUri.clear();
  resetTopicScoring();
  state.showOffTopic = false;
  topicSummary = null;
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
