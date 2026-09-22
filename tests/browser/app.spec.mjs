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
    post('company', 'Instagram prioritizes recommended Reels over followed accounts, pushing creators to buy reach.', 90),
    post('credit', 'Artwork by a contemporary artist (via Instagram) #WomensArt', 80),
    post('promotion', 'I am live now! Follow my stream. #instagram #livestream', 75),
    post('casual', 'Took this photo for someone on Instagram, but I want to share it here.', 72),
    {
      ...post('reaction', 'wow', 70),
      embed: {
        $type: 'app.bsky.embed.external#view',
        external: { uri: 'https://news.example/instagram', title: 'Instagram expands teen account protections', description: 'Messages from strangers will be blocked by default.' },
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
          scores: item.keywords.map(() => (/\/(company|reaction)$/.test(item.id) ? 0.95 : 0.03)),
        })),
      },
    });
  });

  await page.goto('/');
  await page.getByLabel('Search Terms (comma-separated)', { exact: true }).fill('Instagram');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('#results .post')).toHaveCount(5);
  expect(classified).toEqual([]);

  await expect(page.getByText('Keep analysis and substantive news', { exact: true })).toBeVisible();
  await page.getByLabel('Topic Filter', { exact: true }).check();
  await expect(page.locator('#results .post')).toHaveCount(2);
  await expect(page.locator('#results .topic-summary')).toContainText('3 off-topic posts hidden.');
  await expect(page.locator('#results .topic-score-tag')).toHaveText(['95% match', '95% match']);
  await expect(page).toHaveURL(/[?&]topic=1/);
  expect(classified.map((item) => item.keywords)).toEqual(Array.from({ length: 5 }, () => ['Instagram']));
  expect(classified.find((item) => item.id.endsWith('/reaction')).context.link_card).toEqual({
    title: 'Instagram expands teen account protections',
    description: 'Messages from strangers will be blocked by default.',
    site: 'news.example',
    path: '/instagram',
  });

  await expect(page.locator('#results .post', { hasText: 'wow' }).locator('.embed-link-title')).toHaveText('Instagram expands teen account protections');

  await page.getByRole('button', { name: 'Show them', exact: true }).click();
  await expect(page.locator('#results .post')).toHaveCount(5);
  await expect(page.locator('#results .post.off-topic .off-topic-tag')).toHaveText(Array(3).fill('Off-topic \xB7 3% match'));
  await expect(page.locator('#results .post.off-topic .post-text')).toHaveText(posts.slice(1, 4).map((item) => item.record.text));
  await expect(page.locator('#results .topic-score-tag')).toHaveText(['95% match', '95% match']);
  await page.screenshot({ path: testInfo.outputPath('topic-filter.png'), fullPage: true });

  await page.getByRole('button', { name: 'Hide them again', exact: true }).click();
  await expect(page.locator('#results .post')).toHaveCount(2);
  await expect(page.locator('#results .topic-score-tag')).toHaveText(['95% match', '95% match']);
  await page.getByLabel('Topic Filter', { exact: true }).uncheck();
  await expect(page.locator('#results .post')).toHaveCount(5);
  await expect(page.locator('#results .topic-score-tag, #results .off-topic-tag')).toHaveCount(0);
  await page.getByLabel('Topic Filter', { exact: true }).check();

  await page.reload();
  await expect(page.getByLabel('Topic Filter', { exact: true })).toBeChecked();
  await expect(page.locator('#results .post')).toHaveCount(2);
  await expect(page.locator('#results .post-text')).toHaveText([posts[0].record.text, 'wow']);
  await expect(page.locator('#results .topic-score-tag')).toHaveText(['95% match', '95% match']);
});

