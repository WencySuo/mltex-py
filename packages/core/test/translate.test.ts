import { describe, expect, it } from 'vitest';
import { parsePython } from '../src/parse/index.js';
import {
  translateDocument,
  translateFunction,
  translateSelection,
  type TranslateOptions,
} from '../src/translate/index.js';
import { NamingEngine } from '../src/naming/index.js';
import { emitEquation, emitNode } from '../src/emit/index.js';
import type { AlignBlock, Block, Equation, Section } from '../src/ir/types.js';

async function translate(src: string, config?: TranslateOptions['config']) {
  const parsed = await parsePython(src);
  const naming = new NamingEngine({ directives: parsed.ast.directives });
  const opts: TranslateOptions = { uri: 'file:///t.py', version: 1, naming };
  if (config) opts.config = config;
  return translateDocument(parsed, opts);
}

function equations(section: Section): Equation[] {
  const out: Equation[] = [];
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.kind === 'align') out.push(...b.equations);
      else if (b.kind === 'loop') walk(b.body);
    }
  };
  walk(section.blocks);
  return out;
}

/** Emit first equation of the only function in `src`. */
async function firstEq(src: string): Promise<string> {
  const res = await translate(src);
  const eqs = equations(res.document.sections[0]!);
  expect(eqs.length).toBeGreaterThan(0);
  return emitEquation(eqs[0]!);
}

describe('acceptance anchor', () => {
  it('alpha_hat = Q @ K.T / math.sqrt(d) → \\hat{\\alpha} = \\frac{Q K^{\\top}}{\\sqrt{d}}', async () => {
    const tex = await firstEq(
      'import math\ndef attention(Q, K, d):\n    alpha_hat = Q @ K.T / math.sqrt(d)\n    return alpha_hat\n',
    );
    expect(tex.replace(/\s+/g, ' ')).toBe('\\hat{\\alpha} = \\frac{Q K^{\\top}}{\\sqrt{d}}');
  });
});

describe('statement forms (§6.1)', () => {
  it('plain assignment', async () => {
    expect(await firstEq('def f(x):\n    y = x + 1\n')).toBe('y = x + 1');
  });

  it('augmented assignment → \\leftarrow relation', async () => {
    const res = await translate('def f(y, x):\n    y += x\n');
    const eq = equations(res.document.sections[0]!)[0]!;
    expect(eq.relation).toBe('\\leftarrow');
    expect(emitNode(eq.rhs!)).toBe('y + x');
  });

  it('tuple assignment → one equation (y, z) = f(x)', async () => {
    const tex = await firstEq('def g(x):\n    y, z = f(x)\n');
    expect(tex).toContain('\\left( y, z \\right)');
    expect(tex).toContain('\\operatorname{f}');
  });

  it('return expr → function-form LHS', async () => {
    const res = await translate('def loss(x):\n    return x ** 2\n');
    const eqs = equations(res.document.sections[0]!);
    const tex = emitEquation(eqs[0]!);
    expect(tex).toContain('\\operatorname{loss}');
    expect(tex).toContain('x^{2}');
  });

  it('bare side-effect call → code fallback with reason', async () => {
    const res = await translate('def f(x):\n    print(x)\n    y = x + 1\n');
    const blocks = res.document.sections[0]!.blocks;
    expect(blocks.some((b) => b.kind === 'code')).toBe(true);
    expect(res.fallbacks.length).toBeGreaterThan(0);
    // translatable neighbor unaffected
    expect(equations(res.document.sections[0]!).length).toBe(1);
  });

  it('docstring → section prose; imports/asserts skipped', async () => {
    const res = await translate(
      'import torch\ndef f(x):\n    """Docstring here."""\n    assert x is not None\n    y = x + 1\n    return y\n',
    );
    const sec = res.document.sections[0]!;
    expect(sec.prose).toContain('Docstring here.');
    expect(sec.blocks.filter((b) => b.kind === 'code')).toHaveLength(0);
  });
});

