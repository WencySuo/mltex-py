import { describe, expect, it } from 'vitest';
import { NamingEngine } from '../src/naming/index.js';
import type { TexDirective } from '../src/parse/index.js';

const r0 = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

function directive(bindings: Array<{ name: string; tex: string }>, line = 0): TexDirective {
  return { kind: 'tex', bindings, raw: '', range: r0, effectiveFromLine: line };
}

describe('NamingEngine heuristics (plan §5.3, table-driven)', () => {
  const cases: Array<[string, string]> = [
    // Greek
    ['sigma', '\\sigma'],
    ['Sigma', '\\Sigma'],
    ['eps', '\\varepsilon'],
    ['epsilon', '\\varepsilon'],
    ['alpha', '\\alpha'],
    ['eta', '\\eta'],
    ['mu', '\\mu'],
    ['Omega', '\\Omega'],
    // Suffix modifiers
    ['x_hat', '\\hat{x}'],
    ['x_bar', '\\bar{x}'],
    ['x_tilde', '\\tilde{x}'],
    ['x_prime', "x'"],
    ['x_star', 'x^{*}'],
    ['alpha_hat', '\\hat{\\alpha}'],
    ['sigma_bar', '\\bar{\\sigma}'],
    // d-prefix differentials
    ['dx', '\\mathrm{d}x'],
    ['dt', '\\mathrm{d}t'],
    ['dtheta', '\\mathrm{d}\\theta'],
    // Trailing digits → subscripts
    ['w1', 'w_1'],
    ['h0', 'h_0'],
    ['x12', 'x_{12}'],
    ['beta1', '\\beta_1'],
    // Short suffixes → text subscripts
    ['h_prev', 'h_{\\text{prev}}'],
    ['x_new', 'x_{\\text{new}}'],
    ['h_t', 'h_t'],
    ['x_i', 'x_i'],
    ['w_2', 'w_2'],
    // Single letters pass through
    ['x', 'x'],
    ['W', 'W'],
    ['Q', 'Q'],
    // Multi-word leftovers → \mathit + escaped underscores
    ['attn_weights_masked', '\\mathit{attn\\_weights\\_masked}'],
    ['running_mean', '\\mathit{running\\_mean}'],
  ];

  it.each(cases)('%s → %s', (py, tex) => {
    const eng = new NamingEngine();
    expect(eng.texFor(py)).toBe(tex);
  });

  it('emits a one-time hint for \\mathit fallbacks', () => {
    const eng = new NamingEngine();
    eng.texFor('attn_weights_masked');
    eng.texFor('attn_weights_masked');
    const hints = eng.hints().filter((h) => h.pythonName === 'attn_weights_masked');
    expect(hints).toHaveLength(1);
    expect(hints[0]!.message).toContain('# tex:');
  });
});

describe('NamingEngine priority chain', () => {
  it('directive beats mapping and heuristics', () => {
    const eng = new NamingEngine({
      directives: [directive([{ name: 'attn', tex: '\\tilde{A}' }], 3)],
      config: { symbols: { attn: 'X_{wrong}' } },
    });
    expect(eng.texFor('attn', 5)).toBe('\\tilde{A}');
    expect(eng.resolve('attn', 5).source).toBe('directive');
  });

  it('multi-binding directives apply file-wide from their line onward', () => {
    const eng = new NamingEngine({
      directives: [directive([{ name: 'w', tex: 'W_q' }, { name: 'attn', tex: '\\tilde{A}' }], 10)],
    });
    expect(eng.texFor('attn', 12)).toBe('\\tilde{A}');
    expect(eng.texFor('w', 12)).toBe('W_q');
    // before the directive line → heuristic
    expect(eng.texFor('w', 2)).toBe('w');
  });

  it('mapping file beats heuristics', () => {
    const eng = new NamingEngine({ config: { symbols: { lr: '\\eta' } } });
    const r = eng.resolve('lr');
    expect(r.tex).toBe('\\eta');
    expect(r.source).toBe('mapping');
  });

  it('later directive rebinds a name', () => {
    const eng = new NamingEngine({
      directives: [
        directive([{ name: 'a', tex: '\\alpha' }], 1),
        directive([{ name: 'a', tex: '\\beta' }], 10),
      ],
    });
    expect(eng.texFor('a', 5)).toBe('\\alpha');
    expect(eng.texFor('a', 15)).toBe('\\beta');
  });
});

describe('NamingEngine collisions (plan §5.4)', () => {
  it('two names mapping to the same TeX get disambiguating subscripts + hint', () => {
    const eng = new NamingEngine({
      config: { symbols: { learning_rate: '\\eta', lr: '\\eta' } },
    });
    expect(eng.texFor('learning_rate')).toBe('\\eta');
    const second = eng.texFor('lr');
    expect(second).toBe('\\eta_{\\text{lr}}');
    expect(eng.hints().some((h) => h.pythonName === 'lr')).toBe(true);
  });

  it('same name resolved twice is stable', () => {
    const eng = new NamingEngine();
    expect(eng.texFor('sigma')).toBe(eng.texFor('sigma'));
  });
});

describe('NamingEngine.texForFunction', () => {
  it('uses [functions] mapping by qualname or short name, else \\operatorname', () => {
    const eng = new NamingEngine({
      config: { functions: { 'mymodel.ops.softmax': '\\operatorname{softmax}' } },
    });
    expect(eng.texForFunction('mymodel.ops.softmax')).toBe('\\operatorname{softmax}');
    expect(eng.texForFunction('my_helper')).toBe('\\operatorname{my\\_helper}');
  });

  it('directives beat the [functions] mapping (plan §5 priority order)', () => {
    const eng = new NamingEngine({
      directives: [directive([{ name: 'softmax', tex: '\\sigma_{\\max}' }], 0)],
      config: { functions: { softmax: '\\operatorname{softmax\\_wrong}' } },
    });
    expect(eng.texForFunction('softmax')).toBe('\\sigma_{\\max}');
    expect(eng.texForFunction('mymodel.ops.softmax')).toBe('\\sigma_{\\max}');
  });
});

describe('directive collision registration (plan §5.4)', () => {
  it('a directive-resolved name registers in texOwners so a mapped name colliding with it gets disambiguated + hinted', () => {
    const eng = new NamingEngine({
      directives: [directive([{ name: 'attn', tex: '\\eta' }], 0)],
      config: { symbols: { lr: '\\eta' } },
    });
    // Directive first claims \eta …
    expect(eng.texFor('attn', 5)).toBe('\\eta');
    // … so the mapped name colliding with it gets a §5.4 subscript + hint.
    expect(eng.texFor('lr', 5)).toBe('\\eta_{\\text{lr}}');
    expect(eng.hints().some((h) => h.pythonName === 'lr')).toBe(true);
  });

  it('a heuristic name colliding with an earlier directive-owned tex is disambiguated', () => {
    const eng = new NamingEngine({
      directives: [directive([{ name: 'scale', tex: 's' }], 0)],
    });
    expect(eng.texFor('scale', 5)).toBe('s');
    expect(eng.texFor('s', 5)).toBe('s_{\\text{s}}');
    expect(eng.hints().some((h) => h.pythonName === 's')).toBe(true);
  });
});
