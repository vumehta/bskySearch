import { PUBLIC_API } from './constants.mjs';
import { fetchJson } from './http.mjs';
import { isRenderablePost } from './post-data.mjs';
import { formatRelativeTime, isValidBskyUrl } from './utils.mjs';

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

function extractParentChain(thread) {
  const parents = [];
  let current = thread.thread?.parent;
  while (current?.post) {
    if (!isRenderablePost(current.post)) throw new Error('Thread contained an invalid post.');
    parents.push(current.post);
    current = current.parent;
  }
  return parents.reverse();
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

  const timeSpan = document.createElement('span');
  timeSpan.className = 'thread-parent-time';
  timeSpan.textContent = formatRelativeTime(post.record?.createdAt || post.indexedAt);
  header.appendChild(timeSpan);

  wrapper.appendChild(header);

  const textDiv = document.createElement('div');
  textDiv.className = 'thread-parent-text';
  textDiv.textContent = post.record?.text || '';
  wrapper.appendChild(textDiv);

  return wrapper;
}

function createThreadContextElement(parents, contextId) {
  const container = document.createElement('div');
  container.className = 'thread-context';
  container.id = contextId;

  const label = document.createElement('div');
  label.className = 'thread-label';
  label.textContent = 'Thread context';
  container.appendChild(label);

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
    child.remove();
    removed = true;
  }

  return removed;
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
  toggleState.link.dataset.loading = 'false';
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

function getCachedParents(uri) {
  const cached = threadCache.get(uri);
  if (!cached) return null;
  if (Date.now() - cached.timestamp >= THREAD_CACHE_TTL_MS) {
    threadCache.delete(uri);
    return null;
  }
  return cached.parents;
}

function cacheParents(uri, parents) {
  threadCache.delete(uri);
  threadCache.set(uri, { parents, timestamp: Date.now() });
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
  link.dataset.loading = 'true';
  link.setAttribute('aria-busy', 'true');
  link.textContent = 'Cancel loading';

  try {
    let parents = getCachedParents(post.uri);
    if (!parents) {
      const threadData = await fetchPostThread(post.uri, controller.signal);
      if (toggleState.controller !== controller) return;
      parents = extractParentChain(threadData);
      if (parents.length > 0) cacheParents(post.uri, parents);
    }

    if (parents.length === 0) {
      showTemporaryStatus(toggleState, 'No parent posts found');
      return;
    }

    const contextElement = createThreadContextElement(parents, contextId);
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
      link.dataset.loading = 'false';
      link.removeAttribute('aria-busy');
      if (!toggleState.statusTimer) pendingToggles.delete(toggleState);
    }
  }
}
