import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDocument } from './helpers/dom.mjs';

const postUrl = 'https://bsky.app/profile/did:plc:test/post/original';
let elements;
let search;
let state;

function makePost(id = 'result') {
  return {
    uri: `at://did:plc:test/app.bsky.feed.post/${id}`,
    author: { handle: 'alice.bsky.social' },
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
    'themeSelect', 'expandTermsToggle', 'expandSummary', 'quoteForm', 'postUrl',
    'quoteSearchBtn', 'quoteStatus', 'quoteTabs', 'quoteOriginal', 'quoteCount',
    'quoteResults', 'quoteLoadMore',
  ]);
  elements = testDOM.elements;
  elements.minLikes.value = '0';
  elements.timeFilter.value = '24';
  elements.sortSelect.value = 'top';
  elements.expandTermsToggle.checked = false;
  for (const sort of ['likes', 'recent', 'oldest']) {
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

  it.each([['latest', 'searchSort'], ['recent', 'quoteSort']])('migrates legacy sort=%s links without losing the post', async (sort, key) => {
    await bootApp(`?post=${encodeURIComponent(postUrl)}&sort=${sort}`);
    expect(window.location.searchParams.get(key)).toBe(sort);
    expect(window.location.searchParams.has('sort')).toBe(false);
    expect(window.location.searchParams.get('post')).toBe(postUrl);
    expect(state.searchSort).toBe(key === 'searchSort' ? 'latest' : 'top');
    expect(state.quoteSort).toBe(key === 'quoteSort' ? 'recent' : 'likes');
    expect(elements.quoteOriginal.querySelector('.quote-original')).toBeTruthy();
  });
});