describe('operator table (§6.2, table-driven)', () => {
  const rows: Array<[string, string]> = [
    ['y = a @ b', 'y = a b'],
    ['y = torch.matmul(a, b)', 'y = a b'],
    ['y = a.mm(b)', 'y = a b'],
    ['y = a / b', 'y = \\frac{a}{b}'],
    ['y = a ** b', 'y = a^{b}'],
    ['y = a.T', 'y = a^{\\top}'],
    ['y = a.mT', 'y = a^{\\top}'],
    ['y = torch.transpose(a)', 'y = a^{\\top}'],
    ['y = torch.linalg.inv(a)', 'y = a^{-1}'],
    ['y = torch.linalg.solve(a, b)', 'y = a^{-1} b'],
    ['y = torch.norm(x)', 'y = \\lVert x \\rVert'],
    ['y = torch.norm(x, p)', 'y = \\lVert x \\rVert_{p}'],
    ['y = torch.exp(x)', 'y = \\exp\\left( x \\right)'],
    ['y = torch.log(x)', 'y = \\log\\left( x \\right)'],
    ['y = math.sqrt(x)', 'y = \\sqrt{x}'],
    ['y = abs(x)', 'y = \\lvert x \\rvert'],
    ['y = torch.softmax(x, -1)', 'y = \\operatorname{softmax}\\left( x \\right)'],
    ['y = x.softmax(-1)', 'y = \\operatorname{softmax}\\left( x \\right)'],
    ['y = torch.sigmoid(x)', 'y = \\sigma\\left( x \\right)'],
    ['y = F.relu(x)', 'y = \\operatorname{ReLU}\\left( x \\right)'],
    ['y = torch.tanh(x)', 'y = \\tanh\\left( x \\right)'],
    ['y = x.mean()', 'y = \\mathbb{E}\\left[ x \\right]'],
    ['y = x.std()', 'y = \\sigma\\left( x \\right)'],
    ['y = x.var()', 'y = \\operatorname{Var}\\left[ x \\right]'],
    ['y = x[i]', 'y = x_i'],
    ['y = x[i, j]', 'y = x_{i,j}'],
    ['y = torch.zeros(3)', 'y = \\mathbf{0}'],
    ['y = torch.ones(3)', 'y = \\mathbf{1}'],
    ['y = torch.eye(3)', 'y = I'],
    ['y = torch.randn(3)', 'y = \\mathcal{N}(0, I)'],
    ['y = my_helper(x)', 'y = \\operatorname{my\\_helper}\\left( x \\right)'],
    ['y = a + b', 'y = a + b'],
    ['y = a - b', 'y = a - b'],
    ['y = a // b', 'y = a \\mathbin{//} b'],
    ['y = a % b', 'y = a \\bmod b'],
    ['y = -x', 'y = -x'],
  ];

  it.each(rows)('%s → %s', async (stmt, expected) => {
    const tex = await firstEq(`def f(a, b, x, i, j, p):\n    ${stmt}\n`);
    expect(tex).toBe(expected);
  });

  it('slice indexing x[:, j] → x_{:,j}', async () => {
    const tex = await firstEq('def f(x, j):\n    y = x[:, j]\n');
    expect(tex).toBe('y = x_{:,j}');
  });

  it('sum with dim kwarg → \\sum with index', async () => {
    const tex = await firstEq('def f(x, d):\n    y = torch.sum(x, dim=d)\n');
    expect(tex).toContain('\\sum_{d}');
  });

  it('matmul chain flattens: a @ b @ c → a b c', async () => {
    const tex = await firstEq('def f(a, b, c):\n    y = a @ b @ c\n');
    expect(tex).toBe('y = a b c');
  });

  it('comparisons render with proper relations', async () => {
    const tex = await firstEq('def f(a, b, c):\n    y = a <= b\n');
    expect(tex).toBe('y = a \\le b');
  });

  it('transparent methods (.to/.detach/.cpu) pass through', async () => {
    const tex = await firstEq('def f(x, device):\n    y = x.to(device)\n');
    expect(tex).toBe('y = x');
  });

  it('cat → bmatrix rows (dim=0)', async () => {
    const tex = await firstEq('def f(a, b):\n    y = torch.cat([a, b])\n');
    expect(tex).toContain('\\begin{bmatrix} a \\\\ b \\end{bmatrix}');
  });

  it('cat dim=1 → bmatrix columns', async () => {
    const tex = await firstEq('def f(a, b):\n    y = torch.cat([a, b], dim=1)\n');
    expect(tex).toContain('\\begin{bmatrix} a & b \\end{bmatrix}');
  });

  it('math constants: math.pi → \\pi, float("inf") → \\infty', async () => {
    expect(await firstEq('def f():\n    y = math.pi\n')).toBe('y = \\pi');
    expect(await firstEq("def f():\n    y = float('inf')\n")).toBe('y = \\infty');
  });
});

