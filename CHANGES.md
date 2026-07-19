# MathLens — Implementation Changelog

Everything built in the initial multi-agent implementation session (2026-07-18), from an
empty repo containing only `plan.md` to a verified MVP skeleton. Work was executed by
one foundation agent, three parallel implementation agents (A: core, B: server,
C: client + webview), two code-review agents, and one integration-fix agent.

**Final verified state:** `npm run typecheck` / `npm run build` / `npm test` all green —
**326 tests passing** (core 243, server 48, webview 26, client 9). Nothing committed to git.

---

## 1. Foundation (monorepo + shared contracts)

- **npm-workspaces monorepo**: `@mathlens/core`, `@mathlens/server`, `@mathlens/client`
  (extension manifest `mathlens`), `@mathlens/webview`. TypeScript ~5.9 strict via
  `tsconfig.base.json`; `vitest` for tests; `esbuild` bundling
  (server → `server/dist/server.cjs`, client → `client/dist/extension.cjs`,
  webview → `client/media/webview.js`). `lint` is an intentional no-op.
- **MathIR type system** (`packages/core/src/ir/types.ts`, plan §4): `MathDocument`,
  `Section`, `Block` (align/cases/loop/code/prose), `Equation`, `SignatureLine`, and a
  21-variant `MathNode` union (sym, num, str, call, frac, pow, sqrt, reduction, matmul,
  elementwise, transpose, inverse, norm, subscript, tuple, matrix, binop, unaryop,
  compare, group, raw). Every node carries `sourceRange`; every symbol occurrence
  carries a `SymbolOccurrenceId`.
- **Stable IDs** (`ir/stableId.ts`): fnv1a32 hash over (qualname, statement role, LHS
  symbol, ordinal), human-readable prefix (e.g. `attention/assign/attn/0-f5ae67b3`);
  determinism pinned by test.
- **Annotations** (`ir/annotations.ts`, plan §4.2): `Annotation`, `AnnotationProvider`,
  `StaticNoteProvider`, failure-isolated `collectAnnotations()`.
- **LSP protocol contract** (`core/src/protocol.ts`): constants + typed params/results
  for `mathlens/documentMath`, `functionMath`, `selectionMath`, `workflowMath`,
  `emitLatex`, and the `mathlens/mathUpdated` server→client patch notification.
- **Panel message protocol** (`core/src/panelProtocol.ts`): host→webview
  `init | patch | cursorSync | annotations | setViewMode`; webview→host
  `ready | revealSource | toggleExpansion | viewModeChanged | pinChanged | copyLatex |
  exportPdf | stateChanged`; `PanelState`.
- **WASM vendoring**: `tree-sitter-python.wasm` + `tree-sitter.wasm` vendored into
  `packages/core/wasm/`, copied beside server bundles at build time; runtime lookup via
  `resolveLanguageWasmPath()`.
- **CONTRACTS.md**: package ownership boundaries, key signatures, build/test commands,
  and a running contract-change log used by all later agents.

## 2. Core translator (`packages/core`) — plan M1 + M4 + M5-core

- **`parse/`**: web-tree-sitter wrapper over the vendored wasm. `parsePython` yields
  functions (method/nested qualnames), docstrings, `# tex:` / `# tex-note:` directive
  extraction (brace-aware multi-binding split), trailing comments, ERROR-region
  diagnostics; never throws. `reparsePython` uses true tree-sitter incremental parsing
  (`tree.edit`) with fresh-parse fallback.
- **`naming/`** (plan §5): priority order **directive > `mathlens.toml` mapping >
  heuristics**. Heuristics: Greek names (`sigma`→`\sigma`, `eps`→`\varepsilon`),
  suffix modifiers (`x_hat`→`\hat{x}`, `_bar`, `_tilde`, `_prime`, `_star`,
  `dx`→`\mathrm{d}x`), trailing digits → subscripts (`w1`→`w_1`),
  short suffixes → `_{\text{prev}}`, single letters pass through, multi-word →
  `\mathit{...}` with escaped underscores + hint. Collision handling with
  disambiguating subscripts + hints.
