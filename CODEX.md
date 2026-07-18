# mltex / MathLens Execution Plan

**Document type:** Engineering execution plan  
**Date:** 2026-07-18  
**Status:** Proposed  
**Audience:** Contributors and coding agents implementing the project

## Executive Summary

mltex is a VS Code extension that helps ML engineers and researchers verify that
math-heavy Python and PyTorch code matches its intended equations. The product
starts with zero-configuration hover rendering, then adds a synchronized
function-level math panel. Shape analysis, workflow rendering, and PDF export
remain later investments until real-code validation demonstrates their value.

This plan makes four decisions:

1. Build the product in TypeScript with tree-sitter and a desktop-first VS Code
   extension. Do not build the Python, pygls, or matplotlib architecture
   described in `CLAUDE.md`.
2. Separate semantic analysis from presentation. Python syntax first becomes a
   normalized operation IR. That IR then becomes MathIR for hover, panel, and
   export rendering.
3. Prefer honest degradation over plausible but unsupported mathematics. Every
   translated operation records whether support is exact, partial, or opaque.
4. Validate a narrow hover and panel experience before implementing call-graph
   inlining, bundled TeX compilation, PDF viewing, or debugger integration.

The current repository contains planning documents only. There is no existing
Python implementation to preserve or migrate.

## Customer And Product

### Primary customer

The primary customer is an ML engineer or researcher reading or editing
linear-algebra-heavy PyTorch code. The customer needs to compare an
implementation with the equations they expect without mentally translating
every expression.

The primary job is:

> Show the mathematical meaning of the code under inspection, preserve links
> back to source, and expose uncertainty instead of inventing meaning.

Paper-ready export is a secondary job. Runtime debugging and trace generation
are later product bets.

### Product principles

1. **Zero configuration first.** Hover and panel rendering must provide useful
   output without annotations, directives, decorators, or project files.
2. **One pipeline, multiple surfaces.** Hover, panel, and export consume the same
   semantic and presentation models.
3. **No silent semantic loss.** Unknown receivers, dimensions, keywords, side
   effects, or call targets lower the support level or produce an opaque block.
4. **Source correspondence is the unit of value.** Every rendered item carries
   versioned source provenance.
5. **Interactive paths never invoke TeX.** MathJax renders hover and panel
   content. TeX compilation remains an explicit later action.
6. **User code is never executed during static analysis.**
7. **Optimization follows correctness.** Start with full section refreshes.
   Add incremental patches only after versioning and invalidation are proven.

### Non-goals for the MVP

- Full Python type checking or import resolution.
- General LaTeX authoring.
- Symbolic algebra or simplification.
- Call-graph body inlining.
- Bundled Tectonic downloads or an embedded PDF viewer.
- Cross-method or cross-workspace shape inference.
- Debug Adapter Protocol integration.
- Browser-hosted `vscode.dev` support.

## Delivery Scope

### POC: trustworthy hover

The POC demonstrates useful, semantically honest output from ordinary
unannotated PyTorch code.

It includes:

- A TypeScript extension and language server connected over LSP.
- Error-tolerant parsing with `web-tree-sitter` and `tree-sitter-python`.
- A shared UTF-16 LSP to UTF-8 byte-offset position codec.
- Canonical operation resolution for imports, aliases, methods, and operators.
- Python-style positional and keyword argument binding.
- Precedence-aware MathIR emission.
- MathJax SVG hover rendering with a raw-LaTeX fallback.
- Tier 1 operations:
  - arithmetic `+`, `-`, unary signs, division, and powers
  - matrix multiplication with rank-aware support status
  - transpose variants with distinct semantics
  - `det`, `inv`, `solve`, and `norm`
- No hover for expressions with no supported mathematical operation.

POC exit criteria:

- All Tier 1 operation contracts have positive and must-degrade tests.
- Unicode identifiers, CRLF files, aliases, shadowed names, and malformed edits
  preserve correct hover ranges.
- Supported golden cases contain no known semantic misrepresentations.
- Warm hover latency is measured at p50 and p95 on a recorded machine and
  representative file. The initial p95 target is 75 ms.
