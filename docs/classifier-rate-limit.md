# Classifier rate limiting on Vercel

Configure this project firewall rule before enabling `TYPESAFE_API_KEY` on a
public deployment. It uses Vercel's managed counters and requires no database
or application dependency. Firewall settings live in Vercel, not `vercel.json`.

| Setting | Value |
| --- | --- |
| Name | Limit topic classification |
| Conditions (AND) | Request Path starts with `/api/classify`; Method equals `POST` |
| Algorithm | Fixed Window |
| Window / limit | 60 seconds / 30 requests |
| Counting key | IP Address only |
| Exceeded action | Too Many Requests (429) |
| Persistent action duration | None |

Leave hostname and environment unrestricted so the rule covers production,
previews, and deployment aliases. The path prefix also covers trailing slashes
and extension variants. Avoid an earlier bypass rule that skips this limit.
In **Firewall → Rules**, add the rule, review the pending changes, and publish
only the intended change. It fits the Hobby plan's single rate-limit rule slot.

The limit counts HTTP batches, including cache hits. A full batch contains 25
posts and can make up to 50 TypeSafe calls when every post needs a retry. Three
queries returning 200 distinct posts each normally need at least 24 batches;
expansion, incremental results, and more than six original terms can need more.
Users sharing a public IP share the allowance. When limited, the app pauses its
queued checks, waits out the `Retry-After` (a minute when there is none), and
resumes. Unchecked posts stay visible meanwhile. After five limits in a row on
the same batch it stops checking for that search. Ordinary keyword search does
not match this rule.

This is abuse throttling, not a global call or spending cap: Vercel counters are
per region, and different IPs have separate allowances. The handler also limits
TypeSafe calls itself, per instance: a 600-call burst refilling at five calls per
second, of which each client IP may use at most half (a 300-call burst refilling
at 2.5 per second). One visitor therefore cannot use up an instance's allowance;
a very large search from one visitor slows down instead. Both limits charge
retries; a retry they refuse leaves only that post unchecked, and the rest of
its batch still returns its scores. The handler accepts only same-origin
browser requests: `Sec-Fetch-Site: same-origin`, or a matching `Origin` from
browsers that do not send `Sec-Fetch-Site`. That stops cross-site pages and
casual scripts, not a caller who forges the headers. Keep TypeSafe automatic recharge off when using a
prepaid credit budget; throttling cannot guarantee that existing credits will
last.

Validate enforcement with a bounded burst of invalid `POST` bodies (`{}`),
which cannot invoke TypeSafe, then confirm excess requests get 429 while the
homepage and ordinary search remain reachable. Recheck after the window resets.

References: [Vercel rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting),
[rule configuration](https://vercel.com/docs/vercel-firewall/vercel-waf/rule-configuration).
