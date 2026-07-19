import { describe, expect, it } from 'vitest';
import type { Annotation, Equation, LoopHeader, MathNode, Range, SignatureLine } from '@mathlens/core';
import {
  buildAnnotationIndex,
  casesTex,
  equationTex,
  loopHeaderTex,
  nodeTex,
  signatureTex,
} from '../src/texEmitter.js';

const r: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } };

function sym(tex: string, occ = 'e#0'): MathNode {
  return { kind: 'sym', pythonName: tex, tex, occurrenceId: occ, sourceRange: r };
}
function num(text: string): MathNode {
  return { kind: 'num', text, sourceRange: r };
}

describe('nodeTex', () => {
  it('renders frac / matmul / transpose / sqrt (attention shape)', () => {
    const node: MathNode = {
      kind: 'frac',
      numerator: {
        kind: 'matmul',
        factors: [sym('Q'), { kind: 'transpose', operand: sym('K'), sourceRange: r }],
        sourceRange: r,
      },
      denominator: { kind: 'sqrt', radicand: sym('d'), sourceRange: r },
      sourceRange: r,
    };
    expect(nodeTex(node)).toBe('\\frac{Q K^{\\top}}{\\sqrt{d}}');
  });

  it('renders reductions with bounds and domains', () => {
    const sum: MathNode = {
      kind: 'reduction',
      op: 'sum',
      index: sym('i'),
      lower: num('1'),
      upper: sym('N'),
      body: sym('x'),
      sourceRange: r,
    };
    expect(nodeTex(sum)).toBe('\\sum_{i=1}^{N} x');
    const dom: MathNode = {
      kind: 'reduction',
      op: 'max',
      index: sym('i'),
      domain: sym('S'),
      body: sym('x'),
      sourceRange: r,
    };
    expect(nodeTex(dom)).toBe('\\max_{i \\in S} x');
  });

  it('renders subscripts with slices', () => {
    const node: MathNode = {
      kind: 'subscript',
      base: sym('x'),
      indices: [{ kind: 'slice', sourceRange: r }, sym('j')],
      sourceRange: r,
    };
    expect(nodeTex(node)).toBe('x_{:, j}');
  });

  it('escapes raw fallback text for texttt', () => {
    const node: MathNode = { kind: 'raw', text: 'x.to(device)_%$', sourceRange: r };
    expect(nodeTex(node)).toBe('\\texttt{x.to(device)\\_\\%\\$}');
  });

  it('emits raw math fragments verbatim (RawNode.math, core-emit parity)', () => {
    const node: MathNode = { kind: 'raw', text: '\\mathbf{0}', math: true, sourceRange: r };
    expect(nodeTex(node)).toBe('\\mathbf{0}');
  });

  it("renders the reserved '<cases>' call op as an inline cases env (core-emit parity)", () => {
    const node: MathNode = {
      kind: 'call',
      op: '<cases>',
      tex: '',
      display: 'juxtapose',
      args: [
        sym('a'),
        { kind: 'compare', first: sym('x'), rest: [{ op: 'gt', operand: num('0') }], sourceRange: r },
        sym('b'),
      ],
      sourceRange: r,
    };
    expect(nodeTex(node)).toBe(
      '\\begin{cases} a & x > 0 \\\\ b & \\text{otherwise} \\end{cases}',
    );
  });

  it('renders shape annotations on symbol occurrences as underbraces, ignoring origin', () => {
    const annotations: Annotation[] = [
      { target: 'eq1#1', kind: 'shape', origin: 'runtime', payload: { dims: ['d', 'k'] } },
    ];
    const idx = buildAnnotationIndex(annotations);
    expect(nodeTex(sym('W', 'eq1#1'), idx)).toBe('\\underbrace{W}_{d \\times k}');
    // static origin renders identically (plan §4.2 rule).
    const staticIdx = buildAnnotationIndex([{ ...annotations[0]!, origin: 'static' }]);
    expect(nodeTex(sym('W', 'eq1#1'), staticIdx)).toBe('\\underbrace{W}_{d \\times k}');
  });
});

