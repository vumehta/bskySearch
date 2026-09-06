import { PUBLIC_API } from './constants.mjs';
import { didCache, state } from './state.mjs';
import {
  postUrlInput,
  quoteSearchBtn,
  quoteStatusDiv,
  quoteTabs,
  quoteOriginalDiv,
  quoteCountDiv,
  quoteResultsDiv,
  quoteLoadMoreDiv,
} from './dom.mjs';
import {
  formatDateTime,
  getPostTimestamp,
  getPostUrl,
  parseBlueskyPostUrl,
  setText,
} from './utils.mjs';
import { appendEngagementStats, QUOTE_STAT_CLASSES } from './post-stats.mjs';
import { enforceDidCacheLimit, getCachedDid } from './cache.mjs';
import { setQueryParam, updateURLWithParams } from './url.mjs';
import { mergeQuotes, trackQuoteCursor } from './quotes-state.mjs';
import { fetchJson } from './http.mjs';
import { isRenderablePost } from './post-data.mjs';

let quoteSortCache = { quotesRef: null, sortMode: '', sorted: [] };
let lastRenderedQuoteSort = null;
let lastRenderedQuotes = [];
let quoteGeneration = 0;
let quoteController = null;

function resetQuoteRenderCache() {
  quoteSortCache = { quotesRef: null, sortMode: '', sorted: [] };
  lastRenderedQuoteSort = null;
  lastRenderedQuotes = [];
}

export function updateQuoteURL() {
  const params = new URLSearchParams(window.location.search);
  const postValue = postUrlInput.value.trim();
  setQueryParam(params, 'post', postValue);
  if (postValue && state.quoteSort !== 'likes') {
    params.set('quoteSort', state.quoteSort);
  } else {
    params.delete('quoteSort');
  }
  params.delete('sort');
  updateURLWithParams(params);
}

export function updateQuoteTabs() {
  quoteTabs.querySelectorAll('.quote-tab').forEach((tab) => {
    const selected = tab.dataset.sort === state.quoteSort;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-pressed', String(selected));
  });
}

function showQuoteStatus(message, type) {
  quoteStatusDiv.className = `status ${type}`;
  setText(quoteStatusDiv, message);
  quoteStatusDiv.style.display = 'block';
}

function hideQuoteStatus() {
  quoteStatusDiv.style.display = 'none';
}

function updateQuoteCount() {
  if (Number.isFinite(state.quoteTotalCount) && state.quoteTotalCount >= state.allQuotes.length) {
    const total = state.quoteTotalCount;
    quoteCountDiv.textContent = `Loaded ${state.allQuotes.length} of ${total} quote${total !== 1 ? 's' : ''}`;
    return;
  }
  quoteCountDiv.textContent = `Loaded ${state.allQuotes.length} quote${state.allQuotes.length !== 1 ? 's' : ''}`;
}

function sortQuotes(quotes, sortMode) {
  const sorted = [...quotes];
  switch (sortMode) {
    case 'likes':
      sorted.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
      break;
    case 'recent':
      sorted.sort((a, b) => getPostTimestamp(b) - getPostTimestamp(a));
      break;
    case 'oldest':
      sorted.sort((a, b) => getPostTimestamp(a) - getPostTimestamp(b));
      break;
    default:
      break;
  }
  return sorted;
}

function getSortedQuotes(quotes, sortMode) {
  if (quoteSortCache.quotesRef === quotes && quoteSortCache.sortMode === sortMode) {
    return quoteSortCache.sorted;
  }
  const sorted = sortQuotes(quotes, sortMode);
  quoteSortCache = {
    quotesRef: quotes,
    sortMode,
    sorted,
  };
  return sorted;
}

function canAppendQuotes(sortedQuotes, sortMode) {
  if (sortMode !== lastRenderedQuoteSort) {
    return false;
  }
  if (lastRenderedQuotes.length === 0) {
    return false;
  }
  if (sortedQuotes.length <= lastRenderedQuotes.length) {
    return false;
  }

  for (let index = 0; index < lastRenderedQuotes.length; index += 1) {
    if (sortedQuotes[index] !== lastRenderedQuotes[index]) {
      return false;
    }
  }

  return true;
}

