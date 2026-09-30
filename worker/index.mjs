import { GET as search } from '../api/search.mjs';
import { POST as classify } from '../api/classify.mjs';
import securityHeaders from './security-headers.json' with { type: 'json' };

const CLASSIFY_LIMIT_RETRY_AFTER_SECONDS = 60;
const SCRIPT_SRC = "script-src 'self'";

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

function createNonce() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
}

// Bot Fight Mode injects an inline script into the page and copies the script-src nonce from
// this header onto it, so every page response gets a fresh nonce and must not be reused.
async function servePage(request, env) {
  const asset = await env.ASSETS.fetch(request);
  const response = withSecurityHeaders(new Response(asset.body, asset));
  const csp = securityHeaders['Content-Security-Policy'];
  response.headers.set('Content-Security-Policy', csp.replace(SCRIPT_SRC, `${SCRIPT_SRC} 'nonce-${createNonce()}'`));
  response.headers.set('Cache-Control', 'no-store');
  response.headers.delete('ETag');
  return response;
}

async function isClassifyLimited(request, env) {
  if (request.method !== 'POST') return false;
  const key = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await env.CLASSIFY_LIMITER.limit({ key });
  return !success;
}

async function route(request, env, ctx, pathname) {
  const handler = routes.get(pathname);
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
    const { pathname } = new URL(request.url);
    if (pathname === '/') return servePage(request, env);
    return withSecurityHeaders(await route(request, env, ctx, pathname));
  },
};
