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
const topicEntries = new WeakMap();
let keywordCache = { terms: null, keywords: [] };
let queue = [];
let activeRequests = 0;
let owner = null;
let unavailableReason = '';
let resumeTimer = null;
let resumeAt = 0;

const BATCH_ONLY_STATUSES = new Set([400, 413, 504]);
const RATE_LIMIT_DEFAULT_WAIT_MS = 60000;
const RATE_LIMIT_MAX_WAIT_MS = 120000;
const MAX_RATE_LIMITED_ATTEMPTS = 5;
const ADULT_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media']);

const scoreKey = (uri, keyword, context) => JSON.stringify([uri, keyword, context]);
const isScore = (value) => Number.isFinite(value) && value >= 0 && value <= 1;

function getTopicKeywords() {
  if (keywordCache.terms === state.rawSearchTerms) return keywordCache.keywords;
  const seen = new Set();
  const keywords = [];
  for (const term of state.rawSearchTerms) {
    const keyword = normalizeKeyword(term);
    const folded = keyword.toLowerCase();
    if (!keyword || seen.has(folded)) continue;
    seen.add(folded);
    keywords.push(keyword);
  }
  keywordCache = { terms: state.rawSearchTerms, keywords };
  return keywords;
}

function getTopicEntry(post, keywords) {
  let entry = topicEntries.get(post);
  if (!entry) {
    entry = { context: buildTopicContext(post), keywords: null, keys: [] };
    topicEntries.set(post, entry);
  }
  if (entry.keywords !== keywords) {
    entry.keywords = keywords;
    entry.keys = keywords.map((keyword) => scoreKey(post.uri, keyword, entry.context));
  }
  return entry;
}

function rememberScore(key, score) {
  scores.delete(key);
  scores.set(key, score);
}

const hasAdultLabel = (labels) => Array.isArray(labels)
  && labels.some((label) => !label?.neg && ADULT_LABELS.has(label?.val));

function getQuotedLabels(embed) {
  const quoted = embed?.$type === 'app.bsky.embed.recordWithMedia#view' ? embed.record?.record
    : embed?.$type === 'app.bsky.embed.record#view' ? embed.record
      : null;
  return quoted?.labels;
}

const isAdultPost = (post) => [post.labels, post.author?.labels, getQuotedLabels(post.embed)].some(hasAdultLabel);

export function getReachThreshold(post) {
  const likes = post.likeCount || 0;
  if (likes <= TOPIC_REACH_MIN_LIKES || isAdultPost(post)) return TOPIC_SCORE_THRESHOLD;
  const lowered = TOPIC_SCORE_THRESHOLD - TOPIC_REACH_STEP_PER_TENFOLD_LIKES * Math.log10(likes / TOPIC_REACH_MIN_LIKES);
  return Math.max(TOPIC_REACH_MIN_THRESHOLD, lowered);
}

export function getTopicVerdict(post) {
  const keywords = getTopicKeywords();
  const { keys } = getTopicEntry(post, keywords);
  let best = null;
  let complete = keywords.length > 0;
  for (const key of keys) {
    const score = scores.get(key);
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
    const { keys } = getTopicEntry(post, keywords);
    if (keys.some((key) => pending.has(key))) pendingPosts += 1;
    else if (keys.some((key) => failed.has(key)) && getTopicVerdict(post).verdict === 'unknown') failedPosts += 1;
  }
  return { pending: pendingPosts, failed: failedPosts, paused: resumeTimer !== null, unavailableReason };
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

function getRateLimitWaitMs(retryAfter) {
  const value = typeof retryAfter === 'string' ? retryAfter.trim() : '';
  const waitMs = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(waitMs)) return RATE_LIMIT_DEFAULT_WAIT_MS;
  return Math.min(RATE_LIMIT_MAX_WAIT_MS, Math.max(1000, waitMs));
}

function pauseForRateLimit(waitMs, onUpdate) {
  const until = Date.now() + waitMs;
  if (resumeTimer !== null && until <= resumeAt) return;
  clearTimeout(resumeTimer);
  resumeAt = until;
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    pump();
    onUpdate();
  }, waitMs);
}

async function runBatch(batch) {
  const { items, onUpdate, batchOwner } = batch;
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
  const canRetry = !unavailableReason && (batch.rateLimited ?? 0) < MAX_RATE_LIMITED_ATTEMPTS;
  if (error instanceof HttpError && error.status === 429 && canRetry) {
    batch.rateLimited = (batch.rateLimited ?? 0) + 1;
    queue.unshift(batch);
    pauseForRateLimit(getRateLimitWaitMs(error.retryAfter), onUpdate);
    onUpdate();
    return;
  }
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
  while (resumeTimer === null && activeRequests < TOPIC_REQUEST_CONCURRENCY && queue.length > 0) {
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
  const isUnchecked = (key) => !scores.has(key) && !pending.has(key) && !failed.has(key);
  for (const post of posts) {
    if (typeof post?.uri !== 'string' || !post.uri || post.uri.length > TOPIC_LIMITS.id) continue;
    const { context, keys } = getTopicEntry(post, topicKeywords);
    const keywords = topicKeywords.filter((_keyword, index) => isUnchecked(keys[index]));
    if (keywords.length === 0) continue;
    const uncheckedKeys = keys.filter(isUnchecked);
    if (!hasTopicEvidence(context)) {
      uncheckedKeys.forEach((key) => failed.add(key));
      continue;
    }
    uncheckedKeys.forEach((key) => pending.add(key));
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
  clearTimeout(resumeTimer);
  resumeTimer = null;
  queue = [];
  pending.clear();
}

export function restartTopicScoring() {
  cancelTopicScoring();
  failed.clear();
  unavailableReason = '';
}

export function resetTopicScoring() {
  restartTopicScoring();
  while (scores.size > MAX_TOPIC_SCORE_CACHE_SIZE) {
    scores.delete(scores.keys().next().value);
  }
}

export function clearTopicScoresForTests() {
  resetTopicScoring();
  scores.clear();
}
