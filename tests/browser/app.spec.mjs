import { test, expect } from '@playwright/test';

const did = 'did:plc:browserfixture';
const originalUri = `at://${did}/app.bsky.feed.post/original`;
const browserErrors = new WeakMap();

function post(id, text, likes, ageHours = 0) {
  const createdAt = new Date(Date.now() - ageHours * 3600000).toISOString();
  return {
    uri: `at://${did}/app.bsky.feed.post/${id}`,
    author: { did, handle: 'alice.bsky.social', displayName: 'Alice' },
    record: { text, createdAt },
    indexedAt: createdAt,
    likeCount: likes,
    repostCount: 0,
    replyCount: 0,
  };
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) errors.push(message.text());
  });
  page.on('requestfailed', (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  // Any request not explicitly covered by a fixture must remain local.
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
    return route.abort();
  });
  browserErrors.set(page, errors);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page), 'The built page should have no runtime, console, or network errors').toEqual([]);
});

test('built page loads and minimum likes preserves loaded pages and pagination', async ({ page }, testInfo) => {
  const cursors = [];
  const pages = {
    first: { posts: [post('first', 'apple first page', 20)], cursor: 'second' },
    second: { posts: [post('second', 'apple second page', 60)], cursor: 'third' },
    third: { posts: [post('third', 'apple third page', 100)], cursor: 'fourth' },
    fourth: { posts: [post('fourth', 'apple fourth page', 80)] },
  };
  await page.route('**/api/search?**', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    expect(params.get('term')).toBe('apple');
    const cursor = params.get('cursor') || 'first';
    cursors.push(cursor);
    expect(pages[cursor], 'Search must request a known continuation cursor').toBeDefined();
    await route.fulfill({ json: pages[cursor] });
  });

  await page.goto('/');
  await expect(page).toHaveURL(/\/$/);
  await expect(page).toHaveTitle('Bluesky Term Search');
  await expect(page.getByRole('heading', { name: 'Bluesky Term Search', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Quote Finder', exact: true })).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('max-width', '800px');
  await page.screenshot({ path: testInfo.outputPath('initial.png'), fullPage: true });

  await page.getByLabel('Search Terms (comma-separated)', { exact: true }).fill('apple');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('#results .post')).toHaveCount(2);
  await page.getByRole('button', { name: 'Load More Results', exact: true }).click();
  await expect(page.locator('#results .post')).toHaveCount(3);

  await page.getByLabel('Min. Likes', { exact: true }).fill('70');
  await expect(page.locator('#results .post-text')).toHaveText(['apple third page']);
  await page.getByLabel('Min. Likes', { exact: true }).fill('0');
  await expect(page.locator('#results .post')).toHaveCount(3);
  expect(cursors).toEqual(['first', 'second', 'third']);
  await page.getByRole('button', { name: 'Load More Results', exact: true }).click();
  await expect(page.locator('#results .post')).toHaveCount(4);
  expect(cursors).toEqual(['first', 'second', 'third', 'fourth']);
  await expect(page.getByRole('button', { name: 'Load More Results', exact: true })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('search.png'), fullPage: true });
});

