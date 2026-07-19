/**
 * Lightweight regex/indentation scan for Python function definitions.
 *
 * This is NOT a parser — it exists purely as the graceful-degradation path
 * (plan principle 3) so CodeLens (F1) and hover fallbacks keep working while
 * core's tree-sitter parse is unavailable or throwing. When core parse
 * succeeds, its FunctionInfo list wins and this module is unused.
 *
 * OWNED BY AGENT B.
 */

import type { Range } from '@mathlens/core';

export interface ScannedFunction {
  name: string;
  /** Qualified name within the file, e.g. "MyClass.forward" or "outer.inner". */
  qualname: string;
  /** From the `def` line through the last non-blank line of the body. */
  range: Range;
}

const DEF_RE = /^([ \t]*)(?:async[ \t]+)?(def|class)[ \t]+([A-Za-z_]\w*)/;

interface ScopeEntry {
  indent: number;
  name: string;
}

export function scanPythonFunctions(text: string): ScannedFunction[] {
  const lines = text.split(/\r?\n/);
  const stack: ScopeEntry[] = [];
  const found: Array<{ name: string; qualname: string; startLine: number; indent: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const m = DEF_RE.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '        ').length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const qualname = [...stack.map((s) => s.name), m[3]].join('.');
    if (m[2] === 'def') {
      found.push({ name: m[3], qualname, startLine: i, indent });
    }
    stack.push({ indent, name: m[3] });
  }

  return found.map((f) => {
    // End: line before the next non-blank line indented at or below the def.
    let endLine = f.startLine;
    for (let i = f.startLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().length === 0) continue;
      const indent = (/^[ \t]*/.exec(line)?.[0] ?? '').replace(/\t/g, '        ').length;
      if (indent <= f.indent) break;
      endLine = i;
    }
    return {
      name: f.name,
      qualname: f.qualname,
      range: {
        start: { line: f.startLine, character: 0 },
        end: { line: endLine, character: lines[endLine]?.length ?? 0 },
      },
    };
  });
}
