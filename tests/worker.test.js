import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index.mjs';
import securityHeaders from '../worker/security-headers.json' with { type: 'json' };
import { testUtils as searchTestUtils } from '../api/search.mjs';

const originalFetch = globalThis.fetch;

function createEnv({ allowClassify = true } = {}) {
  return {
    BSKY_HANDLE: 'test-handle',
    BSKY_APP_PASSWORD: 'test-password',
    TYPESAFE_API_KEY: 'test-key',
    CLASSIFY_LIMITER: { limit: vi.fn(async () => ({ success: allowClassify })) },
  };
}

function createContext() {
  return { waitUntil: vi.fn() };
}

function classifyRequest(method = 'POST') {
  return new Request('https://search.example/api/classify', {
    method,
    headers: {
      'CF-Connecting-IP': '203.0.113.7',
      'Content-Type': 'application/json',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: method === 'POST' ? '{}' : undefined,
  });
}

function expectSecurityHeaders(response) {
  for (const [name, value] of Object.entries(securityHeaders)) {
    expect(response.headers.get(name)).toBe(value);
  }
}

beforeEach(() => searchTestUtils.resetModuleStateForTests());

afterEach(() => {
  searchTestUtils.resetModuleStateForTests();
  globalThis.fetch = originalFetch;
});

describe('worker routing', () => {
  it('routes searches to the search handler and adds the security headers', async () => {
    const response = await worker.fetch(new Request('https://search.example/api/search'), createEnv(), createContext());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing term parameter.' });
    expectSecurityHeaders(response);
  });

  it('answers unknown paths with 404 and the security headers', async () => {
    const response = await worker.fetch(new Request('https://search.example/api/other'), createEnv(), createContext());
    expect(response.status).toBe(404);
    expectSecurityHeaders(response);
  });

  it('passes the invocation waitUntil to shared search work', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.includes('/com.atproto.server.createSession')) {
        return Response.json({ accessJwt: 'access', refreshJwt: 'refresh' });
      }
      return Response.json({ posts: [] });
    });
    const ctx = createContext();
    const response = await worker.fetch(new Request('https://search.example/api/search?term=topic'), createEnv(), ctx);
    expect(response.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);
  });
});

describe('topic check rate limit', () => {
  it('refuses limited clients before the classifier runs', async () => {
    globalThis.fetch = vi.fn();
    const env = createEnv({ allowClassify: false });
    const response = await worker.fetch(classifyRequest(), env, createContext());
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expectSecurityHeaders(response);
    expect(env.CLASSIFY_LIMITER.limit).toHaveBeenCalledWith({ key: '203.0.113.7' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('counts allowed POSTs and hands them to the classifier', async () => {
    const env = createEnv();
    const response = await worker.fetch(classifyRequest(), env, createContext());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Expected a JSON body with an items array.' });
    expect(env.CLASSIFY_LIMITER.limit).toHaveBeenCalledTimes(1);
  });

  it('does not count other methods', async () => {
    const env = createEnv();
    const response = await worker.fetch(classifyRequest('GET'), env, createContext());
    expect(response.status).toBe(405);
    expect(env.CLASSIFY_LIMITER.limit).not.toHaveBeenCalled();
  });
});
