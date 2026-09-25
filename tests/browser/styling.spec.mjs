import { test, expect } from '@playwright/test';

const did = 'did:plc:browserfixture';
const browserErrors = new WeakMap();

function post(id, text, author = { did, handle: 'alice.bsky.social', displayName: 'Alice' }) {
  const createdAt = new Date().toISOString();
  return {
    uri: `at://${did}/app.bsky.feed.post/${id}`,
    author,
    record: { text, createdAt },
    indexedAt: createdAt,
    likeCount: 20,
    repostCount: 0,
    replyCount: 0,
  };
}

async function searchFor(page, term) {
  const terms = page.getByLabel('Search Terms (comma-separated)', { exact: true });
  await terms.fill(term);
  await terms.press('Enter');
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

test('focused controls, cards and links keep a visible outline in forced colors mode', async ({ page }, testInfo) => {
  await page.route('**/api/search?**', (route) => route.fulfill({ json: { posts: [post('focus', 'apple focus')] } }));
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/');
  await searchFor(page, 'apple');
  const card = page.locator('#results .post');
  await expect(card).toHaveCount(1);
  await card.evaluate((element) => { element.tabIndex = -1; });

  const targets = {
    button: page.getByRole('button', { name: 'Search', exact: true }),
    input: page.getByLabel('Search Terms (comma-separated)', { exact: true }),
    select: page.getByLabel('Time Range', { exact: true }),
    card,
    link: card.getByRole('link', { name: 'View Replies \u2192', exact: true }),
  };
  for (const [name, target] of Object.entries(targets)) {
    await target.focus();
    const ring = await target.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        focusVisible: element.matches(':focus-visible'),
        style: style.outlineStyle,
        width: style.outlineWidth,
        color: style.outlineColor,
      };
    });
    expect(ring.focusVisible, `${name} should match :focus-visible`).toBe(true);
    expect(ring.style, `${name} outline style`).not.toBe('none');
    expect(ring.width, `${name} outline width`).not.toBe('0px');
    expect(ring.color, `${name} outline color`).not.toBe('rgba(0, 0, 0, 0)');
    const box = await target.boundingBox();
    await page.screenshot({
      path: testInfo.outputPath(`forced-colors-focus-${name}.png`),
      clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 },
    });
  }
});
