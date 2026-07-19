/**
 * TeX compile-log parsing (plan §7 F5.3) — pure logic, unit-tested.
 *
 * Extracts the first error and its .tex line number from tectonic/latexmk
 * output, then maps that line to the offending Equation via the emitLatex
 * source map (we generated the .tex, so no SyncTeX needed).
 */

import type { EmitSourceMapEntry } from '@mathlens/core';

export interface TexLogError {
  message: string;
  /** Zero-based line in the emitted .tex, when the log names one. */
  texLine?: number;
}

/**
 * Parse a TeX engine log/stderr for the first error. Handles the classic
 * `! message` + `l.<n> …` pair and tectonic's `error: ` lines (with optional
 * `file.tex:<line>:` prefixes).
 */
export function parseTexLog(log: string): TexLogError | undefined {
  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // tectonic: "error: something.tex:12: Undefined control sequence"
    const tectonic = line.match(/^error:\s*(?:[^\s:]+\.tex:(\d+):)?\s*(.+)$/i);
    if (tectonic) {
      const texLine = tectonic[1] ? Number(tectonic[1]) - 1 : findFollowingLineNumber(lines, i);
      return { message: tectonic[2]!.trim(), texLine };
    }

    // Classic TeX: "! Undefined control sequence." followed by "l.42 ..."
    if (line.startsWith('!')) {
      const message = line.slice(1).trim();
      const texLine = findFollowingLineNumber(lines, i);
      return { message, texLine };
    }
  }
  return undefined;
}

function findFollowingLineNumber(lines: string[], from: number): number | undefined {
  for (let j = from; j < Math.min(lines.length, from + 15); j++) {
    const m = lines[j]!.match(/^l\.(\d+)/);
    if (m) return Number(m[1]) - 1;
    const m2 = lines[j]!.match(/\.tex:(\d+)/);
    if (m2) return Number(m2[1]) - 1;
  }
  return undefined;
}

/**
 * Map a zero-based .tex line to the Equation whose emitted span contains it
 * (spans are [texStartLine, texEndLine), end-exclusive).
 */
export function equationForTexLine(
  sourceMap: readonly EmitSourceMapEntry[],
  texLine: number,
): EmitSourceMapEntry | undefined {
  let best: EmitSourceMapEntry | undefined;
  for (const entry of sourceMap) {
    if (texLine >= entry.texStartLine && texLine < entry.texEndLine) {
      if (!best || entry.texEndLine - entry.texStartLine < best.texEndLine - best.texStartLine) {
        best = entry;
      }
    }
  }
  return best;
}
