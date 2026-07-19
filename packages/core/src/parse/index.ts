/**
 * Parsing — tree-sitter wrapper, Python CST → typed AST slice (plan §3.2).
 *
 * OWNED BY AGENT A.
 *
 * WASM resolution: web-tree-sitter needs two wasm files at runtime:
 *  1. tree-sitter.wasm       — ships inside the web-tree-sitter npm package.
 *  2. tree-sitter-python.wasm — ships inside the tree-sitter-python npm
 *     package (verified: `package/tree-sitter-python.wasm` in the tarball)
 *     and is vendored into `packages/core/wasm/` for bundled builds.
 * `resolveLanguageWasmPath()` below is the single source of truth for
 * locating the grammar wasm; bundlers (esbuild in server) must copy both
 * wasm files next to the bundle and pass `wasmDir` (see core/README.md).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type Node as TsNode, type Tree } from 'web-tree-sitter';
import type { Range } from '../ir/types.js';

/** A parse-level diagnostic (syntax error region, unparseable directive, …). */
export interface ParseDiagnostic {
  message: string;
  range: Range;
  severity: 'error' | 'warning' | 'hint';
}

/**
 * A `# tex:` / `# tex-note:` directive found in the source (plan §5).
 * Collected at parse time; consumed by the NamingEngine and translator.
 */
export interface TexDirective {
  kind: 'tex' | 'tex-note';
  /** For `# tex: \tilde{A}` on a defining line: bindings = [{ name: <lhs>, tex }]. */
  bindings: Array<{ name: string; tex: string }>;
  /** Raw directive text after the marker. */
  raw: string;
  range: Range;
  /** Line the directive applies from (file-wide multi-binding form). */
  effectiveFromLine: number;
}

/**
 * A non-directive trailing comment, e.g. a shape comment `# (B, T, D)`
 * (plan §6.6 Tier 1). Keyed by line for cheap lookup during translation.
 * ADDITIVE contract change 2026-07-18 (agent A): new exported type.
 */
export interface TrailingComment {
  /** Zero-based line the comment sits on. */
  line: number;
  /** Comment text without the leading `#`, trimmed. */
  text: string;
  range: Range;
}

/**
 * The typed slice of the Python CST that translation consumes.
 * Agent A defines the concrete node shapes; consumers outside core should
 * treat this as opaque and use `translate/` instead.
 */
export interface PythonAst {
  /** Opaque tree-sitter tree handle (web-tree-sitter Tree). */
  tree: unknown;
  /** Top-level and nested function definitions, in source order. */
  functions: FunctionInfo[];
  directives: TexDirective[];
  /**
   * Full source text the tree was parsed from (translation needs it for
   * verbatim fallbacks). ADDITIVE contract change 2026-07-18 (agent A).
   */
  source: string;
  /**
   * All comments in the file, in source order (shape comments, notes).
   * ADDITIVE contract change 2026-07-18 (agent A).
   */
  comments: TrailingComment[];
}

/** Summary of one function definition discovered in the file. */
export interface FunctionInfo {
  name: string;
  /** Qualified name within the file, e.g. "MyClass.forward" or "outer.inner". */
  qualname: string;
  range: Range;
  bodyRange: Range;
  /** Opaque tree-sitter node for the function_definition. */
  node: unknown;
  /** Docstring text (unquoted), if the body starts with a string literal. */
  docstring?: string;
}

export interface ParseResult {
  ast: PythonAst;
  diagnostics: ParseDiagnostic[];
}

/**
 * Locate `tree-sitter-python.wasm` on disk. Resolution order:
 *  1. explicit `wasmDir` argument (bundled deployments pass the dir the
 *     bundler copied wasm files into),
 *  2. the vendored copy in `packages/core/wasm/`,
 *  3. the installed `tree-sitter-python` npm package.
 * Throws if none exists.
 */
