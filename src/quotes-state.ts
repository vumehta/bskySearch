import { state } from './state';

export function trackQuoteCursor(nextCursor: string | null | undefined): string | null {
  if (!nextCursor) {
    return null;
  }
  if (state.quoteSeenCursors.has(nextCursor)) {
    return null;
  }
  state.quoteSeenCursors.add(nextCursor);
  return nextCursor;
}
