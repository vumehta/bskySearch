// Optional same-origin bridge for the existing Vercel deployment. The Worker
// can also serve the full app itself, in which case this bridge is unused.
async function proxy(request) {
  const configured = process.env.MONITOR_WORKER_URL;
  if (!configured) return Response.json({ error: 'Monitoring is not connected yet. The owner needs to configure the monitoring service.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  try {
    const target = new URL(configured);
    if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Invalid Worker URL');
    target.pathname = '/api/monitor';
    target.search = new URL(request.url).search;
    const headers = new Headers();
    for (const name of ['cookie', 'content-type', 'origin']) {
      if (request.headers.has(name)) headers.set(name, request.headers.get(name));
    }
    const response = await fetch(target, {
      method: request.method, headers, redirect: 'error',
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      duplex: 'half', signal: AbortSignal.timeout(15_000),
    });
    return new Response(response.body, { status: response.status, headers: response.headers });
  } catch {
    return Response.json({ error: 'Could not reach the monitoring service. Please try again.' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
