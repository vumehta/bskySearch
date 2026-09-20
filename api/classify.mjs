import { TOPIC_JOB_TIMEOUT_MS } from '../src/constants.mjs';
import {
  TOPIC_LIMITS,
  hasTopicEvidence,
  normalizeKeyword,
  sanitizeTopicContext,
} from '../src/topic-context.mjs';

// TypeSafe's Jev answers typed questions about a piece of state with
// probabilities instead of prose. A "noul" is the probability of yes.
const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';

// The deadline includes response headers and JSON body consumption.
const UPSTREAM_TIMEOUT_MS = 8000;
const UPSTREAM_CONCURRENCY = 8;
const UPSTREAM_RETRY_DELAY_MS = 300;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

const MAX_BODY_CHARS = 256 * 1024;

// A score depends only on the question and the evidence, so it is cached under
// a hash of exactly those. A caller cannot plant a score for a real post,
// because a different text is a different key.
const SCORE_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_SCORE_CACHE_SIZE = 5000;

// Per-instance limit on upstream calls, which are what cost money. Cache hits
// are free. Pair this with Vercel's per-IP firewall rule; see
// docs/classifier-rate-limit.md. Neither guard is an account-wide cost ceiling.
export const CLASSIFY_ADMISSION_LIMITS = Object.freeze({
  burst: 600,
  refillPerSecond: 5,
});

const scoreCache = new Map();
let admissionTokens = CLASSIFY_ADMISSION_LIMITS.burst;
let admissionUpdatedAt = null;

function httpError(message, status, headers = {}) {
  const error = new Error(message);
  error.status = status;
  error.headers = headers;
  return error;
}

