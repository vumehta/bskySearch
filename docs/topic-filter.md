# Topic filter

The filter keeps analysis and substantive news about a searched company,
platform, or its products and services. Concrete developments, reasoned
criticism, useful comparisons, and specific product experiences qualify. So do
opinions and calls to action that give a business reason, such as a boycott over
price increases, including when the same criticism names several companies.
The evidence can come from the post, a link preview, a quote, or image alt text.

All keywords share one business/product intent, regardless of capitalization:
Intel means the chip company, Apple the technology company, and Meta the
technology company. Intelligence reports, fruit, gaming metas, and other word
senses do not qualify even when they contain substantive analysis. The same
rule covers Instagram, WhatsApp, Netflix, and other company or platform names;
there are no separate keyword-specific questions or product lists to tune.
Clearly identifiable products can establish relevance without repeating the
company name. When both meanings appear, only the information about the
intended business and its products counts.

A mention alone does not qualify: source credits, promotional hashtags,
follow-me requests, casual photo sharing, and unrelated commentary are excluded.
The searched subject does not have to be the only subject, but the useful
information must be about it. An official author does not qualify automatically.

Posts with reach get a lower bar. A post with at least 50 likes, or from a
verified account, stays when it says anything about the company: a joke, an
unsupported complaint, or a bare call to cancel counts. Credits, hashtags, and
other word senses still do not. The card labels these posts "High reach" or
"Verified author" next to their match percentage.

`buildTopicQuestion` in `api/classify.mjs` defines the rubric, and
`buildMentionQuestion` defines the lower bar. Each original search term gets
both Nouls, sharing the evidence in one request per post, so a post that later
reaches 50 likes needs no second check. The browser applies the reach rule.
The server hashes the entire question with its evidence, so rubric changes
invalidate earlier scores. Unchecked posts remain visible and hidden posts can
be revealed using **Show them**. While the filter is enabled, match percentages
appear as scores arrive, whether or not hidden posts are revealed.

## Evaluate a rubric change

`tests/fixtures/topic-eval.json` contains hand-labeled examples, including
adaptations of the three reported Instagram false positives. These are test
inputs, not verified news reports. Explicit details and account identities from
the reported posts are omitted when they are not relevant to classification.
The set also covers Intel versus intelligence (including both senses in one
post), Apple versus fruit, Meta versus gaming, and product or service news.

Set `TYPESAFE_API_KEY` in the terminal environment, then run `npm.cmd run eval:topic`
(or `npm run eval:topic`). This makes live, billable requests through the same
handler used in production and exits unsuccessfully for wrong or missing answers.
Set `TYPESAFE_MODEL` to a versioned model ID when comparing rubric changes.

Normal unit and browser tests use mocked answers. They check request handling
and UI behavior; they do not establish Jev's classification accuracy. The small
evaluation set is a starting check, not a representative accuracy benchmark.
