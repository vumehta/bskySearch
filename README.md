# Bluesky Term Search

A small, framework-free Bluesky search app with minimum-like and time filters,
phrase expansion, cursor pagination, inline thread context, and a quote finder.

## Development

Use Node.js 24 and npm. On Windows PowerShell, use `npm.cmd` if execution policy
blocks the `npm.ps1` shim.

```sh
npm ci
npm test
npm run build
npm run perf:smoke
```

The build bundles `src/app.mjs` with esbuild, minifies CSS with cssnano, and copies
the HTML, JavaScript, and CSS to `dist/`. Generated assets are ignored by Git.
The performance smoke check imports production transformations, checks their
results against a reference, and measures merge/filter/sort and highlighting.
It does not measure browser layout or network latency.

For the complete local app, configure the two environment variables in
`.env.example` using a local `.env.local` file, then run `vercel dev` with the
Vercel CLI. Keep credentials out of tracked files. A static server can display
`dist/`, but search also needs the `/api/search` function. Quote and thread
lookups use the public Bluesky API directly.

## Deployment

Vercel uses `npm run build`, serves `dist/`, rewrites `/` to the HTML entry point,
and deploys `api/search.mjs` as a Node.js function. Set `BSKY_HANDLE` and
`BSKY_APP_PASSWORD` in the relevant Vercel environment. Use a Bluesky app password.
The configured security headers are in `vercel.json`.

GitHub Actions runs the tests, build, and performance smoke check for pull requests
and pushes to `main`. The workflow does not deploy the app.

## Behavior

- Search terms are comma-separated. Phrase expansion also searches individual
  words. Search is intentionally English-only.
- Terms, minimum likes, time range, sort, and phrase expansion apply automatically.
  Search URLs restore their controls and run the search when opened.
- A new search cancels obsolete work. At most four terms are fetched concurrently,
  initially up to two pages per term. Load More remains available when loaded
  posts are filtered out or a failed page can be retried.
- Successful pages survive failures of other pages or terms. Sort and filter
  changes start a fresh search; cursors are never transferred between rankings.
- The client fixes the `since` value for each search. The backend validates ISO
  dates and AT Protocol datetimes. Client filtering uses the post creation time
  with an indexing-time fallback. Bluesky's search index can use a different
  timestamp and does not guarantee exhaustive pagination.
- Quote pages merge by URI. A new post submission replaces an in-flight quote
  search or pagination request. Quote sorts operate on the loaded quotes.
- Rendering supports plain text, safe term highlighting, and direct image embeds.
  Rich-text facets, video, external cards, and nested quote/media embeds are not
  expanded. Open the post on Bluesky for its complete presentation.

## Reliability and limits

Browser requests have a 10-second deadline through response-body parsing and are
cancelled when replaced. The proxy applies an 8-second upstream deadline through
body parsing, validates successful responses, and returns 502 for invalid data.
Identical pending searches share one upstream operation. Cancelling one subscriber
does not cancel work still needed by another subscriber.

Search responses use `Cache-Control: no-store`; the proxy maintains a bounded
30-second cache in memory. Sessions refresh after their two-hour local lifetime
or an authentication rejection. A late rejection of an old token reuses the
already refreshed session.

Proxy admission limits apply **per running function instance**: up to 16 distinct
search jobs in flight, and a token bucket allowing a burst of 60 new jobs with
one token replenished per second. Cache hits and subscribers joining an existing
job do not consume admission tokens. A limited request receives HTTP 429 and a
`Retry-After` header. These controls do not depend on caller-supplied IP headers.
They do not provide an account-wide quota across scaled instances; that requires
trusted edge controls or shared storage.

## Verification

Tests cover input boundaries, sessions, concurrency, cancellation, body timeouts,
partial pagination, sort changes, stale responses, quote deduplication, theme
storage failures, thread state, and rendering behavior. Browser QA should also
exercise search, pagination, quote replacement, thread cancellation, and narrow
layouts with long handles and URLs. Passing local tests does not verify a live
deployment's credentials or upstream availability.
