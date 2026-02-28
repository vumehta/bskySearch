import { PUBLIC_API } from './constants';
import { didCache, state } from './state';
import {
  postUrlInput,
  quoteSearchBtn,
  quoteStatusDiv,
  quoteTabs,
  quoteOriginalDiv,
  quoteCountDiv,
  quoteResultsDiv,
  quoteLoadMoreDiv,
} from './dom';
import {
  formatDateTime,
  getPostTimestamp,
  getPostUrl,
  parseBlueskyPostUrl,
  setText,
} from './utils';
import { enforceDidCacheLimit, getCachedDid } from './cache';
import { setQueryParam, updateURLWithParams } from './url';
import { trackQuoteCursor } from './quotes-state';
import type { BskyPost, QuoteSortMode } from './types';

interface QuoteSortCache {
  quotesRef: BskyPost[] | null;
  sortMode: string;
  sorted: BskyPost[];
}

interface QuotesPageResult {
  posts: BskyPost[];
  cursor: string | null;
}

let quoteSortCache: QuoteSortCache = { quotesRef: null, sortMode: '', sorted: [] };
let lastRenderedQuoteSort: string | null = null;
let lastRenderedQuoteUris: string[] = [];

function resetQuoteRenderCache(): void {
  quoteSortCache = { quotesRef: null, sortMode: '', sorted: [] };
  lastRenderedQuoteSort = null;
  lastRenderedQuoteUris = [];
}

