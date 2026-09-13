import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDocument, deferred, TestNode } from './helpers/dom.mjs';

const post = (id, likes = 1) => ({
  uri: `at://did:plc:test/app.bsky.feed.post/${id}`,
  author: { did: 'did:plc:test', handle: 'alice.bsky.social' },
  record: { text: id, createdAt: '2026-09-05T00:00:00Z' },
  likeCount: likes,
  quoteCount: 1,
});
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const urlFor = (id) => `https://bsky.app/profile/did:plc:test/post/${id}`;
let elements;
let quotes;
let state;

beforeEach(async () => {
  vi.resetModules();
  const fixture = createTestDocument([
    'postUrl', 'quoteStatus', 'quoteTabs', 'quoteOriginal', 'quoteCount', 'quoteResults', 'quoteLoadMore',
  ]);
  elements = fixture.elements;
  for (const mode of ['likes', 'recent', 'oldest', 'bookmarks']) {
    const tab = new TestNode('button');
    tab.className = 'quote-tab';
    tab.dataset.sort = mode;
    elements.quoteTabs.appendChild(tab);
  }
  vi.stubGlobal('document', fixture.document);
  vi.stubGlobal('window', {
    location: { search: '', pathname: '/' },
    history: { replaceState: vi.fn() },
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  quotes = await import('../src/quotes.mjs');
  ({ state } = await import('../src/state.mjs'));
  elements.postUrl.value = urlFor('original');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mockInitial(page = { posts: [post('q1')], cursor: 'c1' }) {
  vi.stubGlobal('fetch', vi.fn(async (url) => url.includes('getPosts')
    ? response({ posts: [post('original')] })
    : response(page)));
}

describe('quote search and pagination', () => {
  it('resolves a handle for both post requests and reuses its DID for another post', async () => {
    const did = 'did:plc:resolved';
    const originalUri = `at://${did}/app.bsky.feed.post/original`;
    const nextUri = `at://${did}/app.bsky.feed.post/next`;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const { pathname, searchParams } = new URL(url);
      if (pathname === '/xrpc/app.bsky.actor.getProfile') return response({ did });
      if (pathname === '/xrpc/app.bsky.feed.getPosts') {
        const uri = searchParams.get('uris');
        return response({ posts: [{ ...post(uri.split('/').at(-1)), uri }] });
      }
      if (pathname === '/xrpc/app.bsky.feed.getQuotes') {
        const id = searchParams.get('uri').split('/').at(-1);
        return response({ posts: [post(`${id}-quote`)] });
      }
      throw new Error(`Unexpected quote endpoint: ${url}`);
    }));
    elements.postUrl.value = 'https://bsky.app/profile/alice.bsky.social/post/original';
    await quotes.performQuoteSearch();
    expect(state.activeQuoteUri).toBe(originalUri);
    expect(elements.quoteOriginal.querySelector('.quote-text').textContent).toBe('original');
    expect(elements.quoteResults.querySelector('.quote-text').textContent).toBe('original-quote');

    elements.postUrl.value = 'https://bsky.app/profile/alice.bsky.social/post/next';
    await quotes.performQuoteSearch();
    expect(state.activeQuoteUri).toBe(nextUri);
    expect(elements.quoteOriginal.querySelector('.quote-text').textContent).toBe('next');
    expect(elements.quoteResults.querySelector('.quote-text').textContent).toBe('next-quote');
    const requests = fetch.mock.calls.map(([url]) => new URL(url));
    const paramsFor = (method, parameter) => requests
      .filter((url) => url.pathname === `/xrpc/${method}`)
      .map((url) => url.searchParams.get(parameter));
    expect(paramsFor('app.bsky.actor.getProfile', 'actor')).toEqual(['alice.bsky.social']);
    expect(paramsFor('app.bsky.feed.getPosts', 'uris')).toEqual([originalUri, nextUri]);
    expect(paramsFor('app.bsky.feed.getQuotes', 'uri')).toEqual([originalUri, nextUri]);
  });

  it('links a quote from an author with an unverified handle by DID', async () => {
    mockInitial({ posts: [{ ...post('q1'), author: { did: 'did:plc:test', handle: 'handle.invalid' } }] });
    await quotes.performQuoteSearch();
    expect(elements.quoteResults.querySelector('.thread-link').href).toBe('https://bsky.app/profile/did:plc:test/post/q1');
  });

  it.each([
    ['recent', ['newest', 'middle', 'oldest'], ['latest', 'newest', 'middle', 'oldest', 'earliest']],
    ['oldest', ['oldest', 'middle', 'newest'], ['earliest', 'oldest', 'middle', 'newest', 'latest']],
  ])('orders quotes by %s before and after pagination', async (sort, initialOrder, pagedOrder) => {
    const datedPost = (id, day) => ({
      ...post(id),
      record: { text: id, createdAt: `2026-09-0${day}T00:00:00Z` },
    });
    mockInitial({ posts: [datedPost('middle', 3), datedPost('oldest', 2), datedPost('newest', 4)], cursor: 'c1' });
    await quotes.performQuoteSearch();
    const tab = elements.quoteTabs.children.find((node) => node.dataset.sort === sort);
    quotes.handleQuoteTabClick({ target: tab });
    const renderedOrder = () => elements.quoteResults.querySelectorAll('.quote-text').map((node) => node.textContent);
    expect(renderedOrder()).toEqual(initialOrder);
    expect(tab.getAttribute('aria-pressed')).toBe('true');
    expect(elements.quoteTabs.children[0].getAttribute('aria-pressed')).toBe('false');

    fetch.mockResolvedValueOnce(response({ posts: [datedPost('earliest', 1), datedPost('latest', 5)] }));
    await quotes.loadMoreQuotes();
    expect(renderedOrder()).toEqual(pagedOrder);
    expect(state.quoteCursor).toBeNull();
  });

  it('orders quotes by saves, then likes, and shows the save count', async () => {
    mockInitial({ posts: [post('liked', 9), { ...post('saved', 1), bookmarkCount: 3 }, { ...post('both', 5), bookmarkCount: 3 }] });
    await quotes.performQuoteSearch();
    quotes.handleQuoteTabClick({ target: elements.quoteTabs.children.find((node) => node.dataset.sort === 'bookmarks') });
    expect(elements.quoteResults.querySelectorAll('.quote-text').map((node) => node.textContent)).toEqual(['both', 'saved', 'liked']);
    expect(elements.quoteResults.querySelector('.quote-stats').children.at(-1).getAttribute('aria-label')).toBe('3 saves');
  });

  it('shows author badges on quote cards', async () => {
    const author = { ...post('q1').author, verification: { verifiedStatus: 'valid', trustedVerifierStatus: 'none' } };
    mockInitial({ posts: [{ ...post('q1'), author }] });
    await quotes.performQuoteSearch();
    expect(elements.quoteResults.querySelector('.quote-author').querySelector('.badge').textContent).toBe('Verified');
  });

  it('deduplicates overlapping pages, refreshes changed cards, and stops repeated cursors', async () => {
    mockInitial();
    await quotes.performQuoteSearch();
    fetch.mockImplementation(async () => response({ posts: [post('q1', 8), post('q2')], cursor: 'c1' }));
    await quotes.loadMoreQuotes();
    expect(state.allQuotes.map((item) => item.uri)).toEqual([post('q1').uri, post('q2').uri]);
    expect(state.quoteCursor).toBeNull();
    expect(elements.quoteCount.textContent).toBe('Loaded 2 quotes');
    expect(elements.quoteResults.children).toHaveLength(2);
    expect(elements.quoteResults.textContent).toContain('8');
  });

  it('does not duplicate quotes or inflate totals when a whole page repeats', async () => {
    mockInitial();
    await quotes.performQuoteSearch();
    await quotes.loadMoreQuotes();
    expect(state.allQuotes).toHaveLength(1);
    expect(elements.quoteCount.textContent).toBe('Loaded 1 of 1 quote');
    expect(state.quoteCursor).toBeNull();
  });

  it('reuses cards for appended quotes and rerenders when pagination changes their order', async () => {
    mockInitial({ posts: [post('q1', 3), post('q2', 2)], cursor: 'c1' });
    await quotes.performQuoteSearch();
    const firstCard = elements.quoteResults.children[0];
    const secondCard = elements.quoteResults.children[1];

    fetch.mockResolvedValueOnce(response({ posts: [post('q3', 1)], cursor: 'c2' }));
    await quotes.loadMoreQuotes();
    expect(elements.quoteResults.children).toHaveLength(3);
    expect(elements.quoteResults.children[0]).toBe(firstCard);
    expect(elements.quoteResults.children[1]).toBe(secondCard);

    fetch.mockResolvedValueOnce(response({ posts: [post('q4', 4)] }));
    await quotes.loadMoreQuotes();
    expect(elements.quoteResults.querySelectorAll('.quote-text').map((node) => node.textContent))
      .toEqual(['q4', 'q1', 'q2', 'q3']);
    expect(elements.quoteResults.children[1]).not.toBe(firstCard);
    expect(state.quoteCursor).toBeNull();
    expect(document.getElementById('quoteLoadMoreBtn')).toBeNull();
  });

  it('replaces pagination with a new post search and ignores the obsolete response', async () => {
    mockInitial();
    await quotes.performQuoteSearch();
    const pending = deferred();
    let oldSignal;
    fetch.mockImplementationOnce((_, options) => { oldSignal = options.signal; return pending.promise; });
    const oldPage = quotes.loadMoreQuotes();
    elements.postUrl.value = urlFor('replacement');
    fetch.mockImplementation(async (url) => url.includes('getPosts')
      ? response({ posts: [post('replacement')] })
      : response({ posts: [post('newquote')] }));
    await quotes.performQuoteSearch();
    pending.resolve(response({ posts: [post('obsolete')], cursor: 'obsolete-cursor' }));
    await oldPage;
    expect(oldSignal.aborted).toBe(true);
    expect(state.activeQuoteUri).toBe(post('replacement').uri);
    expect(state.allQuotes.map((item) => item.uri)).toEqual([post('newquote').uri]);
    expect(elements.quoteOriginal.textContent).toContain('replacement');
    expect(elements.quoteStatus.style.display).toBe('none');
    expect(state.isQuoteLoading).toBe(false);
  });

  it('keeps the current search loading when an older request finishes', async () => {
    const first = deferred();
    const second = deferred();
    vi.stubGlobal('fetch', vi.fn(async (url) => url.includes('getPosts')
      ? response({ posts: [post(url.includes('replacement') ? 'replacement' : 'original')] })
      : first.promise));
    const oldSearch = quotes.performQuoteSearch();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    elements.postUrl.value = urlFor('replacement');
    fetch.mockImplementation(async (url) => url.includes('getPosts')
      ? response({ posts: [post('replacement')] })
      : second.promise);
    const newSearch = quotes.performQuoteSearch();
    await oldSearch;
    expect(state.isQuoteLoading).toBe(true);
    first.resolve(response({ posts: [post('old')] }));
    second.resolve(response({ posts: [post('new')] }));
    await newSearch;
    expect(state.allQuotes[0].uri).toBe(post('new').uri);
  });

  it('retains pagination for retry after an HTTP error', async () => {
    mockInitial();
    await quotes.performQuoteSearch();
    fetch.mockResolvedValueOnce(response({ error: 'Please retry' }, 503));
    await quotes.loadMoreQuotes();
    expect(state.quoteCursor).toBe('c1');
    expect(state.allQuotes).toHaveLength(1);
    expect(state.isQuoteLoading).toBe(false);
    expect(document.getElementById('quoteLoadMoreBtn').disabled).toBe(false);
    expect(elements.quoteStatus.textContent).toContain('Please retry');
  });

  it('recovers from a body timeout and can search again', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}) })));
    const pending = quotes.performQuoteSearch();
    await vi.advanceTimersByTimeAsync(10000);
    await pending;
    expect(state.isQuoteLoading).toBe(false);
    expect(elements.quoteStatus.textContent).toContain('timed out');
    mockInitial({ posts: [] });
    await quotes.performQuoteSearch();
    expect(elements.quoteResults.textContent).toContain('No quotes found');
  });

  it('rejects invalid post data instead of rendering a false empty result', async () => {
    mockInitial({ wrong: [] });
    await quotes.performQuoteSearch();
    expect(elements.quoteStatus.textContent).toContain('invalid post data');
    expect(elements.quoteResults.textContent).toBe('');
    expect(state.isQuoteLoading).toBe(false);
  });

  it('safely renders hostile post text', async () => {
    mockInitial({ posts: [{ ...post('hostile'), record: { text: '<img src=x onerror=alert(1)>' } }], cursor: null });
    await quotes.performQuoteSearch();
    expect(elements.quoteResults.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(elements.quoteResults.querySelector('.quote-text').children).toHaveLength(0);
  });

  it.each(['displayName', 'avatar'])('rejects object-valued author %s before committing a cursor', async (field) => {
    const malformed = post('bad');
    malformed.author[field] = { toString: 1, valueOf: 1 };
    mockInitial({ posts: [malformed], cursor: 'c1' });
    await quotes.performQuoteSearch();
    expect(elements.quoteStatus.textContent).toContain('invalid post data');
    expect(state.allQuotes).toEqual([]);
    expect(state.quoteCursor).toBeNull();
    expect(document.getElementById('quoteLoadMoreBtn')).toBeNull();
    mockInitial({ posts: [post('good')] });
    await quotes.performQuoteSearch();
    expect(state.allQuotes[0].uri).toBe(post('good').uri);
  });

  it('retains valid quotes and a retryable cursor after malformed pagination data', async () => {
    mockInitial();
    await quotes.performQuoteSearch();
    fetch.mockResolvedValueOnce(response({ posts: [{ ...post('bad'), record: { createdAt: {} } }], cursor: 'c2' }));
    await quotes.loadMoreQuotes();
    expect(state.allQuotes.map((item) => item.uri)).toEqual([post('q1').uri]);
    expect(state.quoteCursor).toBe('c1');
    expect(elements.quoteStatus.textContent).toContain('invalid post data');
    expect(document.getElementById('quoteLoadMoreBtn').disabled).toBe(false);
  });
});
