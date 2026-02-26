import { handleSearch } from './api/search.mjs';

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' https://cdn.bsky.app https://*.bsky.app data:; script-src 'self'; style-src 'self'; connect-src 'self' https://public.api.bsky.app; font-src 'self' data:; upgrade-insecure-requests",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === '/api/search' || url.pathname === '/api/search/') {
        const apiResponse = await handleSearch(request, env);
        return withSecurityHeaders(apiResponse);
      }

      const assetRequest =
        url.pathname === '/'
          ? new Request(new URL('/bluesky-term-search', request.url).toString(), request)
          : request;

      const assetResponse = await env.ASSETS.fetch(assetRequest);
      return withSecurityHeaders(assetResponse);
    } catch (error) {
      console.error('Worker request failed:', error?.message || 'Unknown error');
      return withSecurityHeaders(
        Response.json(
          { error: 'Internal server error.' },
          {
            status: 500,
            headers: {
              'Cache-Control': 'no-store',
            },
          },
        ),
      );
    }
  },
};