describe('elementwise * heuristic (§6.2)', () => {
  it('unknown operands default to \\cdot', async () => {
    const tex = await firstEq('def f(a, b):\n    y = a * b\n');
    expect(tex).toBe('y = a \\cdot b');
  });

  it('both jaxtyping-annotated tensors → \\odot', async () => {
    const tex = await firstEq(
      'def f(a: Float[Tensor, "n d"], b: Float[Tensor, "n d"]):\n    y = a * b\n',
    );
    expect(tex).toBe('y = a \\odot b');
  });

  it('tensor-producing assignment marks LHS as tensor', async () => {
    const res = await translate(
      'def f(a: Float[Tensor, "n d"], w: Float[Tensor, "d k"]):\n    h = a @ w\n    y = h * h\n',
    );
    const eqs = equations(res.document.sections[0]!);
    expect(emitEquation(eqs[1]!)).toBe('y = h \\odot h');
  });

  it('config elementwiseDefault=odot forces \\odot', async () => {
    const res = await translate('def f(a, b):\n    y = a * b\n', {
      toml: { render: { elementwiseDefault: 'odot' } },
      settings: { panelDebounceMs: 250, pdfEngine: 'tectonic', renderDisplayScale: 1, panelFollow: true },
    });
    expect(emitEquation(equations(res.document.sections[0]!)[0]!)).toBe('y = a \\odot b');
  });
});

describe('einsum expansion (flagship, §6.2)', () => {
  it('"ij,jk->ik" → \\sum_{j} A_{i,j} B_{j,k}', async () => {
    const tex = await firstEq('def f(A, B):\n    C = torch.einsum("ij,jk->ik", A, B)\n');
    expect(tex.replace(/\s+/g, ' ')).toContain('\\sum_{j} A_{i,j} B_{j,k}');
  });

  it('trace "ii->" → sum over i', async () => {
    const tex = await firstEq('def f(A):\n    t = torch.einsum("ii->", A)\n');
    expect(tex).toContain('\\sum_{i}');
  });

  it('batched "bij,bjk->bik" sums only j', async () => {
    const tex = await firstEq('def f(A, B):\n    C = torch.einsum("bij,bjk->bik", A, B)\n');
    expect(tex).toContain('\\sum_{j}');
    expect(tex).not.toContain('\\sum_{b}');
  });

  it('implicit output "ij,jk" derives ik per numpy rules', async () => {
    const tex = await firstEq('def f(A, B):\n    C = torch.einsum("ij,jk", A, B)\n');
    expect(tex).toContain('\\sum_{j}');
  });

  it('einsum with ... falls back to \\operatorname (documented core only)', async () => {
    const res = await translate('def f(A, B):\n    C = torch.einsum("...ij,...jk->...ik", A, B)\n');
    const tex = emitEquation(equations(res.document.sections[0]!)[0]!);
    expect(tex).toContain('\\operatorname{einsum}');
  });

  it('einops rearrange: operand passes through, output shape annotated', async () => {
    const res = await translate("def f(x):\n    y = rearrange(x, 'b s d -> b d s')\n");
    const eq = equations(res.document.sections[0]!)[0]!;
    expect(emitNode(eq.rhs!)).toBe('x');
    const shape = eq.annotations.find((a) => a.kind === 'shape');
    expect((shape!.payload as { dims: unknown[] }).dims).toEqual(['b', 'd', 's']);
  });

  it('einsum output shape lands as a shape annotation (§6.6)', async () => {
    const res = await translate('def f(A, B):\n    C = torch.einsum("ij,jk->ik", A, B)\n');
    const eq = equations(res.document.sections[0]!)[0]!;
    const shape = eq.annotations.find((a) => a.kind === 'shape');
    expect(shape).toBeDefined();
    expect((shape!.payload as { dims: unknown[] }).dims).toEqual(['i', 'k']);
  });
});