test('normal handle URL submits the quote form and all sort controls reorder real cards', async ({ page }, testInfo) => {
  const calls = [];
  const quotes = [
    { ...post('newest', 'Newest quote', 10, 1), bookmarkCount: 5 },
    { ...post('oldest', 'Oldest quote', 30, 3), bookmarkCount: 3 },
    post('popular', 'Popular quote', 90, 2),
  ];
  await page.route('https://public.api.bsky.app/xrpc/**', async (route) => {
    const url = new URL(route.request().url());
    const fulfill = (json) => route.fulfill({ json, headers: { 'Access-Control-Allow-Origin': '*' } });
    calls.push(url.pathname.split('/').at(-1));
    switch (url.pathname) {
      case '/xrpc/app.bsky.actor.getProfile':
        expect(url.searchParams.get('actor')).toBe('alice.bsky.social');
        return fulfill({ did });
      case '/xrpc/app.bsky.feed.getPosts':
        expect(url.searchParams.get('uris')).toBe(originalUri);
        return fulfill({ posts: [{ ...post('original', 'Original post', 5), quoteCount: 3 }] });
      case '/xrpc/app.bsky.feed.getQuotes':
        expect(url.searchParams.get('uri')).toBe(originalUri);
        return fulfill({ posts: quotes });
      default:
        throw new Error(`Unexpected quote API request: ${url}`);
    }
  });

  await page.goto('/');
  await page.getByLabel('Bluesky Post URL', { exact: true }).fill('https://bsky.app/profile/alice.bsky.social/post/original');
  await page.getByRole('button', { name: 'Find Quotes', exact: true }).click();
  await expect(page.locator('#quoteOriginal .quote-text')).toHaveText('Original post');
  await expect(page.locator('#quoteCount')).toHaveText('Loaded 3 of 3 quotes');
  const texts = page.locator('#quoteResults .quote-text');
  await expect(texts).toHaveText(['Popular quote', 'Oldest quote', 'Newest quote']);
  await page.getByRole('button', { name: 'Most Recent', exact: true }).click();
  await expect(texts).toHaveText(['Newest quote', 'Popular quote', 'Oldest quote']);
  await expect(page.getByRole('button', { name: 'Most Recent', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Oldest First', exact: true }).click();
  await expect(texts).toHaveText(['Oldest quote', 'Popular quote', 'Newest quote']);
  await page.getByRole('button', { name: 'Most Saved', exact: true }).click();
  await expect(texts).toHaveText(['Newest quote', 'Oldest quote', 'Popular quote']);
  await page.getByRole('button', { name: 'Most Likes', exact: true }).click();
  await expect(texts).toHaveText(['Popular quote', 'Oldest quote', 'Newest quote']);
  expect(calls.sort()).toEqual(['app.bsky.actor.getProfile', 'app.bsky.feed.getPosts', 'app.bsky.feed.getQuotes']);
  await expect(page.locator('#quoteStatus')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('quotes.png'), fullPage: true });
});

test('topic filter hides off-topic posts, reveals them on request, and survives a reload', async ({ page }, testInfo) => {
  const posts = [
    post('company', 'Apple unveils a new iPhone', 90),
    post('fruit', 'My apple pie recipe', 80),
    {
      ...post('reaction', 'wow', 70),
      embed: {
        $type: 'app.bsky.embed.external#view',
        external: { uri: 'https://news.example/apple', title: 'Apple beats earnings', description: 'A record quarter.' },
      },
    },
  ];
  const classified = [];
  await page.route('**/api/search?**', (route) => route.fulfill({ json: { posts } }));
  await page.route('**/api/classify', async (route) => {
    const request = route.request();
    expect(request.method()).toBe('POST');
    expect(request.headers()['content-type']).toBe('application/json');
    const { items } = request.postDataJSON();
    classified.push(...items);
    await route.fulfill({
      json: {
        results: items.map((item) => ({
          id: item.id,
          scores: item.keywords.map(() => (item.context.post_text.includes('pie') ? 0.03 : 0.95)),
        })),
      },
    });
  });

  await page.goto('/');
  await page.getByLabel('Search Terms (comma-separated)', { exact: true }).fill('apple');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('#results .post')).toHaveCount(3);
  expect(classified).toEqual([]);

  await page.getByLabel('Topic Filter', { exact: true }).check();
  await expect(page.locator('#results .post')).toHaveCount(2);
  await expect(page.locator('#results .topic-summary')).toContainText('1 off-topic post hidden.');
  await expect(page).toHaveURL(/[?&]topic=1/);
  expect(classified.map((item) => item.keywords)).toEqual([['apple'], ['apple'], ['apple']]);
  // A reaction post is judged by its link card, not by "wow".
  expect(classified.find((item) => item.id.endsWith('/reaction')).context.link_card).toEqual({
    title: 'Apple beats earnings',
    description: 'A record quarter.',
    site: 'news.example',
    path: '/apple',
  });

  // The card shows the headline that kept the post.
  await expect(page.locator('#results .post', { hasText: 'wow' }).locator('.embed-link-title')).toHaveText('Apple beats earnings');

  await page.getByRole('button', { name: 'Show them', exact: true }).click();
  await expect(page.locator('#results .post')).toHaveCount(3);
  await expect(page.locator('#results .post.off-topic .off-topic-tag')).toHaveText('Off-topic \xB7 3% match');
  await expect(page.locator('#results .post.off-topic .post-text')).toHaveText('My apple pie recipe');
  await expect(page.locator('#results .topic-score-tag')).toHaveText(['95% match', '95% match']);
  await page.screenshot({ path: testInfo.outputPath('topic-filter.png'), fullPage: true });

  await page.reload();
  await expect(page.getByLabel('Topic Filter', { exact: true })).toBeChecked();
  await expect(page.locator('#results .post')).toHaveCount(2);
  await expect(page.locator('#results .post-text')).toHaveText(['Apple unveils a new iPhone', 'wow']);
});

test('cards show link cards and quoted posts as text, linking only to checked URLs', async ({ page }, testInfo) => {
  const external = (fields) => ({ $type: 'app.bsky.embed.external#view', external: fields });
  const quoted = {
    $type: 'app.bsky.embed.record#viewRecord',
    uri: 'at://did:plc:quotedfixture/app.bsky.feed.post/3kquoted',
    author: { did: 'did:plc:quotedfixture', handle: 'newsroom.example', displayName: 'The Newsroom', avatar: 'https://tracker.example/avatar.jpg' },
    value: { text: `Apple raised prices again. ${'Analystsexpectedthis'.repeat(40)}` },
    embeds: [external({ uri: 'https://blog.example/prices', title: 'The new price list', description: 'Not shown in a quote.' })],
  };
  const posts = [
    {
      ...post('reaction', 'wow', 90),
      embed: external({
        uri: 'https://www.news.example/apple?ref=feed',
        title: 'Apple beats earnings',
        description: `A record quarter. ${'Services revenue grew again, and so did everything else. '.repeat(8)}`,
        thumb: 'https://tracker.example/thumb.jpg',
      }),
    },
    {
      ...post('quote', 'this', 80),
      embed: { $type: 'app.bsky.embed.recordWithMedia#view', media: external({ uri: 'http://plain.example/a', title: '' }), record: { $type: 'app.bsky.embed.record#view', record: quoted } },
    },
    {
      ...post('hostile', 'apple', 70),
      embed: external({ uri: 'javascript:alert(document.domain)', title: '<img src=x onerror=alert(1)>', description: 7 }),
    },
    { ...post('malformed', 'apple again', 60), embed: { $type: 'app.bsky.embed.record#view', record: { value: 'text', author: 5 } } },
  ];
  await page.route('**/api/search?**', (route) => route.fulfill({ json: { posts } }));

  await page.goto('/');
  await page.getByLabel('Theme', { exact: true }).selectOption('light');
  await page.getByLabel('Search Terms (comma-separated)', { exact: true }).fill('apple');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('#results .post')).toHaveCount(4);
  // Every card carries an "apple" term tag, so cards are told apart by their post text.
  const card = (text) => page.locator('#results .post')
    .filter({ has: page.locator('.post-text', { hasText: new RegExp(`^${text}$`) }) });

  // Link card: title link, site, and a description kept to one line.
  const reaction = card('wow');
  const title = reaction.locator('a.embed-link-title');
  await expect(title).toHaveText('Apple beats earnings');
  await expect(title).toHaveAttribute('href', 'https://www.news.example/apple?ref=feed');
  await expect(title).toHaveAttribute('target', '_blank');
  await expect(title).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(title.locator('.highlight')).toHaveText('Apple');
  await expect(reaction.locator('.embed-link-site')).toHaveText('news.example');
  const description = reaction.locator('.embed-link-description');
  await expect(description).toContainText('A record quarter.');
  expect((await description.boundingBox()).height).toBeLessThan(28);

  // Quote with media: the media's link card, then the quoted post and its own link.
  const quote = card('this');
  await expect(quote.locator('> .embed-link a.embed-link-title')).toHaveText('plain.example');
  await expect(quote.locator('> .embed-link a.embed-link-title')).toHaveAttribute('href', 'http://plain.example/a');
  await expect(quote.locator('blockquote.embed-quote .embed-quote-name')).toHaveText('The Newsroom');
  await expect(quote.locator('blockquote.embed-quote .embed-quote-handle')).toHaveText('@newsroom.example');
  await expect(quote.locator('.embed-quote-text')).toContainText('Apple raised prices again.');
  await expect(quote.getByRole('link', { name: 'View quote \u2192', exact: true }))
    .toHaveAttribute('href', 'https://bsky.app/profile/did:plc:quotedfixture/post/3kquoted');
  await expect(quote.locator('.embed-quote .embed-link-title')).toHaveText('The new price list');
  await expect(quote.locator('.embed-quote .embed-link-description')).toHaveCount(0);
  // Four lines of 14px text at most, however long the quoted post is.
  expect((await quote.locator('.embed-quote-text').boundingBox()).height).toBeLessThan(4 * 14 * 1.5 + 2);

  // Untrusted fields: markup stays text, a script URL is never a link, and
  // nothing is fetched from the hosts the embeds name (afterEach checks that).
  const hostile = card('apple');
  await expect(hostile.locator('span.embed-link-title')).toHaveText('<img src=x onerror=alert(1)>');
  await expect(hostile.locator('.embed-link a')).toHaveCount(0);
  await expect(card('apple again').locator('.embed-link, .embed-quote')).toHaveCount(0);
  await expect(page.locator('#results img')).toHaveCount(0);
  await expect(page.locator('#results a:not([href^="https://bsky.app/"]):not(.embed-link-title)')).toHaveCount(0);

  // Long unbroken text wraps inside the card at every viewport width.
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const escaped = [...document.querySelectorAll('.embed-link, .embed-quote')].filter((element) => {
      const box = element.getBoundingClientRect();
      const parent = element.parentElement.getBoundingClientRect();
      return box.left < parent.left || box.right > parent.right || element.scrollWidth > element.clientWidth;
    });
    return { page: root.scrollWidth - root.clientWidth, escaped: escaped.length };
  });
  expect(overflow).toEqual({ page: 0, escaped: 0 });

  // Both themes style the blocks from the shared variables.
  const colors = () => reaction.locator('.embed-link').evaluate((element) => ({
    border: getComputedStyle(element).borderTopColor,
    title: getComputedStyle(element.querySelector('.embed-link-title')).color,
    site: getComputedStyle(element.querySelector('.embed-link-site')).color,
  }));
  expect(await colors()).toEqual({ border: 'rgb(224, 224, 224)', title: 'rgb(0, 107, 204)', site: 'rgb(112, 112, 112)' });
  await page.screenshot({ path: testInfo.outputPath('embeds-light.png'), fullPage: true });
  await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  expect(await colors()).toEqual({ border: 'rgb(42, 42, 42)', title: 'rgb(83, 168, 255)', site: 'rgb(160, 167, 179)' });
  await page.screenshot({ path: testInfo.outputPath('embeds-dark.png'), fullPage: true });
});

