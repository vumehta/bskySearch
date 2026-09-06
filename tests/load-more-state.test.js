import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDocument, deferred } from './helpers/dom.mjs';

let testDocument;
let elements;

function makePost(id, likeCount) {
  const now = new Date().toISOString();
  return {
    uri: `at://did:plc:test/app.bsky.feed.post/${id}`,
    author: { handle: 'alice.bsky.social', displayName: 'Alice' },
    record: { text: `post ${id} about apple`, createdAt: now },
    indexedAt: now,
    likeCount,
    repostCount: 0,
    replyCount: 0,
  };
}

// Every page carries a cursor, so the search always has more to load.
function makePagedFetch() {
  let page = 0;
  return vi.fn(async () => {
    page += 1;
    const pageId = page;
    return {
      ok: true,
      json: async () => ({
        cursor: `cursor-${pageId}`,
        posts: [makePost(`p${pageId}a`, 50), makePost(`p${pageId}b`, 20)],
      }),
    };
  });
}

function getLoadMoreButton() {
  return testDocument.getElementById('loadMoreBtn');
}

function getRequestedSinceValues(fetchMock) {
  return fetchMock.mock.calls.map(([url]) => new URL(url, 'https://example.test').searchParams.get('since'));
}

describe('search pagination and lifecycle', () => {
  let search;
  let state;

  beforeEach(async () => {
    vi.resetModules();
    ({ document: testDocument, elements } = createTestDocument([
      'terms', 'minLikes', 'timeFilter', 'sortSelect', 'searchBtn', 'status',
      'results', 'expandTermsToggle', 'expandSummary',
    ]));
    vi.stubGlobal('document', testDocument);
    vi.stubGlobal('requestAnimationFrame', (callback) => setTimeout(callback, 0));
    vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('window', {
      history: { replaceState: vi.fn() },
      location: { pathname: '/', search: '' },
    });
    search = await import('../src/search.mjs');
    ({ state } = await import('../src/state.mjs'));
    elements.terms.value = 'apple';
    elements.minLikes.value = '0';
    elements.sortSelect.value = 'top';
    elements.timeFilter.value = '24';
    elements.expandTermsToggle.checked = false;
  });

  afterEach(() => {
    search.clearSearchResults();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps pagination usable across initial, loading, completed, and terminal pages', async () => {
    globalThis.fetch = makePagedFetch();
    await search.performSearch();
    expect(state.isLoading).toBe(false);
    expect(state.currentCursors.apple).toBe('cursor-2');
    const button = getLoadMoreButton();
    expect(button.style.display).toBe('');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Load More Results');

    const pending = deferred();
    globalThis.fetch = vi.fn(() => pending.promise);
    const loadMorePromise = search.loadMore();
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));

    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Loading…');

    pending.resolve({
      ok: true,
      json: async () => ({ cursor: 'cursor-3', posts: [makePost('p3a', 5)] }),
    });
    await loadMorePromise;

    expect(state.currentCursors.apple).toBe('cursor-3');
    expect(button.style.display).toBe('');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Load More Results');

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ posts: [makePost('last', 5)] }),
    }));
    await search.loadMore();

    expect(state.currentCursors.apple).toBe(null);
    expect(button.style.display).toBe('none');
    expect(button.disabled).toBe(false);
  });

  it('sends the time window as since and reuses it when loading more', async () => {
    const before = Date.now();
    globalThis.fetch = makePagedFetch();
    await search.performSearch();
    const after = Date.now();

    const searchSince = getRequestedSinceValues(globalThis.fetch);
    expect(searchSince).toHaveLength(2);
    expect(searchSince[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
    expect(searchSince[1]).toBe(searchSince[0]);
    expect(state.searchSince).toBe(searchSince[0]);

    // 24-hour window, rounded down to the minute.
    const sinceTs = Date.parse(searchSince[0]);
    expect(sinceTs).toBeLessThanOrEqual(after - 24 * 3600000);
    expect(sinceTs).toBeGreaterThan(before - 24 * 3600000 - 60000);

    globalThis.fetch = makePagedFetch();
    await search.loadMore();
    expect(getRequestedSinceValues(globalThis.fetch)).toEqual([searchSince[0]]);
  });

  it('offers continuation when the first two pages contain no qualifying posts', async () => {
    elements.minLikes.value = '10';
    let page = 0;
    globalThis.fetch = vi.fn(async () => {
      page += 1;
      return { ok: true, json: async () => ({ cursor: `c${page}`, posts: [makePost(`p${page}`, page < 3 ? 0 : 50)] }) };
    });
    await search.performSearch();
    expect(state.allPosts).toEqual([]);
    expect(getLoadMoreButton().style.display).toBe('');
    expect(getLoadMoreButton().disabled).toBe(false);
    await search.loadMore();
    expect(state.allPosts.map((post) => post.uri)).toEqual([expect.stringContaining('/p3')]);
  });

  it('marks a terminal second initial page exhausted', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cursor: 'c1', posts: [makePost('p1', 20)] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ posts: [makePost('p2', 20)] }) });
    await search.performSearch();
    expect(state.currentCursors.apple).toBe(null);
    expect(getLoadMoreButton().style.display).toBe('none');
    await search.loadMore();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('stops repeated cursors and longer cursor cycles', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cursor: 'c1', posts: [makePost('p1', 20)] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cursor: 'c2', posts: [makePost('p2', 20)] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cursor: 'c1', posts: [makePost('p3', 20)] }) });
    await search.performSearch();
    await search.loadMore();
    expect(state.currentCursors.apple).toBe(null);
    expect(state.allPosts).toHaveLength(3);
    expect(getLoadMoreButton().style.display).toBe('none');
  });

  it('keeps a successful first page and retries only a failed second page', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cursor: 'c1', posts: [makePost('p1', 20)] }) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'Unavailable' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ posts: [makePost('p2', 20)] }) });
    await search.performSearch();
    expect(state.allPosts).toHaveLength(1);
    expect(state.currentCursors.apple).toBe('c1');
    expect(elements.status.textContent).toContain('Load more to retry');
    await search.loadMore();
    expect(state.allPosts).toHaveLength(2);
    expect(state.currentCursors.apple).toBe(null);
    expect(new URL(globalThis.fetch.mock.calls[2][0], 'https://example.test').searchParams.get('cursor')).toBe('c1');
    expect(elements.status.style.display).toBe('none');
  });

  it('retains a first-page failure as a retryable cursor', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ error: 'Rate limited' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ posts: [makePost('recovered', 20)] }) });
    await search.performSearch();
    expect(state.currentCursors.apple).toBe('');
    expect(getLoadMoreButton().style.display).toBe('');
    await search.loadMore();
    expect(state.allPosts).toHaveLength(1);
    expect(new URL(globalThis.fetch.mock.calls[1][0], 'https://example.test').searchParams.has('cursor')).toBe(false);
  });

  it('advances healthy terms independently when another pagination request fails', async () => {
    elements.terms.value = 'apple,banana';
    globalThis.fetch = vi.fn(async (url) => {
      const params = new URL(url, 'https://example.test').searchParams;
      return { ok: true, json: async () => ({ cursor: params.has('cursor') ? 'c2' : 'c1', posts: [makePost(`${params.get('term')}${params.get('cursor') || 'initial'}`, 20)] }) };
    });
    await search.performSearch();
    globalThis.fetch = vi.fn(async (url) => new URL(url, 'https://example.test').searchParams.get('term') === 'apple'
      ? { ok: true, json: async () => ({ cursor: 'c3', posts: [makePost('newapple', 20)] }) }
      : { ok: false, status: 500, json: async () => ({ error: 'Unavailable' }) });
    await search.loadMore();
    expect(state.allPosts).toHaveLength(5);
    expect(state.currentCursors).toEqual({ apple: 'c3', banana: 'c2' });
    expect(elements.status.textContent).toContain('1/2 terms');
    expect(state.isLoading).toBe(false);
    const button = getLoadMoreButton();
    expect(button.style.display).toBe('');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Load More Results');
  });

  it('supports object-property names as ordinary search terms', async () => {
    elements.terms.value = '__proto__,constructor';
    globalThis.fetch = makePagedFetch();
    await search.performSearch();
    expect(Object.keys(state.currentCursors)).toEqual(['__proto__', 'constructor']);
    await search.loadMore();
    expect(globalThis.fetch).toHaveBeenCalledTimes(6);
  });

  it('limits concurrent term requests to four without dropping queued terms', async () => {
    elements.terms.value = 'a,b,c,d,e,f,g,h,i';
    const pending = [];
    let active = 0;
    let peak = 0;
    globalThis.fetch = vi.fn(() => {
      active += 1;
      peak = Math.max(peak, active);
      const request = deferred();
      pending.push(() => { active -= 1; request.resolve({ ok: true, json: async () => ({ posts: [] }) }); });
      return request.promise;
    });
    const promise = search.performSearch();
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(4));
    pending.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(8));
    pending.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(9));
    pending.splice(0).forEach((resolve) => resolve());
    await promise;
    expect(peak).toBe(4);
    expect(Object.values(state.currentCursors)).toEqual(Array(9).fill(null));
  });

  it('cancels old requests and starts a replacement search immediately', async () => {
    const oldResponse = deferred();
    const newResponse = deferred();
    globalThis.fetch = vi.fn().mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
    const oldSearch = search.performSearch();
    const oldSignal = globalThis.fetch.mock.calls[0][1].signal;
    elements.terms.value = 'banana';
    const newSearch = search.performSearch();
    await oldSearch;
    expect(oldSignal.aborted).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(state.isLoading).toBe(true);
    expect(elements.searchBtn.disabled).toBe(true);
    oldResponse.resolve({ ok: true, json: async () => ({ cursor: 'stale', posts: [makePost('stale', 99)] }) });
    newResponse.resolve({ ok: true, json: async () => ({ posts: [makePost('banana', 20)] }) });
    await newSearch;
    expect(state.allPosts.map((post) => post.uri)).toEqual([expect.stringContaining('/banana')]);
    expect(state.currentCursors).toEqual({ banana: null });
  });

  it('clearing a search aborts active and queued work without stale errors or cursors', async () => {
    elements.terms.value = 'a,b,c,d,e,f';
    const oldResponse = deferred();
    globalThis.fetch = vi.fn(() => oldResponse.promise);
    const oldSearch = search.performSearch();
    search.clearSearchResults();
    await oldSearch;
    oldResponse.resolve({ ok: false, status: 500, json: async () => ({ error: 'Late failure' }) });
    await Promise.resolve();
    expect(globalThis.fetch).toHaveBeenCalledTimes(4);
    expect(state.currentCursors).toEqual({});
    expect(state.isLoading).toBe(false);
    expect(elements.searchBtn.disabled).toBe(false);
    expect(elements.status.style.display).toBe('none');
  });

  it.each(['success', 'error'])('clearing during pagination ignores a late %s without restoring results or loading state', async (outcome) => {
    globalThis.fetch = makePagedFetch();
    await search.performSearch();
    const response = deferred();
    globalThis.fetch = vi.fn(() => response.promise);
    const loading = search.loadMore();
    const signal = globalThis.fetch.mock.calls[0][1].signal;

    elements.terms.value = '';
    search.debouncedSearch();
    expect(signal.aborted).toBe(true);
    expect(elements.results.textContent).toBe('');
    await loading;
    response.resolve(outcome === 'success'
      ? { ok: true, json: async () => ({ cursor: 'stale', posts: [makePost('stale', 100)] }) }
      : { ok: false, status: 500, json: async () => ({ error: 'Late failure' }) });
    await Promise.resolve();
    expect(state.allPosts).toEqual([]);
    expect(state.currentCursors).toEqual({});
    expect(state.searchTerms).toEqual([]);
    expect(state.searchSince).toBe(null);
    expect(state.isLoading).toBe(false);
    expect(elements.searchBtn.disabled).toBe(false);
    expect(elements.status.style.display).toBe('none');
  });

  it('debouncing cancels an obsolete request before the next search starts', async () => {
    vi.useFakeTimers();
    const oldResponse = deferred();
    globalThis.fetch = vi.fn().mockReturnValueOnce(oldResponse.promise)
      .mockResolvedValue({ ok: true, json: async () => ({ posts: [makePost('replacement', 20)] }) });
    const oldSearch = search.performSearch();
    const oldSignal = globalThis.fetch.mock.calls[0][1].signal;
    elements.terms.value = 'replacement';
    search.debouncedSearch();
    expect(oldSignal.aborted).toBe(true);
    await oldSearch;
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(state.allPosts).toHaveLength(1);
  });

  it('times out an unresponsive page and restores a retryable UI', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(() => new Promise(() => {}));
    const promise = search.performSearch();
    await vi.advanceTimersByTimeAsync(10000);
    await promise;
    expect(state.isLoading).toBe(false);
    expect(state.currentCursors.apple).toBe('');
    expect(elements.status.textContent).toContain('timed out');
    expect(getLoadMoreButton().disabled).toBe(false);
  });

  it.each([
    null,
    {},
    { posts: {} },
    { posts: [], cursor: 42 },
    { posts: [{ uri: 'at://did:plc:test/app.bsky.feed.post/bad' }] },
    { posts: [{ ...makePost('bad', 1), record: { text: {} } }] },
  ])('rejects malformed success data and does not cache it: %j', async (payload) => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => payload })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ posts: [makePost('recovered', 20)] }) });
    await search.performSearch();
    expect(state.allPosts).toEqual([]);
    expect(state.currentCursors.apple).toBe('');
    expect(elements.status.textContent).toContain('invalid search response');
    await search.loadMore();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(state.allPosts).toHaveLength(1);
  });

  it.each(['createdAt', 'reply', 'embed'])('updates an existing card when only %s changes', async (field) => {
    const post = makePost('updated', 20);
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cursor: 'c1', posts: [post] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cursor: 'c2', posts: [post] }) });
    await search.performSearch();
    const previousCard = elements.results.querySelector('.post');
    const updated = { ...post, record: { ...post.record } };
    if (field === 'createdAt') updated.record.createdAt = new Date(Date.now() - 3600000).toISOString();
    if (field === 'reply') updated.record.reply = { parent: { uri: 'at://did:plc:test/app.bsky.feed.post/parent' } };
    if (field === 'embed') updated.embed = { $type: 'app.bsky.embed.images#view', images: [{ thumb: 'https://cdn.bsky.app/image.jpg', alt: 'An image' }] };
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ posts: [updated] }) }));
    await search.loadMore();
    const nextCard = elements.results.querySelector('.post');
    expect(nextCard).not.toBe(previousCard);
    if (field === 'createdAt') expect(nextCard.querySelector('.post-time').textContent).toBe('1h ago');
    if (field === 'reply') {
      const toggle = nextCard.querySelector('.thread-link');
      expect(toggle.textContent).toBe('View Thread');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.getAttribute('aria-controls')).toMatch(/^thread-context-/);
    }
    if (field === 'embed') expect(nextCard.querySelector('.image-placeholder')).toBeTruthy();
  });
});
