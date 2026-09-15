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
    first: { posts: [{ ...post('first', 'apple first page', 20), bookmarkCount: 1 }], cursor: 'second' },
    second: { posts: [{ ...post('second', 'apple second page', 60), bookmarkCount: 9 }], cursor: 'third' },
    third: { posts: [{ ...post('third', 'apple third page', 100), bookmarkCount: 5 }], cursor: 'fourth' },
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
  await page.getByLabel('Sort', { exact: true }).selectOption('bookmarks');
  await expect(page.locator('#results .post-text')).toHaveText(['apple second page', 'apple third page', 'apple first page']);
  await page.getByLabel('Sort', { exact: true }).selectOption('top');
  await expect(page.locator('#results .post-text')).toHaveText(['apple third page', 'apple second page', 'apple first page']);
  expect(cursors).toEqual(['first', 'second', 'third']);
  await page.getByRole('button', { name: 'Load More Results', exact: true }).click();
  await expect(page.locator('#results .post')).toHaveCount(4);
  expect(cursors).toEqual(['first', 'second', 'third', 'fourth']);
  await expect(page.getByRole('button', { name: 'Load More Results', exact: true })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('search.png'), fullPage: true });
});

test('save and badge updates preserve revealed video and expanded thread context', async ({ page }, testInfo) => {
  const base = post('reply', 'apple video reply', 20);
  const reply = {
    ...base,
    bookmarkCount: 1,
    record: { ...base.record, reply: { parent: { uri: originalUri } } },
    embed: { $type: 'app.bsky.embed.video#view', thumbnail: 'https://video.bsky.app/fixture-preview.svg', alt: 'Video preview fixture' },
  };
  const updated = {
    ...reply,
    bookmarkCount: 9,
    author: { ...reply.author, pronouns: 'they/them', verification: { verifiedStatus: 'valid' } },
  };
  const pages = {
    first: { posts: [reply], cursor: 'second' },
    second: { posts: [], cursor: 'third' },
    third: { posts: [updated] },
  };
  await page.route('**/api/search?**', route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor') || 'first';
    return route.fulfill({ json: pages[cursor] });
  });
  await page.route('https://video.bsky.app/fixture-preview.svg', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="white"/></svg>',
  }));
  await page.route('https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?**', route => route.fulfill({
    json: { thread: { parent: { post: post('original', 'Thread parent fixture', 10) } } },
    headers: { 'Access-Control-Allow-Origin': '*' },
  }));

  await page.goto('/?terms=apple');
  await page.getByRole('button', { name: 'Show video preview', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Video preview fixture', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View Thread', exact: true }).click();
  await expect(page.locator('.thread-parent-text')).toHaveText('Thread parent fixture');
  await page.getByRole('button', { name: 'Load More Results', exact: true }).click();
  await expect(page.getByLabel('9 saves', { exact: true })).toBeVisible();
  await expect(page.locator('#results .pronouns')).toHaveText('they/them');
  await expect(page.locator('#results .badge')).toHaveText('Verified');
  await expect(page.getByRole('button', { name: 'Show video preview', exact: true })).toBeHidden();
  await expect(page.getByRole('img', { name: 'Video preview fixture', exact: true })).toBeVisible();
  await expect(page.locator('.thread-parent-text')).toHaveText('Thread parent fixture');
  await expect(page.getByRole('button', { name: 'Hide Thread', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await page.screenshot({ path: testInfo.outputPath('preserved-disclosures.png'), fullPage: true });
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
