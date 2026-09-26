import { PUBLIC_API } from './constants.mjs';
import { appendAuthorBadges, clearBadgeTimers } from './author-badges.mjs';
import { fetchJson } from './http.mjs';
import { isRenderablePost } from './post-data.mjs';
import { formatRelativeTime, getPostSortAt, isValidBskyUrl } from './utils.mjs';

const THREAD_CACHE_TTL_MS = 30000;
const MAX_THREAD_CACHE_SIZE = 100;
const threadCache = new Map();
const toggleStates = new WeakMap();
const pendingToggles = new Set();
let nextContextId = 0;

export function isReplyPost(post) {
  return !!post.record?.reply;
}

async function fetchPostThread(atUri, signal) {
  const params = new URLSearchParams({
    uri: atUri,
    depth: '0',
    parentHeight: '100',
  });
  return fetchJson(`${PUBLIC_API}/app.bsky.feed.getPostThread?${params}`, { signal });
}

function getMissingParentNotice(node) {
  if (!node) return '';
  if (node.$type === 'app.bsky.feed.defs#blockedPost') return 'Parent post blocked';
  if (node.$type === 'app.bsky.feed.defs#notFoundPost') return 'Parent post not found';
  return 'Parent post unavailable';
}

function extractParentChain(thread) {
  const parents = [];
  let current = thread.thread?.parent;
  while (current?.post) {
    if (!isRenderablePost(current.post)) throw new Error('Thread contained an invalid post.');
    parents.push(current.post);
    current = current.parent;
  }
  return { parents: parents.reverse(), missing: getMissingParentNotice(current) };
}

function createThreadParentElement(post) {
  const wrapper = document.createElement('div');
  wrapper.className = 'thread-parent';

  const header = document.createElement('div');
  header.className = 'thread-parent-header';

  if (post.author.avatar && isValidBskyUrl(post.author.avatar)) {
    const avatar = document.createElement('img');
    avatar.className = 'thread-parent-avatar';
    avatar.src = post.author.avatar;
    avatar.alt = '';
    avatar.loading = 'lazy';
    header.appendChild(avatar);
  } else {
    const avatarPlaceholder = document.createElement('div');
    avatarPlaceholder.className = 'thread-parent-avatar';
    header.appendChild(avatarPlaceholder);
  }

  const authorSpan = document.createElement('span');
  authorSpan.className = 'thread-parent-author';
  authorSpan.textContent = post.author.displayName || post.author.handle;
  header.appendChild(authorSpan);

  const handleSpan = document.createElement('span');
  handleSpan.className = 'thread-parent-handle';
  handleSpan.textContent = `@${post.author.handle}`;
  header.appendChild(handleSpan);
  appendAuthorBadges(header, post.author);

  const timeSpan = document.createElement('span');
  timeSpan.className = 'thread-parent-time';
  timeSpan.textContent = formatRelativeTime(getPostSortAt(post));
  header.appendChild(timeSpan);

  wrapper.appendChild(header);

  const textDiv = document.createElement('div');
  textDiv.className = 'thread-parent-text';
  textDiv.textContent = post.record?.text || '';
  wrapper.appendChild(textDiv);

  return wrapper;
}

function createThreadContextElement({ parents, missing }, contextId) {
  const container = document.createElement('div');
  container.className = 'thread-context';
  container.id = contextId;

  const label = document.createElement('div');
  label.className = 'thread-label';
  label.textContent = 'Thread context';
  container.appendChild(label);

  if (missing) {
    const notice = document.createElement('div');
    notice.className = 'thread-parent thread-parent-missing';
    const text = document.createElement('div');
    text.className = 'thread-parent-text';
    text.textContent = missing;
    notice.appendChild(text);
    container.appendChild(notice);
  }

  parents.forEach((parent) => {
    container.appendChild(createThreadParentElement(parent));
  });

  return container;
}

function removeThreadContexts(postElement) {
  const directChildren = Array.from(postElement.children);
  let removed = false;

  for (const child of directChildren) {
    if (!child.classList.contains('thread-context')) {
      continue;
    }
    clearBadgeTimers(child);
    child.remove();
    removed = true;
  }

  return removed;
}

