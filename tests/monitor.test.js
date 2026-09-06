import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { startMonitorRuntime, fixturePost } from './helpers/monitor-runtime.mjs';

describe('monitoring Worker with real D1', () => {
  let runtime;
  beforeAll(async () => { runtime = await startMonitorRuntime(); }, 30000);
  afterAll(async () => { await runtime?.mf.dispose(); });
  beforeEach(async () => {
    await runtime.db.batch([
      runtime.db.prepare('DELETE FROM saved_searches'), runtime.db.prepare('DELETE FROM posts'), runtime.db.prepare('DELETE FROM login_attempts'),
      runtime.db.prepare('UPDATE collector_state SET lease_until = 0, last_started_at = 0, access_jwt = NULL, refresh_jwt = NULL, session_expires_at = NULL WHERE id = 1'),
    ]);
    runtime.upstream.calls.length = 0;
    runtime.upstream.handler = async () => Response.json({ posts: [] });
    await runtime.login();
  });

  it('protects inbox data and validates sign-in, cookies, and request origin', async () => {
    const anonymous = await runtime.request('inbox', 'GET', undefined, {}, { Cookie: '' });
    expect(anonymous.status).toBe(401);
    const badPassword = await runtime.request('session', 'POST', { password: 'wrong' });
    expect(badPassword.status).toBe(401);
    const forgedCookie = await runtime.request('inbox', 'GET', undefined, {}, { Cookie: 'bsky_monitor_session=9999999999999.00000000-0000-0000-0000-000000000000.' + 'a'.repeat(64) });
    expect(forgedCookie.status).toBe(401);
    const csrf = await runtime.request('searches', 'POST', { query: 'test' }, {}, { Origin: 'https://other.example' });
    expect(csrf.status).toBe(403);
    const session = await runtime.request('session');
    expect(await session.json()).toEqual({ signedIn: true });
    const logout = await runtime.request('session', 'DELETE');
    expect(logout.headers.get('Set-Cookie')).toContain('HttpOnly; SameSite=Strict; Max-Age=0');
  });

  it('limits repeated password guesses and rejects oversized bodies', async () => {
    for (let i = 0; i < 9; i++) await runtime.request('session', 'POST', { password: 'wrong' });
    expect((await runtime.request('session', 'POST', { password: 'wrong' })).status).toBe(429);
    expect((await runtime.request('searches', 'POST', { query: 'x'.repeat(9000) })).status).toBe(413);
  });

  it('creates saved queries, rejects duplicates and invalid input, and enforces the cap', async () => {
    expect((await runtime.request('searches', 'POST', { query: '' })).status).toBe(400);
    expect((await runtime.request('searches', 'POST', { query: 'local AI', name: 'AI news' })).status).toBe(201);
    expect((await runtime.request('searches', 'POST', { query: 'LOCAL AI' })).status).toBe(409);
    for (let i = 1; i < 10; i++) await runtime.seedSearch(`search-${i}`, `topic-${i}`);
    expect((await runtime.request('searches', 'POST', { query: 'one too many' })).status).toBe(409);
    expect((await (await runtime.request('searches')).json()).searches).toHaveLength(10);
  });

  it('collects from the scheduled handler, deduplicates overlaps and queries, and preserves read state', async () => {
    await runtime.seedSearch('one', 'local AI');
    await runtime.seedSearch('two', 'AI models');
    runtime.upstream.handler = async () => Response.json({ posts: [fixturePost('p1'), fixturePost('p1')] });
    await runtime.collect();
    let inbox = await (await runtime.request('inbox')).json();
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].searches.sort()).toEqual(['AI models', 'local AI']);
    const id = inbox.items[0].id;
    await runtime.request('read', 'POST', { ids: [id] });
    await runtime.collect();
    inbox = await (await runtime.request('inbox')).json();
    expect(inbox.items).toHaveLength(0);
    expect((await (await runtime.request('inbox', 'GET', undefined, { unread: '0' })).json()).items).toHaveLength(1);
    expect(runtime.upstream.calls.filter(url => url.pathname.endsWith('createSession'))).toHaveLength(1);
    const search = runtime.upstream.calls.find(url => url.pathname.endsWith('searchPosts'));
    expect(search.searchParams.get('sort')).toBe('latest');
    expect(search.searchParams.get('lang')).toBe('en');
    expect(search.searchParams.has('since')).toBe(true);
    expect(search.searchParams.has('until')).toBe(true);
  });

  it('continues bounded pagination with a frozen window and advances only after exhaustion', async () => {
    await runtime.seedSearch('one');
    const start = await runtime.db.prepare('SELECT checkpoint_at FROM saved_searches').first();
    runtime.upstream.handler = async url => {
      const page = Number(url.searchParams.get('cursor') || 0);
      return Response.json({ posts: [fixturePost(`page${page}`)], cursor: page < 3 ? String(page + 1) : undefined });
    };
    await runtime.collect();
    const pending = await runtime.db.prepare('SELECT * FROM saved_searches').first();
    expect(pending.scan_cursor).toBe('3');
    expect(pending.checkpoint_at).toBe(start.checkpoint_at);
    expect(pending.last_checked_at).toBeNull();
    await runtime.collect();
    const done = await runtime.db.prepare('SELECT * FROM saved_searches').first();
    expect(done.scan_cursor).toBeNull();
    expect(done.checkpoint_at).toBe(pending.scan_until);
    expect(done.last_checked_at).toBeGreaterThan(0);
    expect((await (await runtime.request('inbox')).json()).items).toHaveLength(4);
    const windows = runtime.upstream.calls.filter(url => url.pathname.endsWith('searchPosts')).map(url => url.searchParams.get('until'));
    expect(new Set(windows).size).toBe(1);
  });

  it('keeps its checkpoint on upstream failure and recovers without duplicates', async () => {
    await runtime.seedSearch('one');
    runtime.upstream.handler = async url => url.searchParams.has('cursor') ? Response.json({}, { status: 429 }) : Response.json({ posts: [fixturePost('p1')], cursor: 'next' });
    await runtime.collect();
    const failed = await runtime.db.prepare('SELECT * FROM saved_searches').first();
    expect(failed.last_error).toContain('rate limit');
    expect(failed.scan_cursor).toBe('next');
    expect(failed.last_checked_at).toBeNull();
    runtime.upstream.handler = async () => Response.json({ posts: [fixturePost('p1'), fixturePost('p2')] });
    await runtime.collect();
    expect((await (await runtime.request('inbox')).json()).items).toHaveLength(2);
    const done = await runtime.db.prepare('SELECT * FROM saved_searches').first();
    expect(done.last_error).toBeNull();
    expect(done.checkpoint_at).toBe(failed.scan_until);
  });

  it('restarts an expired cursor in the same window and handles malformed responses', async () => {
    await runtime.seedSearch('one');
    await runtime.db.prepare("UPDATE saved_searches SET scan_until = ?, scan_cursor = 'expired'").bind(Date.now()).run();
    runtime.upstream.handler = async () => Response.json({}, { status: 400 });
    await runtime.collect();
    const restarted = await runtime.db.prepare('SELECT * FROM saved_searches').first();
    expect(restarted.scan_cursor).toBeNull();
    expect(restarted.scan_until).toBeGreaterThan(0);
    runtime.upstream.handler = async () => Response.json({ unexpected: true });
    await runtime.collect();
    const failed = await runtime.db.prepare('SELECT * FROM saved_searches').first();
    expect(failed.last_error).toContain('unexpected');
    expect(failed.checkpoint_at).toBe(restarted.checkpoint_at);
  });

  it('honors pause/resume and prevents overlapping or repeated manual checks', async () => {
    await runtime.seedSearch('one');
    expect((await runtime.request('searches', 'PATCH', { enabled: false }, { id: 'one' })).status).toBe(200);
    await runtime.collect();
    expect(runtime.upstream.calls).toHaveLength(0);
    await runtime.request('searches', 'PATCH', { enabled: true }, { id: 'one' });
    await runtime.unlock();
    expect((await runtime.request('check', 'POST')).status).toBe(202);
    expect((await runtime.request('check', 'POST')).status).toBe(429);
    await runtime.unlock();
    const responses = await Promise.all([runtime.mf.dispatchFetch(`${runtime.origin}/__test/collect`), runtime.mf.dispatchFetch(`${runtime.origin}/__test/collect`)]);
    expect(responses.every(r => r.ok)).toBe(true);
    expect(runtime.upstream.calls.filter(url => url.pathname.endsWith('searchPosts'))).toHaveLength(2);
  });

  it('marks only the selected snapshot read while leaving later arrivals unread', async () => {
    await runtime.seedSearch('one');
    runtime.upstream.handler = async () => Response.json({ posts: [fixturePost('first')] });
    await runtime.collect();
    const snapshot = await (await runtime.request('inbox')).json();
    runtime.upstream.handler = async () => Response.json({ posts: [fixturePost('second')] });
    await runtime.collect();
    await runtime.request('read', 'POST', { throughId: snapshot.throughId });
    const inbox = await (await runtime.request('inbox')).json();
    expect(inbox.items.map(item => item.post.uri)).toEqual([fixturePost('second').uri]);
  });

  it('paginates the inbox, filters by query, deletes orphaned matches, and retains shared posts', async () => {
    await runtime.seedSearch('one', 'topic one');
    await runtime.seedSearch('two', 'topic two');
    runtime.upstream.handler = async url => Response.json({ posts: url.searchParams.get('q') === 'topic one' ? Array.from({ length: 55 }, (_, i) => fixturePost(`p${i}`)) : [fixturePost('p0')] });
    await runtime.collect();
    const first = await (await runtime.request('inbox')).json();
    expect(first.items).toHaveLength(50);
    const second = await (await runtime.request('inbox', 'GET', undefined, { before: first.nextCursor })).json();
    expect(second.items).toHaveLength(5);
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(55);
    expect((await (await runtime.request('inbox', 'GET', undefined, { search: 'two' })).json()).items).toHaveLength(1);
    await runtime.request('searches', 'DELETE', undefined, { id: 'one' });
    expect((await (await runtime.request('inbox')).json()).items).toHaveLength(1);
    await runtime.request('searches', 'DELETE', undefined, { id: 'two' });
    expect((await (await runtime.request('inbox')).json()).items).toHaveLength(0);
  });

  it('prunes matches older than 30 days and never treats upstream text as markup', async () => {
    await runtime.seedSearch('one');
    const unsafeText = '<img src=x onerror=alert(1)>';
    runtime.upstream.handler = async () => Response.json({ posts: [fixturePost('p1', unsafeText), { uri: 'javascript:alert(1)', record: { text: 'bad' } }] });
    await runtime.collect();
    const inbox = await (await runtime.request('inbox')).json();
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].post.text).toBe(unsafeText);
    expect(inbox.items[0].post.url).toMatch(/^https:\/\/bsky\.app\/profile\//);
    await runtime.db.prepare('UPDATE posts SET found_at = ?').bind(Date.now() - 31 * 86400000).run();
    runtime.upstream.handler = async () => Response.json({ posts: [] });
    await runtime.collect();
    expect((await (await runtime.request('inbox')).json()).items).toHaveLength(0);
  });
});
