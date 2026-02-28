import { PUBLIC_API } from './constants';
import { formatRelativeTime, isValidBskyUrl } from './utils';
import type { BskyPost } from './types';

interface ThreadNode {
  post?: BskyPost;
  parent?: ThreadNode;
}

interface ThreadResponse {
  thread?: ThreadNode;
}

// Thread Explorer functions
export function isReplyPost(post: BskyPost): boolean {
  return !!post.record?.reply;
}

async function fetchPostThread(atUri: string): Promise<ThreadResponse> {
  const params = new URLSearchParams({
    uri: atUri,
    depth: '0',
    parentHeight: '100',
  });
  const response = await fetch(`${PUBLIC_API}/app.bsky.feed.getPostThread?${params}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch thread: ${response.status}`);
  }
  return response.json();
}

function extractParentChain(thread: ThreadResponse): BskyPost[] {
  const parents: BskyPost[] = [];
  let current = thread.thread?.parent;
  while (current?.post) {
    parents.unshift(current.post);
    current = current.parent;
  }
  return parents;
}

function createThreadParentElement(post: BskyPost): HTMLDivElement {
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
  timeSpan.textContent = formatRelativeTime(post.indexedAt);
  header.appendChild(timeSpan);

  wrapper.appendChild(header);

  const textDiv = document.createElement('div');
  textDiv.className = 'thread-parent-text';
  textDiv.textContent = post.record?.text || '';
  wrapper.appendChild(textDiv);

  return wrapper;
}

function createThreadContextElement(parents: BskyPost[]): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'thread-context thread-context-inline';

  const label = document.createElement('div');
  label.className = 'thread-label';
  label.textContent = 'Thread context';
  container.appendChild(label);

  parents.forEach((parent) => {
    container.appendChild(createThreadParentElement(parent));
  });

  return container;
}

function removeThreadContexts(postElement: HTMLElement): boolean {
  const directChildren = Array.from(postElement.children);
  let removed = false;

  for (const child of directChildren) {
    if (!(child instanceof HTMLElement) || !child.classList.contains('thread-context')) {
      continue;
    }
    child.remove();
    removed = true;
  }

  return removed;
}

export async function toggleThread(post: BskyPost, postElement: HTMLElement): Promise<void> {
  const link = postElement.querySelector('.thread-link') as HTMLButtonElement | null;
  if (!link) return;

  if (link.dataset.loading === 'true') {
    return;
  }

  if (removeThreadContexts(postElement)) {
    link.textContent = 'View Thread';
    return;
  }

  link.dataset.loading = 'true';
  link.disabled = true;
  link.textContent = 'Loading\u2026';

  try {
    const threadData = await fetchPostThread(post.uri);
    const parents = extractParentChain(threadData);

    if (parents.length === 0) {
      link.textContent = 'No parent posts found';
      setTimeout(() => {
        link.textContent = 'View Thread';
      }, 2000);
      return;
    }

    const contextElement = createThreadContextElement(parents);
    postElement.insertBefore(contextElement, postElement.firstElementChild || null);
    link.textContent = 'Hide Thread';
  } catch (error) {
    console.error('Thread fetch error:', error);
    link.textContent = 'Failed to load thread';
    setTimeout(() => {
      link.textContent = 'View Thread';
    }, 2000);
  } finally {
    link.dataset.loading = 'false';
    link.disabled = false;
  }
}
