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
