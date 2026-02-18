import { FormEvent, Fragment, KeyboardEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  INITIAL_MAX_PAGES,
  INITIAL_RENDER_LIMIT,
  QUOTE_SORT_OPTIONS,
  RENDER_STEP,
  SEARCH_DEBOUNCE_MS,
  SEARCH_SORT_OPTIONS,
  TIME_OPTIONS,
} from './constants';
import {
  fetchDid,
  fetchOriginalPost,
  fetchQuotesPage,
  fetchThreadParents,
  searchTerm,
} from './api';
import type {
  Post,
  QuoteSort,
  SearchSort,
  StatusMessage,
  ThreadState,
} from './types';
import { useTheme } from './useTheme';
import {
  deduplicatePosts,
  expandSearchTerms,
  filterByDate,
  filterByLikes,
  formatDateTime,
  formatDuration,
  formatRelativeTime,
  formatTime,
  getMatchedTermsForPost,
  getPostTimestamp,
  getPostUrl,
  isReplyPost,
  isValidBskyUrl,
  mergeMatchedTerms,
  normalizeTerm,
  parseBlueskyPostUrl,
  parseUrlState,
  setQueryParam,
  sortPosts,
  sortQuotes,
} from './utils';

const QUOTE_TAB_LABELS: Record<QuoteSort, string> = {
  likes: 'Most Likes',
  recent: 'Most Recent',
  oldest: 'Oldest First',
};

function StatusBanner({ status }: { status: StatusMessage | null }) {
  if (!status) return null;

  const toneClass =
    status.type === 'error'
      ? 'border-red-300 bg-red-50 text-red-800'
      : status.type === 'loading'
        ? 'border-sky-300 bg-sky-50 text-sky-800'
        : 'border-zinc-300 bg-zinc-100 text-zinc-700';

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={`mb-4 rounded-lg border px-4 py-3 text-sm ${toneClass}`}
    >
      {status.message}
    </div>
  );
}

function highlightText(text: string, terms: string[]): ReactNode {
  if (!text) return '';
  const normalizedTerms = terms.map((term) => term.trim()).filter(Boolean);
  if (normalizedTerms.length === 0) {
    return text;
  }

  const escaped = normalizedTerms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  const termSet = new Set(normalizedTerms.map((term) => term.toLowerCase()));

  return text.split(regex).map((part, index) => {
    if (termSet.has(part.toLowerCase())) {
      return (
        <span key={`h-${index}`} className="search-highlight">
          {part}
        </span>
      );
    }
    return <Fragment key={`t-${index}`}>{part}</Fragment>;
  });
}

function getExpansionSummary(value: string, shouldExpand: boolean): string {
  const inputValue = value.trim();
  if (!inputValue) {
    return 'Enter terms to preview expansion.';
  }

  const rawTerms = inputValue
    .split(',')
    .map((term) => normalizeTerm(term))
    .filter(Boolean);

  if (rawTerms.length === 0) {
    return 'Enter terms to preview expansion.';
  }

  if (!shouldExpand) {
    return `Expansion is off. Searching only: ${rawTerms.join(', ')}`;
  }

  const expanded = expandSearchTerms(rawTerms, true);
  const rawSet = new Set(rawTerms.map((term) => term.toLowerCase()));
  const extras = expanded.filter((term) => !rawSet.has(term.toLowerCase()));

  if (extras.length === 0) {
    return `No multi-word phrases detected. Searching: ${rawTerms.join(', ')}`;
  }

  return `Typed: ${rawTerms.join(', ')}. Expanded: ${expanded.join(', ')}`;
}

