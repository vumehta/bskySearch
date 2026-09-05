import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST, PATCH, DELETE } from '../api/monitor.mjs';
import { monitorAPI } from '../worker/api.mjs';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('monitoring configuration and Vercel bridge', () => {
  it('shows an actionable setup error instead of an empty inbox when unconfigured', async () => {
    vi.stubEnv('MONITOR_WORKER_URL', '');
    const response = await GET(new Request('https://app.example/api/monitor?resource=inbox'));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain('not connected');
    const direct = await monitorAPI(new Request('https://worker.example/api/monitor'), {}, {});
    expect(direct.status).toBe(503);
    expect((await direct.json()).error).toContain('password');
  });

  it('forwards only the intended API, origin, cookie, body and response cookie', async () => {
    vi.stubEnv('MONITOR_WORKER_URL', 'https://monitor.example');
    const fetchMock = vi.fn(async (_url, options) => {
      expect(await new Response(options.body).json()).toEqual({ query: 'local AI' });
      return Response.json({ id: 'new-search' }, { status: 201, headers: { 'Set-Cookie': 'session=opaque; HttpOnly', 'Cache-Control': 'no-store' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await POST(new Request('https://app.example/api/monitor?resource=searches', {
      method: 'POST', headers: { Origin: 'https://app.example', Cookie: 'session=old', Authorization: 'must-not-forward', 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'local AI' }),
    }));
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.href).toBe('https://monitor.example/api/monitor?resource=searches');
    expect(options.headers.get('Origin')).toBe('https://app.example');
    expect(options.headers.get('Cookie')).toBe('session=old');
    expect(options.headers.has('Authorization')).toBe(false);
    expect(response.status).toBe(201);
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(PATCH).toBe(POST);
    expect(DELETE).toBe(POST);
  });

  it('rejects insecure configuration and reports an unreachable Worker', async () => {
    vi.stubEnv('MONITOR_WORKER_URL', 'http://monitor.example');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await GET(new Request('https://app.example/api/monitor'))).status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv('MONITOR_WORKER_URL', 'https://monitor.example');
    fetchMock.mockRejectedValue(new Error('private network details'));
    const response = await GET(new Request('https://app.example/api/monitor'));
    expect(response.status).toBe(502);
    expect((await response.json()).error).not.toContain('private network');
  });
});
