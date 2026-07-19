/**
 * Shared test harness for server-level protocol tests (plan §11).
 *
 * - FakeConnection: captures every handler the server registers and lets
 *   tests drive open/change/close + hover/codeLens/custom requests directly,
 *   and records outgoing notifications/diagnostics.
 * - Mock cores: `workingCore()` is a tiny line-based "translator" good enough
 *   to produce real MathIR (with real computeStableId, so stable-ID tests are
 *   honest); `throwingCore()` mirrors today's not-implemented stubs.
 */

import {
  DeclaredShapeProvider,
  NamingEngine,
  computeStableId,
  computeSymbolOccurrenceId,
  type Annotation,
  type Equation,
  type MathDocument,
  type MathNode,
  type ParseResult,
  type Range,
  type ResolvedName,
  type Section,
} from '@mathlens/core';
import type { CoreBridge } from '../src/core.js';
import { scanPythonFunctions } from '../src/pyscan.js';

// ---------------------------------------------------------------------------
// FakeConnection
// ---------------------------------------------------------------------------

type Handler = (...args: any[]) => any;

export interface SentNotification {
  method: string;
  params: unknown;
}

export class FakeConnection {
  // captured handlers
  readonly handlers = new Map<string, Handler>();
  openHandler: Handler = () => {};
  changeHandler: Handler = () => {};
  closeHandler: Handler = () => {};
  hoverHandler: Handler | undefined;
  codeLensHandler: Handler | undefined;
  watchedFilesHandler: Handler | undefined;

  // recorded outgoing traffic
  readonly notifications: SentNotification[] = [];
  readonly diagnostics: Array<{ uri: string; diagnostics: unknown[] }> = [];
  readonly logs: string[] = [];

  // --- TextDocumentConnection surface (TextDocuments.listen) ---
  onDidOpenTextDocument(h: Handler) {
    this.openHandler = h;
    return { dispose() {} };
  }
  onDidChangeTextDocument(h: Handler) {
    this.changeHandler = h;
    return { dispose() {} };
  }
  onDidCloseTextDocument(h: Handler) {
    this.closeHandler = h;
    return { dispose() {} };
  }
  onWillSaveTextDocument(_h: Handler) {
    return { dispose() {} };
  }
  onWillSaveTextDocumentWaitUntil(_h: Handler) {
    return { dispose() {} };
  }
  onDidSaveTextDocument(_h: Handler) {
    return { dispose() {} };
  }

  // --- Connection surface used by the server ---
  onDidChangeWatchedFiles(h: Handler) {
    this.watchedFilesHandler = h;
    return { dispose() {} };
  }
  onHover(h: Handler) {
    this.hoverHandler = h;
    return { dispose() {} };
  }
  onCodeLens(h: Handler) {
    this.codeLensHandler = h;
    return { dispose() {} };
  }
  onRequest(method: string | { method: string }, h: Handler) {
    this.handlers.set(typeof method === 'string' ? method : method.method, h);
    return { dispose() {} };
  }
  onNotification(method: string | { method: string }, h: Handler) {
    this.handlers.set(typeof method === 'string' ? method : method.method, h);
    return { dispose() {} };
  }
  sendNotification(method: string | { method: string }, params?: unknown): Promise<void> {
    this.notifications.push({
      method: typeof method === 'string' ? method : method.method,
      params,
    });
    return Promise.resolve();
  }
  sendRequest(_type: unknown, _params?: unknown): Promise<unknown> {
    return Promise.resolve(null);
  }
  sendDiagnostics(params: { uri: string; diagnostics: unknown[] }): Promise<void> {
    this.diagnostics.push(params);
    return Promise.resolve();
  }
  console = {
    log: (m: string) => this.logs.push(m),
    warn: (m: string) => this.logs.push(m),
    error: (m: string) => this.logs.push(m),
    info: (m: string) => this.logs.push(m),
  };

