# MathLens — Plan

> Working title: **MathLens** (placeholder). A VS Code extension + language server that
> renders Python linear-algebra / PyTorch code as LaTeX mathematics — line by line on
> hover, function by function in a live panel, and workflow by workflow as a compiled
> PDF. Static analysis only for the MVP; runtime/debugger integration is a stretch goal
> that the architecture must accommodate without rework.

---

## 1. Vision & product principles

The unit of value is the **code ↔ math correspondence**. Everything in this plan exists
to let a user move fluidly between a Python statement and its mathematical meaning.

**Progressive disclosure — one zoom gesture, three surfaces:**

| Surface | Scope | Latency budget | Renderer | Lifetime |
|---|---|---|---|---|
| Hover | one statement | < 50 ms | MathJax → SVG | ephemeral |
| Live math panel | one function / selection / call graph | < 300 ms after edit (debounced) | MathJax in webview | continuous |
| PDF export | whole workflow | seconds, explicit action w/ progress | real TeX (tectonic) | frozen, shareable |

**Principles:**

1. **Never block interaction on a real TeX compile.** MathJax for everything
   interactive; tectonic/latexmk only for explicit "Export PDF".
2. **PDF is a snapshot of the panel**, not a separate feature. The panel is the primary
   experience; PDF export serializes exactly what the panel shows.
3. **Graceful degradation over completeness.** Any statement we cannot translate
   renders as an inline code fragment inside the derivation — never an error, never a
   hole. A function that is 60 % translatable is still useful.
4. **Notation is user-curated.** Auto-generated symbol names are a starting point;
   `# tex:` directives and a project mapping file are first-class, because
   `attn_weights_masked` rendering as \texttt{attn\_weights\_masked} is the difference
   between a toy and a tool.
5. **Design for runtime annotations now, build them later.** Every equation and symbol
   occurrence carries an *annotation slot* that static analysis may partially fill
   (shapes from hints/literals) and a future debug adapter fills at a breakpoint. The
   translator, panel, and PDF renderer all consume annotations through one interface.

**Non-goals (MVP):**

- Executing user code in any form (no runtime, no import of user modules).
- Full Python semantic analysis / type checking — we do our own lightweight, targeted
  inference; we are not building or embedding Pyright.
- Being a general LaTeX editing extension. We *mimic LaTeX Workshop's rendering
  qualities* (hover math, live preview, PDF build + viewer); we do not replicate its
  LaTeX-authoring features (completion, linting of .tex, BibTeX, …).
- Symbolic simplification (we transcribe the code's math; we don't run it through a CAS).

---

## 2. Scope

### MVP (this plan)

| # | Feature | Brainstorm ref |
|---|---|---|
| F0 | Hover: statement → rendered equation | (prerequisite) |
| F1 | CodeLens "View as math" per function | #1 |
| F2 | Live math mirror panel with bidirectional sync | #2 |
| F3 | Selection → derivation | #3 |
| F4 | Call-graph workflow rendering (inline / reference toggle, lemma numbering) | #4 |
| F5 | Two-column literate view + PDF export | #5 |
| F6 | Control-flow QoL: loops → Σ/Π/indexed blocks, if → piecewise cases, comprehensions, robust fallback | cross-cutting |
| F7 | Notation control: `# tex:` directives, project mapping file, preamble file | cross-cutting |

### Stretch (design-for, don't build)

| Feature | Brainstorm ref |
|---|---|
| Static shape propagation + mismatch diagnostics (red dimensions) | #6 |
| Breakpoint-aware math via DAP (runtime shapes/dtypes/devices) | #7 |
| Value substitution for small tensors; stats badges + NaN provenance | #8, #9 |
| Execution-trace PDF | #10 |
| Gradient-flow rendering | #11 |
| Math-rendered watch expressions | #12 |

Static shape propagation is listed as stretch but is the **first** stretch item and the
one the MVP most actively prepares for (see §5 Annotations and §10).

---

## 3. Architecture

### 3.1 Language & stack decision

**TypeScript everywhere** — extension client, language server, translator core.

- **Parsing:** `web-tree-sitter` + `tree-sitter-python` (WASM). Error-tolerant,
  incremental, fast, and runs anywhere Node runs (including vscode.dev eventually).
