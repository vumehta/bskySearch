import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDocument, TestNode } from './helpers/dom.mjs';
import { appendPostEmbeds } from '../src/post-embeds.mjs';
import { TOPIC_LIMITS } from '../src/topic-context.mjs';

const linkCard = (external) => ({ $type: 'app.bsky.embed.external#view', external });
const newsCard = linkCard({
  uri: 'https://www.news.example/apple?ref=feed',
  title: 'Apple beats earnings',
  description: 'A record quarter.',
  thumb: 'https://tracker.example/thumb.jpg',
});
const quotedView = {
  $type: 'app.bsky.embed.record#viewRecord',
  uri: 'at://did:plc:other/app.bsky.feed.post/3kquoted',
  author: { did: 'did:plc:other', handle: 'netflix.com', displayName: 'Netflix', avatar: 'https://tracker.example/a.jpg' },
  value: { text: 'Prices are going up next month.' },
};
const quote = (record) => ({ $type: 'app.bsky.embed.record#view', record });

function render(embed, renderText) {
  const container = new TestNode();
  appendPostEmbeds(container, embed, renderText);
  return container;
}

// [tag.class, text] for an element's children, the shape of a rendered block.
const outline = (node) => node.children.map((child) => [`${child.tagName}.${child.className}`, child.textContent]);
const tagNames = (node) => [node.tagName, ...node.children.flatMap(tagNames)];

