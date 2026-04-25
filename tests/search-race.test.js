import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const classList = {
    add: vi.fn(),
    remove: vi.fn(),
  };
  const createElement = () => ({
    addEventListener: vi.fn(),
    appendChild: vi.fn(),
    classList,
    remove: vi.fn(),
    setAttribute: vi.fn(),
    style: {},
    textContent: '',
  });

  const dom = {
    autoRefreshToggle: { checked: false },
    expandSummary: createElement(),
    expandTermsToggle: { checked: false },
    minLikesInput: { value: '0' },
    newPostsDiv: createElement(),
    refreshIntervalSelect: { value: '5' },
    refreshLastDiv: createElement(),
    refreshNextDiv: createElement(),
    refreshStateDiv: createElement(),
    resultsDiv: createElement(),
    searchBtn: { disabled: false },
    sortSelect: { value: 'top' },
    statusDiv: createElement(),
    termsInput: { value: '' },
    timeFilterSelect: { value: '24' },
  };

  return { createElement, dom };
});

vi.mock('../src/dom.mjs', () => mocks.dom);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

describe('search result race guards', () => {
  let originalDocument;
  let originalFetch;
  let search;
  let state;

  beforeEach(async () => {
    vi.resetModules();
    originalDocument = globalThis.document;
    originalFetch = globalThis.fetch;
    globalThis.document = {
      createElement: vi.fn(mocks.createElement),
      getElementById: vi.fn(() => null),
    };
    globalThis.window = {
      history: { replaceState: vi.fn() },
      location: { pathname: '/', search: '' },
    };
    search = await import('../src/search.mjs');
    ({ state } = await import('../src/state.mjs'));
    state.allPosts = [];
    state.currentCursors = {};
    state.rawSearchTerms = [];
    state.searchTerms = [];
    state.searchGeneration = 0;
    state.isLoading = false;
    state.pendingPosts = [];
    state.newPostUris = new Set();
  });

  afterEach(() => {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    delete globalThis.window;
    vi.restoreAllMocks();
  });

  it('does not restore stale posts when input is cleared during pagination', async () => {
    const response = deferred();
    globalThis.fetch = vi.fn(() => response.promise);
    state.allPosts = [{ uri: 'at://old', likeCount: 1, indexedAt: '2026-04-25T00:00:00.000Z' }];
    state.currentCursors = { apple: 'cursor-1' };
    state.rawSearchTerms = ['apple'];
    state.searchTerms = ['apple'];
    state.searchGeneration = 7;
    mocks.dom.termsInput.value = '';

    const loadMorePromise = search.loadMore();
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));

    search.clearSearchResults();
    response.resolve({
      ok: true,
      json: async () => ({
        cursor: 'cursor-2',
        posts: [{ uri: 'at://stale', likeCount: 100, indexedAt: '2026-04-25T01:00:00.000Z' }],
      }),
    });
    await loadMorePromise;

    expect(state.allPosts).toEqual([]);
    expect(state.currentCursors).toEqual({});
    expect(state.searchTerms).toEqual([]);
  });
});