- **Math rendering:** `mathjax-full` in-process in the server (hover SVGs) and in the
  webview (panel). One stack, no subprocess for the hot path.
- **Why not a Python (pygls) server?** The obvious pull is Python's `ast` module and
  proximity to the user's runtime. But: (a) our translation is syntactic + our own
  targeted inference — tree-sitter is sufficient and error-tolerant where `ast` is not;
  (b) MathJax is JS, and hover needs server-side SVG — a Python server would need a Node
  sidecar for its hottest path; (c) the debugger stretch goal talks to **debugpy via
  DAP from the extension client**, not via Python introspection, so it exerts no pull
  toward a Python server; (d) one toolchain, one bundler, one test runner.
  Decision: TypeScript. Revisit only if we later need deep import resolution.

### 3.2 Package layout (monorepo)

```
mathlens/
├── package.json                # npm workspaces
├── packages/
│   ├── core/                   # ZERO vscode/LSP deps — the heart
│   │   ├── src/parse/          # tree-sitter wrapper, Python CST → typed AST slice
│   │   ├── src/ir/             # MathIR types, builders, stable IDs, annotations
│   │   ├── src/translate/      # AST → MathIR (expressions, statements, control flow)
│   │   ├── src/naming/         # symbol → TeX naming engine, directives, mapping file
│   │   ├── src/callgraph/      # intra-workspace function resolution, expand/reference
│   │   ├── src/emit/           # MathIR → LaTeX strings (two profiles, §7.3)
│   │   └── test/               # golden corpus lives here
│   ├── server/                 # LSP server (vscode-languageserver)
│   │   ├── src/hover.ts        # F0
│   │   ├── src/codelens.ts     # F1
│   │   ├── src/documents.ts    # doc manager, incremental reparse, MathIR cache
│   │   ├── src/custom.ts       # custom LSP requests for panel & export (§3.4)
│   │   └── src/render/         # MathJax tex→svg (shared by hover + tests)
│   ├── client/                 # VS Code extension
│   │   ├── src/extension.ts    # activation, LanguageClient wiring
│   │   ├── src/panel/          # webview panel host, message bridge, state
│   │   ├── src/pdf/            # export orchestration: tectonic spawn, progress, viewer
│   │   └── media/              # webview app (see below)
│   └── webview/                # panel UI (bundled into client/media)
│       └── src/                # renders MathIR JSON w/ MathJax, sync events, toggles
└── docs/plan.md                # this file
```

`core` is deliberately dependency-clean: it is the piece the stretch goals reuse (a
trace-PDF generator is `core` + a runtime annotation source; no LSP involved).

### 3.3 Process & data flow

```
 ┌────────────────────────── VS Code ───────────────────────────┐
 │  editor buffers      webview panel        PDF.js viewer tab  │
 │      │  ▲                │  ▲                    ▲           │
 │      ▼  │       postMessage  │                   │           │
 │  ┌─────────────── extension client ────────────────────┐     │
 │  │ LanguageClient   panel host   pdf: spawn tectonic ──┼──►  │
 │  └───────┬──────────────▲───────────────────────────────┘    │
 └──────────┼──────────────┼────────────────────────────────────┘
            │ LSP (stdio)  │ custom notifications
            ▼              │
 ┌───────── language server ─────────┐
 │ tree-sitter parse (incremental)   │
 │ AST → MathIR → cache per document │
 │ hover: MathIR eq → MathJax SVG    │
 │ custom: MathIR JSON for panel     │
 │ emit: MathIR → .tex for export    │
 └───────────────────────────────────┘
```

Key point: **the server ships MathIR JSON to the panel, not LaTeX-only and not HTML.**
The webview owns presentation (MathJax typesetting, theming, expand/collapse state,
annotation badges). This is what makes runtime annotations a pure additive later — the
panel already renders "MathIR + annotations"; a debug session just supplies more
annotations.

### 3.4 LSP surface

Standard:

- `textDocument/hover` — F0. Markdown with data-URI SVG (LaTeX Workshop technique).
- `textDocument/codeLens` — F1. One lens per `function_definition`.
- `textDocument/publishDiagnostics` — MVP: translation warnings (e.g. unparseable
  `# tex:` directive). Stretch: shape mismatches.

