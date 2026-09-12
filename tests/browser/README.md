# Browser smoke tests

The tests load the real HTML, CSS, and JavaScript from `dist` in Chromium at desktop and mobile viewport sizes. They exercise search pagination, minimum-likes filtering, normal handle-based quote lookup, and quote sorting. API responses are fixtures; these tests do not verify a live Bluesky account or deployment.

```sh
npm ci
npx playwright install chromium
npm run build
npm run test:browser
```

CI installs Chromium's Linux system dependencies with `npx playwright install --with-deps chromium` before running the same tests. Rebuild after editing production source so the tests use the latest bundle.

Screenshots and failure traces go to the operating system's temporary directory under `bskysearch-playwright-<repository ID>`. Each checkout gets a separate directory. Set `BROWSER_TEST_OUTPUT_DIR` to choose another artifact directory. No HTML report is generated.

Optional settings:

- `BROWSER_TEST_PORT`: local server port (default `4173`).
- `BROWSER_TEST_CHANNEL`: installed browser channel, such as `chrome`.
- `BROWSER_TEST_EXECUTABLE`: explicit compatible Chromium executable path.

The local server binds only to `127.0.0.1`, serves the three built assets, and applies the response headers from `vercel.json`. Tests intercept API requests and reject unexpected external requests.