function abortError() {
  return new DOMException('Request cancelled.', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function getRuntimeEnv(context) {
  if (context && typeof context === 'object' && 'env' in context) {
    return context.env || {};
  }
  return process.env;
}

function jsonNoStore(payload, status = 200, extraHeaders = {}) {
  return Response.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

// The wording decides what counts as on-topic, so it lives in one place.
//
// The question is about the sense of the word, not its prominence. An earlier
// version asked whether the company was "a main subject" and scored real
// mentions at 0.2-0.3: an ad tracker covering "meta and Google", a list of big
// tech firms, a parenthetical "(Meta)". Those are wanted. What is not wanted is
// the gaming meta, "that's so meta", or an apple pie.
//
// Products and services are deliberately included: a post about a show, an
// app, or a device refers to the company that makes it.
export function buildTopicQuestion(keyword) {
  return {
    type: 'noul',
    instructions:
      `Does this social media post refer to the company, brand, or organisation called "${keyword}", ` +
      'or to any of its products or services? Consider the post text, its link card, its image descriptions, ' +
      'its author, and any post it quotes.',
    criteria: {
      true:
        `"${keyword}" the company, brand, or organisation, or one of its products, services, shows, apps, devices, ` +
        'platforms, or executives, is mentioned or discussed somewhere in the post, its link card, its image ' +
        'descriptions, or the post it quotes. A brief mention counts, and so does a mention alongside other ' +
        'companies. A post published by the official account of that company also counts.',
      false:
        `Nothing in the post refers to that company. The word "${keyword}" is either absent or used with a ` +
        'different meaning, such as an ordinary word, slang, a game term, or a different thing with the same name.',
    },
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Malformed input is a client bug, so the whole request is rejected rather
// than partially served.
function parseItems(payload) {
  if (!isObject(payload) || !Array.isArray(payload.items)) {
    throw httpError('Expected a JSON body with an items array.', 400);
  }
  const { items } = payload;
  if (items.length === 0 || items.length > TOPIC_LIMITS.maxItems) {
    throw httpError(`Send between 1 and ${TOPIC_LIMITS.maxItems} items.`, 400);
  }
  return items.map((item, index) => {
    if (!isObject(item)) throw httpError(`Item ${index} is not an object.`, 400);
    const { id, keywords } = item;
    if (typeof id !== 'string' || !id || id.length > TOPIC_LIMITS.id) {
      throw httpError(`Item ${index} has an invalid id.`, 400);
    }
    if (!Array.isArray(keywords) || keywords.length === 0 || keywords.length > TOPIC_LIMITS.maxKeywords) {
      throw httpError(`Item ${index} needs between 1 and ${TOPIC_LIMITS.maxKeywords} keywords.`, 400);
    }
    const normalizedKeywords = keywords.map(normalizeKeyword);
    if (normalizedKeywords.some((keyword) => !keyword)) {
      throw httpError(`Item ${index} has an empty keyword.`, 400);
    }
    const context = sanitizeTopicContext(item.context);
    if (!hasTopicEvidence(context)) {
      throw httpError(`Item ${index} has no post content to judge.`, 400);
    }
    return { id, keywords: normalizedKeywords, context };
  });
}

async function readJsonBody(request) {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_CHARS) {
    throw httpError('Request body is too large.', 413);
  }
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) throw httpError('Request body is too large.', 413);
  try {
    return JSON.parse(text);
  } catch {
    throw httpError('Request body is not valid JSON.', 400);
  }
}

// The question is part of the key, so rewording it never serves old scores.
async function getScoreCacheKey(keyword, context) {
  const bytes = new TextEncoder().encode(JSON.stringify([buildTopicQuestion(keyword), context]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getCachedScore(cacheKey) {
  const cached = scoreCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > SCORE_CACHE_TTL_MS) {
    scoreCache.delete(cacheKey);
    return null;
  }
  // Refresh insertion order so eviction drops the least recently used entry.
  scoreCache.delete(cacheKey);
  scoreCache.set(cacheKey, cached);
  return cached.score;
}

function cacheScore(cacheKey, score) {
  scoreCache.delete(cacheKey);
  scoreCache.set(cacheKey, { score, timestamp: Date.now() });
  while (scoreCache.size > MAX_SCORE_CACHE_SIZE) {
    scoreCache.delete(scoreCache.keys().next().value);
  }
}

function admitUpstreamCalls(calls) {
  const now = Date.now();
  if (admissionUpdatedAt !== null) {
    admissionTokens = Math.min(
      CLASSIFY_ADMISSION_LIMITS.burst,
      admissionTokens +
        (Math.max(0, now - admissionUpdatedAt) / 1000) * CLASSIFY_ADMISSION_LIMITS.refillPerSecond,
    );
  }
  admissionUpdatedAt = Math.max(admissionUpdatedAt ?? now, now);
  if (admissionTokens < calls) {
    const retryAfter = Math.ceil((calls - admissionTokens) / CLASSIFY_ADMISSION_LIMITS.refillPerSecond);
    throw httpError('Too many topic checks. Please try again shortly.', 429, {
      'Retry-After': String(retryAfter),
    });
  }
  admissionTokens -= calls;
}

function upstreamTimeoutError() {
  return new DOMException('Upstream request timed out.', 'TimeoutError');
}

// Resolves to { status, payload, retryAfter }. Rejects on caller cancellation, on timeout,
// and on network failure.
async function postToTypeSafe(body, apiKey, signal) {
  throwIfAborted(signal);
  const controller = new AbortController();
  let timedOut = false;
  let responseMeta = null;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let rejectOnAbort;
  // Racing the abort also bounds fetch adapters that ignore the signal.
  const aborted = new Promise((_, reject) => {
    rejectOnAbort = () => reject(timedOut ? upstreamTimeoutError() : abortError());
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);

  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(TYPESAFE_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        responseMeta = { status: response.status, retryAfter: response.headers?.get('retry-after') };
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          // A non-JSON body must not hide the upstream HTTP status.
        }
        return { ...responseMeta, payload };
      })(),
      aborted,
    ]);
  } catch (error) {
    throwIfAborted(signal);
    // A stalled error body must not discard its HTTP status or Retry-After.
    if (timedOut && responseMeta && (responseMeta.status < 200 || responseMeta.status > 299)) {
      return { ...responseMeta, payload: null };
    }
    if (timedOut) throw upstreamTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectOnAbort);
  }
}

