const fs = require('fs');
const path = require('path');

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
