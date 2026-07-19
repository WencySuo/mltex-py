/**
 * F0 — hover: statement → rendered equation as theme-aware data-URI SVG
 * (plan §7 F0, the LaTeX Workshop technique).
 *
 * Degradation ladder (never empty, never an error toast — plan principle 3):
 *  1. MathIR equation → emitEquation → MathJax SVG data-URI markdown.
 *  2. MathJax failed → LaTeX source in a ```latex code block.
 *  3. emit/translate/core failed → raw statement text in a ```python block.
 *  4. Position outside any statement → null (normal LSP "no hover").
 *
 * OWNED BY AGENT B.
 */

import {
  MarkupKind,
  type Connection,
  type Hover,
  type HoverParams,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { Equation, Range } from '@mathlens/core';
import type { DocumentState, MathLensDocuments } from './documents.js';
import { findEquationAtLine, rangeContainsPosition } from './documents.js';
import { defaultCore, type CoreBridge } from './core.js';
import { texToSvg, DEFAULT_MATH_COLOR } from './render/mathjax.js';

export interface HoverOptions {
  core?: CoreBridge;
}

export function registerHover(
  connection: Connection,
  documents: MathLensDocuments,
  options: HoverOptions = {},
): void {
  const core = options.core ?? defaultCore;

  connection.onHover(async (params: HoverParams): Promise<Hover | null> => {
    try {
      const doc = documents.get(params.textDocument.uri);
      if (!doc) return null;
      const state = await documents.getState(params.textDocument.uri);
      return await buildHover(core, documents, doc, state, params.position.line);
    } catch {
      // Absolute last resort: no hover rather than an error surface.
      return null;
    }
  });
}

/** Exposed for protocol tests. */
export async function buildHover(
  core: CoreBridge,
  documents: MathLensDocuments,
  doc: TextDocument,
  state: DocumentState | undefined,
  line: number,
): Promise<Hover | null> {
  // 1./2. MathIR path.
  const hit = state?.math ? findEquationAtLine(state.math, line) : undefined;
  if (hit) {
    const hover = await equationHover(core, documents, state!, hit.equation);
    if (hover) return hover;
    // fall through to raw-statement fallback on total failure
  }

  // 3. Raw statement text fallback (core degraded, or emit+render both failed).
  const range = hit?.equation.sourceRange ?? statementRangeAtLine(doc, state, line);
  if (!range) return null;
  const text = doc
    .getText({ start: range.start, end: range.end })
    .trim();
  if (text.length === 0) return null;
  return {
    contents: { kind: MarkupKind.Markdown, value: `\`\`\`python\n${text}\n\`\`\`` },
    range,
  };
}

async function equationHover(
  core: CoreBridge,
  documents: MathLensDocuments,
  state: DocumentState,
  equation: Equation,
): Promise<Hover | null> {
  // Emit LaTeX for the whole statement.
  let tex: string | undefined;
  try {
    tex = core.emitEquation(equation);
  } catch {
    return null; // emit unavailable → caller's raw-statement fallback
  }
  if (!tex || tex.trim().length === 0) return null;

  const parts: string[] = [];

  // Render via MathJax; on failure show the LaTeX source instead (F0 spec).
  try {
    const { dataUri } = await texToSvg(tex, {
      preamble: documents.getUserPreamble(),
      display: true,
      scale: documents.getConfig().effective.settings.renderDisplayScale,
      color: DEFAULT_MATH_COLOR,
    });
    parts.push(`![equation](${dataUri})`);
  } catch {
    parts.push(`\`\`\`latex\n${tex}\n\`\`\``);
  }

  // Symbol binding line when a directive/mapping named the LHS (plan §7 F0).
  const binding = lhsBinding(state, equation);
  if (binding) parts.push(binding);

  return {
    contents: { kind: MarkupKind.Markdown, value: parts.join('\n\n') },
    range: equation.sourceRange,
  };
}

/** "`attn` ≔ `\tilde{A}` (directive)" when naming resolved via directive/mapping. */
function lhsBinding(state: DocumentState, equation: Equation): string | undefined {
  const lhs = equation.lhs;
  if (!lhs || lhs.kind !== 'sym' || !state.naming) return undefined;
  try {
    const resolved = state.naming.resolve(lhs.pythonName, equation.sourceRange.start.line);
    if (resolved.source === 'directive' || resolved.source === 'mapping') {
      return `\`${resolved.pythonName}\` → \`${resolved.tex}\` _(${resolved.source})_`;
    }
  } catch {
    // naming unimplemented — skip the binding line
  }
  return undefined;
}

/**
 * Best-effort statement range when MathIR is unavailable: the hovered line
 * plus trailing continuation lines (open brackets / backslash), trimmed.
 * Only inside a known function body (scan fallback) to avoid hovering noise
 * on imports and module top-level.
 */
function statementRangeAtLine(
  doc: TextDocument,
  state: DocumentState | undefined,
  line: number,
): Range | undefined {
  const functions = state?.scannedFunctions ?? [];
  const within = functions.some((f) => rangeContainsPosition(f.range, line));
  if (!within) return undefined;

  const text = doc.getText();
  const lines = text.split(/\r?\n/);
  if (line >= lines.length) return undefined;
  if (lines[line].trim().length === 0) return undefined;

  let end = line;
  let depth = bracketDelta(lines[line]);
  while (end < lines.length - 1 && (depth > 0 || lines[end].trimEnd().endsWith('\\'))) {
    end++;
    depth += bracketDelta(lines[end]);
  }
  return {
    start: { line, character: 0 },
    end: { line: end, character: lines[end]?.length ?? 0 },
  };
}

function bracketDelta(line: string): number {
  let delta = 0;
  let inString: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = undefined;
      continue;
    }
    if (c === '#') break;
    if (c === '"' || c === "'") inString = c;
    else if (c === '(' || c === '[' || c === '{') delta++;
    else if (c === ')' || c === ']' || c === '}') delta--;
  }
  return delta;
}