- An installed VSIX loads tree-sitter WASM and MathJax assets successfully.

### MVP: synchronized function math

The MVP adds the primary product experience:

- CodeLens above supported functions.
- A live panel focused on one function or selection.
- Editor-to-panel and panel-to-editor source synchronization.
- Full-section refresh after a debounced edit.
- Follow and pinned panel modes.
- Copy LaTeX for one equation or the visible section.
- Optional symbol mappings and conservative naming overrides.
- Visible exact, partial, and opaque support states.
- Structured fallback reasons in local diagnostic logs.

The MVP does not require stable equation patches. Every response carries a
document version, and the client discards stale responses.

MVP exit criteria:

- The panel remains correct after edits before, inside, and after a function.
- Source synchronization works with Unicode, nested scopes, and shifted lines.
- Three unannotated real-world functions render without crashes.
- Reviewers classify each math-bearing statement as exact, partial, opaque, or
  missed. The release has zero known misleading exact translations.
- Panel keystroke-to-paint latency is measured at p50 and p95 with debounce time
  reported separately.

### Post-MVP decision gate

After MVP dogfooding, compare three next investments:

1. Local static shapes and mismatch diagnostics.
2. Workflow references across functions.
3. LaTeX document export.

Choose the next milestone using observed fallback reasons, user sessions, and
the number of errors or comprehension problems each option addresses. The
default recommendation is a narrow static-shape slice because shape visibility
is the clearest product differentiator.

## Architecture

### Package boundaries

```text
packages/
  core/
    parse/          tree-sitter wrapper and position codec
    resolve/        scopes, bindings, aliases, callable identity
    operations/     canonical registry and operation contracts
    opir/           normalized semantic operation IR
    mathir/         presentation IR and source provenance
    translate/      CST/AST slice to OpIR to MathIR
    naming/         conservative automatic names and overrides
    emit/           browser-safe MathIR emitters
  server/
    documents/      versions, snapshots, invalidation
    hover/          standard LSP hover
    requests/       panel and selection requests
    render/         MathJax SVG rendering and cache
  client/
    extension/      activation and LanguageClient
    panel/          webview host and source synchronization
  webview/
    panel UI, MathJax rendering, theming, and support-state display
```

`core` must not import VS Code or LSP packages. The browser-safe emitter is
shared by the server and webview so rendering ownership remains explicit.

### Translation pipeline

```text
Python source
  -> tree-sitter CST
  -> scoped syntax model
  -> canonical operation resolution
  -> OpIR
  -> MathIR
  -> render fragments
  -> MathJax SVG, panel MathJax, or later TeX
```

Shape analysis consumes OpIR, not emitted LaTeX and not presentation-only
MathIR.

### Operation contracts

Each canonical operation defines:

```ts
interface OperationContract {
  id: string;
  aliases: string[];
  parameters: ParameterSpec[];
  variants: OperationVariant[];
  shapeRule?: ShapeRule;
}

interface OperationVariant {
  predicate: SemanticPredicate;
  build: (call: BoundCall) => OpNode;
  support: 'exact' | 'partial';
}
```

A resolved operation retains:

- Canonical operation ID.
- Bound positional and keyword arguments.
- Receiver evidence and callable-resolution evidence.
- Known rank, shape, dtype, and domain facts.
- Scope and symbol definition/use identities.
- Source range and document version.
- Support state and reason.

An unrecognized keyword that changes operation semantics does not fall through
to a default template. It produces partial or opaque output.

### OpIR and MathIR

OpIR represents semantic operations, state changes, scopes, and dependencies.
MathIR represents equations, cases, loops, code fallbacks, prose, and
presentation annotations.

Keep equation numbering, expanded-call state, and layout choices in a render
manifest outside canonical MathIR. Every inlined or referenced call requires a
provenance chain containing both call-site and definition ranges.

### Versioning and incrementality

MVP requests and responses include the source document version. The server
caches parsed documents, and the client ignores responses for older versions.

Initial panel updates replace a complete section. Later patch support must
define:

- `baseVersion` and `resultVersion`.
- Insert, replace, delete, and move operations.
- Document-qualified IDs.
- Reconciliation after insertions and function renames.
- Invalidation for imports, directives, configuration, and callee changes.
- A full-refresh fallback.

