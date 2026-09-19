import {
  CLASSIFY_API,
  MAX_TOPIC_SCORE_CACHE_SIZE,
  TOPIC_REQUEST_CONCURRENCY,
  TOPIC_REQUEST_TIMEOUT_MS,
  TOPIC_SCORE_THRESHOLD,
} from './constants.mjs';
import { HttpError, fetchJson } from './http.mjs';
import { getMatchedTermsForPost } from './search-model.mjs';
import { TOPIC_LIMITS, buildTopicContext, hasTopicEvidence, normalizeKeyword } from './topic-context.mjs';

// Probability that a post is about a keyword, keyed by post and keyword. A
// score is a fact about the post's content, so it outlives the search that
// asked for it; pending and failed keys belong to the current search only.
const scores = new Map();
const pending = new Set();
const failed = new Set();
let queue = [];
let activeRequests = 0;
// Owns every request of the current search. Replacing it orphans older
// requests, whose late results must not touch the newer search's bookkeeping.
let owner = null;
let unavailableReason = '';

// One bad batch says nothing about the next; every other HTTP failure (not
// configured, rejected credentials, rate limited, no such route) would repeat.
const BATCH_ONLY_STATUSES = new Set([400, 413, 504]);

const scoreKey = (uri, keyword) => JSON.stringify([uri, keyword]);
const isScore = (value) => Number.isFinite(value) && value >= 0 && value <= 1;

function getTopicKeywords(post) {
  const seen = new Set();
  const keywords = [];
  for (const term of getMatchedTermsForPost(post)) {
    const keyword = normalizeKeyword(term);
    const folded = keyword.toLowerCase();
    if (!keyword || seen.has(folded)) continue;
    seen.add(folded);
    keywords.push(keyword);
  }
  return keywords.slice(0, TOPIC_LIMITS.maxKeywords);
}

function rememberScore(key, score) {
  scores.delete(key);
  scores.set(key, score);
  while (scores.size > MAX_TOPIC_SCORE_CACHE_SIZE) {
    scores.delete(scores.keys().next().value);
  }
}

// A post stays visible until every keyword it matched has scored low: results
// appear first and scores arrive after, and an unchecked post is never hidden.
export function getTopicVerdict(post) {
  const keywords = getTopicKeywords(post);
  let best = null;
  let complete = keywords.length > 0;
  for (const keyword of keywords) {
    const score = scores.get(scoreKey(post.uri, keyword));
    if (score === undefined) complete = false;
    else if (best === null || score > best) best = score;
  }
  if (best !== null && best >= TOPIC_SCORE_THRESHOLD) return { verdict: 'on', score: best };
  if (complete) return { verdict: 'off', score: best };
  return { verdict: 'unknown', score: best };
}

export function getTopicProgress(posts) {
  let pendingPosts = 0;
  let failedPosts = 0;
  for (const post of posts) {
    const keys = getTopicKeywords(post).map((keyword) => scoreKey(post.uri, keyword));
    if (keys.some((key) => pending.has(key))) pendingPosts += 1;
    else if (keys.some((key) => failed.has(key)) && getTopicVerdict(post).verdict === 'unknown') failedPosts += 1;
  }
  return { pending: pendingPosts, failed: failedPosts, unavailableReason };
}

function settleBatch(items, results) {
  const byId = new Map((Array.isArray(results) ? results : []).map((result) => [result?.id, result?.scores]));
  for (const item of items) {
    const returned = byId.get(item.id);
    item.keywords.forEach((keyword, index) => {
      const key = scoreKey(item.id, keyword);
      const score = Array.isArray(returned) ? returned[index] : null;
      pending.delete(key);
      if (isScore(score)) rememberScore(key, score);
      else failed.add(key);
    });
  }
}

async function runBatch({ items, onUpdate, batchOwner }) {
  let results = null;
  let error = null;
  try {
    const data = await fetchJson(CLASSIFY_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
      signal: batchOwner.signal,
      timeoutMs: TOPIC_REQUEST_TIMEOUT_MS,
    });
    results = data?.results;
  } catch (caught) {
    error = caught;
  }
  if (batchOwner !== owner) return;
  settleBatch(items, results);
  if (error instanceof HttpError && !BATCH_ONLY_STATUSES.has(error.status)) {
    unavailableReason = error.message;
    for (const queued of queue) settleBatch(queued.items, null);
    queue = [];
  }
  onUpdate();
}

function pump() {
  while (activeRequests < TOPIC_REQUEST_CONCURRENCY && queue.length > 0) {
    const batch = queue.shift();
    activeRequests += 1;
    runBatch(batch).finally(() => {
      activeRequests -= 1;
      pump();
    });
  }
}

// Queues every post that still lacks a score. Safe to call on every rebuild:
// keys that are scored, in flight, or already failed are skipped. `onUpdate`
// runs after each batch that belongs to the current search.
export function requestTopicScores(posts, onUpdate) {
  if (unavailableReason) return;
  const items = [];
  for (const post of posts) {
    if (typeof post?.uri !== 'string' || !post.uri || post.uri.length > TOPIC_LIMITS.id) continue;
    const keywords = getTopicKeywords(post).filter((keyword) => {
      const key = scoreKey(post.uri, keyword);
      return !scores.has(key) && !pending.has(key) && !failed.has(key);
    });
    if (keywords.length === 0) continue;
    const context = buildTopicContext(post);
    if (!hasTopicEvidence(context)) {
      // Nothing to judge, such as an image without a description. It stays visible.
      keywords.forEach((keyword) => failed.add(scoreKey(post.uri, keyword)));
      continue;
    }
    keywords.forEach((keyword) => pending.add(scoreKey(post.uri, keyword)));
    items.push({ id: post.uri, keywords, context });
  }
  if (items.length === 0) return;
  owner ??= new AbortController();
  for (let start = 0; start < items.length; start += TOPIC_LIMITS.maxItems) {
    queue.push({ items: items.slice(start, start + TOPIC_LIMITS.maxItems), onUpdate, batchOwner: owner });
  }
  pump();
}

export function cancelTopicScoring() {
  owner?.abort();
  owner = null;
  queue = [];
  pending.clear();
}

// A new search retries what the previous one could not check.
export function resetTopicScoring() {
  cancelTopicScoring();
  failed.clear();
  unavailableReason = '';
}

export function clearTopicScoresForTests() {
  resetTopicScoring();
  scores.clear();
}
