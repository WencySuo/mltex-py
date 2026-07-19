/**
 * Document manager: open-document tracking, per-version parse + MathIR cache,
 * debounced recompute with `mathlens/mathUpdated` patches, workspace config
 * (mathlens.toml), annotation merging, and translation diagnostics
 * (plan §3.2–§3.5, §4.3).
 *
 * Graceful degradation (plan principle 3): every call into @mathlens/core is
 * wrapped — core still throwing 'not implemented' (agent A works in parallel)
 * leaves the server responsive: hover falls back to raw statement text,
 * CodeLens falls back to a regex function scan, custom requests return empty
 * documents. Rebuild granularity: full-document rebuild today, behind the
 * per-function-capable getState() interface (plan §4.3 note).
 *
 * OWNED BY AGENT B.
 */

import {
  DiagnosticSeverity,
  TextDocuments,
  type Connection,
  type Diagnostic,
  type InitializeParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  DEFAULT_SETTINGS,
  StaticNoteProvider,
  collectAnnotations,
  type Annotation,
  type AnnotationProvider,
  type Equation,
  type MathDocument,
  type NamingEngine,
  type ParseResult,
  type Range,
  type StableId,
} from '@mathlens/core';
import { MathUpdatedNotification, type MathUpdatedParams } from '@mathlens/core/protocol';
import { defaultCore, type CoreBridge } from './core.js';
import { loadWorkspaceConfig, uriToFsPath, type LoadedConfig } from './config.js';
import { diffMathDocuments, isEmptyPatch } from './patch.js';
import { scanPythonFunctions, type ScannedFunction } from './pyscan.js';

/** Everything the server knows about one document version. */
export interface DocumentState {
  uri: string;
  version: number;
  /** Core parse result; undefined when core parse failed/unimplemented. */
  parse?: ParseResult;
  /** Naming engine used for this translation pass (hover symbol bindings). */
  naming?: NamingEngine;
  /**
   * MathIR with provider annotations merged in — what the server ships.
   * Undefined when core translate failed/unimplemented.
   */
  math?: MathDocument;
  /** Merged annotation list (also present inside math's equations). */
  annotations: Annotation[];
  /** Regex-scan fallback function list, used when `parse` is unavailable. */
  scannedFunctions: ScannedFunction[];
  /** True when any core stage threw (degraded mode). */
  degraded: boolean;
}

export interface MathLensDocumentsOptions {
  core?: CoreBridge;
  /** Debounce for change-triggered recomputes (plan default 250 ms). */
  debounceMs?: number;
}

interface CacheEntry {
  state?: DocumentState;
  inflight?: Promise<DocumentState>;
  inflightVersion?: number;
  debounce?: ReturnType<typeof setTimeout>;
  /** Last MathIR shipped via mathUpdated (diff base). */
  shippedMath?: MathDocument;
  shippedAnnotations: Annotation[];
}

export class MathLensDocuments {
  private readonly documents = new TextDocuments(TextDocument);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly core: CoreBridge;
  private readonly extraProviders: AnnotationProvider[] = [];
  private connection: Connection | undefined;
  private workspaceRoot: string | undefined;
  private wasmDir: string | undefined;
  private config: LoadedConfig = loadWorkspaceConfig(undefined);
  private configuredDebounceMs: number | undefined;
  private parserReady: Promise<boolean> | undefined;
  private readonly changeListeners: Array<(uri: string) => void> = [];

