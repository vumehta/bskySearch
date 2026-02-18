import { QUOTE_SORT_OPTIONS, SEARCH_SORT_OPTIONS, TIME_OPTIONS } from './constants';
import type { Post, QuoteSort, SearchSort } from './types';

export interface ParsedPostUrl {
  actor: string;
  postId: string;
  rawHandle: string;
}

export interface UrlState {
  terms: string;
  minLikes: string;
  time: string;
  expand: boolean;
  searchSort: SearchSort;
  post: string;
  quoteSort: QuoteSort;
}

// Safe text rendering helper stays in JSX text nodes; no HTML interpolation.
export function normalizeTerm(raw: string): string {
  const sanitized = String(raw).replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
  let term = sanitized.trim();
  if (
    (term.startsWith('"') && term.endsWith('"')) ||
    (term.startsWith("'") && term.endsWith("'"))
  ) {
    term = term.slice(1, -1).trim();
  }
  return term;
}

export function expandSearchTerms(terms: string[], shouldExpandWords: boolean): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();

  const addTerm = (value: string) => {
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

export function getMatchedTermsForPost(post: Post): string[] {
  if (Array.isArray(post.matchedTerms) && post.matchedTerms.length > 0) {
    return post.matchedTerms.filter(Boolean);
  }
  if (post.matchedTerm) {
    return [post.matchedTerm];
  }
  return [];
}

export function mergeMatchedTerms(existingTerms: string[], incomingTerms: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  const add = (term: string) => {
    if (!term) return;
    const normalized = term.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    merged.push(term);
  };

  existingTerms.forEach(add);
  incomingTerms.forEach(add);

  return merged;
}

export function deduplicatePosts(posts: Post[]): Post[] {
  const byUri = new Map<string, Post>();

  for (const post of posts) {
    const uri = post?.uri;
    if (!uri) continue;

    if (!byUri.has(uri)) {
      const copy: Post = { ...post };
      const matched = getMatchedTermsForPost(copy);
      copy.matchedTerms = matched;
      copy.matchedTerm = matched[0] || '';
      byUri.set(uri, copy);
      continue;
    }

    const existing = byUri.get(uri);
    if (!existing) continue;

    const merged = mergeMatchedTerms(
      getMatchedTermsForPost(existing),
      getMatchedTermsForPost(post),
    );

    Object.assign(existing, post);
    existing.matchedTerms = merged;
    existing.matchedTerm = merged[0] || '';
  }

  return Array.from(byUri.values());
}

export function filterByLikes(posts: Post[], minLikes: number): Post[] {
  const floor = Number.isFinite(minLikes) ? minLikes : 0;
  return posts.filter((post) => (post.likeCount || 0) >= floor);
}

export function getPostTimestamp(post: Post): number {
  const candidate = post.record?.createdAt || post.indexedAt;
  const ts = new Date(candidate || '').getTime();
  return Number.isNaN(ts) ? 0 : ts;
}

export function filterByDate(posts: Post[], hours: number): Post[] {
  const normalizedHours = Number.isFinite(hours) && hours > 0 ? hours : 24;
  const cutoff = Date.now() - normalizedHours * 3600000;
  return posts.filter((post) => getPostTimestamp(post) >= cutoff);
}

export function sortPosts(posts: Post[], sortMode: SearchSort): Post[] {
  const sorted = [...posts];
  if (sortMode === 'latest') {
    sorted.sort((a, b) => getPostTimestamp(b) - getPostTimestamp(a));
    return sorted;
  }
  sorted.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
  return sorted;
}

export function sortQuotes(posts: Post[], sortMode: QuoteSort): Post[] {
  const sorted = [...posts];
  if (sortMode === 'recent') {
    sorted.sort((a, b) => getPostTimestamp(b) - getPostTimestamp(a));
    return sorted;
  }
  if (sortMode === 'oldest') {
    sorted.sort((a, b) => getPostTimestamp(a) - getPostTimestamp(b));
    return sorted;
  }
  sorted.sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));
  return sorted;
}

export function isReplyPost(post: Post): boolean {
  return Boolean(post.record?.reply);
}

export function isValidBskyUrl(url: string | undefined | null): boolean {
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

export function getPostUrl(post: Post): string | null {
  const uri = post.uri || '';
  const parts = uri.split('/');
  const postId = parts[parts.length - 1];
  const handle = post.author?.handle || '';

  if (!/^[a-zA-Z0-9._-]+$/.test(handle) || !/^[a-zA-Z0-9]+$/.test(postId)) {
    return null;
  }

  return `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(postId)}`;
}

export function formatDateTime(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

export function formatRelativeTime(value?: string): string {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return 'unknown';

  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString();
}

export function formatTime(value: Date | number | null): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDuration(ms: number): string {
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

export function parseBlueskyPostUrl(urlString: string): ParsedPostUrl {
  let parsedUrl: URL;
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

export function getSearchCacheKey(term: string, cursor: string | null, sort: SearchSort): string {
  return JSON.stringify([term, cursor || '', sort]);
}

export function isSearchSort(value: string | null): value is SearchSort {
  return Boolean(value && SEARCH_SORT_OPTIONS.includes(value as SearchSort));
}

export function isQuoteSort(value: string | null): value is QuoteSort {
  return Boolean(value && QUOTE_SORT_OPTIONS.includes(value as QuoteSort));
}

export function parseUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);

  const terms = params.get('terms') || '';
  const minLikes = params.get('minLikes') || '10';
  const timeCandidate = params.get('time') || '24';
  const expand = params.get('expand') === '1';
  const post = params.get('post') || '';

  const legacySort = params.get('sort');
  const explicitSearchSort = params.get('searchSort');
  const explicitQuoteSort = params.get('quoteSort');

  const searchSort: SearchSort = isSearchSort(explicitSearchSort)
    ? explicitSearchSort
    : isSearchSort(legacySort)
      ? legacySort
      : 'top';

  const quoteSort: QuoteSort = isQuoteSort(explicitQuoteSort)
    ? explicitQuoteSort
    : isQuoteSort(legacySort)
      ? legacySort
      : 'likes';

  const time = TIME_OPTIONS.includes(timeCandidate as (typeof TIME_OPTIONS)[number])
    ? timeCandidate
    : '24';

  return {
    terms,
    minLikes,
    time,
    expand,
    searchSort,
    post,
    quoteSort,
  };
}

export function setQueryParam(params: URLSearchParams, key: string, value: string) {
  if (value) {
    params.set(key, value);
  } else {
    params.delete(key);
  }
}