Custom (namespaced `mathlens/`):

- `mathlens/documentMath` (request) → MathIR for a whole file (panel initial load).
- `mathlens/functionMath` (request, position) → MathIR for enclosing function.
- `mathlens/selectionMath` (request, range) → MathIR for a selection (F3).
- `mathlens/workflowMath` (request, function + expansion prefs) → call-graph MathIR (F4).
- `mathlens/emitLatex` (request, same params + profile) → complete `.tex` source (F5).
- `mathlens/mathUpdated` (notification, server→client) → incremental MathIR patch after
  an edit, keyed by stable equation IDs (§4.3), so the panel re-typesets only changed
  equations.

### 3.5 Configuration

- `mathlens.toml` at workspace root (optional): symbol mappings, function mappings,
  preamble include, PDF template options, expansion defaults.
- VS Code settings mirror the common ones (`mathlens.panel.debounceMs`,
  `mathlens.pdf.engine: tectonic|latexmk`, `mathlens.render.displayScale`, …).

---

## 4. MathIR — the central data structure

Everything (hover, panel, PDF, future trace) is a view over MathIR. Get this right and
the rest is plumbing.

### 4.1 Shape

```ts
interface MathDocument {
  uri: string;
  version: number;               // matches text document version
  sections: Section[];           // one per function (or one synthetic for selections)
}

interface Section {
  id: StableId;
  kind: 'function' | 'selection' | 'lemma';   // 'lemma' = referenced callee (F4)
  title: string;                  // function name, prettified
  signature?: SignatureLine;      // "given W ∈ ℝ^{d×k}, x ∈ ℝ^d, …" (from hints)
  prose?: string;                 // docstring, lightly LaTeX-escaped
  blocks: Block[];
  sourceRange: Range;
}

type Block =
  | { kind: 'align';  equations: Equation[] }                    // consecutive stmts
  | { kind: 'cases';  subject: Equation; branches: CaseBranch[] } // if/elif/else
  | { kind: 'loop';   header: LoopHeader; body: Block[] }         // non-reducible loop
  | { kind: 'code';   text: string; sourceRange: Range }          // fallback (§6.5)
  | { kind: 'prose';  text: string };                             // comments opted-in

interface Equation {
  id: StableId;
  lhs?: MathNode;                // absent for bare expressions / return
  rhs: MathNode;
  relation: '=' | '\\leftarrow' | '\\coloneqq';   // ← for augmented assignment
  sourceRange: Range;            // THE sync anchor (F2 bidirectional)
  number?: string;               // "(3)" — assigned at emit time for referenced style
  annotations: Annotation[];     // equation-level (see 4.2)
}

// MathNode: a small expression tree (sym, num, call, frac, sum, matmul, transpose,
// subscript, group, raw). Every node keeps its sourceRange. Emitters walk this;
// nothing outside emit/ produces LaTeX strings for expressions.
```

### 4.2 Annotations — the runtime-readiness contract

```ts
interface Annotation {
  target: StableId | SymbolOccurrenceId;
  kind: 'shape' | 'dtype' | 'device' | 'value' | 'stats' | 'grad' | 'note';
  origin: 'static' | 'runtime';
  payload: unknown;              // kind-specific, e.g. {dims: ['d','k']}
}

interface AnnotationProvider {
  provide(doc: MathDocument): Promise<Annotation[]>;
}
```

- MVP ships **one provider**: `StaticNoteProvider` (directive-sourced notes) — and the
  panel/PDF render annotation badges generically (underbraces for `shape`, margin
  badges for `stats`, red tint for `note:error`).
- Stretch items are all "new provider, zero translator changes":
  static shape inference → `StaticShapeProvider`; breakpoint integration →
  `DapAnnotationProvider` living in the **client** (it has DAP access), pushing
  annotations to the panel over the existing message bridge.
- **Rule enforced by review:** no MVP code may branch on `origin`. Renderers treat
  static and runtime annotations identically (styling may differ via CSS class only).

### 4.3 Stable IDs & incrementality

