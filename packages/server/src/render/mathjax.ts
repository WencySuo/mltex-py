/**
 * MathJax tex→svg rendering, shared by hover and tests (plan §3.2).
 *
 * Design (plan §7 F0 latency budget: < 50 ms warm):
 *  - The MathJax document/converter is cached per preamble string — TeX macro
 *    definitions persist inside a TeX input jax, so a preamble change needs a
 *    fresh converter, but the hot path (same preamble) reuses one instance.
 *  - Rendered results are cached in a small LRU keyed by (tex, options).
 *  - Theme adaptation post-processes the SVG: MathJax emits
 *    fill/stroke="currentColor", which does NOT inherit inside a markdown
 *    <img>, so we substitute a concrete mid-tone color (plan F0).
 *
 * OWNED BY AGENT B.
 */

import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor, type LiteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';

export interface TexToSvgOptions {
  /** User preamble macros to inject before typesetting (plan §5). */
  preamble?: string;
  /** Display (block) vs inline math. Default display. */
  display?: boolean;
  /** Scale factor (mathlens.render.displayScale). Default 1. */
  scale?: number;
  /** Foreground color for theme adaptation (post-process SVG fill). */
  color?: string;
}

export interface TexToSvgResult {
  svg: string;
  /** data:image/svg+xml;base64,… URI ready for hover markdown. */
  dataUri: string;
}

/** Mid-tone default that stays legible on both dark and light themes (plan F0). */
export const DEFAULT_MATH_COLOR = '#888888';

interface Converter {
  adaptor: LiteAdaptor;
  doc: ReturnType<typeof mathjax.document>;
}

// One converter per preamble (macros persist in the TeX input state).
const converters = new Map<string, Converter>();

// Small LRU for rendered results (hover re-renders the same equation often).
const RESULT_CACHE_MAX = 200;
const resultCache = new Map<string, TexToSvgResult>();

let handlerRegistered = false;
let sharedAdaptor: LiteAdaptor | undefined;

function getConverter(preamble: string): Converter {
  const existing = converters.get(preamble);
  if (existing) return existing;

  if (!handlerRegistered) {
    sharedAdaptor = liteAdaptor();
    RegisterHTMLHandler(sharedAdaptor);
    handlerRegistered = true;
  }
  const adaptor = sharedAdaptor!;
  // Drop 'noundefined' (renders unknown macros as red text): an undefined
  // macro should reject so hover falls back to LaTeX source (plan §7 F0).
  const tex = new TeX({ packages: AllPackages.filter((p) => p !== 'noundefined') });
  const svg = new SVG({ fontCache: 'local' });
  const doc = mathjax.document('', { InputJax: tex, OutputJax: svg });

  if (preamble.length > 0) {
    // Feed macro definitions through a throwaway conversion; definitions
    // persist in the TeX parse state for subsequent convert() calls.
    // A broken preamble must not poison the converter: errors here render
    // as merror in the throwaway output and are otherwise ignored.
    try {
      doc.convert(preamble, { display: false });
    } catch {
      // ignore — user macros simply won't be available
    }
  }

  const converter: Converter = { adaptor, doc };
  converters.set(preamble, converter);
  return converter;
}

/** Test hook: drop all cached converters and results. */
export function resetMathJaxCaches(): void {
  converters.clear();
  resultCache.clear();
}

function scaleDimension(value: string, scale: number): string {
  return value.replace(/^([\d.]+)ex$/, (_, n: string) => `${(parseFloat(n) * scale).toFixed(3)}ex`);
}

/**
 * Render a TeX string to SVG using mathjax-full in-process.
 * Rejects on conversion errors (including TeX errors surfaced as merror
 * nodes) — callers fall back to showing LaTeX source (plan §7 F0).
 */
export async function texToSvg(tex: string, opts?: TexToSvgOptions): Promise<TexToSvgResult> {
  const preamble = opts?.preamble ?? '';
  const display = opts?.display ?? true;
  const scale = opts?.scale ?? 1;
  const color = opts?.color ?? DEFAULT_MATH_COLOR;

  const cacheKey = JSON.stringify([tex, preamble.length > 0 ? preamble : '', display, scale, color]);
  const cached = resultCache.get(cacheKey);
  if (cached) {
    // refresh LRU position
    resultCache.delete(cacheKey);
    resultCache.set(cacheKey, cached);
    return cached;
  }

  const { adaptor, doc } = getConverter(preamble);
  const node = doc.convert(tex, { display });
  const container = adaptor.outerHTML(node);

  // TeX errors render as <merror>/data-mjx-error rather than throwing.
  if (/data-mjx-error/.test(container)) {
    const match = /data-mjx-error="([^"]*)"/.exec(container);
    throw new Error(`TeX error: ${match?.[1] ?? 'unknown'}`);
  }

  // Strip the <mjx-container> wrapper; keep the bare <svg>.
  const svgMatch = /<svg[\s\S]*<\/svg>/.exec(container);
  if (!svgMatch) throw new Error('MathJax produced no SVG output');
  let svg = svgMatch[0];

  // Theme adaptation: concrete mid-tone color instead of currentColor
  // (currentColor does not inherit into a markdown <img>).
  svg = svg.replace(/currentColor/g, color);

  // Scale the ex-based dimensions.
  if (scale !== 1) {
    svg = svg.replace(/(width|height)="([\d.]+ex)"/g, (_m, attr: string, val: string) => {
      return `${attr}="${scaleDimension(val, scale)}"`;
    });
  }

  // Namespace attribute is required for standalone (data-URI) rendering;
  // MathJax already emits xmlns, but guard anyway.
  if (!svg.includes('xmlns=')) {
    svg = svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
  }

  const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
  const result: TexToSvgResult = { svg, dataUri };

  resultCache.set(cacheKey, result);
  if (resultCache.size > RESULT_CACHE_MAX) {
    const oldest = resultCache.keys().next().value;
    if (oldest !== undefined) resultCache.delete(oldest);
  }
  return result;
}