export function moveThreadContext(fromElement, toElement) {
  const context = Array.from(fromElement.children).find((child) => child.classList.contains('thread-context'));
  const link = toElement.querySelector('button.thread-link');
  if (!context || !link) return;
  link.setAttribute('aria-controls', context.id);
  link.setAttribute('aria-expanded', 'true');
  link.textContent = 'Hide Thread';
  toElement.insertBefore(context, toElement.firstElementChild || null);
}

export function initializeThreadToggle(link) {
  if (!link.getAttribute('aria-controls')) {
    link.setAttribute('aria-controls', `thread-context-${++nextContextId}`);
    link.setAttribute('aria-expanded', 'false');
  }
  return link.getAttribute('aria-controls');
}

function clearStatusTimer(toggleState) {
  clearTimeout(toggleState.statusTimer);
  toggleState.statusTimer = null;
  if (!toggleState.controller) pendingToggles.delete(toggleState);
}

function resetPendingToggle(toggleState) {
  clearStatusTimer(toggleState);
  toggleState.controller?.abort();
  toggleState.controller = null;
  toggleState.link.removeAttribute('aria-busy');
  toggleState.link.textContent = 'View Thread';
  pendingToggles.delete(toggleState);
}

export function cancelThreadRequest(postElement) {
  const toggleState = toggleStates.get(postElement);
  if (toggleState && pendingToggles.has(toggleState)) resetPendingToggle(toggleState);
}

export function cancelThreadRequests() {
  for (const toggleState of pendingToggles) resetPendingToggle(toggleState);
}

function showTemporaryStatus(toggleState, message) {
  toggleState.link.textContent = message;
  pendingToggles.add(toggleState);
  toggleState.statusTimer = setTimeout(() => {
    toggleState.link.textContent = 'View Thread';
    toggleState.statusTimer = null;
    pendingToggles.delete(toggleState);
  }, 2000);
}

function getCachedChain(uri) {
  const cached = threadCache.get(uri);
  if (!cached) return null;
  if (Date.now() - cached.timestamp >= THREAD_CACHE_TTL_MS) {
    threadCache.delete(uri);
    return null;
  }
  return cached.chain;
}

function cacheChain(uri, chain) {
  threadCache.delete(uri);
  threadCache.set(uri, { chain, timestamp: Date.now() });
  while (threadCache.size > MAX_THREAD_CACHE_SIZE) {
    threadCache.delete(threadCache.keys().next().value);
  }
}

export async function toggleThread(post, postElement) {
  const link = postElement.querySelector('button.thread-link');
  if (!link) return;
  const contextId = initializeThreadToggle(link);
  let toggleState = toggleStates.get(postElement);
  if (!toggleState) {
    toggleState = { link, controller: null, statusTimer: null };
    toggleStates.set(postElement, toggleState);
  }

  if (toggleState.controller) {
    resetPendingToggle(toggleState);
    return;
  }
  clearStatusTimer(toggleState);

  if (removeThreadContexts(postElement)) {
    link.textContent = 'View Thread';
    link.setAttribute('aria-expanded', 'false');
    return;
  }

  const controller = new AbortController();
  toggleState.controller = controller;
  pendingToggles.add(toggleState);
  link.setAttribute('aria-busy', 'true');
  link.textContent = 'Cancel loading';

  try {
    let chain = getCachedChain(post.uri);
    if (!chain) {
      const threadData = await fetchPostThread(post.uri, controller.signal);
      if (toggleState.controller !== controller) return;
      chain = extractParentChain(threadData);
      if (chain.parents.length > 0) cacheChain(post.uri, chain);
    }

    if (chain.parents.length === 0) {
      showTemporaryStatus(toggleState, chain.missing || 'No parent posts found');
      return;
    }

    const contextElement = createThreadContextElement(chain, contextId);
    postElement.insertBefore(contextElement, postElement.firstElementChild || null);
    link.setAttribute('aria-expanded', 'true');
    link.textContent = 'Hide Thread';
  } catch (error) {
    if (toggleState.controller !== controller || controller.signal.aborted) return;
    showTemporaryStatus(toggleState,
      error.name === 'RequestTimeoutError' ? 'Thread request timed out' : 'Failed to load thread');
  } finally {
    if (toggleState.controller === controller) {
      toggleState.controller = null;
      link.removeAttribute('aria-busy');
      if (!toggleState.statusTimer) pendingToggles.delete(toggleState);
    }
  }
}