test('topic filtering rechecks an updated link card and keeps it visible while checking', async ({ page }, testInfo) => {
  const external = (title) => ({ $type: 'app.bsky.embed.external#view', external: { uri: 'https://news.example/story', title } });
  const original = { ...post('updated', 'wow', 90), embed: external('Fresh apple pie') };
  const updated = { ...original, embed: external('Apple unveils a new iPhone') };
  const filler = post('filler', 'Apple iPhone launch', 80);
  const pages = {
    first: { posts: [original], cursor: 'second' },
    second: { posts: [filler], cursor: 'third' },
    third: { posts: [updated] },
  };
  const classified = [];
  let releaseUpdated;
  const updatedReady = new Promise((resolve) => { releaseUpdated = resolve; });
  await page.route('**/api/search?**', (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor') || 'first';
    return route.fulfill({ json: pages[cursor] });
  });
  await page.route('**/api/classify', async (route) => {
    const { items } = route.request().postDataJSON();
    classified.push(...items);
    if (items.some((item) => item.context.link_card?.title === 'Apple unveils a new iPhone')) await updatedReady;
    await route.fulfill({
      json: { results: items.map((item) => ({
        id: item.id,
        scores: item.keywords.map(() => item.context.link_card?.title === 'Fresh apple pie' ? 0.05 : 0.95),
      })) },
    });
  });

  await page.goto('/');
  await expect(page).toHaveTitle('Bluesky Term Search');
  await page.getByLabel('Search Terms (comma-separated)', { exact: true }).fill('apple');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('#results .post')).toHaveCount(2);
  await page.getByLabel('Topic Filter', { exact: true }).check();
  await expect(page.locator('#results .post-text')).toHaveText(['Apple iPhone launch']);
  await expect(page.locator('.topic-summary')).toContainText('1 off-topic post hidden.');

  await page.getByRole('button', { name: 'Load More Results', exact: true }).click();
  await expect(page.locator('#results .post-text')).toHaveText(['wow', 'Apple iPhone launch']);
  await expect(page.locator('.embed-link-title')).toHaveText('Apple unveils a new iPhone');
  await expect(page.locator('.topic-summary')).toContainText('Checking 1 post for topic');
  expect(classified.filter((item) => item.id === original.uri).map((item) => item.context.link_card.title))
    .toEqual(['Fresh apple pie', 'Apple unveils a new iPhone']);
  releaseUpdated();
  await expect(page.locator('.topic-summary')).toContainText('No off-topic posts found.');
  await page.getByRole('button', { name: 'Show scores', exact: true }).click();
  await expect(page.locator('#results .topic-score-tag')).toHaveText(['95% match', '95% match']);
  await expect(page.locator('#results .post.off-topic')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await page.locator('#results').screenshot({ path: testInfo.outputPath('updated-topic-score.png') });
});