export function resolveLanguageWasmPath(wasmDir?: string): string {
  const candidates: string[] = [];
  if (wasmDir) candidates.push(path.join(wasmDir, 'tree-sitter-python.wasm'));
  // import.meta.url is empty when core is bundled into a CJS bundle (the
  // server bundle) — bundled deployments MUST pass wasmDir instead.
  try {
    const metaUrl: string | undefined = import.meta.url;
    if (metaUrl) {
      const here = path.dirname(fileURLToPath(metaUrl));
      candidates.push(path.resolve(here, '../../wasm/tree-sitter-python.wasm'));
      candidates.push(
        path.resolve(here, '../../../../node_modules/tree-sitter-python/tree-sitter-python.wasm'),
      );
    }
  } catch {
    // ignore — fall through to the error below if nothing matched
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `tree-sitter-python.wasm not found. Looked in:\n${candidates.join('\n')}\n` +
      'See packages/core/README.md ("WASM resolution").',
  );
}

/** Options for parser initialization. */
export interface ParserInitOptions {
  /** Directory containing tree-sitter.wasm and tree-sitter-python.wasm. */
  wasmDir?: string;
}

let pythonLanguage: Language | undefined;
let initPromise: Promise<void> | undefined;

/**
 * Initialize web-tree-sitter and load the Python grammar. Idempotent;
 * subsequent calls reuse the loaded language. Must be awaited once before
 * `parsePython` / `reparsePython`.
 */
export async function initParser(options?: ParserInitOptions): Promise<void> {
  if (pythonLanguage) return;
  if (!initPromise) {
    initPromise = (async () => {
      const wasmDir = options?.wasmDir;
      await Parser.init(
        wasmDir
          ? {
              locateFile: (file: string) => path.join(wasmDir, file),
            }
          : undefined,
      );
      const langPath = resolveLanguageWasmPath(wasmDir);
      pythonLanguage = await Language.load(langPath);
    })().catch((err) => {
      initPromise = undefined;
      throw err;
    });
  }
  await initPromise;
}

function requireLanguage(): Language {
  if (!pythonLanguage) {
    throw new Error('Parser not initialized — await initParser() first.');
  }
  return pythonLanguage;
}

// ---------------------------------------------------------------------------
// Range helpers (exported for translate/)
// ---------------------------------------------------------------------------

/** Convert a tree-sitter node's position to an IR/LSP Range. */
export function nodeRange(node: TsNode): Range {
  return {
    start: { line: node.startPosition.row, character: node.startPosition.column },
    end: { line: node.endPosition.row, character: node.endPosition.column },
  };
}

// ---------------------------------------------------------------------------
// Directive & comment scanning
// ---------------------------------------------------------------------------

const TEX_DIRECTIVE = /^#\s*tex:\s*(.*)$/;
const TEX_NOTE_DIRECTIVE = /^#\s*tex-note:\s*(.*)$/;

/**
 * Parse the payload of a `# tex:` directive. Two forms (plan §5.1):
 *  - LHS form: `\tilde{A}` — no `=` binding; applies to the statement's LHS.
 *  - Multi-binding: `attn=\tilde{A}, w=W_q` — file-wide from this line.
 * Returns bindings; the LHS form yields a single binding with empty name
 * that the caller fills with the statement's LHS symbol.
 */
function parseTexPayload(payload: string): Array<{ name: string; tex: string }> {
  // Multi-binding form requires `name=` where name is a Python identifier.
  const bindingRe = /^[A-Za-z_][A-Za-z0-9_]*\s*=/;
  if (!bindingRe.test(payload.trim())) {
    return [{ name: '', tex: payload.trim() }];
  }
  const bindings: Array<{ name: string; tex: string }> = [];
  // Split on commas that are not inside braces (TeX often contains `{a,b}`).
  let depth = 0;
  let cur = '';
  const parts: string[] = [];
  for (const ch of payload) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const tex = part.slice(eq + 1).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && tex) bindings.push({ name, tex });
  }
  return bindings;
}

