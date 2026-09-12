import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const PASSWORD = 'local-test-password-for-monitoring';

export function fixturePost(id, text = `A Bluesky post about local AI ${id}`) {
  return { uri: `at://did:plc:example/app.bsky.feed.post/${id}`, record: { text, createdAt: new Date().toISOString() }, author: { handle: 'researcher.bsky.social', displayName: 'AI Researcher' }, likeCount: 12, replyCount: 2 };
}

export async function startMonitorRuntime({ assets = false, port = 0 } = {}) {
  const bundle = await build({
    stdin: { contents: `import worker from './worker/index.mjs';
      export default { async fetch(request, env) {
        if (new URL(request.url).pathname === '/__test/collect') {
          await worker.scheduled({ cron: '*/10 * * * *' }, env, {});
          return Response.json({ ok: true });
        }
        const pending = [];
        const response = await worker.fetch(request, env, { waitUntil(p) { pending.push(p); } });
        await Promise.all(pending);
        return response;
      } };`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'neutral', conditions: ['workerd', 'worker'], mainFields: ['module', 'main'],
  });
  const upstream = { calls: [], handler: async () => Response.json({ posts: [] }) };
  const mf = new Miniflare({
    host: '127.0.0.1', port, telemetry: { enabled: false },
    workers: [{ config: {
      name: 'monitor-test', type: 'worker', compatibilityDate: '2026-09-04', compatibilityFlags: ['nodejs_compat'],
      manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
      env: { DB: { type: 'd1', id: 'test-db' }, ...Object.fromEntries(Object.entries({ MONITOR_PASSWORD: PASSWORD, BSKY_HANDLE: 'test.bsky.social', BSKY_APP_PASSWORD: 'test-app-password' }).map(([key, value]) => [key, { type: 'json', value }])),
    ...(assets ? { ASSETS: { type: 'fetcher', handler: async request => {
      const name = path.basename(new URL(request.url).pathname);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      try { return new Response(await readFile(path.join('dist', name)), { headers: { 'Content-Type': types[path.extname(name)] || 'application/octet-stream' } }); }
      catch { return new Response('Not found', { status: 404 }); }
    } } } : {}),
    } }, dev: { outboundService: { type: 'fetcher', handler: async request => {
      const url = new URL(request.url);
      upstream.calls.push(url);
      if (url.origin !== 'https://bsky.social') throw new Error(`Unexpected outbound origin: ${url.origin}`);
      if (url.pathname.endsWith('createSession') || url.pathname.endsWith('refreshSession')) return Response.json({ accessJwt: 'test-access', refreshJwt: 'test-refresh' });
      return upstream.handler(url, request);
    } } } }],
  });
  const db = await mf.getD1Database('DB');
  const migration = await readFile('worker/migrations/0001_monitor.sql', 'utf8');
  for (const statement of migration.split(';').filter(part => part.trim())) await db.prepare(statement).run();
  const origin = (await mf.ready).origin;
  let cookie = '';
  async function request(resource, method = 'GET', body, params = {}, extraHeaders = {}) {
    return mf.dispatchFetch(`${origin}/api/monitor?${new URLSearchParams({ resource, ...params })}`, {
      method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function login() {
    const response = await request('session', 'POST', { password: PASSWORD });
    if (response.status !== 200) throw new Error(`Login failed: ${await response.text()}`);
    cookie = response.headers.get('Set-Cookie').split(';')[0];
    return cookie;
  }
  async function unlock() { await db.prepare('UPDATE collector_state SET lease_until = 0, last_started_at = 0 WHERE id = 1').run(); }
  async function collect() { await unlock(); return mf.dispatchFetch(`${origin}/__test/collect`); }
  async function seedSearch(id = crypto.randomUUID(), query = 'local AI') {
    const now = Date.now();
    await db.prepare('INSERT INTO saved_searches (id, name, query, created_at, checkpoint_at) VALUES (?, ?, ?, ?, ?)').bind(id, query, query, now, now - 3600000).run();
    return id;
  }
  return { mf, db, upstream, origin, request, login, unlock, collect, seedSearch };
}
