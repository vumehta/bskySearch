import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDocument, TestNode } from './helpers/dom.mjs';

const parent = (text = 'parent') => ({
  uri: 'at://did:plc:test/app.bsky.feed.post/parent123',
  author: { did: 'did:plc:test', handle: 'example.bsky.social' },
  record: { text, createdAt: '2026-01-01T11:00:00Z' },
  indexedAt: '2026-01-01T12:00:00Z',
});
const response = (data) => ({ ok: true, json: async () => data });
const withParent = (text = 'parent') => response({ thread: { parent: { post: parent(text) } } });
function createCard() {
  const card = new TestNode();
  const link = new TestNode('button');
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
  vi.stubGlobal('document', createTestDocument([]).document);
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

  it.each([
    ['a deleted parent', { $type: 'app.bsky.feed.defs#notFoundPost', uri: parent().uri, notFound: true }, 'Parent post not found'],
  ])('says so when the thread starts at %s, showing any parents below it', async (_kind, missing, notice) => {
    const direct = createCard();
    fetchMock.mockResolvedValueOnce(response({ thread: { parent: missing } }));
    await thread.toggleThread(post, direct.card);
    expect(direct.link.textContent).toBe(notice);
    expect(context(direct.card)).toBeUndefined();

    const { card, link } = createCard();
    fetchMock.mockResolvedValueOnce(response({ thread: { parent: { post: parent('reachable'), parent: missing } } }));
    await thread.toggleThread({ uri: `${post.uri}2` }, card);
    expect(link.textContent).toBe('Hide Thread');
    expect(context(card).children.slice(1).map((node) => [node.className, node.querySelector('.thread-parent-text').textContent]))
      .toEqual([['thread-parent thread-parent-missing', notice], ['thread-parent', 'reachable']]);
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
    await thread.toggleThread(post, card);
    await vi.advanceTimersByTimeAsync(2000);
    expect(link.textContent).toBe('Hide Thread');
    expect(vi.getTimerCount()).toBe(0);
  });
});
