/**
 * Type-level contract lock: constructs a small but representative
 * MathDocument literal. If the MathIR shapes change incompatibly, this file
 * stops compiling — which is the point. Keep it in sync with CONTRACTS.md.
 */
import { describe, expect, it } from 'vitest';
import {
  collectAnnotations,
  computeStableId,
  computeSymbolOccurrenceId,
  StaticNoteProvider,
  type Annotation,
  type Equation,
  type MathDocument,
  type MathNode,
  type Range,
  type Section,
} from '../src/index.js';

const r = (line: number, startChar: number, endChar: number): Range => ({
  start: { line, character: startChar },
  end: { line, character: endChar },
});

describe('MathIR contract', () => {
  // alpha_hat = Q @ K.T / math.sqrt(d)   (the F0 acceptance statement)
  const eqId = computeStableId({
    qualname: 'attention',
    role: 'assign',
    lhsSymbol: 'alpha_hat',
    ordinal: 0,
  });

  const lhs: MathNode = {
    kind: 'sym',
    pythonName: 'alpha_hat',
    tex: '\\hat{\\alpha}',
    occurrenceId: computeSymbolOccurrenceId(eqId, 0),
    sourceRange: r(1, 4, 13),
  };

  const rhs: MathNode = {
    kind: 'frac',
    numerator: {
      kind: 'matmul',
      factors: [
        {
          kind: 'sym',
          pythonName: 'Q',
          tex: 'Q',
          occurrenceId: computeSymbolOccurrenceId(eqId, 1),
          sourceRange: r(1, 16, 17),
        },
        {
          kind: 'transpose',
          operand: {
            kind: 'sym',
            pythonName: 'K',
            tex: 'K',
            occurrenceId: computeSymbolOccurrenceId(eqId, 2),
            sourceRange: r(1, 20, 21),
          },
          sourceRange: r(1, 20, 23),
        },
      ],
      sourceRange: r(1, 16, 23),
    },
    denominator: {
      kind: 'sqrt',
      radicand: {
        kind: 'sym',
        pythonName: 'd',
        tex: 'd',
        occurrenceId: computeSymbolOccurrenceId(eqId, 3),
        sourceRange: r(1, 36, 37),
      },
      sourceRange: r(1, 26, 38),
    },
    sourceRange: r(1, 16, 38),
  };

  const equation: Equation = {
    id: eqId,
    lhs,
    rhs,
    relation: '=',
    sourceRange: r(1, 4, 38),
    annotations: [],
  };

  const sectionId = computeStableId({
    qualname: 'attention',
    role: 'section',
    lhsSymbol: '',
    ordinal: 0,
  });

  const section: Section = {
    id: sectionId,
    kind: 'function',
    title: 'attention',
    qualname: 'attention',
    signature: {
      params: [
        {
          pythonName: 'Q',
          tex: 'Q',
          dims: ['n', 'd'],
          dtype: 'float32',
          sourceRange: r(0, 14, 15),
        },
        { pythonName: 'K', tex: 'K', dims: ['n', 'd'], sourceRange: r(0, 17, 18) },
        { pythonName: 'd', tex: 'd', sourceRange: r(0, 20, 21) },
      ],
      sourceRange: r(0, 0, 22),
    },
    prose: 'Scaled dot-product attention scores.',
    blocks: [
      { kind: 'align', equations: [equation] },
      {
        kind: 'loop',
        header: {
          kind: 'for',
          index: {
            kind: 'sym',
            pythonName: 't',
            tex: 't',
            occurrenceId: computeSymbolOccurrenceId(eqId, 4),
            sourceRange: r(3, 8, 9),
          },
          lower: { kind: 'num', text: '1', sourceRange: r(3, 19, 20) },
          upper: { kind: 'num', text: 'T', sourceRange: r(3, 22, 23) },
          sourceRange: r(3, 4, 24),
        },
        body: [{ kind: 'code', text: 'log.info(t)', sourceRange: r(4, 8, 19), reason: 'side-effect call' }],
        sourceRange: r(3, 4, 24),
      },
      { kind: 'prose', text: 'within loop over t' },
    ],
    sourceRange: r(0, 0, 40),
  };

  const doc: MathDocument = {
    uri: 'file:///example/attention.py',
    version: 3,
    sections: [section],
  };

  it('constructs and round-trips through JSON (wire format for panel init)', () => {
    const wire = JSON.parse(JSON.stringify(doc)) as MathDocument;
    expect(wire.sections[0]!.blocks[0]!.kind).toBe('align');
    expect(wire.sections[0]!.title).toBe('attention');
  });

  it('every symbol occurrence is addressable and every node has a sourceRange', () => {
    const syms: string[] = [];
    const walk = (n: MathNode): void => {
      expect(n.sourceRange).toBeDefined();
      if (n.kind === 'sym') syms.push(n.occurrenceId);
      if (n.kind === 'frac') [n.numerator, n.denominator].forEach(walk);
      if (n.kind === 'matmul') n.factors.forEach(walk);
      if (n.kind === 'transpose' || n.kind === 'inverse') walk(n.operand);
      if (n.kind === 'sqrt') walk(n.radicand);
    };
    walk(lhs);
    walk(rhs);
    expect(new Set(syms).size).toBe(4);
  });

  it('StaticNoteProvider produces annotations against the doc', async () => {
    const provider = new StaticNoteProvider([
      { target: eqId, payload: { text: 'masked before softmax', severity: 'info' } },
    ]);
    const anns: Annotation[] = await collectAnnotations(doc, [provider]);
    expect(anns).toHaveLength(1);
    expect(anns[0]).toMatchObject({ target: eqId, kind: 'note', origin: 'static' });
  });
});
