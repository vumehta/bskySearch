import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDocument, TestNode } from './helpers/dom.mjs';
import { appendPostEmbeds } from '../src/post-embeds.mjs';

const linkCard = (external) => ({ $type: 'app.bsky.embed.external#view', external });
const newsCard = linkCard({
  uri: 'https://www.news.example/apple?ref=feed',
  title: 'Apple beats earnings',
  description: 'A record quarter.',
});
const quote = (record) => ({ $type: 'app.bsky.embed.record#view', record });

function render(embed) {
  const container = new TestNode();
  appendPostEmbeds(container, embed);
  return container;
}

beforeEach(() => {
  vi.stubGlobal('document', createTestDocument([]).document);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('untrusted embeds', () => {
  it('names the site after the link itself, not after anything the card claims', () => {
    const container = render(linkCard({ uri: 'https://trusted.example@evil.example/login', title: 'Sign in', site: 'trusted.example' }));
    expect(container.querySelector('.embed-link-site').textContent).toBe('evil.example');
  });

  it('keeps usable fields when an embed contains malformed values', () => {
    const container = render({
      $type: 'app.bsky.embed.recordWithMedia#view',
      media: linkCard({ uri: ['https://news.example/'], title: { text: 'x' }, description: 'Only a description.' }),
      record: quote({
        uri: { did: 'did:plc:other' },
        author: { handle: 5, displayName: ['Netflix'] },
        value: { text: 'Still readable.' },
        embeds: [null, 7, 'x', { $type: 'app.bsky.embed.external#view' }, { $type: 'app.bsky.embed.recordWithMedia#view', media: 3 }],
      }),
    });
    expect(container.querySelector('.embed-link-description').textContent).toBe('Only a description.');
    expect(container.querySelector('.embed-quote-text').textContent).toBe('Still readable.');
    expect(container.querySelector('a.embed-link-title')).toBeNull();
    expect(container.querySelector('a.embed-quote-link')).toBeNull();
  });
});

describe('unavailable quoted posts', () => {
  const uri = 'at://did:plc:other/app.bsky.feed.post/gone';
  it.each([
    ['blocked', { $type: 'app.bsky.embed.record#viewBlocked', uri, blocked: true, author: { did: 'did:plc:other' } }, 'Quoted post blocked'],
    ['not found', { $type: 'app.bsky.embed.record#viewNotFound', uri, notFound: true }, 'Quoted post not found'],
    ['detached', { $type: 'app.bsky.embed.record#viewDetached', uri, detached: true }, 'Quoted post removed by its author'],
  ])('shows a notice for a %s quote, alone or next to media', (_kind, record, notice) => {
    const notices = (container) => container.querySelectorAll('.embed-quote').map((node) => [node.className, node.textContent]);
    expect(notices(render(quote(record)))).toEqual([['embed-quote embed-quote-unavailable', notice]]);
    const withMedia = render({ $type: 'app.bsky.embed.recordWithMedia#view', media: newsCard, record: quote(record) });
    expect(withMedia.children.map((node) => node.className)).toEqual(['embed-link', 'embed-quote embed-quote-unavailable']);
    expect(notices(withMedia)).toEqual([['embed-quote embed-quote-unavailable', notice]]);
  });

  it('shows nothing for quoted records that are not posts', () => {
    expect(render(quote({ $type: 'app.bsky.feed.defs#generatorView', uri: 'at://did:plc:other/app.bsky.feed.generator/x' })).children).toEqual([]);
  });
});

describe('embeds in search result cards', () => {
  let elements;
  let search;

  const makePost = (id, text, extra = {}) => {
    const now = new Date().toISOString();
    return {
      uri: `at://did:plc:test/app.bsky.feed.post/${id}`,
      author: { did: 'did:plc:test', handle: 'alice.bsky.social', displayName: 'Alice' },
      record: { text, createdAt: now },
      indexedAt: now,
      likeCount: 50,
      repostCount: 0,
      replyCount: 0,
      ...extra,
    };
  };
  const respondWith = (...pages) => {
    const queue = [...pages];
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => queue.shift() }));
  };
  const renderedPosts = () => elements.results.querySelectorAll('.post');

  beforeEach(async () => {
    vi.resetModules();
    let testDocument;
    ({ document: testDocument, elements } = createTestDocument([
      'terms', 'minLikes', 'timeFilter', 'sortSelect', 'searchBtn', 'status',
      'results', 'expandTermsToggle', 'expandSummary',
    ]));
    vi.stubGlobal('document', testDocument);
    vi.stubGlobal('requestAnimationFrame', (callback) => setTimeout(callback, 0));
    vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
    vi.stubGlobal('window', {
      history: { replaceState: vi.fn() },
      location: { pathname: '/', search: '' },
    });
    search = await import('../src/search.mjs');
    elements.terms.value = 'apple';
    elements.minLikes.value = '0';
    elements.sortSelect.value = 'top';
    elements.timeFilter.value = '24';
    elements.expandTermsToggle.checked = false;
  });

  afterEach(() => {
    search.clearSearchResults();
    vi.restoreAllMocks();
  });

  it('accepts a page with malformed embeds and still renders every post', async () => {
    respondWith({
      posts: [
        makePost('a', 'apple one', { embed: linkCard({ uri: 'javascript:alert(1)', title: 7 }) }),
        makePost('b', 'apple two', { embed: quote({ value: { text: ['x'] }, author: 3, uri: 4, embeds: {} }) }),
        makePost('c', 'apple three', { embed: 'embed' }),
      ],
    });
    await search.performSearch();
    expect(elements.status.style.display).toBe('none');
    expect(renderedPosts()).toHaveLength(3);
    expect(elements.results.querySelectorAll('.embed-link')).toEqual([]);
    expect(elements.results.querySelectorAll('.embed-quote')).toEqual([]);
  });

  it('updates a card when a later page carries a different link card', async () => {
    const staleCard = linkCard({ uri: 'https://news.example/apple', title: 'Apple reports earnings today' });
    respondWith(
      { posts: [makePost('reaction', 'wow', { likeCount: 90, embed: staleCard })], cursor: 'two' },
      { posts: [makePost('other', 'apple pie')], cursor: 'three' },
      { posts: [makePost('reaction', 'wow', { likeCount: 90, embed: newsCard })] },
    );
    await search.performSearch();
    const [before, untouched] = renderedPosts();
    expect(before.querySelector('.embed-link-title').textContent).toBe('Apple reports earnings today');

    await search.loadMore();
    const [after, stillUntouched] = renderedPosts();
    expect(after.querySelector('.embed-link-title').textContent).toBe('Apple beats earnings');
    expect(stillUntouched).toBe(untouched);
  });
});
