import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDocument, deferred } from './helpers/dom.mjs';

const postUrl = 'https://bsky.app/profile/did:plc:test/post/original';
let elements;
let search;
let state;

function makePost(id = 'result') {
  return {
    uri: `at://did:plc:test/app.bsky.feed.post/${id}`,
    author: { did: 'did:plc:test', handle: 'alice.bsky.social' },
    record: { text: 'An apple pie post', createdAt: new Date().toISOString() },
    likeCount: 50,
  };
}

function dispatch(id, event, details = {}) {
  return elements[id].listeners.get(event)({ target: elements[id], ...details });
}

async function bootApp(query = '') {
  window.location.search = query;
  await import('../src/app.mjs');
  await vi.advanceTimersByTimeAsync(0);
}

function searchRequests() {
  return fetch.mock.calls.map(([url]) => new URL(url, window.location))
    .filter((url) => url.pathname === '/api/search').map((url) => url.searchParams);
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
  const testDOM = createTestDocument([
    'terms', 'minLikes', 'timeFilter', 'sortSelect', 'searchBtn', 'status', 'results',
    'themeSelect', 'expandTermsToggle', 'expandSummary', 'topicFilterToggle', 'quoteForm', 'postUrl',
    'quoteSearchBtn', 'quoteStatus', 'quoteTabs', 'quoteOriginal', 'quoteCount',
    'quoteResults', 'quoteLoadMore',
  ]);
  elements = testDOM.elements;
  elements.minLikes.value = '0';
  elements.timeFilter.value = '24';
  elements.sortSelect.value = 'top';
  elements.expandTermsToggle.checked = false;
  elements.topicFilterToggle.checked = false;
  for (const sort of ['likes', 'recent', 'oldest', 'bookmarks']) {
    const tab = testDOM.document.createElement('button');
    tab.className = 'quote-tab';
    tab.dataset.sort = sort;
    elements.quoteTabs.appendChild(tab);
  }
  const location = new URL('https://example.test/');
  vi.stubGlobal('document', testDOM.document);
  vi.stubGlobal('window', {
    location,
    history: { replaceState: (_state, _title, url) => { location.href = new URL(url, location).href; } },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
  vi.stubGlobal('requestAnimationFrame', (callback) => setTimeout(callback, 0));
  vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ posts: [makePost()] })));
  search = await import('../src/search.mjs');
  ({ state } = await import('../src/state.mjs'));
});

