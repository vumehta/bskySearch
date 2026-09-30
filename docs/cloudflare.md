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

`npm run deploy` builds and deploys; run `npx wrangler login` first on a new
machine. The first deploy creates the custom domain's DNS record and
certificate, and fails if the hostname already has a DNS record.
`npx wrangler rollback` returns to the previous version. CI bundles the Worker
with `wrangler deploy --dry-run` on every push, without deploying.

Keep Rocket Loader, Email Obfuscation, and automatic Web Analytics injection off
for the zone. The Content Security Policy allows only the site's own scripts, so
anything Cloudflare injects would be blocked.

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
