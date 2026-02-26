import { GET } from '../api/search.mjs';

// Security headers matching _headers / vercel.json.
// _headers only covers static assets; Worker responses need them explicitly.
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

function appendSecurityHeaders(response) {
  const patched = new Response(response.body, response);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    patched.headers.set(key, value);
  }
  return patched;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/search') {
      const response = await GET(request, { env });
      return appendSecurityHeaders(response);
    }

    // All other routes are handled by the [assets] config in wrangler.toml.
    // If we reach here, no asset matched either.
    return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  },
};
