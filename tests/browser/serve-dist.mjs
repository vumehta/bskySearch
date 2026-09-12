import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

// Serve only the built assets, with the same response headers as deployment.
const assets = new Map([
  ['/', ['bluesky-term-search.html', 'text/html']],
  ['/bluesky-term-search.html', ['bluesky-term-search.html', 'text/html']],
  ['/app.min.js', ['app.min.js', 'text/javascript']],
  ['/styles.min.css', ['styles.min.css', 'text/css']],
].map(([url, [name, contentType]]) => [url, {
  contentType,
  body: readFileSync(new URL(`../../dist/${name}`, import.meta.url)),
}]));
const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
const headers = Object.fromEntries(config.headers.flatMap((rule) => rule.headers)
  .map(({ key, value }) => [key, value]));

const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/favicon.ico') {
    response.writeHead(204).end();
    return;
  }
  const asset = assets.get(pathname);
  if (!asset) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Type': asset.contentType, 'Cache-Control': 'no-store' });
  response.end(asset.body);
});

server.listen(Number(process.env.BROWSER_TEST_PORT || 4173), '127.0.0.1');
process.on('SIGTERM', () => server.close());
