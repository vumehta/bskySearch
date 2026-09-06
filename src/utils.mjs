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

export function normalizeSortValue(raw) {
  return raw === 'latest' ? 'latest' : 'top';
}

export function sortPosts(posts, sortMode = 'top') {
  const sorted = [...posts];
  if (sortMode === 'latest') {
    sorted.sort((a, b) => getPostTimestamp(b) - getPostTimestamp(a));
    return sorted;
  }
  sorted.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
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

export function getPostUrl(post) {
  const parts = post.uri.split('/');
  const postId = parts[parts.length - 1];
  const handle = post.author.handle;
  if (!/^[a-zA-Z0-9._-]+$/.test(handle) || !/^[a-zA-Z0-9]+$/.test(postId)) {
    return null;
  }
  return `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(postId)}`;
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
  return { actor, postId, rawHandle };
}
