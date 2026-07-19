/**
 * Unit tests for the MathIR differ behind `mathlens/mathUpdated` (plan §3.4,
 * §4.3) — pure logic over synthetic MathIR versions, no core needed.
 */

import { describe, expect, it } from 'vitest';
import type { Annotation, Equation, MathDocument, Section } from '@mathlens/core';
import { computeStableId } from '@mathlens/core';
import { collectEquations, deepEqual, diffMathDocuments, isEmptyPatch } from '../src/patch.js';

function eq(id: string, rhsText: string, line = 0): Equation {
  const range = { start: { line, character: 0 }, end: { line, character: rhsText.length } };
  return {
    id: id as Equation['id'],
    rhs: { kind: 'raw', text: rhsText, sourceRange: range },
    relation: '=',
    sourceRange: range,
    annotations: [],
  };
}

function section(id: string, equations: Equation[], title = 'f'): Section {
  return {
    id: id as Section['id'],
    kind: 'function',
    title,
    qualname: title,
    blocks: [{ kind: 'align', equations }],
    sourceRange: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
  };
}

function doc(version: number, sections: Section[]): MathDocument {
  return { uri: 'file:///t.py', version, sections };
}

describe('deepEqual', () => {
  it('treats undefined-valued keys as absent', () => {
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, [2]], [1, [2]])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
});

describe('diffMathDocuments', () => {
  it('reports everything as added when previous is undefined', () => {
    const next = doc(1, [section('s1', [eq('e1', 'x + 1')])]);
    const patch = diffMathDocuments(undefined, next);
    expect(patch.addedSections.map((s) => s.id)).toEqual(['s1']);
    expect(patch.updatedSections).toEqual([]);
    expect(patch.removedSections).toEqual([]);
    expect(patch.updatedEquations).toEqual([]);
  });

  it('produces an empty patch for identical documents', () => {
    const a = doc(1, [section('s1', [eq('e1', 'x + 1'), eq('e2', 'y')])]);
    const b = doc(2, [section('s1', [eq('e1', 'x + 1'), eq('e2', 'y')])]);
    const patch = diffMathDocuments(a, b);
    expect(isEmptyPatch(patch)).toBe(true);
  });

  it('emits equation-level patches when only one equation body changed', () => {
    const before = doc(1, [section('s1', [eq('e1', 'x + 1', 1), eq('e2', 'y * 2', 2)])]);
    const after = doc(2, [section('s1', [eq('e1', 'x + 1', 1), eq('e2', 'y * 3', 2)])]);
    const patch = diffMathDocuments(before, after);
    expect(patch.updatedSections).toEqual([]);
    expect(patch.updatedEquations).toHaveLength(1);
    expect(patch.updatedEquations[0].sectionId).toBe('s1');
    expect(patch.updatedEquations[0].equation.id).toBe('e2');
    expect((patch.updatedEquations[0].equation.rhs as { text: string }).text).toBe('y * 3');
  });

  it('replaces the whole section when the equation id sequence changes', () => {
    const before = doc(1, [section('s1', [eq('e1', 'a')])]);
    const after = doc(2, [section('s1', [eq('e1', 'a'), eq('e3', 'b')])]);
    const patch = diffMathDocuments(before, after);
    expect(patch.updatedEquations).toEqual([]);
    expect(patch.updatedSections.map((s) => s.id)).toEqual(['s1']);
  });

  it('reports added and removed sections by id', () => {
    const before = doc(1, [section('s1', [eq('e1', 'a')]), section('s2', [eq('e2', 'b')])]);
    const after = doc(2, [section('s1', [eq('e1', 'a')]), section('s3', [eq('e3', 'c')])]);
    const patch = diffMathDocuments(before, after);
    expect(patch.addedSections.map((s) => s.id)).toEqual(['s3']);
    expect(patch.removedSections).toEqual(['s2']);
    expect(patch.updatedSections).toEqual([]);
  });

  it('carries a full annotation refresh only when annotations changed', () => {
    const a = doc(1, [section('s1', [eq('e1', 'a')])]);
    const b = doc(2, [section('s1', [eq('e1', 'a')])]);
    const ann: Annotation = {
      target: 'e1' as Annotation['target'],
      kind: 'shape',
      origin: 'static',
      payload: { dims: ['d', 'k'] },
    };
    const unchanged = diffMathDocuments(a, b, { previous: [ann], next: [ann] });
    expect(unchanged.annotations).toBeUndefined();
    const changed = diffMathDocuments(a, b, { previous: [], next: [ann] });
    expect(changed.annotations).toEqual([ann]);
    expect(isEmptyPatch(changed)).toBe(false);
  });

  it('walks loop bodies and cases subjects when collecting equations', () => {
    const inner = eq('e-loop', 'h + x', 3);
    const subject = eq('e-case', 'y', 5);
    const s: Section = {
      ...section('s1', []),
      blocks: [
        {
          kind: 'loop',
          header: {
            kind: 'for',
            sourceRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
          },
          body: [{ kind: 'align', equations: [inner] }],
          sourceRange: { start: { line: 2, character: 0 }, end: { line: 4, character: 0 } },
        },
        {
          kind: 'cases',
          subject,
          branches: [],
          sourceRange: { start: { line: 5, character: 0 }, end: { line: 7, character: 0 } },
        },
      ],
    };
    expect(collectEquations(s).map((e) => e.id)).toEqual(['e-loop', 'e-case']);

    // and the differ patches an equation nested in a loop
    const s2: Section = structuredClone(s);
    const loopBlock = s2.blocks[0] as Extract<Section['blocks'][number], { kind: 'loop' }>;
    (loopBlock.body[0] as { kind: 'align'; equations: Equation[] }).equations[0] = eq(
      'e-loop',
      'h + 2 * x',
      3,
    );
    const patch = diffMathDocuments(doc(1, [s]), doc(2, [s2]));
    expect(patch.updatedSections).toEqual([]);
    expect(patch.updatedEquations.map((p) => p.equation.id)).toEqual(['e-loop']);
  });
});

describe('stable ids under synthetic edits (plan §4.3)', () => {
  it('same (qualname, role, lhs, ordinal) yields the same id regardless of line numbers', () => {
    const before = computeStableId({ qualname: 'f', role: 'assign', lhsSymbol: 'y', ordinal: 0 });
    const after = computeStableId({ qualname: 'f', role: 'assign', lhsSymbol: 'y', ordinal: 0 });
    expect(after).toBe(before);
    const other = computeStableId({ qualname: 'f', role: 'assign', lhsSymbol: 'y', ordinal: 1 });
    expect(other).not.toBe(before);
  });
});