// Retry-After can be a delay in seconds or an HTTP date. Invalid or past
// values use the normal retry delay; an excessive delay is skipped below.
function getRetryDelayMs(value) {
  if (typeof value !== 'string' || !value.trim()) return UPSTREAM_RETRY_DELAY_MS;
  const trimmed = value.trim();
  const delay = /^\d+(?:\.\d+)?$/.test(trimmed)
    ? Number(trimmed) * 1000
    : Date.parse(trimmed) - Date.now();
  return Number.isNaN(delay) ? UPSTREAM_RETRY_DELAY_MS : Math.max(UPSTREAM_RETRY_DELAY_MS, delay);
}

function abortableDelay(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// A failed post only shows up as an unscored result, so the reason is logged
// for whoever reads the function logs. Never the key; at most a short excerpt
// of the classifier's own error text.
function describeUpstreamFailure(payload) {
  const detail = payload?.detail ?? payload?.error ?? payload?.message ?? '';
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return (text || 'no error body').slice(0, 300);
}

// One upstream call answers every keyword for one post, because questions
// over the same state share its tokens. Returns a score per keyword, or null
// where the classifier gave no usable answer. Rejected credentials fail the
// whole request instead: no later call can succeed either.
async function scoreItem(keywords, context, { apiKey, model, signal, deadlineAt }) {
  const questions = Object.fromEntries(keywords.map((keyword, index) => [`k${index}`, buildTopicQuestion(keyword)]));
  const body = { model, state: context, questions };
  const unscored = keywords.map(() => null);
  let retryDelayMs = UPSTREAM_RETRY_DELAY_MS;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfAborted(signal);
    if (attempt > 0) {
      // Preserve completed scores when the requested wait cannot fit. Never
      // shorten the provider's delay just to squeeze in another attempt.
      if (retryDelayMs >= deadlineAt - Date.now()) return unscored;
      await abortableDelay(retryDelayMs, signal);
    }
    throwIfAborted(signal);
    // First attempts are reserved together; each retry needs another token.
    // Keep admission outside the network-error catch so a local limit cannot retry.
    if (attempt > 0) admitUpstreamCalls(1);
    let result;
    try {
      result = await postToTypeSafe(body, apiKey, signal);
    } catch (error) {
      throwIfAborted(signal);
      // Timeouts and network failures are retried once, then given up on.
      if (attempt === 0) continue;
      console.warn('Topic classifier unreachable:', error?.name || 'Error', error?.message || '');
      return unscored;
    }
    if (result.status === 401 || result.status === 403) {
      throw httpError('The topic classifier rejected the server credentials.', 502);
    }
    if (RETRYABLE_STATUSES.has(result.status) && attempt === 0) {
      retryDelayMs = getRetryDelayMs(result.retryAfter);
      continue;
    }
    if (result.status < 200 || result.status > 299) {
      console.warn(`Topic classifier answered ${result.status}:`, describeUpstreamFailure(result.payload));
      return unscored;
    }
    const answers = isObject(result.payload?.answers) ? result.payload.answers : {};
    const scores = keywords.map((_, index) => {
      const score = answers[`k${index}`]?.noul;
      return Number.isFinite(score) && score >= 0 && score <= 1 ? score : null;
    });
    if (scores.includes(null)) console.warn('Topic classifier returned an answer without a usable score.');
    return scores;
  }
  return unscored;
}

