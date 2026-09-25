import { test, expect } from '@playwright/test';

const did = 'did:plc:browserfixture';
const browserErrors = new WeakMap();
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

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

function palette(page) {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const names = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules])
      .filter((rule) => rule.selectorText === ':root')
      .flatMap((rule) => [...rule.style].filter((name) => name.startsWith('--')));
    return {
      colorScheme: root.colorScheme,
      background: getComputedStyle(document.body).backgroundColor,
      variables: Object.fromEntries(names.map((name) => [name, root.getPropertyValue(name)])),
    };
  });
}

function setTheme(page, theme) {
  return page.evaluate((value) => {
    if (value) document.documentElement.dataset.theme = value;
    else delete document.documentElement.dataset.theme;
  }, theme);
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

test('a dark system preference gets the dark palette before the app script runs', async ({ page }) => {
  await page.route('**/app.min.js', (route) => route.fulfill({ body: '', contentType: 'text/javascript' }));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(false);
  const systemDark = await palette(page);
  expect(systemDark.background).toBe('rgb(10, 10, 10)');
  expect(systemDark.colorScheme).toBe('dark');

  await page.emulateMedia({ colorScheme: 'light' });
  const systemLight = await palette(page);
  expect(systemLight.background).toBe('rgb(255, 255, 255)');
  expect(systemLight.colorScheme).toBe('light');

  await setTheme(page, 'dark');
  expect(await palette(page), 'Dark under a light system must match the system dark palette').toEqual(systemDark);
  await page.emulateMedia({ colorScheme: 'dark' });
  await setTheme(page, 'light');
  expect(await palette(page), 'Light under a dark system must match the system light palette').toEqual(systemLight);
});

test('choosing Light or Dark overrides the system preference', async ({ page }) => {
  const body = page.locator('body');
  const theme = page.getByLabel('Theme', { exact: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(body).toHaveCSS('background-color', 'rgb(10, 10, 10)');
  await theme.selectOption('light');
  await expect(body).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.reload();
  await expect(theme).toHaveValue('light');
  await expect(body).toHaveCSS('background-color', 'rgb(255, 255, 255)');

  await page.emulateMedia({ colorScheme: 'light' });
  await theme.selectOption('dark');
  await expect(body).toHaveCSS('background-color', 'rgb(10, 10, 10)');
  await theme.selectOption('system');
  await expect(body).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});

test('the image CDN preconnect matches the no-cors image loads it is for', async ({ page }) => {
  const avatar = 'https://cdn.bsky.app/img/avatar/plain/did:plc:browserfixture/avatar@jpeg';
  await page.route('https://cdn.bsky.app/**', (route) => route.fulfill({ body: pixel, contentType: 'image/png' }));
  await page.route('**/api/search?**', (route) => route.fulfill({
    json: { posts: [post('avatar', 'apple avatar', { did, handle: 'alice.bsky.social', avatar })] },
  }));
  await page.goto('/');
  await expect(page.locator('link[rel="preconnect"][href="https://public.api.bsky.app"]')).toHaveAttribute('crossorigin', '');
  await expect(page.locator('link[rel="preconnect"][href="https://cdn.bsky.app"]')).not.toHaveAttribute('crossorigin');

  await searchFor(page, 'apple');
  const image = page.locator('#results img.avatar');
  await expect(image).toHaveAttribute('src', avatar);
  await expect(image).not.toHaveAttribute('crossorigin');
});
