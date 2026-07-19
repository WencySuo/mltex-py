/**
 * Custom LSP surface — method name constants + param/result types
 * (plan §3.4). Types only; no runtime dependency on vscode-languageserver,
 * so this lives in core (plan §10.2) and both server and client import it.
 *
 * All position/range types are the LSP-compatible shapes from ir/types.ts.
 *
 * OWNERSHIP: shared contract (see CONTRACTS.md). Agents B (server) and C
 * (client) implement against these; do not change without coordinating.
 */

import type { Annotation, MathDocument, Position, Range, Section, StableId } from './ir/types.js';
import type { EmitProfile, EmitSourceMapEntry } from './emit/index.js';
import type { ExpansionPrefs } from './callgraph/index.js';

// ---------------------------------------------------------------------------
// Method names (namespaced `mathlens/`)
// ---------------------------------------------------------------------------

/** Request: MathIR for a whole file (panel initial load). */
export const DocumentMathRequest = 'mathlens/documentMath' as const;
/** Request: MathIR for the function enclosing a position. */
export const FunctionMathRequest = 'mathlens/functionMath' as const;
/** Request: MathIR for a selection (F3). */
export const SelectionMathRequest = 'mathlens/selectionMath' as const;
/** Request: call-graph MathIR for a top-level function (F4). */
export const WorkflowMathRequest = 'mathlens/workflowMath' as const;
/** Request: complete .tex source for export (F5). */
export const EmitLatexRequest = 'mathlens/emitLatex' as const;
/** Notification (server → client): incremental MathIR patch after an edit. */
export const MathUpdatedNotification = 'mathlens/mathUpdated' as const;
/**
 * Notification (client → server): the panel has rendered these functions
 * (qualnames), enabling the conditional "Export PDF" CodeLens (plan §7 F1).
 * Batched shape: one notification per panel render, all rendered function
 * qualnames at once.
 */
export const PanelDidRenderNotification = 'mathlens/panelDidRender' as const;

// ---------------------------------------------------------------------------
// Common shapes
// ---------------------------------------------------------------------------

export interface TextDocumentIdentifierParam {
  /** Document URI, LSP-style string. */
  uri: string;
}

/**
 * Every math response echoes the document version the IR was computed
 * against, so the client can drop stale responses.
 */
export interface MathResult {
  document: MathDocument;
  /**
   * Document-level annotation list computed for this document (provider
   * output; also embedded per-equation). The client forwards these to the
   * panel init message. Optional / additive — absent means "none computed".
   */
  annotations?: Annotation[];
  /**
   * User preamble macros (mathlens.toml preamble file, plan §5). The client
   * forwards this to the webview so MathJax registers \newcommand macros
   * before typesetting. Optional / additive.
   */
  preamble?: string;
}

// ---------------------------------------------------------------------------
// mathlens/documentMath
// ---------------------------------------------------------------------------

export interface DocumentMathParams extends TextDocumentIdentifierParam {}
export type DocumentMathResult = MathResult;

// ---------------------------------------------------------------------------
// mathlens/functionMath
// ---------------------------------------------------------------------------

export interface FunctionMathParams extends TextDocumentIdentifierParam {
  /** Position inside the target function (cursor). */
  position: Position;
}
/** `document.sections` holds exactly the enclosing function's Section; null result when no enclosing function. */
export type FunctionMathResult = MathResult | null;

// ---------------------------------------------------------------------------
// mathlens/selectionMath
// ---------------------------------------------------------------------------

export interface SelectionMathParams extends TextDocumentIdentifierParam {
  range: Range;
}
/** One synthetic `selection` Section. */
export type SelectionMathResult = MathResult;

// ---------------------------------------------------------------------------
// mathlens/workflowMath
// ---------------------------------------------------------------------------

export interface WorkflowMathParams extends TextDocumentIdentifierParam {
  /** Position inside (or qualname of) the top-level function. */
  position?: Position;
  qualname?: string;
  /** Expansion preferences; round-trips to emitLatex (plan §6.4). */
  prefs: ExpansionPrefs;
}
export type WorkflowMathResult = MathResult;

// ---------------------------------------------------------------------------
// mathlens/emitLatex
// ---------------------------------------------------------------------------

/** Same target params as workflowMath + profile (plan principle 2: PDF = panel snapshot). */
export interface EmitLatexParams extends TextDocumentIdentifierParam {
  position?: Position;
  qualname?: string;
  /** Present when exporting a workflow; must match the panel's current prefs. */
  prefs?: ExpansionPrefs;
  profile: EmitProfile;
  /**
   * What the panel is showing, so the PDF/copy is an exact snapshot of it
   * (plan principle 2): 'selection' → selectionMath(range), 'function' →
   * functionMath (NO workflow expansion/lemmas), 'workflow' →
   * workflowMath(prefs). Absent: legacy behavior (workflow when
   * prefs/qualname/position present, else whole document). ADDITIVE.
   */
  target?: 'function' | 'selection' | 'workflow';
  /** The panel's selection range; required for target 'selection'. */
  range?: Range;
}

export interface EmitLatexResult {
  tex: string;
  sourceMap: EmitSourceMapEntry[];
}

// ---------------------------------------------------------------------------
// mathlens/mathUpdated (server → client notification)
// ---------------------------------------------------------------------------

/**
 * Incremental MathIR patch keyed by StableId (plan §3.4, §4.3). The panel
 * re-typesets only equations/sections named here.
 */
export interface MathUpdatedParams {
  uri: string;
  /** Text document version this patch brings the client up to. */
  version: number;
  patch: MathPatch;
}

/**
 * SCOPING SEMANTICS: `mathlens/mathUpdated` patches are WHOLE-DOCUMENT — they
 * describe every section of the file. A client showing a scoped view
 * (functionMath / selectionMath / workflowMath results contain only a subset
 * of the file's sections) MUST filter relayed patches to the section ids
 * present in its current document: drop added/updated sections with unknown
 * ids (they belong to functions outside the view), but always relay removals
 * (a section shown in the view may have been deleted). Equation-level patches
 * self-scope: unknown sectionIds simply don't match anything.
 */
export interface MathPatch {
  /** Sections added or structurally changed (replace wholesale by id). */
  addedSections: Section[];
  updatedSections: Section[];
  /** StableIds of sections that no longer exist. */
  removedSections: StableId[];
  /**
   * Equation-level granularity within otherwise-unchanged sections:
   * replace each equation (matched by id) in place.
   */
  updatedEquations: EquationPatch[];
  /** Annotation refresh for existing targets (does not imply re-typeset). */
  annotations?: Annotation[];
}

// ---------------------------------------------------------------------------
// mathlens/panelDidRender (client → server notification)
// ---------------------------------------------------------------------------

/**
 * Sent by the client after the panel renders a document; `functionIds` are
 * the qualnames of function/lemma sections rendered. The server uses this to
 * enable the conditional "Export PDF" CodeLens. Servers that don't handle it
 * can ignore it.
 */
export interface PanelDidRenderParams {
  uri: string;
  /** Qualnames of the function/lemma sections the panel rendered. */
  functionIds: string[];
}

export interface EquationPatch {
  /** Section containing the equation. */
  sectionId: StableId;
  /** The replacement equation (its id names which one to replace). */
  equation: import('./ir/types.js').Equation;
}