test('topic filtering checks a seventh keyword and includes quoted image descriptions', async ({ page }, testInfo) => {
  const keywords = ['meta', 'gap', 'target', 'shell', 'block', 'square', 'apple'];
  const posts = [
    post('seven', 'A puzzle with a gap, target, shell, block and square. Apple announced an iPhone.', 90),
    {
      ...post('image-quote', 'wow', 80),
      embed: {
        $type: 'app.bsky.embed.record#view',
        record: {
          $type: 'app.bsky.embed.record#viewRecord',
          uri: 'at://did:plc:quotedfixture/app.bsky.feed.post/image',
          author: { did: 'did:plc:quotedfixture', handle: 'reporter.example', displayName: 'Reporter' },
          value: { text: '' },
          embeds: [{ $type: 'app.bsky.embed.images#view', images: [{ alt: 'Apple launches the new iPhone', thumb: 'https://not-loaded.example/image' }] }],
        },
      },
    },
  ];
  const classified = [];
  let lastKeyword;
  let releaseSeventh;
  const seventhReady = new Promise((resolve) => { releaseSeventh = resolve; });
  let releaseMeta;
  let otherTermsCompleted = 0;
  const otherTermsReady = new Promise((resolve) => { releaseMeta = resolve; });
  await page.route('**/api/search?**', async (route) => {
    const term = new URL(route.request().url()).searchParams.get('term');
    // Exercise out-of-order completion without relying on arbitrary delays.
    if (term === 'meta') await otherTermsReady;
    await route.fulfill({ json: { posts } });
    if (term !== 'meta' && ++otherTermsCompleted === keywords.length - 1) releaseMeta();
  });
  await page.route('**/api/classify', async (route) => {
    const { items } = route.request().postDataJSON();
    expect(items.length).toBeLessThanOrEqual(25);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    expect(items.every((item) => item.keywords.length <= 6)).toBe(true);
    classified.push(...items);
    if (items.some((item) => item.keywords.includes(lastKeyword))) await seventhReady;
    await route.fulfill({
      json: { results: items.map((item) => ({
        id: item.id,
        scores: item.keywords.map((keyword) => keyword === lastKeyword ? 0.95 : 0.05),
      })) },
    });
  });

  await page.goto('/');
  await page.getByLabel('Search Terms (comma-separated)', { exact: true }).fill(keywords.join(', '));
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeEnabled();
  await expect(page.locator('#results .post')).toHaveCount(2);
  const matchedTerms = await page.locator('#results .post').first().locator('.term-tag').allTextContents();
  expect([...matchedTerms].sort()).toEqual([...keywords].sort());
  lastKeyword = matchedTerms.at(-1);
  await page.getByLabel('Topic Filter', { exact: true }).check();
  await expect.poll(() => classified.flatMap((item) => item.keywords).length).toBe(14);
  for (const candidate of posts) {
    expect(classified.filter((item) => item.id === candidate.uri).flatMap((item) => item.keywords).sort())
      .toEqual([...keywords].sort());
  }
  expect(classified.find((item) => item.id.endsWith('/image-quote')).context.quoted_post.image_descriptions)
    .toEqual(['Apple launches the new iPhone']);
  await expect(page.locator('.topic-summary')).toContainText('Checking 2 posts for topic');
  await expect(page.locator('#results .post')).toHaveCount(2);
  await page.getByRole('button', { name: 'Show scores', exact: true }).click();
  await expect(page.locator('#results .topic-score-tag')).toHaveText(['5% match', '5% match']);
  releaseSeventh();
  await expect(page.locator('.topic-summary')).toContainText('No off-topic posts found.');
  await expect(page.locator('#results .topic-score-tag')).toHaveText(['95% match', '95% match']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await page.locator('#results').screenshot({ path: testInfo.outputPath('all-keywords-and-quoted-image.png') });
});

test('long destinations and quoted handles remain fully visible', async ({ page }, testInfo) => {
  const hostname = 'login.' + 'secure.'.repeat(11) + 'identity.bsky.app.attacker.example';
  const handle = 'account.' + 'secure.'.repeat(20) + 'foo.bsky.app.attacker.example';
  const uri = 'https://' + hostname + '/signin';
  const external = (title = '') => ({ $type: 'app.bsky.embed.external#view', external: { uri, title } });
  const posts = [
    {
      ...post('identities', 'Apple account update', 90),
      embed: {
        $type: 'app.bsky.embed.recordWithMedia#view',
        media: external('Apple account information'),
        record: {
          $type: 'app.bsky.embed.record#view',
          record: {
            $type: 'app.bsky.embed.record#viewRecord',
            uri: 'at://did:plc:quotedfixture/app.bsky.feed.post/3kquoted',
            author: { did: 'did:plc:quotedfixture', handle, displayName: 'Quoted author' },
            value: { text: 'Apple account announcement' },
            embeds: [external()],
          },
        },
      },
    },
    { ...post('untitled', 'Apple untitled link', 80), embed: external() },
  ];
  await page.route('**/api/search?**', (route) => route.fulfill({ json: { posts } }));
  await page.goto('/');
  await page.getByLabel('Search Terms (comma-separated)', { exact: true }).fill('apple');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('#results .post')).toHaveCount(2);
  await expect(page.locator('.embed-link-site')).toHaveText(hostname);
  await expect(page.locator('.embed-quote-handle')).toHaveText('@' + handle);
  await expect(page.locator('.embed-link-hostname')).toHaveText([hostname, hostname]);
  for (const link of await page.locator('a.embed-link-title').all()) {
    await expect(link).toHaveAttribute('href', uri);
  }

  // Hostnames used in place of titles must wrap completely, including inside quotes.
  for (const width of [testInfo.project.use.viewport.width, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.getByLabel('Theme', { exact: true }).selectOption(theme);
      const clipped = await page.locator('.embed-link-site, .embed-link-hostname, .embed-quote-handle')
        .evaluateAll((elements) => elements.filter((element) =>
          element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
          .map((element) => element.className));
      expect(clipped, 'Every destination and handle suffix must be visible').toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      await page.locator('#results .post').first().screenshot({ path: testInfo.outputPath('identifiers-' + width + '-' + theme + '.png') });
    }
  }
});