- `StableId` = hash of (enclosing function qualname, statement role, LHS symbol,
  ordinal among same-LHS statements). Survives edits to *other* lines, so the panel
  patches only what changed and equation cross-references in F4 stay stable.
- Server caches `(docVersion → MathIR)`; tree-sitter incremental parsing keeps reparse
  cost low; MathIR rebuild is per-function (only functions whose source range
  intersects the edit).

---

## 5. Notation & naming engine (F7)

Runs before translation; owns every symbol's TeX form. Priority order:

1. **Inline directive** — trailing comment on the defining line:
   `attn = w @ x  # tex: \tilde{A}` (applies to LHS), or
   `# tex: attn=\tilde{A}, w=W_q` (multi-binding, applies file-wide from that point).
2. **Project mapping file** — `mathlens.toml`:
   ```toml
   [symbols]
   attn_weights_masked = '\tilde{A}'
   lr = '\eta'
   [functions]
   "mymodel.ops.softmax" = '\operatorname{softmax}'
   [preamble]
   include = "notation.tex"      # user macros, mimics LaTeX Workshop preamble scan
   ```
3. **Heuristics** (in order):
   - Greek names → Greek letters: `sigma`→`\sigma`, `Sigma`→`\Sigma`, `eps|epsilon`→`\varepsilon`.
   - Suffix modifiers: `x_hat`→`\hat{x}`, `x_bar`→`\bar{x}`, `x_tilde`→`\tilde{x}`,
     `x_prime`→`x'`, `x_star`→`x^{*}`, `dx`→`\mathrm{d}x` (only when x known).
   - Trailing digits / short suffixes → subscripts: `w1`→`w_1`, `h_prev`→`h_{\text{prev}}`.
   - Single letters pass through; capitalized single letters stay upright capitals
     (matrices by convention).
   - Multi-word leftovers → `\mathit{attn}` with underscores → `\_` escaped, plus a
     one-time hint (diagnostic, severity: hint) suggesting a `# tex:` directive.
4. **Collision handling:** two Python names mapping to the same TeX symbol within a
   scope get disambiguating subscripts + a hint diagnostic.

The preamble file (3.2) is injected into MathJax's TeX input (macro definitions) *and*
into the PDF template — the LaTeX-Workshop-parity move that makes user macros render
identically on hover, panel, and PDF.

---

## 6. Translation engine

### 6.1 Statements

| Python | MathIR |
|---|---|
| `y = expr` | `y = expr` equation |
| `y += expr` etc. | `y ← y + expr` (relation `\leftarrow`) |
| `y, z = f(x)` | one equation `(y, z) = f(x)` |
| `return expr` | equation with LHS = declared/derived output symbol of the function (`\Rightarrow y = expr` styling) |
| bare call w/ side effects | fallback `code` block |
| docstring | section prose |
| `assert cond` | prose constraint “s.t. cond” (config-off by default) |
| `import`, `with`, `try`, decorators | skipped (structural), body still translated |

Function signature → `SignatureLine`: parameter list with types from annotations where
present (`torch.Tensor` + shape comment/`jaxtyping`-style hints if available → `W \in
\mathbb{R}^{d\times k}`; unknown → just the symbol). This is deliberately the same
rendering path shape *annotations* use, so static-shape stretch drops in cleanly.

### 6.2 Expressions — operator table

