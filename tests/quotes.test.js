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

  it('keeps the Load More Quotes button in place while it loads, then hands focus to the last quote', async () => {
    mockInitial();
    await quotes.performQuoteSearch();
    const button = document.getElementById('quoteLoadMoreBtn');
    button.focus();
    const next = deferred();
    fetch.mockReturnValueOnce(next.promise);
    const loading = quotes.loadMoreQuotes();
    expect(document.getElementById('quoteLoadMoreBtn')).toBe(button);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.textContent).toBe('Loading…');

    next.resolve(response({ posts: [post('q2')], cursor: 'c2' }));
    await loading;
    expect(document.getElementById('quoteLoadMoreBtn')).toBe(button);
    expect(button.getAttribute('aria-disabled')).toBe(null);
    expect(document.activeElement).toBe(button);

    fetch.mockResolvedValueOnce(response({ posts: [post('q3')] }));
    await quotes.loadMoreQuotes();
    expect(document.getElementById('quoteLoadMoreBtn')).toBeNull();
    expect(document.activeElement).toBe(elements.quoteResults.lastElementChild);
    expect(document.activeElement.tabIndex).toBe(-1);
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
