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
  });

  await page.getByRole('button', { name: 'Show them', exact: true }).click();
  await expect(page.locator('#results .post')).toHaveCount(3);
  await expect(page.locator('#results .post.off-topic .off-topic-tag')).toHaveText('Off-topic \xB7 3% match');
  await expect(page.locator('#results .post.off-topic .post-text')).toHaveText('My apple pie recipe');
  await page.screenshot({ path: testInfo.outputPath('topic-filter.png'), fullPage: true });

  await page.reload();
  await expect(page.getByLabel('Topic Filter', { exact: true })).toBeChecked();
  await expect(page.locator('#results .post')).toHaveCount(2);
  await expect(page.locator('#results .post-text')).toHaveText(['Apple unveils a new iPhone', 'wow']);
});