| Python | LaTeX |
|---|---|
| `a @ b`, `matmul`, `mm`, `bmm`, `dot` (2-D) | juxtaposition `A B` (explicit `\cdot` config) |
| `a * b` | `a \odot b` when both known tensors; else implicit/`\cdot` (heuristic + config) |
| `a / b` | `\frac{a}{b}` (inline `a/b` for hover if nested depth > 2) |
| `a ** b` | `a^{b}` |
| `a.T`, `transpose(a)`, `a.mT` | `A^{\top}` |
| `torch.linalg.inv(a)` | `A^{-1}` |
| `torch.linalg.solve(A, b)` | `A^{-1} b` (or `x : Ax=b` style, config) |
| `norm(x)`, `norm(x, p)` | `\lVert x \rVert`, `\lVert x \rVert_p` |
| `sum(x, dim=d)` | `\sum_{d} x` with named index when derivable |
| `exp/log/sqrt/abs/sin/…` | `\exp`, `\log`, `\sqrt{\,}`, `\lvert\,\rvert`, … |
| `softmax/sigmoid/relu/tanh/…` | `\operatorname{softmax}` … (extensible table) |
| `mean/std/var` | `\mathbb{E}[x]`, `\sigma(x)`, `\operatorname{Var}[x]` (config: operator names instead) |
| `x[i]`, `x[i, j]` | `x_i`, `x_{ij}` |
| `x[:, j]`, slices | `x_{:,j}`; complex slices → raw index in brackets |
| `torch.einsum("ij,jk->ik", a, b)` | expanded explicit sum `\sum_j A_{ij} B_{jk}` — flagship feature, spec'd fully in golden tests |
| `cat/stack` | `\begin{bmatrix} … \end{bmatrix}` (axis-aware) |
| `zeros/ones/eye/randn` | `\mathbf{0}`, `\mathbf{1}`, `I`, `\varepsilon \sim \mathcal{N}(0, I)` |
| comparisons, `and/or/not` | `\le, \ge, \ne, \land, \lor, \lnot` (mostly inside `cases` guards) |
| unknown call `f(x)` | `\operatorname{f}(x)` — never an error |
| unknown attribute chain / kwargs-heavy call | `raw` node → typeset as `\texttt{…}` inline |

Method-call and function-call forms normalize to one internal op (e.g. `x.softmax(-1)`
≡ `torch.softmax(x, -1)`). The table is data (`translate/ops.ts`), unit-tested row by
row, and user-extensible via `[functions]` in `mathlens.toml`.

### 6.3 Control flow (F6) — the QoL core

**Loops — three-tier strategy, most-specific first:**

1. **Reduction pattern recognition.** `acc = 0` (or `1`, `[]`) followed by
   `for i in range(N): acc += f(i)` → single equation
   `\mathrm{acc} = \sum_{i=1}^{N} f(i)` (or `\prod`, or concatenation). Recognize:
   `+=`, `*=`, `acc = acc + …`, `acc = max(acc, …)` → `\max_i`, list-append inside
   loop → indexed family `(f(i))_{i=1}^{N}`. Also `sum(f(i) for i in …)` directly.
2. **Recurrence recognition.** Loop where a variable feeds itself
   (`h = f(h, x[t])`) → recurrence equation `h_{t} = f(h_{t-1}, x_t), \quad t = 1,\dots,T`
   — this is the RNN/Kalman/optimizer-step case and matters enormously for the target
   audience.
3. **General fallback — indexed block.** `loop` block with header
   `\text{for } t = 1, \dots, T:` and the translated body indented beneath. Loop
   variable substitutes into subscripts inside the body (`x[t]` → `x_t`).

**Conditionals:** `if/elif/else` where each branch assigns the same variable →
piecewise `cases`:
`y = \begin{cases} f(x) & x > 0 \\ g(x) & \text{otherwise} \end{cases}`.
Branches assigning different variables or containing side effects → `loop`-style
labeled block (`\text{if } x > 0:` + body). Ternary `a if c else b` → inline cases.

**Comprehensions:** `[f(i) for i in xs]` → `(f(i))_{i \in xs}`;
`sum(... for ...)` → `\sum`; `{k: v for ...}` → fallback.

**`while`:** labeled block with condition (`\text{while } \lVert g \rVert > \epsilon:`).
No convergence magic in MVP.

### 6.4 Call graph (F4)

- Resolution: same-file first; then workspace-relative imports resolved syntactically
  (tree-sitter over imported files; no sys.path execution). Unresolvable → stays
  `\operatorname{f}(x)`.
- Two modes per call site, toggleable in the panel:
  - **Reference** (default): callee rendered once as a numbered `lemma` Section
    appended after the main derivation; call site renders as
    `\operatorname{softmax}(z)` with the equation reference `(3)` and, in the panel, a
    clickable link that scrolls to the lemma.
  - **Inline**: callee body substituted with arguments bound (α-renaming via the
    naming engine to avoid collisions; parameters get `\mapsto` bindings shown once).
