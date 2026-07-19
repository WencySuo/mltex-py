import { describe, expect, it } from 'vitest';
import type {
  AlignBlock,
  Annotation,
  Equation,
  MathDocument,
  MathNode,
  Range,
  Section,
} from '@mathlens/core';
import type { MathPatch } from '@mathlens/core';
import { PanelDocModel, equationsInSection } from '../src/docModel.js';

function range(startLine: number, endLine = startLine): Range {
  return { start: { line: startLine, character: 0 }, end: { line: endLine, character: 80 } };
}

function sym(name: string, occ: string, line = 0): MathNode {
  return { kind: 'sym', pythonName: name, tex: name, occurrenceId: occ, sourceRange: range(line) };
}

function eq(id: string, line: number, rhsName = 'x'): Equation {
  return {
    id,
    lhs: sym('y', `${id}#0`, line),
    rhs: sym(rhsName, `${id}#1`, line),
    relation: '=',
    sourceRange: range(line),
    annotations: [],
  };
}

function section(id: string, equations: Equation[], startLine = 0, endLine = 20): Section {
  return {
    id,
    kind: 'function',
    title: 'f',
    qualname: 'f',
    blocks: [{ kind: 'align', equations } satisfies AlignBlock],
    sourceRange: range(startLine, endLine),
  };
}

function doc(sections: Section[], version = 1): MathDocument {
  return { uri: 'file:///t.py', version, sections };
}

function emptyPatch(): MathPatch {
  return { addedSections: [], updatedSections: [], removedSections: [], updatedEquations: [] };
}

describe('PanelDocModel patch application', () => {
  it('replaces an equation in place and reports it changed', () => {
    const model = new PanelDocModel();
    model.init(doc([section('s1', [eq('e1', 2), eq('e2', 3)])]), []);

    const replacement = eq('e2', 3, 'z');
    const outcome = model.applyPatch('file:///t.py', 2, {
      ...emptyPatch(),
      updatedEquations: [{ sectionId: 's1', equation: replacement }],
    });

    expect(outcome.changedEquationIds).toEqual(['e2']);
    expect(outcome.changedSectionIds).toEqual([]);
    expect(model.version).toBe(2);
    const eqs = [...equationsInSection(model.document!.sections[0]!)];
    expect((eqs[1]!.rhs as { pythonName: string }).pythonName).toBe('z');
  });

  it('drops stale patches (older version)', () => {
    const model = new PanelDocModel();
    model.init(doc([section('s1', [eq('e1', 2)])], 5), []);
    const outcome = model.applyPatch('file:///t.py', 3, {
      ...emptyPatch(),
      updatedEquations: [{ sectionId: 's1', equation: eq('e1', 2, 'z') }],
    });
    expect(outcome.changedEquationIds).toEqual([]);
    expect(model.version).toBe(5);
  });

  it('drops patches for a different uri', () => {
    const model = new PanelDocModel();
    model.init(doc([section('s1', [eq('e1', 2)])]), []);
    const outcome = model.applyPatch('file:///other.py', 2, {
      ...emptyPatch(),
      removedSections: ['s1'],
    });
    expect(outcome.removedSectionIds).toEqual([]);
    expect(model.document!.sections).toHaveLength(1);
  });

  it('adds, updates, and removes sections wholesale', () => {
    const model = new PanelDocModel();
    model.init(doc([section('s1', [eq('e1', 2)]), section('s2', [eq('e2', 10)])]), []);

    const s2v2 = section('s2', [eq('e2', 10, 'q')]);
    const s3 = section('s3', [eq('e3', 30)]);
    const outcome = model.applyPatch('file:///t.py', 2, {
      ...emptyPatch(),
      addedSections: [s3],
      updatedSections: [s2v2],
      removedSections: ['s1'],
    });

    expect(outcome.removedSectionIds).toEqual(['s1']);
    expect(outcome.changedSectionIds.sort()).toEqual(['s2', 's3']);
    expect(model.document!.sections.map((s) => String(s.id))).toEqual(['s2', 's3']);
  });

  it('skips equation patches inside sections replaced in the same patch', () => {
    const model = new PanelDocModel();
    model.init(doc([section('s1', [eq('e1', 2)])]), []);
    const outcome = model.applyPatch('file:///t.py', 2, {
      ...emptyPatch(),
      updatedSections: [section('s1', [eq('e1', 2, 'new')])],
      updatedEquations: [{ sectionId: 's1', equation: eq('e1', 2, 'stale') }],
    });
    expect(outcome.changedSectionIds).toEqual(['s1']);
    expect(outcome.changedEquationIds).toEqual([]);
    const eqs = [...equationsInSection(model.document!.sections[0]!)];
    expect((eqs[0]!.rhs as { pythonName: string }).pythonName).toBe('new');
  });

  it('replaces equations nested inside loop blocks', () => {
    const model = new PanelDocModel();
    const inner = eq('e-in', 5);
    const s: Section = {
      id: 's1',
      kind: 'function',
      title: 'f',
      blocks: [
        {
          kind: 'loop',
          header: { kind: 'for', sourceRange: range(4) },
          body: [{ kind: 'align', equations: [inner] }],
          sourceRange: range(4, 7),
        },
      ],
      sourceRange: range(0, 10),
    };
    model.init(doc([s]), []);
    const outcome = model.applyPatch('file:///t.py', 2, {
      ...emptyPatch(),
      updatedEquations: [{ sectionId: 's1', equation: eq('e-in', 5, 'z') }],
    });
    expect(outcome.changedEquationIds).toEqual(['e-in']);
  });
});

describe('cursor line → equation mapping (F2 sync)', () => {
  it('maps a line to the containing equation', () => {
    const model = new PanelDocModel();
    model.init(doc([section('s1', [eq('e1', 2), eq('e2', 3)])]), []);
    expect(String(model.equationAtLine(3)?.id)).toBe('e2');
    expect(model.equationAtLine(9)).toBeUndefined();
  });

  it('prefers the tightest containing range for multi-line statements', () => {
    const model = new PanelDocModel();
    const wide: Equation = { ...eq('wide', 2), sourceRange: range(2, 6) };
    const tight: Equation = { ...eq('tight', 4), sourceRange: range(4, 4) };
    model.init(doc([section('s1', [wide, tight])]), []);
    expect(String(model.equationAtLine(4)?.id)).toBe('tight');
    expect(String(model.equationAtLine(5)?.id)).toBe('wide');
  });

  it('equationById round-trips with sourceRange intact (panel→editor)', () => {
    const model = new PanelDocModel();
    model.init(doc([section('s1', [eq('e1', 7)])]), []);
    const found = model.equationById('e1');
    expect(found?.sourceRange.start.line).toBe(7);
  });
});

describe('annotation store', () => {
  const ann = (target: string, source = 'x'): Annotation => ({
    target,
    kind: 'shape',
    origin: 'runtime',
    payload: { dims: ['d'] },
  });

  it('scopes reset to one source (client-side DAP push semantics)', () => {
    const model = new PanelDocModel();
    model.init(doc([section('s1', [eq('e1', 2)])]), [ann('e1')]);
    model.setAnnotations('dap', [ann('e1'), ann('e1')]);
    expect(model.allAnnotations()).toHaveLength(3);
    model.setAnnotations('dap', [ann('e1')], true);
    expect(model.allAnnotations()).toHaveLength(2);
    // init-sourced annotation survives dap reset.
    model.setAnnotations('dap', [], true);
    expect(model.allAnnotations()).toHaveLength(1);
  });
});
