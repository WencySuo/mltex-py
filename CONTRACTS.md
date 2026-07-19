# MathLens — Contracts for parallel implementation agents

The foundation (M0 + shared type contracts) is in place. Three agents implement
in parallel against the contracts below. `plan.md` is the authoritative spec.

## Ownership boundaries

| Agent | Owns (may edit freely) |
|---|---|
| **A — translator** | `packages/core/src/{parse,translate,naming,callgraph,emit}/`, `packages/core/test/` (incl. golden corpus), `packages/core/scripts/` |
| **B — LSP server** | `packages/server/` (all of it) |
| **C — client + webview** | `packages/client/`, `packages/webview/` |

**Shared contract files — NOBODY edits these without noting the change here
(add a dated entry under "Contract changes" below) and checking the other
agents' usage:**

- `packages/core/src/ir/` (`types.ts`, `stableId.ts`, `annotations.ts`)
- `packages/core/src/protocol.ts` (custom LSP surface)
- `packages/core/src/panelProtocol.ts` (webview message bridge)
- `packages/core/src/config/types.ts` (mathlens.toml / settings shapes)
- `packages/core/src/index.ts` (public export surface)
- The *signatures* in agent A's stub files are also contracts: B and C compile
  against them today. A implements the bodies; changing a signature requires a
  note here.

Root `package.json`, `tsconfig.base.json`: coordinate before changing.

Hard rules (plan §10): `@mathlens/core` never imports vscode/LSP. No code
branches on `Annotation.origin`. Translation never throws (worst case: `code`
block / `raw` node). Every MathNode carries `sourceRange`; every `sym` carries
an `occurrenceId`.

## Build & test

```bash
npm install            # from repo root (npm workspaces)
npm run build          # core: vendor wasm + tsc-check; server/client/webview: esbuild bundles
npm run typecheck      # tsc --noEmit in every package
npm test               # vitest in every package (--passWithNoTests in skeletons)
npm run lint           # intentionally a no-op echo for now
```

Packages are consumed source-directly (`main: src/index.ts`) — bundlers and
vitest resolve TS across workspace symlinks; there is no per-package emit step.
Build outputs: `packages/server/dist/server.cjs` (+ wasm files beside it),
`packages/client/dist/extension.cjs`, `packages/client/media/webview.js`.
The client resolves the server at `<extension>/server/server.cjs`; at package
time copy `packages/server/dist/*` there (dev harness TBD by agent C).

