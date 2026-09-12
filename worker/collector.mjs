import { compactPost, getSession, searchPage } from './bluesky.mjs';

const OVERLAP = 30 * 60_000;
const RETENTION = 30 * 24 * 60 * 60_000;
const MAX_PAGES = 3;
const RUN_BUDGET = 22_000;

export async function collect(env) {
  const started = Date.now();
  const token = crypto.randomUUID();
  const lease = await env.DB.prepare(`UPDATE collector_state SET lease_token = ?, lease_until = ?, last_started_at = ?
    WHERE id = 1 AND lease_until <= ? AND last_started_at <= ? RETURNING id`)
    .bind(token, started + 90_000, started, started, started - 60_000).first();
  if (!lease) return { skipped: true };
  let checked = 0;
  let added = 0;
  try {
    const searches = await env.DB.prepare(`SELECT * FROM saved_searches WHERE enabled = 1 ORDER BY COALESCE(last_attempt_at, 0), created_at LIMIT 10`).all();
    let session;
    for (const search of searches.results) {
      if (Date.now() - started >= RUN_BUDGET) break;
      await env.DB.prepare('UPDATE saved_searches SET last_attempt_at = ? WHERE id = ?').bind(Date.now(), search.id).run();
      try {
        session ||= { token: await getSession(env, false, started + RUN_BUDGET), deadline: started + RUN_BUDGET };
        const until = search.scan_until || started;
        const since = Math.max(search.created_at - 60 * 60_000, search.checkpoint_at - OVERLAP);
        let cursor = search.scan_cursor || null;
        for (let page = 0; page < MAX_PAGES && Date.now() - started < RUN_BUDGET; page++) {
          // Honor a pause/delete made while a network request was in progress.
          const current = await env.DB.prepare('SELECT enabled FROM saved_searches WHERE id = ?').bind(search.id).first();
          if (!current?.enabled) break;
          const payload = await searchPage(env, search.query, since, until, cursor, session);
          if (payload.cursor && payload.cursor === cursor) throw new Error('Bluesky repeated a page. The next check will retry.');
          const statements = [];
          const posts = new Map(payload.posts.map(compactPost).filter(Boolean).map(post => [post.uri, post]));
          for (const post of posts.values()) {
            // Gated inserts avoid resurrecting results after a search is deleted.
            statements.push(env.DB.prepare(`INSERT INTO posts (uri, payload, found_at)
              SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM saved_searches WHERE id = ? AND enabled = 1)
              ON CONFLICT(uri) DO UPDATE SET payload = excluded.payload`).bind(post.uri, JSON.stringify(post), Date.now(), search.id));
            statements.push(env.DB.prepare(`INSERT OR IGNORE INTO matches (search_id, post_id)
              SELECT s.id, p.id FROM saved_searches s, posts p WHERE s.id = ? AND s.enabled = 1 AND p.uri = ?`).bind(search.id, post.uri));
          }
          const nextCursor = payload.cursor || null;
          statements.push(env.DB.prepare(`UPDATE saved_searches SET scan_until = ?, scan_cursor = ?, checkpoint_at = ?, last_checked_at = ?, last_error = NULL
            WHERE id = ? AND enabled = 1`).bind(nextCursor ? until : null, nextCursor, nextCursor ? search.checkpoint_at : until, nextCursor ? search.last_checked_at : Date.now(), search.id));
          // Each page and its checkpoint commit together. Failures can replay safely.
          const results = await env.DB.batch(statements);
          added += results.filter((_, index) => index % 2 === 1).reduce((sum, result) => sum + (result.meta?.changes || 0), 0);
          cursor = nextCursor;
          if (!cursor) { checked++; break; }
        }
      } catch (error) {
        const message = error.name === 'TimeoutError' ? 'Bluesky timed out. The next check will retry.' : error.message;
        // Expired pagination cursors restart the same window without advancing it.
        await env.DB.prepare(`UPDATE saved_searches SET last_error = ?, scan_cursor = CASE WHEN ? = 400 THEN NULL ELSE scan_cursor END WHERE id = ?`)
          .bind(String(message || 'Check failed. The next check will retry.').slice(0, 300), error.status || 0, search.id).run();
        console.warn(JSON.stringify({ event: 'monitor_check_failed', searchId: search.id, status: error.status || null }));
      }
    }
    await env.DB.prepare('DELETE FROM posts WHERE found_at < ?').bind(started - RETENTION).run();
    console.log(JSON.stringify({ event: 'monitor_collection', checked, added }));
    return { checked, added };
  } finally {
    await env.DB.prepare('UPDATE collector_state SET lease_token = NULL, lease_until = 0 WHERE id = 1 AND lease_token = ?').bind(token).run();
  }
}
