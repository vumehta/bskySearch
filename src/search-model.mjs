import { isRenderablePost } from './post-data.mjs';

// Search transformations shared by the UI and the performance smoke checks.
export function validateSearchPage(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.posts)
    || (data.cursor !== undefined && data.cursor !== null && typeof data.cursor !== 'string')
    || !data.posts.every(isRenderablePost)) {
    throw new Error('The server returned an invalid search response.');
  }
  return data;
}

export function getMatchedTermsForPost(post) {
  if (Array.isArray(post.matchedTerms) && post.matchedTerms.length > 0) {
    return post.matchedTerms.filter(Boolean);
  }
  return post.matchedTerm ? [post.matchedTerm] : [];
}

export function ingestSearchPosts(postsByUri, posts) {
  for (const post of posts) {
    if (!post?.uri) continue;
    const existing = postsByUri.get(post.uri);
    const terms = [...getMatchedTermsForPost(existing || {}), ...getMatchedTermsForPost(post)];
    const seen = new Set();
    const matchedTerms = terms.filter((term) => {
      const key = term.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    postsByUri.set(post.uri, {
      ...existing,
      ...post,
      matchedTerms,
      matchedTerm: matchedTerms[0] || '',
    });
  }
  return postsByUri;
}

export function createHighlightMatcher(terms) {
  if (terms.length === 0) return { regex: null, termSet: new Set() };
  const orderedTerms = [...terms].sort((a, b) => b.length - a.length);
  const escaped = orderedTerms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return {
    regex: new RegExp(`(${escaped.join('|')})`, 'gi'),
    termSet: new Set(terms.map((term) => term.toLowerCase())),
  };
}

export function getPostRenderFingerprint(post) {
  return JSON.stringify([
    post.uri || '',
    post.author?.handle || '',
    post.author?.displayName || '',
    post.author?.avatar || '',
    post.indexedAt || '',
    post.record?.createdAt || '',
    post.record?.text || '',
    post.record?.reply || null,
    post.embed || null,
    post.likeCount || 0,
    post.repostCount || 0,
    post.replyCount || 0,
    getMatchedTermsForPost(post),
  ]);
}

// A cursor is useful only once. This also terminates A -> B -> A loops.
export function nextSearchCursor(nextCursor, requestedCursor, seenCursors) {
  if (typeof nextCursor !== 'string' || !nextCursor || nextCursor === requestedCursor || seenCursors.has(nextCursor)) return null;
  return nextCursor;
}

export async function settleWithConcurrency(items, concurrency, worker, signal) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runWorker() {
    while (!signal?.aborted && nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  return results.filter(Boolean);
}
