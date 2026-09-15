import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestDocument, deferred } from './helpers/dom.mjs';

let search, state, elements, proxy;
const epoch = Date.parse('2026-09-15T12:00:00Z');
const env = { env: { BSKY_HANDLE: 'fixture', BSKY_APP_PASSWORD: 'fixture' } };
function post(id, saves = 0, live = false) {
  return {
    uri: `at://did:plc:fixture/app.bsky.feed.post/${id}`,
    author: {
      did: 'did:plc:fixture', handle: 'handle.invalid', displayName: 'Fixture',
      ...(live ? { status: { status: 'app.bsky.actor.status#live', expiresAt: new Date(epoch + 3600000).toISOString() } } : {}),
    },
    record: { text: `apple ${id}`, createdAt: new Date(epoch).toISOString() },
    likeCount: 30, bookmarkCount: saves,
  };
}
const page = (cursor) => ({
  posts: [post(cursor ? (cursor === 'c1' ? 'p2' : 'p3') : 'p1', cursor === 'c2' ? 100 : 1)],
  cursor: cursor === 'c2' ? null : cursor === 'c1' ? 'c2' : 'c1',
});
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(epoch);
  const dom = createTestDocument(['terms', 'minLikes', 'timeFilter', 'sortSelect', 'searchBtn', 'status', 'results', 'expandTermsToggle', 'expandSummary']);
  elements = dom.elements;
  vi.stubGlobal('document', dom.document);
  vi.stubGlobal('window', { history: { replaceState: vi.fn() }, location: { pathname: '/', search: '' } });
  vi.stubGlobal('requestAnimationFrame', callback => setTimeout(callback, 0));
  vi.stubGlobal('cancelAnimationFrame', id => clearTimeout(id));
  vi.stubGlobal('fetch', vi.fn(async url => Response.json(page(new URL(url, 'https://fixture.test').searchParams.get('cursor')))));
  search = await import('../src/search.mjs');
  ({ state } = await import('../src/state.mjs'));
  elements.terms.value = 'apple'; elements.minLikes.value = '0';
  elements.sortSelect.value = 'top'; elements.timeFilter.value = '24';
  elements.expandTermsToggle.checked = false;
});
afterEach(() => {
  search.clearSearchResults(); proxy?.testUtils.resetModuleStateForTests(); proxy = null;
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it('preserves the third loaded page and its most-saved winner on a local sort change', async () => {
  await search.performSearch(); await search.loadMore();
  expect(state.allPosts).toHaveLength(3);
  expect(state.currentCursors.apple).toBe(null);
  const since = state.searchSince;
  const renderLimit = state.renderLimit;
  elements.minLikes.value = '10'; search.applyMinLikesFilter();
  expect(state.allPosts).toHaveLength(3);
  elements.sortSelect.value = 'bookmarks'; state.searchSort = 'bookmarks';
  await search.applySearchSortChange();
  expect(state.allPosts.map(p => p.uri.split('/').pop())).toEqual(['p3', 'p1', 'p2']);
  expect(state.currentCursors.apple).toBe(null);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(state.searchSince).toBe(since);
  expect(state.renderLimit).toBe(renderLimit);
  elements.sortSelect.value = 'top'; state.searchSort = 'top';
  await search.applySearchSortChange();
  expect(state.allPosts).toHaveLength(3);
  expect(state.currentCursors.apple).toBe(null);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('keeps loaded results when a sort change coincides with expired caches and auth cooldown', async () => {
  proxy = await import('../api/search.mjs');
  let rateLimited = false;
  const upstream = { login: 0, refresh: 0, search: 0 };
  fetch.mockImplementation(async (url, options) => {
    if (String(url).startsWith('/api/search?')) return proxy.GET(new Request(`https://fixture.test${url}`, options), env);
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('createSession')) {
      upstream.login++;
      return Response.json({ accessJwt: 'access-a', refreshJwt: 'refresh-a' });
    }
    if (parsed.pathname.endsWith('refreshSession')) {
      upstream.refresh++;
      return Response.json({ error: 'RateLimitExceeded' }, { status: 429, headers: { 'Retry-After': '60' } });
    }
    upstream.search++;
    return rateLimited
      ? Response.json({ error: 'ExpiredToken' }, { status: 400 })
      : Response.json(page(parsed.searchParams.get('cursor')));
  });
  await search.performSearch();
  expect(state.allPosts).toHaveLength(2);
  const since = state.searchSince;
  await vi.advanceTimersByTimeAsync(61000); rateLimited = true;
  elements.sortSelect.value = 'bookmarks'; state.searchSort = 'bookmarks';
  await search.applySearchSortChange();
  expect(state.allPosts).toHaveLength(2);
  expect(upstream.refresh).toBe(0);
  expect(upstream.search).toBe(2);
  expect(state.searchSince).toBe(since);
});

it('keeps an in-flight page alive when switching between local sort orders', async () => {
  await search.performSearch();
  const pending = deferred();
  let signal;
  fetch.mockImplementationOnce((_url, options) => { signal = options.signal; return pending.promise; });
  const loading = search.loadMore();
  await vi.advanceTimersByTimeAsync(0);
  const generation = state.searchGeneration;
  elements.sortSelect.value = 'bookmarks'; state.searchSort = 'bookmarks';
  await search.applySearchSortChange();
  expect(signal.aborted).toBe(false);
  expect(state.isLoading).toBe(true);
  expect(state.searchGeneration).toBe(generation);
  pending.resolve(Response.json(page('c2')));
  await loading;
  expect(state.allPosts.map(p => p.uri.split('/').pop())).toEqual(['p3', 'p1', 'p2']);
  expect(state.currentCursors.apple).toBe(null);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('submits changed terms when a sort control is used during the debounce', async () => {
  await search.performSearch();
  elements.terms.value = 'banana';
  search.debouncedSearch();
  fetch.mockImplementation(async () => Response.json({ posts: [post('banana')] }));
  elements.sortSelect.value = 'bookmarks'; state.searchSort = 'bookmarks';
  await search.applySearchSortChange();
  expect(state.searchTerms).toEqual(['banana']);
  expect(state.searchDebounceTimer).toBe(null);
  expect(state.allPosts.map(p => p.uri.split('/').pop())).toEqual(['banana']);
  expect(new URL(fetch.mock.calls.at(-1)[0], 'https://fixture.test').searchParams.get('term')).toBe('banana');
});

it('releases LIVE badge expiry timers when filtered cards and results are removed', async () => {
  fetch.mockImplementation(async () => Response.json({ posts: [post('live1', 1, true), post('live2', 2, true)] }));
  await search.performSearch(); await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(2);
  for (let i = 0; i < 10; i++) {
    elements.minLikes.value = '100'; search.applyMinLikesFilter();
    elements.minLikes.value = '0'; search.applyMinLikesFilter();
  }
  search.clearSearchResults();
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves a revealed video preview when an overlapping page updates only saves', async () => {
  const mediaPost = { ...post('video', 1), embed: { $type: 'app.bsky.embed.video#view', thumbnail: 'https://video.bsky.app/thumbnail.jpg', alt: 'Fixture video' } };
  fetch.mockImplementation(async url => {
    const cursor = new URL(url, 'https://fixture.test').searchParams.get('cursor');
    return Response.json(cursor === 'c2'
      ? { posts: [{ ...mediaPost, bookmarkCount: 99 }] }
      : cursor === 'c1' ? { posts: [], cursor: 'c2' } : { posts: [mediaPost], cursor: 'c1' });
  });
  await search.performSearch();
  const card = elements.results.querySelector('.post');
  card.querySelector('.image-placeholder').firstElementChild.listeners.get('click')();
  expect(card.querySelectorAll('.post-image')).toHaveLength(1);
  await search.loadMore();
  const updated = elements.results.querySelector('.post');
  expect(updated.querySelectorAll('.post-image')).toHaveLength(1);
  expect(updated).toBe(card);
  expect(updated.querySelector('.post-stats').children.at(-1).getAttribute('aria-label')).toBe('99 saves');
});

it('preserves pending and expanded threads while updating badges and engagement', async () => {
  const reply = { ...post('reply', 1, true), record: { ...post('reply').record, reply: { parent: { uri: post('parent').uri } } } };
  const pending = deferred();
  let threadSignal;
  fetch.mockImplementation(async (url, options) => {
    if (url.includes('getPostThread')) { threadSignal = options.signal; return pending.promise; }
    const cursor = new URL(url, 'https://fixture.test').searchParams.get('cursor');
    if (!cursor) return Response.json({ posts: [reply], cursor: 'c1' });
    if (cursor === 'c1') return Response.json({ posts: [], cursor: 'c2' });
    return Response.json({
      posts: [{ ...reply, bookmarkCount: cursor === 'c2' ? 10 : 11, author: { ...reply.author, pronouns: 'they/them', verification: { verifiedStatus: 'valid' } } }],
      ...(cursor === 'c2' ? { cursor: 'c3' } : {}),
    });
  });
  await search.performSearch(); await vi.advanceTimersByTimeAsync(0);
  const card = elements.results.querySelector('.post');
  const button = card.querySelector('button.thread-link');
  const expanding = button.listeners.get('click')();
  await search.loadMore(); await vi.advanceTimersByTimeAsync(0);
  expect(threadSignal.aborted).toBe(false);
  expect(elements.results.querySelector('.post')).toBe(card);
  expect(card.querySelector('.pronouns').textContent).toBe('they/them');
  expect(card.querySelector('.verified').textContent).toBe('Verified');
  expect(vi.getTimerCount()).toBe(2); // LIVE expiry plus the pending thread deadline.
  pending.resolve(Response.json({ thread: { parent: { post: post('parent') } } }));
  await expanding;
  const context = card.querySelector('.thread-context');
  expect(button.getAttribute('aria-expanded')).toBe('true');
  await search.loadMore();
  expect(card.querySelector('.thread-context')).toBe(context);
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(card.querySelector('.post-stats').children.at(-1).getAttribute('aria-label')).toBe('11 saves');
  expect(vi.getTimerCount()).toBe(1);
});
