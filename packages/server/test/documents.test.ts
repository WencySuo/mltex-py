/**
 * Document manager tests: annotation provider merging (provider-agnostic,
 * plan §4.2), mathlens.toml workspace config loading (plan §3.5), and the
 * pyscan degradation fallback.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Connection } from 'vscode-languageserver/node';
import type { Annotation } from '@mathlens/core';

import { MathLensDocuments, mergeAnnotations, findEquationAtLine } from '../src/documents.js';
import { loadWorkspaceConfig } from '../src/config.js';
import { scanPythonFunctions } from '../src/pyscan.js';
import { FakeConnection, fakeTranslate, sleep, staticAnnotations, workingCore } from './helpers.js';

const URI = 'file:///proj/m.py';
const SRC = ['def f(x):', '    y = x + 1', '    z = y * 2', '    return z'].join('\n');

describe('annotation merging (plan §4.2)', () => {
  it('merges provider annotations into targeted equations without branching on origin', () => {
    const doc = fakeTranslate(URI, 1, SRC);
    const eqId = String(
      (doc.sections[0].blocks[0] as { equations: Array<{ id: string }> }).equations[0].id,
    );
    const annotations: Annotation[] = [
      { target: eqId as Annotation['target'], kind: 'shape', origin: 'static', payload: { dims: ['d'] } },
      // occurrence-targeted → resolves to the same equation
      { target: `${eqId}#0` as Annotation['target'], kind: 'note', origin: 'runtime', payload: { text: 'hi' } },
      { target: 'nonexistent' as Annotation['target'], kind: 'note', origin: 'static', payload: { text: 'x' } },
    ];
    const merged = mergeAnnotations(doc, annotations);
    const eq = (merged.sections[0].blocks[0] as { equations: Array<{ annotations: Annotation[] }> })
      .equations[0];
    expect(eq.annotations).toHaveLength(2);
    // static and runtime carried identically — same array, same shape
    expect(new Set(eq.annotations.map((a) => a.origin))).toEqual(new Set(['static', 'runtime']));
    // original untouched (merge is a copy)
    const orig = (doc.sections[0].blocks[0] as { equations: Array<{ annotations: Annotation[] }> })
      .equations[0];
    expect(orig.annotations).toHaveLength(0);
  });

  it('ships provider annotations inside getMath() output', async () => {
    const connection = new FakeConnection();
    const documents = new MathLensDocuments({ core: workingCore(), debounceMs: 5 });
    documents.listen(connection as unknown as Connection);
    const doc = fakeTranslate(URI, 1, SRC);
    const eqId = (doc.sections[0].blocks[0] as { equations: Array<{ id: string }> }).equations[0].id;
    documents.addAnnotationProvider(
      staticAnnotations([
        { target: eqId as Annotation['target'], kind: 'shape', origin: 'static', payload: { dims: ['b', 'd'] } },
      ]),
    );
    connection.open(URI, SRC);
    const math = await documents.getMath(URI);
    const eq = (math!.sections[0].blocks[0] as { equations: Array<{ annotations: Annotation[] }> })
      .equations[0];
    expect(eq.annotations).toEqual([
      { target: eqId, kind: 'shape', origin: 'static', payload: { dims: ['b', 'd'] } },
    ]);
  });

  it('isolates a throwing provider (graceful degradation)', async () => {
    const connection = new FakeConnection();
    const documents = new MathLensDocuments({ core: workingCore(), debounceMs: 5 });
    documents.listen(connection as unknown as Connection);
    documents.addAnnotationProvider({
      name: 'boom',
      provide: async () => {
        throw new Error('provider exploded');
      },
    });
    connection.open(URI, SRC);
    const math = await documents.getMath(URI);
    expect(math).toBeDefined();
    expect(math!.sections).toHaveLength(1);
  });
});

describe('workspace config (plan §3.5, §5)', () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it('loads mathlens.toml + preamble include from the workspace root', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mathlens-'));
    fs.writeFileSync(
      path.join(tmp, 'mathlens.toml'),
      `[symbols]\nlr = '\\eta'\n[preamble]\ninclude = "notation.tex"\n`,
    );
    fs.writeFileSync(path.join(tmp, 'notation.tex'), '\\newcommand{\\R}{\\mathbb{R}}');
    const loaded = loadWorkspaceConfig(tmp);
    expect(loaded.effective.toml.symbols).toEqual({ lr: '\\eta' });
    expect(loaded.userPreamble).toBe('\\newcommand{\\R}{\\mathbb{R}}');
    expect(loaded.warnings).toEqual([]);
  });

  it('degrades to defaults with a warning on a broken toml / missing include', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mathlens-'));
    fs.writeFileSync(path.join(tmp, 'mathlens.toml'), '[symbols\nbroken');
    const loaded = loadWorkspaceConfig(tmp);
    expect(loaded.effective.toml).toEqual({});
    expect(loaded.warnings.length).toBeGreaterThan(0);
    expect(loaded.effective.settings.panelDebounceMs).toBe(250);
  });

  it('feeds [symbols]/[functions] into the NamingEngine construction', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mathlens-'));
    fs.writeFileSync(path.join(tmp, 'mathlens.toml'), `[symbols]\nattn = '\\tilde{A}'\n`);
    const seen: unknown[] = [];
    const core = workingCore();
    const RealNaming = core.NamingEngine;
    core.NamingEngine = class extends RealNaming {
      constructor(opts: ConstructorParameters<typeof RealNaming>[0] = {}) {
        super(opts);
        seen.push(opts?.config);
      }
    } as typeof RealNaming;

    const connection = new FakeConnection();
    const documents = new MathLensDocuments({ core, debounceMs: 5 });
    documents.initialize({
      processId: null,
      rootUri: pathToFileURL(tmp).toString(),
      capabilities: {},
      workspaceFolders: null,
    } as never);
    documents.listen(connection as unknown as Connection);
    connection.open(URI, SRC);
    await documents.getState(URI);
    expect(seen.length).toBeGreaterThan(0);
    expect((seen[0] as { symbols: Record<string, string> }).symbols).toEqual({
      attn: '\\tilde{A}',
    });
  });
});

describe('pyscan fallback', () => {
  it('finds nested functions and methods with qualnames', () => {
    const src = [
      'def outer(a):',
      '    def inner(b):',
      '        return b',
      '    return inner(a)',
      '',
      'class C:',
      '    async def m(self):',
      '        pass',
    ].join('\n');
    const fns = scanPythonFunctions(src);
    expect(fns.map((f) => f.qualname)).toEqual(['outer', 'outer.inner', 'C.m']);
    expect(fns[0].range.start.line).toBe(0);
    expect(fns[0].range.end.line).toBe(3);
  });
});

describe('cache & sync', () => {
  it('caches state per version and drops it on close', async () => {
    const connection = new FakeConnection();
    const core = workingCore();
    let parses = 0;
    const origParse = core.parsePython;
    core.parsePython = async (s: string) => {
      parses++;
      return origParse(s);
    };
    const documents = new MathLensDocuments({ core, debounceMs: 5 });
    documents.listen(connection as unknown as Connection);
    connection.open(URI, SRC);
    await documents.getState(URI);
    await documents.getState(URI);
    await sleep(20); // debounced open-recompute folds into the same version
    await documents.getState(URI);
    expect(parses).toBe(1);
    connection.close(URI);
    expect(await documents.getState(URI)).toBeUndefined();
    // close clears our diagnostics
    expect(connection.diagnostics[connection.diagnostics.length - 1]).toEqual({
      uri: URI,
      diagnostics: [],
    });
  });

  it('findEquationAtLine picks the statement equation by sourceRange (F2 anchor)', () => {
    const doc = fakeTranslate(URI, 1, SRC);
    const hit = findEquationAtLine(doc, 2);
    expect(hit).toBeDefined();
    expect((hit!.equation.lhs as { pythonName: string }).pythonName).toBe('z');
    expect(findEquationAtLine(doc, 0)).toBeUndefined();
  });
});
