/**
 * MathJax smoke test (plan §11): every equation the corpus emits must
 * typeset under mathjax-full without producing a merror node.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import { parsePython } from '../src/parse/index.js';
import { NamingEngine } from '../src/naming/index.js';
import { translateDocument } from '../src/translate/index.js';
import { emitEquation, emitSignatureLine } from '../src/emit/index.js';
import type { Block, Equation, MathDocument, SignatureLine } from '../src/ir/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.join(here, 'corpus');
const files = fs.readdirSync(corpusDir).filter((f) => f.endsWith('.py')).sort();

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
// hypertarget is a hyperref macro MathJax doesn't know — harmless no-op here.
const tex = new TeX({
  packages: AllPackages.filter((p) => p !== 'bussproofs'),
  macros: { hypertarget: ['', 2] },
});
const mjDoc = mathjax.document('', { InputJax: tex, OutputJax: new SVG() });

function compiles(fragment: string): { ok: boolean; error?: string } {
  try {
    const node = mjDoc.convert(fragment, { display: true });
    const html = adaptor.outerHTML(node as Parameters<typeof adaptor.outerHTML>[0]);
    if (html.includes('data-mjx-error')) {
      const m = /data-mjx-error="([^"]*)"/.exec(html);
      return { ok: false, error: m?.[1] ?? 'merror' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface Sample {
  file: string;
  label: string;
  fragment: string;
}

const samples: Sample[] = [];

beforeAll(async () => {
  for (const file of files) {
    const source = fs.readFileSync(path.join(corpusDir, file), 'utf8');
    const parsed = await parsePython(source);
    const naming = new NamingEngine({ directives: parsed.ast.directives });
    const { document } = translateDocument(parsed, { uri: `file:///corpus/${file}`, version: 1, naming });
    collect(document, file);
  }

  function collect(doc: MathDocument, file: string): void {
    const walkEq = (eq: Equation): void => {
      samples.push({ file, label: String(eq.id), fragment: emitEquation(eq) });
    };
    const walkSig = (sig: SignatureLine): void => {
      samples.push({ file, label: 'signature', fragment: emitSignatureLine(sig) });
    };
    const walk = (blocks: Block[]): void => {
      for (const b of blocks) {
        if (b.kind === 'align') b.equations.forEach(walkEq);
        else if (b.kind === 'cases') walkEq(b.subject);
        else if (b.kind === 'loop') walk(b.body);
      }
    };
    for (const s of doc.sections) {
      if (s.signature) walkSig(s.signature);
      walk(s.blocks);
    }
  }
});

describe('MathJax smoke (every emitted equation typesets)', () => {
  it('collects a healthy sample size', () => {
    expect(samples.length).toBeGreaterThanOrEqual(40);
  });

  it('every corpus equation + signature compiles without merror', () => {
    const failures: string[] = [];
    for (const s of samples) {
      const r = compiles(s.fragment);
      if (!r.ok) failures.push(`${s.file} ${s.label}: ${r.error}\n  ${s.fragment}`);
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('the acceptance anchor compiles', () => {
    expect(compiles('\\hat{\\alpha} = \\frac{Q K^{\\top}}{\\sqrt{d}}').ok).toBe(true);
  });
});