// Shared layout for the original post card and each quote card. They differ only
// in the wrapper class, the leading label, and the trailing quote-count stat.
function createQuoteCard(post, { className, label = '', includeQuoteCount = false }) {
  const wrapper = document.createElement('div');
  wrapper.className = className;

  if (label) {
    const labelEl = document.createElement('div');
    labelEl.className = 'label';
    labelEl.textContent = label;
    wrapper.appendChild(labelEl);
  }

  const author = document.createElement('div');
  author.className = 'quote-author';
  const authorName = post.author.displayName || post.author.handle;
  author.textContent = `${authorName} (@${post.author.handle})`;
  wrapper.appendChild(author);

  const meta = document.createElement('div');
  meta.className = 'quote-meta';
  const time = document.createElement('span');
  time.textContent = formatDateTime(post.record?.createdAt || post.indexedAt);
  meta.appendChild(time);
  wrapper.appendChild(meta);

  const postUrl = getPostUrl(post);
  if (postUrl) {
    const actions = document.createElement('div');
    actions.className = 'link-actions';

    const link = document.createElement('a');
    link.className = 'thread-link';
    link.href = postUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'View on Bluesky';
    actions.appendChild(link);

    wrapper.appendChild(actions);
  }

  const text = document.createElement('div');
  text.className = 'quote-text';
  text.textContent = post.record?.text || '';
  wrapper.appendChild(text);

  const stats = document.createElement('div');
  stats.className = 'quote-stats';
  appendEngagementStats(stats, post, QUOTE_STAT_CLASSES);

  if (includeQuoteCount) {
    const quoteStat = document.createElement('span');
    quoteStat.className = 'quote-stat';
    quoteStat.textContent = `Quotes ${post.quoteCount || 0}`;
    stats.appendChild(quoteStat);
  }

  wrapper.appendChild(stats);
  return wrapper;
}

function createQuoteOriginalElement(post) {
  return createQuoteCard(post, {
    className: 'quote-original',
    label: 'Original Post',
    includeQuoteCount: true,
  });
}

function createQuotePostElement(post, index) {
  return createQuoteCard(post, { className: `quote-post depth-${(index % 8) + 1}` });
}

function renderQuoteLoadMore() {
  quoteLoadMoreDiv.textContent = '';
  if (!state.quoteCursor) {
    return;
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'load-more';
  button.id = 'quoteLoadMoreBtn';
  button.textContent = 'Load More Quotes';
  button.disabled = state.isQuoteLoading;
  button.addEventListener('click', loadMoreQuotes);
  quoteLoadMoreDiv.appendChild(button);
}

export function renderQuoteResults({ allowAppend = false } = {}) {
  if (state.allQuotes.length === 0) {
    quoteResultsDiv.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'no-quotes';
    empty.textContent = 'No quotes found for this post.';
    quoteResultsDiv.appendChild(empty);
    lastRenderedQuoteSort = state.quoteSort;
    lastRenderedQuotes = [];
    return;
  }

  const sorted = getSortedQuotes(state.allQuotes, state.quoteSort);
  const appendOnly = allowAppend && canAppendQuotes(sorted, state.quoteSort);
  const startIndex = appendOnly ? lastRenderedQuotes.length : 0;

  if (!appendOnly) {
    quoteResultsDiv.textContent = '';
  }

  const fragment = document.createDocumentFragment();
  for (let index = startIndex; index < sorted.length; index += 1) {
    fragment.appendChild(createQuotePostElement(sorted[index], index));
  }
  quoteResultsDiv.appendChild(fragment);

  lastRenderedQuoteSort = state.quoteSort;
  lastRenderedQuotes = sorted;
}

async function fetchDid(actor, signal) {
  if (actor.startsWith('did:')) return actor;
  const cacheKey = actor.toLowerCase();
  const cached = getCachedDid(cacheKey);
  if (cached) {
    return cached;
  }

  const data = await fetchJson(
    `${PUBLIC_API}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`,
    { signal }
  );
  const did = data?.did || data?.profile?.did;
  if (typeof did !== 'string' || !did.startsWith('did:')) {
    throw new Error('Could not resolve DID for that handle.');
  }

  didCache.set(cacheKey, { did, timestamp: Date.now() });
  enforceDidCacheLimit();
  return did;
}

function validatePosts(data) {
  if (!Array.isArray(data?.posts) || !data.posts.every(isRenderablePost)) {
    throw new Error('The server returned invalid post data.');
  }
  return data.posts;
}

async function fetchOriginalPost(atUri, signal) {
  const data = await fetchJson(
    `${PUBLIC_API}/app.bsky.feed.getPosts?uris=${encodeURIComponent(atUri)}`,
    { signal }
  );
  const posts = validatePosts(data);
  if (posts.length === 0) {
    throw new Error('Post not found.');
  }
  return posts[0];
}

async function fetchQuotesPage(atUri, cursor = null, signal) {
  let url = `${PUBLIC_API}/app.bsky.feed.getQuotes?uri=${encodeURIComponent(atUri)}&limit=100`;
  if (cursor) {
    url += `&cursor=${encodeURIComponent(cursor)}`;
  }

  const data = await fetchJson(url, { signal });
  if (data?.cursor != null && typeof data.cursor !== 'string') {
    throw new Error('The server returned an invalid pagination cursor.');
  }
  return {
    posts: validatePosts(data),
    cursor: data.cursor || null,
  };
}

export async function loadMoreQuotes() {
  if (state.isQuoteLoading || !state.activeQuoteUri || !state.quoteCursor) {
    return;
  }

  const generation = quoteGeneration;
  const controller = quoteController;
  state.isQuoteLoading = true;
  const loadMoreBtn = document.getElementById('quoteLoadMoreBtn');
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = 'Loading…';
  }

  try {
    const page = await fetchQuotesPage(state.activeQuoteUri, state.quoteCursor, controller?.signal);
    if (generation !== quoteGeneration) return;
    const hasNewQuotes = page.posts.length > 0;
    if (page.posts.length > 0) {
      state.allQuotes = mergeQuotes(state.allQuotes, page.posts);
    }
    state.quoteCursor = trackQuoteCursor(page.cursor);
    updateQuoteCount();
    if (hasNewQuotes) {
      renderQuoteResults({ allowAppend: true });
    }
    hideQuoteStatus();
  } catch (error) {
    if (generation !== quoteGeneration || controller?.signal.aborted) return;
    console.error('Load more quotes error:', error);
    showQuoteStatus(`Error loading more quotes: ${error.message}`, 'error');
  } finally {
    if (generation === quoteGeneration) {
      state.isQuoteLoading = false;
      renderQuoteLoadMore();
    }
  }
}

