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
} from './utils.mjs';
import { enforceDidCacheLimit, getCachedDid } from './cache.mjs';
import { setQueryParam, updateURLWithParams } from './url.mjs';
import { trackQuoteCursor } from './quotes-state.mjs';
import {
  createBlueskyLink,
  createStatsBar,
  hideStatusMessage,
  showStatusMessage,
} from './render.mjs';

export function updateQuoteURL() {
  const params = new URLSearchParams(window.location.search);
  const postValue = postUrlInput.value.trim();
  setQueryParam(params, 'post', postValue);
  if (postValue && state.quoteSort !== 'likes') {
    params.set('sort', state.quoteSort);
  } else {
    params.delete('sort');
  }
  updateURLWithParams(params);
}

export function updateQuoteTabs() {
  quoteTabs.querySelectorAll('.quote-tab').forEach((tab) => {
    const isActive = tab.dataset.sort === state.quoteSort;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });
}

function showQuoteStatus(message, type = 'info') {
  showStatusMessage(quoteStatusDiv, message, type);
}

function hideQuoteStatus() {
  hideStatusMessage(quoteStatusDiv);
}

function updateQuoteCount() {
  if (Number.isFinite(state.quoteTotalCount)) {
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

function createQuoteBaseElement(post, options = {}) {
  const { className = 'quote-post', showLabel = false, index } = options;

  const wrapper = document.createElement('div');
  wrapper.className = index != null ? `${className} depth-${(index % 8) + 1}` : className;

  if (showLabel) {
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = 'Original Post';
    wrapper.appendChild(label);
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
    wrapper.appendChild(createBlueskyLink(postUrl));
  }

  const text = document.createElement('div');
  text.className = 'quote-text';
  text.textContent = post.record?.text || '';
  wrapper.appendChild(text);

  wrapper.appendChild(
    createStatsBar(post, {
      statPrefix: 'quote-stat',
      containerClass: 'quote-stats',
      showQuotes: showLabel,
    })
  );

  return wrapper;
}

function createQuoteOriginalElement(post) {
  return createQuoteBaseElement(post, {
    className: 'quote-original',
    showLabel: true,
  });
}

function createQuotePostElement(post, index) {
  return createQuoteBaseElement(post, { index });
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

export function renderQuoteResults() {
  quoteResultsDiv.textContent = '';
  if (state.allQuotes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'no-quotes';
    empty.textContent = 'No quotes found for this post.';
    quoteResultsDiv.appendChild(empty);
    return;
  }

  const sorted = sortQuotes(state.allQuotes, state.quoteSort);
  sorted.forEach((quote, index) => {
    quoteResultsDiv.appendChild(createQuotePostElement(quote, index));
  });
}

async function fetchDid(actor) {
  const cacheKey = actor.toLowerCase();
  const cached = getCachedDid(cacheKey);
  if (cached) {
    return cached;
  }

  const response = await fetch(
    `${PUBLIC_API}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`
  );
  if (!response.ok) {
    throw new Error(`Profile fetch failed: ${response.status}`);
  }
  const data = await response.json();
  const did = data.did || data.profile?.did;
  if (!did) {
    throw new Error('Could not resolve DID for that handle.');
  }

  didCache.set(cacheKey, { did, timestamp: Date.now() });
  enforceDidCacheLimit();
  return did;
}

async function fetchOriginalPost(atUri) {
  const response = await fetch(
    `${PUBLIC_API}/app.bsky.feed.getPosts?uris=${encodeURIComponent(atUri)}`
  );
  if (!response.ok) {
    throw new Error(`Original post fetch failed: ${response.status}`);
  }
  const data = await response.json();
  if (!data.posts || data.posts.length === 0) {
    throw new Error('Post not found.');
  }
  return data.posts[0];
}

async function fetchQuotesPage(atUri, cursor = null) {
  let url = `${PUBLIC_API}/app.bsky.feed.getQuotes?uri=${encodeURIComponent(atUri)}&limit=100`;
  if (cursor) {
    url += `&cursor=${encodeURIComponent(cursor)}`;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Quotes fetch failed: ${response.status}`);
  }
  const data = await response.json();
  return {
    posts: Array.isArray(data.posts) ? data.posts : [],
    cursor: data.cursor || null,
  };
}

async function loadMoreQuotes() {
  if (state.isQuoteLoading || !state.activeQuoteUri || !state.quoteCursor) {
    return;
  }

  state.isQuoteLoading = true;
  const loadMoreBtn = document.getElementById('quoteLoadMoreBtn');
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = 'Loading…';
  }

  try {
    const page = await fetchQuotesPage(state.activeQuoteUri, state.quoteCursor);
    if (page.posts.length > 0) {
      state.allQuotes = state.allQuotes.concat(page.posts);
    }
    state.quoteCursor = trackQuoteCursor(page.cursor);
    updateQuoteCount();
    renderQuoteResults();
    hideQuoteStatus();
  } catch (error) {
    console.error('Load more quotes error:', error);
    showQuoteStatus(`Error loading more quotes: ${error.message}`, 'error');
  } finally {
    state.isQuoteLoading = false;
    renderQuoteLoadMore();
  }
}

export async function performQuoteSearch() {
  if (state.isQuoteLoading) return;

  const urlValue = postUrlInput.value.trim();
  if (!urlValue) {
    showQuoteStatus('Please enter a Bluesky post URL.', 'error');
    return;
  }

  state.isQuoteLoading = true;
  quoteSearchBtn.disabled = true;
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

  updateQuoteURL();

  try {
    const { actor, postId } = parseBlueskyPostUrl(urlValue);
    const did = await fetchDid(actor);
    const atUri = `at://${did}/app.bsky.feed.post/${postId}`;

    state.activeQuoteUri = atUri;

    const [post, quotePage] = await Promise.all([
      fetchOriginalPost(atUri),
      fetchQuotesPage(atUri),
    ]);

    state.allQuotes = quotePage.posts;
    state.quoteCursor = trackQuoteCursor(quotePage.cursor);
    if (Number.isFinite(post.quoteCount) && post.quoteCount >= state.allQuotes.length) {
      state.quoteTotalCount = post.quoteCount;
    }

    quoteOriginalDiv.appendChild(createQuoteOriginalElement(post));
    updateQuoteCount();
    quoteTabs.style.display = 'flex';
    hideQuoteStatus();
    renderQuoteResults();
  } catch (error) {
    console.error('Quote search error:', error);
    showQuoteStatus(`Error: ${error.message}`, 'error');
  } finally {
    state.isQuoteLoading = false;
    quoteSearchBtn.disabled = false;
    renderQuoteLoadMore();
  }
}

export function handleQuoteTabClick(event) {
  if (!event.target.classList.contains('quote-tab')) return;
  const nextSort = event.target.dataset.sort;
  if (nextSort && nextSort !== state.quoteSort) {
    state.quoteSort = nextSort;
    updateQuoteTabs();
    updateQuoteURL();
    renderQuoteResults();
  }
}
