# Bluesky Term Search

Search English-language Bluesky posts by time and engagement, find quotes, and monitor saved searches in a personal inbox.

## Monitoring MVP

The **Inbox** link opens `/monitor.html`. Sign in with your dashboard password, save up to 10 Bluesky queries, and check for new matches. Each saved search accepts one query (including Bluesky search operators); comma-separated searches and phrase expansion from the manual search form are not applied here.

- Cloudflare runs the collector every 10 minutes, even when the browser and computer are off.
- A new search starts with the preceding hour. Later checks revisit a 30-minute overlap to pick up delayed indexing.
- D1 stores searches, text snapshots, query matches, and read state. The same post appears once even if multiple queries find it. Repeated checks update its snapshot without making it unread again.
- Pause/resume, remove, check now, filter by search, unread/all views, individual read actions, and mark-all-read are included.
- Mark-all-read applies to the selected search and the inbox snapshot you loaded. Later arrivals remain unread.
- Matches are kept for 30 days from first collection. Removing a search also removes posts that no remaining search matches.
- The initial MVP has one shared personal inbox, not multiple accounts. It has no email/push alerts or digests. Likes are shown as last observed; collection includes posts regardless of like count. Images/embeds open on Bluesky.

The existing Vercel deployment remains supported. The Worker can also serve the whole app so local development and a standalone Cloudflare deployment need only one origin.

## Run locally

Use Node 22 and npm.

```sh
npm ci
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` with:

- `MONITOR_PASSWORD`: a private dashboard password of at least 16 characters.
- `BSKY_HANDLE`: the Bluesky account used for searches.
- `BSKY_APP_PASSWORD`: an app password created in Bluesky settings (not your account password).

```sh
npm run monitor:dev
```

Open `http://localhost:8787/monitor.html`. Local D1 data persists in `.wrangler/`. Saving a search and **Check now** invoke the collector immediately (at most once a minute). Local development does **not** run the production cron automatically. Exercise its scheduled handler with:

```sh
curl 'http://localhost:8787/__scheduled?cron=*/10+*+*+*+*'
```

The UI shows setup errors when the service or credentials are missing. It never substitutes sample results. Automated tests use isolated fixtures and never contact Bluesky.

## Deploy the Worker

These commands create Cloudflare resources and publish the Worker. Run them when ready to deploy, after choosing the account with `npx wrangler login`.

1. Run `npx wrangler d1 create bsky-search-monitor`. Add the returned `database_id` to the existing `DB` entry in `wrangler.jsonc`.
2. Apply the schema with `npx wrangler d1 migrations apply DB --remote`.
3. Set `MONITOR_PASSWORD`, `BSKY_HANDLE`, and `BSKY_APP_PASSWORD` using `npx wrangler secret put NAME` for each secret. Do not put them in `wrangler.jsonc` or source control.
4. Run `npm run monitor:dry-run`, then `npx wrangler deploy`.
5. Open the returned Worker URL at `/monitor.html`, save a low-volume query, and verify a successful check plus new inbox matches. Verify the scheduled invocation in Cloudflare before relying on unattended monitoring.

The cron is declared in `wrangler.jsonc`; it is activated by deployment. This branch does not provision resources or enable monitoring merely by being checked out.

### Keep the existing frontend on Vercel

Deploy the Worker above, then:

- Set `MONITOR_WORKER_URL` in Vercel to the Worker's HTTPS origin, for example `https://bsky-search-monitor.YOUR-SUBDOMAIN.workers.dev`.
- Set the Worker's `APP_ORIGIN` variable to the exact Vercel app origin, such as `https://your-app.vercel.app`. This permits dashboard mutations from that origin; preview deployments need their own matching value or a separate preview Worker/database.
- Deploy this branch's frontend and `api/monitor.mjs` on Vercel. That route forwards only monitoring requests and session cookies to the configured Worker. The existing `/api/search` route remains unchanged.
- Keep `BSKY_HANDLE` and `BSKY_APP_PASSWORD` configured on Vercel as before for manual searches; the collector uses the Worker secrets.

Sign-in sessions are signed, HttpOnly, SameSite cookies valid for seven days. HTTPS deployments use Secure cookies. Password guessing is rate-limited in D1. Rotating `MONITOR_PASSWORD` invalidates existing sessions. Bluesky refresh/access tokens are cached server-side in D1 to avoid repeated account logins; they never appear in API responses. Protect access to the Cloudflare account and database as you would other credentials.

## Collection behavior and limits

Each invocation has a 22-second work budget and reads at most three pages of 100 posts per search, serving the least recently attempted searches first. A database lease prevents concurrent collectors; manual requests have a one-minute cooldown. Each page is stored atomically with its cursor. Failures preserve progress, expired cursors restart the same window, and busy searches show **Catching up** until the frozen window is exhausted. Paused searches resume from their checkpoint.

This is best-effort monitoring of Bluesky's search index, not a complete firehose archive. Indexing delays beyond the overlap, upstream pagination limits, or searches generating more results than polling can drain can cause gaps or a growing backlog. Prefer focused queries for this MVP. Deleted posts and engagement changes are not continuously reconciled; snapshots expire after retention.

## Validation

```sh
npm test
npm run build
npm run perf:smoke
npm run monitor:types
npm run monitor:dry-run
```

Integration tests run the actual Worker and SQLite/D1 runtime through Miniflare, with fixture Bluesky responses. They cover authentication and origin checks, rate limits, validation and search limits, scheduled collection, deduplication, checkpoint recovery, bounded pagination, pause/resume, concurrent collectors, inbox pagination/filtering, read-state races, deletion, and retention. Miniflare opens loopback ports during testing. The test-only collector endpoint exists solely in the test harness; it is not bundled into the deployed Worker.

Cloudflare's installed Wrangler version uses Miniflare 5; the test harness uses its current configuration format. Runtime bindings are generated by `monitor:types` rather than maintained by hand.

References: [Cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
