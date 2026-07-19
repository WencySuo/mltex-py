/**
 * MathJax tex→svg renderer tests (plan §7 F0: SVG data-URI, theming,
 * preamble macros, failure → reject so callers can fall back).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MATH_COLOR, resetMathJaxCaches, texToSvg } from '../src/render/mathjax.js';

beforeEach(() => resetMathJaxCaches());

describe('texToSvg', () => {
  it('renders display math to an SVG and a base64 data URI', async () => {
    const { svg, dataUri } = await texToSvg('\\hat{\\alpha} = \\frac{Q K^{\\top}}{\\sqrt{d}}');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(dataUri.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const decoded = Buffer.from(dataUri.split(',')[1], 'base64').toString('utf8');
    expect(decoded).toBe(svg);
  });

  it('post-processes fill color for theme adaptation (no currentColor left)', async () => {
    const { svg } = await texToSvg('x + 1', { color: '#c8c8c8' });
    expect(svg).not.toContain('currentColor');
    expect(svg).toContain('#c8c8c8');
    const { svg: defaulted } = await texToSvg('x + 2');
    expect(defaulted).toContain(DEFAULT_MATH_COLOR);
  });

  it('injects user preamble macros (plan §5)', async () => {
    const preamble = '\\newcommand{\\mymac}{\\alpha + \\beta}';
    const { svg } = await texToSvg('\\mymac', { preamble });
    expect(svg.startsWith('<svg')).toBe(true);
    // Without the preamble the macro is undefined → rejection.
    await expect(texToSvg('\\mymacother')).rejects.toThrow();
  });

  it('rejects on TeX errors so callers can fall back to LaTeX source', async () => {
    await expect(texToSvg('\\frac{')).rejects.toThrow(/TeX error/);
  });

  it('is fast warm (< 50 ms budget, plan F0)', async () => {
    await texToSvg('x_i = \\sum_j A_{ij} b_j'); // warmup + cache fill
    const t0 = performance.now();
    await texToSvg('x_i = \\sum_j A_{ij} b_j'); // cached
    await texToSvg('y = W x + b'); // warm converter, uncached
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50);
  });

  it('scales ex-based dimensions', async () => {
    const { svg: normal } = await texToSvg('x');
    const { svg: scaled } = await texToSvg('x', { scale: 2 });
    const w = (s: string) => parseFloat(/width="([\d.]+)ex"/.exec(s)![1]);
    expect(w(scaled)).toBeCloseTo(w(normal) * 2, 1);
  });
});
