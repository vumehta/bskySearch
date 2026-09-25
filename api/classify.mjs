import { TOPIC_JOB_TIMEOUT_MS } from '../src/constants.mjs';
import {
  TOPIC_LIMITS,
  hasTopicEvidence,
  normalizeKeyword,
  sanitizeTopicContext,
} from '../src/topic-context.mjs';

const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';

const UPSTREAM_TIMEOUT_MS = 8000;
const UPSTREAM_CONCURRENCY = 8;
const UPSTREAM_RETRY_DELAY_MS = 300;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

const MAX_BODY_CHARS = 256 * 1024;

const SCORE_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_SCORE_CACHE_SIZE = 5000;

export const CLASSIFY_ADMISSION_LIMITS = Object.freeze({
  burst: 600,
  refillPerSecond: 5,
});

export const CLASSIFY_CLIENT_ADMISSION_LIMITS = Object.freeze({
  burst: 300,
  refillPerSecond: 2.5,
});

const MAX_ADMISSION_CLIENTS = 1000;

const scoreCache = new Map();
const instanceAdmission = { tokens: CLASSIFY_ADMISSION_LIMITS.burst, updatedAt: null };
const clientAdmissions = new Map();

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

export function buildTopicQuestion(keyword) {
  return {
    type: 'noul',
    instructions: {
      subject: keyword,
      search_intent: 'The user is tracking companies, brands, and platforms and their products and services. ' +
        'Interpret the search term as the named business or platform, regardless of capitalization, ' +
        'not as an ordinary word, acronym, or unrelated entity. For example, Intel means the chip company, ' +
        'not intelligence reports or military intel; Apple means the technology company, not fruit; ' +
        'Meta means the technology company, not gaming strategy or self-referential commentary. ' +
        'Idioms, catchphrases, and generic verbs built on a brand name are a different meaning too: ' +
        '"Netflix and chill" is slang for a hookup, not a statement about Netflix, and "google it" just means search online. ' +
        'Apply this same business/product interpretation to every search term, including Instagram, WhatsApp, and Netflix.',
      question: 'Does this post provide substantive analysis, news, or reasoned criticism about `subject`, ' +
        'in the intended business/product sense described above?',
      evidence: 'Consider `post_text`, `link_card`, `image_descriptions`, and `quoted_post` together. ' +
        'Use only the supplied content; do not assume an unseen article or missing thread adds useful information.',
    },
    criteria: {
      true:
        'The supplied evidence connects the content to the intended company, brand, or platform. ' +
        'It explains, evaluates, compares, or reports a concrete development concerning `subject` or its products ' +
        'and services: for example features, business performance, strategy, competition, privacy, moderation, ' +
        'regulation, security, reliability, or effects on users. Reasoned criticism, specific product experiences, ' +
        'and brief factual news count. So do opinions and calls to action that give a reason tied to the ' +
        'business, such as urging people to cancel or boycott `subject` because it raised prices or changed a policy. ' +
        'When a post names several companies and its claim or criticism applies to all of them, it counts for each ' +
        'one named. The subject need not be the only focus, but there must be substantive ' +
        'information about it. A clearly identifiable product or service can establish the connection without ' +
        'repeating the company name. A link preview or quoted post can supply that information even when the post itself is a short reaction.',
      false:
        'No substantive analysis, news, or reasoned criticism about the intended business or its products and services. ' +
        'Detailed news or analysis about another meaning of the search term does not qualify. ' +
        'An ambiguous word alone is not evidence of a connection to the business. ' +
        'If multiple meanings occur, judge only the information about the intended business and its products. ' +
        'Mere mentions, hashtags, source or photo credits ' +
        '(such as "via Instagram"), follow-me requests, promotions of unrelated content, and casual personal ' +
        'updates do not count. Neither does using the platform to post a photo, share content, or contact someone. ' +
        'Analysis of unrelated content does not qualify just because the platform is credited. ' +
        'Praise or complaints that give no reason, fandom about a show, an official author alone, and a different meaning of the word do not count.',
    },
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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

function refillAdmission(bucket, limits, now) {
  if (bucket.updatedAt !== null) {
    bucket.tokens = Math.min(
      limits.burst,
      bucket.tokens + (Math.max(0, now - bucket.updatedAt) / 1000) * limits.refillPerSecond,
    );
  }
  bucket.updatedAt = Math.max(bucket.updatedAt ?? now, now);
}

function getClientAdmission(client) {
  const bucket = clientAdmissions.get(client) || { tokens: CLASSIFY_CLIENT_ADMISSION_LIMITS.burst, updatedAt: null };
  clientAdmissions.delete(client);
  clientAdmissions.set(client, bucket);
  while (clientAdmissions.size > MAX_ADMISSION_CLIENTS) {
    clientAdmissions.delete(clientAdmissions.keys().next().value);
  }
  return bucket;
}

function admitUpstreamCalls(calls, client) {
  const now = Date.now();
  const limited = [
    [instanceAdmission, CLASSIFY_ADMISSION_LIMITS],
    [getClientAdmission(client), CLASSIFY_CLIENT_ADMISSION_LIMITS],
  ];
  let retryAfter = 0;
  for (const [bucket, limits] of limited) {
    refillAdmission(bucket, limits, now);
    if (bucket.tokens < calls) {
      retryAfter = Math.max(retryAfter, Math.ceil((calls - bucket.tokens) / limits.refillPerSecond));
    }
  }
  if (retryAfter > 0) return retryAfter;
  for (const [bucket] of limited) bucket.tokens -= calls;
  return 0;
}

function getClientKey(request) {
  const realIp = request.headers.get('x-real-ip')?.trim();
  const forwardedIp = request.headers.get('x-forwarded-for')?.split(',')[0].trim();
  return realIp || forwardedIp || 'unknown';
}

function isSameOriginRequest(request) {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite) return fetchSite === 'same-origin';
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function upstreamTimeoutError() {
  return new DOMException('Upstream request timed out.', 'TimeoutError');
}

async function postToTypeSafe(body, apiKey, signal) {
  throwIfAborted(signal);
  const controller = new AbortController();
  let timedOut = false;
  let responseMeta = null;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let rejectOnAbort;
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
        }
        return { ...responseMeta, payload };
      })(),
      aborted,
    ]);
  } catch (error) {
    throwIfAborted(signal);
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

function describeUpstreamFailure(payload) {
  const detail = payload?.detail ?? payload?.error ?? payload?.message ?? '';
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return (text || 'no error body').slice(0, 300);
}

async function scoreItem(keywords, context, { apiKey, model, signal, deadlineAt, client }) {
  const questions = Object.fromEntries(keywords.map((keyword, index) => [`k${index}`, buildTopicQuestion(keyword)]));
  const body = { model, state: context, questions };
  const unscored = keywords.map(() => null);
  let retryDelayMs = UPSTREAM_RETRY_DELAY_MS;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfAborted(signal);
    if (attempt > 0) {
      if (retryDelayMs >= deadlineAt - Date.now()) return unscored;
      await abortableDelay(retryDelayMs, signal);
    }
    throwIfAborted(signal);
    if (attempt > 0 && admitUpstreamCalls(1, client) > 0) return unscored;
    let result;
    try {
      result = await postToTypeSafe(body, apiKey, signal);
    } catch (error) {
      throwIfAborted(signal);
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

async function classifyItems(items, results, options) {
  const tasks = [];
  for (const [itemIndex, item] of items.entries()) {
    const { scores } = results[itemIndex];
    const cacheKeys = await Promise.all(item.keywords.map((keyword) => getScoreCacheKey(keyword, item.context)));
    cacheKeys.forEach((cacheKey, keywordIndex) => {
      scores[keywordIndex] = getCachedScore(cacheKey);
    });
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
    throwIfAborted(options.signal);
    const retryAfter = admitUpstreamCalls(tasks.length, options.client);
    if (retryAfter > 0) {
      throw httpError('Too many topic checks. Please try again shortly.', 429, {
        'Retry-After': String(retryAfter),
      });
    }
    await runWithConcurrency(tasks, UPSTREAM_CONCURRENCY);
  }
}

const DEADLINE_PASSED = Symbol('deadline passed');

function withDeadline(start, signal, timeoutMs) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve(DEADLINE_PASSED);
      controller.abort();
    }, timeoutMs);
  });
  const deadlineAt = Date.now() + timeoutMs;
  const work = Promise.resolve().then(() => start(controller.signal, deadlineAt));
  work.catch(() => {});
  return Promise.race([work, deadline]).finally(() => {
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

  if (!isSameOriginRequest(request)) {
    return jsonNoStore({ error: 'Cross-site requests are not allowed.' }, 403);
  }
  if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) {
    return jsonNoStore({ error: 'Content-Type must be application/json.' }, 415);
  }

  try {
    const items = parseItems(await readJsonBody(request));
    throwIfAborted(request.signal);
    const results = items.map(({ id, keywords }) => ({ id, scores: keywords.map(() => null) }));
    const outcome = await withDeadline(
      (signal, deadlineAt) => classifyItems(items, results, {
        apiKey,
        model: configuredModel || DEFAULT_MODEL,
        signal,
        deadlineAt,
        client: getClientKey(request),
      }),
      request.signal,
      TOPIC_JOB_TIMEOUT_MS,
    );
    if (outcome === DEADLINE_PASSED) {
      const scores = results.flatMap((result) => result.scores);
      const scored = scores.filter((score) => score !== null).length;
      console.warn(`Topic check reached its deadline with ${scored} of ${scores.length} scores.`);
    }
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
  instanceAdmission.tokens = CLASSIFY_ADMISSION_LIMITS.burst;
  instanceAdmission.updatedAt = null;
  clientAdmissions.clear();
}

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
        MAX_ADMISSION_CLIENTS,
        clientAdmissions,
        resetModuleStateForTests,
      }
    : undefined;
