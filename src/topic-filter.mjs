import { isVerifiedAuthor } from './author-badges.mjs';
import {
  CLASSIFY_API,
  MAX_TOPIC_SCORE_CACHE_SIZE,
  TOPIC_MENTION_THRESHOLD,
  TOPIC_REACH_MIN_LIKES,
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

function rememberScores(key, entry) {
  scores.delete(key);
  scores.set(key, entry);
}

function isFullyScored(key) {
  const entry = scores.get(key);
  return entry?.topic !== undefined && entry?.mention !== undefined;
}

function getReachReason(post) {
  if ((post.likeCount || 0) >= TOPIC_REACH_MIN_LIKES) return 'High reach';
  if (isVerifiedAuthor(post.author)) return 'Verified author';
  return null;
}

export function getTopicVerdict(post) {
  const context = buildTopicContext(post);
  const keywords = getTopicKeywords();
  const reach = getReachReason(post);
  let best = null;
  let bestMention = null;
  let complete = keywords.length > 0;
  for (const keyword of keywords) {
    const { topic: score, mention } = scores.get(scoreKey(post.uri, keyword, context)) || {};
    if (score === undefined) complete = false;
    else if (best === null || score > best) best = score;
    if (!reach) continue;
    if (mention === undefined) complete = false;
    else if (bestMention === null || mention > bestMention) bestMention = mention;
  }
  if (best !== null && best >= TOPIC_SCORE_THRESHOLD) return { verdict: 'on', score: best };
  if (bestMention !== null && bestMention >= TOPIC_MENTION_THRESHOLD) return { verdict: 'on', score: best, keptFor: reach };
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

const scoreAt = (values, index) => (Array.isArray(values) && isScore(values[index]) ? values[index] : undefined);

function settleBatch(items, results) {
  const byId = new Map((Array.isArray(results) ? results : []).map((result) => [result?.id, result]));
  for (const item of items) {
    const returned = byId.get(item.id);
    item.keywords.forEach((keyword, index) => {
      const key = scoreKey(item.id, keyword, item.context);
      const entry = { ...scores.get(key) };
      entry.topic = scoreAt(returned?.scores, index) ?? entry.topic;
      entry.mention = scoreAt(returned?.mentionScores, index) ?? entry.mention;
      pending.delete(key);
      if (entry.topic !== undefined || entry.mention !== undefined) rememberScores(key, entry);
      if (!isFullyScored(key)) failed.add(key);
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
      return !isFullyScored(key) && !pending.has(key) && !failed.has(key);
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
