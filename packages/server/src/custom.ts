/**
 * Custom LSP requests for the panel & export (plan §3.4). Method names and
 * param/result types come from @mathlens/core/protocol — the shared contract.
 *
 * Graceful degradation (plan principle 3): while core is unimplemented, math
 * requests resolve to an EMPTY MathDocument at the current version (never a
 * request error — the panel renders "nothing translatable yet"); emitLatex
 * resolves to a comment-only .tex. The `mathlens/mathUpdated` notification
 * is driven by the document manager (documents.ts) on recompute.
 *
 * OWNED BY AGENT B.
 */

import type { Connection } from 'vscode-languageserver/node';
import {
  DEFAULT_EXPANSION_PREFS,
  type Annotation,
  type MathDocument,
  type MathResult,
  type Section,
} from '@mathlens/core';
import {
  DocumentMathRequest,
  EmitLatexRequest,
  FunctionMathRequest,
  SelectionMathRequest,
  WorkflowMathRequest,
  type DocumentMathParams,
  type DocumentMathResult,
  type EmitLatexParams,
  type EmitLatexResult,
  type FunctionMathParams,
  type FunctionMathResult,
  type SelectionMathParams,
  type SelectionMathResult,
  type WorkflowMathParams,
  type WorkflowMathResult,
} from '@mathlens/core/protocol';
import type { DocumentState, MathLensDocuments } from './documents.js';
import { populateEquationTex, rangeContainsPosition } from './documents.js';
import { defaultCore, type CoreBridge } from './core.js';

export interface CustomRequestOptions {
  core?: CoreBridge;
}

function emptyDocument(uri: string, version: number): MathDocument {
  return { uri, version, sections: [] };
}

export function registerCustomRequests(
  connection: Connection,
  documents: MathLensDocuments,
  options: CustomRequestOptions = {},
): void {
  const core = options.core ?? defaultCore;
  const handlers = createCustomHandlers(core, documents);

  connection.onRequest(DocumentMathRequest, handlers.documentMath);
  connection.onRequest(FunctionMathRequest, handlers.functionMath);
  connection.onRequest(SelectionMathRequest, handlers.selectionMath);
  connection.onRequest(WorkflowMathRequest, handlers.workflowMath);
  connection.onRequest(EmitLatexRequest, handlers.emitLatex);
}

/**
 * Handler factory, exposed for protocol tests (exercised directly without a
 * jsonrpc connection).
 */