- Recursion / depth: max expansion depth (default 2), cycles always render as
  references. Same callee called twice → single lemma, two references.
- Expansion preferences are part of the `mathlens/workflowMath` request, so panel
  state round-trips to `emitLatex` and the PDF matches the panel exactly (principle 2).

### 6.5 Fallback discipline

One rule everywhere: **untranslatable ⇒ `code` block / `raw` node, translatable
neighbors unaffected.** A 60-line function with logging, `.to(device)`, and asserts
must still yield a clean 12-equation derivation with three small `\texttt{…}` inserts.
Every fallback logs a structured reason (feeds the golden-corpus backlog).

---

## 7. Feature specs & acceptance criteria

### F0 — Hover

- Hovering any expression/assignment inside a function shows the rendered equation for
  the *whole statement*, plus (if directive/mapping exists) the symbol binding.
- SVG color adapts to theme (post-process fill; use `--vscode-editorHoverWidget-foreground`-derived mid-tone; test on dark+light).
- User preamble macros work in hover (§5).
- Failure → hover shows LaTeX source in a code block instead (never empty).
- **Accept:** hover on `alpha_hat = Q @ K.T / math.sqrt(d)` renders
  `\hat{\alpha} = \frac{Q K^{\top}}{\sqrt{d}}` in < 50 ms warm.

### F1 — CodeLens

- Lens `⟦ View as math ⟧` above every `def` (and methods). Click → opens/reveals the
  panel focused on that function.
- Second lens `⟦ Export PDF ⟧` appears only when the panel has rendered that function
  at least once (keeps lens row quiet).
- **Accept:** works on nested functions and methods; lenses update on edit without
  flicker (stable IDs).

### F2 — Live math mirror panel

- Webview in `ViewColumn.Beside`; follows cursor's enclosing function (configurable:
  follow / pinned).
- Debounced re-render (default 250 ms) via `mathlens/mathUpdated` patches; only
  changed equations re-typeset (MathJax per-node typesetting, not full page).
- **Bidirectional sync (the SyncTeX analogue):**
  - editor → panel: cursor line maps to equation via `sourceRange`; that equation gets
    a highlight bar.
  - panel → editor: click any equation → `revealRange` + cursor to its source line.
- Per-call-site expand/collapse chevrons (F4), annotation badges rendered from
  MathIR annotations generically (§4.2).
- Toolbar: pin, copy-LaTeX (block or whole doc), export PDF, view mode
  (derivation / two-column).
- Panel state (pinned target, expansions, view mode) survives tab hide/show
  (`retainContextWhenHidden` off; serialize state instead — memory hygiene).
- **Accept:** typing continuously in a 40-statement function keeps panel updates
  under 300 ms and never re-typesets untouched equations; clicking eq ↔ line round-trips
  correctly after edits above the function.

### F3 — Selection → derivation

- Editor context menu + command palette: "MathLens: Render selection as derivation".
- Selection may span partial functions; loop/if bodies selected without their header
  get a synthesized context note (`\text{within loop over } t`).
- Renders into the panel as a `selection` Section; ephemeral (replaced by next follow
  event unless pinned).
- **Accept:** selecting 8 mid-function lines that use variables defined above renders
  correctly, with free variables listed in a "given …" line.

### F4 — Workflow rendering

- Command + CodeLens variant on the *top-level* function: "View workflow as math".
- Default: main function as Section 1, direct callees as numbered lemmas; equation
  numbers `(1)…(n)` global across sections; references clickable in panel, `\eqref` in
  PDF.
- Inline mode per call site as spec'd in §6.4.
- **Accept:** `train_step → attention → softmax` renders with softmax as Lemma 2,
  referenced from attention's derivation; toggling softmax to inline substitutes with
  correctly renamed arguments; PDF export reproduces the exact panel state.

### F5 — Two-column literate view + PDF export

**Panel side:** view-mode toggle → table layout: statement source (highlighted,
`shiki` or plain `<pre>`) left, equation right, row-aligned per Equation, prose/cases
rows spanning both columns.

**PDF pipeline:**

