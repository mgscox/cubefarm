// Bundles server/ (and the shared/ code it uses) into dist-server/index.js for the npm package.
// Node won't run TypeScript from inside node_modules, so the published server is plain JavaScript.
// Dependencies stay external: npm installs them next to the package.
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist-server');

fs.rmSync(out, { recursive: true, force: true });
await build({
  // The terminal keeper (ptyHost) runs as a process of its own, started from the server's folder; on a box it loads
  // boxOps by path, and `cubefarm box` runs boxStdio.
  entryPoints: ['index.ts', 'ptyHost.ts', 'boxOps.ts', 'boxStdio.ts'].map((f) => path.join(root, 'server', f)),
  outdir: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  logLevel: 'warning',
});
// Loaded by path at runtime: agentRunner.ts hands it to each agent's Playwright browser.
fs.copyFileSync(path.join(root, 'server', 'browser-init.js'), path.join(out, 'browser-init.js'));
console.log(`built ${path.relative(root, out)}/index.js`);
