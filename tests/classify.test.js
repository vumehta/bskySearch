import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLASSIFY_ADMISSION_LIMITS,
  CLASSIFY_CLIENT_ADMISSION_LIMITS,
  POST,
  buildTopicQuestion,
  testUtils,
} from '../api/classify.mjs';
import { TOPIC_JOB_TIMEOUT_MS } from '../src/constants.mjs';
import { TOPIC_LIMITS } from '../src/topic-context.mjs';

const context = { env: { TYPESAFE_API_KEY: 'test-key' } };
const {
  scoreCache,
  SCORE_CACHE_TTL_MS,
  UPSTREAM_TIMEOUT_MS,
  UPSTREAM_CONCURRENCY,
  UPSTREAM_RETRY_DELAY_MS,
  TYPESAFE_ENDPOINT,
  MAX_ADMISSION_CLIENTS,
  clientAdmissions,
  resetModuleStateForTests,
} = testUtils;
const originalFetch = globalThis.fetch;

function item(id, keywords = ['Meta'], text = `post ${id}`) {
  return { id, keywords, context: { post_text: text, author: 'Alice (@alice.example)' } };
}

function request(body, { headers = {}, method = 'POST', signal, client } = {}) {
  return new Request('https://example.com/api/classify', {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Sec-Fetch-Site': 'same-origin',
      ...(client ? { 'X-Real-IP': client } : {}),
      ...headers,
    },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    signal,
  });
}

function upstream(scoreFor = () => 0.9) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    const answers = Object.fromEntries(Object.entries(body.questions).map(([key, question]) => {
      const keyword = question.instructions.subject;
      return [key, { type: 'noul', noul: scoreFor(keyword, body.state) }];
    }));
    return Response.json({ model: body.model, answers, usage: { input_tokens: 1, output_tokens: 1 } });
  });
  return calls;
}

const realSetTimeout = globalThis.setTimeout;
const realPause = (ms = 1) => new Promise((resolve) => realSetTimeout(resolve, ms));

function useFakeClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
}

async function advanceUntilSettled(pending, stepMs = 250) {
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  for (let turn = 0; turn < 5000 && !settled && globalThis.fetch.mock.calls.length === 0; turn += 1) {
    await realPause();
  }
  for (let step = 0; step < 400 && !settled; step += 1) {
    await vi.advanceTimersByTimeAsync(stepMs);
    await realPause();
  }
  return pending;
}

