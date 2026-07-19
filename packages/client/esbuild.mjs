// Bundles the VS Code extension into dist/extension.cjs.
// The server bundle is built by @mathlens/server (dist/server.cjs) and the
// webview bundle by @mathlens/webview (into ./media/webview.js).
//
// F2 (integration fix): the extension resolves the server at
// <extension>/server/server.cjs, so this build also copies the server bundle
// (server.cjs + both tree-sitter wasm files + sourcemap) from
// ../server/dist into ./server/. If the server hasn't been built yet the copy
// is skipped with a warning (extension.ts falls back to ../server/dist in
// dev — see extension.ts resolveServerModule()).
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, 'src/extension.ts')],
  outfile: path.join(here, 'dist/extension.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
});

// Copy the server bundle + wasm files into <extension root>/server/.
const serverDist = path.resolve(here, '../server/dist');
const serverOut = path.join(here, 'server');
if (existsSync(path.join(serverDist, 'server.cjs'))) {
  mkdirSync(serverOut, { recursive: true });
  for (const file of readdirSync(serverDist)) {
    if (/\.(cjs|map|wasm)$/.test(file)) {
      copyFileSync(path.join(serverDist, file), path.join(serverOut, file));
    }
  }
  console.log('server bundle copied to', serverOut);
} else {
  console.warn(
    `WARN: ${serverDist}/server.cjs not found — build @mathlens/server first ` +
      '(npm run build at the repo root builds in dependency order). ' +
      'The extension falls back to packages/server/dist in development.',
  );
}
