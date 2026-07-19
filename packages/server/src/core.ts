/**
 * The server's single seam onto @mathlens/core.
 *
 * Agent A implements core's bodies in parallel; the *signatures* are the
 * contract (CONTRACTS.md). Every server call site goes through this bridge
 * inside try/catch, so a still-throwing core degrades gracefully (plan
 * principle 3) — and tests can inject a mock core without module trickery.
 *
 * OWNED BY AGENT B.
 */

import {
  DeclaredShapeProvider,
  NamingEngine,
  buildWorkflow,
  emitEquation,
  emitLatex,
  initParser,
  parsePython,
  translateDocument,
  translateFunction,
  translateSelection,
} from '@mathlens/core';

/** Everything the server calls on core, mockable as a unit. */
export interface CoreBridge {
  initParser: typeof initParser;
  parsePython: typeof parsePython;
  translateDocument: typeof translateDocument;
  translateFunction: typeof translateFunction;
  translateSelection: typeof translateSelection;
  buildWorkflow: typeof buildWorkflow;
  emitLatex: typeof emitLatex;
  emitEquation: typeof emitEquation;
  NamingEngine: typeof NamingEngine;
  /**
   * F8 declared-shape provider (plan §4.2): constructed PER COMPUTE from the
   * shape annotations translation collected (TranslateResult.shapeAnnotations)
   * — a no-arg instance would always be empty, so documents.ts passes the
   * fresh annotations for each translate pass. Used only through the
   * provider-agnostic AnnotationProvider interface (never branch on provider
   * identity or annotation origin).
   */
  DeclaredShapeProvider: typeof DeclaredShapeProvider;
}

export const defaultCore: CoreBridge = {
  initParser,
  parsePython,
  translateDocument,
  translateFunction,
  translateSelection,
  buildWorkflow,
  emitLatex,
  emitEquation,
  NamingEngine,
  DeclaredShapeProvider,
};
