// Bundles the language server into dist/server.cjs and copies the tree-sitter
// wasm binaries next to the bundle (see packages/core/README.md, "WASM resolution").
// The server passes `wasmDir: __dirname` to initParser at startup.
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(here, 'src/server.ts')],
  outfile: path.join(dist, 'server.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  // web-tree-sitter loads its wasm at runtime; keep node builtins external-by-platform.
  logLevel: 'info',
});

// Copy wasm binaries next to the bundle.
const tspWasm = path.join(
  path.dirname(require.resolve('tree-sitter-python/package.json')),
  'tree-sitter-python.wasm',
);
// web-tree-sitter's exports map exposes the wasm as an explicit subpath.
const wtsWasm = require.resolve('web-tree-sitter/tree-sitter.wasm');
for (const src of [tspWasm, wtsWasm]) {
  if (!existsSync(src)) {
    console.error(`ERROR: ${src} not found`);
    process.exit(1);
  }
  copyFileSync(src, path.join(dist, path.basename(src)));
}
console.log('server bundle + wasm ready in', dist);
