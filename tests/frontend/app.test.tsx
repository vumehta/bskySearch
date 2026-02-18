import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import App from '../../src/frontend/App';

function mockResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

function asUrl(input: RequestInfo | URL): URL {
  if (typeof input === 'string') return new URL(input, 'https://example.test');
  if (input instanceof URL) return input;
  return new URL(input.url, 'https://example.test');
}

function installMatchMediaMock() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function installLocalStorageMock() {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => {
      store.clear();
    },
    getItem: (key: string) => {
      return store.has(key) ? store.get(key)! : null;
    },
    key: (index: number) => {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };

  Object.defineProperty(window, 'localStorage', {
    writable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    writable: true,
    value: storage,
  });
}

describe('App URL state and UI behavior', () => {
  beforeEach(() => {
    installLocalStorageMock();
    installMatchMediaMock();
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it('hydrates search controls from URL and rewrites legacy sort param', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse({ posts: [], cursor: null })));
    window.history.replaceState({}, '', '/?terms=cat,dog&minLikes=5&time=48&expand=1&sort=latest');

    render(<App />);

    expect(screen.getByLabelText('Search Terms (comma-separated)')).toHaveValue('cat,dog');
    expect(screen.getByLabelText('Min. Likes')).toHaveValue(5);
    expect(screen.getByLabelText('Time Range')).toHaveValue('48');
    expect(screen.getByLabelText('Sort')).toHaveValue('latest');
    expect(
      screen.getByLabelText('Also search each word in multi-word phrases'),
    ).toBeChecked();

    await waitFor(() => {
      expect(window.location.search).toContain('searchSort=latest');
    });
    expect(window.location.search).not.toContain('sort=latest');
  });

  it('submits a search request and renders fetched posts', async () => {
    window.history.replaceState({}, '', '/?terms=alpha,beta&time=48&searchSort=latest');

    const now = new Date().toISOString();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = asUrl(input);
      expect(url.pathname).toBe('/api/search');

      const term = url.searchParams.get('term');
      const sort = url.searchParams.get('sort');
      expect(sort).toBe('latest');

      if (!term) return mockResponse({ posts: [], cursor: null });

      return mockResponse({
        posts: [
          {
            uri: `at://did:plc:test/app.bsky.feed.post/${term}`,
            author: {
              handle: `${term}.bsky.social`,
              displayName: term.toUpperCase(),
            },
            record: {
              text: `${term} post`,
              createdAt: now,
            },
            indexedAt: now,
            likeCount: 15,
            repostCount: 1,
            replyCount: 0,
          },
        ],
        cursor: null,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('2 posts found')).toBeInTheDocument();
    expect(screen.getByText('ALPHA')).toBeInTheDocument();
    expect(screen.getByText('BETA')).toBeInTheDocument();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    const requestedTerms = fetchMock.mock.calls.map(([input]) =>
      asUrl(input as RequestInfo | URL).searchParams.get('term'),
    );
    expect(new Set(requestedTerms)).toEqual(new Set(['alpha', 'beta']));
  });
});
