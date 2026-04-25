import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const createControl = (initial = {}) => {
    const listeners = new Map();
    return {
      value: initial.value ?? '',
      checked: initial.checked ?? false,
      addEventListener: vi.fn((eventName, handler) => {
        listeners.set(eventName, handler);
      }),
      dispatch(eventName, event = {}) {
        const handler = listeners.get(eventName);
        if (handler) {
          handler({ target: this, ...event });
        }
      },
      reset(nextInitial = initial) {
        listeners.clear();
        this.value = nextInitial.value ?? '';
        this.checked = nextInitial.checked ?? false;
        this.addEventListener.mockClear();
      },
    };
  };

  const dom = {
    autoRefreshToggle: createControl({ checked: false }),
    expandTermsToggle: createControl({ checked: false }),
    minLikesInput: createControl({ value: '' }),
    postUrlInput: createControl({ value: '' }),
    quoteForm: createControl(),
    quoteTabs: createControl(),
    refreshIntervalSelect: createControl({ value: '5' }),
    searchBtn: createControl(),
    sortSelect: createControl({ value: 'top' }),
    termsInput: createControl({ value: '' }),
    themeSelect: createControl({ value: 'system' }),
    timeFilterSelect: createControl({ value: '24' }),
  };

  const state = {
    autoRefreshEnabled: false,
    pendingSearch: false,
    quoteSort: 'likes',
    searchSort: 'top',
  };

  const search = {
    applySearchSortChange: vi.fn(),
    cancelDebouncedSearch: vi.fn(),
    clearSearchResults: vi.fn(),
    debouncedSearch: vi.fn(),
    disableAutoRefresh: vi.fn(),
    enableAutoRefresh: vi.fn(),
    focusSearchInput: vi.fn(),
    performSearch: vi.fn(),
    scheduleNextRefresh: vi.fn(),
    updateExpansionSummary: vi.fn(),
    updateRefreshInterval: vi.fn(),
    updateRefreshMeta: vi.fn(),
    updateSearchURL: vi.fn(),
  };

  const quotes = {
    handleQuoteTabClick: vi.fn(),
    performQuoteSearch: vi.fn(),
    updateQuoteTabs: vi.fn(),
  };

  const theme = {
    handleSystemThemeChange: vi.fn(),
    handleThemeChange: vi.fn(),
    initTheme: vi.fn(),
    prefersDarkScheme: { addEventListener: vi.fn() },
  };

  const url = {
    updateURLWithParams: vi.fn(),
  };

  const reset = () => {
    dom.autoRefreshToggle.reset({ checked: false });
    dom.expandTermsToggle.reset({ checked: false });
    dom.minLikesInput.reset({ value: '' });
    dom.postUrlInput.reset({ value: '' });
    dom.quoteForm.reset();
    dom.quoteTabs.reset();
    dom.refreshIntervalSelect.reset({ value: '5' });
    dom.searchBtn.reset();
    dom.sortSelect.reset({ value: 'top' });
    dom.termsInput.reset({ value: '' });
    dom.themeSelect.reset({ value: 'system' });
    dom.timeFilterSelect.reset({ value: '24' });

    state.autoRefreshEnabled = false;
    state.pendingSearch = false;
    state.quoteSort = 'likes';
    state.searchSort = 'top';

    for (const mod of [search, quotes, theme, url]) {
      for (const val of Object.values(mod)) {
        if (typeof val?.mockClear === 'function') val.mockClear();
        if (typeof val?.addEventListener?.mockClear === 'function') val.addEventListener.mockClear();
      }
    }
  };

  return {
    dom,
    quotes,
    reset,
    search,
    state,
    theme,
    url,
  };
});

vi.mock('../src/state.mjs', () => ({ state: mocks.state }));
vi.mock('../src/dom.mjs', () => mocks.dom);
vi.mock('../src/utils.mjs', () => ({
  normalizeSortValue: (raw) => (raw === 'latest' ? 'latest' : 'top'),
}));
vi.mock('../src/search.mjs', () => mocks.search);
vi.mock('../src/quotes.mjs', () => mocks.quotes);
vi.mock('../src/theme.mjs', () => mocks.theme);
vi.mock('../src/url.mjs', () => mocks.url);

async function bootApp() {
  await import('../src/app.mjs');
}