/** Find the LHS identifier of the statement a trailing directive sits on. */
function lhsOnLine(root: TsNode, line: number): string | undefined {
  let found: string | undefined;
  const visit = (node: TsNode): void => {
    if (found) return;
    if (node.startPosition.row > line || node.endPosition.row < line) return;
    if (
      (node.type === 'assignment' || node.type === 'augmented_assignment') &&
      node.startPosition.row === line
    ) {
      const left = node.childForFieldName('left');
      if (left?.type === 'identifier') {
        found = left.text;
        return;
      }
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(root);
  return found;
}

function collectCommentsAndDirectives(
  root: TsNode,
  diagnostics: ParseDiagnostic[],
): { directives: TexDirective[]; comments: TrailingComment[] } {
  const directives: TexDirective[] = [];
  const comments: TrailingComment[] = [];
  const visit = (node: TsNode): void => {
    if (node.type === 'comment') {
      const range = nodeRange(node);
      const line = node.startPosition.row;
      const text = node.text;
      const texMatch = TEX_DIRECTIVE.exec(text);
      const noteMatch = TEX_NOTE_DIRECTIVE.exec(text);
      if (texMatch) {
        const payload = texMatch[1]!;
        let bindings = parseTexPayload(payload);
        if (bindings.length === 1 && bindings[0]!.name === '') {
          // LHS form: bind to the assignment on this line.
          const lhs = lhsOnLine(root, line);
          if (lhs && bindings[0]!.tex) {
            bindings = [{ name: lhs, tex: bindings[0]!.tex }];
          } else {
            diagnostics.push({
              message: bindings[0]!.tex
                ? `'# tex:' directive has no assignment on its line to bind to.`
                : `Empty '# tex:' directive.`,
              range,
              severity: 'warning',
            });
            bindings = [];
          }
        }
        directives.push({
          kind: 'tex',
          bindings,
          raw: payload,
          range,
          effectiveFromLine: line,
        });
      } else if (noteMatch) {
        directives.push({
          kind: 'tex-note',
          bindings: [],
          raw: noteMatch[1]!,
          range,
          effectiveFromLine: line,
        });
      } else {
        comments.push({ line, text: text.replace(/^#\s?/, '').trimEnd(), range });
      }
    }
    for (const child of node.children) {
      if (child) visit(child);
    }
  };
  visit(root);
  return { directives, comments };
}

// ---------------------------------------------------------------------------
// Function discovery
// ---------------------------------------------------------------------------

function extractDocstring(fnNode: TsNode): string | undefined {
  const body = fnNode.childForFieldName('body');
  const first = body?.namedChildren[0];
  if (first?.type === 'expression_statement') {
    const inner = first.namedChildren[0];
    if (inner?.type === 'string') {
      const raw = inner.text;
      // Strip quotes (''' / """ / ' / ") and any prefix like r/b/f.
      const m = /^[rRbBuUfF]*("""|'''|"|')([\s\S]*)\1$/.exec(raw);
      return (m ? m[2]! : raw).trim();
    }
  }
  return undefined;
}

function collectFunctions(root: TsNode): FunctionInfo[] {
  const out: FunctionInfo[] = [];
  const visit = (node: TsNode, prefix: string): void => {
    let nextPrefix = prefix;
    if (node.type === 'function_definition') {
      const nameNode = node.childForFieldName('name');
      const bodyNode = node.childForFieldName('body');
      const name = nameNode?.text ?? '<anonymous>';
      const qualname = prefix ? `${prefix}.${name}` : name;
      out.push({
        name,
        qualname,
        range: nodeRange(node),
        bodyRange: bodyNode ? nodeRange(bodyNode) : nodeRange(node),
        node,
        docstring: extractDocstring(node),
      });
      nextPrefix = qualname;
    } else if (node.type === 'class_definition') {
      const nameNode = node.childForFieldName('name');
      const name = nameNode?.text ?? '<anonymous>';
      nextPrefix = prefix ? `${prefix}.${name}` : name;
    }
    for (const child of node.namedChildren) {
      if (child) visit(child, nextPrefix);
    }
  };
  visit(root, '');
  return out;
}

function collectErrorDiagnostics(root: TsNode, diagnostics: ParseDiagnostic[]): void {
  if (!root.hasError) return;
  const visit = (node: TsNode): void => {
    if (node.type === 'ERROR' || node.isMissing) {
      diagnostics.push({
        message: node.isMissing ? `Missing ${node.type}` : 'Syntax error',
        range: nodeRange(node),
        severity: 'error',
      });
      return; // don't descend into error subtrees
    }
    if (node.hasError) {
      for (const child of node.children) {
        if (child) visit(child);
      }
    }
  };
  visit(root);
}

// ---------------------------------------------------------------------------
// Parse entry points
// ---------------------------------------------------------------------------

function buildResult(tree: Tree, source: string): ParseResult {
  const diagnostics: ParseDiagnostic[] = [];
  const root = tree.rootNode;
  const { directives, comments } = collectCommentsAndDirectives(root, diagnostics);
  collectErrorDiagnostics(root, diagnostics);
  return {
    ast: {
      tree,
      functions: collectFunctions(root),
      directives,
      source,
      comments,
    },
    diagnostics,
  };
}

/**
 * Parse a Python source file into the typed AST slice.
 * Error-tolerant: syntax errors become diagnostics + ERROR-subtree regions
 * that translation renders as `code` fallback blocks — never throws on bad input.
 */
export async function parsePython(source: string): Promise<ParseResult> {
  await initParser();
  const parser = new Parser();
  parser.setLanguage(requireLanguage());
  try {
    const tree = parser.parse(source);
    if (!tree) {
      return {
        ast: { tree: undefined, functions: [], directives: [], source, comments: [] },
        diagnostics: [
          {
            message: 'tree-sitter returned no tree',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            severity: 'error',
          },
        ],
      };
    }
    return buildResult(tree, source);
  } finally {
    parser.delete();
  }
}

/** A single content change, LSP-incremental-sync shaped. */
export interface SourceEdit {
  range: Range;
  newText: string;
}

/**
 * Incrementally reparse after edits, reusing the previous tree when possible
 * (tree-sitter incremental parsing, plan §4.3). May internally fall back to a
 * fresh parse; the result contract is identical either way.
 */
export async function reparsePython(
  previous: ParseResult,
  newSource: string,
  edits: readonly SourceEdit[],
): Promise<ParseResult> {
  await initParser();
  const prevTree = previous.ast.tree as Tree | undefined;
  if (!prevTree || edits.length === 0) return parsePython(newSource);
  try {
    // Apply edits to the old tree so tree-sitter can reuse unchanged subtrees.
    // Byte offsets: compute from the OLD source for start, and from lengths
    // for the new end. We track offsets against previous.ast.source.
    const oldSource = previous.ast.source;
    const lineStarts = computeLineStarts(oldSource);
    for (const edit of edits) {
      const startIndex = offsetAt(lineStarts, oldSource, edit.range.start);
      const oldEndIndex = offsetAt(lineStarts, oldSource, edit.range.end);
      const newEndIndex = startIndex + edit.newText.length;
      const newEndPoint = advancePoint(edit.range.start, edit.newText);
      prevTree.edit({
        startIndex,
        oldEndIndex,
        newEndIndex,
        startPosition: { row: edit.range.start.line, column: edit.range.start.character },
        oldEndPosition: { row: edit.range.end.line, column: edit.range.end.character },
        newEndPosition: { row: newEndPoint.line, column: newEndPoint.character },
      });
    }
    const parser = new Parser();
    parser.setLanguage(requireLanguage());
    try {
      const tree = parser.parse(newSource, prevTree);
      if (!tree) return parsePython(newSource);
      return buildResult(tree, newSource);
    } finally {
      parser.delete();
    }
  } catch {
    // Any incremental-path failure → fresh parse (never throw).
    return parsePython(newSource);
  }
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetAt(lineStarts: number[], text: string, pos: { line: number; character: number }): number {
  const lineStart = lineStarts[Math.min(pos.line, lineStarts.length - 1)] ?? text.length;
  return Math.min(lineStart + pos.character, text.length);
}

function advancePoint(
  start: { line: number; character: number },
  text: string,
): { line: number; character: number } {
  let line = start.line;
  let character = start.character;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      character = 0;
    } else {
      character++;
    }
  }
  return { line, character };
}