afterEach(() => {
  search.clearSearchResults();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('app search controls', () => {
  it('debounces typing and clears loaded results and pending input immediately', async () => {
    await bootApp();
    elements.terms.value = 'apple';
    dispatch('terms', 'input');
    expect(elements.expandSummary.textContent).toContain('apple');
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(elements.results.querySelectorAll('.post')).toHaveLength(1);
    expect(state.searchSince).not.toBe(null);

    elements.terms.value = 'banana';
    dispatch('terms', 'input');
    elements.terms.value = '';
    dispatch('terms', 'input');
    expect(elements.results.textContent).toBe('');
    expect(state.searchTerms).toEqual([]);
    expect(state.searchSince).toBe(null);
    expect(elements.status.style.display).toBe('none');
    await vi.advanceTimersByTimeAsync(300);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['searchBtn', 'terms', 'minLikes'])('%s submits immediately and cancels the pending debounce', async (id) => {
    await bootApp();
    elements.terms.value = 'apple';
    dispatch('terms', 'input');
    await dispatch(id, id === 'searchBtn' ? 'click' : 'keypress', { key: 'Enter' });
    await vi.advanceTimersByTimeAsync(0);
    expect(elements.results.querySelectorAll('.post')).toHaveLength(1);
    const card = elements.results.querySelector('.post');
    expect(state.searchDebounceTimer).toBe(null);
    await vi.advanceTimersByTimeAsync(300);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(elements.results.querySelector('.post')).toBe(card);
  });

  it.each(['timeFilter', 'expandTermsToggle'])('%s starts the pending search with the new filter and stays idle without terms', async (id) => {
    await bootApp();
    dispatch(id, 'change');
    expect(fetch).not.toHaveBeenCalled();
    expect(elements.status.textContent).toBe('');

    elements.terms.value = 'apple pie';
    dispatch('terms', 'input');
    if (id === 'timeFilter') elements.timeFilter.value = '6';
    else elements.expandTermsToggle.checked = true;
    dispatch(id, 'change');
    await vi.advanceTimersByTimeAsync(0);
    expect(state.searchDebounceTimer).toBe(null);
    expect(state.timeFilterHours).toBe(id === 'timeFilter' ? 6 : 24);
    expect(state.searchTerms).toEqual(id === 'timeFilter' ? ['apple pie'] : ['apple pie', 'apple', 'pie']);
    const count = searchRequests().length;
    expect(count).toBe(state.searchTerms.length);
    const card = elements.results.querySelector('.post');
    await vi.advanceTimersByTimeAsync(300);
    expect(searchRequests()).toHaveLength(count);
    expect(elements.results.querySelector('.post')).toBe(card);
  });

  it('filters every loaded page locally and preserves pagination after the cache expires', async () => {
    fetch.mockImplementation(async (url) => {
      const cursor = new URL(url, window.location).searchParams.get('cursor');
      const page = cursor ? Number(cursor) + 1 : 1;
      return Response.json({ posts: [makePost(page)], cursor: String(page) });
    });
    await bootApp('?terms=apple');
    await search.loadMore();
    const loadedUris = state.allPosts.map((post) => post.uri);
    expect(loadedUris).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(31000);

    for (const [threshold, count] of [['1', 3], ['60', 0], ['0', 3]]) {
      elements.minLikes.value = threshold;
      dispatch('minLikes', 'input');
      expect(elements.results.querySelectorAll('.post')).toHaveLength(count);
      expect(state.currentCursors.apple).toBe('3');
      expect(window.location.searchParams.get('minLikes')).toBe(threshold);
      await vi.advanceTimersByTimeAsync(300);
      await dispatch('minLikes', 'keypress', { key: 'Enter' });
      expect(fetch).toHaveBeenCalledTimes(3);
    }
    expect(state.allPosts.map((post) => post.uri)).toEqual(loadedUris);
    await search.loadMore();
    expect(searchRequests().at(-1).get('cursor')).toBe('3');
    expect(state.allPosts).toHaveLength(4);
  });

  it('applies minimum likes to an in-flight page without cancelling it', async () => {
    fetch.mockImplementation(async (url) => Response.json({
      posts: [makePost()],
      cursor: new URL(url, window.location).searchParams.has('cursor') ? 'c2' : 'c1',
    }));
    await bootApp('?terms=apple');
    const pending = deferred();
    fetch.mockReturnValueOnce(pending.promise);
    const loading = search.loadMore();
    const signal = fetch.mock.calls.at(-1)[1].signal;
    elements.minLikes.value = '60';
    dispatch('minLikes', 'input');
    expect(signal.aborted).toBe(false);
    expect(state.isLoading).toBe(true);
    expect(elements.results.querySelectorAll('.post')).toHaveLength(0);

    pending.resolve(Response.json({ posts: [{ ...makePost('new'), likeCount: 100 }] }));
    await loading;
    expect(state.allPosts.map((post) => post.uri)).toEqual([makePost('new').uri]);
    expect(state.isLoading).toBe(false);
    expect(state.currentCursors.apple).toBeNull();
  });

  it('keeps a pending term search scheduled when minimum likes changes', async () => {
    await bootApp();
    elements.terms.value = 'apple';
    dispatch('terms', 'input');
    await vi.advanceTimersByTimeAsync(200);
    elements.minLikes.value = '60';
    dispatch('minLikes', 'input');
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.minLikes).toBe(60);
    expect(state.allPosts).toEqual([]);
    expect(state.searchDebounceTimer).toBeNull();
  });

  it('starts a fresh cursor stream when sort changes and restores the top results when changed back', async () => {
    let page = 0;
    fetch.mockImplementation(async () => Response.json({ posts: [makePost(++page)], cursor: `cursor-${page}` }));
    await bootApp('?terms=apple');
    elements.sortSelect.value = 'latest';
    dispatch('sortSelect', 'change');
    await vi.advanceTimersByTimeAsync(0);
    await search.loadMore();
    const requests = searchRequests();
    expect(requests.map((params) => params.get('sort'))).toEqual(['top', 'top', 'latest', 'latest', 'latest']);
    expect(requests[2].has('cursor')).toBe(false);
    expect(requests[4].get('cursor')).toBe('cursor-4');
    expect(state.allPosts).toHaveLength(3);
    expect(window.location.searchParams.get('searchSort')).toBe('latest');

    elements.sortSelect.value = 'top';
    dispatch('sortSelect', 'change');
    await vi.advanceTimersByTimeAsync(0);
    expect(state.searchSort).toBe('top');
    expect(state.currentCursors.apple).toBe('cursor-2');
    expect(state.allPosts.map((post) => post.uri)).toEqual([1, 2].map((id) => makePost(id).uri));
    expect(window.location.searchParams.has('searchSort')).toBe(false);
  });

  it('ranks by saves locally while requesting the top results', async () => {
    fetch.mockImplementation(async () => Response.json({ posts: [
      { ...makePost('liked'), bookmarkCount: 1 },
      { ...makePost('saved'), likeCount: 10, bookmarkCount: 9 },
    ] }));
    await bootApp('?terms=apple&searchSort=bookmarks');
    expect(elements.sortSelect.value).toBe('bookmarks');
    expect(state.searchSort).toBe('bookmarks');
    expect(searchRequests().map((params) => params.get('sort'))).toEqual(['top']);
    expect(state.allPosts.map((post) => post.uri)).toEqual([makePost('saved').uri, makePost('liked').uri]);
    expect(elements.results.querySelector('.results-header').textContent).toContain('Sorted by saves (high to low)');
  });

  it('re-ranks cached top results when the sort changes to saves', async () => {
    fetch.mockImplementation(async () => Response.json({ posts: [
      { ...makePost('liked'), bookmarkCount: 1 },
      { ...makePost('saved'), likeCount: 10, bookmarkCount: 9 },
    ] }));
    await bootApp('?terms=apple');
    expect(state.allPosts.map((post) => post.uri)).toEqual([makePost('liked').uri, makePost('saved').uri]);
    elements.sortSelect.value = 'bookmarks';
    dispatch('sortSelect', 'change');
    await vi.advanceTimersByTimeAsync(0);
    expect(searchRequests().map((params) => params.get('sort'))).toEqual(['top']);
    expect(state.allPosts.map((post) => post.uri)).toEqual([makePost('saved').uri, makePost('liked').uri]);
    expect(window.location.searchParams.get('searchSort')).toBe('bookmarks');
  });
});

describe('app URL initialization', () => {
  it('restores search filters and independent quote sort before fetching and rendering both searches', async () => {
    await bootApp(`?terms=apple%20pie&minLikes=25&time=6&expand=1&searchSort=latest&post=${encodeURIComponent(postUrl)}&quoteSort=recent`);
    expect(elements.terms.value).toBe('apple pie');
    expect(elements.minLikes.value).toBe('25');
    expect(elements.timeFilter.value).toBe('6');
    expect(elements.expandTermsToggle.checked).toBe(true);
    expect(state.minLikes).toBe(25);
    expect(state.timeFilterHours).toBe(6);
    expect(searchRequests().map((params) => [params.get('term'), params.get('sort')]))
      .toEqual(['apple pie', 'apple', 'pie'].map((term) => [term, 'latest']));
    expect(elements.results.querySelectorAll('.post')).toHaveLength(1);
    expect(state.quoteSort).toBe('recent');
    expect(state.activeQuoteUri).toBe('at://did:plc:test/app.bsky.feed.post/original');
    expect(elements.quoteOriginal.querySelector('.quote-original')).toBeTruthy();
    expect(elements.quoteTabs.querySelector('.active').dataset.sort).toBe('recent');
    expect(window.location.searchParams.get('searchSort')).toBe('latest');
    expect(window.location.searchParams.get('quoteSort')).toBe('recent');
  });

  it.each([['latest', 'searchSort'], ['bookmarks', 'searchSort'], ['recent', 'quoteSort']])('migrates legacy sort=%s links without losing the post', async (sort, key) => {
    await bootApp(`?post=${encodeURIComponent(postUrl)}&sort=${sort}`);
    expect(window.location.searchParams.get(key)).toBe(sort);
    expect(window.location.searchParams.has('sort')).toBe(false);
    expect(window.location.searchParams.get('quoteSort')).toBe(key === 'quoteSort' ? sort : null);
    expect(window.location.searchParams.get('post')).toBe(postUrl);
    expect(state.searchSort).toBe(key === 'searchSort' ? sort : 'top');
    expect(state.quoteSort).toBe(key === 'quoteSort' ? sort : 'likes');
    expect(elements.quoteOriginal.querySelector('.quote-original')).toBeTruthy();
  });
});

describe('topic filter control', () => {
  // The classifier calls every post off-topic, which makes its effect visible.
  function classifyEverythingOffTopic() {
    fetch.mockImplementation(async (url, options) => {
      if (!String(url).startsWith('/api/classify')) return Response.json({ posts: [makePost()] });
      const { items } = JSON.parse(options.body);
      return Response.json({ results: items.map((item) => ({ id: item.id, scores: item.keywords.map(() => 0.03) })) });
    });
  }

  it('starts from the URL and filters the first search', async () => {
    classifyEverythingOffTopic();
    await bootApp('?terms=apple&minLikes=0&topic=1');
    expect(elements.topicFilterToggle.checked).toBe(true);
    expect(state.hideOffTopic).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(elements.results.querySelectorAll('.post')).toHaveLength(0);
    expect(elements.results.querySelector('.topic-summary').textContent).toContain('1 off-topic post hidden.');
    expect(window.location.search).toContain('topic=1');
  });

  it('stays off by default and applies the checkbox without another search', async () => {
    classifyEverythingOffTopic();
    await bootApp('?terms=apple&minLikes=0');
    expect(state.hideOffTopic).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(elements.results.querySelectorAll('.post')).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);

    elements.topicFilterToggle.checked = true;
    dispatch('topicFilterToggle', 'change');
    await vi.advanceTimersByTimeAsync(300);
    expect(elements.results.querySelectorAll('.post')).toHaveLength(0);
    expect(searchRequests()).toHaveLength(1);
    expect(window.location.search).toContain('topic=1');

    elements.topicFilterToggle.checked = false;
    dispatch('topicFilterToggle', 'change');
    expect(elements.results.querySelectorAll('.post')).toHaveLength(1);
    expect(window.location.search).not.toContain('topic=');
  });
});