1. `mathlens/emitLatex` produces a complete document: template preamble (`amsmath`,
   `amssymb`, `mathtools`, `listings` for code column, user preamble include) +
   emitted body. Two templates: `derivation` (one-column, sections + lemmas) and
   `literate` (two-column via `longtable`/`paracol`).
2. Engine: **tectonic** primary — client downloads the per-platform binary on first
   export (rust-analyzer pattern) into `globalStorage`, with checksum pinning;
   `mathlens.pdf.engine: latexmk` uses system TeX as fallback/opt-out. No TeX Live
   requirement for the default path.
3. Compile in a temp dir with progress notification (`withProgress`), parse the log on
   failure into a readable error surface (jump to offending equation, not TeX line —
   we know which Equation emitted each source span via emit-time source maps).
4. View result: PDF.js in a webview tab (LaTeX Workshop pattern). Equation → source
   click-through comes free via our own source maps (we don't need SyncTeX because we
   generated the .tex ourselves — embed `\hypertarget` anchors per equation ID).
5. "Copy LaTeX" everywhere, for users who just want the source in their paper.
- **Accept:** first-ever export (cold tectonic download) has clear progress UX; warm
  export of a 3-function workflow < 5 s; failed compile shows which equation broke.

---

## 8. LaTeX Workshop parity checklist

The specific qualities we're mimicking, as a checklist:

- [ ] Hover math as theme-aware data-URI SVG (their `mathpreviewlib` approach).
- [ ] User macro support: preamble file injected into MathJax + PDF identically.
- [ ] Live preview panel (their Math Preview Panel, ours is MathIR-native).
- [ ] Build on explicit action with progress + parsed log diagnostics (their `latexmk`
      recipe UX; ours defaults to tectonic).
- [ ] Embedded PDF viewer with source↔output sync (their PDF.js + SyncTeX; ours
      PDF.js + generated anchors).
- [ ] Never freeze the editor during builds; kill/restart running builds on re-export.
- Explicit non-parity: .tex authoring features (completion, linting, BibTeX, snippets).

---

## 9. Milestones

Dependencies flow downward; M2–M4 have internal parallelism (hover vs panel).

| M | Deliverable | Contents | Exit criterion |
|---|---|---|---|
| **M0** | Skeleton | Monorepo, esbuild bundling, LanguageClient↔server handshake, tree-sitter loading a Python file, CI (lint+test), hello-world hover | Hover shows raw statement text |
| **M1** | Translator core | MathIR types, naming engine w/ heuristics + `# tex:`, expression table (§6.2 sans einsum), statement forms, `emit/` LaTeX profiles, golden-test harness | 30 golden cases pass, incl. attention & layernorm bodies |
| **M2** | Hover (F0) | MathJax server-side SVG, theming, preamble injection, failure fallback | F0 acceptance |
| **M3** | Panel (F2) + CodeLens (F1) | Webview app, MathIR-JSON protocol, incremental patches, bidirectional sync, follow/pin | F1+F2 acceptance |
| **M4** | Control flow (F6) + Selection (F3) | Reduction/recurrence/indexed-block tiers, cases, comprehensions, einsum, fallback discipline pass over corpus | F3+F6 acceptance; golden corpus ≥ 80 cases |
| **M5** | Workflow (F4) | Call resolution, lemma/reference emit, inline substitution + α-renaming, panel toggles, numbering | F4 acceptance |
| **M6** | PDF (F5) | emitLatex templates, tectonic bootstrap, progress/error UX, PDF.js viewer, two-column mode (panel + PDF) | F5 acceptance |
| **M7** | Polish & readiness | `mathlens.toml` full support, collision diagnostics, docs, example gallery; **stretch-readiness audit** (§10 checklist) | Dogfood on a real training repo; publish preview |

### Stretch (post-MVP, sequenced)

S1 `StaticShapeProvider` (+ red-dimension diagnostics) → S2 `DapAnnotationProvider`
(breakpoint shapes) → S3 value/stats badges → S4 trace PDF → S5 gradient flow.

---

## 10. Runtime-readiness constraints on the MVP

Concrete rules that keep the stretch goals cheap, enforceable in review *now*:

1. **All augmentation is `Annotation[]`** (§4.2). No renderer hardcodes "there are no
   annotations"; panel + PDF emit render badges from day one (exercised in tests with
   synthetic annotations, even though MVP produces almost none).