beforeEach(() => {
  vi.stubGlobal('document', createTestDocument([]).document);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('link card', () => {
  it('shows the title as a link, the site, and the description', () => {
    const container = render(newsCard);
    expect(outline(container)).toEqual([['div.embed-link', 'Apple beats earningsnews.exampleA record quarter.']]);
    expect(outline(container.children[0])).toEqual([
      ['a.embed-link-title', 'Apple beats earnings'],
      ['div.embed-link-site', 'news.example'],
      ['div.embed-link-description', 'A record quarter.'],
    ]);
    const link = container.querySelector('a.embed-link-title');
    expect(link.href).toBe('https://www.news.example/apple?ref=feed');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
  });

  it('never creates an image, whatever the thumbnail points at', () => {
    const embed = { $type: 'app.bsky.embed.recordWithMedia#view', media: newsCard, record: quote({ ...quotedView, embeds: [newsCard] }) };
    expect(tagNames(render(embed))).not.toContain('img');
  });

  it('names the site after the link itself, not after anything the card claims', () => {
    const container = render(linkCard({ uri: 'https://trusted.example@evil.example/login', title: 'Sign in', site: 'trusted.example' }));
    expect(container.querySelector('.embed-link-site').textContent).toBe('evil.example');
  });

  it('links the site when there is no title', () => {
    const container = render(linkCard({ uri: 'http://news.example/story', description: 'A record quarter.' }));
    expect(outline(container.children[0])).toEqual([
      ['a.embed-link-title', 'news.example'],
      ['div.embed-link-description', 'A record quarter.'],
    ]);
    expect(container.querySelector('a.embed-link-title').href).toBe('http://news.example/story');
  });

  it.each([
    ['a script URL', 'javascript:alert(document.domain)'],
    ['a script URL with a host', 'javascript://news.example/%0Aalert(1)'],
    ['a data URL', 'data:text/html,<script>alert(1)</script>'],
    ['another scheme', 'ftp://files.example/report'],
    ['a relative URL', '/api/classify'],
    ['text', 'not a url'],
    ['a number', 7],
    ['nothing', undefined],
  ])('shows the title without a link or a site for %s', (_kind, uri) => {
    const container = render(linkCard({ uri, title: 'Apple beats earnings' }));
    expect(outline(container.children[0])).toEqual([['span.embed-link-title', 'Apple beats earnings']]);
    expect(tagNames(container)).not.toContain('a');
  });

  it('shows nothing when there is nothing to show', () => {
    expect(render(linkCard({ uri: 'javascript:alert(1)' })).children).toEqual([]);
    expect(render(linkCard({ uri: 'javascript:alert(1)', title: ' \n ', description: 9 })).children).toEqual([]);
  });

  it('flattens whitespace and control characters, and caps what it shows', () => {
    const container = render(linkCard({
      uri: 'https://news.example/',
      title: `Apple\n\n beats\x00\u{9B}earnings ${'x'.repeat(TOPIC_LIMITS.title)}`,
      description: 'one\r\ntwo',
    }));
    const title = container.querySelector('.embed-link-title').textContent;
    expect(title.startsWith('Apple beats earnings x')).toBe(true);
    expect(title).toHaveLength(TOPIC_LIMITS.title);
    expect(container.querySelector('.embed-link-description').textContent).toBe('one two');
  });
});

describe('quoted post', () => {
  it('shows the author, the text, and a link to the post by DID', () => {
    const container = render(quote(quotedView));
    expect(outline(container)).toEqual([['blockquote.embed-quote', 'Netflix@netflix.comView quote \u{2192}Prices are going up next month.']]);
    const [header, text] = container.children[0].children;
    expect(outline(header)).toEqual([
      ['span.embed-quote-name', 'Netflix'],
      ['span.embed-quote-handle', '@netflix.com'],
      ['a.thread-link embed-quote-link', 'View quote \u{2192}'],
    ]);
    expect(outline(container.children[0])[1]).toEqual(['div.embed-quote-text', 'Prices are going up next month.']);
    expect(text.textContent).toBe('Prices are going up next month.');
    const link = container.querySelector('a.embed-quote-link');
    expect(link.href).toBe('https://bsky.app/profile/did:plc:other/post/3kquoted');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
  });

  it('shows the media link card first, and the quoted post with its own link title', () => {
    const container = render({
      $type: 'app.bsky.embed.recordWithMedia#view',
      media: newsCard,
      record: quote({ ...quotedView, embeds: [linkCard({ uri: 'https://blog.example/prices', title: 'New prices', description: 'Not shown.' })] }),
    });
    expect(container.children.map((child) => child.className)).toEqual(['embed-link', 'embed-quote']);
    const nested = container.children[1].querySelector('.embed-link');
    expect(outline(nested)).toEqual([
      ['a.embed-link-title', 'New prices'],
      ['div.embed-link-site', 'blog.example'],
    ]);
  });

  it('falls back to the handle for an author without a display name', () => {
    const container = render(quote({ ...quotedView, author: { handle: 'netflix.com' } }));
    expect(outline(container.children[0].children[0]).slice(0, 2)).toEqual([
      ['span.embed-quote-name', 'netflix.com'],
      ['span.embed-quote-handle', '@netflix.com'],
    ]);
  });

  it.each([
    ['a handle instead of a DID', 'at://netflix.com/app.bsky.feed.post/3kquoted'],
    ['another collection', 'at://did:plc:other/app.bsky.feed.generator/3kquoted'],
    ['a path in the record key', 'at://did:plc:other/app.bsky.feed.post/../../settings'],
    ['a web URL', 'https://evil.example/app.bsky.feed.post/3kquoted'],
    ['a number', 7],
    ['nothing', undefined],
  ])('does not link a quote addressed by %s', (_kind, uri) => {
    const container = render(quote({ ...quotedView, uri }));
    expect(container.querySelector('.embed-quote-text').textContent).toBe('Prices are going up next month.');
    expect(tagNames(container)).not.toContain('a');
  });

  it.each([
    ['blocked', { $type: 'app.bsky.embed.record#viewBlocked', uri: 'at://x', blocked: true }],
    ['deleted', { $type: 'app.bsky.embed.record#viewNotFound', uri: 'at://x', notFound: true }],
    ['detached', { $type: 'app.bsky.embed.record#viewDetached', uri: 'at://x', detached: true }],
    ['a feed', { $type: 'app.bsky.feed.defs#generatorView', displayName: 'A feed' }],
  ])('shows nothing for a quote that is %s', (_kind, record) => {
    expect(render(quote(record)).children).toEqual([]);
  });
});

describe('untrusted embeds', () => {
  it.each([
    ['no embed', undefined],
    ['text', 'embed'],
    ['a list', [newsCard]],
    ['an unknown type', { $type: 'app.bsky.embed.future#view', external: newsCard.external }],
    ['images', { $type: 'app.bsky.embed.images#view', images: [{ thumb: 't', alt: 'A chart' }] }],
    ['a link card that is text', linkCard('nope')],
    ['a link card that is a list', linkCard([newsCard.external])],
    ['a quote that is text', quote('nope')],
    ['a quote whose value is text', quote({ ...quotedView, value: 'text' })],
    ['a quote with media and neither half', { $type: 'app.bsky.embed.recordWithMedia#view' }],
    ['a quote with media made of text', { $type: 'app.bsky.embed.recordWithMedia#view', media: 'x', record: 'y' }],
  ])('renders nothing for %s', (_kind, embed) => {
    expect(render(embed).children).toEqual([]);
  });

  it('keeps the fields that are usable and drops those of the wrong type', () => {
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
    expect(outline(container)).toEqual([
      ['div.embed-link', 'Only a description.'],
      ['blockquote.embed-quote', 'Still readable.'],
    ]);
    expect(outline(container.children[1])).toEqual([['div.embed-quote-text', 'Still readable.']]);

    // A link alone says nothing about the quote, so an otherwise empty block is dropped.
    expect(render(quote({ ...quotedView, author: 'netflix.com', value: { text: 42 }, embeds: 'none' })).children).toEqual([]);
  });

  it('only ever sets embed text as text', () => {
    const markup = '<img src=x onerror=alert(1)>';
    const container = render({
      $type: 'app.bsky.embed.recordWithMedia#view',
      media: linkCard({ uri: 'https://news.example/', title: markup, description: markup }),
      record: quote({ ...quotedView, author: { handle: markup, displayName: markup }, value: { text: markup } }),
    });
    expect(tagNames(container).filter((tag) => !tag.startsWith('#')).sort())
      .toEqual(['a', 'a', 'blockquote', 'div', 'div', 'div', 'div', 'div', 'div', 'span', 'span']);
    expect(container.querySelector('.embed-quote-text').textContent).toBe(markup);
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
  const highlights = (node) => node.querySelectorAll('.highlight').map((span) => span.textContent);

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

  it('explains a reaction post between its text and its stats, highlighting the terms', async () => {
    respondWith({
      posts: [makePost('reaction', 'wow', {
        embed: { $type: 'app.bsky.embed.recordWithMedia#view', media: newsCard, record: quote({ ...quotedView, value: { text: 'Big day for Apple.' } }) },
      })],
    });
    await search.performSearch();

    const [card] = renderedPosts();
    expect(card.children.map((child) => child.className)).toEqual([
      'search-terms', 'post-header', 'post-text', 'embed-link', 'embed-quote', 'post-stats', 'link-actions',
    ]);
    expect(highlights(card.querySelector('.post-text'))).toEqual([]);
    expect(highlights(card.querySelector('.embed-link-title'))).toEqual(['Apple']);
    expect(highlights(card.querySelector('.embed-quote-text'))).toEqual(['Apple']);
    expect(card.querySelector('.embed-link-title').textContent).toBe('Apple beats earnings');
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

  it('rebuilds a card when a later page carries a different link card', async () => {
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
    expect(after).not.toBe(before);
    expect(after.querySelector('.embed-link-title').textContent).toBe('Apple beats earnings');
    expect(stillUntouched).toBe(untouched);
  });
});
