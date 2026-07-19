import { describe, expect, it } from 'vitest';
import { emitEquation, emitLatex, emitNode, emitSignatureLine } from '../src/emit/index.js';
import type { Annotation, Equation, MathDocument, MathNode, SymNode } from '../src/ir/types.js';

const r0 = { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } };

function sym(tex: string, pythonName = tex): SymNode {
  return { kind: 'sym', pythonName, tex, occurrenceId: 'eq#0' as SymNode['occurrenceId'], sourceRange: r0 };
}

function eq(id: string, lhs: MathNode | undefined, rhs: MathNode, annotations: Annotation[] = []): Equation {
  return { id: id as Equation['id'], lhs, rhs, relation: '=', sourceRange: r0, annotations };
}

describe('emitNode', () => {
  it('scientific literals: 1e-5 → 10^{-5}', () => {
    expect(emitNode({ kind: 'num', text: '1e-5', sourceRange: r0 })).toBe('10^{-5}');
    expect(emitNode({ kind: 'num', text: '2.5e3', sourceRange: r0 })).toBe('2.5 \\times 10^{3}');
  });

  it('raw code nodes are \\texttt-escaped; math raws verbatim', () => {
    expect(emitNode({ kind: 'raw', text: 'x_y#', sourceRange: r0 })).toBe('\\texttt{x\\_y\\#}');
    expect(emitNode({ kind: 'raw', text: '\\mathbf{0}', math: true, sourceRange: r0 })).toBe('\\mathbf{0}');
  });

  it('nested frac/pow parenthesization', () => {
    const add: MathNode = { kind: 'binop', op: '+', left: sym('a'), right: sym('b'), sourceRange: r0 };
    expect(emitNode({ kind: 'pow', base: add, exponent: sym('n'), sourceRange: r0 })).toBe(
      '\\left( a + b \\right)^{n}',
    );
    expect(emitNode({ kind: 'transpose', operand: add, sourceRange: r0 })).toBe('\\left( a + b \\right)^{\\top}');
  });

  it('matmul factors that are sums get parens', () => {
    const add: MathNode = { kind: 'binop', op: '+', left: sym('a'), right: sym('b'), sourceRange: r0 };
    expect(emitNode({ kind: 'matmul', factors: [sym('W'), add], sourceRange: r0 })).toBe(
      'W \\left( a + b \\right)',
    );
  });

  it('a - (b - c) keeps parens', () => {
    const inner: MathNode = { kind: 'binop', op: '-', left: sym('b'), right: sym('c'), sourceRange: r0 };
    expect(emitNode({ kind: 'binop', op: '-', left: sym('a'), right: inner, sourceRange: r0 })).toBe(
      'a - \\left( b - c \\right)',
    );
  });
});

describe('annotation rendering (§4.2 — no origin branching)', () => {
  it('renders shape underbrace-style suffix identically for static and runtime', () => {
    const mk = (origin: 'static' | 'runtime') =>
      emitEquation(
        eq('e1', sym('h'), sym('x'), [
          { target: 'e1' as Annotation['target'], kind: 'shape', origin, payload: { dims: ['B', 'T', 128] } },
        ]),
      );
    expect(mk('static')).toBe(mk('runtime'));
    expect(mk('static')).toContain('(B \\times T \\times 128)');
  });

  it('renders note badges', () => {
    const tex = emitEquation(
      eq('e1', sym('y'), sym('x'), [
        { target: 'e1' as Annotation['target'], kind: 'note', origin: 'static', payload: { text: 'careful' } },
      ]),
    );
    expect(tex).toContain('careful');
  });
});

describe('emitSignatureLine', () => {
  it('renders given W ∈ ℝ^{d×k}', () => {
    const tex = emitSignatureLine({
      params: [
        { pythonName: 'W', tex: 'W', dims: ['d', 'k'], dtype: 'float', sourceRange: r0 },
        { pythonName: 'x', tex: 'x', dims: ['d'], sourceRange: r0 },
        { pythonName: 'n', tex: 'n', typeText: 'int', sourceRange: r0 },
      ],
      sourceRange: r0,
    });
    expect(tex).toContain('\\text{given }');
    expect(tex).toContain('W \\in \\mathbb{R}^{d \\times k}');
    expect(tex).toContain('x \\in \\mathbb{R}^{d}');
    expect(tex).toContain('n : \\texttt{int}');
  });
});

