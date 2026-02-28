import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

interface MockControl {
  value: string;
  checked: boolean;
  addEventListener: Mock;
  dispatch(eventName: string, event?: Record<string, unknown>): void;
  reset(nextInitial?: { value?: string; checked?: boolean }): void;
}

const mocks = vi.hoisted(() => {
  const createControl = (initial: { value?: string; checked?: boolean } = {}): MockControl => {
    const listeners = new Map<string, Function>();
    return {
      value: initial.value ?? '',
      checked: initial.checked ?? false,
      addEventListener: vi.fn((eventName: string, handler: Function) => {
        listeners.set(eventName, handler);
      }),
      dispatch(eventName: string, event: Record<string, unknown> = {}) {
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

  const reset = (): void => {
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

    for (const mod of [search, quotes, theme]) {
      for (const val of Object.values(mod)) {
        if (typeof (val as Mock)?.mockClear === 'function') (val as Mock).mockClear();
        if (typeof (val as { addEventListener?: Mock })?.addEventListener?.mockClear === 'function') (val as { addEventListener: Mock }).addEventListener.mockClear();
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
  };
});

vi.mock('../src/state', () => ({ state: mocks.state }));
vi.mock('../src/dom', () => mocks.dom);
vi.mock('../src/utils', () => ({
  normalizeSortValue: (raw: string) => (raw === 'latest' ? 'latest' : 'top'),
}));
vi.mock('../src/search', () => mocks.search);
vi.mock('../src/quotes', () => mocks.quotes);
vi.mock('../src/theme', () => mocks.theme);

async function bootApp(): Promise<void> {
  await import('../src/app');
}

describe('app sort change handler', () => {
  let originalWindow: typeof globalThis.window;

  beforeEach(() => {
    vi.resetModules();
    mocks.reset();
    originalWindow = globalThis.window;
    globalThis.window = { location: { search: '' } } as unknown as typeof globalThis.window;
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: typeof globalThis.window }).window;
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
