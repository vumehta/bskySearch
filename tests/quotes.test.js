import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDocument, deferred, TestNode } from './helpers/dom.mjs';

const post = (id, likes = 1) => ({
  uri: `at://did:plc:test/app.bsky.feed.post/${id}`,
  author: { handle: 'alice.bsky.social' },
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
    'postUrl', 'quoteSearchBtn', 'quoteStatus', 'quoteTabs', 'quoteOriginal', 'quoteCount', 'quoteResults', 'quoteLoadMore',
  ]);
  elements = fixture.elements;
  for (const mode of ['likes', 'recent', 'oldest']) {
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

  it('announces the selected sort and safely renders hostile post text', async () => {
    mockInitial({ posts: [{ ...post('hostile'), record: { text: '<img src=x onerror=alert(1)>' } }], cursor: null });
    await quotes.performQuoteSearch();
    const oldest = elements.quoteTabs.children[2];
    quotes.handleQuoteTabClick({ target: oldest });
    expect(oldest.getAttribute('aria-pressed')).toBe('true');
    expect(elements.quoteTabs.children[0].getAttribute('aria-pressed')).toBe('false');
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