export function createCustomHandlers(core: CoreBridge, documents: MathLensDocuments) {
  async function stateFor(uri: string): Promise<{ state?: DocumentState; version: number }> {
    const state = await documents.getState(uri);
    return { state, version: state?.version ?? documents.get(uri)?.version ?? 0 };
  }

  /**
   * Finalize a MathResult before it ships to the client: pre-emit every
   * equation's TeX with core's emitEquation (F4 — panel output identical to
   * hover/PDF; per-equation try/catch inside populateEquationTex), attach
   * the document-level annotation list (F3 — panel init annotations) and the
   * user preamble (F11 — MathJax macro registration in the webview).
   */
  function withTexAndAnnotations<T extends MathResult>(
    result: T,
    annotations: Annotation[] | undefined,
  ): T {
    try {
      populateEquationTex(result.document, (eq) => core.emitEquation(eq));
    } catch {
      // never let TeX pre-emission fail a math request
    }
    if (annotations && annotations.length > 0) result.annotations = annotations;
    const preamble = documents.getUserPreamble();
    if (preamble) result.preamble = preamble;
    return result;
  }

  /** Qualname of the function whose section/parse range encloses `line`. */
  function qualnameAt(state: DocumentState | undefined, line: number): string | undefined {
    const parsed = state?.parse?.ast.functions ?? state?.scannedFunctions ?? [];
    // innermost = last match with the highest start line
    let best: { qualname: string; startLine: number } | undefined;
    for (const f of parsed) {
      if (rangeContainsPosition(f.range, line)) {
        if (!best || f.range.start.line >= best.startLine) {
          best = { qualname: f.qualname, startLine: f.range.start.line };
        }
      }
    }
    return best?.qualname;
  }

  async function documentMath(params: DocumentMathParams): Promise<DocumentMathResult> {
    const { state, version } = await stateFor(params.uri);
    return withTexAndAnnotations(
      { document: state?.math ?? emptyDocument(params.uri, version) },
      state?.annotations,
    );
  }

  async function functionMath(params: FunctionMathParams): Promise<FunctionMathResult> {
    const { state, version } = await stateFor(params.uri);
    const qualname = qualnameAt(state, params.position.line);
    if (!qualname) return null;

    // Preferred: pick the enclosing function's Section out of cached MathIR.
    const cached = state?.math?.sections.find((s) => s.qualname === qualname);
    if (cached && state?.math) {
      return withTexAndAnnotations(
        { document: { ...state.math, sections: [cached] } },
        state.annotations,
      );
    }

    // Direct per-function translate (also the per-function-rebuild seam, §4.3).
    if (state?.parse && state.naming) {
      try {
        const section: Section | undefined = core.translateFunction(state.parse, qualname, {
          uri: params.uri,
          version,
          naming: state.naming,
          config: documents.getConfig().effective,
        });
        if (section) {
          return withTexAndAnnotations(
            { document: { uri: params.uri, version, sections: [section] } },
            state.annotations,
          );
        }
      } catch {
        // fall through to degraded empty document
      }
    }
    return { document: emptyDocument(params.uri, version) };
  }

  async function selectionMath(params: SelectionMathParams): Promise<SelectionMathResult> {
    const { state, version } = await stateFor(params.uri);
    if (state?.parse && state.naming) {
      try {
        const section = core.translateSelection(state.parse, params.range, {
          uri: params.uri,
          version,
          naming: state.naming,
          config: documents.getConfig().effective,
        });
        // Selection sections use synthetic '<selection>' ids, so document-level
        // annotations don't apply; equation-embedded ones still travel.
        return withTexAndAnnotations(
          { document: { uri: params.uri, version, sections: [section] } },
          undefined,
        );
      } catch {
        // degrade below
      }
    }
    return { document: emptyDocument(params.uri, version) };
  }

  async function workflowMath(params: WorkflowMathParams): Promise<WorkflowMathResult> {
    const { state, version } = await stateFor(params.uri);
    const qualname =
      params.qualname ?? (params.position ? qualnameAt(state, params.position.line) : undefined);
    if (state?.parse && state.naming && qualname) {
      const parse = state.parse;
      try {
        const document = await core.buildWorkflow(parse, qualname, {
          uri: params.uri,
          version,
          naming: state.naming,
          config: documents.getConfig().effective,
          prefs: params.prefs ?? DEFAULT_EXPANSION_PREFS,
          workspace: {
            // Same-file resolution only for now; cross-file callgraph needs a
            // workspace file loader — kept behind this interface so it can be
            // added without protocol changes.
            getParse: async (uri) => (uri === params.uri ? parse : undefined),
            resolveModule: async () => undefined,
          },
        });
        return withTexAndAnnotations({ document }, state.annotations);
      } catch {
        // degrade below
      }
    }
    // Fallback: the enclosing function alone (no callee expansion), or empty.
    if (params.position) {
      const single = await functionMath({ uri: params.uri, position: params.position });
      if (single) return single;
    }
    return { document: emptyDocument(params.uri, version) };
  }

  async function emitLatexHandler(params: EmitLatexParams): Promise<EmitLatexResult> {
    const { state, version } = await stateFor(params.uri);

    // Assemble the target MathDocument mirroring the panel's view
    // (principle 2: PDF is a snapshot of the panel). `params.target` names
    // the panel's actual target kind (F6): selection → selectionMath(range),
    // function → functionMath (no workflow expansion/lemmas), workflow →
    // workflowMath(prefs). Absent → legacy dispatch.
    let target: MathDocument | undefined;
    if (params.target === 'selection' && params.range) {
      const sel = await selectionMath({ uri: params.uri, range: params.range });
      target = sel.document;
    } else if (params.target === 'function' && params.position) {
      const fn = await functionMath({ uri: params.uri, position: params.position });
      target = fn?.document;
    } else if (
      params.target === 'workflow' ||
      (!params.target && (params.prefs || params.qualname || params.position))
    ) {
      const wf = await workflowMath({
        uri: params.uri,
        position: params.position,
        qualname: params.qualname,
        prefs: params.prefs ?? DEFAULT_EXPANSION_PREFS,
      });
      target = wf.document;
    } else {
      target = state?.math;
    }
    if (!target) target = emptyDocument(params.uri, version);

    try {
      const result = core.emitLatex(target, {
        profile: params.profile,
        standalone: true,
        userPreamble: documents.getUserPreamble(),
        numbered: true,
      });
      return { tex: result.tex, sourceMap: result.sourceMap };
    } catch {
      return {
        tex: '% MathLens: LaTeX emission is not available yet (translator core unimplemented).\n',
        sourceMap: [],
      };
    }
  }

  return { documentMath, functionMath, selectionMath, workflowMath, emitLatex: emitLatexHandler };
}
