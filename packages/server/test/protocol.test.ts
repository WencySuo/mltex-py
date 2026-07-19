/**
 * Server-level protocol tests (plan §11 "protocol tests"): request handlers
 * exercised directly against a fake connection, with a working mock core and
 * with a throwing core (today's stubs) — graceful degradation everywhere.
 */

import { describe, expect, it } from 'vitest';
import type { Connection } from 'vscode-languageserver/node';
import { MathUpdatedNotification, type MathUpdatedParams } from '@mathlens/core/protocol';
import { computeStableId, type MathDocument } from '@mathlens/core';

import { MathLensDocuments } from '../src/documents.js';
import { registerHover } from '../src/hover.js';
import { registerCodeLens, PanelDidRenderNotification } from '../src/codelens.js';
import { createCustomHandlers, registerCustomRequests } from '../src/custom.js';
import type { CoreBridge } from '../src/core.js';
import { FakeConnection, sleep, throwingCore, workingCore } from './helpers.js';

const URI = 'file:///proj/model.py';

const SAMPLE = [
  'import math',
  '',
  'def attention(q, k, d):',
  '    scores = q @ k.T / math.sqrt(d)',
  '    weights = softmax(scores)',
  '    return weights',
  '',
  'class Model:',
  '    def forward(self, x):',
  '        y = self.w @ x',
  '        return y',
].join('\n');

interface Harness {
  connection: FakeConnection;
  documents: MathLensDocuments;
  core: CoreBridge;
}

function setup(core: CoreBridge, debounceMs = 5): Harness {
  const connection = new FakeConnection();
  const documents = new MathLensDocuments({ core, debounceMs });
  documents.listen(connection as unknown as Connection);
  registerHover(connection as unknown as Connection, documents, { core });
  registerCodeLens(connection as unknown as Connection, documents);
  registerCustomRequests(connection as unknown as Connection, documents, { core });
  return { connection, documents, core };
}