describe('control flow (§6.3)', () => {
  it('tier 1: acc = 0; for i in range(N): acc += f(i) → Σ, initializer consumed', async () => {
    const res = await translate('def f(N):\n    acc = 0\n    for i in range(N):\n        acc += g(i)\n');
    const eqs = equations(res.document.sections[0]!);
    expect(eqs).toHaveLength(1);
    const tex = emitEquation(eqs[0]!);
    expect(tex).toContain('\\sum_{i=1}^{N}');
  });

  it('tier 1: product accumulation', async () => {
    const res = await translate('def f(N):\n    p = 1\n    for i in range(N):\n        p *= g(i)\n');
    const tex = emitEquation(equations(res.document.sections[0]!)[0]!);
    expect(tex).toContain('\\prod_{i=1}^{N}');
  });

  it('tier 1: acc = max(acc, ...) → \\max', async () => {
    const res = await translate(
      "def f(xs):\n    m = float('-inf')\n    for x in xs:\n        m = max(m, g(x))\n",
    );
    const tex = emitEquation(equations(res.document.sections[0]!)[0]!);
    expect(tex).toContain('\\max_{x \\in \\mathit{xs}}');
  });

  it('tier 1: list append → indexed family', async () => {
    const res = await translate('def f(N):\n    ys = []\n    for i in range(N):\n        ys.append(g(i))\n');
    const tex = emitEquation(equations(res.document.sections[0]!)[0]!);
    expect(tex).toContain('\\operatorname{g}');
    expect(tex).toContain('_{i = \\left( 1, \\dots, N \\right)}');
  });

  it('generator sum: sum(f(i) for i in range(N)) → Σ', async () => {
    const tex = await firstEq('def f(N):\n    s = sum(g(i) for i in range(N))\n');
    expect(tex).toContain('\\sum_{i=1}^{N}');
  });

  it('tier 2: recurrence h = f(h, x[t]) → h_t = f(h_{t-1}, x_t) with range qualifier', async () => {
    const res = await translate('def f(h, x, T):\n    for t in range(1, T):\n        h = g(h, x[t])\n');
    const eqs = equations(res.document.sections[0]!);
    expect(eqs).toHaveLength(1);
    const tex = emitEquation(eqs[0]!);
    expect(tex).toContain('h_t =');
    expect(tex).toContain('h_{t - 1}');
    expect(tex).toContain('x_t');
    expect(tex).toContain('\\dots');
  });

  it('tier 3: non-reducible loop → indexed block, loop var subscripts body', async () => {
    const res = await translate(
      'def f(x, T):\n    for t in range(T):\n        y = x[t] + 1\n        z = y * 2\n',
    );
    const blocks = res.document.sections[0]!.blocks;
    const loop = blocks.find((b) => b.kind === 'loop');
    expect(loop).toBeDefined();
    expect(loop!.kind === 'loop' ? loop!.header.kind : undefined).toBe('for');
  });

  it('if/elif/else assigning same var → cases', async () => {
    const res = await translate(
      'def f(x):\n    if x > 0:\n        y = g(x)\n    elif x < 0:\n        y = h(x)\n    else:\n        y = 0\n',
    );
    const cases = res.document.sections[0]!.blocks.find((b) => b.kind === 'cases');
    expect(cases).toBeDefined();
    if (cases?.kind === 'cases') {
      expect(cases.branches).toHaveLength(3);
      expect(cases.branches[2]!.guard).toBeUndefined();
    }
  });

  it('if branches assigning different vars → labeled blocks', async () => {
    const res = await translate('def f(x):\n    if x > 0:\n        y = 1\n    else:\n        z = 2\n');
    const blocks = res.document.sections[0]!.blocks;
    const loops = blocks.filter((b) => b.kind === 'loop');
    expect(loops.length).toBe(2);
  });

  it('ternary → inline cases', async () => {
    const tex = await firstEq('def f(a, b, c):\n    y = a if c > 0 else b\n');
    expect(tex).toBe('y = \\begin{cases} a & c > 0 \\\\ b & \\text{otherwise} \\end{cases}');
  });

  it('list comprehension → indexed family', async () => {
    const tex = await firstEq('def f(xs):\n    ys = [g(x) for x in xs]\n');
    expect(tex).toContain('x \\in \\mathit{xs}');
  });

  it('while → labeled block with condition', async () => {
    const res = await translate('def f(g, eps):\n    while torch.norm(g) > eps:\n        g = step(g)\n');
    const loop = res.document.sections[0]!.blocks.find((b) => b.kind === 'loop');
    expect(loop).toBeDefined();
    if (loop?.kind === 'loop') {
      expect(loop.header.kind).toBe('while');
      expect(loop.header.condition).toBeDefined();
    }
  });
});

