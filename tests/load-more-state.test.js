import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDocument, deferred } from './helpers/dom.mjs';
import { SEARCH_REQUEST_TIMEOUT_MS } from '../src/constants.mjs';

let testDocument;
let elements;

function makePost(id, likeCount) {
  const now = new Date().toISOString();
  return {
    uri: `at://did:plc:test/app.bsky.feed.post/${id}`,
    author: { did: 'did:plc:test', handle: 'alice.bsky.social', displayName: 'Alice' },
    record: { text: `post ${id} about apple`, createdAt: now },
    indexedAt: now,
    likeCount,
    repostCount: 0,
    replyCount: 0,
  };
}

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

    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.textContent).toBe('Loading…');

    pending.resolve({
      ok: true,
      json: async () => ({ cursor: 'cursor-3', posts: [makePost('p3a', 5)] }),
    });
    await loadMorePromise;

    expect(state.currentCursors.apple).toBe('cursor-3');
    expect(button.style.display).toBe('');
    expect(button.getAttribute('aria-disabled')).toBe(null);
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

  it('renders a proxy response that needs more than the old ten-second browser deadline', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(() => new Promise((resolve) => {
      setTimeout(() => resolve(Response.json({ posts: [makePost('slow', 20)] })), 12000);
    }));
    const pending = search.performSearch();
    await vi.advanceTimersByTimeAsync(10000);
    expect(state.isLoading).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(state.allPosts.map((post) => post.uri)).toEqual([makePost('slow', 20).uri]);
    expect(elements.status.style.display).toBe('none');
    expect(state.isLoading).toBe(false);
  });

  it('times out an unresponsive page and restores a retryable UI', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(() => new Promise(() => {}));
    const promise = search.performSearch();
    await vi.advanceTimersByTimeAsync(SEARCH_REQUEST_TIMEOUT_MS);
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
    const updated = { ...post, record: { ...post.record } };
    if (field === 'createdAt') updated.record.createdAt = new Date(Date.now() - 3600000).toISOString();
    if (field === 'reply') updated.record.reply = { parent: { uri: 'at://did:plc:test/app.bsky.feed.post/parent' } };
    if (field === 'embed') updated.embed = { $type: 'app.bsky.embed.images#view', images: [{ thumb: 'https://cdn.bsky.app/image.jpg', alt: 'An image' }] };
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ posts: [updated] }) }));
    await search.loadMore();
    const nextCard = elements.results.querySelector('.post');
    if (field === 'createdAt') expect(nextCard.querySelector('.post-time').textContent).toBe('1h ago');
    if (field === 'reply') {
      const toggle = nextCard.querySelector('.thread-link');
      expect(toggle.textContent).toBe('View Thread');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.getAttribute('aria-controls')).toMatch(/^thread-context-/);
    }
    if (field === 'embed') expect(nextCard.querySelector('.image-placeholder')).toBeTruthy();
  });

  it.each([
    [
      'a gallery',
      { $type: 'app.bsky.embed.gallery#view', items: [{ thumbnail: 'https://cdn.bsky.app/one.jpg', alt: 'One' }, { thumbnail: 'https://cdn.bsky.app/two.jpg', alt: 'Two' }] },
      'Show 2 images',
      ['https://cdn.bsky.app/one.jpg', 'https://cdn.bsky.app/two.jpg'],
    ],
    [
      'a video',
      { $type: 'app.bsky.embed.video#view', thumbnail: 'https://video.bsky.app/thumbnail.jpg', alt: 'Clip' },
      'Show video preview',
      ['https://video.bsky.app/thumbnail.jpg'],
    ],
    [
      'a quote post with images',
      { $type: 'app.bsky.embed.recordWithMedia#view', record: {}, media: { $type: 'app.bsky.embed.images#view', images: [{ thumb: 'https://cdn.bsky.app/quoted.jpg', alt: 'Quoted' }] } },
      'Show 1 image',
      ['https://cdn.bsky.app/quoted.jpg'],
    ],
  ])('reveals the previews of %s on request', async (_kind, embed, buttonText, sources) => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ posts: [{ ...makePost('media', 20), embed }] }) }));
    await search.performSearch();
    const card = elements.results.querySelector('.post');
    const button = card.querySelector('.image-toggle');
    expect(button.textContent).toBe(buttonText);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(card.querySelector('.post-images')).toBe(null);

    button.listeners.get('click')();
    const images = card.querySelector('.post-images');
    expect(card.querySelector('.image-toggle')).toBe(button);
    expect(button.textContent).toBe(buttonText.replace('Show', 'Hide'));
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(images.id);
    expect(card.querySelectorAll('.post-image').map((image) => image.src)).toEqual(sources);

    button.listeners.get('click')();
    expect(button.textContent).toBe(buttonText);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(images.style.display).toBe('none');
  });

  it('keeps an open thread, shown images and focus when a card is updated', async () => {
    const post = {
      ...makePost('kept', 20),
      record: { ...makePost('kept', 20).record, reply: { parent: { uri: 'at://did:plc:test/app.bsky.feed.post/parent' } } },
      embed: { $type: 'app.bsky.embed.images#view', images: [{ thumb: 'https://cdn.bsky.app/kept.jpg', alt: 'Kept' }] },
    };
    let searches = 0;
    let page = () => ({ cursor: `c${searches}`, posts: [post] });
    globalThis.fetch = vi.fn(async (url) => {
      const isThread = String(url).includes('getPostThread');
      if (!isThread) searches += 1;
      const body = isThread ? { thread: { parent: { post: makePost('parent', 5) } } } : page();
      return { ok: true, json: async () => body };
    });
    await search.performSearch();
    const card = elements.results.querySelector('.post');
    card.querySelector('.image-toggle').listeners.get('click')();
    await card.querySelector('button.thread-link').listeners.get('click')();
    expect(card.querySelector('.thread-context')).not.toBe(null);
    card.querySelectorAll('a.thread-link')[0].focus();

    page = () => ({ posts: [{ ...post, likeCount: 30 }] });
    await search.loadMore();
    const updated = elements.results.querySelector('.post');
    expect(updated).not.toBe(card);
    expect(updated.querySelector('.stat.likes').textContent).toBe('♥ 30');
    const context = updated.querySelector('.thread-context');
    const threadButton = updated.querySelector('button.thread-link');
    expect(context.textContent).toContain('post parent about apple');
    expect(threadButton.textContent).toBe('Hide Thread');
    expect(threadButton.getAttribute('aria-expanded')).toBe('true');
    expect(threadButton.getAttribute('aria-controls')).toBe(context.id);
    expect(updated.querySelector('.image-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(updated.querySelectorAll('.post-image').map((image) => image.src)).toEqual(['https://cdn.bsky.app/kept.jpg']);
    expect(testDocument.activeElement).toBe(updated.querySelectorAll('a.thread-link')[0]);

    await threadButton.listeners.get('click')();
    expect(updated.querySelector('.thread-context')).toBe(null);
    expect(threadButton.textContent).toBe('View Thread');
  });

  it('moves focus to the last result when Load More runs out while focused', async () => {
    globalThis.fetch = makePagedFetch();
    await search.performSearch();
    getLoadMoreButton().focus();
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ posts: [makePost('last', 5)] }) }));
    await search.loadMore();
    const cards = elements.results.querySelectorAll('.post');
    expect(getLoadMoreButton().style.display).toBe('none');
    expect(testDocument.activeElement).toBe(cards.at(-1));
    expect(cards.at(-1).tabIndex).toBe(-1);
  });

  it('moves focus to the empty-results message when Load More runs out with nothing to show', async () => {
    globalThis.fetch = makePagedFetch();
    elements.minLikes.value = '60';
    await search.performSearch();
    expect(elements.results.querySelectorAll('.post')).toHaveLength(0);
    getLoadMoreButton().focus();
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ posts: [makePost('last', 5)] }) }));
    await search.loadMore();
    const empty = elements.results.querySelector('.no-results');
    expect(getLoadMoreButton().style.display).toBe('none');
    expect(empty.style.display).toBe('block');
    expect(testDocument.activeElement).toBe(empty);
  });

  it('moves focus to the first newly shown result when the last Show more is used', async () => {
    const posts = Array.from({ length: 250 }, (_, index) => makePost(`many${index}`, 300 - index));
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ posts }) }));
    await search.performSearch();
    const showMore = elements.results.querySelectorAll('button.load-more')[0];
    expect(showMore.textContent).toBe('Show 50 more loaded results');
    showMore.focus();
    showMore.listeners.get('click')();
    const cards = elements.results.querySelectorAll('.post');
    expect(cards).toHaveLength(250);
    expect(showMore.style.display).toBe('none');
    expect(testDocument.activeElement).toBe(cards[200]);
  });

  it.each([
    ['a video without a thumbnail', { $type: 'app.bsky.embed.video#view', playlist: 'https://video.bsky.app/playlist.m3u8' }],
    ['a quote post with a link card', { $type: 'app.bsky.embed.recordWithMedia#view', record: {}, media: { $type: 'app.bsky.embed.external#view', external: { thumb: 'https://cdn.bsky.app/link.jpg' } } }],
  ])('shows no preview button for %s', async (_kind, embed) => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ posts: [{ ...makePost('media', 20), embed }] }) }));
    await search.performSearch();
    expect(elements.results.querySelector('.post')).not.toBe(null);
    expect(elements.results.querySelector('.image-placeholder')).toBe(null);
  });

  it('shows pronouns, badges and the save count on a search result, dropping LIVE at expiry', async () => {
    vi.useFakeTimers();
    const post = {
      ...makePost('badged', 20),
      bookmarkCount: 4,
      author: {
        did: 'did:plc:test',
        handle: 'alice.bsky.social',
        pronouns: 'she/her',
        verification: { verifiedStatus: 'none', trustedVerifierStatus: 'valid' },
        status: { status: 'app.bsky.actor.status#live', expiresAt: new Date(Date.now() + 3600000).toISOString() },
      },
    };
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ posts: [post] }) }));
    await search.performSearch();
    const card = elements.results.querySelector('.post');
    const authorDetails = () => card.querySelector('.author-info').children.map((node) => node.textContent).slice(2);
    expect(authorDetails()).toEqual(['she/her', 'Verifier', 'LIVE']);
    expect(card.querySelector('.post-stats').children.at(-1).getAttribute('aria-label')).toBe('4 saves');
    vi.advanceTimersByTime(3600000);
    expect(authorDetails()).toEqual(['she/her', 'Verifier']);
  });

  it('links an author with an unverified handle by DID', async () => {
    const post = { ...makePost('unverified', 20), author: { did: 'did:plc:test', handle: 'handle.invalid' } };
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ posts: [post] }) }));
    await search.performSearch();
    const card = elements.results.querySelector('.post');
    expect(card.querySelector('.display-name').href).toBe('https://bsky.app/profile/did:plc:test');
    expect(card.querySelector('a.thread-link').href).toBe('https://bsky.app/profile/did:plc:test/post/unverified');
  });
});
