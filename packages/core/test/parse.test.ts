import { describe, expect, it } from 'vitest';
import { initParser, parsePython, reparsePython } from '../src/parse/index.js';

const SRC = `
"""Module docstring."""

import math

def attention(q, k, v):
    """Scaled dot-product attention."""
    alpha_hat = q @ k.T / math.sqrt(64)  # tex: \\hat{\\alpha}
    return alpha_hat @ v

class Model:
    def forward(self, x):
        # tex: y=\\tilde{Y}, w=W_q
        y = self.lin(x)  # (B, T, D)
        return y

    def helper(self):
        def inner():
            pass
        return inner
`;

describe('parsePython', () => {
  it('discovers functions with qualnames (methods, nested)', async () => {
    const { ast } = await parsePython(SRC);
    const quals = ast.functions.map((f) => f.qualname);
    expect(quals).toEqual(['attention', 'Model.forward', 'Model.helper', 'Model.helper.inner']);
  });

  it('extracts docstrings', async () => {
    const { ast } = await parsePython(SRC);
    const attn = ast.functions.find((f) => f.qualname === 'attention')!;
    expect(attn.docstring).toBe('Scaled dot-product attention.');
  });

  it('collects tex directives (LHS form binds the assignment target)', async () => {
    const { ast } = await parsePython(SRC);
    const lhsForm = ast.directives.find((d) => d.raw.includes('\\hat'));
    expect(lhsForm).toBeDefined();
    expect(lhsForm!.bindings).toEqual([{ name: 'alpha_hat', tex: '\\hat{\\alpha}' }]);
  });

  it('collects multi-binding directives', async () => {
    const { ast } = await parsePython(SRC);
    const multi = ast.directives.find((d) => d.bindings.length === 2);
    expect(multi).toBeDefined();
    expect(multi!.bindings).toContainEqual({ name: 'y', tex: '\\tilde{Y}' });
    expect(multi!.bindings).toContainEqual({ name: 'w', tex: 'W_q' });
  });

  it('collects trailing shape comments as plain comments', async () => {
    const { ast } = await parsePython(SRC);
    expect(ast.comments.some((c) => c.text === '(B, T, D)')).toBe(true);
  });

  it('never throws on garbage input, reports diagnostics', async () => {
    const res = await parsePython('def broken(:\n  x = = 1\n');
    expect(res.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('handles empty input', async () => {
    const res = await parsePython('');
    expect(res.ast.functions).toEqual([]);
  });
});

describe('reparsePython', () => {
  it('reparses after an edit (may be fresh parse internally)', async () => {
    await initParser();
    const first = await parsePython('def f(x):\n    y = x + 1\n');
    const newSource = 'def f(x):\n    y = x + 2\n';
    const res = await reparsePython(first, newSource, [
      {
        range: { start: { line: 1, character: 12 }, end: { line: 1, character: 13 } },
        newText: '2',
      },
    ]);
    expect(res.ast.source).toBe(newSource);
    expect(res.ast.functions[0]!.qualname).toBe('f');
    expect(res.diagnostics).toEqual([]);
  });
});
