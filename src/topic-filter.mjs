import {
  CLASSIFY_API,
  MAX_TOPIC_SCORE_CACHE_SIZE,
  TOPIC_REACH_MIN_LIKES,
  TOPIC_REACH_MIN_THRESHOLD,
  TOPIC_REACH_STEP_PER_TENFOLD_LIKES,
  TOPIC_REQUEST_CONCURRENCY,
  TOPIC_REQUEST_TIMEOUT_MS,
  TOPIC_SCORE_THRESHOLD,
} from './constants.mjs';
import { HttpError, fetchJson } from './http.mjs';
import { state } from './state.mjs';
import { TOPIC_LIMITS, buildTopicContext, hasTopicEvidence, normalizeKeyword } from './topic-context.mjs';

const scores = new Map();
const pending = new Set();
const failed = new Set();
let queue = [];
let activeRequests = 0;
let owner = null;
let unavailableReason = '';

const BATCH_ONLY_STATUSES = new Set([400, 413, 504]);
const ADULT_LABELS = new Set(['porn', 'sexual', 'nudity']);

const scoreKey = (uri, keyword, context) => JSON.stringify([uri, keyword, context]);
const isScore = (value) => Number.isFinite(value) && value >= 0 && value <= 1;

function getTopicKeywords() {
  const seen = new Set();
  const keywords = [];
  for (const term of state.rawSearchTerms) {
    const keyword = normalizeKeyword(term);
    const folded = keyword.toLowerCase();
    if (!keyword || seen.has(folded)) continue;
    seen.add(folded);
    keywords.push(keyword);
  }
  return keywords;
}

function rememberScore(key, score) {
  scores.delete(key);
  scores.set(key, score);
}

const hasAdultLabel = (post) => Array.isArray(post.labels)
  && post.labels.some((label) => !label?.neg && ADULT_LABELS.has(label?.val));

export function getReachThreshold(post) {
  const likes = post.likeCount || 0;
  if (likes <= TOPIC_REACH_MIN_LIKES || hasAdultLabel(post)) return TOPIC_SCORE_THRESHOLD;
  const lowered = TOPIC_SCORE_THRESHOLD - TOPIC_REACH_STEP_PER_TENFOLD_LIKES * Math.log10(likes / TOPIC_REACH_MIN_LIKES);
  return Math.max(TOPIC_REACH_MIN_THRESHOLD, lowered);
}

export function getTopicVerdict(post) {
  const context = buildTopicContext(post);
  const keywords = getTopicKeywords();
  let best = null;
  let complete = keywords.length > 0;
  for (const keyword of keywords) {
    const score = scores.get(scoreKey(post.uri, keyword, context));
    if (score === undefined) complete = false;
    else if (best === null || score > best) best = score;
  }
  if (best !== null && best >= TOPIC_SCORE_THRESHOLD) return { verdict: 'on', score: best };
  if (best !== null && best >= getReachThreshold(post)) return { verdict: 'on', score: best, keptFor: 'High reach' };
  if (complete) return { verdict: 'off', score: best };
  return { verdict: 'unknown', score: best };
}

export function getTopicProgress(posts) {
  let pendingPosts = 0;
  let failedPosts = 0;
  const keywords = getTopicKeywords();
  for (const post of posts) {
    const context = buildTopicContext(post);
    const keys = keywords.map((keyword) => scoreKey(post.uri, keyword, context));
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
      const key = scoreKey(item.id, keyword, item.context);
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
    unavailableReason = error.status === 429
      ? 'Too many topic checks. Try again in a minute.'
      : error.message;
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

export function requestTopicScores(posts, onUpdate) {
  if (unavailableReason) return;
  const rounds = [];
  const topicKeywords = getTopicKeywords();
  for (const post of posts) {
    if (typeof post?.uri !== 'string' || !post.uri || post.uri.length > TOPIC_LIMITS.id) continue;
    const context = buildTopicContext(post);
    const keywords = topicKeywords.filter((keyword) => {
      const key = scoreKey(post.uri, keyword, context);
      return !scores.has(key) && !pending.has(key) && !failed.has(key);
    });
    if (keywords.length === 0) continue;
    if (!hasTopicEvidence(context)) {
      keywords.forEach((keyword) => failed.add(scoreKey(post.uri, keyword, context)));
      continue;
    }
    keywords.forEach((keyword) => pending.add(scoreKey(post.uri, keyword, context)));
    for (let start = 0; start < keywords.length; start += TOPIC_LIMITS.maxKeywords) {
      const round = start / TOPIC_LIMITS.maxKeywords;
      rounds[round] ??= [];
      rounds[round].push({ id: post.uri, keywords: keywords.slice(start, start + TOPIC_LIMITS.maxKeywords), context });
    }
  }
  if (rounds.length === 0) return;
  owner ??= new AbortController();
  for (const items of rounds) {
    for (let start = 0; start < items.length; start += TOPIC_LIMITS.maxItems) {
      queue.push({ items: items.slice(start, start + TOPIC_LIMITS.maxItems), onUpdate, batchOwner: owner });
    }
  }
  pump();
}

export function dropQueuedTopicScores() {
  for (const { items } of queue) {
    for (const item of items) {
      item.keywords.forEach((keyword) => pending.delete(scoreKey(item.id, keyword, item.context)));
    }
  }
  queue = [];
}

export function cancelTopicScoring() {
  owner?.abort();
  owner = null;
  queue = [];
  pending.clear();
}

export function resetTopicScoring() {
  cancelTopicScoring();
  failed.clear();
  unavailableReason = '';
  while (scores.size > MAX_TOPIC_SCORE_CACHE_SIZE) {
    scores.delete(scores.keys().next().value);
  }
}

export function clearTopicScoresForTests() {
  resetTopicScoring();
  scores.clear();
}
