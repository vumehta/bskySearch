import { HttpError, json, readJson } from './http.mjs';

const COOKIE = 'bsky_monitor_session';
const MAX_AGE = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();

async function key(password) {
  return crypto.subtle.importKey('raw', encoder.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function hex(bytes) { return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join(''); }
function unhex(value) { return Uint8Array.from(value.match(/../g) || [], s => parseInt(s, 16)); }

function cookie(request, value, maxAge) {
  const url = new URL(request.url);
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${local ? '' : '; Secure'}`;
}

export function assertConfigured(env) {
  if (!env.MONITOR_PASSWORD || env.MONITOR_PASSWORD.length < 16) {
    throw new HttpError(503, 'Monitoring needs a dashboard password configured by the owner.');
  }
}

export async function isSignedIn(request, env) {
  const value = (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!value || !/^\d+\.[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(value)) return false;
  const [expires, nonce, signature] = value.split('.');
  if (Number(expires) <= Date.now() || Number(expires) > Date.now() + MAX_AGE * 1000) return false;
  return crypto.subtle.verify('HMAC', await key(env.MONITOR_PASSWORD), unhex(signature), encoder.encode(`${expires}.${nonce}`));
}

export async function login(request, env) {
  const input = await readJson(request);
  if (typeof input?.password !== 'string' || input.password.length > 1024) throw new HttpError(400, 'Enter your dashboard password.');
  const now = Date.now();
  const bucket = hex(await crypto.subtle.digest('SHA-256', encoder.encode(request.headers.get('CF-Connecting-IP') || 'shared')));
  await env.DB.prepare('DELETE FROM login_attempts WHERE expires_at <= ?').bind(now).run();
  const attempt = await env.DB.prepare(`INSERT INTO login_attempts (bucket, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1 RETURNING attempts`).bind(bucket, now + 10 * 60_000).first();
  if (attempt.attempts > 10) throw new HttpError(429, 'Too many sign-in attempts. Try again in 10 minutes.');
  const expected = await crypto.subtle.digest('SHA-256', encoder.encode(env.MONITOR_PASSWORD));
  const actual = await crypto.subtle.digest('SHA-256', encoder.encode(input.password));
  if (!crypto.subtle.timingSafeEqual(expected, actual)) throw new HttpError(401, 'Incorrect dashboard password.');
  const payload = `${now + MAX_AGE * 1000}.${crypto.randomUUID()}`;
  const signature = hex(await crypto.subtle.sign('HMAC', await key(env.MONITOR_PASSWORD), encoder.encode(payload)));
  return json({ signedIn: true }, 200, { 'Set-Cookie': cookie(request, `${payload}.${signature}`, MAX_AGE) });
}

export function logout(request) {
  return json({ signedIn: false }, 200, { 'Set-Cookie': cookie(request, '', 0) });
}
