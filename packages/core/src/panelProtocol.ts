/**
 * Webview message bridge protocol — panel host (extension client) ↔ webview
 * postMessage payloads (plan §3.3, §7 F2, §10.5).
 *
 * Types only, zero dependencies beyond MathIR — the webview bundle imports
 * this from core (plan §10.2).
 *
 * Direction conventions:
 *  - `HostToWebviewMessage`: extension client → webview.
 *  - `WebviewToHostMessage`: webview → extension client.
 *
 * RUNTIME-READINESS (plan §10.5): `annotations` push exists so the future
 * DapAnnotationProvider (living in the client, which has DAP access) can
 * feed the panel without any server involvement.
 *
 * OWNERSHIP: shared contract (see CONTRACTS.md).
 */

import type { Annotation, MathDocument, StableId } from './ir/types.js';
import type { MathPatch } from './protocol.js';
import type { ExpansionMode } from './callgraph/index.js';

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

/** Panel view mode (F5 two-column toggle). */
export type PanelViewMode = 'derivation' | 'two-column';

/** Serializable panel state (survives tab hide/show — plan §7 F2). */
export interface PanelState {
  viewMode: PanelViewMode;
  /** Pinned target qualname, or undefined when following the cursor. */
  pinnedQualname?: string;
  /** Per-call-site expansion state, keyed by call-site equation StableId. */
  expansions: Record<StableId, ExpansionMode>;
}

// ---------------------------------------------------------------------------
// Host → Webview
// ---------------------------------------------------------------------------

/** Full (re)initialization: document JSON + restored state. */
export interface InitMessage {
  type: 'init';
  document: MathDocument;
  annotations: Annotation[];
  state: PanelState;
  /**
   * User preamble macros (plan §5): the webview registers \newcommand
   * definitions with MathJax before typesetting. Optional / additive.
   */
  preamble?: string;
}

/** Incremental update; webview re-typesets only what the patch names. */
export interface PatchMessage {
  type: 'patch';
  uri: string;
  version: number;
  patch: MathPatch;
}

/** Editor → panel cursor sync: highlight the equation containing the cursor. */
export interface CursorSyncMessage {
  type: 'cursorSync';
  uri: string;
  /** Zero-based editor cursor line; webview maps it via equation sourceRanges. */
  line: number;
}

/**
 * Annotation push from the CLIENT side (plan §10.5) — e.g. future DAP
 * provider at a breakpoint. Additive; targets resolve by StableId /
 * SymbolOccurrenceId. `reset` clears previously pushed annotations from the
 * same source first.
 */
export interface AnnotationsMessage {
  type: 'annotations';
  /** Provider name (AnnotationProvider.name) for reset scoping. */
  source: string;
  annotations: Annotation[];
  reset?: boolean;
}

/** Host-driven view mode change (command palette / toolbar handled host-side). */
export interface SetViewModeMessage {
  type: 'setViewMode';
  mode: PanelViewMode;
}

export type HostToWebviewMessage =
  | InitMessage
  | PatchMessage
  | CursorSyncMessage
  | AnnotationsMessage
  | SetViewModeMessage;

// ---------------------------------------------------------------------------
// Webview → Host
// ---------------------------------------------------------------------------

/** Webview finished booting and is ready for `init`. */
export interface ReadyMessage {
  type: 'ready';
}

/** Panel → editor click sync: reveal + move cursor to the equation's source. */
export interface RevealSourceMessage {
  type: 'revealSource';
  uri: string;
  equationId: StableId;
  /** The equation's sourceRange as known to the webview (host may re-validate). */
  range: import('./ir/types.js').Range;
}

/** User toggled a call-site chevron (F4); host refetches workflowMath with new prefs. */
export interface ToggleExpansionMessage {
  type: 'toggleExpansion';
  callSiteEquationId: StableId;
  mode: ExpansionMode;
}

/** User changed view mode from the panel toolbar. */
export interface ViewModeChangedMessage {
  type: 'viewModeChanged';
  mode: PanelViewMode;
}

/** User pinned/unpinned the panel target. */
export interface PinChangedMessage {
  type: 'pinChanged';
  pinnedQualname?: string;
}

/** Toolbar: copy LaTeX for one block or the whole doc (host calls emitLatex). */
export interface CopyLatexMessage {
  type: 'copyLatex';
  scope: 'document' | 'section' | 'equation';
  targetId?: StableId;
}

/** Toolbar: export PDF with the panel's exact current state (principle 2). */
export interface ExportPdfMessage {
  type: 'exportPdf';
}

/** State snapshot for host-side persistence (setState mirror). */
export interface StateChangedMessage {
  type: 'stateChanged';
  state: PanelState;
}

export type WebviewToHostMessage =
  | ReadyMessage
  | RevealSourceMessage
  | ToggleExpansionMessage
  | ViewModeChangedMessage
  | PinChangedMessage
  | CopyLatexMessage
  | ExportPdfMessage
  | StateChangedMessage;