2. **`core` never imports vscode/LSP.** The trace-PDF generator (S4) must be able to
   consume MathIR + runtime annotations in a plain Node process.
3. **`SymbolOccurrenceId` exists in MVP** — every symbol occurrence in a MathNode tree
   is addressable, because runtime value substitution (S3) targets occurrences, not
   equations.
4. **Signature/shape rendering path is shared.** The "given W ∈ ℝ^{d×k}" line (M1)
   uses the same `shape` annotation payload the DAP provider will emit — static hints
   and runtime facts are the same shape (pun intended) on the wire.
5. **The panel message bridge accepts annotations from the client side**, not only the
   server, because DAP lives in the client. (One message type, stubbed in M3.)
6. **Loop blocks keep per-iteration identity** (`loop` header carries the index
   symbol + range MathNodes), so a future trace can attach per-iteration stats without
   re-translating.
7. **Equation `sourceRange` is authoritative and tested** — breakpoint→equation lookup
   (S2) is just the F2 sync map reused.

---

## 11. Testing strategy

- **Golden corpus (the backbone):** `core/test/corpus/*.py` + expected `.tex` /
  MathIR-JSON snapshots. Seed with real code: scaled-dot-product attention, layernorm,
  Adam step, Kalman filter, softmax/logsumexp, GRU cell, batched einsum ops, a messy
  "real-world" function full of logging (fallback discipline). Every bug report
  becomes a corpus case.
- **Table-driven unit tests** for the op table (§6.2) and naming heuristics (§5) —
  one row, one test.
- **Render smoke tests:** every golden `.tex` body must compile under MathJax without
  errors (fast, in-process); a nightly/CI-tagged job compiles the full templates under
  tectonic.
- **Protocol tests:** server-level integration tests via
  `vscode-languageserver` test harness — hover payloads, incremental `mathUpdated`
  patches after synthetic edits, stable-ID survival across edits.
- **Panel e2e (thin):** `@vscode/test-electron` happy-path: open file → lens →
  panel renders → click-sync round-trip. Keep minimal; logic lives below the webview.
- **Fallback audit:** corpus-wide assertion that no input ever throws — worst case is
  a `code` block.

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Translation quality cliff — real code is messier than the corpus | Fallback discipline (§6.5) as a hard invariant; structured fallback-reason telemetry (local log) to prioritize table gaps; `# tex:` escape hatch |
| `*` ambiguity (elementwise vs scalar) misleads users | Conservative default (`\odot` only when both operands traced to tensor constructors/params), config override, and hover always available to check a single line |
| Symbol naming feels wrong → users bounce | Heuristics conservative; hint-diagnostics advertise directives; mapping file documented in README with a worked example |
| MathJax macro/feature gaps vs real TeX (panel ≠ PDF) | Preamble is injected into both; CI smoke-compiles goldens under both renderers and diffs failures |
| tectonic download friction (offline/proxy environments) | `latexmk` engine setting; clear error with manual-install docs; cache binary in globalStorage |
| Panel perf on huge functions | Incremental typeset per equation ID; virtualize section list; hard cap with "function too large, use selection" notice |
| Call resolution wrong across packages | Syntactic-only resolution, explicit "unresolved" styling, never guess across ambiguous imports |
| Scope creep toward a type checker | §1 non-goals; shape inference stays a stretch provider, not a translator concern |

## 13. Open questions (decide by end of M1)

1. Panel MathJax vs KaTeX for *panel only* (KaTeX is faster; hover must stay MathJax
   SVG). Leaning: MathJax everywhere for identical output; revisit if panel perf bites.
2. `return` rendering: `\Rightarrow y = …` vs naming the function
   (`\operatorname{attn}(Q,K,V) = …` as the final line). Leaning: final-line function
   form for sections, arrow form for selections.
3. Comment passthrough: render `#`-comments as interleaved prose? Default off;
   `# tex-note:` opt-in seems safer than surprising users with their TODOs in a PDF.
4. Should `mathlens/emitLatex` also emit standalone snippets (`standalone` class, one
   equation) for users embedding into papers? Cheap; likely yes in M6.