// A task only throws for a reason that dooms the rest too (cancellation or
// rejected credentials, or admission limits), so no later tasks start after one.
async function runWithConcurrency(tasks, concurrency) {
  let nextIndex = 0;
  let stopped = false;
  async function worker() {
    while (!stopped && nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        await tasks[index]();
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

async function classifyItems(items, options) {
  const results = [];
  const tasks = [];
  for (const item of items) {
    const cacheKeys = await Promise.all(item.keywords.map((keyword) => getScoreCacheKey(keyword, item.context)));
    const scores = cacheKeys.map(getCachedScore);
    results.push({ id: item.id, scores });
    const missing = scores.flatMap((score, index) => (score === null ? [index] : []));
    if (missing.length === 0) continue;
    tasks.push(async () => {
      const fresh = await scoreItem(missing.map((index) => item.keywords[index]), item.context, options);
      missing.forEach((keywordIndex, position) => {
        const score = fresh[position];
        if (score === null) return;
        scores[keywordIndex] = score;
        cacheScore(cacheKeys[keywordIndex], score);
      });
    });
  }
  if (tasks.length > 0) {
    // Start only when the whole first round fits, avoiding partially admitted
    // batches whose in-flight calls would immediately be cancelled.
    admitUpstreamCalls(tasks.length);
    await runWithConcurrency(tasks, UPSTREAM_CONCURRENCY);
  }
  return results;
}

// Scores that arrive before the deadline are already cached, so retrying a
// timed-out request only pays for the posts that were still outstanding.
function withDeadline(start, signal, timeoutMs) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(httpError('Topic check timed out.', 504));
      controller.abort();
    }, timeoutMs);
  });
  const deadlineAt = Date.now() + timeoutMs;
  const work = Promise.resolve().then(() => start(controller.signal, deadlineAt));
  // The loser of the race may still reject after the winner settles.
  work.catch(() => {});
  return Promise.race([work, deadline]).finally(() => {
    // An early batch failure must also stop the other workers and retry waits.
    controller.abort();
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  });
}

export async function POST(request, context) {
  if (request.method !== 'POST') {
    return jsonNoStore({ error: 'Method not allowed.' }, 405, { Allow: 'POST' });
  }

  const { TYPESAFE_API_KEY: apiKey, TYPESAFE_MODEL: configuredModel } = getRuntimeEnv(context);
  if (!apiKey) {
    return jsonNoStore({ error: 'The topic filter is not configured on this server.' }, 503);
  }

  // Browsers label cross-site requests. This endpoint spends money, so only
  // this site's own pages may call it; other clients meet the admission limit.
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin') {
    return jsonNoStore({ error: 'Cross-site requests are not allowed.' }, 403);
  }
  // A JSON content type cannot be sent cross-site without a preflight.
  if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) {
    return jsonNoStore({ error: 'Content-Type must be application/json.' }, 415);
  }

  try {
    const items = parseItems(await readJsonBody(request));
    throwIfAborted(request.signal);
    const results = await withDeadline(
      (signal, deadlineAt) => classifyItems(items, { apiKey, model: configuredModel || DEFAULT_MODEL, signal, deadlineAt }),
      request.signal,
      TOPIC_JOB_TIMEOUT_MS,
    );
    return jsonNoStore({ results }, 200);
  } catch (error) {
    if (error?.name === 'AbortError') {
      return jsonNoStore({ error: 'Request cancelled.' }, 499);
    }
    if (error?.status >= 400 && error.status <= 599) {
      return jsonNoStore({ error: error.message }, error.status, error.headers);
    }
    console.error('Topic classifier error:', error?.message || 'Unknown error');
    return jsonNoStore({ error: 'Topic check failed.' }, 500);
  }
}

function resetModuleStateForTests() {
  scoreCache.clear();
  admissionTokens = CLASSIFY_ADMISSION_LIMITS.burst;
  admissionUpdatedAt = null;
}

// Test utilities for unit/integration coverage.
export const testUtils =
  process.env.NODE_ENV === 'test'
    ? {
        scoreCache,
        SCORE_CACHE_TTL_MS,
        MAX_SCORE_CACHE_SIZE,
        UPSTREAM_TIMEOUT_MS,
        UPSTREAM_CONCURRENCY,
        UPSTREAM_RETRY_DELAY_MS,
        TYPESAFE_ENDPOINT,
        resetModuleStateForTests,
      }
    : undefined;
