import { assertConfigured, isSignedIn, login, logout } from './auth.mjs';
import { checkOrigin, HttpError, json, readJson } from './http.mjs';
import { collect } from './collector.mjs';

const MAX_SEARCHES = 10;

function positiveInteger(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpError(400, 'Invalid inbox cursor.');
  return parsed;
}

export async function monitorAPI(request, env, ctx) {
  try {
    assertConfigured(env);
    if (request.method !== 'GET') checkOrigin(request, env);
    const url = new URL(request.url);
    const resource = url.searchParams.get('resource') || 'session';
    if (resource === 'session') {
      if (request.method === 'POST') return await login(request, env);
      if (request.method === 'DELETE') return logout(request);
      if (request.method === 'GET') return json({ signedIn: await isSignedIn(request, env) });
    }
    if (!await isSignedIn(request, env)) throw new HttpError(401, 'Sign in to view your monitored searches.');

    if (resource === 'searches' && request.method === 'GET') {
      const { results } = await env.DB.prepare(`SELECT s.*,
        COUNT(p.id) AS total_count, COALESCE(SUM(p.read_at IS NULL AND p.id IS NOT NULL), 0) AS unread_count
        FROM saved_searches s LEFT JOIN matches m ON m.search_id = s.id LEFT JOIN posts p ON p.id = m.post_id
        GROUP BY s.id ORDER BY s.created_at, s.id`).all();
      const totals = await env.DB.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(read_at IS NULL), 0) AS unread FROM posts').first();
      const runtime = await env.DB.prepare('SELECT lease_until, last_started_at FROM collector_state WHERE id = 1').first();
      return json({ searches: results, ...totals, checking: runtime.lease_until > Date.now(), nextManualCheckAt: runtime.last_started_at + 60_000, intervalMinutes: 10, retentionDays: 30 });
    }
    if (resource === 'searches' && request.method === 'POST') {
      const body = await readJson(request);
      const query = typeof body?.query === 'string' ? body.query.trim() : '';
      const name = typeof body?.name === 'string' ? body.name.trim() || query.slice(0, 80) : query.slice(0, 80);
      if (!query || query.length > 500 || /[\u0000-\u001f\u007f]/.test(query)) throw new HttpError(400, 'Enter a search query of 1–500 characters.');
      if (name.length > 80) throw new HttpError(400, 'Keep the search name under 80 characters.');
      const now = Date.now();
      const id = crypto.randomUUID();
      const result = await env.DB.prepare(`INSERT INTO saved_searches (id, name, query, created_at, checkpoint_at)
        SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM saved_searches) < ?
        ON CONFLICT(query) DO NOTHING RETURNING id`).bind(id, name, query, now, now - 60 * 60_000, MAX_SEARCHES).first();
      if (!result) throw new HttpError(409, 'That query is already saved, or you have reached the limit of 10 searches.');
      ctx.waitUntil(collect(env));
      return json({ id }, 201);
    }
    const searchId = url.searchParams.get('id');
    if (resource === 'searches' && request.method === 'PATCH') {
      const body = await readJson(request);
      if (typeof body?.enabled !== 'boolean') throw new HttpError(400, 'Choose pause or resume.');
      const result = await env.DB.prepare('UPDATE saved_searches SET enabled = ? WHERE id = ? RETURNING id').bind(body.enabled ? 1 : 0, searchId).first();
      if (!result) throw new HttpError(404, 'Search not found.');
      if (body.enabled) ctx.waitUntil(collect(env));
      return json({ ok: true });
    }
    if (resource === 'searches' && request.method === 'DELETE') {
      const result = await env.DB.prepare('DELETE FROM saved_searches WHERE id = ? RETURNING id').bind(searchId).first();
      if (!result) throw new HttpError(404, 'Search not found.');
      await env.DB.prepare('DELETE FROM posts WHERE NOT EXISTS (SELECT 1 FROM matches WHERE matches.post_id = posts.id)').run();
      return json({ ok: true });
    }
    if (resource === 'check' && request.method === 'POST') {
      const runtime = await env.DB.prepare('SELECT lease_until, last_started_at FROM collector_state WHERE id = 1').first();
      if (runtime.lease_until > Date.now() || runtime.last_started_at > Date.now() - 60_000) throw new HttpError(429, 'A check is running or just finished. Try again in a minute.');
      ctx.waitUntil(collect(env));
      return json({ checking: true }, 202);
    }
    if (resource === 'inbox' && request.method === 'GET') {
      const before = positiveInteger(url.searchParams.get('before'), Number.MAX_SAFE_INTEGER);
      const search = url.searchParams.get('search') || '';
      const unread = url.searchParams.get('unread') !== '0';
      const { results } = await env.DB.prepare(`SELECT p.id, p.payload, p.found_at, p.read_at,
        (SELECT json_group_array(s.name) FROM matches m JOIN saved_searches s ON s.id = m.search_id WHERE m.post_id = p.id) AS search_names
        FROM posts p WHERE p.id < ? AND (? = 0 OR p.read_at IS NULL)
        AND (? = '' OR EXISTS (SELECT 1 FROM matches m WHERE m.post_id = p.id AND m.search_id = ?))
        ORDER BY p.id DESC LIMIT 51`).bind(before, unread ? 1 : 0, search, search).all();
      const items = results.slice(0, 50).map(row => ({ id: row.id, post: JSON.parse(row.payload), foundAt: row.found_at, readAt: row.read_at, searches: JSON.parse(row.search_names) }));
      return json({ items, nextCursor: results.length > 50 ? items.at(-1).id : null, throughId: items[0]?.id || 0 });
    }
    if (resource === 'read' && request.method === 'POST') {
      const body = await readJson(request);
      if (Array.isArray(body?.ids)) {
        if (!body.ids.length || body.ids.length > 50 || body.ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new HttpError(400, 'Choose 1–50 posts to mark as read.');
        const placeholders = body.ids.map(() => '?').join(',');
        await env.DB.prepare(`UPDATE posts SET read_at = ? WHERE id IN (${placeholders}) AND read_at IS NULL`).bind(Date.now(), ...body.ids).run();
      } else {
        const through = positiveInteger(body?.throughId);
        const search = typeof body?.search === 'string' ? body.search : '';
        if (!through) throw new HttpError(400, 'Load the inbox before marking posts as read.');
        await env.DB.prepare(`UPDATE posts SET read_at = ? WHERE id <= ? AND read_at IS NULL
          AND (? = '' OR EXISTS (SELECT 1 FROM matches m WHERE m.post_id = posts.id AND m.search_id = ?))`).bind(Date.now(), through, search, search).run();
      }
      return json({ ok: true });
    }
    throw new HttpError(405, 'This action is not supported.');
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error(JSON.stringify({ event: 'monitor_api_error', message: String(error.message).slice(0, 200) }));
    return json({ error: 'Monitoring is unavailable. Check the database setup and try again.' }, 503);
  }
}
