import { state } from './state.mjs';

export function trackQuoteCursor(nextCursor) {
  if (!nextCursor) {
    return null;
  }
  if (state.quoteSeenCursors.has(nextCursor)) {
    return null;
  }
  state.quoteSeenCursors.add(nextCursor);
  return nextCursor;
}

// Replacing overlapping records also refreshes engagement counts. Return a new
// array so sorting/render caches can detect a changed collection.
export function mergeQuotes(existing, incoming) {
  const byUri = new Map(existing.map((post) => [post.uri, post]));
  incoming.forEach((post) => byUri.set(post.uri, post));
  return Array.from(byUri.values());
}
