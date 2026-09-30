# Classifier rate limiting

The Worker limits topic classification per client IP with a Workers Rate
Limiting binding. The limit lives in `wrangler.jsonc` and deploys with the code;
there is no dashboard rule to configure.

| Setting | Value |
| --- | --- |
| Binding | `CLASSIFY_LIMITER` (namespace `1001`) |
| Requests counted | `POST` to `/api/classify` |
| Window / limit | 60 seconds / 30 requests |
| Counting key | `CF-Connecting-IP` |
| Exceeded response | 429 with `Retry-After: 60` |

`worker/index.mjs` checks the limit before the classifier handler runs, so a
limited request never reaches TypeSafe. Other methods and ordinary keyword
search are not counted. The namespace ID only has to be unique among the rate
limiters in the Cloudflare account.

Treat this as best-effort. Cloudflare documents the binding as permissive and
eventually consistent: counters are cached on each machine and synced in the
background. On the deployed Worker, 95 `POST`s from one IP in two minutes all
passed it, while `wrangler dev` refused everything after the 30th. The
same-origin check and the handler's own TypeSafe budget (below) still apply.

The limit counts HTTP batches, including cache hits. A full batch contains 25
posts and can make up to 50 TypeSafe calls when every post needs a retry. Three
queries returning 200 distinct posts each normally need at least 24 batches;
expansion, incremental results, and more than six original terms can need more.
Users sharing a public IP share the allowance. When limited, the app pauses its
queued checks, waits out the `Retry-After`, and resumes. Unchecked posts stay
visible meanwhile. After five limits in a row on the same batch it stops
checking for that search.

This is abuse throttling, not a global call or spending cap: Workers rate limit
counters are kept per Cloudflare location and are eventually consistent, so a
burst can slightly exceed the limit, and different IPs have separate
allowances. The handler also limits TypeSafe calls itself, per Worker isolate: a
600-call burst refilling at five calls per second, shared by every caller that
isolate serves. The app has two or three users, so there is no per-visitor
share; one visitor can use the whole allowance. The limit charges retries; a
retry it refuses leaves only that post unchecked, and the rest of its batch
still returns its scores. The handler accepts only same-origin browser
requests: `Sec-Fetch-Site: same-origin`, or a matching `Origin` from browsers
that do not send `Sec-Fetch-Site`. That stops cross-site pages and casual
scripts, not a caller who forges the headers. Keep TypeSafe automatic recharge
off when using a prepaid credit budget; throttling cannot guarantee that
existing credits will last.

Check the wiring under `npm run dev` with a bounded burst of invalid `POST`
bodies (`{}`), which cannot invoke TypeSafe: requests after the 30th in a
minute get 429 while the homepage and ordinary search remain reachable. The
deployed limiter may engage late or not at all at this volume.

Reference: [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
