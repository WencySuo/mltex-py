/**
 * MathLens language server entry point (plan §3.3, §3.4).
 *
 * OWNED BY AGENT B. Wires up the connection, advertises hover + codeLens
 * capabilities, captures the workspace root for mathlens.toml, points core's
 * parser at the wasm files bundled beside this file, and registers all
 * standard + custom handlers. Every call into @mathlens/core degrades
 * gracefully while agent A implements the bodies (plan principle 3).
 */

import * as path from 'node:path';
import {
  createConnection,
  ProposedFeatures,
  TextDocumentSyncKind,
  type InitializeParams,
  type InitializeResult,
} from 'vscode-languageserver/node';

import {
  DocumentMathRequest,
  EmitLatexRequest,
  FunctionMathRequest,
  SelectionMathRequest,
  WorkflowMathRequest,
} from '@mathlens/core/protocol';

import { MathLensDocuments } from './documents.js';
import { registerHover } from './hover.js';
import { registerCodeLens } from './codelens.js';
import { registerCustomRequests } from './custom.js';

const connection = createConnection(ProposedFeatures.all);
const documents = new MathLensDocuments();

// When bundled, __dirname is dist/ where esbuild copied the wasm files;
// during source-run (vitest/tsx) core falls back to its vendored wasm/.
try {
  // eslint-disable-next-line no-undef
  documents.setWasmDir(typeof __dirname !== 'undefined' ? __dirname : path.resolve('.'));
} catch {
  // ESM context without __dirname — core's own resolution handles it.
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  documents.initialize(params);
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      codeLensProvider: { resolveProvider: false },
    },
    serverInfo: { name: 'mathlens-server', version: '0.0.1' },
  };
});

connection.onInitialized(() => {
  connection.console.log('MathLens server initialized.');
  connection.console.log(
    `Custom requests registered: ${[
      DocumentMathRequest,
      FunctionMathRequest,
      SelectionMathRequest,
      WorkflowMathRequest,
      EmitLatexRequest,
    ].join(', ')}`,
  );
});

documents.listen(connection);
registerHover(connection, documents);
registerCodeLens(connection, documents);
registerCustomRequests(connection, documents);

connection.listen();
