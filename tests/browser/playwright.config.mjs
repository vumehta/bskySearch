import { defineConfig } from '@playwright/test';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = process.env.BROWSER_TEST_PORT || '4173';
const baseURL = `http://127.0.0.1:${port}`;
const repositoryDir = fileURLToPath(new URL('../../', import.meta.url));
const repositoryId = createHash('sha256').update(repositoryDir).digest('hex').slice(0, 12);

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  workers: 2,
  retries: 0,
  timeout: 20000,
  reporter: 'list',
  outputDir: process.env.BROWSER_TEST_OUTPUT_DIR || join(tmpdir(), `bskysearch-playwright-${repositoryId}`),
  use: {
    baseURL,
    browserName: 'chromium',
    channel: process.env.BROWSER_TEST_CHANNEL,
    launchOptions: { executablePath: process.env.BROWSER_TEST_EXECUTABLE },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 900 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'node tests/browser/serve-dist.mjs',
    cwd: repositoryDir,
    url: baseURL,
    timeout: 10000,
    reuseExistingServer: false,
  },
});