describe('F8 declared shapes (§6.6 Tier 1)', () => {
  it('jaxtyping param annotations → SignatureParam.dims + dtype', async () => {
    const res = await translate('def f(W: Float[Tensor, "d k"], x: Float[Tensor, "d"]):\n    y = W.T @ x\n');
    const sig = res.document.sections[0]!.signature!;
    expect(sig.params[0]!.dims).toEqual(['d', 'k']);
    expect(sig.params[0]!.dtype).toBe('float');
    expect(sig.params[1]!.dims).toEqual(['d']);
  });

  it('dim-string edge cases: *batch, #broadcast, ..., ints', async () => {
    const res = await translate(
      'def f(x: Float[Tensor, "*batch seq 128"], m: Bool[Tensor, "#b s"], z: Int[Tensor, "..."]):\n    y = x\n',
    );
    const sig = res.document.sections[0]!.signature!;
    expect(sig.params[0]!.dims).toEqual(['*batch', 'seq', 128]);
    expect(sig.params[1]!.dims).toEqual(['#b', 's']);
    expect(sig.params[1]!.dtype).toBe('bool');
    expect(sig.params[2]!.dims).toEqual(['...']);
  });

  it('unparseable dim string → raw typeText, no dims (§6.5 fallback)', async () => {
    const res = await translate('def f(x: Float[Tensor, "dim-1 d"]):\n    y = x\n');
    const p = res.document.sections[0]!.signature!.params[0]!;
    expect(p.dims).toBeUndefined();
    expect(p.typeText).toBe('dim-1 d');
  });

  it('trailing shape comment # (B, T, D) → shape annotation on equation', async () => {
    const res = await translate('def f(x, w):\n    h = x @ w  # (B, T, D)\n');
    const eq = equations(res.document.sections[0]!)[0]!;
    const shape = eq.annotations.find((a) => a.kind === 'shape');
    expect(shape).toBeDefined();
    expect((shape!.payload as { dims: unknown[] }).dims).toEqual(['B', 'T', 'D']);
    expect(shape!.origin).toBe('static');
  });

  it('return-type jaxtyping annotation → SignatureLine.returns', async () => {
    const res = await translate(
      'def f(x: Float[Tensor, "b d"]) -> Float[Tensor, "b"]:\n    return x.sum(-1)\n',
    );
    const sig = res.document.sections[0]!.signature!;
    expect(sig.returns).toBeDefined();
    expect(sig.returns![0]!.dims).toEqual(['b']);
  });

  it('shapeAnnotations are exposed on TranslateResult for DeclaredShapeProvider', async () => {
    const res = await translate('def f(x, w):\n    h = x @ w  # (B, D)\n');
    expect(res.shapeAnnotations!.length).toBeGreaterThan(0);
  });
});

describe('naming integration + directives', () => {
  it('# tex: LHS directive renames the symbol', async () => {
    const tex = await firstEq('def f(w, x):\n    attn = w @ x  # tex: \\tilde{A}\n');
    expect(tex).toContain('\\tilde{A} =');
  });

  it('multi-binding directive applies file-wide from its line', async () => {
    const res = await translate(
      'def f(w, x):\n    # tex: attn=\\tilde{A}, w=W_q\n    attn = w @ x\n    y = attn\n',
    );
    const eqs = equations(res.document.sections[0]!);
    expect(emitEquation(eqs[0]!)).toBe('\\tilde{A} = W_q x');
    expect(emitEquation(eqs[1]!)).toBe('y = \\tilde{A}');
  });
});

