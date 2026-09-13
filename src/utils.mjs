export function isValidBskyUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'bsky.app' || parsed.hostname.endsWith('.bsky.app'))
    );
  } catch {
    return false;
  }
}

export function normalizeTerm(raw) {
  const sanitized = raw.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
  let term = sanitized.trim();
  if (
    (term.startsWith('"') && term.endsWith('"')) ||
    (term.startsWith("'") && term.endsWith("'"))
  ) {
    term = term.slice(1, -1).trim();
  }
  return term;
}

export function expandSearchTerms(terms, shouldExpandWords) {
  const expanded = [];
  const seen = new Set();

  const addTerm = (value) => {
    const cleaned = value.trim();
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    expanded.push(cleaned);
  };

  terms.forEach((raw) => {
    const term = normalizeTerm(raw);
    if (!term) return;
    addTerm(term);
    if (shouldExpandWords) {
      const parts = term.split(/\s+/).filter(Boolean);
      if (parts.length > 1) {
        parts.forEach(addTerm);
      }
    }
  });

  return expanded;
}

export function getSearchCacheKey(term, cursor, sort, since = '') {
  return JSON.stringify([term, cursor || '', sort, since || '']);
}

// Start of the search window as a UTC timestamp for the API's `since` filter.
// Rounded down to the minute so searches repeated within the cache TTL share
// a cache key, and without fractional seconds to keep the value compact.
export function getSearchSince(hours, now = Date.now()) {
  const normalizedHours = Number.isFinite(hours) && hours > 0 ? hours : 24;
  const cutoffTs = now - normalizedHours * 3600000;
  const roundedTs = Math.floor(cutoffTs / 60000) * 60000;
  return new Date(roundedTs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function filterByLikes(posts, minLikes) {
  return posts.filter((post) => (post.likeCount || 0) >= minLikes);
}

export function filterByDate(posts, hours) {
  const normalizedHours = Number.isFinite(hours) && hours > 0 ? hours : 24;
  const cutoffTs = Date.now() - normalizedHours * 3600000;
  return posts.filter((post) => getPostTimestamp(post) >= cutoffTs);
}

export const SEARCH_SORT_VALUES = ['top', 'latest', 'bookmarks'];

export function normalizeSortValue(raw) {
  return SEARCH_SORT_VALUES.includes(raw) ? raw : 'top';
}

// Bookmarks are sparse, so equal counts fall back to likes.
export function compareByBookmarks(a, b) {
  return (b.bookmarkCount || 0) - (a.bookmarkCount || 0) || (b.likeCount || 0) - (a.likeCount || 0);
}

export function sortPosts(posts, sortMode = 'top') {
  const sorted = [...posts];
  if (sortMode === 'latest') {
    sorted.sort((a, b) => getPostTimestamp(b) - getPostTimestamp(a));
  } else if (sortMode === 'bookmarks') {
    sorted.sort(compareByBookmarks);
  } else {
    sorted.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
  }
  return sorted;
}

export function formatRelativeTime(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString();
}

// The AppView reports `handle.invalid` when it could not verify the handle;
// bsky.app also resolves profiles by DID. The DID is not percent-encoded: its
// syntax already is, and bsky.app does not resolve a re-encoded `did%3A` prefix.
export function getProfileUrl(author) {
  const actor = author.handle === 'handle.invalid' ? author.did : encodeURIComponent(author.handle);
  return `https://bsky.app/profile/${actor}`;
}

export function getPostUrl(post) {
  const postId = post.uri.split('/').pop();
  if (!/^[a-zA-Z0-9]+$/.test(postId)) return null;
  return `${getProfileUrl(post.author)}/post/${postId}`;
}

export function formatDateTime(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

export function getPostTimestamp(post) {
  const candidate = post.record?.createdAt || post.indexedAt;
  const time = new Date(candidate).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export function parseBlueskyPostUrl(urlString) {
  let parsedUrl;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    throw new Error('Please enter a valid URL.');
  }

  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'bsky.app') {
    throw new Error('URL must be from https://bsky.app');
  }

  const parts = parsedUrl.pathname.split('/').filter(Boolean);
  if (parts.length < 4 || parts[0] !== 'profile' || parts[2] !== 'post') {
    throw new Error('Use https://bsky.app/profile/{handle}/post/{postId}');
  }

  const rawHandle = parts[1];
  const postId = parts[3];

  const actor = rawHandle.startsWith('did:')
    ? rawHandle
    : rawHandle.includes('.')
      ? rawHandle
      : `${rawHandle}.bsky.social`;
  return { actor, postId };
}
