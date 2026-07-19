/**
 * Minimal TOML parser tests for the documented mathlens.toml subset
 * (plan §3.5, §5) + config mapping.
 */

import { describe, expect, it } from 'vitest';
import { parseToml, TomlParseError } from '../src/toml.js';
import { tomlToConfig } from '../src/config.js';

describe('parseToml', () => {
  it('parses the documented mathlens.toml example (plan §5)', () => {
    const text = `
# MathLens project notation
[symbols]
attn_weights_masked = '\\tilde{A}'
lr = '\\eta'

[functions]
"mymodel.ops.softmax" = '\\operatorname{softmax}'

[preamble]
include = "notation.tex"      # user macros
`;
    const table = parseToml(text);
    expect(table).toEqual({
      symbols: { attn_weights_masked: '\\tilde{A}', lr: '\\eta' },
      functions: { 'mymodel.ops.softmax': '\\operatorname{softmax}' },
      preamble: { include: 'notation.tex' },
    });
  });

  it('keeps backslashes intact in literal strings (TeX values)', () => {
    const table = parseToml(`[symbols]\nx = '\\hat{x}'`);
    expect((table.symbols as Record<string, string>).x).toBe('\\hat{x}');
  });

  it('handles basic strings with escapes, numbers, booleans, dotted headers', () => {
    const table = parseToml(
      ['[render]', 'explicitMatmulDot = true', '[expansion]', 'maxDepth = 3', '[a.b]', 'c = "x\\ny"'].join(
        '\n',
      ),
    );
    expect(table).toEqual({
      render: { explicitMatmulDot: true },
      expansion: { maxDepth: 3 },
      a: { b: { c: 'x\ny' } },
    });
  });

  it('throws TomlParseError with a line number on invalid input', () => {
    expect(() => parseToml('[symbols]\nbad value here')).toThrowError(TomlParseError);
    try {
      parseToml('[symbols]\nx = ');
    } catch (e) {
      expect(e).toBeInstanceOf(TomlParseError);
      expect((e as TomlParseError).line).toBe(1);
    }
  });
});

describe('tomlToConfig', () => {
  it('maps known tables and drops unknown keys / wrong types', () => {
    const config = tomlToConfig(
      parseToml(
        [
          '[symbols]',
          "lr = '\\eta'",
          '[render]',
          "elementwiseDefault = 'odot'",
          "solveStyle = 'bogus'",
          '[pdf]',
          "engine = 'latexmk'",
          '[expansion]',
          'maxDepth = 4',
          "defaultMode = 'inline'",
          '[unknown_table]',
          'x = 1',
        ].join('\n'),
      ),
    );
    expect(config.symbols).toEqual({ lr: '\\eta' });
    expect(config.render?.elementwiseDefault).toBe('odot');
    expect(config.render?.solveStyle).toBeUndefined();
    expect(config.pdf?.engine).toBe('latexmk');
    expect(config.expansion).toEqual({ maxDepth: 4, defaultMode: 'inline' });
    expect((config as Record<string, unknown>).unknown_table).toBeUndefined();
  });
});
