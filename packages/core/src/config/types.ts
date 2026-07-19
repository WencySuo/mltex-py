/**
 * Configuration shapes for `mathlens.toml` and mirrored VS Code settings
 * (plan §3.5, §5).
 *
 * OWNERSHIP: shared contract (see CONTRACTS.md). Agent A implements the
 * loader (parsing TOML, merging defaults); the *shapes* here are frozen.
 */

/** Parsed contents of `mathlens.toml` at the workspace root (all optional). */
export interface MathLensConfig {
  /** [symbols] — Python name → TeX form, e.g. attn_weights_masked = '\tilde{A}'. */
  symbols?: Record<string, string>;
  /** [functions] — qualified name → TeX operator, e.g. "mymodel.ops.softmax" = '\operatorname{softmax}'. */
  functions?: Record<string, string>;
  /** [preamble] — user macro file injected into MathJax AND the PDF template (§5). */
  preamble?: PreambleConfig;
  /** [render] — expression rendering choices (plan §6.2 config hooks). */
  render?: RenderConfig;
  /** [pdf] — PDF template options. */
  pdf?: PdfConfig;
  /** [expansion] — call-graph expansion defaults (plan §6.4). */
  expansion?: ExpansionConfig;
}

export interface PreambleConfig {
  /** Path to a .tex file with user macros, relative to the workspace root. */
  include?: string;
}

export interface RenderConfig {
  /** Explicit \cdot between matmul factors instead of juxtaposition. */
  explicitMatmulDot?: boolean;
  /** How `a * b` renders when tensor-ness is unknown: 'odot' | 'cdot' | 'implicit'. */
  elementwiseDefault?: 'odot' | 'cdot' | 'implicit';
  /** `torch.linalg.solve(A, b)`: 'inverse' → A^{-1} b, 'setform' → x : Ax = b. */
  solveStyle?: 'inverse' | 'setform';
  /** mean/std/var: 'blackboard' → 𝔼[x], 'operator' → \operatorname{mean}(x). */
  statsStyle?: 'blackboard' | 'operator';
  /** Render `assert cond` as "s.t. cond" prose (default false, §6.1). */
  renderAsserts?: boolean;
  /** Render `# tex-note:` comments as interleaved prose (default false, §13.3). */
  renderNotes?: boolean;
}

export interface PdfConfig {
  /** 'tectonic' (default, auto-downloaded) or 'latexmk' (system TeX). */
  engine?: 'tectonic' | 'latexmk';
  /** Template: 'derivation' (one-column) or 'literate' (two-column). */
  defaultProfile?: 'derivation' | 'literate';
}

export interface ExpansionConfig {
  /** Max call-graph inline expansion depth (default 2, §6.4). */
  maxDepth?: number;
  /** Default per-call-site mode. */
  defaultMode?: 'reference' | 'inline';
}

/** VS Code settings mirrored from package.json `contributes.configuration` (§3.5). */
export interface VsCodeSettings {
  /** mathlens.panel.debounceMs — panel re-render debounce (default 250). */
  panelDebounceMs: number;
  /** mathlens.pdf.engine */
  pdfEngine: 'tectonic' | 'latexmk';
  /** mathlens.render.displayScale — hover/panel math scale factor (default 1). */
  renderDisplayScale: number;
  /** mathlens.panel.follow — panel follows cursor's enclosing function. */
  panelFollow: boolean;
}

export const DEFAULT_SETTINGS: VsCodeSettings = {
  panelDebounceMs: 250,
  pdfEngine: 'tectonic',
  renderDisplayScale: 1,
  panelFollow: true,
};

/** Effective, merged configuration handed to the translator/naming/emit. */
export interface EffectiveConfig {
  toml: MathLensConfig;
  settings: VsCodeSettings;
}
