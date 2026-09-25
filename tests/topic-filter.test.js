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
    calls.search.push(params.get('term'));
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
    state.rawSearchTerms = ['apple'];
    elements.minLikes.value = '0';
    elements.sortSelect.value = 'top';
    elements.timeFilter.value = '24';
    elements.expandTermsToggle.checked = false;
  });

  afterEach(() => {
    search.clearSearchResults();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
    expect(elements.results.querySelectorAll('.topic-score-tag')).toHaveLength(0);

    pending.resolve(scoredBy((item) => (item.id === uri('company') ? 0.96 : 0.04))(calls.classify[0].body));
    await vi.waitFor(() => expect(renderedPosts()).toHaveLength(1));
    expect(visibleUris()).toEqual([uri('company')]);
    expect(summaryText()).toBe('1 off-topic post hidden.');
    expect(revealButton().style.display).toBe('');
    expect(revealButton().textContent).toBe('Show them');
    expect(renderedPosts()[0].querySelector('.topic-score-tag').textContent).toBe('96% match');
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
    expect(renderedPosts()[0].querySelector('.topic-score-tag').textContent).toBe('96% match');
    expect(renderedPosts()[0].querySelector('.off-topic-tag')).toBeNull();
    expect(summaryText()).toBe('1 off-topic post shown dimmed.');
    expect(revealButton().textContent).toBe('Hide them again');
    expect(revealButton().getAttribute('aria-pressed')).toBe('true');

    revealButton().listeners.get('click')();
    expect(renderedPosts().map((post) => post.className)).toEqual(['post']);
    expect(renderedPosts()[0].querySelector('.topic-score-tag').textContent).toBe('96% match');
    expect(revealButton().getAttribute('aria-pressed')).toBe('false');
  });

  it.each(['loading', 'open'])('preserves image previews and %s threads when scores arrive', async (threadState) => {
    const pendingScore = deferred();
    const pendingThread = deferred();
    const post = makePost('reply', 'Apple announces a new iPhone');
    post.record.reply = { parent: { uri: uri('parent') }, root: { uri: uri('parent') } };
    post.embed = {
      $type: 'app.bsky.embed.images#view',
      images: [{ thumb: 'https://cdn.bsky.app/image.jpg', alt: 'iPhone' }],
    };
    const calls = installFetch({ posts: [post], classify: () => pendingScore.promise });
    const fetchSearch = globalThis.fetch;
    let threadSignal;
    globalThis.fetch = vi.fn((url, options) => {
      if (String(url).includes('getPostThread')) {
        threadSignal = options.signal;
        return pendingThread.promise;
      }
      return fetchSearch(url, options);
    });
    state.hideOffTopic = true;
    await search.performSearch();
    const card = renderedPosts()[0];
    card.querySelector('.image-placeholder').children[0].listeners.get('click')();
    const preview = card.querySelector('.post-images');
    const threadButton = card.querySelector('button.thread-link');
    const loading = threadButton.listeners.get('click')();
    const threadResponse = ok({ thread: { parent: { post: makePost('parent', 'Apple news') } } });
    if (threadState === 'open') {
      pendingThread.resolve(threadResponse);
      await loading;
    }
    const context = card.querySelector('.thread-context');

    pendingScore.resolve(scoredBy(() => 0.96)(calls.classify[0].body));
    await vi.waitFor(() => expect(renderedPosts()[0].querySelector('.topic-score-tag')?.textContent).toBe('96% match'));
    expect(renderedPosts()[0]).toBe(card);
    expect(card.querySelector('.post-images')).toBe(preview);
    expect(threadSignal.aborted).toBe(false);
    if (threadState === 'loading') {
      expect(threadButton.getAttribute('aria-busy')).toBe('true');
      pendingThread.resolve(threadResponse);
      await loading;
    } else {
      expect(card.querySelector('.thread-context')).toBe(context);
    }
    expect(threadButton.getAttribute('aria-expanded')).toBe('true');

    search.applyTopicFilterChange(false);
    await vi.waitFor(() => expect(card.querySelector('.topic-score-tag')).toBeNull());
    expect(renderedPosts()[0]).toBe(card);
    expect(card.querySelector('.post-images')).toBe(preview);
    expect(threadButton.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows scores without a reveal button when nothing was hidden', async () => {
    installFetch({
      posts: [makePost('company', 'Apple announces a new iPhone', 90)],
      classify: scoredBy(() => 0.71),
    });
    state.hideOffTopic = true;
    await search.performSearch();
    await vi.waitFor(() => expect(summaryText()).toBe('No off-topic posts found.'));
    expect(revealButton().style.display).toBe('none');
    expect(renderedPosts()[0].querySelector('.topic-score-tag').textContent).toBe('71% match');

    search.applyTopicFilterChange(false);
    await vi.waitFor(() => expect(renderedPosts()[0].querySelector('.topic-score-tag')).toBeNull());
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
          link_card: { title: 'Apple beats earnings', description: 'Record quarter.', site: 'news.example', path: '/story' },
        },
      }],
    });

    elements.minLikes.value = '0';
    search.applyMinLikesFilter();
    await vi.waitFor(() => expect(calls.classify).toHaveLength(2));
    expect(calls.classify[1].body.items.map((item) => item.id)).toEqual([uri('ignored')]);
  });

  it('keeps a post when any original search term is on-topic, regardless of which query found it', async () => {
    const shared = makePost('shared', 'Apple and Meta both report earnings today');
    const calls = installFetch({
      posts: (term) => term === 'apple' ? [shared] : [],
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

  it('uses only original phrases when scoring expanded matches', async () => {
    const postsByTerm = {
      Electric: [makePost('ge', 'GE wins an electric turbine contract')],
      General: [makePost('gm', 'GM announces its quarterly results'), makePost('other', 'A general update')],
    };
    const calls = installFetch({
      posts: (term) => postsByTerm[term] || [],
      classify: scoredBy((item, keyword) => (
        (item.id === uri('ge') && keyword === 'General Electric') ||
        (item.id === uri('gm') && keyword === 'General Motors')
      ) ? 0.95 : 0.05),
    });
    elements.terms.value = 'General Electric, General Motors, general electric';
    elements.expandTermsToggle.checked = true;
    state.hideOffTopic = true;
    await search.performSearch();
    expect(calls.search).toEqual(['General Electric', 'General', 'Electric', 'General Motors', 'Motors']);
    expect(calls.classify.flatMap(({ body }) => body.items.map((item) => item.keywords)))
      .toEqual(Array.from({ length: 3 }, () => ['General Electric', 'General Motors']));
    await vi.waitFor(() => expect(summaryText()).toBe('1 off-topic post hidden.'));
    expect(visibleUris().sort()).toEqual([uri('ge'), uri('gm')]);

    elements.terms.value = 'Apple';
    search.applyTopicFilterChange(false);
    search.applyTopicFilterChange(true);
    expect(visibleUris().sort()).toEqual([uri('ge'), uri('gm')]);
    expect(calls.classify).toHaveLength(1);
  });

  it('rechecks a post when original phrases change even if the expanded match is unchanged', async () => {
    const shared = makePost('ge', 'GE updates its general earnings guidance');
    const calls = installFetch({
      posts: (term) => term === 'General' ? [shared] : [],
      classify: scoredBy((_item, keyword) => keyword === 'General Electric' ? 0.95 : 0.05),
    });
    elements.terms.value = 'General Electric';
    elements.expandTermsToggle.checked = true;
    state.hideOffTopic = true;
    await search.performSearch();
    await vi.waitFor(() => expect(summaryText()).toBe('No off-topic posts found.'));
    expect(visibleUris()).toEqual([uri('ge')]);

    elements.terms.value = 'General Motors';
    await search.performSearch();
    await vi.waitFor(() => expect(summaryText()).toBe('1 off-topic post hidden.'));
    expect(visibleUris()).toEqual([]);
    expect(calls.classify.map(({ body }) => body.items[0].keywords))
      .toEqual([['General Electric'], ['General Motors']]);
  });

  it('lets in-flight topic batches finish when minimum likes rises and drops queued posts that no longer qualify', async () => {
    const posts = Array.from({ length: 100 }, (_, index) => makePost(`p${index}`, 'Apple news', 100 - index));
    const pending = [deferred(), deferred()];
    let attempt = 0;
    const calls = installFetch({
      posts,
      classify: (body) => pending[attempt++]?.promise || scoredBy(() => 0.9)(body),
    });
    state.hideOffTopic = true;
    await search.performSearch();
    expect(calls.classify).toHaveLength(2);
    expect(summaryText()).toBe('Checking 100 posts for topic…');

    search.applyMinLikesFilter();
    elements.minLikes.value = '99';
    search.applyMinLikesFilter();
    expect(calls.classify.every(({ options }) => !options.signal.aborted)).toBe(true);
    expect(visibleUris()).toEqual([uri('p0'), uri('p1')]);
    expect(summaryText()).toBe('Checking 2 posts for topic…');

    pending.forEach((response, index) => response.resolve(scoredBy(() => 0.9)(calls.classify[index].body)));
    await vi.waitFor(() => expect(summaryText()).toBe('No off-topic posts found.'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.classify).toHaveLength(2);
    expect(visibleUris()).toEqual([uri('p0'), uri('p1')]);

    elements.minLikes.value = '50';
    search.applyMinLikesFilter();
    await vi.waitFor(() => expect(summaryText()).toBe('No off-topic posts found.'));
    expect(calls.classify).toHaveLength(3);
    expect(calls.classify[2].body.items.map((item) => item.id)).toEqual([uri('p50')]);
    expect(visibleUris()).toHaveLength(51);
  });

  it('asks again for every keyword of a dropped post once it qualifies again', async () => {
    const posts = Array.from({ length: 100 }, (_, index) => makePost(`p${index}`, 'Apple and Meta news', 100 - index));
    const pending = [deferred(), deferred()];
    let attempt = 0;
    const calls = installFetch({
      posts,
      classify: (body) => pending[attempt++]?.promise || scoredBy(() => 0.9)(body),
    });
    elements.terms.value = 'apple, meta';
    state.hideOffTopic = true;
    await search.performSearch();
    expect(calls.classify).toHaveLength(2);
    expect(calls.classify[0].body.items[0].keywords).toEqual(['apple', 'meta']);

    elements.minLikes.value = '99';
    search.applyMinLikesFilter();
    pending.forEach((response, index) => response.resolve(scoredBy(() => 0.9)(calls.classify[index].body)));
    await vi.waitFor(() => expect(summaryText()).toBe('No off-topic posts found.'));

    elements.minLikes.value = '50';
    search.applyMinLikesFilter();
    await vi.waitFor(() => expect(summaryText()).toBe('No off-topic posts found.'));
    expect(calls.classify).toHaveLength(3);
    expect(calls.classify[2].body.items).toEqual([
      expect.objectContaining({ id: uri('p50'), keywords: ['apple', 'meta'] }),
    ]);
  });

  it('keeps everything visible when the classifier is not configured', async () => {
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

    elements.minLikes.value = '40';
    search.applyMinLikesFilter();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.classify).toHaveLength(1);
  });

  const rateLimited = (retryAfter) => ({
    ok: false,
    status: 429,
    headers: new Headers(retryAfter ? { 'Retry-After': retryAfter } : {}),
    json: async () => ({ error: 'Too many topic checks. Please try again shortly.' }),
  });

  it('waits out a rate limit and then sends the checks it held back', async () => {
    vi.useFakeTimers();
    let limited = true;
    const calls = installFetch({
      posts: [makePost('company', 'Apple announces a new iPhone', 90), makePost('fruit', 'apple pie recipe', 80)],
      classify: (body) => (limited
        ? rateLimited('3')
        : scoredBy((item) => (item.id === uri('company') ? 0.96 : 0.04))(body)),
    });
    state.hideOffTopic = true;
    await search.performSearch();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.classify).toHaveLength(1);
    expect(summaryText()).toBe('Checking 2 posts for topic… Pausing briefly to stay within the topic check rate limit.');
    expect(visibleUris()).toHaveLength(2);

    limited = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.classify).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.classify).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(visibleUris()).toEqual([uri('company')]);
    expect(summaryText()).toBe('1 off-topic post hidden.');
  });

  it('starts a new search without waiting out the last search\'s rate limit', async () => {
    vi.useFakeTimers();
    let limited = true;
    const calls = installFetch({
      posts: [makePost('company', 'Apple announces a new iPhone', 90)],
      classify: (body) => (limited ? rateLimited('60') : scoredBy(() => 0.96)(body)),
    });
    state.hideOffTopic = true;
    await search.performSearch();
    await vi.advanceTimersByTimeAsync(500);
    expect(summaryText()).toContain('Pausing briefly');

    limited = false;
    await search.performSearch();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.classify).toHaveLength(2);
    expect(summaryText()).toBe('No off-topic posts found.');
  });

  it('stops a batch still in flight from retrying once repeated rate limits have turned the filter off', async () => {
    vi.useFakeTimers();
    const pages = {
      '': { posts: Array.from({ length: 25 }, (_, index) => makePost(`first${index}`, 'Apple news', 90)), cursor: 'c1' },
      c1: { posts: [], cursor: 'c2' },
      c2: { posts: Array.from({ length: 25 }, (_, index) => makePost(`late${index}`, 'Apple news', 80)) },
    };
    const late = deferred();
    const classified = [];
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      if (String(url).startsWith('/api/classify')) {
        const [{ id }] = JSON.parse(options.body).items;
        classified.push(id);
        return id === uri('first0') ? rateLimited() : late.promise;
      }
      return ok(pages[new URL(url, 'https://example.test').searchParams.get('cursor') || '']);
    });
    state.hideOffTopic = true;
    await search.performSearch();
    await vi.advanceTimersByTimeAsync(4 * 60000 + 500);
    expect(classified).toEqual(Array(5).fill(uri('first0')));

    await search.loadMore();
    await vi.advanceTimersByTimeAsync(60000);
    expect(classified.slice(5)).toEqual([uri('first0'), uri('late0')]);
    expect(summaryText()).toContain('Topic filter unavailable');

    late.resolve(rateLimited());
    await vi.advanceTimersByTimeAsync(3 * 60000);
    expect(classified).toHaveLength(7);
    expect(summaryText()).toBe(
      'Topic filter unavailable: Too many topic checks. Try again in a minute. Unchecked posts stay visible.',
    );
  });

  it('turns the filter off after repeated rate limits and keeps unchecked posts visible', async () => {
    vi.useFakeTimers();
    const calls = installFetch({
      posts: [makePost('a', 'apple pie recipe'), makePost('b', 'Apple event recap')],
      classify: () => rateLimited(),
    });
    state.hideOffTopic = true;
    await search.performSearch();
    await vi.advanceTimersByTimeAsync(4 * 60000);
    expect(calls.classify).toHaveLength(5);
    expect(summaryText()).toContain('Pausing briefly');
    await vi.advanceTimersByTimeAsync(60000 + 500);
    expect(calls.classify).toHaveLength(6);
    expect(summaryText()).toBe(
      'Topic filter unavailable: Too many topic checks. Try again in a minute. Unchecked posts stay visible.',
    );
    expect(visibleUris()).toHaveLength(2);

    elements.minLikes.value = '40';
    search.applyMinLikesFilter();
    await vi.advanceTimersByTimeAsync(120000);
    expect(calls.classify).toHaveLength(6);
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

  it('scales the cutoff down with likes to a floor, except for adult content', async () => {
    const { getReachThreshold } = await import('../src/topic-filter.mjs');
    const at = (likeCount, extra) => getReachThreshold(makePost('p', 'Apple', likeCount, extra));
    expect(at(0)).toBe(0.3);
    expect(at(50)).toBe(0.3);
    expect(at(500)).toBeCloseTo(0.2);
    expect(at(5000)).toBeCloseTo(0.1);
    expect(at(1_000_000)).toBe(0.1);
    expect(at(5000, { labels: [{ src: 'did:plc:labeler', val: 'porn' }] })).toBe(0.3);
    expect(at(5000, { labels: [{ src: 'did:plc:labeler', val: 'porn', neg: true }] })).toBeCloseTo(0.1);
  });

  it('keeps borderline popular posts but never rescues a clearly off-topic one with likes', async () => {
    const scoresById = { 'viral-weak': 0.12, 'popular-weak': 0.12, 'popular-borderline': 0.22, 'viral-off': 0.05 };
    installFetch({
      posts: [
        makePost('viral-weak', 'Cancel Apple, they only care about money', 5000),
        makePost('popular-weak', 'Apple is so overrated', 500),
        makePost('popular-borderline', 'My Apple laptop fan is so loud', 500),
        makePost('viral-off', 'Young people spend too much on Apple gadgets and lattes, say the Tories', 5000),
      ],
      classify: scoredBy((item) => scoresById[item.id.split('/').pop()]),
    });
    state.hideOffTopic = true;
    await search.performSearch();
    await vi.waitFor(() => expect(summaryText()).toBe('2 off-topic posts hidden.'));
    expect(visibleUris().sort()).toEqual([uri('popular-borderline'), uri('viral-weak')]);
    const tags = Array.from(elements.results.querySelectorAll('.topic-score-tag'), (tag) => tag.textContent);
    expect(tags.sort()).toEqual(['High reach \xB7 12% match', 'High reach \xB7 22% match']);
  });

  it('applies the lower cutoff as likes grow, without checking the post again', async () => {
    const { getTopicVerdict, requestTopicScores } = await import('../src/topic-filter.mjs');
    const post = makePost('growing', 'Apple is so overrated', 49, { matchedTerms: ['apple'] });
    const calls = installFetch({ posts: [], classify: scoredBy(() => 0.2) });
    requestTopicScores([post], () => {});
    await vi.waitFor(() => expect(getTopicVerdict(post)).toEqual({ verdict: 'off', score: 0.2 }));

    const popular = { ...post, likeCount: 5000 };
    requestTopicScores([popular], () => {});
    expect(getTopicVerdict(popular)).toEqual({ verdict: 'on', score: 0.2, keptFor: 'High reach' });
    expect(calls.classify).toHaveLength(1);
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

  it('rechecks changed evidence but reuses a score after engagement-only updates', async () => {
    const { getTopicVerdict, requestTopicScores } = await import('../src/topic-filter.mjs');
    const oldPost = makePost('updated', 'wow', 50, {
      matchedTerms: ['apple'],
      embed: { $type: 'app.bsky.embed.external#view', external: { title: 'Fresh apple pie' } },
    });
    const calls = installFetch({
      posts: [],
      classify: scoredBy((item) => item.context.link_card.title.includes('iPhone') ? 0.95 : 0.05),
    });
    requestTopicScores([oldPost], () => {});
    await vi.waitFor(() => expect(getTopicVerdict(oldPost)).toEqual({ verdict: 'off', score: 0.05 }));

    const popular = { ...oldPost, likeCount: 500 };
    requestTopicScores([popular], () => {});
    expect(getTopicVerdict(popular)).toEqual({ verdict: 'off', score: 0.05 });
    expect(calls.classify).toHaveLength(1);

    const updated = {
      ...oldPost,
      embed: { $type: 'app.bsky.embed.external#view', external: { title: 'Apple unveils a new iPhone' } },
    };
    expect(getTopicVerdict(updated)).toEqual({ verdict: 'unknown', score: null });
    requestTopicScores([updated], () => {});
    await vi.waitFor(() => expect(getTopicVerdict(updated)).toEqual({ verdict: 'on', score: 0.95 }));
    expect(calls.classify).toHaveLength(2);
    expect(getTopicVerdict(oldPost)).toEqual({ verdict: 'off', score: 0.05 });
  });

  it.each(['old first', 'new first'])('isolates in-flight scores for changed evidence: %s', async (order) => {
    const { getTopicProgress, getTopicVerdict, requestTopicScores } = await import('../src/topic-filter.mjs');
    const oldPost = makePost('updated', 'apple pie', 50, { matchedTerms: ['apple'] });
    const updated = { ...oldPost, record: { ...oldPost.record, text: 'Apple iPhone launch' } };
    const responses = [deferred(), deferred()];
    let index = 0;
    const calls = installFetch({ posts: [], classify: () => responses[index++].promise });
    const onUpdate = vi.fn();
    requestTopicScores([oldPost], onUpdate);
    requestTopicScores([updated], onUpdate);
    expect(calls.classify).toHaveLength(2);
    let finished = 0;
    const finish = async (position, score) => {
      responses[position].resolve(scoredBy(() => score)(calls.classify[position].body));
      finished += 1;
      await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(finished));
    };
    if (order === 'old first') {
      await finish(0, 0.05);
      expect(getTopicVerdict(updated)).toEqual({ verdict: 'unknown', score: null });
      expect(getTopicProgress([updated]).pending).toBe(1);
      await finish(1, 0.95);
    } else {
      await finish(1, 0.95);
      expect(getTopicProgress([updated]).pending).toBe(0);
      await finish(0, 0.05);
    }
    expect(getTopicVerdict(updated)).toEqual({ verdict: 'on', score: 0.95 });
    expect(getTopicProgress([updated])).toMatchObject({ pending: 0, failed: 0 });
  });

  it.each(['failed score', 'missing evidence'])('retries changed evidence after %s in the same search', async (kind) => {
    const { getTopicProgress, getTopicVerdict, requestTopicScores } = await import('../src/topic-filter.mjs');
    const oldPost = makePost('updated', kind === 'missing evidence' ? '' : 'wow', 50, { matchedTerms: ['apple'] });
    const updated = { ...oldPost, record: { ...oldPost.record, text: 'Apple iPhone launch' } };
    installFetch({ posts: [], classify: scoredBy((item) => item.context.post_text.includes('iPhone') ? 0.95 : null) });
    requestTopicScores([oldPost], () => {});
    await vi.waitFor(() => expect(getTopicProgress([oldPost]).failed).toBe(1));
    requestTopicScores([updated], () => {});
    await vi.waitFor(() => expect(getTopicVerdict(updated)).toEqual({ verdict: 'on', score: 0.95 }));
    expect(getTopicProgress([updated])).toMatchObject({ pending: 0, failed: 0 });
  });

  it.each([[0.95, 'on'], [0.05, 'off'], [null, 'unknown']])(
    'waits for every original keyword, including the seventh (%s -> %s)',
    async (lastScore, verdict) => {
      const { getTopicProgress, getTopicVerdict, requestTopicScores } = await import('../src/topic-filter.mjs');
      const keywords = ['meta', 'gap', 'target', 'shell', 'block', 'square', 'apple'];
      state.rawSearchTerms = keywords;
      const shared = makePost('seven', 'Apple makes an iPhone', 50, { matchedTerms: keywords });
      const last = deferred();
      const calls = installFetch({
        posts: [],
        classify: (body) => body.items[0].keywords.includes('apple') ? last.promise : scoredBy(() => 0.05)(body),
      });
      const onUpdate = vi.fn();
      requestTopicScores([shared], onUpdate);
      await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
      expect(calls.classify).toHaveLength(2);
      expect(calls.classify.flatMap(({ body }) => body.items.flatMap((item) => item.keywords))).toEqual(keywords);
      expect(getTopicVerdict(shared)).toEqual({ verdict: 'unknown', score: 0.05 });
      expect(getTopicProgress([shared]).pending).toBe(1);
      last.resolve(scoredBy(() => lastScore)(calls.classify[1].body));
      await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
      expect(getTopicVerdict(shared).verdict).toBe(verdict);
      expect(getTopicProgress([shared]).pending).toBe(0);
    },
  );

  it('bounds both dimensions of a large keyword and post batch without mixing scores', async () => {
    const { getTopicVerdict, requestTopicScores } = await import('../src/topic-filter.mjs');
    const keywords = Array.from({ length: 13 }, (_, index) => 'brand' + index);
    state.rawSearchTerms = keywords;
    const posts = Array.from({ length: 27 }, (_, index) => makePost('p' + index, 'Company news', 50, { matchedTerms: keywords }));
    const calls = installFetch({
      posts: [],
      classify: scoredBy((item, keyword) => item.id === uri('p26') && keyword === 'brand12' ? 0.95 : 0.05),
    });
    const onUpdate = vi.fn();
    requestTopicScores(posts, onUpdate);
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(6));
    for (const { body } of calls.classify) {
      expect(body.items.length).toBeLessThanOrEqual(25);
      expect(new Set(body.items.map((item) => item.id)).size).toBe(body.items.length);
      expect(body.items.every((item) => item.keywords.length <= 6)).toBe(true);
    }
    for (const candidate of posts) {
      const sent = calls.classify.flatMap(({ body }) => body.items.filter((item) => item.id === candidate.uri).flatMap((item) => item.keywords));
      expect(sent).toEqual(keywords);
      expect(getTopicVerdict(candidate).verdict).toBe(candidate.uri === uri('p26') ? 'on' : 'off');
    }
    requestTopicScores(posts, onUpdate);
    expect(calls.classify).toHaveLength(6);
  });

  it('keeps active scores beyond the carry-over cache limit without repeated classification', async () => {
    const { getTopicProgress, getTopicVerdict, requestTopicScores, resetTopicScoring } = await import('../src/topic-filter.mjs');
    const { MAX_TOPIC_SCORE_CACHE_SIZE } = await import('../src/constants.mjs');
    const keywords = Array.from({ length: 26 }, (_, index) => 'brand' + index);
    state.rawSearchTerms = keywords;
    const posts = Array.from({ length: 200 }, (_, index) => makePost('p' + index, 'Company news', 50, { matchedTerms: keywords }));
    const calls = installFetch({ posts: [], classify: scoredBy(() => 0.05) });
    const checkAll = async () => {
      requestTopicScores(posts, () => {});
      await vi.waitFor(() => expect(getTopicProgress(posts).pending).toBe(0));
      expect(posts.every((post) => getTopicVerdict(post).verdict === 'off')).toBe(true);
    };
    await checkAll();
    const firstPass = calls.classify.length;
    for (let rebuild = 0; rebuild < 3; rebuild += 1) await checkAll();
    expect(calls.classify).toHaveLength(firstPass);

    resetTopicScoring();
    await checkAll();
    const rescoredPairs = calls.classify.slice(firstPass)
      .flatMap(({ body }) => body.items).reduce((count, item) => count + item.keywords.length, 0);
    expect(rescoredPairs).toBe(posts.length * keywords.length - MAX_TOPIC_SCORE_CACHE_SIZE);
    const secondPass = calls.classify.length;
    await checkAll();
    expect(calls.classify).toHaveLength(secondPass);
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

    pending.resolve(ok({ results: [{ id: uri('apple'), scores: [0] }] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(visibleUris()).toEqual([uri('netflix')]);
  });
});
