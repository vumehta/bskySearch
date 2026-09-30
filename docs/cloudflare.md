# Cloudflare deployment

The site runs as one Cloudflare Worker. The files in `dist/` are served as
Workers static assets, and `worker/index.mjs` routes `/api/search` and
`/api/classify` to the handlers in `api/`. `wrangler.jsonc` holds the
configuration: the custom domain, the classifier rate limit (see
`classifier-rate-limit.md`), and the `enable_request_signal` compatibility flag
that lets abandoned requests cancel their upstream calls.

## Security headers

`worker/security-headers.json` is the only list. The build writes it to
`dist/_headers` for static files, the Worker adds it to its own responses, and
the browser tests serve it too. Edit the JSON, not `dist/_headers`.

The Worker serves the page itself (`run_worker_first` for `/`) so each response
gets a fresh `script-src` nonce. Bot Fight Mode injects an inline JavaScript
Detections script into HTML and copies that nonce from the CSP header onto it;
without one, the CSP blocks the script. Nonce-bearing pages are sent with
`Cache-Control: no-store`.

## Secrets

Set each secret once; Wrangler prompts for the value:

```sh
npx wrangler secret put BSKY_HANDLE
npx wrangler secret put BSKY_APP_PASSWORD
npx wrangler secret put TYPESAFE_API_KEY
```

Use a Bluesky app password, not the account password. `TYPESAFE_MODEL` is
optional; set it the same way to pin a versioned model.

## Local development

`npm run dev` builds `dist/` and runs the Worker at `http://localhost:8787` in
the local Workers runtime, rate limiter included. Wrangler reads secrets from
`.env` (or `.dev.vars`, but not both) next to `wrangler.jsonc`; `.env.example`
lists them. Rerun after changing browser code, since the Worker serves the
built bundle.

## Deploy

Workers Builds deploys every push to `main`, and builds a Preview for pushes to
other branches. It does not wait for GitHub CI. Its settings live in the
Cloudflare dashboard under the Worker's **Settings → Builds**, not in this repo:

| Setting | Value |
| --- | --- |
| Build command | `npm install -g npm@11.19.0 && npm ci && npm run build` |
| Deploy command | `npx wrangler deploy` |
| Preview command | `npx wrangler preview` |
| Build variable | `SKIP_DEPENDENCY_INSTALL` = `1` |

The build image's Node 24 ships an npm older than the 11.19 that `devEngines`
requires, so the variable turns off Cloudflare's own install and the build
command upgrades npm before `npm ci`. Bump the pinned npm there by hand.
Previews appear to take their secrets from the Previews Base settings rather
than production, so search may not work on a Preview without them.

`npm run deploy` builds and deploys from a local checkout; run
`npx wrangler login` first on a new machine. `npx wrangler rollback` returns to
the previous version. CI bundles the Worker with `wrangler deploy --dry-run` on
every push, without deploying.

The old `bskysearch.vercel.app` URL sends a 307 for every path, keeping the query
string, to the same path here. That is a project routing rule in the Vercel
project, which is no longer connected to this repository.

Keep Rocket Loader and Email Obfuscation off for the zone. The app doesn't need
them, and both rewrite the page's scripts.

## Runtime notes

- Identical searches and Bluesky logins share in-flight work within an isolate.
  Workers cancel a request's pending fetches when its client disconnects, even
  while other requests wait on them, so each shared job is registered with the
  starting request's `waitUntil` and runs until it settles (at most 20 seconds).
- Caches, the search admission limit, and the TypeSafe call budget are kept per
  isolate. Workers run more, shorter-lived isolates than a single server, so
  caches hit less often and cold isolates log in to Bluesky again.
- On the Workers Free plan a request gets 10 ms of CPU and 50 outbound requests.
  A full topic batch can make exactly 50 TypeSafe calls (25 posts, each retried
  once). The Paid plan lifts both limits.
