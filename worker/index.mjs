import { GET as search } from '../api/search.mjs';
import { POST as classify } from '../api/classify.mjs';
import securityHeaders from './security-headers.json' with { type: 'json' };

const CLASSIFY_LIMIT_RETRY_AFTER_SECONDS = 60;

const routes = new Map([
  ['/api/search', search],
  ['/api/classify', classify],
]);

// Static assets get these headers from dist/_headers; Worker responses need them set here.
function withSecurityHeaders(response) {
  for (const [name, value] of Object.entries(securityHeaders)) {
    response.headers.set(name, value);
  }
  return response;
}

async function isClassifyLimited(request, env) {
  if (request.method !== 'POST') return false;
  const key = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await env.CLASSIFY_LIMITER.limit({ key });
  return !success;
}

async function route(request, env, ctx) {
  const handler = routes.get(new URL(request.url).pathname);
  if (!handler) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (handler === classify && await isClassifyLimited(request, env)) {
    return Response.json({ error: 'Too many topic checks. Please try again shortly.' }, {
      status: 429,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(CLASSIFY_LIMIT_RETRY_AFTER_SECONDS),
      },
    });
  }
  return handler(request, { env, waitUntil: (promise) => ctx.waitUntil(promise) });
}

export default {
  async fetch(request, env, ctx) {
    return withSecurityHeaders(await route(request, env, ctx));
  },
};