describe('equationTex', () => {
  const eq: Equation = {
    id: 'e1',
    lhs: sym('y', 'e1#0'),
    rhs: sym('x', 'e1#1'),
    relation: '\\leftarrow',
    sourceRange: r,
    annotations: [],
  };

  it('renders lhs relation rhs', () => {
    expect(equationTex(eq)).toBe('y \\leftarrow x');
  });

  it('prefers the additive server-emitted tex field when present', () => {
    expect(equationTex({ ...eq, tex: '\\hat{y} = f(x)' })).toBe('\\hat{y} = f(x)');
  });

  it('renders bare expressions without lhs', () => {
    expect(equationTex({ ...eq, lhs: undefined, relation: '=' })).toBe('x');
  });

  it('renders the trailing qualifier (recurrence range, core-emit parity)', () => {
    const qualifier: MathNode = {
      kind: 'compare',
      first: sym('t', 'e1#2'),
      rest: [{ op: 'eq', operand: sym('T', 'e1#3') }],
      sourceRange: r,
    };
    expect(equationTex({ ...eq, relation: '=', qualifier })).toBe('y = x, \\quad t = T');
  });
});

describe('cases / loop / signature', () => {
  it('renders piecewise cases with otherwise', () => {
    const subject: Equation = {
      id: 'c1',
      lhs: sym('y', 'c1#0'),
      rhs: { kind: 'raw', text: '', sourceRange: r },
      relation: '=',
      sourceRange: r,
      annotations: [],
    };
    const tex = casesTex(subject, [
      { value: sym('a'), guard: { kind: 'compare', first: sym('x'), rest: [{ op: 'gt', operand: num('0') }], sourceRange: r }, sourceRange: r },
      { value: sym('b'), sourceRange: r },
    ]);
    expect(tex).toBe('y = \\begin{cases} a & x > 0 \\\\ b & \\text{otherwise} \\end{cases}');
  });

  it('renders for-loop headers with bounds', () => {
    const header: LoopHeader = {
      kind: 'for',
      index: sym('t'),
      lower: num('1'),
      upper: sym('T'),
      sourceRange: r,
    };
    expect(loopHeaderTex(header)).toBe('\\text{for } t = 1, \\dots, T:');
  });

  it('renders if/elif/else and unknown headers like core emit', () => {
    const cond: MathNode = {
      kind: 'compare',
      first: sym('x'),
      rest: [{ op: 'gt', operand: num('0') }],
      sourceRange: r,
    };
    expect(loopHeaderTex({ kind: 'if', condition: cond, sourceRange: r })).toBe('\\text{if } x > 0:');
    expect(loopHeaderTex({ kind: 'elif', condition: cond, sourceRange: r })).toBe('\\text{else if } x > 0:');
    expect(loopHeaderTex({ kind: 'else', sourceRange: r })).toBe('\\text{else:}');
    expect(loopHeaderTex({ kind: 'block', sourceRange: r })).toBe('\\text{block:}');
    // Unknown kinds render like 'block' per CONTRACTS.md.
    expect(loopHeaderTex({ kind: 'unknown' as LoopHeader['kind'], sourceRange: r })).toBe('\\text{block:}');
  });

  it('renders while headers', () => {
    const header: LoopHeader = {
      kind: 'while',
      condition: { kind: 'norm', operand: sym('g'), sourceRange: r },
      sourceRange: r,
    };
    expect(loopHeaderTex(header)).toBe('\\text{while } \\lVert g \\rVert:');
  });

  it('renders "given" signature lines with shape dims', () => {
    const sig: SignatureLine = {
      params: [
        { pythonName: 'W', tex: 'W', dims: ['d', 'k'], sourceRange: r },
        { pythonName: 'x', tex: 'x', dims: ['d'], sourceRange: r },
        { pythonName: 'lr', tex: '\\eta', sourceRange: r },
      ],
      sourceRange: r,
    };
    expect(signatureTex(sig)).toBe(
      '\\text{given } W \\in \\mathbb{R}^{d \\times k},\\; x \\in \\mathbb{R}^{d},\\; \\eta',
    );
  });
});
