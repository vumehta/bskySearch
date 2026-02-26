const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
const files = [
  'bluesky-term-search.html',
  'app.min.js',
  'styles.min.css',
];

// Cloudflare Pages config files (copied if present, not required)
const optionalFiles = [
  '_headers',
  '_redirects',
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

for (const file of optionalFiles) {
  const src = path.join(__dirname, '..', file);
  const dest = path.join(distDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
  }
}