export async function performQuoteSearch() {
  const urlValue = postUrlInput.value.trim();
  if (!urlValue) {
    showQuoteStatus('Please enter a Bluesky post URL.', 'error');
    return;
  }

  quoteController?.abort();
  const controller = new AbortController();
  quoteController = controller;
  const generation = ++quoteGeneration;
  state.isQuoteLoading = true;
  // A new post submission replaces the current search or pagination request.
  quoteSearchBtn.disabled = false;
  showQuoteStatus('Loading quotes…', 'loading');
  quoteTabs.style.display = 'none';
  quoteResultsDiv.textContent = '';
  quoteOriginalDiv.textContent = '';
  quoteCountDiv.textContent = '';
  quoteLoadMoreDiv.textContent = '';
  state.allQuotes = [];
  state.quoteCursor = null;
  state.quoteSeenCursors = new Set();
  state.quoteTotalCount = null;
  state.activeQuoteUri = null;
  resetQuoteRenderCache();

  updateQuoteURL();

  try {
    const { actor, postId } = parseBlueskyPostUrl(urlValue);
    const did = await fetchDid(actor, controller.signal);
    if (generation !== quoteGeneration) return;
    const atUri = `at://${did}/app.bsky.feed.post/${postId}`;

    state.activeQuoteUri = atUri;

    const [post, quotePage] = await Promise.all([
      fetchOriginalPost(atUri, controller.signal),
      fetchQuotesPage(atUri, null, controller.signal),
    ]);
    if (generation !== quoteGeneration) return;

    state.allQuotes = mergeQuotes([], quotePage.posts);
    state.quoteCursor = trackQuoteCursor(quotePage.cursor);
    if (Number.isFinite(post.quoteCount) && post.quoteCount >= state.allQuotes.length) {
      state.quoteTotalCount = post.quoteCount;
    }

    quoteOriginalDiv.appendChild(createQuoteOriginalElement(post));
    updateQuoteCount();
    quoteTabs.style.display = 'flex';
    updateQuoteTabs();
    hideQuoteStatus();
    renderQuoteResults();
  } catch (error) {
    if (generation !== quoteGeneration || controller.signal.aborted) return;
    // Cancel a still-running sibling (original post or quotes page).
    controller.abort();
    state.activeQuoteUri = null;
    state.quoteCursor = null;
    state.allQuotes = [];
    state.quoteTotalCount = null;
    quoteOriginalDiv.textContent = '';
    quoteResultsDiv.textContent = '';
    quoteCountDiv.textContent = '';
    console.error('Quote search error:', error);
    showQuoteStatus(`Error: ${error.message}`, 'error');
  } finally {
    if (generation === quoteGeneration) {
      state.isQuoteLoading = false;
      quoteSearchBtn.disabled = false;
      renderQuoteLoadMore();
    }
  }
}

export function handleQuoteTabClick(event) {
  if (!event.target.classList.contains('quote-tab')) return;
  const nextSort = event.target.dataset.sort;
  if (['likes', 'recent', 'oldest'].includes(nextSort) && nextSort !== state.quoteSort) {
    state.quoteSort = nextSort;
    updateQuoteTabs();
    updateQuoteURL();
    renderQuoteResults();
  }
}
