import { readJson } from './http.mjs';

const SERVICE = 'https://bsky.social/xrpc';

async function call(method, options = {}, deadline = Infinity) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new DOMException('Collection time budget exhausted.', 'TimeoutError');
  const response = await fetch(`${SERVICE}/${method}`, { ...options, signal: AbortSignal.timeout(Math.min(6000, remaining)) });
  const payload = await readJson(response, 2 * 1024 * 1024);
  if (!response.ok) {
    const error = new Error(response.status === 429 ? 'Bluesky rate limit reached. The next check will retry.' : `Bluesky returned ${response.status}. The next check will retry.`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function saveSession(env, session) {
  if (!session?.accessJwt || !session?.refreshJwt) throw new Error('Bluesky did not return a usable session.');
  // Refresh ahead of Bluesky's normal access-token expiration; no isolate cache.
  await env.DB.prepare(`UPDATE collector_state SET session_handle = ?, access_jwt = ?, refresh_jwt = ?, session_expires_at = ? WHERE id = 1`)
    .bind(env.BSKY_HANDLE, session.accessJwt, session.refreshJwt, Date.now() + 60 * 60_000).run();
  return session.accessJwt;
}

export async function getSession(env, forceRefresh = false, deadline = Infinity) {
  if (!env.BSKY_HANDLE || !env.BSKY_APP_PASSWORD) throw new Error('Bluesky credentials are missing. Ask the owner to finish monitoring setup.');
  const state = await env.DB.prepare('SELECT * FROM collector_state WHERE id = 1').first();
  if (state.session_handle === env.BSKY_HANDLE) {
    if (!forceRefresh && state.access_jwt && state.session_expires_at > Date.now()) return state.access_jwt;
    if (state.refresh_jwt) {
      try {
        return await saveSession(env, await call('com.atproto.server.refreshSession', { method: 'POST', headers: { Authorization: `Bearer ${state.refresh_jwt}` } }, deadline));
      } catch (error) {
        if (error.status !== 400 && error.status !== 401) throw error;
      }
    }
  }
  return saveSession(env, await call('com.atproto.server.createSession', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: env.BSKY_HANDLE, password: env.BSKY_APP_PASSWORD }),
  }, deadline));
}

export async function searchPage(env, query, since, until, cursor, session) {
  const params = new URLSearchParams({ q: query, sort: 'latest', lang: 'en', limit: '100', since: new Date(since).toISOString(), until: new Date(until).toISOString() });
  if (cursor) params.set('cursor', cursor);
  let payload;
  try {
    payload = await call(`app.bsky.feed.searchPosts?${params}`, { headers: { Authorization: `Bearer ${session.token}` } }, session.deadline);
  } catch (error) {
    if (error.status !== 401) throw error;
    session.token = await getSession(env, true, session.deadline);
    payload = await call(`app.bsky.feed.searchPosts?${params}`, { headers: { Authorization: `Bearer ${session.token}` } }, session.deadline);
  }
  if (!Array.isArray(payload?.posts) || payload.posts.length > 100 || (payload.cursor != null && typeof payload.cursor !== 'string')) {
    throw new Error('Bluesky returned an unexpected response. The next check will retry.');
  }
  return payload;
}

export function compactPost(post) {
  if (!post || typeof post.uri !== 'string' || !/^at:\/\/did:[a-z]+:[a-zA-Z0-9._:%-]+\/app\.bsky\.feed\.post\/[a-zA-Z0-9._~-]+$/.test(post.uri)) return null;
  if (typeof post.record?.text !== 'string') return null;
  const [, actor, postId] = post.uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return {
    uri: post.uri, text: post.record.text.slice(0, 12000),
    author: { handle: String(post.author?.handle || actor).slice(0, 253), displayName: String(post.author?.displayName || '').slice(0, 256) },
    url: `https://bsky.app/profile/${encodeURIComponent(actor)}/post/${encodeURIComponent(postId)}`,
    createdAt: Number.isFinite(Date.parse(post.record.createdAt)) ? post.record.createdAt : post.indexedAt,
    likeCount: count(post.likeCount), repostCount: count(post.repostCount), replyCount: count(post.replyCount),
  };
}