function docWith(equations: Equation[]): MathDocument {
  return {
    uri: 'file:///t.py',
    version: 1,
    sections: [
      {
        id: 's1' as Equation['id'],
        kind: 'function',
        title: 'f',
        qualname: 'f',
        blocks: [{ kind: 'align', equations }],
        sourceRange: r0,
      },
    ],
  };
}

describe('emitLatex', () => {
  const doc = docWith([eq('e1', sym('y'), sym('x')), eq('e2', sym('z'), sym('y'))]);

  it('derivation standalone document has preamble + document env', () => {
    const { tex } = emitLatex(doc, { profile: 'derivation' });
    expect(tex).toContain('\\documentclass{article}');
    expect(tex).toContain('\\usepackage{amsmath}');
    expect(tex).toContain('\\begin{document}');
    expect(tex).toContain('\\end{document}');
    expect(tex).toContain('\\begin{align*}');
  });

  it('fragment mode omits the wrapper', () => {
    const { tex } = emitLatex(doc, { profile: 'derivation', standalone: false });
    expect(tex).not.toContain('\\documentclass');
    expect(tex).toContain('\\begin{align*}');
  });

  it('numbered mode emits \\hypertarget anchors + tags and assigns eq.number', () => {
    const d = docWith([eq('e1', sym('y'), sym('x')), eq('e2', sym('z'), sym('y'))]);
    const { tex } = emitLatex(d, { profile: 'derivation', numbered: true });
    expect(tex).toContain('\\hypertarget{');
    expect(tex).toContain('\\tag{1}');
    expect(tex).toContain('\\tag{2}');
    expect(d.sections[0]!.blocks[0]!.kind === 'align' && d.sections[0]!.blocks[0]!.equations[0]!.number).toBe('(1)');
  });

  it('source map covers every equation with valid tex line spans', () => {
    const { tex, sourceMap } = emitLatex(doc, { profile: 'derivation' });
    const lineCount = tex.split('\n').length;
    expect(sourceMap.map((e) => String(e.equationId)).sort()).toEqual(['e1', 'e2']);
    for (const entry of sourceMap) {
      expect(entry.texStartLine).toBeGreaterThanOrEqual(0);
      expect(entry.texEndLine).toBeGreaterThan(entry.texStartLine);
      expect(entry.texEndLine).toBeLessThanOrEqual(lineCount);
    }
  });

  it('literate profile emits longtable rows with source line refs', () => {
    const { tex, sourceMap } = emitLatex(doc, { profile: 'literate' });
    expect(tex).toContain('\\begin{longtable}');
    expect(tex).toContain('L1');
    expect(sourceMap).toHaveLength(2);
  });

  it('lemma numbering: main section is 1, first lemma is "Lemma 2" (plan §7 F4)', () => {
    const r = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    const section = (id: string, kind: 'function' | 'lemma', title: string) => ({
      id,
      kind,
      title,
      blocks: [],
      sourceRange: r,
    });
    const d: MathDocument = {
      uri: 'file:///t.py',
      version: 1,
      sections: [
        section('m', 'function', 'train_step'),
        section('l1', 'lemma', 'attention'),
        section('l2', 'lemma', 'softmax'),
      ],
    };
    const { tex } = emitLatex(d, { profile: 'derivation', standalone: false });
    expect(tex).toContain('\\subsection*{Lemma 2: attention}');
    expect(tex).toContain('\\subsection*{Lemma 3: softmax}');
    expect(tex).not.toContain('Lemma 1');
    expect(tex).not.toContain('Lemma 4');
  });

  it('user preamble is injected before \\begin{document}', () => {
    const { tex } = emitLatex(doc, {
      profile: 'derivation',
      userPreamble: '\\newcommand{\\attn}{\\tilde{A}}',
    });
    const pIdx = tex.indexOf('\\newcommand{\\attn}');
    const dIdx = tex.indexOf('\\begin{document}');
    expect(pIdx).toBeGreaterThan(-1);
    expect(pIdx).toBeLessThan(dIdx);
  });
});