beforeEach(() => {
  resetModuleStateForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  resetModuleStateForTests();
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('request validation', () => {
  it('reports a missing key without calling anything', async () => {
    globalThis.fetch = vi.fn();
    const response = await POST(request({ items: [item('a')] }), { env: {} });
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects other methods, cross-site callers, and non-JSON bodies', async () => {
    globalThis.fetch = vi.fn();
    const wrongMethod = await POST(request(null, { method: 'GET' }), context);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('Allow')).toBe('POST');
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect((await POST(request({ items: [item('a')] }, { headers: { 'Sec-Fetch-Site': site } }), context)).status).toBe(403);
    }
    const withoutFetchSite = (headers) => {
      const built = request({ items: [item('a')] }, { headers });
      built.headers.delete('Sec-Fetch-Site');
      return built;
    };
    expect((await POST(withoutFetchSite({}), context)).status).toBe(403);
    expect((await POST(withoutFetchSite({ Origin: 'https://attacker.example' }), context)).status).toBe(403);
    expect((await POST(withoutFetchSite({ Origin: 'null' }), context)).status).toBe(403);
    expect((await POST(request({ items: [item('a')] }, { headers: { 'Content-Type': 'text/plain' } }), context)).status).toBe(415);
    expect((await POST(request('{nope'), context)).status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('accepts this site\'s own pages, including browsers that only send Origin', async () => {
    upstream();
    const response = await POST(request({ items: [item('a')] }, { headers: { 'Sec-Fetch-Site': 'same-origin' } }), context);
    expect(response.status).toBe(200);
    const originOnly = request({ items: [item('b')] }, { headers: { Origin: 'https://example.com' } });
    originOnly.headers.delete('Sec-Fetch-Site');
    expect((await POST(originOnly, context)).status).toBe(200);
  });

  it.each([
    ['no items array', { items: 'x' }],
    ['no items', { items: [] }],
    ['too many items', { items: Array.from({ length: TOPIC_LIMITS.maxItems + 1 }, (_, index) => item(`p${index}`)) }],
    ['a non-object item', { items: ['x'] }],
    ['a missing id', { items: [{ ...item('a'), id: '' }] }],
    ['an oversized id', { items: [item('x'.repeat(TOPIC_LIMITS.id + 1))] }],
    ['no keywords', { items: [item('a', [])] }],
    ['too many keywords', { items: [item('a', Array.from({ length: TOPIC_LIMITS.maxKeywords + 1 }, (_, index) => `k${index}`))] }],
    ['a keyword that normalizes to nothing', { items: [item('a', ['"`'])] }],
    ['a non-string keyword', { items: [item('a', [7])] }],
    ['no context', { items: [{ id: 'a', keywords: ['Meta'] }] }],
    ['an author-only context', { items: [{ id: 'a', keywords: ['Meta'], context: { author: 'Alice' } }] }],
    ['a context of author names only', { items: [{ id: 'a', keywords: ['Meta'], context: { author: 'Alice', quoted_post: { author: 'Bob' } } }] }],
  ])('rejects %s', async (_label, body) => {
    globalThis.fetch = vi.fn();
    const response = await POST(request(body), context);
    expect(response.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies', async () => {
    globalThis.fetch = vi.fn();
    const response = await POST(request(JSON.stringify({ items: [item('a', ['Meta'], 'x'.repeat(300 * 1024))] })), context);
    expect(response.status).toBe(413);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('scoring', () => {
  it('asks one question per keyword over one shared state', async () => {
    const calls = upstream((keyword) => (keyword === 'Meta' ? 0.97 : 0.04));
    const response = await POST(request({ items: [item('at://post/1', ['Meta', 'Apple'])] }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [{ id: 'at://post/1', scores: [0.97, 0.04] }] });

    expect(calls).toHaveLength(1);
    const [{ url, options, body }] = calls;
    expect(url).toBe(TYPESAFE_ENDPOINT);
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer test-key');
    expect(body.model).toBe('jev-latest');
    expect(body.state).toEqual({ post_text: 'post at://post/1', author: 'Alice (@alice.example)' });
    expect(body.questions).toEqual({ k0: buildTopicQuestion('Meta'), k1: buildTopicQuestion('Apple') });
    expect(body.questions.k0.type).toBe('noul');
  });

  it('forwards only sanitized evidence, never extra client fields', async () => {
    const calls = upstream();
    await POST(request({
      items: [{
        id: 'a',
        keywords: ['  Meta" '],
        context: { post_text: ' hi\x00 there ', secret: 'x', link_card: { title: 'T', html: '<b>' } },
        model: 'other',
      }],
    }), context);
    expect(calls[0].body.state).toEqual({ post_text: 'hi there', link_card: { title: 'T' } });
    expect(calls[0].body.questions.k0).toEqual(buildTopicQuestion('Meta'));
    expect(calls[0].body.model).toBe('jev-latest');
  });

  it('forwards quoted image descriptions as bounded text evidence', async () => {
    const calls = upstream();
    const raw = item('quote');
    raw.context.quoted_post = {
      image_descriptions: [' Apple\u0000 introduces an iPhone ', null, ...Array(8).fill('x'.repeat(600))],
      thumbnail: 'https://not-forwarded.example/image',
    };
    const response = await POST(request({ items: [raw] }), context);
    expect(response.status).toBe(200);
    expect(calls[0].body.state.quoted_post).toEqual({
      image_descriptions: ['Apple introduces an iPhone', ...Array(3).fill('x'.repeat(TOPIC_LIMITS.imageDescription))],
    });
  });

  it('forwards quoted link evidence and rechecks changed descriptions', async () => {
    const calls = upstream((_keyword, state) => state.quoted_post.link_description.includes('iPhone') ? 0.9 : 0.1);
    const candidate = item('quote', ['Apple'], 'wow');
    candidate.context.quoted_post = {
      link_title: 'Read more',
      link_description: ' Apple\u0000 announces the iPhone ',
      link_site: 'news.example',
      link_path: '/story',
      uri: 'https://news.example/story?tracking=1',
    };
    const response = await POST(request({ items: [candidate] }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [{ id: 'quote', scores: [0.9] }] });
    expect(calls[0].body.state.quoted_post).toEqual({
      link_title: 'Read more',
      link_description: 'Apple announces the iPhone',
      link_site: 'news.example',
      link_path: '/story',
    });
    candidate.context.quoted_post.link_description = 'Apple pie recipe';
    const updated = await POST(request({ items: [candidate] }), context);
    await expect(updated.json()).resolves.toEqual({ results: [{ id: 'quote', scores: [0.1] }] });
    expect(calls).toHaveLength(2);
  });

  it('uses a configured model', async () => {
    const calls = upstream();
    await POST(request({ items: [item('a')] }), { env: { TYPESAFE_API_KEY: 'k', TYPESAFE_MODEL: 'jev-1.13.0' } });
    expect(calls[0].body.model).toBe('jev-1.13.0');
  });

  it('serves repeats from the cache and only asks about what is missing', async () => {
    const calls = upstream();
    await POST(request({ items: [item('a', ['Meta'])] }), context);
    await POST(request({ items: [item('a', ['Meta'])] }), context);
    expect(calls).toHaveLength(1);

    const response = await POST(request({ items: [item('a', ['Meta', 'Apple'])] }), context);
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[1].body.questions)).toEqual(['k0']);
    expect(calls[1].body.questions.k0).toEqual(buildTopicQuestion('Apple'));
    await expect(response.json()).resolves.toEqual({ results: [{ id: 'a', scores: [0.9, 0.9] }] });
  });

  it('keys the cache on content, so a caller cannot plant a score for a real post', async () => {
    const calls = upstream((_keyword, state) => (state.post_text === 'planted' ? 0.01 : 0.99));
    await POST(request({ items: [item('at://real', ['Meta'], 'planted')] }), context);
    const response = await POST(request({ items: [item('at://real', ['Meta'], 'Meta ships a new headset')] }), context);
    expect(calls).toHaveLength(2);
    await expect(response.json()).resolves.toEqual({ results: [{ id: 'at://real', scores: [0.99] }] });
  });

  it('expires cached scores', async () => {
    useFakeClock();
    const calls = upstream();
    await POST(request({ items: [item('a')] }), context);
    vi.setSystemTime(Date.now() + SCORE_CACHE_TTL_MS + 1);
    await POST(request({ items: [item('a')] }), context);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['out of range', 1.5],
    ['not a number', 'high'],
    ['missing', undefined],
  ])('reports an answer that is %s as unscored and does not cache it', async (_label, noul) => {
    globalThis.fetch = vi.fn(async () => Response.json({ answers: { k0: { type: 'noul', noul } } }));
    const response = await POST(request({ items: [item('a')] }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [{ id: 'a', scores: [null] }] });
    expect(scoreCache.size).toBe(0);
  });
});

describe('upstream failures', () => {
  it('retries an overloaded classifier once', async () => {
    useFakeClock();
    let attempts = 0;
    globalThis.fetch = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) return Response.json({ error: 'overloaded' }, { status: 529 });
      return Response.json({ answers: { k0: { type: 'noul', noul: 0.8 } } });
    });
    const response = await advanceUntilSettled(POST(request({ items: [item('a')] }), context));
    await expect(response.json()).resolves.toEqual({ results: [{ id: 'a', scores: [0.8] }] });
    expect(attempts).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['seconds', 429, () => '1', 1000],
    ['HTTP date', 529, () => new Date(Date.now() + 2000).toUTCString(), 2000],
    ['invalid header', 503, () => 'not-a-date', UPSTREAM_RETRY_DELAY_MS],
  ])('honors Retry-After with %s before retrying', async (_kind, status, header, minimumDelay) => {
    useFakeClock();
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    const attemptedAt = [];
    globalThis.fetch = vi.fn(async () => {
      attemptedAt.push(Date.now());
      if (attemptedAt.length === 1) {
        return Response.json({ error: 'try later' }, { status, headers: { 'Retry-After': header() } });
      }
      return Response.json({ answers: { k0: { type: 'noul', noul: 0.8 } } });
    });
    const response = await advanceUntilSettled(POST(request({ items: [item('a')] }), context), 50);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [{ id: 'a', scores: [0.8] }] });
    expect(attemptedAt).toHaveLength(2);
    expect(attemptedAt[1] - attemptedAt[0]).toBeGreaterThanOrEqual(minimumDelay);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves other scores when Retry-After exceeds the remaining job budget', async () => {
    useFakeClock();
    globalThis.fetch = vi.fn(async (_url, options) => {
      if (JSON.parse(options.body).state.post_text === 'post throttled') {
        return Response.json({ error: 'try later' }, { status: 429, headers: { 'Retry-After': '60' } });
      }
      return Response.json({ answers: { k0: { type: 'noul', noul: 0.8 } } });
    });
    const response = await advanceUntilSettled(POST(request({ items: [item('good'), item('throttled')] }), context));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [{ id: 'good', scores: [0.8] }, { id: 'throttled', scores: [null] }],
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains Retry-After when a rate-limit response body stalls', async () => {
    useFakeClock();
    let upstreamSignal;
    globalThis.fetch = vi.fn(async (_url, options) => {
      if (globalThis.fetch.mock.calls.length > 1) {
        return Response.json({ answers: { k0: { type: 'noul', noul: 0.8 } } });
      }
      upstreamSignal = options.signal;
      return {
        status: 429,
        headers: new Headers({ 'Retry-After': '60' }),
        json: () => new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }),
      };
    });
    const response = await advanceUntilSettled(POST(request({ items: [item('a')] }), context));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [{ id: 'a', scores: [null] }] });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(upstreamSignal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the Retry-After wait when the caller leaves', async () => {
    useFakeClock();
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: 'try later' }, { status: 429, headers: { 'Retry-After': '10' } }));
    const controller = new AbortController();
    const pending = POST(request({ items: [item('a')] }, { signal: controller.signal }), context);
    for (let turn = 0; turn < 5000 && globalThis.fetch.mock.calls.length === 0; turn += 1) await realPause();
    await vi.advanceTimersByTimeAsync(500);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up on one post without failing the others', async () => {
    useFakeClock();
    globalThis.fetch = vi.fn(async (_url, options) => {
      const { state } = JSON.parse(options.body);
      if (state.post_text === 'post bad') return new Response('<html>', { status: 500 });
      return Response.json({ answers: { k0: { type: 'noul', noul: 0.7 } } });
    });
    const response = await advanceUntilSettled(POST(request({ items: [item('good'), item('bad')] }), context));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [{ id: 'good', scores: [0.7] }, { id: 'bad', scores: [null] }],
    });
    expect(scoreCache.size).toBe(1);
  });

  it('does not retry a rejected request, and logs why for the function logs', async () => {
    globalThis.fetch = vi.fn(async () => Response.json(
      { detail: { error_type: 'validation_error', message: 'criteria must be a map' } },
      { status: 422 },
    ));
    const response = await POST(request({ items: [item('a')] }), context);
    await expect(response.json()).resolves.toEqual({ results: [{ id: 'a', scores: [null] }] });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    const logged = console.warn.mock.calls[0].join(' ');
    expect(logged).toContain('422');
    expect(logged).toContain('criteria must be a map');
    expect(logged).not.toContain('test-key');
  });

  it.each([401, 403])('fails the whole request when the key is rejected with %i', async (status) => {
    globalThis.fetch = vi.fn(async () => Response.json({ error: 'bad key' }, { status }));
    const items = Array.from({ length: TOPIC_LIMITS.maxItems }, (_, index) => item(`p${index}`));
    const response = await POST(request({ items }), context);
    expect(response.status).toBe(502);
    expect(globalThis.fetch.mock.calls.length).toBeLessThanOrEqual(UPSTREAM_CONCURRENCY);
    const payload = await response.json();
    expect(payload.error).toMatch(/credentials/);
    expect(JSON.stringify(payload)).not.toContain('test-key');
  });

  it('times out a stalled classifier, retries once, and clears its timers', async () => {
    useFakeClock();
    const signals = [];
    globalThis.fetch = vi.fn((_url, options) => {
      signals.push(options.signal);
      return new Promise(() => {});
    });
    const startedAt = Date.now();
    const response = await advanceUntilSettled(POST(request({ items: [item('a')] }), context));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [{ id: 'a', scores: [null] }] });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(UPSTREAM_TIMEOUT_MS * 2 + UPSTREAM_RETRY_DELAY_MS);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds the whole job', async () => {
    useFakeClock();
    globalThis.fetch = vi.fn(async () => ({ status: 200, json: () => new Promise(() => {}) }));
    const items = Array.from({ length: TOPIC_LIMITS.maxItems }, (_, index) => item(`p${index}`));
    const startedAt = Date.now();
    const response = await advanceUntilSettled(POST(request({ items }), context));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: items.map(({ id }) => ({ id, scores: [null] })) });
    expect(Date.now() - startedAt).toBeLessThan(TOPIC_JOB_TIMEOUT_MS + 1000);
    for (let step = 0; step < 20; step += 1) {
      await vi.advanceTimersByTimeAsync(1000);
      await realPause();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns the scores that finished when the job deadline passes', async () => {
    useFakeClock();
    const quick = new Set(Array.from({ length: UPSTREAM_CONCURRENCY }, (_, index) => `post p${index}`));
    const stalled = [];
    globalThis.fetch = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (quick.has(body.state.post_text)) return Response.json({ answers: { k0: { type: 'noul', noul: 0.8 } } });
      stalled.push(options.signal);
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    const items = Array.from({ length: TOPIC_LIMITS.maxItems }, (_, index) => item(`p${index}`));
    const startedAt = Date.now();
    const response = await advanceUntilSettled(POST(request({ items }), context));
    expect(response.status).toBe(200);
    const { results } = await response.json();
    expect(results.map(({ id }) => id)).toEqual(items.map(({ id }) => id));
    expect(results.map(({ scores }) => scores[0])).toEqual(
      items.map((_, index) => (index < UPSTREAM_CONCURRENCY ? 0.8 : null)),
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(TOPIC_JOB_TIMEOUT_MS);
    expect(Date.now() - startedAt).toBeLessThan(TOPIC_JOB_TIMEOUT_MS + 1000);
    expect(stalled.length).toBeGreaterThan(0);
    expect(stalled.every((signal) => signal.aborted)).toBe(true);
    expect(scoreCache.size).toBe(UPSTREAM_CONCURRENCY);
    expect(console.warn).toHaveBeenCalledWith(
      `Topic check reached its deadline with ${UPSTREAM_CONCURRENCY} of ${TOPIC_LIMITS.maxItems} scores.`,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops upstream work when the caller goes away', async () => {
    const controller = new AbortController();
    let upstreamSignal;
    globalThis.fetch = vi.fn((_url, options) => {
      upstreamSignal = options.signal;
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    const pending = POST(request({ items: [item('a')] }, { signal: controller.signal }), context);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(upstreamSignal.aborted).toBe(true);
    expect(scoreCache.size).toBe(0);
  });
});

async function fillAdmission(calls, prefix = 'fill') {
  for (let start = 0; start < calls; start += TOPIC_LIMITS.maxItems) {
    const client = `filler-${Math.floor(start / CLASSIFY_CLIENT_ADMISSION_LIMITS.burst)}`;
    const items = Array.from({ length: Math.min(TOPIC_LIMITS.maxItems, calls - start) }, (_, index) => item(prefix + (start + index)));
    expect((await POST(request({ items }, { client }), context)).status).toBe(200);
  }
}

describe('admission', () => {
  it('charges nothing when the caller goes away before any call is made', async () => {
    useFakeClock();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    upstream();
    await fillAdmission(CLASSIFY_ADMISSION_LIMITS.burst - TOPIC_LIMITS.maxItems);
    globalThis.fetch.mockClear();
    const controller = new AbortController();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation((...args) => {
      controller.abort();
      return digest(...args);
    });
    const abandoned = Array.from({ length: TOPIC_LIMITS.maxItems }, (_, index) => item('gone' + index));
    expect((await POST(request({ items: abandoned }, { signal: controller.signal }), context)).status).toBe(499);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    spy.mockRestore();
    const next = Array.from({ length: TOPIC_LIMITS.maxItems }, (_, index) => item('next' + index));
    expect((await POST(request({ items: next }), context)).status).toBe(200);
  });

  it('charges every admitted retry against admission, including concurrent retries', async () => {
    useFakeClock();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    upstream();
    const retryingPosts = 4;
    const admittedRetries = 2;
    await fillAdmission(CLASSIFY_ADMISSION_LIMITS.burst - retryingPosts - admittedRetries);
    globalThis.fetch.mockImplementation(async () => Response.json({ error: 'overloaded' }, { status: 529 }));
    const retrying = Array.from({ length: retryingPosts }, (_, index) => item('retry' + index));
    const response = await advanceUntilSettled(POST(request({ items: retrying }), context));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: retrying.map(({ id }) => ({ id, scores: [null] })) });
    expect(globalThis.fetch).toHaveBeenCalledTimes(CLASSIFY_ADMISSION_LIMITS.burst);
    expect(vi.getTimerCount()).toBe(0);
    expect((await POST(request({ items: [item('fresh')] }), context)).status).toBe(429);
    expect((await POST(request({ items: [item('fill0')] }), context)).status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(CLASSIFY_ADMISSION_LIMITS.burst);
  });

  it('leaves only the post whose retry is refused unscored and keeps the rest of the batch', async () => {
    useFakeClock();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    upstream();
    await fillAdmission(CLASSIFY_ADMISSION_LIMITS.burst - 2);
    globalThis.fetch.mockClear().mockImplementation(async (_url, options) => {
      if (JSON.parse(options.body).state.post_text === 'post retry') {
        return Response.json({ error: 'overloaded' }, { status: 529 });
      }
      return Response.json({ answers: { k0: { type: 'noul', noul: 0.8 } } });
    });
    const response = await advanceUntilSettled(POST(request({ items: [item('good'), item('retry')] }), context));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [{ id: 'good', scores: [0.8] }, { id: 'retry', scores: [null] }],
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect((await POST(request({ items: [item('good')] }), context)).status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('limits upstream calls, not cache hits, and refills over time', async () => {
    useFakeClock();
    upstream();
    await fillAdmission(CLASSIFY_ADMISSION_LIMITS.burst);

    const limited = await POST(request({ items: [item('fresh-1'), item('fresh-2')] }), context);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);

    const cached = await POST(request({ items: [item('fill0')] }), context);
    expect(cached.status).toBe(200);

    vi.setSystemTime(Date.now() + 1000);
    expect((await POST(request({ items: [item('fresh-1'), item('fresh-2')] }), context)).status).toBe(200);

    const freshBatch = Array.from({ length: TOPIC_LIMITS.maxItems }, (_, index) => item('next' + index));
    const callsBefore = globalThis.fetch.mock.calls.length;
    const batchLimited = await POST(request({ items: freshBatch }), context);
    expect(batchLimited.status).toBe(429);
    expect(globalThis.fetch).toHaveBeenCalledTimes(callsBefore);
    const retryAfter = Number(batchLimited.headers.get('Retry-After'));
    expect(retryAfter).toBeGreaterThan(1);
    vi.setSystemTime(Date.now() + retryAfter * 1000);
    expect((await POST(request({ items: freshBatch }), context)).status).toBe(200);
  });

  it('gives each client its own share, so one client cannot lock out the rest', async () => {
    useFakeClock();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    upstream();
    const batches = CLASSIFY_CLIENT_ADMISSION_LIMITS.burst / TOPIC_LIMITS.maxItems;
    for (let batch = 0; batch < batches; batch += 1) {
      const items = Array.from({ length: TOPIC_LIMITS.maxItems }, (_, index) => item(`greedy${batch}-${index}`));
      expect((await POST(request({ items }, { client: '203.0.113.7' }), context)).status).toBe(200);
    }
    const greedy = Array.from({ length: TOPIC_LIMITS.maxItems }, (_, index) => item(`greedy-more${index}`));
    const limited = await POST(request({ items: greedy }, { client: '203.0.113.7' }), context);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBe(
      Math.ceil(TOPIC_LIMITS.maxItems / CLASSIFY_CLIENT_ADMISSION_LIMITS.refillPerSecond),
    );
    const other = Array.from({ length: TOPIC_LIMITS.maxItems }, (_, index) => item(`other${index}`));
    expect((await POST(request({ items: other }, { client: '198.51.100.4' }), context)).status).toBe(200);
  });

  it('charges retries against the client share as well as the instance', async () => {
    useFakeClock();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    upstream();
    const retryingPosts = 4;
    const admittedRetries = 2;
    const fill = CLASSIFY_CLIENT_ADMISSION_LIMITS.burst - retryingPosts - admittedRetries;
    for (let start = 0; start < fill; start += TOPIC_LIMITS.maxItems) {
      const items = Array.from({ length: Math.min(TOPIC_LIMITS.maxItems, fill - start) }, (_, index) => item(`share${start + index}`));
      expect((await POST(request({ items }, { client: '203.0.113.20' }), context)).status).toBe(200);
    }
    globalThis.fetch.mockClear().mockImplementation(async () => Response.json({ error: 'overloaded' }, { status: 529 }));
    const response = await advanceUntilSettled(POST(request({
      items: Array.from({ length: retryingPosts }, (_, index) => item(`share-retry${index}`)),
    }, { client: '203.0.113.20' }), context));
    expect(response.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(retryingPosts + admittedRetries);
    expect(vi.getTimerCount()).toBe(0);
    upstream();
    expect((await POST(request({ items: [item('share-next')] }, { client: '203.0.113.20' }), context)).status).toBe(429);
    expect((await POST(request({ items: [item('share-next')] }, { client: '198.51.100.4' }), context)).status).toBe(200);
  });

  it('identifies a client by X-Real-IP, then by the first X-Forwarded-For address', async () => {
    useFakeClock();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    upstream();
    const batches = CLASSIFY_CLIENT_ADMISSION_LIMITS.burst / TOPIC_LIMITS.maxItems;
    for (let batch = 0; batch < batches; batch += 1) {
      const items = Array.from({ length: TOPIC_LIMITS.maxItems }, (_, index) => item(`fwd${batch}-${index}`));
      const headers = { 'X-Forwarded-For': '203.0.113.9, 10.0.0.1' };
      expect((await POST(request({ items }, { headers }), context)).status).toBe(200);
    }
    const next = [item('fwd-next')];
    expect((await POST(request({ items: next }, { client: '203.0.113.9' }), context)).status).toBe(429);
    expect((await POST(request({ items: next }, { headers: { 'X-Forwarded-For': '10.0.0.1, 203.0.113.9' } }), context)).status).toBe(200);
  });

  it('remembers a bounded number of clients', async () => {
    useFakeClock();
    upstream();
    for (let index = 0; index <= MAX_ADMISSION_CLIENTS; index += 1) {
      vi.setSystemTime(Date.now() + 1000 / CLASSIFY_ADMISSION_LIMITS.refillPerSecond);
      expect((await POST(request({ items: [item(`visitor${index}`)] }, { client: `client-${index}` }), context)).status).toBe(200);
    }
    expect(clientAdmissions.size).toBe(MAX_ADMISSION_CLIENTS);
    expect(clientAdmissions.has('client-0')).toBe(false);
    expect(clientAdmissions.has(`client-${MAX_ADMISSION_CLIENTS}`)).toBe(true);
  });
});