describe('app sort change handler', () => {
  let originalWindow;

  beforeEach(() => {
    vi.resetModules();
    mocks.reset();
    originalWindow = globalThis.window;
    globalThis.window = { location: { search: '' } };
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete globalThis.window;
      return;
    }
    globalThis.window = originalWindow;
  });

  it('rebuilds and re-renders results when sort changes', async () => {
    await bootApp();

    mocks.dom.sortSelect.value = 'latest';
    mocks.dom.sortSelect.dispatch('change');

    expect(mocks.state.searchSort).toBe('latest');
    expect(mocks.search.updateSearchURL).toHaveBeenCalledTimes(1);
    expect(mocks.search.applySearchSortChange).toHaveBeenCalledTimes(1);
    expect(mocks.search.scheduleNextRefresh).not.toHaveBeenCalled();
  });

  it('rebuilds and re-renders when sort changes back to top', async () => {
    await bootApp();

    mocks.state.searchSort = 'latest';
    mocks.dom.sortSelect.value = 'top';
    mocks.dom.sortSelect.dispatch('change');

    expect(mocks.state.searchSort).toBe('top');
    expect(mocks.search.updateSearchURL).toHaveBeenCalledTimes(1);
    expect(mocks.search.applySearchSortChange).toHaveBeenCalledTimes(1);
    expect(mocks.search.scheduleNextRefresh).not.toHaveBeenCalled();
  });

  it('reschedules auto-refresh when enabled after sort changes', async () => {
    await bootApp();

    mocks.state.autoRefreshEnabled = true;
    mocks.dom.sortSelect.value = 'latest';
    mocks.dom.sortSelect.dispatch('change');

    expect(mocks.search.scheduleNextRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('app search input handler', () => {
  let originalWindow;

  beforeEach(() => {
    vi.resetModules();
    mocks.reset();
    originalWindow = globalThis.window;
    globalThis.window = { location: { search: '' } };
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete globalThis.window;
      return;
    }
    globalThis.window = originalWindow;
  });

  it('clears stale results when the terms field is emptied', async () => {
    await bootApp();

    const expansionCallsBeforeInput = mocks.search.updateExpansionSummary.mock.calls.length;
    mocks.dom.termsInput.value = '';
    mocks.state.pendingSearch = true;
    mocks.dom.termsInput.dispatch('input');

    expect(mocks.search.updateExpansionSummary).toHaveBeenCalledTimes(expansionCallsBeforeInput + 1);
    expect(mocks.search.cancelDebouncedSearch).toHaveBeenCalledTimes(1);
    expect(mocks.search.clearSearchResults).toHaveBeenCalledTimes(1);
    expect(mocks.search.debouncedSearch).not.toHaveBeenCalled();
  });

  it('debounces search when the terms field has content', async () => {
    await bootApp();

    const expansionCallsBeforeInput = mocks.search.updateExpansionSummary.mock.calls.length;
    mocks.dom.termsInput.value = 'apple';
    mocks.dom.termsInput.dispatch('input');

    expect(mocks.search.updateExpansionSummary).toHaveBeenCalledTimes(expansionCallsBeforeInput + 1);
    expect(mocks.search.clearSearchResults).not.toHaveBeenCalled();
    expect(mocks.search.debouncedSearch).toHaveBeenCalledTimes(1);
  });
});

describe('app URL initialization', () => {
  let originalWindow;

  beforeEach(() => {
    vi.resetModules();
    mocks.reset();
    originalWindow = globalThis.window;
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete globalThis.window;
      return;
    }
    globalThis.window = originalWindow;
  });

  it('reads distinct searchSort and quoteSort params without collisions', async () => {
    globalThis.window = {
      location: {
        search:
          '?searchSort=latest&post=https%3A%2F%2Fbsky.app%2Fprofile%2Falice%2Fpost%2F123&quoteSort=recent',
      },
    };

    await bootApp();

    expect(mocks.dom.sortSelect.value).toBe('latest');
    expect(mocks.state.searchSort).toBe('latest');
    expect(mocks.state.quoteSort).toBe('recent');
    expect(mocks.quotes.updateQuoteTabs).toHaveBeenCalledTimes(1);
    expect(mocks.quotes.performQuoteSearch).toHaveBeenCalledTimes(1);
    expect(mocks.url.updateURLWithParams).not.toHaveBeenCalled();
  });

  it('migrates legacy search sort links to searchSort', async () => {
    globalThis.window = {
      location: {
        search: '?sort=latest',
      },
    };

    await bootApp();

    expect(mocks.dom.sortSelect.value).toBe('latest');
    expect(mocks.state.searchSort).toBe('latest');
    expect(mocks.state.quoteSort).toBe('likes');
    expect(mocks.url.updateURLWithParams).toHaveBeenCalledTimes(1);
    const params = mocks.url.updateURLWithParams.mock.calls[0][0];
    expect(params.get('searchSort')).toBe('latest');
    expect(params.get('sort')).toBe(null);
  });

  it('migrates legacy quote sort links to quoteSort', async () => {
    globalThis.window = {
      location: {
        search:
          '?post=https%3A%2F%2Fbsky.app%2Fprofile%2Falice%2Fpost%2F123&sort=recent',
      },
    };

    await bootApp();

    expect(mocks.state.quoteSort).toBe('recent');
    expect(mocks.quotes.updateQuoteTabs).toHaveBeenCalledTimes(1);
    expect(mocks.quotes.performQuoteSearch).toHaveBeenCalledTimes(1);
    expect(mocks.url.updateURLWithParams).toHaveBeenCalledTimes(1);
    const params = mocks.url.updateURLWithParams.mock.calls[0][0];
    expect(params.get('post')).toBe('https://bsky.app/profile/alice/post/123');
    expect(params.get('quoteSort')).toBe('recent');
    expect(params.get('sort')).toBe(null);
  });
});
