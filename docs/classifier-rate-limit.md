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
Users sharing a public IP share the allowance. When limited, the app stops
queued classification for that search and keeps unchecked posts visible.
Ordinary keyword search does not match this rule.

This is abuse throttling, not a global call or spending cap: Vercel counters are
per region, and different IPs have separate allowances. The handler's existing
600-call burst / five-call-per-second refill remains per instance and also
charges retries. Keep TypeSafe automatic recharge off when using a prepaid
credit budget; throttling cannot guarantee that existing credits will last.

Validate enforcement with a bounded burst of invalid `POST` bodies (`{}`),
which cannot invoke TypeSafe, then confirm excess requests get 429 while the
homepage and ordinary search remain reachable. Recheck after the window resets.

References: [Vercel rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting),
[rule configuration](https://vercel.com/docs/vercel-firewall/vercel-waf/rule-configuration).