describe('hover (F0)', () => {
  it('returns markdown with a data-URI SVG image for a translatable statement', async () => {
    const { connection } = setup(workingCore());
    connection.open(URI, SAMPLE);
    const hover = await connection.hoverHandler!({
      textDocument: { uri: URI },
      position: { line: 3, character: 6 },
    });
    expect(hover).not.toBeNull();
    expect(hover.contents.kind).toBe('markdown');
    expect(hover.contents.value).toMatch(/!\[equation\]\(data:image\/svg\+xml;base64,/);
    expect(hover.range.start.line).toBe(3);
  });

  it('falls back to raw statement text when core throws (never empty on statements)', async () => {
    const { connection } = setup(throwingCore());
    connection.open(URI, SAMPLE);
    const hover = await connection.hoverHandler!({
      textDocument: { uri: URI },
      position: { line: 3, character: 6 },
    });
    expect(hover).not.toBeNull();
    expect(hover.contents.value).toContain('```python');
    expect(hover.contents.value).toContain('scores = q @ k.T / math.sqrt(d)');
  });

  it('falls back to LaTeX source in a code block when rendering fails', async () => {
    // emitEquation yields invalid TeX → texToSvg rejects → ```latex fallback.
    const core = workingCore({ emitEquation: () => '\\frac{' });
    const { connection } = setup(core);
    connection.open(URI, SAMPLE);
    const hover = await connection.hoverHandler!({
      textDocument: { uri: URI },
      position: { line: 4, character: 4 },
    });
    expect(hover).not.toBeNull();
    expect(hover.contents.value).toContain('```latex');
    expect(hover.contents.value).toContain('\\frac{');
  });

  it('returns null (normal no-hover) outside any function', async () => {
    const { connection } = setup(workingCore());
    connection.open(URI, SAMPLE);
    const hover = await connection.hoverHandler!({
      textDocument: { uri: URI },
      position: { line: 0, character: 2 },
    });
    expect(hover).toBeNull();
  });
});

describe('codeLens (F1)', () => {
  it('emits one "View as math" lens per function, including methods', async () => {
    const { connection } = setup(workingCore());
    connection.open(URI, SAMPLE);
    const lenses = await connection.codeLensHandler!({ textDocument: { uri: URI } });
    const titles = lenses.map((l: { command: { title: string } }) => l.command.title);
    expect(titles).toEqual(['View as math', 'View as math']);
    const qualnames = lenses.map((l: { command: { arguments: unknown[] } }) => l.command.arguments[1]);
    expect(qualnames).toEqual(['attention', 'Model.forward']);
    expect(lenses[0].command.command).toBe('mathlens.viewAsMath');
    expect(lenses[0].command.arguments[0]).toBe(URI);
    expect(lenses[0].command.arguments[2]).toHaveProperty('start');
  });

  it('still emits lenses via the scan fallback when core throws', async () => {
    const { connection } = setup(throwingCore());
    connection.open(URI, SAMPLE);
    const lenses = await connection.codeLensHandler!({ textDocument: { uri: URI } });
    expect(lenses).toHaveLength(2);
  });

  it('adds the "Export PDF" lens only after mathlens/panelDidRender', async () => {
    const { connection } = setup(workingCore());
    connection.open(URI, SAMPLE);
    connection.handlers.get(PanelDidRenderNotification)!({ uri: URI, functionIds: ['attention'] });
    const lenses = await connection.codeLensHandler!({ textDocument: { uri: URI } });
    const byTitle = lenses.map((l: { command: { title: string; arguments: unknown[] } }) => [
      l.command.title,
      l.command.arguments[1],
    ]);
    expect(byTitle).toContainEqual(['Export PDF', 'attention']);
    expect(byTitle).not.toContainEqual(['Export PDF', 'Model.forward']);
  });
});

describe('custom requests (plan §3.4)', () => {
  it('documentMath returns MathIR for a simple file', async () => {
    const { connection, documents, core } = setup(workingCore());
    connection.open(URI, SAMPLE);
    const handlers = createCustomHandlers(core, documents);
    const result = await handlers.documentMath({ uri: URI });
    expect(result.document.uri).toBe(URI);
    expect(result.document.version).toBe(1);
    expect(result.document.sections.map((s) => s.qualname)).toEqual(['attention', 'Model.forward']);
    const eqs = (result.document.sections[0].blocks[0] as { equations: unknown[] }).equations;
    expect(eqs.length).toBe(2); // scores, weights
  });

  it('functionMath returns exactly the enclosing section; null outside functions', async () => {
    const { connection, documents, core } = setup(workingCore());
    connection.open(URI, SAMPLE);
    const handlers = createCustomHandlers(core, documents);
    const inside = await handlers.functionMath({ uri: URI, position: { line: 9, character: 2 } });
    expect(inside).not.toBeNull();
    expect(inside!.document.sections.map((s) => s.qualname)).toEqual(['Model.forward']);
    const outside = await handlers.functionMath({ uri: URI, position: { line: 0, character: 0 } });
    expect(outside).toBeNull();
  });

  it('selectionMath returns one synthetic selection section', async () => {
    const { connection, documents, core } = setup(workingCore());
    connection.open(URI, SAMPLE);
    const handlers = createCustomHandlers(core, documents);
    const result = await handlers.selectionMath({
      uri: URI,
      range: { start: { line: 3, character: 0 }, end: { line: 4, character: 30 } },
    });
    expect(result.document.sections).toHaveLength(1);
    expect(result.document.sections[0].kind).toBe('selection');
  });

  it('workflowMath resolves the entry by position and echoes the version', async () => {
    const { connection, documents, core } = setup(workingCore());
    connection.open(URI, SAMPLE);
    const handlers = createCustomHandlers(core, documents);
    const result = await handlers.workflowMath({
      uri: URI,
      position: { line: 3, character: 0 },
      prefs: { maxDepth: 2, perCallSite: {}, defaultMode: 'reference' },
    });
    expect(result.document.sections.map((s) => s.qualname)).toEqual(['attention']);
    expect(result.document.version).toBe(1);
  });

  it('emitLatex returns tex + sourceMap and injects the user preamble', async () => {
    const { connection, documents, core } = setup(workingCore());
    connection.open(URI, SAMPLE);
    const handlers = createCustomHandlers(core, documents);
    const result = await handlers.emitLatex({ uri: URI, profile: 'derivation' });
    expect(result.tex).toContain('% profile: derivation');
    expect(Array.isArray(result.sourceMap)).toBe(true);
  });

  it('emitLatex dispatches by target kind (F6: PDF = panel snapshot)', async () => {
    const emitted: unknown[] = [];
    const core = workingCore({
      emitLatex: (doc, opts) => {
        emitted.push(doc);
        return { tex: `% profile: ${opts.profile}\n`, sourceMap: [] };
      },
    });
    const { connection, documents } = setup(core);
    connection.open(URI, SAMPLE);
    const handlers = createCustomHandlers(core, documents);

    // target 'selection' → selectionMath(range) → one synthetic selection section
    await handlers.emitLatex({
      uri: URI,
      profile: 'derivation',
      target: 'selection',
      range: { start: { line: 3, character: 0 }, end: { line: 4, character: 30 } },
    });
    const selDoc = emitted[emitted.length - 1] as MathDocument;
    expect(selDoc.sections.map((s) => s.kind)).toEqual(['selection']);

    // target 'function' → functionMath at position (single enclosing section)
    await handlers.emitLatex({
      uri: URI,
      profile: 'derivation',
      target: 'function',
      position: { line: 9, character: 2 },
      prefs: { maxDepth: 2, perCallSite: {}, defaultMode: 'reference' },
    });
    const fnDoc = emitted[emitted.length - 1] as MathDocument;
    expect(fnDoc.sections.map((s) => s.qualname)).toEqual(['Model.forward']);
  });

  it('degrades to empty documents / comment-only tex when core throws — never a request error', async () => {
    const { connection, documents, core } = setup(throwingCore());
    connection.open(URI, SAMPLE);
    const handlers = createCustomHandlers(core, documents);

    const docResult = await handlers.documentMath({ uri: URI });
    expect(docResult.document).toEqual({ uri: URI, version: 1, sections: [] });

    // functionMath: scan fallback still finds the function → degraded empty doc
    const fn = await handlers.functionMath({ uri: URI, position: { line: 3, character: 0 } });
    expect(fn).not.toBeNull();
    expect(fn!.document.sections).toEqual([]);

    const sel = await handlers.selectionMath({
      uri: URI,
      range: { start: { line: 3, character: 0 }, end: { line: 4, character: 0 } },
    });
    expect(sel.document.sections).toEqual([]);

    const wf = await handlers.workflowMath({
      uri: URI,
      qualname: 'attention',
      prefs: { maxDepth: 2, perCallSite: {}, defaultMode: 'reference' },
    });
    expect(wf.document.sections).toEqual([]);

    const emit = await handlers.emitLatex({ uri: URI, profile: 'literate' });
    expect(emit.tex).toMatch(/^% MathLens/);
    expect(emit.sourceMap).toEqual([]);
  });
});

describe('mathlens/mathUpdated (plan §3.4, §4.3)', () => {
  async function flush(connection: FakeConnection, ms = 30): Promise<void> {
    await sleep(ms);
  }

  it('ships an initial full patch on open, then an equation-level patch after an edit', async () => {
    const { connection } = setup(workingCore(), 5);
    connection.open(URI, SAMPLE);
    await flush(connection);

    const initial = connection.notificationsFor(MathUpdatedNotification);
    expect(initial).toHaveLength(1);
    const first = initial[0].params as MathUpdatedParams;
    expect(first.uri).toBe(URI);
    expect(first.version).toBe(1);
    expect(first.patch.addedSections.length).toBe(2);

    // Edit ONE rhs (same statement structure) → equation-level patch only.
    const edited = SAMPLE.replace('softmax(scores)', 'softmax(scores / t)');
    connection.change(URI, edited, 2);
    await flush(connection);

    const all = connection.notificationsFor(MathUpdatedNotification);
    expect(all).toHaveLength(2);
    const second = all[1].params as MathUpdatedParams;
    expect(second.version).toBe(2);
    expect(second.patch.addedSections).toEqual([]);
    expect(second.patch.updatedSections).toEqual([]);
    expect(second.patch.removedSections).toEqual([]);
    expect(second.patch.updatedEquations).toHaveLength(1);
    const expectedId = computeStableId({
      qualname: 'attention',
      role: 'assign',
      lhsSymbol: 'weights',
      ordinal: 0,
    });
    expect(second.patch.updatedEquations[0].equation.id).toBe(expectedId);
  });

  it('debounces: rapid consecutive edits produce a single patch', async () => {
    const { connection } = setup(workingCore(), 25);
    connection.open(URI, SAMPLE);
    await flush(connection, 60);
    const before = connection.notificationsFor(MathUpdatedNotification).length;

    connection.change(URI, SAMPLE.replace('sqrt(d)', 'sqrt(d1)'), 2);
    connection.change(URI, SAMPLE.replace('sqrt(d)', 'sqrt(d2)'), 3);
    connection.change(URI, SAMPLE.replace('sqrt(d)', 'sqrt(d3)'), 4);
    await flush(connection, 80);

    const after = connection.notificationsFor(MathUpdatedNotification);
    expect(after.length).toBe(before + 1);
    const last = after[after.length - 1].params as MathUpdatedParams;
    expect(last.version).toBe(4);
    expect(last.patch.updatedEquations).toHaveLength(1);
  });

  it('stable IDs survive a synthetic edit above the function (plan §4.3)', async () => {
    const { connection, documents } = setup(workingCore(), 5);
    connection.open(URI, SAMPLE);
    await flush(connection);
    const before = (await documents.getMath(URI)) as MathDocument;
    const idsBefore = before.sections.map((s) => s.id);

    // Insert lines ABOVE the functions — all ranges shift, ids must not.
    connection.change(URI, `# header comment\nimport os\n${SAMPLE}`, 2);
    await flush(connection);
    const after = (await documents.getMath(URI)) as MathDocument;
    expect(after.sections.map((s) => s.id)).toEqual(idsBefore);

    // And the shipped patch carries no added/removed sections (ids matched):
    // the shift arrives as in-place section updates keyed by the SAME ids.
    const notifications = connection.notificationsFor(MathUpdatedNotification);
    const last = notifications[notifications.length - 1].params as MathUpdatedParams;
    expect(last.patch.addedSections).toEqual([]);
    expect(last.patch.removedSections).toEqual([]);
    expect(last.patch.updatedSections.map((s) => s.id).sort()).toEqual([...idsBefore].sort());
  });

  it('sends nothing when core is throwing (degraded mode stays quiet)', async () => {
    const { connection } = setup(throwingCore(), 5);
    connection.open(URI, SAMPLE);
    await flush(connection);
    expect(connection.notificationsFor(MathUpdatedNotification)).toEqual([]);
  });
});

describe('diagnostics (plan §3.4)', () => {
  it('publishes parse diagnostics and naming hints with hint/warning severity', async () => {
    const core = workingCore({
      parsePython: async (source: string) => {
        const parsed = (await workingCore().parsePython(source)) as Awaited<
          ReturnType<CoreBridge['parsePython']>
        >;
        return {
          ...parsed,
          diagnostics: [
            {
              message: 'unparseable # tex: directive',
              range: { start: { line: 3, character: 0 }, end: { line: 3, character: 10 } },
              severity: 'warning' as const,
            },
          ],
        };
      },
    });
    const { connection } = setup(core, 5);
    connection.open(URI, SAMPLE);
    await sleep(30);
    const published = connection.diagnostics.filter((d) => d.uri === URI);
    expect(published.length).toBeGreaterThan(0);
    const last = published[published.length - 1];
    const messages = (last.diagnostics as Array<{ message: string; severity: number }>).map(
      (d) => d.message,
    );
    expect(messages).toContain('unparseable # tex: directive');
    for (const d of last.diagnostics as Array<{ severity: number; source: string }>) {
      expect(d.severity).toBeGreaterThanOrEqual(2); // never Error severity
      expect(d.source).toBe('mathlens');
    }
  });
});