  constructor(options: MathLensDocumentsOptions = {}) {
    this.core = options.core ?? defaultCore;
    this.configuredDebounceMs = options.debounceMs;
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  /** Capture workspace root (for mathlens.toml) from the initialize handshake. */
  initialize(params: InitializeParams): void {
    const folderUri = params.workspaceFolders?.[0]?.uri ?? params.rootUri ?? undefined;
    this.workspaceRoot = folderUri ? uriToFsPath(folderUri) : undefined;
    this.reloadConfig();
  }

  /** Directory holding tree-sitter wasm files (bundled deployments must set). */
  setWasmDir(dir: string): void {
    this.wasmDir = dir;
  }

  listen(connection: Connection): void {
    this.connection = connection;
    this.documents.listen(connection);

    this.documents.onDidChangeContent((change) => {
      this.scheduleRecompute(change.document.uri);
    });

    this.documents.onDidClose((e) => {
      const entry = this.cache.get(e.document.uri);
      if (entry?.debounce) clearTimeout(entry.debounce);
      this.cache.delete(e.document.uri);
      // Clear our diagnostics for the closed file.
      connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] }).catch(() => {});
    });

    // mathlens.toml changes (client watches it — see extension.ts synchronize).
    connection.onDidChangeWatchedFiles(() => {
      this.reloadConfig();
      for (const doc of this.documents.all()) this.scheduleRecompute(doc.uri, 0);
    });
  }

  /** Register at server startup; used by DAP-adjacent or future providers. */
  addAnnotationProvider(provider: AnnotationProvider): void {
    this.extraProviders.push(provider);
  }

  /** Observe recomputes (codelens refresh piggybacks on this). */
  onDidRecompute(listener: (uri: string) => void): void {
    this.changeListeners.push(listener);
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  get(uri: string): TextDocument | undefined {
    return this.documents.get(uri);
  }

  all(): TextDocument[] {
    return [...this.documents.all()];
  }

  getConfig(): LoadedConfig {
    return this.config;
  }

  /** User preamble macros for MathJax injection (plan §5). */
  getUserPreamble(): string | undefined {
    return this.config.userPreamble;
  }

  private get debounceMs(): number {
    return this.configuredDebounceMs ?? this.config.effective.settings.panelDebounceMs;
  }

  reloadConfig(): void {
    this.config = loadWorkspaceConfig(this.workspaceRoot, DEFAULT_SETTINGS);
    for (const w of this.config.warnings) {
      this.connection?.console.warn(`mathlens.toml: ${w.message}`);
    }
  }

  /**
   * Up-to-date state for a document: cached when the version matches,
   * recomputed (and cached) otherwise. Undefined for unknown documents.
   */
  async getState(uri: string): Promise<DocumentState | undefined> {
    const doc = this.documents.get(uri);
    if (!doc) return this.cache.get(uri)?.state;
    const entry = this.ensureEntry(uri);
    if (entry.state && entry.state.version === doc.version) return entry.state;
    if (entry.inflight && entry.inflightVersion === doc.version) return entry.inflight;
    return this.recompute(doc);
  }

  /** MathIR for a document (annotations merged), or undefined when degraded. */
  async getMath(uri: string): Promise<MathDocument | undefined> {
    return (await this.getState(uri))?.math;
  }

  // -------------------------------------------------------------------------
  // Compute pipeline
  // -------------------------------------------------------------------------

  private ensureEntry(uri: string): CacheEntry {
    let entry = this.cache.get(uri);
    if (!entry) {
      entry = { shippedAnnotations: [] };
      this.cache.set(uri, entry);
    }
    return entry;
  }

  private scheduleRecompute(uri: string, delay = this.debounceMs): void {
    const entry = this.ensureEntry(uri);
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
      entry.debounce = undefined;
      const doc = this.documents.get(uri);
      if (!doc) return;
      // Already computed at this version (e.g. an eager getState() beat the
      // debounce): skip the duplicate parse+translate.
      if (entry.state && entry.state.version === doc.version) return;
      if (entry.inflight && entry.inflightVersion === doc.version) return;
      void this.recompute(doc).catch(() => {});
    }, delay);
  }

  private recompute(doc: TextDocument): Promise<DocumentState> {
    const entry = this.ensureEntry(doc.uri);
    const version = doc.version;
    const run = this.computeState(doc)
      .then((state) => {
        // Drop stale results (document changed while computing).
        const current = this.documents.get(doc.uri);
        if (!current || current.version === version) {
          entry.state = state;
          if (entry.inflightVersion === version) {
            entry.inflight = undefined;
            entry.inflightVersion = undefined;
          }
          this.afterCompute(entry, state);
        }
        return state;
      })
      .catch((err) => {
        // computeState never throws by design; belt and braces.
        this.connection?.console.error(`MathLens compute failed for ${doc.uri}: ${String(err)}`);
        const state: DocumentState = {
          uri: doc.uri,
          version,
          annotations: [],
          scannedFunctions: safeScan(doc.getText()),
          degraded: true,
        };
        entry.state = state;
        entry.inflight = undefined;
        entry.inflightVersion = undefined;
        return state;
      });
    entry.inflight = run;
    entry.inflightVersion = version;
    return run;
  }

  private async ensureParser(): Promise<boolean> {
    if (!this.parserReady) {
      this.parserReady = this.core
        .initParser({ wasmDir: this.wasmDir })
        .then(() => true)
        .catch((err) => {
          this.connection?.console.warn(`MathLens parser init unavailable: ${String(err)}`);
          // Allow retry on next compute (agent A may land core mid-session
          // only in dev; cheap either way).
          this.parserReady = undefined;
          return false;
        });
    }
    return this.parserReady;
  }

  private async computeState(doc: TextDocument): Promise<DocumentState> {
    const uri = doc.uri;
    const version = doc.version;
    const text = doc.getText();
    let degraded = false;

    // 1. Parse (core tree-sitter; regex scan as degradation fallback).
    let parse: ParseResult | undefined;
    if (await this.ensureParser()) {
      try {
        parse = await this.core.parsePython(text);
      } catch {
        degraded = true;
      }
    } else {
      degraded = true;
    }
    const scannedFunctions = safeScan(text);

    // 2. Naming engine (directives + mathlens.toml [symbols]/[functions]).
    let naming: NamingEngine | undefined;
    try {
      naming = new this.core.NamingEngine({
        directives: parse?.ast.directives ?? [],
        config: this.config.effective.toml,
      });
    } catch {
      degraded = true;
    }

    // 3. Translate to MathIR.
    let math: MathDocument | undefined;
    let shapeAnnotations: Annotation[] = [];
    if (parse && naming) {
      try {
        const result = this.core.translateDocument(parse, {
          uri,
          version,
          naming,
          config: this.config.effective,
        });
        math = result.document;
        shapeAnnotations = result.shapeAnnotations ?? [];
      } catch {
        degraded = true;
      }
    }

    // 4. Annotations: StaticNoteProvider + a per-compute DeclaredShapeProvider
    // over this pass's collected shape annotations (F8) + any registered
    // providers, merged provider-agnostically (plan §4.2 — never branch on
    // origin or provider identity).
    let annotations: Annotation[] = [];
    if (math) {
      const providers: AnnotationProvider[] = [
        new StaticNoteProvider([]),
        new this.core.DeclaredShapeProvider(shapeAnnotations),
        ...this.extraProviders,
      ];
      try {
        annotations = await collectAnnotations(math, providers);
      } catch {
        annotations = [];
      }
      math = mergeAnnotations(math, annotations);
      // Single-source-of-truth TeX (F4 parity): pre-emit every equation with
      // core's emitEquation so panel output matches hover/PDF exactly. This
      // also flows into mathUpdated patches (diffed from this math).
      populateEquationTex(math, (eq) => this.core.emitEquation(eq));
    }

    const state: DocumentState = {
      uri,
      version,
      parse,
      naming,
      math,
      annotations,
      scannedFunctions,
      degraded,
    };

    this.publishDiagnostics(state);
    return state;
  }

  private afterCompute(entry: CacheEntry, state: DocumentState): void {
    // Ship a mathUpdated patch whenever the shipped MathIR changed (plan §3.4).
    if (state.math) {
      const patch = diffMathDocuments(entry.shippedMath, state.math, {
        previous: entry.shippedAnnotations,
        next: state.annotations,
      });
      if (!isEmptyPatch(patch)) {
        const params: MathUpdatedParams = { uri: state.uri, version: state.version, patch };
        this.connection?.sendNotification(MathUpdatedNotification, params).catch(() => {});
      }
      entry.shippedMath = state.math;
      entry.shippedAnnotations = state.annotations;
    }
    for (const listener of this.changeListeners) {
      try {
        listener(state.uri);
      } catch {
        // listeners must not break the pipeline
      }
    }
  }

  // -------------------------------------------------------------------------
  // Diagnostics (plan §3.4: translation warnings as hint/warning severity)
  // -------------------------------------------------------------------------

  private publishDiagnostics(state: DocumentState): void {
    if (!this.connection) return;
    const diagnostics: Diagnostic[] = [];

    for (const d of state.parse?.diagnostics ?? []) {
      diagnostics.push({
        range: d.range,
        message: d.message,
        // Syntax errors are the Python tooling's job; ours stay quiet
        // (warning at most — plan §3.4).
        severity: d.severity === 'hint' ? DiagnosticSeverity.Hint : DiagnosticSeverity.Warning,
        source: 'mathlens',
      });
    }

    // Naming hints: multi-word leftovers, collisions (plan §5.3–5.4).
    try {
      for (const hint of state.naming?.hints() ?? []) {
        diagnostics.push({
          range: hint.range ?? {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          message: hint.message,
          severity: DiagnosticSeverity.Hint,
          source: 'mathlens',
        });
      }
    } catch {
      // NamingEngine.hints() unimplemented — tolerate (plan principle 3).
    }

    this.connection
      .sendDiagnostics({ uri: state.uri, version: state.version, diagnostics })
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeScan(text: string): ScannedFunction[] {
  try {
    return scanPythonFunctions(text);
  } catch {
    return [];
  }
}

/** Equation id an annotation target resolves to (occurrence ids are `eqId#n`). */
function targetEquationId(target: string): string {
  const hash = target.lastIndexOf('#');
  return hash >= 0 ? target.slice(0, hash) : target;
}

/**
 * Return a copy of the document with provider annotations merged into the
 * targeted equations' `annotations` arrays (plan §4.2). Section-level targets
 * (signature/section ids) don't have an annotations slot; they still travel
 * in the document-level list / MathPatch.annotations.
 */
export function mergeAnnotations(
  doc: MathDocument,
  annotations: readonly Annotation[],
): MathDocument {
  if (annotations.length === 0) return doc;
  const byEquation = new Map<string, Annotation[]>();
  for (const a of annotations) {
    const eqId = targetEquationId(String(a.target));
    const list = byEquation.get(eqId);
    if (list) list.push(a);
    else byEquation.set(eqId, [a]);
  }
  if (byEquation.size === 0) return doc;

  const merged: MathDocument = structuredClone(doc);
  forEachEquation(merged, (eq) => {
    const extra = byEquation.get(String(eq.id));
    if (extra) {
      // Structural dedup: translation may already have embedded the same
      // annotation (e.g. DeclaredShapeProvider re-provides shapes collected
      // during translation) — don't double-badge.
      const seen = new Set(eq.annotations.map(annotationKey));
      const fresh = extra.filter((a) => !seen.has(annotationKey(a)));
      if (fresh.length > 0) eq.annotations = [...eq.annotations, ...fresh];
    }
  });
  return merged;
}

/** Structural identity key for annotation dedup. */
function annotationKey(a: Annotation): string {
  return `${String(a.target)} ${a.kind} ${a.origin} ${JSON.stringify(a.payload)}`;
}

/**
 * Populate `Equation.tex` on every equation via core's emitEquation so the
 * panel typesets exactly what hover/PDF emit (single-source-of-truth TeX,
 * plan §4.1). Per-equation try/catch: on failure `tex` stays undefined and
 * the webview's fallback walker applies. Mutates and returns `doc`.
 */
export function populateEquationTex(
  doc: MathDocument,
  emit: (eq: Equation) => string,
): MathDocument {
  forEachEquation(doc, (eq) => {
    try {
      const tex = emit(eq);
      if (typeof tex === 'string' && tex.trim().length > 0) eq.tex = tex;
    } catch {
      // leave undefined — webview falls back to its own emitter
    }
  });
  return doc;
}

/** Visit every equation in a MathDocument (align runs, cases subjects, loops). */
export function forEachEquation(doc: MathDocument, visit: (eq: Equation) => void): void {
  const walkBlocks = (blocks: MathDocument['sections'][number]['blocks']): void => {
    for (const b of blocks) {
      if (b.kind === 'align') b.equations.forEach(visit);
      else if (b.kind === 'cases') visit(b.subject);
      else if (b.kind === 'loop') walkBlocks(b.body);
    }
  };
  for (const section of doc.sections) walkBlocks(section.blocks);
}

/** Position-in-range test over MathIR/LSP-shaped ranges. */
export function rangeContainsPosition(range: Range, line: number, character?: number): boolean {
  if (line < range.start.line || line > range.end.line) return false;
  if (character === undefined) return true;
  if (line === range.start.line && character < range.start.character) return false;
  if (line === range.end.line && character > range.end.character) return false;
  return true;
}

/** Smallest equation whose sourceRange spans `line` (statement-level hover, F0). */
export function findEquationAtLine(
  doc: MathDocument,
  line: number,
): { equation: Equation; sectionId: StableId } | undefined {
  let best: { equation: Equation; sectionId: StableId } | undefined;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const section of doc.sections) {
    forEachEquation({ ...doc, sections: [section] }, (eq) => {
      if (!rangeContainsPosition(eq.sourceRange, line)) return;
      const span = eq.sourceRange.end.line - eq.sourceRange.start.line;
      if (span < bestSpan) {
        bestSpan = span;
        best = { equation: eq, sectionId: section.id };
      }
    });
  }
  return best;
}