describe('fallback discipline (§6.5 hard invariant)', () => {
  const nasty = [
    '',
    'x',
    'def f(:\n  broken',
    'def f():\n    y = {k: v for k, v in d.items()}\n',
    'def f():\n    async with open("f") as h:\n        pass\n',
    'def f(*args, **kwargs):\n    return args\n',
    'lambda x: x + 1',
    'def f():\n    yield 1\n',
    'class A:\n    x: int = 1\n',
    'def f():\n    del x\n    raise ValueError("boom")\n',
  ];
  it.each(nasty.map((s, i) => [i, s] as const))('input #%d never throws', async (_i, src) => {
    const parsed = await parsePython(src);
    const naming = new NamingEngine({ directives: parsed.ast.directives });
    expect(() => translateDocument(parsed, { uri: 'file:///t.py', version: 1, naming })).not.toThrow();
  });
});

describe('translateFunction / translateSelection', () => {
  it('translateFunction finds methods by qualname', async () => {
    const parsed = await parsePython('class M:\n    def forward(self, x):\n        y = x + 1\n        return y\n');
    const naming = new NamingEngine();
    const sec = translateFunction(parsed, 'M.forward', { uri: 'file:///t.py', version: 1, naming });
    expect(sec).toBeDefined();
    expect(sec!.qualname).toBe('M.forward');
    expect(equations(sec!).length).toBe(2);
  });

  it('translateFunction returns undefined for missing qualname', async () => {
    const parsed = await parsePython('def f():\n    pass\n');
    const naming = new NamingEngine();
    expect(translateFunction(parsed, 'nope', { uri: 'file:///t.py', version: 1, naming })).toBeUndefined();
  });

  it('translateSelection lists free variables in a given-line', async () => {
    const src = 'def f(a, b):\n    c = a + b\n    d = c * 2\n    e = d + a\n';
    const parsed = await parsePython(src);
    const naming = new NamingEngine();
    const sec = translateSelection(
      parsed,
      { start: { line: 2, character: 0 }, end: { line: 3, character: 20 } },
      { uri: 'file:///t.py', version: 1, naming },
    );
    expect(sec.kind).toBe('selection');
    const free = sec.signature?.params.map((p) => p.pythonName) ?? [];
    expect(free).toContain('c');
    expect(free).toContain('a');
    expect(free).not.toContain('d');
  });

  it('selection inside a loop body synthesizes a context note', async () => {
    const src = 'def f(x, T):\n    for t in range(T):\n        y = x[t] + 1\n        z = y * 2\n';
    const parsed = await parsePython(src);
    const naming = new NamingEngine();
    const sec = translateSelection(
      parsed,
      { start: { line: 2, character: 0 }, end: { line: 3, character: 30 } },
      { uri: 'file:///t.py', version: 1, naming },
    );
    const prose = sec.blocks.find((b) => b.kind === 'prose');
    expect(prose).toBeDefined();
    if (prose?.kind === 'prose') expect(prose.text).toContain('loop over t');
  });
});

describe('occurrence ids (§10.3)', () => {
  it('every sym node carries an occurrenceId keyed to the equation', async () => {
    const res = await translate('def f(a, b):\n    y = a + b * a\n');
    const eq = equations(res.document.sections[0]!)[0]!;
    const ids: string[] = [];
    const walk = (n: unknown): void => {
      if (n && typeof n === 'object') {
        const node = n as { kind?: string; occurrenceId?: string };
        if (node.kind === 'sym') {
          expect(node.occurrenceId).toBeTruthy();
          ids.push(node.occurrenceId!);
        }
        for (const v of Object.values(n)) {
          if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === 'object') walk(v);
        }
      }
    };
    walk(eq);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith(String(eq.id)))).toBe(true);
  });
});
