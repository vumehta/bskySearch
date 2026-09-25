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
intended business and its products counts. Idioms and generic verbs built on a
brand name, such as "Netflix and chill" or "google it", are another word sense.

A mention alone does not qualify: source credits, promotional hashtags,
follow-me requests, casual photo sharing, and unrelated commentary are excluded.
The searched subject does not have to be the only subject, but the useful
information must be about it. An official author does not qualify automatically.

A post needs a 30% match to stay. Jev's score decides; likes only lower the bar
for weaker matches. Above 50 likes the cutoff drops by 10 points for every
tenfold increase in likes (about 20% at 500 likes and 13% at 2,500) down to a
floor of 10% at 5,000 likes or more. A post below 10% always stays hidden,
however popular it is, but a weak match above the floor can stay once it has
enough likes: a 13% match stays from about 2,500 likes. The cutoff stays at 30%
whatever the likes when a porn, sexual, nudity, or graphic-media label that is
not negated is on the post, on its author's account, or on the post it quotes,
because likes say little about importance there. Posts kept only because of
their likes are labelled "High reach" next to their match percentage. The
browser applies this rule when it renders, so a post that gains likes needs no
second check. The constants live in `src/constants.mjs`.

`buildTopicQuestion` in `api/classify.mjs` defines the rubric. It asks one Noul
per original search term, sharing the evidence in one request per post.
The server hashes the entire question with its evidence, so rubric changes
invalidate earlier scores. Unchecked posts remain visible and hidden posts can
be revealed using **Show them**. While the filter is enabled, a post shows its
match percentage once its verdict is decided, whether or not hidden posts are
revealed; a post whose verdict still waits on other terms shows none.
Percentages are rounded down, so a hidden 29.6% match reads 29%, never the 30%
cutoff.

Only the posts you can see, plus the next step, are checked. Going down the
sorted results, the browser checks posts until it has passed the number shown
(200 at first) plus one **Show more** step of 100, not counting posts hidden as
off-topic. **Show more** and **Load More** widen this window when they show
more posts. Posts beyond it stay visible and unchecked, and the summary does
not count them as being checked or as failed.

A batch of up to 25 posts has 20 seconds on the server. When that runs out, the
server returns the scores that finished and the remaining posts stay visible as
unchecked. Changes to **Min. Likes** apply once typing pauses (or on Enter, or
when the topic filter is toggled). While a change is pending, queued checks are
dropped and no new ones start; checks already in flight finish. Once the change
applies, only posts that meet it are queued again. `vercel.json` enables request
cancellation, so a batch the browser abandons stops calling TypeSafe.

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