**WASM:** `tree-sitter-python` ships `tree-sitter-python.wasm` in its npm
package; `web-tree-sitter` ships `tree-sitter.wasm` (exports-map subpath
`web-tree-sitter/tree-sitter.wasm`). Core's build vendors both into
`packages/core/wasm/`; the server's esbuild copies both into `dist/`. Runtime
lookup: `resolveLanguageWasmPath(wasmDir?)` — bundled deployments MUST pass
`wasmDir` (the bundle's dir). See `packages/core/README.md`.

## Key exported signatures (core)

MathIR (`src/ir/types.ts`): `MathDocument { uri, version, sections }`,
`Section`, `SignatureLine`, `Block = align | cases | loop | code | prose`,
`Equation { id, lhs?, rhs, relation, sourceRange, number?, annotations }`,
`MathNode` union (`sym num str call frac pow sqrt reduction matmul elementwise
transpose inverse norm subscript tuple matrix binop unaryop compare group raw`),
`Range`/`Position` (LSP-shaped, zero-based), `Annotation`, `AnnotationProvider`.

```ts
// ir/stableId.ts (deterministic; pinned by test — do not change the hash)
computeStableId(input: { qualname; role: StatementRole; lhsSymbol; ordinal }): StableId
computeSymbolOccurrenceId(equationId: StableId, ordinal: number): SymbolOccurrenceId

// ir/annotations.ts
class StaticNoteProvider implements AnnotationProvider
collectAnnotations(doc, providers): Promise<Annotation[]>

// parse/ (agent A implements)
initParser(options?: { wasmDir?: string }): Promise<void>
parsePython(source: string): Promise<ParseResult>            // never throws on bad input
reparsePython(previous, newSource, edits: SourceEdit[]): Promise<ParseResult>
resolveLanguageWasmPath(wasmDir?: string): string             // implemented

// naming/ (agent A implements)
new NamingEngine({ directives?, config? })
  .texFor(pythonName: string, atLine?: number): string
  .texForFunction(qualname: string): string
  .resolve(pythonName, atLine?): ResolvedName
  .hints(): readonly NamingHint[]

// translate/ (agent A implements)
translateDocument(parsed, opts: { uri; version; naming; config? }): TranslateResult // { document, fallbacks }
translateFunction(parsed, qualname, opts): Section | undefined
translateSelection(parsed, range, opts): Section

// callgraph/ (agent A implements)
buildWorkflow(entry, entryQualname, opts: WorkflowOptions): Promise<MathDocument>
findCallSites(parsed, qualname, workspace): Promise<CallSite[]>
ExpansionPrefs { maxDepth; perCallSite: Record<StableId, 'reference'|'inline'>; defaultMode }

// emit/ (agent A implements)
emitLatex(doc: MathDocument, opts: { profile: 'derivation'|'literate'; standalone?; userPreamble?; numbered? }): EmitResult // { tex, sourceMap }
emitEquation(eq: Equation): string   // hover path
emitNode(node: MathNode): string
```

## LSP protocol (`@mathlens/core/protocol`)

Methods: `mathlens/documentMath`, `mathlens/functionMath` (position),
`mathlens/selectionMath` (range), `mathlens/workflowMath` (position/qualname +
`ExpansionPrefs`), `mathlens/emitLatex` (+ `profile`), and the
`mathlens/mathUpdated` server→client notification carrying `MathPatch`
(`addedSections / updatedSections / removedSections / updatedEquations /
annotations`, all keyed by `StableId`). Every result wraps `{ document:
MathDocument }` and echoes the doc `version` — clients drop stale responses.

## Webview bridge (`@mathlens/core/panelProtocol`)

Host→webview: `init` (document + annotations + `PanelState`), `patch`,
`cursorSync` (line), `annotations` (client-side push — DAP-ready, §10.5),
`setViewMode`. Webview→host: `ready`, `revealSource` (equationId + range),
`toggleExpansion`, `viewModeChanged`, `pinChanged`, `copyLatex`, `exportPdf`,
`stateChanged`. All discriminated on `type`; the webview skeleton has the
exhaustive switch.

## Contract changes

- 2026-07-18: initial contracts landed (foundation agent).
- 2026-07-18 (agent A, all ADDITIVE — no existing field/signature changed):
  - `ir/types.ts` `Equation.qualifier?: MathNode` — optional trailing
    qualifier rendered as ", \quad …" (recurrence range "t = 1, …, T", §6.3
    tier 2). Absent everywhere else; renderers that ignore it lose only the
    range note.
  - `ir/types.ts` `RawNode.math?: boolean` — when true, `text` is a trusted
    LaTeX math fragment (e.g. `\mathbf{0}`) emitted verbatim instead of
    `\texttt{…}`. Default (absent) keeps the old code-fragment meaning.
  - `ir/types.ts` `LoopHeader.kind` widened from `'for' | 'while'` to
    `'for' | 'while' | 'if' | 'elif' | 'else' | 'block'` — labeled-block
    fallback for non-cases conditionals (§6.3). Consumers switching on kind
    should treat unknown values like 'block'.
  - `parse/index.ts` new exported type `TrailingComment` and two new fields
    on `PythonAst`: `source: string` (text the tree was parsed from) and
    `comments: TrailingComment[]` (shape comments / notes, F8).
    `FunctionInfo.docstring?: string` added. New helper export
    `nodeRange(node)` (tree-sitter node → IR Range).
  - `translate/index.ts` new exports: `DeclaredShapeProvider`
    (AnnotationProvider over collected F8 shape annotations),
    `TranslateResult.shapeAnnotations?: Annotation[]`,
    `assignOccurrenceIds(eq)`, `childrenOf(node)` (MathNode traversal).
  - New internal modules `translate/ops.ts` (§6.2 operator table as data)
    and `translate/shapes.ts` (F8 jaxtyping/shape-comment/einsum parsing).
    Not re-exported from the core barrel; other packages should consume them
    only through `translate/` results.
  - `emit/index.ts` new export `emitSignatureLine(sig)` — "given W ∈ ℝ^{d×k}"
    line rendering (shared shape-annotation path, §10.4).
  - Reserved `CallNode.op` value `'<cases>'` (args = [value, guard, alt]):
    inline ternary cases; emit/ renders it as `\begin{cases}…\end{cases}`.
  - Typed agent C's `Equation.tex?` / `Equation.sourceText?` conventions in
    `ir/types.ts` (both optional). translate/ now populates `sourceText` on
    every equation; the literate emit profile uses it for the left column.
- 2026-07-18 (agent C, additive conventions — no shared type files edited):
  - New client→server notification `mathlens/panelRendered` with params
    `{ uri: string, functionIds: string[] }` (functionIds = qualnames of
    function/lemma sections the panel has rendered). Sent by the client after
    every panel init render; the server may use it for the conditional
    "Export PDF" CodeLens (plan §7 F1). Servers that don't handle it can ignore it.
  - Optional additive field `Equation.tex?: string`: the server MAY attach a
    pre-emitted display-math TeX body per equation. When present the webview
    uses it verbatim; when absent the webview falls back to its own MathIR →
    TeX walker (`packages/webview/src/texEmitter.ts`), which must be
    reconciled with `core/emit` once agent A lands it.
  - Optional additive field `Equation.sourceText?: string`: the statement's
    source text, used for the left column of the two-column literate view.
    When absent the webview shows a line-number placeholder.
- 2026-07-18 (integration-fix agent):
  - `protocol.ts`: added `PanelDidRenderNotification = 'mathlens/panelDidRender'`
    (client → server) with `PanelDidRenderParams { uri: string, functionIds:
    string[] }` — reconciles the server's previous `{uri, qualname}` handler in
    codelens.ts with the client's `mathlens/panelRendered` convention. Both
    sides now import the shared constant; the server handler loops over
    `functionIds`. `mathlens/panelRendered` is retired.
  - `protocol.ts`: ADDITIVE `MathResult.annotations?: Annotation[]` — the
    server attaches the document-level annotation list to every math response;
    the client forwards it in the panel `init` message (F3 annotation
    pipeline). Absent = none computed.
  - Server behavior (no type change): every MathDocument shipped to the client
    (custom request results and the recompute cache feeding mathUpdated) now
    has `Equation.tex` pre-emitted via core `emitEquation` (per-equation
    try/catch; undefined on failure so the webview fallback still applies) —
    panel TeX now matches hover/PDF (F4).
  - `protocol.ts`: documented MathPatch scoping semantics (patches are
    whole-document; scoped-view clients filter added/updated sections to
    known ids, always relay removals). Client behavior: panelHost filters
    relayed patches for scoped (function/selection/workflow) views (F5).
  - `protocol.ts`: ADDITIVE `EmitLatexParams.target?: 'function' | 'selection'
    | 'workflow'` and `EmitLatexParams.range?: Range` — the client passes the
    panel's actual target kind; the server dispatches emitLatex through the
    same math request the panel used (selection→selectionMath(range),
    function→functionMath with NO workflow expansion, workflow→workflowMath).
    Absent target keeps the legacy dispatch (F6).
  - `protocol.ts`: ADDITIVE `MathResult.preamble?: string` and
    `panelProtocol.ts` ADDITIVE `InitMessage.preamble?: string` — user
    preamble macros travel server → client → webview so the panel's MathJax
    registers \newcommand definitions before typesetting (F11).
  - `translate/index.ts` signature notes: `assignOccurrenceIds(eq)` now
    returns the next unused ordinal (was void — callers ignoring the return
    are unaffected); new export `assignOccurrenceIdsToNodes(ownerId, nodes,
    startOrdinal?)` for cases branches / loop headers (§10.3 occurrence-id
    completeness).
  - `naming/index.ts` behavior (no signature change): `texForFunction` checks
    directives BEFORE the [functions] mapping (plan §5 order); directive-
    resolved names now register in the collision tracker so mapped/heuristic
    names colliding with them get §5.4 disambiguation + hints.
