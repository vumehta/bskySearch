export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

// Bound both inbound JSON and upstream responses, including chunked bodies.
export async function readJson(message, limit = 8192) {
  const reader = message.body?.getReader();
  if (!reader) throw new HttpError(400, 'A JSON body is required.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, 'Response or request is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}

export function checkOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = [new URL(request.url).origin, env.APP_ORIGIN].filter(Boolean);
  if (!origin || !allowed.includes(origin)) throw new HttpError(403, 'This request must come from your dashboard.');
}
