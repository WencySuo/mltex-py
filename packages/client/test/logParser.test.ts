import { describe, expect, it } from 'vitest';
import type { EmitSourceMapEntry } from '@mathlens/core';
import { equationForTexLine, parseTexLog } from '../src/pdf/logParser.js';

describe('parseTexLog', () => {
  it('parses classic TeX errors with l.<n> line info', () => {
    const log = [
      'This is pdfTeX, Version 3.141592653',
      '! Undefined control sequence.',
      'l.42 \\badmacro',
      '           {x}',
    ].join('\n');
    expect(parseTexLog(log)).toEqual({ message: 'Undefined control sequence.', texLine: 41 });
  });

  it('parses tectonic error lines with file:line prefixes', () => {
    const log = 'error: mathlens.tex:12: Undefined control sequence';
    expect(parseTexLog(log)).toEqual({ message: 'Undefined control sequence', texLine: 11 });
  });

  it('parses tectonic errors without line info', () => {
    const log = 'error: something went wrong overall';
    expect(parseTexLog(log)).toEqual({ message: 'something went wrong overall', texLine: undefined });
  });

  it('returns undefined for clean logs', () => {
    expect(parseTexLog('Output written on mathlens.pdf (2 pages).')).toBeUndefined();
  });
});

describe('equationForTexLine (compile error → offending equation, F5.3)', () => {
  const sourceMap: EmitSourceMapEntry[] = [
    { equationId: 'eq-a', texStartLine: 10, texEndLine: 14 },
    { equationId: 'eq-b', texStartLine: 14, texEndLine: 20 },
    // nested/tighter span wins
    { equationId: 'eq-b-inner', texStartLine: 15, texEndLine: 16 },
  ];

  it('maps a tex line to the containing equation span (end-exclusive)', () => {
    expect(equationForTexLine(sourceMap, 10)?.equationId).toBe('eq-a');
    expect(equationForTexLine(sourceMap, 13)?.equationId).toBe('eq-a');
    expect(equationForTexLine(sourceMap, 14)?.equationId).toBe('eq-b');
  });

  it('prefers the tightest span when spans nest', () => {
    expect(equationForTexLine(sourceMap, 15)?.equationId).toBe('eq-b-inner');
  });

  it('returns undefined outside all spans', () => {
    expect(equationForTexLine(sourceMap, 5)).toBeUndefined();
    expect(equationForTexLine(sourceMap, 20)).toBeUndefined();
  });
});
