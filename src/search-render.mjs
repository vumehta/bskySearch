import { INITIAL_RENDER_LIMIT, RENDER_STEP } from './constants.mjs';
import { state } from './state.mjs';
import {
  newPostsDiv,
  resultsDiv,
  statusDiv,
} from './dom.mjs';
import {
  formatRelativeTime,
  getPostTimestamp,
  getPostUrl,
  isValidBskyUrl,
} from './utils.mjs';
import { isReplyPost, toggleThread } from './thread.mjs';
import {
  createAuthorHeader,
  createStatsBar,
  hideStatusMessage,
  showStatusMessage,
} from './render.mjs';

// Status helpers
export function showStatus(message, type = 'info') {
  showStatusMessage(statusDiv, message, type);
}

export function hideStatus() {
  hideStatusMessage(statusDiv);
}

export function clearNewPostHighlightsFromDOM() {
  resultsDiv.querySelectorAll('.new-post').forEach((el) => el.classList.remove('new-post'));
}

// Render limit management
export function resetRenderLimit() {
  state.renderLimit = INITIAL_RENDER_LIMIT;
}

export function increaseRenderLimit(step = RENDER_STEP) {
  state.renderLimit = Math.min(state.allPosts.length, state.renderLimit + step);
}

// Coalesce progressive renders into a single frame
let pendingRenderFrame = null;
let pendingRenderHandlers = null;

export function scheduleRender(handlers = {}) {
  pendingRenderHandlers = handlers;
  if (pendingRenderFrame !== null) {
    return;
  }
  pendingRenderFrame = requestAnimationFrame(() => {
    const handlersForFrame = pendingRenderHandlers || {};
    pendingRenderHandlers = null;
    pendingRenderFrame = null;
    renderResults(handlersForFrame);
  });
}

// Cache compiled highlight regex — reused for every post in a single search
let highlightRegexCache = { terms: null, regex: null };

// Create text with highlighted search terms using DOM methods (safe)
function createHighlightedText(text, terms) {
  const fragment = document.createDocumentFragment();
  if (!text) return fragment;

  let regex;
  if (terms === highlightRegexCache.terms) {
    regex = highlightRegexCache.regex;
  } else {
    const escapedTerms = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi');
    highlightRegexCache = { terms, regex };
  }

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

  // Header (avatar, author, time)
  postDiv.appendChild(createAuthorHeader(post, { timeText: formatRelativeTime(post.indexedAt) }));

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

  // Stats
  postDiv.appendChild(createStatsBar(post));

  // Links container
  const linksDiv = document.createElement('div');
  linksDiv.className = 'link-actions';

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

// --- Header & buttons helpers (lightweight, always rebuilt) ---

function updateResultsHeader(visibleCount, totalCount) {
  const existing = resultsDiv.querySelector('.results-header');
  if (existing) existing.remove();

  const headerDiv = document.createElement('div');
  headerDiv.className = 'results-header';
  headerDiv.setAttribute('role', 'status');
  headerDiv.setAttribute('aria-live', 'polite');
  headerDiv.setAttribute('aria-atomic', 'true');

  const countSpan = document.createElement('span');
  countSpan.className = 'results-count';
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

  // Insert header before the posts container (or at start)
  const postsContainer = resultsDiv.querySelector('.posts-container');
  if (postsContainer) {
    resultsDiv.insertBefore(headerDiv, postsContainer);
  } else {
    resultsDiv.insertBefore(headerDiv, resultsDiv.firstChild);
  }
}

function updateResultsButtons(visibleCount, totalCount, handlers = {}) {
  // Remove old buttons
  const oldShowMore = resultsDiv.querySelector('#showMoreBtn');
  if (oldShowMore) oldShowMore.remove();
  const oldLoadMore = resultsDiv.querySelector('#loadMoreBtn');
  if (oldLoadMore) oldLoadMore.remove();

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
      renderResults(handlers);
    });
    resultsDiv.appendChild(showMoreBtn);
  }

  const hasMoreResults = Object.values(state.currentCursors).some((cursor) => cursor !== null);
  if (hasMoreResults) {
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.className = 'load-more';
    loadMoreBtn.id = 'loadMoreBtn';
    loadMoreBtn.textContent = 'Load More Results';
    loadMoreBtn.addEventListener('click', () => handlers.onLoadMore && handlers.onLoadMore());
    resultsDiv.appendChild(loadMoreBtn);
  }
}

// Render all results using a full rebuild. For this app's scale, this is simpler and easier to reason about.
export function renderResults(handlers = {}) {
  const totalCount = state.allPosts.length;
  const visibleCount = Math.min(state.renderLimit, totalCount);

  // Empty state
  if (totalCount === 0) {
    resultsDiv.textContent = '';

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

  resultsDiv.textContent = '';

  const postsContainer = document.createElement('div');
  postsContainer.className = 'posts-container';

  const fragment = document.createDocumentFragment();
  const visiblePosts = state.allPosts.slice(0, visibleCount);
  visiblePosts.forEach((post) => fragment.appendChild(createPostElement(post)));
  postsContainer.appendChild(fragment);

  resultsDiv.appendChild(postsContainer);

  updateResultsHeader(visibleCount, totalCount);
  updateResultsButtons(visibleCount, totalCount, handlers);
}

export function renderNewPosts(handlers = {}) {
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
  addBtn.addEventListener(
    'click',
    () => handlers.onMergePending && handlers.onMergePending(),
  );
  actions.appendChild(addBtn);

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'button-secondary button-small';
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener(
    'click',
    () => handlers.onDismissPending && handlers.onDismissPending(),
  );
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