export function updateQuoteURL(): void {
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

export function updateQuoteTabs(): void {
  quoteTabs.querySelectorAll('.quote-tab').forEach((tab) => {
    const tabEl = tab as HTMLElement;
    tabEl.classList.toggle('active', tabEl.dataset.sort === state.quoteSort);
  });
}

function showQuoteStatus(message: string, type: string = 'info'): void {
  quoteStatusDiv.className = `status ${type}`;
  setText(quoteStatusDiv, message);
  quoteStatusDiv.style.display = 'block';
}

function hideQuoteStatus(): void {
  quoteStatusDiv.style.display = 'none';
}

function updateQuoteCount(): void {
  if (Number.isFinite(state.quoteTotalCount)) {
    const total = state.quoteTotalCount!;
    quoteCountDiv.textContent = `Loaded ${state.allQuotes.length} of ${total} quote${total !== 1 ? 's' : ''}`;
    return;
  }
  quoteCountDiv.textContent = `Loaded ${state.allQuotes.length} quote${state.allQuotes.length !== 1 ? 's' : ''}`;
}

function sortQuotes(quotes: BskyPost[], sortMode: QuoteSortMode): BskyPost[] {
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

function getSortedQuotes(quotes: BskyPost[], sortMode: QuoteSortMode): BskyPost[] {
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

function canAppendQuotes(sortedQuotes: BskyPost[], sortMode: string): boolean {
  if (sortMode !== lastRenderedQuoteSort) {
    return false;
  }
  if (lastRenderedQuoteUris.length === 0) {
    return false;
  }
  if (sortedQuotes.length <= lastRenderedQuoteUris.length) {
    return false;
  }

  for (let index = 0; index < lastRenderedQuoteUris.length; index += 1) {
    if (sortedQuotes[index]?.uri !== lastRenderedQuoteUris[index]) {
      return false;
    }
  }

  return true;
}

function createQuoteOriginalElement(post: BskyPost): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'quote-original';

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = 'Original Post';
  wrapper.appendChild(label);

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

  const likeStat = document.createElement('span');
  likeStat.className = 'quote-stat likes';
  likeStat.setAttribute('aria-label', `${post.likeCount || 0} likes`);
  const likeIcon = document.createElement('span');
  likeIcon.setAttribute('aria-hidden', 'true');
  likeIcon.textContent = '\u2665 ';
  likeStat.appendChild(likeIcon);
  likeStat.appendChild(document.createTextNode(String(post.likeCount || 0)));
  stats.appendChild(likeStat);

  const repostStat = document.createElement('span');
  repostStat.className = 'quote-stat reposts';
  repostStat.setAttribute('aria-label', `${post.repostCount || 0} reposts`);
  const repostIcon = document.createElement('span');
  repostIcon.setAttribute('aria-hidden', 'true');
  repostIcon.textContent = '\u21bb ';
  repostStat.appendChild(repostIcon);
  repostStat.appendChild(document.createTextNode(String(post.repostCount || 0)));
  stats.appendChild(repostStat);

  const replyStat = document.createElement('span');
  replyStat.className = 'quote-stat replies';
  replyStat.setAttribute('aria-label', `${post.replyCount || 0} replies`);
  const replyIcon = document.createElement('span');
  replyIcon.setAttribute('aria-hidden', 'true');
  replyIcon.textContent = '\ud83d\udcac ';
  replyStat.appendChild(replyIcon);
  replyStat.appendChild(document.createTextNode(String(post.replyCount || 0)));
  stats.appendChild(replyStat);

  const quoteStat = document.createElement('span');
  quoteStat.className = 'quote-stat';
  quoteStat.textContent = `Quotes ${post.quoteCount || 0}`;
  stats.appendChild(quoteStat);

  wrapper.appendChild(stats);
  return wrapper;
}

function createQuotePostElement(post: BskyPost, index: number): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.className = `quote-post depth-${(index % 8) + 1}`;

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

  const likeStat = document.createElement('span');
  likeStat.className = 'quote-stat likes';
  likeStat.setAttribute('aria-label', `${post.likeCount || 0} likes`);
  const likeIcon = document.createElement('span');
  likeIcon.setAttribute('aria-hidden', 'true');
  likeIcon.textContent = '\u2665 ';
  likeStat.appendChild(likeIcon);
  likeStat.appendChild(document.createTextNode(String(post.likeCount || 0)));
  stats.appendChild(likeStat);

  const repostStat = document.createElement('span');
  repostStat.className = 'quote-stat reposts';
  repostStat.setAttribute('aria-label', `${post.repostCount || 0} reposts`);
  const repostIcon = document.createElement('span');
  repostIcon.setAttribute('aria-hidden', 'true');
  repostIcon.textContent = '\u21bb ';
  repostStat.appendChild(repostIcon);
  repostStat.appendChild(document.createTextNode(String(post.repostCount || 0)));
  stats.appendChild(repostStat);

  const replyStat = document.createElement('span');
  replyStat.className = 'quote-stat replies';
  replyStat.setAttribute('aria-label', `${post.replyCount || 0} replies`);
  const replyIcon = document.createElement('span');
  replyIcon.setAttribute('aria-hidden', 'true');
  replyIcon.textContent = '\ud83d\udcac ';
  replyStat.appendChild(replyIcon);
  replyStat.appendChild(document.createTextNode(String(post.replyCount || 0)));
  stats.appendChild(replyStat);

  wrapper.appendChild(stats);
  return wrapper;
}

function renderQuoteLoadMore(): void {
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

export function renderQuoteResults({ allowAppend = false } = {}): void {
  if (state.allQuotes.length === 0) {
    quoteResultsDiv.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'no-quotes';
    empty.textContent = 'No quotes found for this post.';
    quoteResultsDiv.appendChild(empty);
    lastRenderedQuoteSort = state.quoteSort;
    lastRenderedQuoteUris = [];
    return;
  }

  const sorted = getSortedQuotes(state.allQuotes, state.quoteSort);
  const appendOnly = allowAppend && canAppendQuotes(sorted, state.quoteSort);
  const startIndex = appendOnly ? lastRenderedQuoteUris.length : 0;

  if (!appendOnly) {
    quoteResultsDiv.textContent = '';
  }

  const fragment = document.createDocumentFragment();
  for (let index = startIndex; index < sorted.length; index += 1) {
    fragment.appendChild(createQuotePostElement(sorted[index], index));
  }
  quoteResultsDiv.appendChild(fragment);

  lastRenderedQuoteSort = state.quoteSort;
  lastRenderedQuoteUris = sorted.map((quote) => quote.uri);
}

async function fetchDid(actor: string): Promise<string> {
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
  const did: string | undefined = data.did || data.profile?.did;
  if (!did) {
    throw new Error('Could not resolve DID for that handle.');
  }

  didCache.set(cacheKey, { did, timestamp: Date.now() });
  enforceDidCacheLimit();
  return did;
}

async function fetchOriginalPost(atUri: string): Promise<BskyPost> {
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
  return data.posts[0] as BskyPost;
}

async function fetchQuotesPage(atUri: string, cursor: string | null = null): Promise<QuotesPageResult> {
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

async function loadMoreQuotes(): Promise<void> {
  if (state.isQuoteLoading || !state.activeQuoteUri || !state.quoteCursor) {
    return;
  }

  state.isQuoteLoading = true;
  const loadMoreBtn = document.getElementById('quoteLoadMoreBtn') as HTMLButtonElement | null;
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = 'Loading\u2026';
  }

  try {
    const page = await fetchQuotesPage(state.activeQuoteUri, state.quoteCursor);
    const hasNewQuotes = page.posts.length > 0;
    if (page.posts.length > 0) {
      state.allQuotes = state.allQuotes.concat(page.posts);
    }
    state.quoteCursor = trackQuoteCursor(page.cursor);
    updateQuoteCount();
    if (hasNewQuotes) {
      renderQuoteResults({ allowAppend: true });
    }
    hideQuoteStatus();
  } catch (error) {
    console.error('Load more quotes error:', error);
    showQuoteStatus(`Error loading more quotes: ${(error as Error).message}`, 'error');
  } finally {
    state.isQuoteLoading = false;
    renderQuoteLoadMore();
  }
}

export async function performQuoteSearch(): Promise<void> {
  if (state.isQuoteLoading) return;

  const urlValue = postUrlInput.value.trim();
  if (!urlValue) {
    showQuoteStatus('Please enter a Bluesky post URL.', 'error');
    return;
  }

  state.isQuoteLoading = true;
  quoteSearchBtn.disabled = true;
  showQuoteStatus('Loading quotes\u2026', 'loading');
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
    const did = await fetchDid(actor);
    const atUri = `at://${did}/app.bsky.feed.post/${postId}`;

    state.activeQuoteUri = atUri;

    const [post, quotePage] = await Promise.all([
      fetchOriginalPost(atUri),
      fetchQuotesPage(atUri),
    ]);

    state.allQuotes = quotePage.posts;
    state.quoteCursor = trackQuoteCursor(quotePage.cursor);
    if (Number.isFinite(post.quoteCount) && post.quoteCount! >= state.allQuotes.length) {
      state.quoteTotalCount = post.quoteCount!;
    }

    quoteOriginalDiv.appendChild(createQuoteOriginalElement(post));
    updateQuoteCount();
    quoteTabs.style.display = 'flex';
    hideQuoteStatus();
    renderQuoteResults();
  } catch (error) {
    console.error('Quote search error:', error);
    showQuoteStatus(`Error: ${(error as Error).message}`, 'error');
  } finally {
    state.isQuoteLoading = false;
    quoteSearchBtn.disabled = false;
    renderQuoteLoadMore();
  }
}

export function handleQuoteTabClick(event: Event): void {
  const target = event.target as HTMLElement;
  if (!target.classList.contains('quote-tab')) return;
  const nextSort = target.dataset.sort as QuoteSortMode | undefined;
  if (nextSort && nextSort !== state.quoteSort) {
    state.quoteSort = nextSort;
    updateQuoteTabs();
    updateQuoteURL();
    renderQuoteResults();
  }
}
