import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A tiny DOM stand-in: enough tree behaviour for renderResults() to run in node.
const mocks = vi.hoisted(() => {
  class FakeNode {
    constructor(tagName = '') {
      this.tagName = tagName;
      this.children = [];
      this.parentNode = null;
      this.style = {};
      this.dataset = {};
      this.className = '';
      this.disabled = false;
      this.listeners = new Map();
      this.classList = { add: () => {}, remove: () => {} };
      this._textContent = '';
    }

    get textContent() {
      return this._textContent;
    }

    set textContent(value) {
      this._textContent = value;
      if (value === '') {
        this.children.forEach((child) => {
          child.parentNode = null;
        });
        this.children = [];
      }
    }

    get lastElementChild() {
      return this.children[this.children.length - 1] || null;
    }

    addEventListener(name, handler) {
      this.listeners.set(name, handler);
    }

    setAttribute() {}

    appendChild(child) {
      return this.insertBefore(child, null);
    }

    insertBefore(child, reference) {
      if (child.parentNode) {
        child.parentNode.removeChild(child);
      }
      const index = reference ? this.children.indexOf(reference) : -1;
      if (index === -1) {
        this.children.push(child);
      } else {
        this.children.splice(index, 0, child);
      }
      child.parentNode = this;
      return child;
    }

    replaceChild(next, previous) {
      const index = this.children.indexOf(previous);
      if (index === -1) throw new Error('replaceChild: node not found');
      if (next.parentNode) {
        next.parentNode.removeChild(next);
      }
      this.children[index] = next;
      next.parentNode = this;
      previous.parentNode = null;
      return previous;
    }

    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index !== -1) {
        this.children.splice(index, 1);
        child.parentNode = null;
      }
      return child;
    }

    remove() {
      if (this.parentNode) {
        this.parentNode.removeChild(this);
      }
    }
  }

  const createElement = (tagName) => new FakeNode(tagName);

  // Only attached nodes are findable, like a real document.
  const findById = (node, id) => {
    if (node.id === id) return node;
    for (const child of node.children) {
      const match = findById(child, id);
      if (match) return match;
    }
    return null;
  };

  const roots = [];
  const document = {
    createElement,
    createDocumentFragment: () => new FakeNode('#fragment'),
    createTextNode: (text) => {
      const node = new FakeNode('#text');
      node.textContent = String(text);
      return node;
    },
    getElementById: (id) => {
      for (const root of roots) {
        const match = findById(root, id);
        if (match) return match;
      }
      return null;
    },
  };

  const dom = {
    autoRefreshToggle: { checked: false },
    expandSummary: createElement('span'),
    expandTermsToggle: { checked: false },
    minLikesInput: { value: '0' },
    newPostsDiv: createElement('div'),
    refreshIntervalSelect: { value: '5' },
    refreshLastDiv: createElement('div'),
    refreshNextDiv: createElement('div'),
    refreshStateDiv: createElement('div'),
    resultsDiv: createElement('div'),
    searchBtn: { disabled: false },
    sortSelect: { value: 'top' },
    statusDiv: createElement('div'),
    termsInput: { value: '' },
    timeFilterSelect: { value: '24' },
  };
  roots.push(dom.resultsDiv, dom.newPostsDiv, dom.statusDiv);

  return { document, dom };
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
  return mocks.document.getElementById('loadMoreBtn');
}

function getRequestedSinceValues(fetchMock) {
  return fetchMock.mock.calls.map(([url]) => new URL(url, 'https://example.test').searchParams.get('since'));
}

describe('load more button state', () => {
  let originalDocument;
  let originalFetch;
  let originalRaf;
  let originalCancelRaf;
  let search;
  let state;

  beforeEach(async () => {
    vi.resetModules();
    originalDocument = globalThis.document;
    originalFetch = globalThis.fetch;
    originalRaf = globalThis.requestAnimationFrame;
    originalCancelRaf = globalThis.cancelAnimationFrame;
    globalThis.document = mocks.document;
    globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    globalThis.window = {
      history: { replaceState: vi.fn() },
      location: { pathname: '/', search: '' },
    };
    search = await import('../src/search.mjs');
    ({ state } = await import('../src/state.mjs'));
    const { searchCache } = await import('../src/state.mjs');
    searchCache.clear();
    state.allPosts = [];
    state.currentCursors = {};
    state.rawSearchTerms = [];
    state.searchTerms = [];
    state.searchGeneration = 0;
    state.isLoading = false;
    state.pendingSearch = false;
    state.autoRefreshEnabled = false;
    state.pendingPosts = [];
    state.newPostUris = new Set();
    mocks.dom.termsInput.value = 'apple';
    mocks.dom.minLikesInput.value = '0';
  });

  afterEach(() => {
    if (state?.refreshTimerId) clearTimeout(state.refreshTimerId);
    if (state?.refreshCountdownId) clearInterval(state.refreshCountdownId);
    if (state?.clearHighlightsTimeout) clearTimeout(state.clearHighlightsTimeout);
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCancelRaf;
    delete globalThis.window;
    vi.restoreAllMocks();
  });

  it('leaves the button clickable after a search that has more pages', async () => {
    globalThis.fetch = makePagedFetch();

    await search.performSearch();

    expect(state.isLoading).toBe(false);
    expect(state.currentCursors.apple).toBe('cursor-2');
    const button = getLoadMoreButton();
    expect(button).toBeTruthy();
    expect(button.style.display).toBe('');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Load More Results');
  });

  it('shows a loading state while more results are in flight, then recovers', async () => {
    globalThis.fetch = makePagedFetch();
    await search.performSearch();

    const pending = deferred();
    globalThis.fetch = vi.fn(() => pending.promise);
    const loadMorePromise = search.loadMore();
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));

    const button = getLoadMoreButton();
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
  });

  it('hides the button once the last page has been loaded', async () => {
    globalThis.fetch = makePagedFetch();
    await search.performSearch();

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ posts: [makePost('last', 5)] }),
    }));
    await search.loadMore();

    expect(state.currentCursors.apple).toBe(null);
    const button = getLoadMoreButton();
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

  it('drops the since window when results are cleared', async () => {
    globalThis.fetch = makePagedFetch();
    await search.performSearch();
    expect(state.searchSince).not.toBe(null);

    search.clearSearchResults();
    expect(state.searchSince).toBe(null);
  });

  it('re-enables the button when loading more fails', async () => {
    globalThis.fetch = makePagedFetch();
    await search.performSearch();

    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await search.loadMore();

    const button = getLoadMoreButton();
    expect(state.isLoading).toBe(false);
    expect(button.style.display).toBe('');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Load More Results');
  });
});
