import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDocument, deferred } from './helpers/dom.mjs';

let elements;
let search;
let state;

const uri = (id) => `at://did:plc:test/app.bsky.feed.post/${id}`;

function makePost(id, text, likeCount = 50, extra = {}) {
  const now = new Date().toISOString();
  return {
    uri: uri(id),
    author: { did: 'did:plc:test', handle: 'alice.bsky.social', displayName: 'Alice' },
    record: { text, createdAt: now },
    indexedAt: now,
    likeCount,
    repostCount: 0,
    replyCount: 0,
    ...extra,
  };
}

const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });
const failure = (status, payload) => ({ ok: false, status, json: async () => payload });

// Scores each (post, keyword) pair with `scoreFor`, in the API's response shape.
const scoredBy = (scoreFor) => (body) => ok({
  results: body.items.map((item) => ({
    id: item.id,
    scores: item.keywords.map((keyword) => scoreFor(item, keyword)),
  })),
});

function installFetch({ posts, classify }) {
  const calls = { search: [], classify: [] };
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    if (String(url).startsWith('/api/classify')) {
      const body = JSON.parse(options.body);
      calls.classify.push({ body, options });
      return classify(body, options);
    }
    const params = new URL(url, 'https://example.test').searchParams;
    calls.search.push(params);
    return ok({ posts: typeof posts === 'function' ? posts(params.get('term')) : posts });
  });
  return calls;
}

const visibleUris = () => state.allPosts.map((post) => post.uri);
const renderedPosts = () => elements.results.querySelectorAll('.post');
const summary = () => elements.results.querySelector('.topic-summary');
const summaryText = () => summary().children[0].textContent;
const revealButton = () => summary().children[1];

