import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.className = '';
    this.textContent = '';
    this.classList = { contains: (name) => this.className.split(' ').includes(name) };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  get firstElementChild() { return this.children[0] || null; }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, before) {
    child.parentNode = this;
    const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index, 0, child);
    return child;
  }
  remove() { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); }
  querySelector(selector) {
    return this.children.find((child) => selector === 'button.thread-link' &&
      child.tagName === 'button' && child.classList.contains('thread-link')) || null;
  }
}

const parent = (text = 'parent') => ({
  uri: 'at://did:plc:test/app.bsky.feed.post/parent123',
  author: { handle: 'example.bsky.social' },
  record: { text, createdAt: '2026-01-01T11:00:00Z' },
  indexedAt: '2026-01-01T12:00:00Z',
});
const response = (data) => ({ ok: true, json: async () => data });
const withParent = (text = 'parent') => response({ thread: { parent: { post: parent(text) } } });
function createCard() {
  const card = new Element();
  const link = new Element('button');
  link.className = 'thread-link';
  card.appendChild(link);
  return { card, link };
}
function context(card) { return card.children.find((node) => node.classList.contains('thread-context')); }

let thread;
let fetchMock;
const post = { uri: 'at://did:plc:test/app.bsky.feed.post/abc123' };

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
  vi.stubGlobal('document', { createElement: (tag) => new Element(tag) });
  fetchMock = vi.fn(async () => withParent());
  vi.stubGlobal('fetch', fetchMock);
  thread = await import('../src/thread.mjs');
});

afterEach(() => {
  thread.cancelThreadRequests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('thread disclosure', () => {
  it('preserves parent order and text, exposes disclosure state, and reuses recent results', async () => {
    const { card, link } = createCard();
    thread.initializeThreadToggle(link);
    expect(link.getAttribute('aria-expanded')).toBe('false');
    fetchMock.mockResolvedValue(response({ thread: { parent: {
      post: parent('immediate'), parent: { post: parent('<b>root</b>') },
    } } }));
    await thread.toggleThread(post, card);
    const rendered = context(card);
    expect(rendered.id).toBe(link.getAttribute('aria-controls'));
    expect(link.getAttribute('aria-expanded')).toBe('true');
    expect(rendered.children.slice(1).map((node) => node.children[1].textContent))
      .toEqual(['<b>root</b>', 'immediate']);
    expect(rendered.children[1].children[0].children.at(-1).textContent).toBe('1h ago');

    await thread.toggleThread(post, card);
    expect(context(card)).toBeUndefined();
    expect(link.getAttribute('aria-expanded')).toBe('false');
    await thread.toggleThread(post, card);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(context(card)).toBeDefined();
  });

  it('refreshes cached parents after the cache lifetime', async () => {
    const { card } = createCard();
    await thread.toggleThread(post, card);
    await thread.toggleThread(post, card);
    vi.advanceTimersByTime(30000);
    fetchMock.mockResolvedValue(withParent('updated'));
    await thread.toggleThread(post, card);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(context(card).children[1].children[1].textContent).toBe('updated');
  });

  it('rejects malformed parent data before rendering or caching it', async () => {
    const { card, link } = createCard();
    fetchMock.mockResolvedValueOnce(response({ thread: { parent: {
      post: { ...parent(), record: { text: { unexpected: 'object' } } },
    } } }));
    await thread.toggleThread(post, card);
    expect(link.textContent).toBe('Failed to load thread');
    expect(context(card)).toBeUndefined();
    await thread.toggleThread(post, card);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(link.textContent).toBe('Hide Thread');
  });

  it('bounds cached threads and gives each disclosure its own controlled region', async () => {
    const first = createCard();
    await thread.toggleThread(post, first.card);
    await thread.toggleThread(post, first.card);
    const ids = new Set([first.link.getAttribute('aria-controls')]);
    for (let index = 0; index < 100; index += 1) {
      const current = createCard();
      await thread.toggleThread({ uri: `${post.uri}${index}` }, current.card);
      ids.add(current.link.getAttribute('aria-controls'));
    }
    expect(ids.size).toBe(101);
    await thread.toggleThread(post, first.card);
    expect(fetchMock).toHaveBeenCalledTimes(102);
  });

  it('does not let a no-parent status timer overwrite a successful retry', async () => {
    const { card, link } = createCard();
    fetchMock.mockResolvedValueOnce(response({ thread: {} }));
    await thread.toggleThread(post, card);
    expect(link.textContent).toBe('No parent posts found');
    await thread.toggleThread(post, card);
    await vi.advanceTimersByTimeAsync(2000);
    expect(link.textContent).toBe('Hide Thread');
    expect(link.getAttribute('aria-expanded')).toBe('true');
    expect(context(card)).toBeDefined();
  });

  it('does not let an error status timer overwrite an in-flight retry', async () => {
    const { card, link } = createCard();
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await thread.toggleThread(post, card);
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    const retry = thread.toggleThread(post, card);
    await vi.advanceTimersByTimeAsync(2000);
    expect(link.textContent).toBe('Cancel loading');
    await thread.toggleThread(post, card);
    await retry;
    expect(link.textContent).toBe('View Thread');
  });

  it('cancels loading on a second click and ignores the late response', async () => {
    const { card, link } = createCard();
    let resolve;
    fetchMock.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = thread.toggleThread(post, card);
    const signal = fetchMock.mock.calls[0][1].signal;
    await thread.toggleThread(post, card);
    expect(signal.aborted).toBe(true);
    resolve(withParent('late'));
    await pending;
    expect(context(card)).toBeUndefined();
    expect(link.textContent).toBe('View Thread');
    expect(link.getAttribute('aria-expanded')).toBe('false');
    expect(link.getAttribute('aria-busy')).toBeNull();
    await thread.toggleThread(post, card);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels removed cards and all active requests when results reset', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const first = createCard();
    const second = createCard();
    const pending = [thread.toggleThread(post, first.card), thread.toggleThread(post, second.card)];
    const signals = fetchMock.mock.calls.map((call) => call[1].signal);
    thread.cancelThreadRequest(first.card);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    thread.cancelThreadRequests();
    await Promise.all(pending);
    expect(signals[1].aborted).toBe(true);
    expect(first.link.textContent).toBe('View Thread');
    expect(second.link.textContent).toBe('View Thread');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out an unresponsive request and allows a successful retry', async () => {
    const { card, link } = createCard();
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    const pending = thread.toggleThread(post, card);
    await vi.advanceTimersByTimeAsync(10000);
    await pending;
    expect(link.textContent).toBe('Thread request timed out');
    expect(link.dataset.loading).toBe('false');
    await thread.toggleThread(post, card);
    await vi.advanceTimersByTimeAsync(2000);
    expect(link.textContent).toBe('Hide Thread');
    expect(vi.getTimerCount()).toBe(0);
  });
});
