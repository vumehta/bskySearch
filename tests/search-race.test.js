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
    state.autoRefreshEnabled = false;
    state.refreshTimerId = null;
    state.refreshCountdownId = null;
    state.nextRefreshAt = null;
    state.pendingPosts = [];
    state.newPostUris = new Set();
    state.clearHighlightsTimeout = null;
    mocks.dom.autoRefreshToggle.checked = false;
  });

  afterEach(() => {
    if (state?.refreshTimerId) clearTimeout(state.refreshTimerId);
    if (state?.refreshCountdownId) clearInterval(state.refreshCountdownId);
    if (state?.clearHighlightsTimeout) clearTimeout(state.clearHighlightsTimeout);
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

  it('turns off auto-refresh immediately when clearing search results', () => {
    state.autoRefreshEnabled = true;
    state.nextRefreshAt = Date.now() + 300000;
    state.refreshTimerId = setTimeout(() => {}, 300000);
    state.refreshCountdownId = setInterval(() => {}, 1000);
    mocks.dom.autoRefreshToggle.checked = true;

    search.clearSearchResults();

    expect(state.autoRefreshEnabled).toBe(false);
    expect(mocks.dom.autoRefreshToggle.checked).toBe(false);
    expect(state.nextRefreshAt).toBe(null);
    expect(state.refreshTimerId).toBe(null);
    expect(state.refreshCountdownId).toBe(null);
    expect(mocks.dom.refreshStateDiv.textContent).toBe('Auto-refresh off');
    expect(mocks.dom.refreshNextDiv.textContent).toBe('');
  });

  it('cancels pending highlight clear timers when clearing search results', () => {
    state.newPostUris = new Set(['at://highlighted']);
    state.clearHighlightsTimeout = setTimeout(() => {}, 8000);

    search.clearSearchResults();

    expect(state.newPostUris.size).toBe(0);
    expect(state.clearHighlightsTimeout).toBe(null);
  });
});
