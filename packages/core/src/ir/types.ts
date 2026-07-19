/**
 * MathIR — the central data structure of MathLens (plan §4).
 *
 * Everything (hover, panel, PDF export, future runtime traces) is a view over
 * MathIR. This module has ZERO vscode/LSP dependencies (plan §10.2) — the
 * `Range` shape below is structurally identical to LSP's `Range` so values can
 * be passed across the wire without conversion, but we do not import it.
 *
 * OWNERSHIP: this file is a shared contract. Do not change it without noting
 * the change in CONTRACTS.md (all three implementation agents compile against it).
 */

// ---------------------------------------------------------------------------
// Positions & ranges (LSP-compatible shape, zero-based)
// ---------------------------------------------------------------------------

/** Zero-based position in a text document. Structurally identical to LSP `Position`. */
export interface Position {
  /** Zero-based line index. */
  line: number;
  /** Zero-based UTF-16 character offset within the line. */
  character: number;
}

/**
 * Source range, end-exclusive. Structurally identical to LSP `Range`.
 * Every MathNode and Equation carries one — it is THE bidirectional sync
 * anchor (plan §7 F2, §10.7).
 */
export interface Range {
  start: Position;
  end: Position;
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * Stable identity of an equation/section across edits (plan §4.3).
 * Computed by `computeStableId()` in `ir/stableId.ts` from
 * (enclosing function qualname, statement role, LHS symbol, ordinal among
 * same-LHS statements). Opaque string; treat as a map key only.
 */
export type StableId = string & { readonly __brand?: 'StableId' };

/**
 * Addresses one *occurrence* of a symbol inside a MathNode tree (plan §10.3).
 * Runtime value substitution (stretch S3) targets occurrences, not equations.
 * Format (by convention, produced by `computeSymbolOccurrenceId()`):
 * `<equation StableId>#<zero-based occurrence ordinal within the equation,
 * in pre-order traversal of lhs-then-rhs>`. Opaque to consumers.
 */
export type SymbolOccurrenceId = string & { readonly __brand?: 'SymbolOccurrenceId' };

// ---------------------------------------------------------------------------
// Document / Section / Block (plan §4.1)
// ---------------------------------------------------------------------------

export interface MathDocument {
  /** Text document URI this IR was derived from. */
  uri: string;
  /** Matches the text document version the IR was computed against. */
  version: number;
  /** One per function (or one synthetic section for selections). */
  sections: Section[];
}

export type SectionKind = 'function' | 'selection' | 'lemma';

export interface Section {
  id: StableId;
  /** 'lemma' = referenced callee rendered as a numbered lemma (F4). */
  kind: SectionKind;
  /** Function name, prettified (or synthetic title for selections). */
  title: string;
  /**
   * Fully qualified name of the function this section was derived from,
   * e.g. "mymodel.ops.softmax" or "MyClass.forward". Absent for selections.
   * Needed for stable-ID computation and call-graph cross-references.
   */
  qualname?: string;
  /** "given W ∈ ℝ^{d×k}, x ∈ ℝ^d, …" derived from signature + hints. */
  signature?: SignatureLine;
  /** Docstring, lightly LaTeX-escaped. */
  prose?: string;
  blocks: Block[];
  sourceRange: Range;
}

/**
 * Rendered "given …" line for a function signature (plan §6.1).
 * Deliberately reuses the `shape` annotation payload shape (plan §10.4)
 * so static hints and future runtime facts are identical on the wire.
 */
export interface SignatureLine {
  params: SignatureParam[];
  /** Declared/derived output symbol(s) of the function, if known. */
  returns?: SignatureParam[];
  sourceRange: Range;
}

export interface SignatureParam {
  /** Python parameter name. */
  pythonName: string;
  /** TeX form as decided by the naming engine. */
  tex: string;
  /**
   * Declared shape, if any (from jaxtyping annotation, shape comment, …).
   * Same payload shape as ShapeAnnotationPayload.dims.
   */
  dims?: ShapeDim[];
  /** Declared dtype, e.g. "float32", if any. */
  dtype?: string;
  /** Raw type annotation text, if present and not otherwise consumed. */
  typeText?: string;
  sourceRange: Range;
}

/** One dimension of a shape: a named symbolic dim ("d", "batch") or a literal size. */
export type ShapeDim = string | number;

export type Block = AlignBlock | CasesBlock | LoopBlock | CodeBlock | ProseBlock;

/** Run of consecutive translatable statements → LaTeX align environment. */
export interface AlignBlock {
  kind: 'align';
  equations: Equation[];
}

/** if/elif/else assigning one subject → piecewise cases (plan §6.3). */
export interface CasesBlock {
  kind: 'cases';
  /**
   * The subject equation: `subject.lhs` is the variable assigned in every
   * branch; `subject.rhs` is a placeholder (typically a `raw` node) — the
   * real right-hand sides live in `branches`.
   */
  subject: Equation;
  branches: CaseBranch[];
  sourceRange: Range;
}

export interface CaseBranch {
  /** Branch value (the RHS assigned when the guard holds). */
  value: MathNode;
  /** Guard condition; absent for the `else` branch (renders "otherwise"). */
  guard?: MathNode;
  sourceRange: Range;
}

/**
 * Non-reducible loop rendered as an indexed block (plan §6.3 tier 3).
 * The header keeps per-iteration identity (index symbol + bound MathNodes)
 * so a future trace can attach per-iteration stats (plan §10.6).
 */
export interface LoopBlock {
  kind: 'loop';
  header: LoopHeader;
  body: Block[];
  sourceRange: Range;
}

export interface LoopHeader {
  /**
   * 'for' / 'while' per plan §6.3; 'if' | 'elif' | 'else' | 'block' are the
   * labeled-block fallback forms (branches with side effects, §6.3) —
   * ADDITIVE contract change 2026-07-18 (agent A), see CONTRACTS.md.
   */
  kind: 'for' | 'while' | 'if' | 'elif' | 'else' | 'block';
  /** Loop index symbol (a `sym` node), for `for` loops. */
  index?: MathNode;
  /** Lower bound / iterable start, when derivable (e.g. `range` start). */
  lower?: MathNode;
  /** Upper bound / iterable end, when derivable. */
  upper?: MathNode;
  /** The iterable expression when it is not a recognized range form. */
  iterable?: MathNode;
  /** `while` condition. */
  condition?: MathNode;
  sourceRange: Range;
}

/** Fallback: untranslatable statement(s), rendered verbatim (plan §6.5). */
export interface CodeBlock {
  kind: 'code';
  text: string;
  sourceRange: Range;
  /** Structured reason for the fallback (feeds golden-corpus backlog). */
  reason?: string;
}

/** Opted-in comment / synthesized context note rendered as prose. */
export interface ProseBlock {
  kind: 'prose';
  text: string;
  sourceRange?: Range;
}

// ---------------------------------------------------------------------------
// Equation (plan §4.1)
// ---------------------------------------------------------------------------

/** `=` plain, `\leftarrow` augmented assignment, `\coloneqq` definition. */
export type EquationRelation = '=' | '\\leftarrow' | '\\coloneqq';

export interface Equation {
  id: StableId;
  /** Absent for bare expressions / bare `return expr` forms. */
  lhs?: MathNode;
  rhs: MathNode;
  relation: EquationRelation;
  /** THE sync anchor (F2 bidirectional sync). Authoritative and tested (§10.7). */
  sourceRange: Range;
  /** "(3)" — assigned at emit time for referenced style (F4). */
  number?: string;
  /**
   * Trailing qualifier rendered after the RHS as ", \quad <qualifier>" —
   * e.g. the recurrence range "t = 1, \dots, T" (plan §6.3 tier 2).
   * ADDITIVE contract change 2026-07-18 (agent A), see CONTRACTS.md.
   */
  qualifier?: MathNode;
  /**
   * Pre-emitted display-math TeX body (server-attached via emitEquation).
   * When present the webview uses it verbatim; when absent it falls back to
   * its own walker. ADDITIVE 2026-07-18 (agent C convention, typed by A).
   */
  tex?: string;
  /**
   * The statement's source text (left column of the literate view).
   * Populated by translate/. ADDITIVE 2026-07-18 (agent C convention, typed
   * by A).
   */
  sourceText?: string;
  /** Equation-level annotations (plan §4.2). Always present, possibly empty. */
  annotations: Annotation[];
}

// ---------------------------------------------------------------------------
// Annotations — the runtime-readiness contract (plan §4.2)
// ---------------------------------------------------------------------------

export type AnnotationKind =
  | 'shape'
  | 'dtype'
  | 'device'
  | 'value'
  | 'stats'
  | 'grad'
  | 'note';

export type AnnotationOrigin = 'static' | 'runtime';

/**
 * One augmentation fact attached to an equation or a single symbol occurrence.
 * RULE (plan §4.2, enforced in review): no MVP code may *branch* on `origin`;
 * renderers treat static and runtime annotations identically (CSS class only).
 */
export interface Annotation {
  target: StableId | SymbolOccurrenceId;
  kind: AnnotationKind;
  origin: AnnotationOrigin;
  /** Kind-specific payload; see the typed payload interfaces below. */
  payload: unknown;
}

/** Payload for kind 'shape': `{ dims: ['d', 'k'] }` or `{ dims: [32, 128] }`. */
export interface ShapeAnnotationPayload {
  dims: ShapeDim[];
}

/** Payload for kind 'dtype'. */
export interface DtypeAnnotationPayload {
  dtype: string;
}

/** Payload for kind 'device'. */
export interface DeviceAnnotationPayload {
  device: string;
}

/** Payload for kind 'note' (directive-sourced notes, StaticNoteProvider). */
export interface NoteAnnotationPayload {
  text: string;
  /** 'error' tints the badge red; default 'info'. */
  severity?: 'info' | 'warning' | 'error';
}

// ---------------------------------------------------------------------------
// MathNode — the expression tree (plan §4.1 comment block, fleshed out)
// ---------------------------------------------------------------------------

/**
 * Common fields on every MathNode variant. EVERY node keeps its sourceRange
 * (hover statement mapping, panel click-sync, emit-time source maps).
 */
export interface MathNodeBase {
  sourceRange: Range;
}

/**
 * The expression tree. Emitters walk this; nothing outside `emit/` produces
 * LaTeX strings for expressions (plan §4.1). Discriminant: `kind`.
 */
export type MathNode =
  | SymNode
  | NumNode
  | StrNode
  | CallNode
  | FracNode
  | PowNode
  | SqrtNode
  | ReductionNode
  | MatMulNode
  | ElementwiseNode
  | TransposeNode
  | InverseNode
  | NormNode
  | SubscriptNode
  | TupleNode
  | MatrixNode
  | BinOpNode
  | UnaryOpNode
  | CompareNode
  | GroupNode
  | RawNode;

/** All MathNode `kind` discriminants, for exhaustive switches. */
export type MathNodeKind = MathNode['kind'];

/**
 * A symbol occurrence. `tex` is the naming-engine-resolved TeX form;
 * `pythonName` is the original identifier. Every occurrence is addressable
 * via `occurrenceId` (plan §10.3) — assigned during translation.
 */
export interface SymNode extends MathNodeBase {
  kind: 'sym';
  pythonName: string;
  tex: string;
  occurrenceId: SymbolOccurrenceId;
}

/** Numeric literal, kept as source text to preserve formatting (1e-5, 0x10, …). */
export interface NumNode extends MathNodeBase {
  kind: 'num';
  text: string;
}

/** String literal (rare in math context; renders as \text{...}). */
export interface StrNode extends MathNodeBase {
  kind: 'str';
  text: string;
}

/** How a call renders (plan §6.2 operator table). */
export type CallDisplay =
  /** \operatorname{name}(args) — default for known/unknown named ops. */
  | 'operatorname'
  /** \name(args) for TeX built-ins like \exp, \log, \sin. */
  | 'builtin'
  /** \mathbb{E}[x]-style bracket application. */
  | 'brackets'
  /** name applied by juxtaposition without parens (rare). */
  | 'juxtapose';

/**
 * Operator/function application. `op` is the *normalized* internal operator
 * name (method-call and function-call forms normalize to one op, §6.2);
 * `tex` is the display form decided by naming/config
 * (e.g. op: 'softmax', tex: '\\operatorname{softmax}').
 */
export interface CallNode extends MathNodeBase {
  kind: 'call';
  op: string;
  tex: string;
  display: CallDisplay;
  args: MathNode[];
}

export interface FracNode extends MathNodeBase {
  kind: 'frac';
  numerator: MathNode;
  denominator: MathNode;
  /** Render as inline a/b (hover, when nesting depth > 2 — §6.2). */
  inline?: boolean;
}

export interface PowNode extends MathNodeBase {
  kind: 'pow';
  base: MathNode;
  exponent: MathNode;
}

export interface SqrtNode extends MathNodeBase {
  kind: 'sqrt';
  radicand: MathNode;
  /** Optional index for n-th roots. */
  index?: MathNode;
}

/** Which big-operator a reduction renders as. */
export type ReductionOp = 'sum' | 'prod' | 'max' | 'min';

/**
 * Big-operator reduction: Σ / Π / max / min over an index (plan §6.2, §6.3).
 * Covers `sum(x, dim=d)`, recognized accumulation loops, einsum expansion,
 * and `sum(f(i) for i in …)`.
 */
export interface ReductionNode extends MathNodeBase {
  kind: 'reduction';
  op: ReductionOp;
  /** Index symbol (a `sym` node), when derivable; absent for bare Σ x. */
  index?: MathNode;
  /** Lower bound / domain start (e.g. `1` in Σ_{i=1}^{N}). */
  lower?: MathNode;
  /** Upper bound. */
  upper?: MathNode;
  /** Domain expression when not a lower/upper range (e.g. `i ∈ xs`). */
  domain?: MathNode;
  body: MathNode;
}

/** Matrix product chain — juxtaposition `A B` (explicit \cdot via config). */
export interface MatMulNode extends MathNodeBase {
  kind: 'matmul';
  /** ≥ 2 factors, in order. */
  factors: MathNode[];
}

/** Which elementwise operator symbol to use. */
export type ElementwiseOp = 'mul' | 'div';

/** Elementwise product/division of tensors — a ⊙ b (plan §6.2 `*` row). */
export interface ElementwiseNode extends MathNodeBase {
  kind: 'elementwise';
  op: ElementwiseOp;
  left: MathNode;
  right: MathNode;
}

export interface TransposeNode extends MathNodeBase {
  kind: 'transpose';
  operand: MathNode;
}

export interface InverseNode extends MathNodeBase {
  kind: 'inverse';
  operand: MathNode;
}

export interface NormNode extends MathNodeBase {
  kind: 'norm';
  operand: MathNode;
  /** Norm order subscript (p, ∞, 'F' as a raw/str node), absent for plain ‖x‖. */
  order?: MathNode;
}

/**
 * Indexing rendered as subscripts: `x[i, j]` → x_{ij} (plan §6.2).
 * `indices` may contain SliceIndex markers for `x[:, j]` → x_{:,j}.
 */
export interface SubscriptNode extends MathNodeBase {
  kind: 'subscript';
  base: MathNode;
  indices: SubscriptIndex[];
}

export type SubscriptIndex = MathNode | SliceIndex;

/** A slice appearing in a subscript position; ':' with optional bounds. */
export interface SliceIndex {
  kind: 'slice';
  start?: MathNode;
  stop?: MathNode;
  step?: MathNode;
  sourceRange: Range;
}

/** Tuple: `(y, z)` on either side of an equation, function multi-return. */
export interface TupleNode extends MathNodeBase {
  kind: 'tuple';
  elements: MathNode[];
}

/**
 * Block matrix for cat/stack (plan §6.2): \begin{bmatrix}…\end{bmatrix}.
 * `rows` is a 2-D array of cells; axis-aware construction happens in translate/.
 */
export interface MatrixNode extends MathNodeBase {
  kind: 'matrix';
  rows: MathNode[][];
  /** Delimiter style; 'bmatrix' default. */
  delim?: 'bmatrix' | 'pmatrix' | 'vmatrix';
}

/** Generic binary operators not covered by a dedicated node. */
export type BinOp = '+' | '-' | 'cdot' | 'div' | 'mod' | 'floordiv' | 'and' | 'or';

export interface BinOpNode extends MathNodeBase {
  kind: 'binop';
  op: BinOp;
  left: MathNode;
  right: MathNode;
}

export type UnaryOp = 'neg' | 'pos' | 'not';

export interface UnaryOpNode extends MathNodeBase {
  kind: 'unaryop';
  op: UnaryOp;
  operand: MathNode;
}

/** Comparison chain: a < b ≤ c (plan §6.2 comparisons row). */
export type CompareOp = 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne' | 'in' | 'notin';

export interface CompareNode extends MathNodeBase {
  kind: 'compare';
  /** First operand. */
  first: MathNode;
  /** (operator, operand) pairs; length ≥ 1. Supports Python chained compares. */
  rest: Array<{ op: CompareOp; operand: MathNode }>;
}

/** Explicit grouping parentheses that must survive emit. */
export interface GroupNode extends MathNodeBase {
  kind: 'group';
  inner: MathNode;
}

/**
 * Verbatim code fragment inside an otherwise-translated expression
 * (plan §6.5 fallback discipline). Typeset as \texttt{…}.
 */
export interface RawNode extends MathNodeBase {
  kind: 'raw';
  text: string;
  /** Structured reason for the fallback. */
  reason?: string;
  /**
   * When true, `text` is a trusted LaTeX math fragment emitted verbatim
   * (e.g. "\\mathbf{0}", "\\ldots") instead of \texttt{…} code.
   * ADDITIVE contract change 2026-07-18 (agent A), see CONTRACTS.md.
   */
  math?: boolean;
}