test('cards show link cards and quoted posts as text, linking only to checked URLs', async ({ page }, testInfo) => {
  const external = (fields) => ({ $type: 'app.bsky.embed.external#view', external: fields });
  const markup = '<img src=x onerror=alert(1)>';
  const quoted = {
    $type: 'app.bsky.embed.record#viewRecord',
    uri: 'at://did:plc:quotedfixture/app.bsky.feed.post/3kquoted',
    author: { did: 'did:plc:quotedfixture', handle: 'newsroom.example', displayName: markup, avatar: 'https://tracker.example/avatar.jpg' },
    value: { text: `Apple raised prices again. ${markup} ${'Analystsexpectedthis'.repeat(40)}` },
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
      embed: external({ uri: 'javascript:alert(document.domain)', title: markup, description: 7 }),
    },
  ];
  await page.route('**/api/search?**', (route) => route.fulfill({ json: { posts } }));

  await page.goto('/');
  await page.getByLabel('Theme', { exact: true }).selectOption('light');
  await page.getByLabel('Search Terms (comma-separated)', { exact: true }).fill('apple');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('#results .post')).toHaveCount(3);
  const card = (text) => page.locator('#results .post')
    .filter({ has: page.locator('.post-text', { hasText: new RegExp(`^${text}$`) }) });

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

  const quote = card('this');
  await expect(quote.locator('> .embed-link a.embed-link-title')).toHaveText('plain.example');
  await expect(quote.locator('> .embed-link a.embed-link-title')).toHaveAttribute('href', 'http://plain.example/a');
  await expect(quote.locator('blockquote.embed-quote .embed-quote-name')).toHaveText(markup);
  await expect(quote.locator('blockquote.embed-quote .embed-quote-handle')).toHaveText('@newsroom.example');
  await expect(quote.locator('.embed-quote-text')).toContainText(`Apple raised prices again. ${markup}`);
  await expect(quote.getByRole('link', { name: 'View quote \u2192', exact: true }))
    .toHaveAttribute('href', 'https://bsky.app/profile/did:plc:quotedfixture/post/3kquoted');
  await expect(quote.locator('.embed-quote .embed-link-title')).toHaveText('The new price list');
  await expect(quote.locator('.embed-quote .embed-link-description')).toHaveCount(0);
  expect((await quote.locator('.embed-quote-text').boundingBox()).height).toBeLessThan(4 * 14 * 1.5 + 2);

  const hostile = card('apple');
  await expect(hostile.locator('span.embed-link-title')).toHaveText(markup);
  await expect(hostile.locator('.embed-link a')).toHaveCount(0);
  await expect(page.locator('#results img')).toHaveCount(0);
  await expect(page.locator('#results a:not([href^="https://bsky.app/"]):not(.embed-link-title)')).toHaveCount(0);

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

  await page.screenshot({ path: testInfo.outputPath('embeds-light.png'), fullPage: true });
  await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  await page.screenshot({ path: testInfo.outputPath('embeds-dark.png'), fullPage: true });
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
            author: { did: 'did:plc:quotedfixture', handle },
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
  await expect(page.locator('.embed-quote-name')).toHaveText(handle);
  await expect(page.locator('.embed-quote-handle')).toHaveText('@' + handle);
  await expect(page.locator('.embed-link-hostname')).toHaveText([hostname, hostname]);
  for (const link of await page.locator('a.embed-link-title').all()) {
    await expect(link).toHaveAttribute('href', uri);
  }

  const widths = [testInfo.project.use.viewport.width];
  if (testInfo.project.name === 'mobile') widths.push(320);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.getByLabel('Theme', { exact: true }).selectOption(theme);
      const clipped = await page.locator('.embed-link-site, .embed-link-hostname, .embed-quote-name, .embed-quote-handle')
        .evaluateAll((elements) => elements.filter((element) =>
          element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
          .map((element) => element.className));
      expect(clipped, 'Every destination and handle suffix must be visible').toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      await page.locator('#results .post').first().screenshot({ path: testInfo.outputPath('identifiers-' + width + '-' + theme + '.png') });
    }
  }
});
