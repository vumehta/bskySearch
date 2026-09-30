const fs = require('fs');
const path = require('path');
const securityHeaders = require('../worker/security-headers.json');

const distDir = path.join(__dirname, '..', 'dist');
const files = [
  ['bluesky-term-search.html', 'index.html'],
  ['app.min.js', 'app.min.js'],
  ['styles.min.css', 'styles.min.css'],
];

// Start clean so a deploy never uploads files an earlier build left behind.
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

for (const [file, name] of files) {
  const src = path.join(__dirname, '..', file);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing build artifact: ${file}`);
  }
  fs.copyFileSync(src, path.join(distDir, name));
}

const headerLines = Object.entries(securityHeaders).map(([name, value]) => `  ${name}: ${value}`);
fs.writeFileSync(path.join(distDir, '_headers'), `/*\n${headerLines.join('\n')}\n`);