- **`translate/`** (plan §6): statement forms (§6.1) including `+=` → `←`, tuple
  targets, return-as-function-form; **operator table as data** (`ops.ts`, ~35 rows,
  §6.2) including matmul juxtaposition with chain flattening, `*`→`⊙` tensor-provenance
  heuristic, `\frac`, powers, transpose (`.T`/`.mT`), inverse, solve, norms, reductions
  with dim kwarg, the softmax/sigmoid function family, mean/std/var
  (blackboard or operator style), indexing → subscripts,
  **einsum → expanded explicit sums** (explicit + implicit output, trace, bilinear,
  batched), cat/stack → axis-aware `bmatrix`, zeros/ones/eye/randn, unknown call →
  `\operatorname` (never an error); method-call ≡ function-call normalization;
  user-extensible via `[functions]` config.
- **Control flow** (§6.3): three-tier loops — (1) reduction recognition
  (`+=`/`*=`/max/min/append/generator-sum with initializer consumption → Σ/Π/max/
  indexed family), (2) recurrence recognition (`h = f(h, x[t])` →
  `h_t = f(h_{t-1}, x_t)` with range qualifier), (3) indexed-block fallback with
  loop-var subscripting. if/elif/else → piecewise `cases` (same-var branches) or
  labeled blocks; ternary → inline cases; comprehensions → indexed families;
  while → labeled block.
- **F8 declared shapes** (`translate/shapes.ts`, §6.6 Tier 1): jaxtyping dim tokenizer
  (`Float[Tensor, "b s d"]` — names, ints, `*variadic`, `#broadcast`, `...`,
  `name=value`; unparseable → raw string), trailing shape comments (`# (B, T, D)`),
  einsum/einops pattern strings — all normalizing to the single `shape` annotation
  payload. `DeclaredShapeProvider` implements `AnnotationProvider`. **No shape
  inference/propagation** (per §6.6 doctrine).
- **`callgraph/`** (§6.4): same-file + workspace `from x import y` syntactic
  resolution; reference mode (numbered lemma sections, duplicates → one lemma) and
  inline mode (body substitution, `param ↦ arg` bindings); max depth 2; cycles always
  reference.
- **`emit/`**: derivation + literate (`longtable`) LaTeX profiles, `emitEquation` for
  hover, precedence-aware parenthesization, `1e-5`→`10^{-5}`, equation numbering,
  `\hypertarget` anchors, emit-time source maps (equation id → tex line spans),
  signature lines ("given W ∈ ℝ^{d×k}"), annotation suffixes that branch only on
  `kind`, never `origin`.
- **§6.5 fallback discipline**: try/catch at expression, statement, function, and
  section levels; all fallbacks carry structured `{code, message, range}` reasons;
  no input ever throws (corpus-audited).
- **Tests (243)**: 9-file golden corpus (attention incl. jaxtyping variant,
  layernorm/rmsnorm, Adam, Kalman recurrence, softmax/logsumexp, GRU, 7 einsum ops,
  messy logging-heavy fallback case, jaxtyping edge cases), table-driven op-table (36
  rows) + naming (31 rows) tests, corpus-wide no-throw / sourceRange-validity /
  occurrenceId-uniqueness invariants, MathJax smoke test (every emitted equation
  typesets without error). Acceptance anchor verified:
  `alpha_hat = Q @ K.T / math.sqrt(d)` → `\hat{\alpha} = \frac{Q K^{\top}}{\sqrt{d}}`.

## 3. LSP server (`packages/server`) — plan §3.3–3.4, F0, F1

- **Hover (F0)**: whole-statement equation → `emitEquation` → in-process MathJax SVG →
  markdown data-URI image (LaTeX Workshop technique); symbol-binding line when a
  directive/mapping resolved the LHS; user preamble macros injected; converter + LRU
  SVG caching, measured well under the 50 ms budget. Four-step degradation ladder:
  MathIR+SVG → LaTeX source code block → raw statement text → null (never an error).
- **CodeLens (F1)**: "View as math" per function (incl. methods/nested) with
  `[uri, qualname, range]` args; conditional "Export PDF" lens gated on
  panel-rendered reports, with `workspace/codeLens/refresh`.