The original hash of function name, LHS, role, and ordinal is not a sufficient
stable-ID contract.

## Semantic Safety Rules

### Exact, partial, and opaque output

- **Exact:** all semantics needed by the notation are established.
- **Partial:** the core operation is known, but dimensions, domains, or optional
  behavior remain unknown. The rendered UI marks this state.
- **Opaque:** translation discards or invents behavior without a fallback.
  Render the source as code and record a structured reason.

Unknown calls with unresolved side effects create dependency barriers.
Equations that depend on values crossing such a barrier cannot be labeled
exact.

### Required corrections to the initial operator table

- Treat `torch.dot`, `matmul`, `mm`, and `bmm` as distinct operations.
- Treat `.T`, `.mT`, `.t()`, and `transpose(dim0, dim1)` as distinct variants.
- Render `solve(A, b)` as a solution satisfying `Ax = b` unless stronger
  notation is explicitly selected.
- Preserve `dim`, `keepdim`, `correction`, and dtype arguments for reductions.
- Use explicit operator notation for `sum`, `mean`, `std`, `var`, `cat`,
  `stack`, and `softmax` until axis and shape facts justify indexed notation.
- Translate Python `and` and `or` as logical connectives only when operands are
  known scalar booleans.
- Preserve Python loop bounds. `range(N)` means `0` through `N - 1`.
- Do not flatten `try`, `with`, or decorator semantics into unconditional
  equations.
- Do not infer real-valued domains from `torch.Tensor` alone.

### Naming

Automatic naming remains conservative:

- Greek names and simple trailing numeric subscripts are allowed.
- Direct mappings and `# tex:` directives override automatic names.
- `_masked`, `_transpose`, capitalization from usage, and similar semantic
  guesses require explicit user configuration.
- Naming never changes the support state of an operation.

## Static Shapes And Runtime Readiness

### First static-shape slice

The first shape milestone supports:

- Constructor literals such as `zeros`, `ones`, and `randn`.
- Symbolic constructor dimensions.
- Local transpose rules.
- Local matrix multiplication unification.
- One inner-dimension mismatch diagnostic.
- Named symbolic, anonymous symbolic, and unknown dimensions.
- Silent unknowns when no contradiction is proven.

Shape rules live beside canonical operation contracts but operate on OpIR.
Cross-method `nn.Module` analysis, broadcasting, and caller-to-callee
propagation remain later work.

### Annotation model

Do not use `payload: unknown`. Define discriminated annotation types for shape,
dtype, device, value, statistics, gradient, and notes. Shape facts include
dimension expressions, evidence, confidence, and conflict state.

Renderers consume resolved annotations. A resolution layer decides how static
and runtime facts combine.

Runtime annotations require a versioned overlay with:

- Document version.
- Debug session, thread, frame, and stop sequence.
- Annotation values and provenance.
- Clear rules for edit, continue, step, and frame changes.

An export must receive the same overlay snapshot shown in the panel. Otherwise,
the exported artifact is not a snapshot of the panel.

## Platform And Security

### Initial platform matrix

| Environment | POC/MVP support | Notes |
|---|---:|---|
| VS Code desktop, local workspace | Required | Node language server |
| Remote SSH, WSL, Codespaces | Validate before MVP release | Server and assets run on the extension host |
| `vscode.dev` browser extension | Deferred | Requires a worker server and no local process spawning |
| TeX/PDF export | Deferred | Desktop and remote behavior require separate design |

### Trust and content handling

- Use a restrictive webview Content Security Policy.
- Escape source text before placing it in HTML or TeX.
- Do not execute user Python or import user modules.
- Disable external binary download and TeX compilation in untrusted workspaces.
- Treat project preambles as active content.
- Support a documented portable MathJax macro subset.
- Keep arbitrary TeX packages and file includes PDF-only.

Before adding Tectonic, specify OS and architecture selection, checksums,
updates, executable permissions, proxy behavior, offline resource bundles,
cancellation, remote hosts, licenses, and cache management.

