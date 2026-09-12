import { test, expect } from '@playwright/test';

const did = 'did:plc:browserfixture';
const originalUri = `at://${did}/app.bsky.feed.post/original`;
const browserErrors = new WeakMap();

function post(id, text, likes, ageHours = 0) {
  const createdAt = new Date(Date.now() - ageHours * 3600000).toISOString();
  return {
    uri: `at://${did}/app.bsky.feed.post/${id}`,
    author: { handle: 'alice.bsky.social', displayName: 'Alice' },
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
    post('newest', 'Newest quote', 10, 1),
    post('oldest', 'Oldest quote', 30, 3),
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
  await page.getByRole('button', { name: 'Most Likes', exact: true }).click();
  await expect(texts).toHaveText(['Popular quote', 'Oldest quote', 'Newest quote']);
  expect(calls.sort()).toEqual(['app.bsky.actor.getProfile', 'app.bsky.feed.getPosts', 'app.bsky.feed.getQuotes']);
  await expect(page.locator('#quoteStatus')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('quotes.png'), fullPage: true });
});
