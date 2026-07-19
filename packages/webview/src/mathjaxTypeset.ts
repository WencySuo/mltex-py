/**
 * MathJax typesetting for the panel (plan §3.1: mathjax-full bundled into the
 * webview). Exposes a per-string `typesetTex()` used PER EQUATION node so
 * patches re-typeset only changed equations (plan §7 F2) — never a full-page
 * typeset pass.
 *
 * Failure mode (plan principle 3): a TeX error renders the raw LaTeX source
 * in a <pre> instead of throwing.
 */

import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { browserAdaptor } from 'mathjax-full/js/adaptors/browserAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
// Individual packages (not AllPackages: keeps the bundle lean and avoids the
// node-only `require` extension).
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';
import 'mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js';
import 'mathjax-full/js/input/tex/noundefined/NoUndefinedConfiguration.js';
import 'mathjax-full/js/input/tex/mathtools/MathtoolsConfiguration.js';

export type TypesetFn = (tex: string, display: boolean) => HTMLElement;

let mjDoc: ReturnType<typeof mathjax.document> | undefined;
let styleInjected = false;

function ensureDoc(): ReturnType<typeof mathjax.document> {
  if (!mjDoc) {
    const adaptor = browserAdaptor();
    RegisterHTMLHandler(adaptor);
    const tex = new TeX({
      packages: ['base', 'ams', 'newcommand', 'noundefined', 'mathtools'],
    });
    const svg = new SVG({ fontCache: 'local' });
    mjDoc = mathjax.document(document, { InputJax: tex, OutputJax: svg });
  }
  return mjDoc;
}

/** Inject MathJax's SVG stylesheet once (fonts, spacing). */
function ensureStyles(doc: ReturnType<typeof mathjax.document>): void {
  if (styleInjected) return;
  const sheet = (doc.outputJax as SVG<HTMLElement, Text, Document>).styleSheet(doc) as unknown as HTMLElement;
  document.head.appendChild(sheet);
  styleInjected = true;
}

/**
 * Typeset one TeX string into a detached HTMLElement. Never throws: on
 * failure returns a <pre class="tex-fallback"> with the raw source.
 */
export function typesetTex(tex: string, display: boolean): HTMLElement {
  try {
    const doc = ensureDoc();
    ensureStyles(doc);
    const node = doc.convert(tex, { display }) as HTMLElement;
    // MathJax renders errors inline as merror; detect and fall back so the
    // user always sees something readable (plan §6.5 fallback discipline).
    if (node.querySelector('[data-mjx-error]')) {
      return fallbackNode(tex);
    }
    return node;
  } catch {
    return fallbackNode(tex);
  }
}

function fallbackNode(tex: string): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'tex-fallback';
  pre.textContent = tex;
  return pre;
}

/**
 * Inject user preamble macros (plan §5): typeset them once in a throwaway
 * conversion so \newcommand definitions register with the TeX input jax.
 */
export function injectPreamble(preamble: string): void {
  if (!preamble.trim()) return;
  try {
    const doc = ensureDoc();
    doc.convert(preamble, { display: false });
  } catch {
    // Bad preamble must not break the panel.
  }
}