PDF reverse synchronization does not come from `\hypertarget` alone. A future
PDF.js implementation must expose link annotations or click regions carrying
equation IDs and send those IDs to the extension host.

## Validation Strategy

### Semantic tests

- Table-driven operation-contract tests.
- Golden OpIR, MathIR, and emitted-LaTeX snapshots.
- Must-degrade cases for unknown receivers, ranks, keywords, dimensions, and
  side effects.
- Shadowed-name and import-alias cases.
- Rank, axis, and keyword matrices for every supported PyTorch operation.
- Loop-bound, reassignment, mutation, and control-flow cases.
- Numeric equivalence tests for the supported pure subset where practical.

Golden snapshots alone do not prove correctness. Every operation contract must
state the semantic evidence required for exact output.

### Protocol and editor tests

- UTF-16 and UTF-8 position conversion with non-ASCII identifiers.
- CRLF and LF source files.
- Edits above and inside rendered functions.
- Stale response rejection.
- Syntax-error recovery without presenting stale ranges as current.
- Dark and light theme rendering.
- No hover on unsupported plain Python.

### Packaging and performance tests

- Installed-VSIX smoke tests for WASM, MathJax, worker, and webview assets.
- Webview CSP and resource-URI tests.
- Package-size and extension-startup measurements.
- Warm and cold hover benchmarks.
- Panel parse, translate, IPC, typeset, and paint timings.
- A maximum-wait update in addition to trailing debounce so continuous typing
  cannot postpone rendering indefinitely.

### Dogfood metrics

For each representative function, record:

- Math-bearing statements.
- Exact, partial, opaque, and missed statements.
- Misleading exact translations, with a release threshold of zero known cases.
- Fallback reasons.
- Hover and panel p50/p95 latency.
- User corrections made through mappings or directives.

## Milestones

| Milestone | Deliverable | Exit decision |
|---|---|---|
| M0 | TypeScript monorepo, LSP handshake, parser, position codec, packaged VSIX smoke test | Toolchain works on desktop |
| M1 | Operation registry, resolver, OpIR, MathIR, Tier 1 golden and must-degrade tests | Translation contracts are trustworthy |
| M2 | MathJax hover, caching, aliases, malformed-edit handling, measured latency | POC provides zero-config value |
| M3 | CodeLens, function/selection panel, full refresh, bidirectional source sync | MVP workflow is usable |
| G1 | Real-code dogfood and product review | Choose shapes, workflow references, or export |
| M4A | Narrow local static-shape slice | Shape value and false-positive rate are known |
| M4B | Reference-only workflow rendering | Cross-function comprehension value is known |
| M4C | LaTeX source export | Documentation value is known |

Only one M4 branch becomes the next committed milestone after G1.

Deferred milestone backlog:

1. Incremental equation patches.
2. Restricted pure-function inlining.
3. TeX compilation and failure diagnostics.
4. Embedded PDF viewing and explicit source synchronization.
5. DAP shape overlays.
6. Runtime values and statistics.
7. Execution-trace documents.

## Working Rules For Codex

1. Treat this file as the implementation sequence and `plan.md` as the broader
   product vision.
2. Do not implement post-MVP features while an earlier milestone lacks its exit
   evidence.
3. Every new operation requires a contract, positive tests, and must-degrade
   tests.
4. Never label output exact when rank, axis, dtype, receiver, keyword, or
   side-effect uncertainty changes its meaning.
5. Keep `core` free of VS Code and LSP dependencies.
6. Preserve document versions and source provenance through every layer.
7. Start with full refreshes. Do not add patch complexity to hide correctness
   problems.
8. Do not execute user code, import user modules, or download executables during
   static analysis.
9. Test the installed extension, not only source-level modules.
10. Update this plan when a milestone decision changes scope or architecture.

## Open Decisions

Resolve these decisions with evidence from M1 through G1:

1. Whether `web-tree-sitter` meets desktop latency and packaging requirements.
2. Decide whether one MathIR supports hover and panel without a separate compact
   hover projection.
3. The exact portable macro subset supported by MathJax.
4. Whether static shapes produce more customer value than workflow references.
5. Whether users need compiled PDF output or only copyable LaTeX and `.tex`
   export.
