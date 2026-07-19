/**
 * @mathlens/core — public API surface.
 *
 * ZERO vscode/LSP dependencies (plan §10.2). Server, client, and webview all
 * import their shared contracts from here (or the `./protocol` /
 * `./panelProtocol` subpath exports).
 */

// MathIR (plan §4)
export * from './ir/types.js';
export * from './ir/stableId.js';
export * from './ir/annotations.js';

// Configuration shapes (plan §3.5, §5)
export * from './config/types.js';

// Pipeline modules (stubs — agent A implements; signatures are contracts)
export * from './parse/index.js';
export * from './naming/index.js';
export * from './translate/index.js';
export * from './callgraph/index.js';
export * from './emit/index.js';

// LSP + webview protocols (plan §3.4, §10.5)
export * from './protocol.js';
export * from './panelProtocol.js';
