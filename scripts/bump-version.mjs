// Adds ?v=<stamp> to every local module import and to the CSS/JS links in index.html,
// so a browser never mixes old cached files with new ones after a deploy.
// Run before each push:  node scripts/bump-version.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const v = Date.now().toString(36);
const files = ['index.html', ...fs.readdirSync(path.join(root, 'js')).map((f) => 'js/' + f), 'vendor/OrbitControls.js'];
for (const f of files) {
  const p = path.join(root, f);
  const src = fs.readFileSync(p, 'utf8');
  const out = src
    .replace(/(from\s+['"])(\.{1,2}\/[^'"?]+\.js)(\?v=[^'"]*)?(['"])/g, `$1$2?v=${v}$4`)
    .replace(/((?:src|href)=")((?:js\/|style)[^"?]*\.(?:js|css))(\?v=[^"]*)?(")/g, `$1$2?v=${v}$4`);
  if (out !== src) fs.writeFileSync(p, out);
}
console.log('version', v);
