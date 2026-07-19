/**
 * MathLens VS Code extension entry point (plan §3.2, §3.3).
 * OWNED BY AGENT C. Skeleton: starts the LanguageClient against the bundled
 * server, registers command stubs. Typechecks today; agent C fills in
 * the panel host, sync, and PDF export.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Range } from '@mathlens/core';
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';

import { PanelHost } from './panel/panelHost.js';
import { DapAnnotationSource } from './panel/dapAnnotations.js';
import { exportPdf } from './pdf/export.js';

let client: LanguageClient | undefined;

/**
 * Resolve the language-server bundle. Packaged extension: <extension>/server/
 * (populated by the client build copy step, see esbuild.mjs). Development
 * (monorepo layout): packages/server/dist/server.cjs relative to
 * packages/client/.
 */
export function resolveServerModule(context: vscode.ExtensionContext): string {
  const packaged = context.asAbsolutePath(path.join('server', 'server.cjs'));
  if (fs.existsSync(packaged)) return packaged;
  // Dev fallback: <repo>/packages/client → <repo>/packages/server/dist.
  const dev = context.asAbsolutePath(path.join('..', 'server', 'dist', 'server.cjs'));
  if (fs.existsSync(dev)) return dev;
  return packaged; // let the LanguageClient surface a clear startup error
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // The server bundle + wasm files are copied into the extension's server/
  // directory by the client build (esbuild.mjs); during development they live
  // in packages/server/dist (see CONTRACTS.md "Build & run").
  const serverModule = resolveServerModule(context);

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'python' }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/mathlens.toml'),
    },
  };

  client = new LanguageClient('mathlens', 'MathLens', serverOptions, clientOptions);
  await client.start();

  const panelHost = new PanelHost(context, client);

  // Client-side annotation source (stubbed DAP provider — plan §10.5): wires
  // the panel's `annotations` message end-to-end today, real DAP later.
  new DapAnnotationSource(panelHost).activate(context);

  context.subscriptions.push(
    // CodeLens args: (uri, qualname, range) — range selects the CLICKED
    // function, independent of where the cursor happens to be (F9).
    vscode.commands.registerCommand(
      'mathlens.viewAsMath',
      (uri?: string, qualname?: string, range?: Range) =>
        panelHost.showFunction(uri, qualname, range),
    ),
    vscode.commands.registerCommand('mathlens.renderSelection', () => panelHost.showSelection()),
    vscode.commands.registerCommand('mathlens.viewWorkflow', (uri?: string, qualname?: string) =>
      panelHost.showWorkflow(uri, qualname),
    ),
    vscode.commands.registerCommand(
      'mathlens.exportPdf',
      async (uri?: string, qualname?: string, range?: Range) => {
        // Lens variant: render the clicked function first so the export
        // snapshots it (principle 2), then export.
        if (uri && range) await panelHost.showFunction(uri, qualname, range);
        await exportPdf(context, client!, panelHost);
      },
    ),
    vscode.commands.registerCommand('mathlens.copyLatex', () => panelHost.copyLatexToClipboard()),
  );
}

export async function deactivate(): Promise<void> {
  await client?.stop();
  client = undefined;
}
