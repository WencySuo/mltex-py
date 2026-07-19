# @mathlens/core

The dependency-clean heart of MathLens: parse (tree-sitter), MathIR, translate,
naming, callgraph, emit. **ZERO vscode/LSP dependencies** (plan §10.2) — keep it
that way; a future trace-PDF generator must run this in a plain Node process.

## WASM resolution

`web-tree-sitter` needs two wasm binaries at runtime:

1. `tree-sitter.wasm` — the runtime, shipped inside the `web-tree-sitter` npm package.
2. `tree-sitter-python.wasm` — the grammar. The `tree-sitter-python` npm package
   **does** ship this prebuilt at its package root (verified in the 0.25.0
   tarball: `package/tree-sitter-python.wasm`).

`npm run build` in this package runs `scripts/copy-wasm.mjs`, which vendors both
files into `packages/core/wasm/` (gitignored). Runtime lookup goes through
`resolveLanguageWasmPath(wasmDir?)` in `src/parse/index.ts`, which tries, in order:

1. an explicit `wasmDir` argument — **bundled deployments (the server bundle)
   must copy both wasm files next to the bundle and pass that directory**
   (the server's esbuild script does this),
2. the vendored `packages/core/wasm/` copy,
3. the installed `node_modules/tree-sitter-python` package.

If `tree-sitter-python` ever stops shipping the wasm, fall back to the
`tree-sitter-wasms` npm package (`out/tree-sitter-python.wasm`) and update
`scripts/copy-wasm.mjs`.

## Layout

- `src/ir/` — MathIR types, stable IDs, annotations. **Shared contract — see /CONTRACTS.md before editing.**
- `src/protocol.ts`, `src/panelProtocol.ts` — LSP + webview bridge contracts. **Shared contract.**
- `src/config/` — `mathlens.toml` / settings shapes. **Shared contract.**
- `src/parse/`, `src/translate/`, `src/naming/`, `src/callgraph/`, `src/emit/` —
  owned by the translator agent; currently typed stubs that throw `not implemented`.
- `test/` — vitest; golden corpus will live in `test/corpus/`.
