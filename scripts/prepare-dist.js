const fs = require('fs');
const path = require('path');
const securityHeaders = require('../worker/security-headers.json');

const distDir = path.join(__dirname, '..', 'dist');
const files = [
  'bluesky-term-search.html',
  'app.min.js',
  'styles.min.css',
];

fs.mkdirSync(distDir, { recursive: true });

for (const file of files) {
  const src = path.join(__dirname, '..', file);
  const dest = path.join(distDir, file);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing build artifact: ${file}`);
  }
  fs.copyFileSync(src, dest);
}

// Workers serves index.html at `/`. The original name stays while Vercel's rewrite still points at it,
// but isn't uploaded to Workers, where it would be a second copy of the page without a CSP nonce.
fs.copyFileSync(path.join(distDir, 'bluesky-term-search.html'), path.join(distDir, 'index.html'));
fs.writeFileSync(path.join(distDir, '.assetsignore'), 'bluesky-term-search.html\n');

const headerLines = Object.entries(securityHeaders).map(([name, value]) => `  ${name}: ${value}`);
fs.writeFileSync(path.join(distDir, '_headers'), `/*\n${headerLines.join('\n')}\n`);