describe('topic filter', () => {
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
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('window', {
      history: { replaceState: vi.fn() },
      location: { pathname: '/', search: '' },
    });
    search = await import('../src/search.mjs');
    ({ state } = await import('../src/state.mjs'));
    elements.terms.value = 'apple';
    elements.minLikes.value = '0';
    elements.sortSelect.value = 'top';
    elements.timeFilter.value = '24';
    elements.expandTermsToggle.checked = false;
  });

  afterEach(() => {
    search.clearSearchResults();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends nothing to the classifier while it is off', async () => {
    const calls = installFetch({ posts: [makePost('a', 'apple pie recipe')], classify: scoredBy(() => 0) });
    await search.performSearch();
    expect(visibleUris()).toEqual([uri('a')]);
    expect(calls.classify).toHaveLength(0);
    expect(summary().style.display).toBe('none');
  });

  it('shows results first, then hides the posts that score as off-topic', async () => {
    const pending = deferred();
    const calls = installFetch({
      posts: [makePost('company', 'Apple announces a new iPhone', 90), makePost('fruit', 'apple pie recipe', 80)],
      classify: () => pending.promise,
    });
    state.hideOffTopic = true;
    await search.performSearch();

    expect(visibleUris()).toEqual([uri('company'), uri('fruit')]);
    expect(summaryText()).toBe('Checking 2 posts for topic…');
    expect(revealButton().style.display).toBe('none');

    pending.resolve(scoredBy((item) => (item.id === uri('company') ? 0.96 : 0.04))(calls.classify[0].body));
    await vi.waitFor(() => expect(renderedPosts()).toHaveLength(1));
    expect(visibleUris()).toEqual([uri('company')]);
    expect(summaryText()).toBe('1 off-topic post hidden.');
    expect(revealButton().style.display).toBe('');
    expect(revealButton().textContent).toBe('Show them');
    expect(calls.classify).toHaveLength(1);
  });

  it('reveals hidden posts marked as off-topic, and hides them again', async () => {
    installFetch({
      posts: [makePost('company', 'Apple announces a new iPhone', 90), makePost('fruit', 'apple pie recipe', 80)],
      classify: scoredBy((item) => (item.id === uri('company') ? 0.96 : 0.04)),
    });
    state.hideOffTopic = true;
    await search.performSearch();
    await vi.waitFor(() => expect(renderedPosts()).toHaveLength(1));

    revealButton().listeners.get('click')();
    expect(renderedPosts().map((post) => post.className)).toEqual(['post', 'post off-topic']);
    expect(renderedPosts()[1].querySelector('.off-topic-tag').textContent).toBe('Off-topic \xB7 4% match');
    expect(summaryText()).toBe('1 off-topic post shown dimmed.');
    expect(revealButton().textContent).toBe('Hide them again');
    expect(revealButton().getAttribute('aria-pressed')).toBe('true');

    revealButton().listeners.get('click')();
    expect(renderedPosts().map((post) => post.className)).toEqual(['post']);
    expect(revealButton().getAttribute('aria-pressed')).toBe('false');
  });

  it('scores only posts that pass the cheap filters, with their full evidence', async () => {
    const linkCard = {
      $type: 'app.bsky.embed.external#view',
      external: { uri: 'https://news.example/story', title: 'Apple beats earnings', description: 'Record quarter.' },
    };
    const calls = installFetch({
      posts: [makePost('liked', 'wow', 50, { embed: linkCard }), makePost('ignored', 'apple pie recipe', 5)],
      classify: scoredBy(() => 0.9),
    });
    elements.minLikes.value = '30';
    state.hideOffTopic = true;
    await search.performSearch();
    await vi.waitFor(() => expect(calls.classify).toHaveLength(1));

    expect(calls.classify[0].options.method).toBe('POST');
    expect(calls.classify[0].options.headers['Content-Type']).toBe('application/json');
    expect(calls.classify[0].body).toEqual({
      items: [{
        id: uri('liked'),
        keywords: ['apple'],
        context: {
          post_text: 'wow',
          author: 'Alice (@alice.bsky.social)',
          link_card: { title: 'Apple beats earnings', description: 'Record quarter.', site: 'news.example' },
        },
      }],
    });

    // Lowering the filter later scores only the newly visible post.
    elements.minLikes.value = '0';
    search.applyMinLikesFilter();
    await vi.waitFor(() => expect(calls.classify).toHaveLength(2));
    expect(calls.classify[1].body.items.map((item) => item.id)).toEqual([uri('ignored')]);
  });

  it('keeps a post that matched several keywords when any of them is on-topic', async () => {
    const shared = makePost('shared', 'Apple and Meta both report earnings today');
    const calls = installFetch({
      posts: [shared],
      classify: scoredBy((_item, keyword) => (keyword === 'meta' ? 0.92 : 0.1)),
    });
    elements.terms.value = 'apple, meta';
    state.hideOffTopic = true;
    await search.performSearch();
    await vi.waitFor(() => expect(summaryText()).toBe('No off-topic posts found.'));
    expect(calls.classify[0].body.items).toHaveLength(1);
    expect(calls.classify[0].body.items[0].keywords).toEqual(['apple', 'meta']);
    expect(visibleUris()).toEqual([uri('shared')]);
  });

  it('keeps everything visible when the classifier is unavailable', async () => {
    const calls = installFetch({
      posts: [makePost('a', 'apple pie recipe'), makePost('b', 'Apple event recap')],
      classify: () => failure(503, { error: 'The topic filter is not configured on this server.' }),
    });
    state.hideOffTopic = true;
    await search.performSearch();
    await vi.waitFor(() => expect(summaryText()).toContain('unavailable'));
    expect(summaryText()).toBe(
      'Topic filter unavailable: The topic filter is not configured on this server. Unchecked posts stay visible.',
    );
    expect(visibleUris()).toHaveLength(2);

    // It does not keep asking during this search.
    search.applyMinLikesFilter();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.classify).toHaveLength(1);
  });

  it('keeps a post the classifier could not score, and retries it on the next search', async () => {
    let score = null;
    const calls = installFetch({
      posts: [makePost('a', 'apple pie recipe')],
      classify: scoredBy(() => score),
    });
    state.hideOffTopic = true;
    await search.performSearch();
    await vi.waitFor(() => expect(summaryText()).toBe('1 post could not be checked and stays visible.'));
    expect(visibleUris()).toEqual([uri('a')]);

    score = 0.02;
    await search.performSearch();
    await vi.waitFor(() => expect(visibleUris()).toEqual([]));
    expect(calls.classify).toHaveLength(2);
    expect(summaryText()).toBe('1 off-topic post hidden.');
  });

  it('never sends a post that has nothing to judge', async () => {
    const calls = installFetch({
      posts: [makePost('image-only', '', 50, { embed: { $type: 'app.bsky.embed.images#view', images: [{ thumb: 't', alt: '' }] } })],
      classify: scoredBy(() => 0),
    });
    state.hideOffTopic = true;
    await search.performSearch();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.classify).toHaveLength(0);
    expect(visibleUris()).toEqual([uri('image-only')]);
  });

  it('reuses scores on a repeat search, so hidden posts never flash back', async () => {
    const calls = installFetch({
      posts: [makePost('company', 'Apple announces a new iPhone', 90), makePost('fruit', 'apple pie recipe', 80)],
      classify: scoredBy((item) => (item.id === uri('company') ? 0.96 : 0.04)),
    });
    state.hideOffTopic = true;
    await search.performSearch();
    await vi.waitFor(() => expect(visibleUris()).toEqual([uri('company')]));

    await search.performSearch();
    expect(visibleUris()).toEqual([uri('company')]);
    expect(calls.classify).toHaveLength(1);
  });

  it('splits large result sets into bounded batches', async () => {
    const posts = Array.from({ length: 60 }, (_, index) => makePost(`p${index}`, `Apple news ${index}`, 100 - index));
    const calls = installFetch({ posts, classify: scoredBy(() => 0.9) });
    state.hideOffTopic = true;
    await search.performSearch();
    await vi.waitFor(() => expect(calls.classify).toHaveLength(3));
    expect(calls.classify.map(({ body }) => body.items.length)).toEqual([25, 25, 10]);
    // The most prominent posts are judged first.
    expect(calls.classify[0].body.items[0].id).toBe(uri('p0'));
    await vi.waitFor(() => expect(summaryText()).toBe('No off-topic posts found.'));
  });

  it('switches on for loaded posts without searching again, and records it in the URL', async () => {
    const calls = installFetch({
      posts: [makePost('company', 'Apple announces a new iPhone', 90), makePost('fruit', 'apple pie recipe', 80)],
      classify: scoredBy((item) => (item.id === uri('company') ? 0.96 : 0.04)),
    });
    await search.performSearch();
    expect(calls.search).toHaveLength(1);

    search.applyTopicFilterChange(true);
    await vi.waitFor(() => expect(visibleUris()).toEqual([uri('company')]));
    expect(calls.search).toHaveLength(1);
    expect(window.history.replaceState.mock.calls.at(-1)[2]).toContain('topic=1');

    search.applyTopicFilterChange(false);
    expect(visibleUris()).toEqual([uri('company'), uri('fruit')]);
    expect(summary().style.display).toBe('none');
    expect(window.history.replaceState.mock.calls.at(-1)[2]).not.toContain('topic=');
  });

  it('abandons scoring when a new search replaces the old one', async () => {
    const pending = deferred();
    const signals = [];
    installFetch({
      posts: (term) => [makePost(term, `${term} news`)],
      classify: (_body, options) => {
        signals.push(options.signal);
        return signals.length === 1 ? pending.promise : scoredBy(() => 0.9)(_body);
      },
    });
    state.hideOffTopic = true;
    await search.performSearch();
    await vi.waitFor(() => expect(signals).toHaveLength(1));

    elements.terms.value = 'netflix';
    await search.performSearch();
    expect(signals[0].aborted).toBe(true);
    await vi.waitFor(() => expect(summaryText()).toBe('No off-topic posts found.'));
    expect(visibleUris()).toEqual([uri('netflix')]);

    // A late answer for the old search changes nothing.
    pending.resolve(ok({ results: [{ id: uri('apple'), scores: [0] }] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(visibleUris()).toEqual([uri('netflix')]);
  });
});