- **Custom requests**: all five `mathlens/*` handlers; `emitLatex` routes through the
  same paths the panel uses so PDF = panel snapshot. `mathlens/mathUpdated`:
  per-document debounced (250 ms default) recompute → StableId-keyed diff
  (`patch.ts`) → added/updated/removed sections + equation-level patches.
- **Supporting modules**: `render/mathjax.ts` (liteAdaptor pipeline, preamble
  injection, theme mid-tone fill), `toml.ts` (minimal hand-written TOML parser — no
  new dependency), `config.ts` (`mathlens.toml` → frozen config + preamble file load),
  `pyscan.ts` (regex function scanner used only for degradation),
  `core.ts` (`CoreBridge` — single mockable seam onto core; every core call is
  try/caught at this boundary).
- **Diagnostics**: parse warnings (bad `# tex:` directives) + naming collision hints
  at hint/warning severity.
- **Tests (48)**: fake-connection protocol tests (hover payload, all five requests in
  working and degraded modes, Export-PDF lens gating, mathUpdated debounce +
  equation-level patches, stable-ID survival across edits), differ unit tests, MathJax
  renderer tests (< 50 ms warm), TOML/config tests. Verified end-to-end over stdio:
  initialize handshake + graceful degradation with core stubs.

## 4. Client + webview (`packages/client`, `packages/webview`) — F1–F5 client side

- **Webview renderer**: walks MathDocument sections/blocks; per-equation MathJax SVG
  typesetting keyed by StableId (patches re-typeset only changed equations); all block
  kinds (cases, loop, code → `<pre>`, prose); signature "given …" lines; generic
  annotation badges/underbraces (never branches on `origin` — CSS classes only);
  equation click → `revealSource`; cursorSync highlight bar; F4 expand/collapse
  chevrons; toolbar (pin, view-mode toggle, copy LaTeX, export PDF); two-column
  literate view. Logic in testable modules (`docModel.ts`, `texEmitter.ts`,
  `mathjaxTypeset.ts`, `view.ts`); theme via VS Code CSS variables; CSP-compliant
  (nonce, no remote resources).
- **Panel host (F2)**: singleton WebviewPanel in ViewColumn.Beside; full
  panelProtocol bridge; follow-vs-pinned per `mathlens.panel.follow`, debounced via
  `mathlens.panel.debounceMs`; state via getState/setState + WebviewPanelSerializer
  (`retainContextWhenHidden` off); server failures degrade to empty document +
  status-bar message; client-side annotation push wired end-to-end with a stubbed DAP
  source (plan §10.5).
- **Commands**: `viewAsMath`, `renderSelection` (F3, + editor context menu),
  `viewWorkflow` (F4), `exportPdf`, `copyLatex`.
- **PDF export (F5)**: `emitLatex` with the panel's exact target + prefs + profile →
  temp-dir `.tex` → tectonic (config path → globalStorage → PATH) or latexmk;
  `withProgress` + cancellation; running build killed on re-export; log parsing
  (classic and tectonic formats) mapped to the offending equation via the emit
  sourceMap; PDF opened in an embed webview tab.
- **Tests (35 total across both packages)**: patch application, cursor→equation
  mapping, TeX emitter parity cases, log parser, expansion-prefs round-trip.

## 5. Cross-verification reviews

Two review agents ran to completion (a third, correctness-focused reviewer was lost to
repeated backend API failures — see §7 Known gaps):

- **Integration/seam review**: traced every cross-package contract; confirmed 2
  runtime breaks + 5 silent divergences (findings F1–F9 below) and explicitly
  confirmed-OK: all five request/response types, MathPatch shape, all 13 panelProtocol
  messages, wasm plumbing, emitLatex sourceMap semantics.
- **Plan-conformance review**: audited every plan.md commitment; found the §10.3
  occurrenceId and §5 naming-priority violations (F7, F8) plus several partials
  (F10–F12); scored **compliant** on the §4.2 origin rule (zero conditional logic on
  `origin` anywhere), §10.2 core dependency hygiene, §6.5 fallback discipline, F8
  no-inference doctrine, and the full §3.4 LSP surface.

