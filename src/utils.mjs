// Safe text content setter (prevents XSS)
export function setText(element, text) {
  element.textContent = text;
}

// Validate URL is from allowed domains
export function isValidBskyUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'bsky.app' ||
        parsed.hostname.endsWith('.bsky.app') ||
        parsed.hostname === 'cdn.bsky.app' ||
        parsed.hostname.endsWith('.cdn.bsky.app'))
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

// Generate cache key for search requests
export function getSearchCacheKey(term, cursor, sort) {
  return JSON.stringify([term, cursor || '', sort]);
}

// Deduplicate posts by URI
export function deduplicatePosts(posts) {
  const seen = new Map();

  for (const post of posts) {
    const uri = post.uri;
    if (!seen.has(uri)) {
      seen.set(uri, post);
    } else {
      const existing = seen.get(uri);
      if (!existing.matchedTerms) {
        existing.matchedTerms = [existing.matchedTerm];
      }
      if (!existing.matchedTerms.includes(post.matchedTerm)) {
        existing.matchedTerms.push(post.matchedTerm);
      }
    }
  }

  return Array.from(seen.values()).map((post) => {
    if (!post.matchedTerms) {
      post.matchedTerms = [post.matchedTerm];
    }
    return post;
  });
}

// Filter posts by minimum likes
export function filterByLikes(posts, minLikes) {
  return posts.filter((post) => (post.likeCount || 0) >= minLikes);
}

// Filter posts by date (configurable hours)
export function filterByDate(posts, hours) {
  const normalizedHours = Number.isFinite(hours) && hours > 0 ? hours : 24;
  const cutoffTs = Date.now() - normalizedHours * 3600000;
  return posts.filter((post) => getPostTimestamp(post) >= cutoffTs);
}

// Sort posts by selected mode
export function sortPosts(posts, sortMode = 'top') {
  const sorted = [...posts];
  if (sortMode === 'latest') {
    sorted.sort((a, b) => getPostTimestamp(b) - getPostTimestamp(a));
    return sorted;
  }
  sorted.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
  return sorted;
}

// Format relative time
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

// Extract post URL from URI
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

export function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function parseBlueskyPostUrl(urlString) {
  let parsedUrl;
  try {
    parsedUrl = new URL(urlString);
  } catch (e) {
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
  if (!rawHandle || !postId) {
    throw new Error('URL is missing a handle or post ID.');
  }

  const actor = rawHandle.startsWith('did:')
    ? rawHandle
    : rawHandle.includes('.')
      ? rawHandle
      : `${rawHandle}.bsky.social`;
  return { actor, postId, rawHandle };
}
