import { GET } from '../api/search.mjs';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/search') {
      return GET(request, { env });
    }

    // All other routes are handled by the [assets] config in wrangler.toml.
    // If we reach here, no asset matched either.
    return new Response('Not Found', { status: 404 });
  },
};
