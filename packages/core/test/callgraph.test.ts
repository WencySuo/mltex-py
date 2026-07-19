import { describe, expect, it } from 'vitest';
import { parsePython, type ParseResult } from '../src/parse/index.js';
import { NamingEngine } from '../src/naming/index.js';
import {
  buildWorkflow,
  DEFAULT_EXPANSION_PREFS,
  findCallSites,
  type WorkspaceSourceProvider,
  type WorkflowOptions,
} from '../src/callgraph/index.js';
import { emitLatex } from '../src/emit/index.js';

const emptyWorkspace: WorkspaceSourceProvider = {
  getParse: () => Promise.resolve(undefined),
  resolveModule: () => Promise.resolve(undefined),
};

function makeWorkspace(files: Record<string, ParseResult>): WorkspaceSourceProvider {
  return {
    getParse: (uri) => Promise.resolve(files[uri]),
    resolveModule: (_from, modulePath) => {
      const uri = `file:///${modulePath.replace(/\./g, '/')}.py`;
      return Promise.resolve(files[uri] ? uri : undefined);
    },
  };
}

function opts(workspace: WorkspaceSourceProvider, extra?: Partial<WorkflowOptions>): WorkflowOptions {
  return {
    uri: 'file:///main.py',
    version: 1,
    naming: new NamingEngine(),
    prefs: { ...DEFAULT_EXPANSION_PREFS, perCallSite: {} },
    workspace,
    ...extra,
  };
}

const MAIN_SRC = `
def softmax(z):
    e = torch.exp(z)
    return e / e.sum()

def attention(q, k, v):
    scores = q @ k.T
    w = softmax(scores)
    return w @ v

def train_step(q, k, v):
    out = attention(q, k, v)
    return out
`;

describe('findCallSites (same-file)', () => {
  it('finds resolvable call sites with callee qualnames', async () => {
    const parsed = await parsePython(MAIN_SRC);
    const sites = await findCallSites(parsed, 'attention', emptyWorkspace);
    expect(sites).toHaveLength(1);
    expect(sites[0]!.calleeQualname).toBe('softmax');
  });

  it('unresolvable calls are omitted', async () => {
    const parsed = await parsePython('def f(x):\n    y = mystery(x)\n    return y\n');
    const sites = await findCallSites(parsed, 'f', emptyWorkspace);
    expect(sites).toHaveLength(0);
  });
});

describe('buildWorkflow — reference mode (default)', () => {
  it('main section + numbered lemmas, duplicate callee → one lemma', async () => {
    const parsed = await parsePython(MAIN_SRC + '\ndef twice(q, k, v):\n    a = attention(q, k, v)\n    b = attention(q, k, v)\n    return a + b\n');
    const doc = await buildWorkflow(parsed, 'twice', opts(emptyWorkspace));
    const kinds = doc.sections.map((s) => s.kind);
    expect(kinds[0]).toBe('function');
    // attention lemma once (not twice), softmax at depth 1 also referenced
    const lemmaTitles = doc.sections.filter((s) => s.kind === 'lemma').map((s) => s.title);
    expect(lemmaTitles.filter((t) => t === 'attention')).toHaveLength(1);
    expect(lemmaTitles).toContain('softmax');
  });

  it('respects maxDepth (default 2): depth-2 callees not expanded further', async () => {
    const src = 'def a(x):\n    return b(x)\ndef b(x):\n    return c(x)\ndef c(x):\n    return d(x)\ndef d(x):\n    return x\n';
    const parsed = await parsePython(src);
    const doc = await buildWorkflow(parsed, 'a', opts(emptyWorkspace));
    const titles = doc.sections.filter((s) => s.kind === 'lemma').map((s) => s.title);
    expect(titles).toContain('b');
    expect(titles).toContain('c');
    expect(titles).not.toContain('d');
  });

  it('cycles always render as references (no infinite loop)', async () => {
    const src = 'def ping(x):\n    return pong(x)\ndef pong(x):\n    return ping(x)\n';
    const parsed = await parsePython(src);
    const doc = await buildWorkflow(parsed, 'ping', opts(emptyWorkspace, { prefs: { maxDepth: 5, perCallSite: {}, defaultMode: 'reference' } }));
    const titles = doc.sections.map((s) => s.title);
    // pong lemma appears once; ping does not get a lemma (it is the main section)
    expect(titles.filter((t) => t === 'pong')).toHaveLength(1);
  });

  it('workflow emits with lemma subsections + hypertargets', async () => {
    const parsed = await parsePython(MAIN_SRC);
    const doc = await buildWorkflow(parsed, 'train_step', opts(emptyWorkspace));
    const { tex } = emitLatex(doc, { profile: 'derivation', numbered: true });
    expect(tex).toContain('Lemma');
    expect(tex).toContain('\\hypertarget{');
  });
});

describe('buildWorkflow — inline mode', () => {
  it('inline substitutes callee body with mapsto bindings prose', async () => {
    const parsed = await parsePython(MAIN_SRC);
    const doc = await buildWorkflow(
      parsed,
      'attention',
      opts(emptyWorkspace, { prefs: { maxDepth: 2, perCallSite: {}, defaultMode: 'inline' } }),
    );
    const main = doc.sections[0]!;
    const prose = main.blocks.filter((b) => b.kind === 'prose');
    expect(prose.length).toBeGreaterThan(0);
    if (prose[0]!.kind === 'prose') {
      expect(prose[0]!.text).toContain('softmax');
      expect(prose[0]!.text).toContain('z ↦ scores');
    }
    // no lemma sections in pure-inline mode
    expect(doc.sections.filter((s) => s.kind === 'lemma')).toHaveLength(0);
  });
});

describe('buildWorkflow — workspace imports', () => {
  it('resolves workspace-relative imports syntactically', async () => {
    const ops = await parsePython('def softmax(z):\n    e = torch.exp(z)\n    return e / e.sum()\n');
    const main = await parsePython(
      'from mymodel.ops import softmax\n\ndef attention(q, k):\n    w = softmax(q @ k.T)\n    return w\n',
    );
    const workspace = makeWorkspace({ 'file:///mymodel/ops.py': ops });
    const sites = await findCallSites(main, 'attention', workspace);
    expect(sites).toHaveLength(1);
    expect(sites[0]!.calleeUri).toBe('file:///mymodel/ops.py');
    const doc = await buildWorkflow(main, 'attention', opts(workspace));
    expect(doc.sections.some((s) => s.kind === 'lemma' && s.title === 'softmax')).toBe(true);
  });

  it('unresolvable imports never throw, call stays \\operatorname', async () => {
    const main = await parsePython('from missing.mod import helper\n\ndef f(x):\n    return helper(x)\n');
    const doc = await buildWorkflow(main, 'f', opts(emptyWorkspace));
    expect(doc.sections).toHaveLength(1);
  });
});