## 6. Integration fixes (all 12 findings repaired)

| # | Severity | Fix |
|---|---|---|
| F1 | Runtime break | Render-notification mismatch (`mathlens/panelDidRender` vs `mathlens/panelRendered`, different payloads — Export PDF lens could never appear). Reconciled to one constant in `core/protocol.ts` with batched `{uri, functionIds}`; both sides import it. |
| F2 | Runtime break | Client resolved `<extension>/server/server.cjs`, which nothing created — activation would fail. Client build now copies `packages/server/dist/*` into `packages/client/server/`; `extension.ts` gained a dev-mode fallback; path gitignored. |
| F3 | Silent divergence | Annotation pipeline was dead in the panel (empty `DeclaredShapeProvider`, no protocol channel, webview ignored equation-embedded annotations). Server now constructs the provider from real translate output, `MathResult.annotations?` added, panelHost forwards them, webview merges equation-embedded annotations (deduped). |
| F4 | Silent divergence | Panel TeX diverged from hover (server never populated `Equation.tex`; webview fallback emitter had drifted). Server pre-emits `eq.tex` via core's `emitEquation` on every shipped document; fallback emitter fixed (RawNode.math, `<cases>` op, unknown loop-header kinds, `Equation.qualifier`). Panel = hover = PDF. |
| F5 | Silent divergence | Whole-document patches accreted unrelated sections into scoped panel views. panelHost now filters relayed patches to the view's section ids; semantics documented on `MathPatch`. |
| F6 | Silent divergence | PDF/copy was not a panel snapshot for function/selection targets (everything routed through workflow expansion). `EmitLatexParams` gained `target` + `range`; server dispatches to the matching request; client passes its actual target kind. |
| F7 | Contract violation | `SymbolOccurrenceId` missing on cases-branch values/guards and loop-header nodes (§10.3). All are now assigned; corpus invariant test extended to enforce it. |
| F8 | Contract violation | Function-name priority inverted (toml mapping beat directives) and directive results bypassed collision tracking (§5). Order corrected; directives now register for §5.4 disambiguation. |
| F9 | Wrong behavior | CodeLens clicks rendered the cursor's function, not the clicked one. Client now uses the lens `range.start` in the lens `uri`; pinning is no longer a side effect. |
| F10 | Cosmetic | Lemma numbering off-by-one (first lemma rendered "Lemma 2"→ was "Lemma 3"). Fixed + test. |
| F11 | Parity | User preamble never reached the panel (hover/PDF only). Added `preamble?` to `MathResult` + init message; webview injects it before rendering. |
| F12 | Spec detail | F3 selection views were sticky; plan wants ephemeral-unless-pinned. Follow-mode now replaces unpinned selection views. |

Contract changes were logged in `CONTRACTS.md` (dated entries). Tests grew 318 → 326.

## 7. Known gaps & declared stubs (not regressions)

- **Correctness review incomplete**: the dedicated adversarial pass over einsum
  internals, patch-differ edge cases, cache invalidation, and lifecycle/disposable
  races never completed (repeated backend API stalls). These areas are covered by the
  326 tests but have not had an independent review.
- **Declared stubs per plan**: tectonic auto-download bootstrap (actionable error
  instead), PDF viewer is a plain embed (PDF.js + anchor click-through is follow-up),
  DAP annotation source is a stub by design (§10.5 requires only the wired bridge).
- **Deferred**: `@vscode/test-electron` e2e tests, CI/nightly tectonic compile jobs,
  server-side `workspace/configuration` pull (debounce/displayScale use defaults),
  cross-file workflow resolution wired same-file-only in the server (core supports
  cross-file and is tested), F4 references render as badges without clickable
  `\eqref`-style links, theme mid-tone for hover SVG is a fixed `#888888`.

## 8. Verification commands

```bash
npm run typecheck   # 0 errors, all packages
npm run build       # server/client/webview bundles + server copy into client/server/
npm test            # 326 tests: core 243, server 48, webview 26, client 9
```