  // --- test drivers ---
  open(uri: string, text: string, version = 1): void {
    this.openHandler({
      textDocument: { uri, languageId: 'python', version, text },
    });
  }
  /** Full-document replace (TextDocuments accepts full-text change events). */
  change(uri: string, text: string, version: number): void {
    this.changeHandler({
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }
  close(uri: string): void {
    this.closeHandler({ textDocument: { uri } });
  }

  notificationsFor(method: string): SentNotification[] {
    return this.notifications.filter((n) => n.method === method);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Mock cores
// ---------------------------------------------------------------------------

class MockNaming extends NamingEngine {
  override texFor(pythonName: string): string {
    return pythonName;
  }
  override texForFunction(qualname: string): string {
    return `\\operatorname{${qualname.split('.').pop()}}`;
  }
  override resolve(pythonName: string): ResolvedName {
    return { pythonName, tex: pythonName, source: 'heuristic' };
  }
  override hints() {
    return [] as const;
  }
}

function lineRange(line: number, length: number): Range {
  return { start: { line, character: 0 }, end: { line, character: length } };
}

function sym(name: string, range: Range, eqId: string, ordinal: number): MathNode {
  return {
    kind: 'sym',
    pythonName: name,
    tex: name,
    occurrenceId: computeSymbolOccurrenceId(eqId as any, ordinal),
    sourceRange: range,
  };
}

const ASSIGN_RE = /^(\s*)([A-Za-z_]\w*)\s*=\s*(.+?)\s*(?:#.*)?$/;

/**
 * Line-based fake translation: every `name = expr` line inside a scanned
 * function becomes an Equation (lhs sym, rhs raw) with a REAL computeStableId
 * (qualname / 'assign' / lhs / per-lhs ordinal) — enough for patch-diff and
 * stable-ID-survival tests to be meaningful.
 */
export function fakeTranslate(uri: string, version: number, text: string): MathDocument {
  const functions = scanPythonFunctions(text);
  const lines = text.split(/\r?\n/);
  const sections: Section[] = functions.map((f) => {
    const ordinals = new Map<string, number>();
    const equations: Equation[] = [];
    for (let line = f.range.start.line + 1; line <= f.range.end.line; line++) {
      const m = ASSIGN_RE.exec(lines[line] ?? '');
      if (!m) continue;
      const lhsName = m[2];
      const rhsText = m[3];
      const ordinal = ordinals.get(lhsName) ?? 0;
      ordinals.set(lhsName, ordinal + 1);
      const id = computeStableId({
        qualname: f.qualname,
        role: 'assign',
        lhsSymbol: lhsName,
        ordinal,
      });
      const range = lineRange(line, lines[line].length);
      equations.push({
        id,
        lhs: sym(lhsName, range, id, 0),
        rhs: { kind: 'raw', text: rhsText, sourceRange: range },
        relation: '=',
        sourceRange: range,
        annotations: [],
      });
    }
    return {
      id: computeStableId({ qualname: f.qualname, role: 'section', lhsSymbol: '', ordinal: 0 }),
      kind: 'function' as const,
      title: f.name,
      qualname: f.qualname,
      blocks: [{ kind: 'align' as const, equations }],
      sourceRange: f.range,
    };
  });
  return { uri, version, sections };
}

export function fakeParse(text: string): ParseResult {
  const functions = scanPythonFunctions(text).map((f) => ({
    name: f.name,
    qualname: f.qualname,
    range: f.range,
    bodyRange: f.range,
    node: undefined as unknown,
  }));
  return {
    ast: { tree: undefined, functions, directives: [], source: text, comments: [] },
    diagnostics: [],
  };
}

/** A CoreBridge whose pipeline "works" (line-based fake translator). */
export function workingCore(overrides: Partial<CoreBridge> = {}): CoreBridge {
  const sources = new Map<string, string>();
  const core: CoreBridge = {
    initParser: async () => {},
    parsePython: async (source: string) => {
      sources.set('last', source);
      return fakeParse(source);
    },
    translateDocument: (parsed, opts) => ({
      document: fakeTranslate(opts.uri, opts.version, sources.get('last') ?? ''),
      fallbacks: [],
    }),
    translateFunction: (parsed, qualname, opts) => {
      const doc = fakeTranslate(opts.uri, opts.version, sources.get('last') ?? '');
      return doc.sections.find((s) => s.qualname === qualname);
    },
    translateSelection: (_parsed, range, opts) => ({
      id: computeStableId({ qualname: '<selection>', role: 'section', lhsSymbol: '', ordinal: 0 }),
      kind: 'selection',
      title: 'Selection',
      blocks: [],
      sourceRange: range,
    }),
    buildWorkflow: async (_entry, entryQualname, opts) => {
      const doc = fakeTranslate(opts.uri, opts.version, sources.get('last') ?? '');
      const main = doc.sections.filter((s) => s.qualname === entryQualname);
      return { ...doc, sections: main.length > 0 ? main : doc.sections };
    },
    emitLatex: (doc, opts) => ({
      tex: `% profile: ${opts.profile}\n${opts.userPreamble ?? ''}\n\\begin{document}\\end{document}\n`,
      sourceMap: [],
    }),
    emitEquation: (eq) => {
      const lhs = eq.lhs && eq.lhs.kind === 'sym' ? eq.lhs.tex : '';
      const rhs = eq.rhs.kind === 'raw' ? `\\texttt{${eq.rhs.text}}` : 'x';
      return lhs ? `${lhs} ${eq.relation === '=' ? '=' : eq.relation} ${rhs}` : rhs;
    },
    NamingEngine: MockNaming as unknown as typeof NamingEngine,
    DeclaredShapeProvider,
    ...overrides,
  };
  return core;
}

/** A CoreBridge matching today's stubs: everything throws 'not implemented'. */
export function throwingCore(): CoreBridge {
  const boom = () => {
    throw new Error('not implemented');
  };
  return {
    initParser: async () => boom(),
    parsePython: async () => boom(),
    translateDocument: boom as never,
    translateFunction: boom as never,
    translateSelection: boom as never,
    buildWorkflow: async () => boom() as never,
    emitLatex: boom as never,
    emitEquation: boom as never,
    // Real class: construction succeeds, methods throw (matches the stub).
    NamingEngine,
    DeclaredShapeProvider,
  };
}

/** Annotation provider stub for merge tests. */
export function staticAnnotations(annotations: Annotation[]) {
  return {
    name: 'test-provider',
    provide: async () => annotations,
  };
}
