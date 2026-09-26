import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHighlightMatcher, ingestSearchPosts } from '../src/search-model.mjs';
import { state } from '../src/state.mjs';
import { getTopicProgress, getTopicVerdict, requestTopicScores } from '../src/topic-filter.mjs';
import { filterByDate, filterByLikes, sortPosts } from '../src/utils.mjs';

const now = Date.now();
const termResults = Array.from({ length: 10 }, (_, termIndex) =>
  Array.from({ length: 160 }, (_, index) => ({
    uri: `at://did:plc:test/app.bsky.feed.post/${index < 56 ? `shared${index}` : `t${termIndex}p${index}`}`,
    matchedTerm: `term${termIndex}`,
    likeCount: (index * 7 + termIndex) % 500,
    indexedAt: new Date(now - (index % 72) * 3600000).toISOString(),
    author: { did: 'did:plc:test', handle: 'perf.bsky.social' },
    record: { text: `post ${index} for term${termIndex}` },
  }))
);

function derive(posts) {
  return sortPosts(filterByLikes(filterByDate(posts, 24), 10), 'top');
}

function runProductionMerge() {
  const store = new Map();
  termResults.forEach((posts) => ingestSearchPosts(store, posts));
  return derive([...store.values()]);
}

const flattened = termResults.flat();
const expected = [...new Set(flattened.map((post) => post.uri))].map((uri) => {
  const versions = flattened.filter((post) => post.uri === uri);
  const matchedTerms = [...new Set(versions.map((post) => post.matchedTerm))];
  return { ...versions.at(-1), matchedTerm: matchedTerms[0], matchedTerms };
});
const inputSnapshot = JSON.stringify(termResults);
assert.deepEqual(runProductionMerge(), derive(expected));
assert.equal(JSON.stringify(termResults), inputSnapshot, 'Ingestion must not mutate fetched/cache data.');

const terms = Array.from({ length: 28 }, (_, index) => `term${index}`);
const text = Array.from({ length: 120 }, (_, index) => `token${index % 25} term${index % 28}`).join(' ');
const matcher = createHighlightMatcher(terms);
function highlightedParts(value, pattern) {
  return value.split(pattern.regex).filter((part) => pattern.termSet.has(part.toLowerCase()));
}
assert.equal(highlightedParts(text, matcher).length, 120);
assert.deepEqual(
  highlightedParts('ALPHA BETA a+b a.b café', createHighlightMatcher(['alpha', 'alpha beta', 'a+b', 'a.b', 'café'])),
  ['ALPHA BETA', 'a+b', 'a.b', 'café']
);

function measure(label, operation, runs, budgetMs) {
  for (let index = 0; index < 10; index += 1) operation();
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    operation();
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  const median = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  console.log(`${label}: median ${median.toFixed(3)}ms, p95 ${p95.toFixed(3)}ms (budget ${budgetMs}ms)`);
  assert.ok(p95 < budgetMs, `${label} exceeded its smoke-check budget.`);
}

const topicPosts = [...new Map(flattened.map((post, index) => [post.uri, {
  ...post,
  embed: {
    $type: 'app.bsky.embed.recordWithMedia#view',
    media: {
      $type: 'app.bsky.embed.external#view',
      external: { uri: `https://news.example/story/${index}`, title: `Story ${index} about term0`, description: `Details for story ${index}.` },
    },
    record: {
      record: {
        uri: `at://did:plc:quoted/app.bsky.feed.post/${index}`,
        author: { did: 'did:plc:quoted', handle: 'quoted.bsky.social', displayName: 'Quoted' },
        value: { text: `Quoted post ${index} about term1` },
      },
    },
  },
}])).values()];
state.rawSearchTerms = ['term0', 'term1', 'term2'];
globalThis.fetch = async (_url, { body }) => ({
  ok: true,
  status: 200,
  json: async () => ({
    results: JSON.parse(body).items.map((item) => ({
      id: item.id,
      scores: item.keywords.map((_keyword, index) => ((item.id.length + index) % 10) / 10),
    })),
  }),
});
requestTopicScores(topicPosts, () => {});
while (getTopicProgress(topicPosts).pending > 0) await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(topicPosts.every((post) => getTopicVerdict(post).verdict !== 'unknown'), 'Every perf post must have a topic verdict.');

function rebuildTopicVerdicts() {
  for (const post of topicPosts) getTopicVerdict(post);
  requestTopicScores(topicPosts, () => {});
  return getTopicProgress(topicPosts);
}

measure('Production merge/filter/sort (1600 records)', runProductionMerge, 60, 50);
measure('Production cached highlighting (120 matches)', () => highlightedParts(text, matcher), 200, 5);
measure(`Topic verdicts on an unchanged rebuild (${topicPosts.length} posts, 3 terms)`, rebuildTopicVerdicts, 60, 15);
console.log('Production performance and result-equivalence checks passed.');
