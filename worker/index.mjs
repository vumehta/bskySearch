import { GET as search } from '../api/search.mjs';
import { monitorAPI } from './api.mjs';
import { collect } from './collector.mjs';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let response;
    if (url.pathname === '/api/monitor') response = await monitorAPI(request, env, ctx);
    else if (url.pathname === '/api/search') response = await search(request, { env });
    else {
      if (url.pathname === '/') url.pathname = '/bluesky-term-search.html';
      if (url.pathname === '/monitor') url.pathname = '/monitor.html';
      response = await env.ASSETS.fetch(new Request(url, request));
    }
    const secure = new Response(response.body, response);
    secure.headers.set('X-Content-Type-Options', 'nosniff');
    secure.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    secure.headers.set('X-Frame-Options', 'DENY');
    secure.headers.set('Content-Security-Policy', "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' https://cdn.bsky.app https://*.bsky.app data:; script-src 'self'; style-src 'self'; connect-src 'self' https://public.api.bsky.app; font-src 'self' data:");
    return secure;
  },
  async scheduled(_event, env, _ctx) {
    await collect(env);
  },
};
