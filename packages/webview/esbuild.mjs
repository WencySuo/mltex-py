// Bundles the webview app into packages/client/media/webview.js
// (plan §3.2: "webview/ — panel UI (bundled into client/media)").
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(here, 'src/main.ts')],
  outfile: path.resolve(here, '../client/media/webview.js'),
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  sourcemap: true,
  logLevel: 'info',
});