function PostCard({
  post,
  searchTerms,
  isHighlighted,
  showImages,
  onShowImages,
  threadState,
  onToggleThread,
}: {
  post: Post;
  searchTerms: string[];
  isHighlighted: boolean;
  showImages: boolean;
  onShowImages: (uri: string) => void;
  threadState?: ThreadState;
  onToggleThread: (post: Post) => void;
}) {
  const postUrl = getPostUrl(post);
  const handle = post.author?.handle || 'unknown';
  const displayName = post.author?.displayName || handle;
  const text = post.record?.text || '';
  const matchedTerms = getMatchedTermsForPost(post);

  const imageEmbed = post.embed as
    | { $type?: string; images?: Array<{ thumb?: string; alt?: string }> }
    | undefined;
  const validImages =
    imageEmbed?.$type === 'app.bsky.embed.images#view'
      ? (imageEmbed.images || []).filter(
          (image): image is { thumb: string; alt?: string } =>
            Boolean(image?.thumb && isValidBskyUrl(image.thumb)),
        )
      : [];

  return (
    <article
      className={`rounded-xl border bg-[var(--card-bg)] p-4 shadow-sm transition-shadow hover:shadow-md ${
        isHighlighted ? 'ring-2 ring-[var(--focus-ring)] border-[var(--accent)]' : 'border-[var(--border)]'
      }`}
    >
      {matchedTerms.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {matchedTerms.map((term) => (
            <span
              key={`${post.uri}-${term}`}
              className="rounded bg-[var(--tag-bg)] px-2 py-0.5 text-xs font-medium text-[var(--accent-text)]"
            >
              {term}
            </span>
          ))}
        </div>
      )}

      {threadState?.visible && threadState.parents.length > 0 && (
        <div className="mb-3 rounded-lg border border-[var(--accent-soft-border)] bg-[var(--accent-soft)] p-3">
          <div className="mb-2 text-xs uppercase tracking-wide text-[var(--muted)]">Thread context</div>
          <div className="space-y-2">
            {threadState.parents.map((parent) => (
              <div
                key={parent.uri}
                className="rounded-r-md border-l-4 border-[var(--accent)] bg-[var(--card-bg)] px-3 py-2"
              >
                <div className="mb-1 flex items-center gap-2 text-xs text-[var(--muted-2)]">
                  <span className="font-semibold text-[var(--text)]">
                    {parent.author?.displayName || parent.author?.handle || 'Unknown'}
                  </span>
                  <span>@{parent.author?.handle || 'unknown'}</span>
                  <span className="ml-auto">{formatRelativeTime(parent.indexedAt)}</span>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm text-[var(--text)]">
                  {parent.record?.text || ''}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <header className="mb-2 flex items-center gap-2.5">
        {post.author?.avatar && isValidBskyUrl(post.author.avatar) ? (
          <img
            src={post.author.avatar}
            alt=""
            loading="lazy"
            className="h-10 w-10 rounded-full bg-[var(--avatar-bg)] object-cover"
          />
        ) : (
          <div className="h-10 w-10 rounded-full bg-[var(--avatar-bg)]" aria-hidden="true" />
        )}

        <div className="min-w-0 flex-1">
          <a
            href={`https://bsky.app/profile/${encodeURIComponent(handle)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-sm font-semibold text-[var(--text)] hover:underline"
          >
            {displayName}
          </a>
          <div className="truncate text-xs text-[var(--muted-2)]">@{handle}</div>
        </div>

        <time className="text-xs text-[var(--muted-2)]">{formatRelativeTime(post.indexedAt)}</time>
      </header>

      <p className="mb-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--text)]">
        {highlightText(text, searchTerms)}
      </p>

      {validImages.length > 0 && (
        <div className="mb-3">
          {!showImages && (
            <button
              type="button"
              onClick={() => onShowImages(post.uri)}
              className="rounded border border-dashed border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--accent)] hover:underline"
            >
              Show {validImages.length} image{validImages.length !== 1 ? 's' : ''}
            </button>
          )}

          {showImages && (
            <div
              className={`grid gap-2 ${validImages.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}
            >
              {validImages.map((image, index) => (
                <img
                  key={`${post.uri}-image-${index}`}
                  src={image.thumb}
                  alt={image.alt || ''}
                  loading="lazy"
                  className="max-h-72 w-full rounded-lg object-cover"
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-[var(--muted)]">
        <span className="font-semibold text-pink-500">Likes {post.likeCount || 0}</span>
        <span>Reposts {post.repostCount || 0}</span>
        <span>Replies {post.replyCount || 0}</span>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-sm">
        {postUrl && isReplyPost(post) && (
          <button
            type="button"
            onClick={() => onToggleThread(post)}
            disabled={threadState?.loading}
            className="text-[var(--accent)] disabled:text-[var(--muted)] hover:underline"
          >
            {threadState?.loading
              ? 'Loading...'
              : threadState?.message
                ? threadState.message
                : threadState?.visible
                  ? 'Hide Thread'
                  : 'View Thread'}
          </button>
        )}

        {postUrl && (
          <a
            href={postUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--accent)] hover:underline"
          >
            {isReplyPost(post) ? 'View on Bluesky' : 'View Replies ->'}
          </a>
        )}
      </div>
    </article>
  );
}

export default function App() {
  const initialUrlState = useMemo(() => parseUrlState(window.location.search), []);

  const [termsInput, setTermsInput] = useState(initialUrlState.terms);
  const [minLikesInput, setMinLikesInput] = useState(initialUrlState.minLikes);
  const [timeFilter, setTimeFilter] = useState(initialUrlState.time);
  const [searchSort, setSearchSort] = useState<SearchSort>(initialUrlState.searchSort);
  const [expandTerms, setExpandTerms] = useState(initialUrlState.expand);

  const [status, setStatus] = useState<StatusMessage | null>(null);

  const [allPosts, setAllPosts] = useState<Post[]>([]);
  const [currentCursors, setCurrentCursors] = useState<Record<string, string | null>>({});
  const [searchTerms, setSearchTerms] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [renderLimit, setRenderLimit] = useState(INITIAL_RENDER_LIMIT);

  const [pendingPosts, setPendingPosts] = useState<Post[]>([]);
  const [newPostUris, setNewPostUris] = useState<Set<string>>(new Set());
  const [revealedImages, setRevealedImages] = useState<Set<string>>(new Set());

  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(false);
  const [refreshIntervalMinutes, setRefreshIntervalMinutes] = useState('5');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [nextRefreshAt, setNextRefreshAt] = useState<number | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null);
  const [lastRefreshNewCount, setLastRefreshNewCount] = useState<number | null>(null);
  const [lastRefreshError, setLastRefreshError] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(Date.now());

  const [threadStates, setThreadStates] = useState<Record<string, ThreadState>>({});

  const [postUrl, setPostUrl] = useState(initialUrlState.post);
  const [quoteSort, setQuoteSort] = useState<QuoteSort>(initialUrlState.quoteSort);
  const [quoteStatus, setQuoteStatus] = useState<StatusMessage | null>(null);
  const [isQuoteLoading, setIsQuoteLoading] = useState(false);
  const [quoteOriginalPost, setQuoteOriginalPost] = useState<Post | null>(null);
  const [allQuotes, setAllQuotes] = useState<Post[]>([]);
  const [quoteCursor, setQuoteCursor] = useState<string | null>(null);
  const [quoteTotalCount, setQuoteTotalCount] = useState<number | null>(null);
  const [activeQuoteUri, setActiveQuoteUri] = useState<string | null>(null);

  const { preference: themePreference, setThemePreference } = useTheme();

  const minLikesRef = useRef<number>(Number.parseInt(initialUrlState.minLikes, 10) || 0);
  const timeFilterRef = useRef<number>(Number.parseInt(initialUrlState.time, 10) || 24);
  const searchSortRef = useRef<SearchSort>(initialUrlState.searchSort);
  const searchTermsRef = useRef<string[]>([]);
  const currentCursorsRef = useRef<Record<string, string | null>>({});
  const pendingPostsRef = useRef<Post[]>([]);
  const newPostUrisRef = useRef<Set<string>>(new Set());
  const threadStatesRef = useRef<Record<string, ThreadState>>({});

  const isLoadingRef = useRef(false);
  const isRefreshingRef = useRef(false);
  const autoRefreshEnabledRef = useRef(false);

  const searchGenerationRef = useRef(0);
  const pendingSearchRef = useRef(false);
  const quoteSeenCursorsRef = useRef<Set<string>>(new Set());
  const hasAutoQuoteLoadedRef = useRef(false);

  const ingestedPostsRef = useRef<Map<string, Post>>(new Map());

  const debounceTimerRef = useRef<number | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const refreshCountdownRef = useRef<number | null>(null);
  const highlightClearTimerRef = useRef<number | null>(null);
  const threadMessageTimersRef = useRef<Record<string, number>>({});

  const performSearchRef = useRef<() => Promise<void>>(async () => {});
  const runAutoRefreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    minLikesRef.current = Number.parseInt(minLikesInput, 10) || 0;
  }, [minLikesInput]);

  useEffect(() => {
    timeFilterRef.current = Number.parseInt(timeFilter, 10) || 24;
  }, [timeFilter]);

  useEffect(() => {
    searchSortRef.current = searchSort;
  }, [searchSort]);

  useEffect(() => {
    searchTermsRef.current = searchTerms;
  }, [searchTerms]);

  useEffect(() => {
    currentCursorsRef.current = currentCursors;
  }, [currentCursors]);

  useEffect(() => {
    pendingPostsRef.current = pendingPosts;
  }, [pendingPosts]);

  useEffect(() => {
    newPostUrisRef.current = newPostUris;
  }, [newPostUris]);

  useEffect(() => {
    threadStatesRef.current = threadStates;
  }, [threadStates]);

  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);

  useEffect(() => {
    isRefreshingRef.current = isRefreshing;
  }, [isRefreshing]);

  useEffect(() => {
    autoRefreshEnabledRef.current = autoRefreshEnabled;
  }, [autoRefreshEnabled]);

  const expansionSummary = useMemo(
    () => getExpansionSummary(termsInput, expandTerms),
    [termsInput, expandTerms],
  );

  const clearDebouncedSearch = useCallback(() => {
    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const clearRefreshTimers = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    if (refreshCountdownRef.current !== null) {
      window.clearInterval(refreshCountdownRef.current);
      refreshCountdownRef.current = null;
    }
  }, []);

  const clearThreadMessageTimers = useCallback(() => {
    Object.values(threadMessageTimersRef.current).forEach((timerId) => {
      window.clearTimeout(timerId);
    });
    threadMessageTimersRef.current = {};
  }, []);

  const clearNewPostHighlights = useCallback(() => {
    if (highlightClearTimerRef.current !== null) {
      window.clearTimeout(highlightClearTimerRef.current);
      highlightClearTimerRef.current = null;
    }
    setNewPostUris(new Set());
  }, []);

  const scheduleHighlightClear = useCallback(() => {
    if (highlightClearTimerRef.current !== null) {
      window.clearTimeout(highlightClearTimerRef.current);
    }
    highlightClearTimerRef.current = window.setTimeout(() => {
      setNewPostUris(new Set());
      highlightClearTimerRef.current = null;
    }, 8000);
  }, []);

  const recomputeDerivedPosts = useCallback(() => {
    let derived = Array.from(ingestedPostsRef.current.values());
    derived = filterByDate(derived, timeFilterRef.current);
    derived = filterByLikes(derived, minLikesRef.current);
    derived = sortPosts(derived, searchSortRef.current);
    setAllPosts(derived);
    return derived;
  }, []);

  const ingestPosts = useCallback((posts: Post[]) => {
    for (const post of posts) {
      if (!post?.uri) continue;

      const incomingTerms = getMatchedTermsForPost(post);
      const existing = ingestedPostsRef.current.get(post.uri);

      if (!existing) {
        const normalized = { ...post };
        normalized.matchedTerms = incomingTerms;
        normalized.matchedTerm = normalized.matchedTerms[0] || '';
        ingestedPostsRef.current.set(post.uri, normalized);
        continue;
      }

      const mergedTerms = mergeMatchedTerms(getMatchedTermsForPost(existing), incomingTerms);
      Object.assign(existing, post);
      existing.matchedTerms = mergedTerms;
      existing.matchedTerm = mergedTerms[0] || '';
    }
  }, []);

  const fetchAllPostsForTerm = useCallback(async (term: string, sortMode: SearchSort) => {
    let posts: Post[] = [];
    let cursor: string | null = null;
    let pages = 0;

    while (pages < INITIAL_MAX_PAGES) {
      const data = await searchTerm(term, cursor, sortMode);
      if (data.posts.length > 0) {
        posts = posts.concat(
          data.posts.map((post) => ({
            ...post,
            matchedTerm: term,
          })),
        );
      }

      if (!data.cursor) {
        break;
      }

      cursor = data.cursor;
      pages += 1;
    }

    setCurrentCursors((prev) => {
      const next = { ...prev, [term]: cursor };
      currentCursorsRef.current = next;
      return next;
    });

    return posts;
  }, []);

  const fetchLatestPostsForTerm = useCallback(async (term: string, sortMode: SearchSort) => {
    const data = await searchTerm(term, null, sortMode);
    return data.posts.map((post) => ({
      ...post,
      matchedTerm: term,
    }));
  }, []);

  const trackQuoteCursor = useCallback((nextCursor: string | null) => {
    if (!nextCursor) {
      return null;
    }
    if (quoteSeenCursorsRef.current.has(nextCursor)) {
      return null;
    }
    quoteSeenCursorsRef.current.add(nextCursor);
    return nextCursor;
  }, []);

  const setThreadMessage = useCallback((uri: string, message: string) => {
    setThreadStates((prev) => {
      const current = prev[uri] || { loading: false, visible: false, parents: [], message: null };
      return {
        ...prev,
        [uri]: {
          ...current,
          loading: false,
          visible: false,
          message,
        },
      };
    });

    const existingTimer = threadMessageTimersRef.current[uri];
    if (existingTimer) {
      window.clearTimeout(existingTimer);
    }

    threadMessageTimersRef.current[uri] = window.setTimeout(() => {
      setThreadStates((prev) => {
        const current = prev[uri];
        if (!current) return prev;
        return {
          ...prev,
          [uri]: {
            ...current,
            message: null,
          },
        };
      });
      delete threadMessageTimersRef.current[uri];
    }, 2000);
  }, []);

  const handleToggleThread = useCallback(
    async (post: Post) => {
      const uri = post.uri;
      if (!uri) return;

      const current =
        threadStatesRef.current[uri] ||
        ({ loading: false, visible: false, parents: [], message: null } satisfies ThreadState);

      if (current.loading) return;

      if (current.visible) {
        setThreadStates((prev) => ({
          ...prev,
          [uri]: {
            ...current,
            visible: false,
            message: null,
          },
        }));
        return;
      }

      if (current.parents.length > 0) {
        setThreadStates((prev) => ({
          ...prev,
          [uri]: {
            ...current,
            visible: true,
            message: null,
          },
        }));
        return;
      }

      setThreadStates((prev) => ({
        ...prev,
        [uri]: {
          ...current,
          loading: true,
          message: null,
        },
      }));

      try {
        const parents = await fetchThreadParents(uri);
        if (parents.length === 0) {
          setThreadMessage(uri, 'No parent posts found');
          return;
        }

        setThreadStates((prev) => ({
          ...prev,
          [uri]: {
            loading: false,
            visible: true,
            parents,
            message: null,
          },
        }));
      } catch {
        setThreadMessage(uri, 'Failed to load thread');
      }
    },
    [setThreadMessage],
  );

  const refreshSearch = useCallback(async () => {
    if (searchTermsRef.current.length === 0) {
      return 0;
    }

    const hours = timeFilterRef.current;
    const minLikes = minLikesRef.current;
    const cutoffTs = Date.now() - hours * 3600000;

    const retainedMap = new Map<string, Post>();
    for (const [uri, post] of ingestedPostsRef.current.entries()) {
      if (getPostTimestamp(post) < cutoffTs) continue;
      if ((post.likeCount || 0) < minLikes) continue;
      retainedMap.set(uri, post);
    }
    ingestedPostsRef.current = retainedMap;

    setAllPosts(sortPosts(Array.from(retainedMap.values()), searchSortRef.current));

    const filteredPending = filterByLikes(filterByDate(pendingPostsRef.current, hours), minLikes);
    pendingPostsRef.current = filteredPending;
    setPendingPosts(filteredPending);

    const existingUris = new Set([
      ...Array.from(retainedMap.keys()),
      ...filteredPending.map((post) => post.uri),
    ]);

    const results = await Promise.all(
      searchTermsRef.current.map((term) => fetchLatestPostsForTerm(term, searchSortRef.current)),
    );

    let latestPosts = deduplicatePosts(results.flat());
    latestPosts = filterByDate(latestPosts, hours);
    latestPosts = filterByLikes(latestPosts, minLikes);

    const newPosts = latestPosts.filter((post) => !existingUris.has(post.uri));

    clearNewPostHighlights();
    if (newPosts.length > 0) {
      const nextPending = deduplicatePosts([...filteredPending, ...newPosts]);
      pendingPostsRef.current = nextPending;
      setPendingPosts(nextPending);
      setNewPostUris(new Set(newPosts.map((post) => post.uri)));
      scheduleHighlightClear();
    }

    return newPosts.length;
  }, [clearNewPostHighlights, fetchLatestPostsForTerm, scheduleHighlightClear]);

  const scheduleNextRefresh = useCallback(() => {
    clearRefreshTimers();

    if (!autoRefreshEnabledRef.current) {
      setNextRefreshAt(null);
      return;
    }

    const minutes = Number.parseInt(refreshIntervalMinutes, 10);
    const intervalMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60000 : 5 * 60000;
    const nextAt = Date.now() + intervalMs;

    setNextRefreshAt(nextAt);

    refreshTimerRef.current = window.setTimeout(() => {
      void runAutoRefreshRef.current();
    }, intervalMs);

    refreshCountdownRef.current = window.setInterval(() => {
      setClockNow(Date.now());
    }, 1000);
  }, [clearRefreshTimers, refreshIntervalMinutes]);

  const runAutoRefresh = useCallback(async () => {
    if (!autoRefreshEnabledRef.current) {
      return;
    }

    if (isLoadingRef.current || isRefreshingRef.current) {
      scheduleNextRefresh();
      return;
    }

    if (searchTermsRef.current.length === 0) {
      setAutoRefreshEnabled(false);
      autoRefreshEnabledRef.current = false;
      setNextRefreshAt(null);
      setLastRefreshError('Run a search first.');
      clearRefreshTimers();
      return;
    }

    setIsRefreshing(true);
    isRefreshingRef.current = true;
    setLastRefreshError(null);
    setLastRefreshNewCount(null);

    try {
      const newCount = await refreshSearch();
      setLastRefreshAt(new Date());
      setLastRefreshNewCount(newCount);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Refresh failed.';
      setLastRefreshError(message);
    } finally {
      setIsRefreshing(false);
      isRefreshingRef.current = false;
      scheduleNextRefresh();
    }
  }, [clearRefreshTimers, refreshSearch, scheduleNextRefresh]);

  useEffect(() => {
    runAutoRefreshRef.current = runAutoRefresh;
  }, [runAutoRefresh]);

  const performSearch = useCallback(async () => {
    if (isLoadingRef.current) {
      pendingSearchRef.current = true;
      return;
    }

    pendingSearchRef.current = false;

    const termsValue = termsInput.trim();
    if (!termsValue) {
      setStatus({ type: 'error', message: 'Please enter at least one search term.' });
      return;
    }

    const rawTerms = termsValue
      .split(',')
      .map((term) => normalizeTerm(term))
      .filter((term) => term.length > 0);

    if (rawTerms.length === 0) {
      setStatus({ type: 'error', message: 'Please enter at least one search term.' });
      return;
    }

    const expandedTerms = expandSearchTerms(rawTerms, expandTerms);
    const minLikes = Number.parseInt(minLikesInput, 10) || 0;
    const timeHours = Number.parseInt(timeFilter, 10) || 24;

    minLikesRef.current = minLikes;
    timeFilterRef.current = timeHours;
    searchSortRef.current = searchSort;

    setSearchTerms(expandedTerms);

    searchGenerationRef.current += 1;
    const generation = searchGenerationRef.current;

    setIsLoading(true);
    isLoadingRef.current = true;

    setStatus({ type: 'loading', message: `Searching for: ${rawTerms.join(', ')}...` });

    ingestedPostsRef.current.clear();
    setAllPosts([]);
    setCurrentCursors({});
    currentCursorsRef.current = {};
    setThreadStates({});
    clearThreadMessageTimers();
    clearNewPostHighlights();
    pendingPostsRef.current = [];
    setPendingPosts([]);
    setRenderLimit(INITIAL_RENDER_LIMIT);
    setRevealedImages(new Set());

    let completedSearch = false;

    try {
      let completedTerms = 0;
      const totalTerms = expandedTerms.length;

      const results = await Promise.allSettled(
        expandedTerms.map(async (term) => {
          const posts = await fetchAllPostsForTerm(term, searchSort);

          if (searchGenerationRef.current !== generation) {
            return posts;
          }

          completedTerms += 1;
          ingestPosts(posts);
          recomputeDerivedPosts();

          if (completedTerms < totalTerms) {
            setStatus({ type: 'loading', message: `Loaded ${completedTerms}/${totalTerms} terms...` });
          }

          return posts;
        }),
      );

      if (searchGenerationRef.current !== generation) {
        return;
      }

      const failures = results.filter((result) => result.status === 'rejected');

      if (failures.length > 0) {
        const firstFailure = failures[0] as PromiseRejectedResult;
        const message =
          failures.length === totalTerms
            ? `Search failed: ${
                firstFailure.reason instanceof Error
                  ? firstFailure.reason.message
                  : 'Unknown search error'
              }`
            : `${failures.length}/${totalTerms} terms failed to load`;
        setStatus({ type: 'error', message });
      } else {
        setStatus(null);
      }

      recomputeDerivedPosts();
      setLastRefreshAt(new Date());
      setLastRefreshNewCount(null);
      setLastRefreshError(null);
      completedSearch = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Search failed.';
      setStatus({ type: 'error', message: `Error: ${message}` });
    } finally {
      setIsLoading(false);
      isLoadingRef.current = false;

      if (autoRefreshEnabledRef.current && completedSearch) {
        scheduleNextRefresh();
      }

      if (pendingSearchRef.current) {
        pendingSearchRef.current = false;
        void performSearchRef.current();
      }
    }
  }, [
    clearNewPostHighlights,
    clearThreadMessageTimers,
    expandTerms,
    fetchAllPostsForTerm,
    ingestPosts,
    minLikesInput,
    recomputeDerivedPosts,
    scheduleNextRefresh,
    searchSort,
    termsInput,
    timeFilter,
  ]);

  useEffect(() => {
    performSearchRef.current = performSearch;
  }, [performSearch]);

  const loadMore = useCallback(async () => {
    if (isLoadingRef.current) {
      return;
    }

    setIsLoading(true);
    isLoadingRef.current = true;

    const previousCount = allPosts.length;

    try {
      const termsWithCursor = searchTermsRef.current.filter(
        (term) => currentCursorsRef.current[term],
      );

      const results = await Promise.all(
        termsWithCursor.map(async (term) => {
          const data = await searchTerm(term, currentCursorsRef.current[term] || null, searchSortRef.current);

          setCurrentCursors((prev) => {
            const next = { ...prev, [term]: data.cursor || null };
            currentCursorsRef.current = next;
            return next;
          });

          return data.posts.map((post) => ({
            ...post,
            matchedTerm: term,
          }));
        }),
      );

      const fetchedPosts = results.flat();

      if (fetchedPosts.length > 0) {
        ingestPosts(fetchedPosts);
        const nextPosts = recomputeDerivedPosts();
        if (nextPosts.length > previousCount) {
          setRenderLimit((prev) => Math.min(nextPosts.length, prev + RENDER_STEP));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Load more failed.';
      setStatus({ type: 'error', message: `Error loading more: ${message}` });
    } finally {
      setIsLoading(false);
      isLoadingRef.current = false;
    }
  }, [allPosts.length, ingestPosts, recomputeDerivedPosts]);

  const mergePendingPosts = useCallback(() => {
    if (pendingPostsRef.current.length === 0) return;

    const pending = pendingPostsRef.current;
    ingestPosts(pending);
    recomputeDerivedPosts();

    clearNewPostHighlights();
    setNewPostUris(new Set(pending.map((post) => post.uri)));
    scheduleHighlightClear();

    pendingPostsRef.current = [];
    setPendingPosts([]);
  }, [clearNewPostHighlights, ingestPosts, recomputeDerivedPosts, scheduleHighlightClear]);

  const dismissPendingPosts = useCallback(() => {
    pendingPostsRef.current = [];
    setPendingPosts([]);
    clearNewPostHighlights();
  }, [clearNewPostHighlights]);

  const scheduleDebouncedSearch = useCallback(() => {
    clearDebouncedSearch();
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null;
      void performSearchRef.current();
    }, SEARCH_DEBOUNCE_MS);
  }, [clearDebouncedSearch]);

  const handleTermsInputChange = useCallback(
    (value: string) => {
      setTermsInput(value);
      if (!value.trim()) {
        clearDebouncedSearch();
        pendingSearchRef.current = false;
        return;
      }
      scheduleDebouncedSearch();
    },
    [clearDebouncedSearch, scheduleDebouncedSearch],
  );

  const handleMinLikesInputChange = useCallback(
    (value: string) => {
      setMinLikesInput(value);
      if (!termsInput.trim()) return;
      scheduleDebouncedSearch();
    },
    [scheduleDebouncedSearch, termsInput],
  );

  const enableAutoRefresh = useCallback(() => {
    if (searchTermsRef.current.length === 0) {
      setAutoRefreshEnabled(false);
      autoRefreshEnabledRef.current = false;
      setLastRefreshError('Run a search first.');
      return;
    }

    setAutoRefreshEnabled(true);
    autoRefreshEnabledRef.current = true;
    setLastRefreshError(null);
    scheduleNextRefresh();
  }, [scheduleNextRefresh]);

  const disableAutoRefresh = useCallback(() => {
    setAutoRefreshEnabled(false);
    autoRefreshEnabledRef.current = false;
    clearRefreshTimers();
    setNextRefreshAt(null);
  }, [clearRefreshTimers]);

  const performQuoteSearch = useCallback(
    async (urlOverride?: string) => {
      if (isQuoteLoading) {
        return;
      }

      const value = (urlOverride ?? postUrl).trim();
      if (!value) {
        setQuoteStatus({ type: 'error', message: 'Please enter a Bluesky post URL.' });
        return;
      }

      setIsQuoteLoading(true);
      setQuoteStatus({ type: 'loading', message: 'Loading quotes...' });
      setQuoteOriginalPost(null);
      setAllQuotes([]);
      setQuoteCursor(null);
      setQuoteTotalCount(null);
      setActiveQuoteUri(null);
      quoteSeenCursorsRef.current = new Set();

      try {
        const { actor, postId } = parseBlueskyPostUrl(value);
        const did = await fetchDid(actor);
        const atUri = `at://${did}/app.bsky.feed.post/${postId}`;

        setActiveQuoteUri(atUri);

        const [originalPost, quotePage] = await Promise.all([
          fetchOriginalPost(atUri),
          fetchQuotesPage(atUri),
        ]);

        setQuoteOriginalPost(originalPost);
        setAllQuotes(quotePage.posts);
        setQuoteCursor(trackQuoteCursor(quotePage.cursor));

        if (
          Number.isFinite(originalPost.quoteCount) &&
          (originalPost.quoteCount || 0) >= quotePage.posts.length
        ) {
          setQuoteTotalCount(originalPost.quoteCount || 0);
        } else {
          setQuoteTotalCount(null);
        }

        setQuoteStatus(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Quote search failed.';
        setQuoteStatus({ type: 'error', message: `Error: ${message}` });
      } finally {
        setIsQuoteLoading(false);
      }
    },
    [isQuoteLoading, postUrl, trackQuoteCursor],
  );

  const loadMoreQuotes = useCallback(async () => {
    if (isQuoteLoading || !activeQuoteUri || !quoteCursor) {
      return;
    }

    setIsQuoteLoading(true);

    try {
      const page = await fetchQuotesPage(activeQuoteUri, quoteCursor);
      if (page.posts.length > 0) {
        setAllQuotes((prev) => prev.concat(page.posts));
      }
      setQuoteCursor(trackQuoteCursor(page.cursor));
      setQuoteStatus(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Load more quotes failed.';
      setQuoteStatus({ type: 'error', message: `Error loading more quotes: ${message}` });
    } finally {
      setIsQuoteLoading(false);
    }
  }, [activeQuoteUri, isQuoteLoading, quoteCursor, trackQuoteCursor]);

  useEffect(() => {
    if (hasAutoQuoteLoadedRef.current) {
      return;
    }
    hasAutoQuoteLoadedRef.current = true;

    if (initialUrlState.post) {
      void performQuoteSearch(initialUrlState.post);
    }
  }, [initialUrlState.post, performQuoteSearch]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setQueryParam(params, 'terms', termsInput.trim());
    setQueryParam(params, 'minLikes', minLikesInput);
    setQueryParam(params, 'time', timeFilter !== '24' ? timeFilter : '');
    setQueryParam(params, 'searchSort', searchSort !== 'top' ? searchSort : '');
    setQueryParam(params, 'expand', expandTerms ? '1' : '');

    const trimmedPost = postUrl.trim();
    setQueryParam(params, 'post', trimmedPost);
    if (trimmedPost) {
      setQueryParam(params, 'quoteSort', quoteSort !== 'likes' ? quoteSort : '');
    } else {
      params.delete('quoteSort');
    }

    // Keep writes on explicit params while preserving read compatibility for legacy sort.
    params.delete('sort');

    const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
    window.history.replaceState({}, '', nextUrl);
  }, [expandTerms, minLikesInput, postUrl, quoteSort, searchSort, termsInput, timeFilter]);

  useEffect(() => {
    if (autoRefreshEnabledRef.current) {
      scheduleNextRefresh();
    }
  }, [refreshIntervalMinutes, scheduleNextRefresh]);

  useEffect(() => {
    return () => {
      clearDebouncedSearch();
      clearRefreshTimers();
      clearNewPostHighlights();
      clearThreadMessageTimers();
    };
  }, [clearDebouncedSearch, clearNewPostHighlights, clearRefreshTimers, clearThreadMessageTimers]);

  const visibleCount = Math.min(renderLimit, allPosts.length);
  const visiblePosts = allPosts.slice(0, visibleCount);
  const remainingLoaded = allPosts.length - visibleCount;
  const hasMoreResults = Object.values(currentCursors).some((cursor) => cursor !== null);

  const refreshStateText = autoRefreshEnabled
    ? isRefreshing
      ? 'Refreshing...'
      : 'Auto-refresh on'
    : 'Auto-refresh off';

  const refreshLastText = lastRefreshError
    ? `Last update failed: ${lastRefreshError}`
    : lastRefreshAt
      ? `Last updated: ${formatTime(lastRefreshAt)}${
          typeof lastRefreshNewCount === 'number' ? ` (+${lastRefreshNewCount} new)` : ''
        }`
      : 'Last updated: --';

  const refreshNextText =
    autoRefreshEnabled && nextRefreshAt
      ? `Next refresh in ${formatDuration(nextRefreshAt - clockNow)}`
      : '';

  const sortedPendingPosts = useMemo(
    () => [...pendingPosts].sort((a, b) => getPostTimestamp(b) - getPostTimestamp(a)),
    [pendingPosts],
  );

  const sortedQuotes = useMemo(() => sortQuotes(allQuotes, quoteSort), [allQuotes, quoteSort]);

  const quoteCountLabel = useMemo(() => {
    if (typeof quoteTotalCount === 'number') {
      return `Loaded ${allQuotes.length} of ${quoteTotalCount} quote${quoteTotalCount === 1 ? '' : 's'}`;
    }
    return `Loaded ${allQuotes.length} quote${allQuotes.length === 1 ? '' : 's'}`;
  }, [allQuotes.length, quoteTotalCount]);

  const onSearchSubmit = (event: FormEvent) => {
    event.preventDefault();
    clearDebouncedSearch();
    void performSearch();
  };

  const onQuoteSubmit = (event: FormEvent) => {
    event.preventDefault();
    void performQuoteSearch();
  };

  const onSearchInputKeyPress = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    clearDebouncedSearch();
    event.preventDefault();
    void performSearch();
  };

  return (
    <div className="mx-auto min-h-screen w-full max-w-4xl px-4 py-6 text-[var(--text)]">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Bluesky Term Search</h1>
          <p className="text-sm text-[var(--muted)]">Search posts filtered by time and engagement</p>
        </div>

        <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
          <span>Theme</span>
          <select
            value={themePreference}
            onChange={(event) =>
              setThemePreference(event.target.value as 'light' | 'dark' | 'system')
            }
            className="rounded-md border border-[var(--input-border)] bg-[var(--input-bg)] px-2 py-1 text-[var(--text)]"
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </label>
      </header>

      <form
        onSubmit={onSearchSubmit}
        className="mb-6 space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
      >
        <div>
          <label className="mb-1 block text-sm font-medium text-[var(--muted)]" htmlFor="terms">
            Search Terms (comma-separated)
          </label>
          <input
            id="terms"
            type="text"
            value={termsInput}
            onChange={(event) => handleTermsInputChange(event.target.value)}
            onKeyDown={onSearchInputKeyPress}
            placeholder="Enter search terms..."
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-md border border-[var(--input-border)] bg-[var(--input-bg)] px-3 py-2 text-base text-[var(--text)]"
          />
        </div>

        <div className="rounded-lg border border-[var(--border)] bg-[var(--card-bg)] p-3">
          <div className="mb-2 text-sm font-medium text-[var(--muted)]">Phrase Expansion</div>
          <label className="mb-2 flex items-center gap-2 text-sm text-[var(--text)]">
            <input
              type="checkbox"
              checked={expandTerms}
              onChange={(event) => setExpandTerms(event.target.checked)}
            />
            <span>Also search each word in multi-word phrases</span>
          </label>
          <p className="text-xs text-[var(--muted-2)]">{expansionSummary}</p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--muted)]" htmlFor="minLikes">
              Min. Likes
            </label>
            <input
              id="minLikes"
              type="number"
              min={0}
              value={minLikesInput}
              onChange={(event) => handleMinLikesInputChange(event.target.value)}
              onKeyDown={onSearchInputKeyPress}
              className="w-full rounded-md border border-[var(--input-border)] bg-[var(--input-bg)] px-3 py-2 text-[var(--text)]"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--muted)]" htmlFor="timeFilter">
              Time Range
            </label>
            <select
              id="timeFilter"
              value={timeFilter}
              onChange={(event) => setTimeFilter(event.target.value)}
              className="w-full rounded-md border border-[var(--input-border)] bg-[var(--input-bg)] px-3 py-2 text-[var(--text)]"
            >
              {TIME_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value === '168' ? '7 days' : `${value} ${value === '1' ? 'hour' : 'hours'}`}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--muted)]" htmlFor="sortSelect">
              Sort
            </label>
            <select
              id="sortSelect"
              value={searchSort}
              onChange={(event) => {
                const next = event.target.value as SearchSort;
                if (!SEARCH_SORT_OPTIONS.includes(next)) return;
                setSearchSort(next);
                if (autoRefreshEnabledRef.current) {
                  scheduleNextRefresh();
                }
              }}
              className="w-full rounded-md border border-[var(--input-border)] bg-[var(--input-bg)] px-3 py-2 text-[var(--text)]"
            >
              <option value="top">Top</option>
              <option value="latest">Latest</option>
            </select>
          </div>

          <div className="flex items-end">
            <button
              type="submit"
              disabled={isLoading}
              className="w-full rounded-md bg-[var(--accent)] px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:bg-[var(--button-disabled)]"
            >
              {isLoading ? 'Searching...' : 'Search'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 rounded-lg border border-[var(--border)] bg-[var(--card-bg)] p-3 md:grid-cols-[1fr_1fr_2fr_auto]">
          <div>
            <div className="mb-1 text-sm font-medium text-[var(--muted)]">Auto-refresh</div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoRefreshEnabled}
                onChange={(event) => {
                  if (event.target.checked) {
                    enableAutoRefresh();
                  } else {
                    disableAutoRefresh();
                  }
                }}
              />
              <span>Enable</span>
            </label>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-[var(--muted)]" htmlFor="refreshInterval">
              Interval
            </label>
            <select
              id="refreshInterval"
              value={refreshIntervalMinutes}
              onChange={(event) => setRefreshIntervalMinutes(event.target.value)}
              className="w-full rounded-md border border-[var(--input-border)] bg-[var(--input-bg)] px-3 py-2 text-[var(--text)]"
            >
              <option value="2">2 min</option>
              <option value="5">5 min</option>
              <option value="10">10 min</option>
              <option value="30">30 min</option>
            </select>
          </div>

          <div className="text-sm text-[var(--muted-2)]">
            <div className="font-semibold text-[var(--text)]">{refreshStateText}</div>
            <div>{refreshLastText}</div>
            <div>{refreshNextText}</div>
          </div>

          <a
            href="https://bskyfeed.vum.sh/"
            target="_blank"
            rel="noopener noreferrer"
            className="self-end text-sm text-[var(--accent)] hover:underline"
          >
            Custom keyword feed
          </a>
        </div>
      </form>

      <StatusBanner status={status} />

      {pendingPosts.length > 0 && (
        <section
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="mb-4 rounded-xl border border-[var(--accent-soft-border)] bg-[var(--accent-soft)] p-4"
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold text-[var(--accent-text)]">
              {pendingPosts.length} new post{pendingPosts.length === 1 ? '' : 's'} from auto-refresh
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={mergePendingPosts}
                className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white"
              >
                Add to results
              </button>
              <button
                type="button"
                onClick={dismissPendingPosts}
                className="rounded-md border border-[var(--input-border)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--text)]"
              >
                Dismiss
              </button>
            </div>
          </div>

          <div className="space-y-3">
            {sortedPendingPosts.map((post) => (
              <PostCard
                key={`pending-${post.uri}`}
                post={post}
                searchTerms={searchTerms}
                isHighlighted={newPostUris.has(post.uri)}
                showImages={revealedImages.has(post.uri)}
                onShowImages={(uri) =>
                  setRevealedImages((prev) => {
                    const next = new Set(prev);
                    next.add(uri);
                    return next;
                  })
                }
                threadState={threadStates[post.uri]}
                onToggleThread={handleToggleThread}
              />
            ))}
          </div>
        </section>
      )}

      <section>
        {allPosts.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-10 text-center text-[var(--muted)]">
            <p>
              {pendingPosts.length > 0
                ? 'New posts are waiting above.'
                : 'No posts found matching your criteria.'}
            </p>
            <p className="mt-1 text-sm text-[var(--muted-2)]">
              {pendingPosts.length > 0
                ? 'Use "Add to results" to merge them into the main list.'
                : 'Try different search terms or lower the minimum likes.'}
            </p>
          </div>
        ) : (
          <>
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-soft)] pb-3 text-sm"
            >
              <span className="font-medium">
                {visibleCount < allPosts.length
                  ? `Showing ${visibleCount} of ${allPosts.length} posts`
                  : `${allPosts.length} post${allPosts.length === 1 ? '' : 's'} found`}
              </span>
              <span className="text-[var(--muted)]">
                {searchSort === 'latest'
                  ? 'Sorted by time (newest first)'
                  : 'Sorted by likes (high to low)'}
              </span>
            </div>

            <div className="space-y-3">
              {visiblePosts.map((post) => (
                <PostCard
                  key={post.uri}
                  post={post}
                  searchTerms={searchTerms}
                  isHighlighted={newPostUris.has(post.uri)}
                  showImages={revealedImages.has(post.uri)}
                  onShowImages={(uri) =>
                    setRevealedImages((prev) => {
                      const next = new Set(prev);
                      next.add(uri);
                      return next;
                    })
                  }
                  threadState={threadStates[post.uri]}
                  onToggleThread={handleToggleThread}
                />
              ))}
            </div>

            {remainingLoaded > 0 && (
              <button
                type="button"
                onClick={() => setRenderLimit((prev) => Math.min(allPosts.length, prev + RENDER_STEP))}
                className="mt-4 w-full rounded-md border border-[var(--input-border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--text)]"
              >
                {remainingLoaded <= RENDER_STEP
                  ? remainingLoaded === 1
                    ? 'Show 1 more loaded result'
                    : `Show ${remainingLoaded} more loaded results`
                  : `Show ${RENDER_STEP} more loaded results`}
              </button>
            )}

            {hasMoreResults && (
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={isLoading}
                className="mt-3 w-full rounded-md border border-[var(--input-border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--text)] disabled:cursor-not-allowed"
              >
                {isLoading ? 'Loading...' : 'Load More Results'}
              </button>
            )}
          </>
        )}
      </section>

      <section className="mt-10 border-t border-[var(--border-soft)] pt-4">
        <h2 className="text-xl font-semibold">Quote Finder</h2>
        <p className="mb-3 text-sm text-[var(--muted)]">Find all quotes of a Bluesky post</p>

        <form
          onSubmit={onQuoteSubmit}
          className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
            <div>
              <label className="mb-1 block text-sm font-medium text-[var(--muted)]" htmlFor="postUrl">
                Bluesky Post URL
              </label>
              <input
                id="postUrl"
                type="url"
                required
                value={postUrl}
                onChange={(event) => setPostUrl(event.target.value)}
                placeholder="https://bsky.app/profile/handle/post/abc123"
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-md border border-[var(--input-border)] bg-[var(--input-bg)] px-3 py-2 text-[var(--text)]"
              />
            </div>

            <button
              type="submit"
              disabled={isQuoteLoading}
              className="self-end rounded-md bg-[var(--accent)] px-4 py-2 text-white disabled:cursor-not-allowed disabled:bg-[var(--button-disabled)]"
            >
              {isQuoteLoading ? 'Loading...' : 'Find Quotes'}
            </button>
          </div>
        </form>

        <StatusBanner status={quoteStatus} />

        {quoteOriginalPost && (
          <>
            <div className="mb-4 flex flex-wrap gap-2 border-b border-[var(--border-soft)]">
              {QUOTE_SORT_OPTIONS.map((sortMode) => (
                <button
                  key={sortMode}
                  type="button"
                  onClick={() => setQuoteSort(sortMode)}
                  className={`border-b-2 px-3 py-2 text-sm ${
                    quoteSort === sortMode
                      ? 'border-[var(--accent)] font-semibold text-[var(--accent)]'
                      : 'border-transparent text-[var(--muted)]'
                  }`}
                >
                  {QUOTE_TAB_LABELS[sortMode]}
                </button>
              ))}
            </div>

            <article className="mb-4 rounded-xl border border-[var(--accent-soft-border)] bg-[var(--accent-soft)] p-4">
              <div className="mb-2 text-xs uppercase tracking-wide text-[var(--muted)]">Original Post</div>
              <div className="mb-1 font-semibold">
                {quoteOriginalPost.author?.displayName || quoteOriginalPost.author?.handle} (@
                {quoteOriginalPost.author?.handle})
              </div>
              <div className="mb-2 text-xs text-[var(--muted-2)]">
                {formatDateTime(quoteOriginalPost.record?.createdAt || quoteOriginalPost.indexedAt)}
              </div>
              {getPostUrl(quoteOriginalPost) && (
                <a
                  href={getPostUrl(quoteOriginalPost) || undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mb-2 inline-block text-sm text-[var(--accent)] hover:underline"
                >
                  View on Bluesky
                </a>
              )}
              <p className="mb-2 whitespace-pre-wrap break-words text-sm">
                {quoteOriginalPost.record?.text || ''}
              </p>
              <div className="flex flex-wrap gap-4 text-xs text-[var(--muted)]">
                <span className="font-semibold text-pink-500">Likes {quoteOriginalPost.likeCount || 0}</span>
                <span>Reposts {quoteOriginalPost.repostCount || 0}</span>
                <span>Replies {quoteOriginalPost.replyCount || 0}</span>
                <span>Quotes {quoteOriginalPost.quoteCount || 0}</span>
              </div>
            </article>

            <div className="mb-3 text-sm text-[var(--muted)]">{quoteCountLabel}</div>

            {sortedQuotes.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--border)] px-4 py-8 text-center text-[var(--muted)]">
                No quotes found for this post.
              </div>
            ) : (
              <div className="space-y-3">
                {sortedQuotes.map((quote, index) => (
                  <article
                    key={quote.uri}
                    data-depth={(index % 8) + 1}
                    className="quote-depth-stripe rounded-xl border border-[var(--border)] bg-[var(--card-bg)] p-4"
                  >
                    <div className="mb-1 font-semibold">
                      {quote.author?.displayName || quote.author?.handle} (@{quote.author?.handle})
                    </div>
                    <div className="mb-2 text-xs text-[var(--muted-2)]">
                      {formatDateTime(quote.record?.createdAt || quote.indexedAt)}
                    </div>
                    {getPostUrl(quote) && (
                      <a
                        href={getPostUrl(quote) || undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mb-2 inline-block text-sm text-[var(--accent)] hover:underline"
                      >
                        View on Bluesky
                      </a>
                    )}
                    <p className="mb-2 whitespace-pre-wrap break-words text-sm">
                      {quote.record?.text || ''}
                    </p>
                    <div className="flex flex-wrap gap-4 text-xs text-[var(--muted)]">
                      <span className="font-semibold text-pink-500">Likes {quote.likeCount || 0}</span>
                      <span>Reposts {quote.repostCount || 0}</span>
                      <span>Replies {quote.replyCount || 0}</span>
                    </div>
                  </article>
                ))}
              </div>
            )}

            {quoteCursor && (
              <button
                type="button"
                onClick={() => void loadMoreQuotes()}
                disabled={isQuoteLoading}
                className="mt-4 w-full rounded-md border border-[var(--input-border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--text)] disabled:cursor-not-allowed"
              >
                {isQuoteLoading ? 'Loading...' : 'Load More Quotes'}
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
