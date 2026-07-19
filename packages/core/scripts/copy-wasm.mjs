// Vendors the tree-sitter wasm binaries into packages/core/wasm/ so bundled
// deployments (server bundle) can resolve them without node_modules.
// Run automatically as part of `npm run build` in @mathlens/core.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const wasmDir = path.resolve(here, '../wasm');
mkdirSync(wasmDir, { recursive: true });

// 1. tree-sitter-python.wasm — ships at the root of the tree-sitter-python package.
const tspPkg = require.resolve('tree-sitter-python/package.json');
const tspWasm = path.join(path.dirname(tspPkg), 'tree-sitter-python.wasm');
if (!existsSync(tspWasm)) {
  console.error(`ERROR: ${tspWasm} not found — did tree-sitter-python stop shipping its wasm?`);
  console.error('Fallback: npm i -D tree-sitter-wasms and copy out/tree-sitter-python.wasm.');
  process.exit(1);
}
copyFileSync(tspWasm, path.join(wasmDir, 'tree-sitter-python.wasm'));

// 2. tree-sitter.wasm — the web-tree-sitter runtime. The package's exports
// map exposes the wasm as an explicit subpath (it does NOT expose package.json).
const wtsWasm = require.resolve('web-tree-sitter/tree-sitter.wasm');
copyFileSync(wtsWasm, path.join(wasmDir, 'tree-sitter.wasm'));

console.log(`Vendored tree-sitter wasm binaries into ${wasmDir}`);
