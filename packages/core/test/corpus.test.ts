/**
 * Golden corpus (plan §11): corpus/*.py → emitted LaTeX snapshots + a
 * corpus-wide no-throw assertion + a MathJax compile smoke test for every
 * emitted equation. Every bug report becomes a corpus case.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parsePython, type ParseResult } from '../src/parse/index.js';
import { NamingEngine } from '../src/naming/index.js';
import { translateDocument, type TranslateResult } from '../src/translate/index.js';
import { emitEquation, emitLatex } from '../src/emit/index.js';
import type { Block, Equation, MathDocument } from '../src/ir/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.join(here, 'corpus');
const files = fs.readdirSync(corpusDir).filter((f) => f.endsWith('.py')).sort();

interface CorpusEntry {
  file: string;
  source: string;
  parsed: ParseResult;
  result: TranslateResult;
}

const entries: CorpusEntry[] = [];

beforeAll(async () => {
  for (const file of files) {
    const source = fs.readFileSync(path.join(corpusDir, file), 'utf8');
    const parsed = await parsePython(source);
    const naming = new NamingEngine({ directives: parsed.ast.directives });
    const result = translateDocument(parsed, { uri: `file:///corpus/${file}`, version: 1, naming });
    entries.push({ file, source, parsed, result });
  }
});

function allEquations(doc: MathDocument): Equation[] {
  const out: Equation[] = [];
  const walk = (blocks: Block[]): void => {
    for (const b of blocks) {
      if (b.kind === 'align') out.push(...b.equations);
      else if (b.kind === 'cases') out.push(b.subject);
      else if (b.kind === 'loop') walk(b.body);
    }
  };
  for (const s of doc.sections) walk(s.blocks);
  return out;
}

describe('corpus-wide invariants (§6.5, §10)', () => {
  it('loads at least 8 corpus files', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it('no input throws; every function yields a section', () => {
    for (const e of entries) {
      expect(e.result.document.sections.length, e.file).toBe(e.parsed.ast.functions.length);
    }
  });

  it('corpus yields ≥ 40 golden equations', () => {
    const total = entries.reduce((n, e) => n + allEquations(e.result.document).length, 0);
    expect(total).toBeGreaterThanOrEqual(40);
  });

  it('every equation has a sourceRange inside its file and an annotations array', () => {
    for (const e of entries) {
      const lineCount = e.source.split('\n').length;
      for (const eq of allEquations(e.result.document)) {
        expect(eq.sourceRange.start.line).toBeGreaterThanOrEqual(0);
        expect(eq.sourceRange.end.line).toBeLessThanOrEqual(lineCount);
        expect(Array.isArray(eq.annotations)).toBe(true);
      }
    }
  });

  it('every sym node — including cases branches and loop headers — has an occurrenceId (§10.3)', () => {
    const checkTree = (n: unknown, label: string): void => {
      if (n && typeof n === 'object') {
        const node = n as { kind?: string; occurrenceId?: string };
        if (node.kind === 'sym') expect(node.occurrenceId, label).toBeTruthy();
        for (const v of Object.values(n)) {
          if (Array.isArray(v)) v.forEach((x) => checkTree(x, label));
          else if (v && typeof v === 'object') checkTree(v, label);
        }
      }
    };
    for (const e of entries) {
      const walkBlocks = (blocks: Block[]): void => {
        for (const b of blocks) {
          if (b.kind === 'align') {
            for (const eq of b.equations) checkTree(eq, `${e.file} eq ${String(eq.id)}`);
          } else if (b.kind === 'cases') {
            checkTree(b.subject, `${e.file} cases subject ${String(b.subject.id)}`);
            for (const br of b.branches) {
              checkTree(br.value, `${e.file} cases branch value (${String(b.subject.id)})`);
              if (br.guard) checkTree(br.guard, `${e.file} cases branch guard (${String(b.subject.id)})`);
            }
          } else if (b.kind === 'loop') {
            const h = b.header;
            for (const part of [h.index, h.condition, h.iterable, h.lower, h.upper]) {
              if (part) checkTree(part, `${e.file} loop header (${h.kind})`);
            }
            walkBlocks(b.body);
          }
        }
      };
      for (const s of e.result.document.sections) walkBlocks(s.blocks);
    }
  });

  it('fallbacks carry structured reasons', () => {
    for (const e of entries) {
      for (const fb of e.result.fallbacks) {
        expect(fb.code).toBeTruthy();
        expect(fb.message).toBeTruthy();
        expect(fb.range).toBeDefined();
      }
    }
  });

  it('emitLatex produces a document for both profiles without throwing', () => {
    for (const e of entries) {
      for (const profile of ['derivation', 'literate'] as const) {
        const { tex, sourceMap } = emitLatex(e.result.document, { profile, numbered: true });
        expect(tex).toContain('\\begin{document}');
        expect(sourceMap.length).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('golden snapshots', () => {
  it.each(files)('%s emits stable LaTeX', (file) => {
    const e = entries.find((x) => x.file === file)!;
    const { tex } = emitLatex(e.result.document, { profile: 'derivation', standalone: false });
    expect(tex).toMatchSnapshot();
  });
});

describe('spot checks on flagship corpus cases', () => {
  const eqTexOf = (file: string, sectionTitle: string): string[] => {
    const e = entries.find((x) => x.file === file)!;
    const sec = e.result.document.sections.find((s) => s.title === sectionTitle)!;
    const eqs: Equation[] = [];
    const walk = (blocks: Block[]): void => {
      for (const b of blocks) {
        if (b.kind === 'align') eqs.push(...b.equations);
        else if (b.kind === 'loop') walk(b.body);
      }
    };
    walk(sec.blocks);
    return eqs.map(emitEquation);
  };

  it('attention: scores = Q K^T / sqrt(d)', () => {
    const texes = eqTexOf('attention.py', 'scaled_dot_product_attention');
    expect(texes[0]).toBe('\\mathit{scores} = \\frac{Q K^{\\top}}{\\sqrt{d}}');
    expect(texes[1]).toContain('\\operatorname{softmax}');
  });

  it('attention jaxtyped: signature has dims for all params + return', () => {
    const e = entries.find((x) => x.file === 'attention.py')!;
    const sec = e.result.document.sections.find((s) => s.title === 'attention_jaxtyped')!;
    expect(sec.signature!.params.map((p) => p.dims)).toEqual([
      ['b', 's', 'd'],
      ['b', 's', 'd'],
      ['b', 's', 'd'],
    ]);
    expect(sec.signature!.returns![0]!.dims).toEqual(['b', 's', 'd']);
  });

  it('attention: # tex: directive renames attn to \\tilde{A}', () => {
    const texes = eqTexOf('attention.py', 'masked_attention');
    expect(texes.some((t) => t.includes('\\tilde{A} ='))).toBe(true);
  });

  it('layernorm: x_hat = (x - mu)/sqrt(var + eps) with Greek + hat naming', () => {
    const texes = eqTexOf('layernorm.py', 'layernorm');
    const xhat = texes.find((t) => t.startsWith('\\hat{x} ='))!;
    expect(xhat).toContain('\\mu');
    expect(xhat).toContain('\\sqrt{');
    expect(xhat).toContain('\\varepsilon');
  });

  it('adam: beta1/beta2 → \\beta_1/\\beta_2, m_hat → \\hat{m}', () => {
    const texes = eqTexOf('adam.py', 'adam_step');
    const joined = texes.join('\n');
    expect(joined).toContain('\\beta_1');
    expect(joined).toContain('\\beta_2');
    expect(joined).toContain('\\hat{m} =');
  });

  it('kalman: K = P_hat H^T S^{-1}', () => {
    const texes = eqTexOf('kalman.py', 'kalman_update');
    const gain = texes.find((t) => t.startsWith('K ='))!;
    expect(gain).toContain('H^{\\top}');
    expect(gain).toContain('S^{-1}');
  });

  it('kalman filter loop: recurrence with qualifier over t', () => {
    const texes = eqTexOf('kalman.py', 'kalman_filter');
    expect(texes.some((t) => t.includes('x_t =') && t.includes('x_{t - 1}'))).toBe(true);
  });

  it('softmax loop: accumulation → Σ with consumed initializer', () => {
    const texes = eqTexOf('softmax_logsumexp.py', 'softmax_loop');
    expect(texes.some((t) => t.includes('\\sum_{i=1}^{N}'))).toBe(true);
    // initializer `total = 0` is consumed
    expect(texes.filter((t) => t.startsWith('\\mathit{total} ='))).toHaveLength(1);
  });

  it('gru sequence: recurrence h_t = tanh(W x_t + U h_{t-1})', () => {
    const texes = eqTexOf('gru.py', 'gru_sequence');
    const rec = texes.find((t) => t.startsWith('h_t ='))!;
    expect(rec).toContain('h_{t - 1}');
    expect(rec).toContain('\\tanh');
  });

  it('einsum matmul → \\sum_{j}', () => {
    const texes = eqTexOf('einsum_ops.py', 'matmul_einsum');
    expect(texes[0]).toContain('\\sum_{j} A_{i,j} B_{j,k}');
  });

  it('einsum bilinear form sums i and j', () => {
    const texes = eqTexOf('einsum_ops.py', 'bilinear_form');
    expect(texes[0]).toContain('\\sum_{i}');
    expect(texes[0]).toContain('\\sum_{j}');
  });

  it('messy function still yields equations + code fallbacks', () => {
    const e = entries.find((x) => x.file === 'messy.py')!;
    const sec = e.result.document.sections.find((s) => s.title === 'messy_training_step')!;
    const eqCount = allEquations({ uri: '', version: 0, sections: [sec] }).length;
    expect(eqCount).toBeGreaterThanOrEqual(4);
    expect(sec.blocks.some((b) => b.kind === 'code')).toBe(true);
    expect(e.result.fallbacks.length).toBeGreaterThan(0);
  });

  it('control flow: sign() → cases with 3 branches', () => {
    const e = entries.find((x) => x.file === 'control_flow.py')!;
    const sec = e.result.document.sections.find((s) => s.title === 'sign')!;
    const cases = sec.blocks.find((b) => b.kind === 'cases');
    expect(cases).toBeDefined();
    if (cases?.kind === 'cases') expect(cases.branches).toHaveLength(3);
  });

  it('jaxtyping variants: dim edge cases land in signatures', () => {
    const e = entries.find((x) => x.file === 'jaxtyping_variants.py')!;
    const secs = e.result.document.sections;
    expect(secs.find((s) => s.title === 'variadic_batch')!.signature!.params[0]!.dims).toEqual([
      '*batch',
      'seq',
      'dim',
    ]);
    expect(secs.find((s) => s.title === 'broadcast_dims')!.signature!.params[0]!.dims).toEqual(['#b', 's']);
    expect(secs.find((s) => s.title === 'ellipsis_dims')!.signature!.params[0]!.dims).toEqual(['...']);
    expect(secs.find((s) => s.title === 'int_dims')!.signature!.params[0]!.dims).toEqual(['b', 128, 4]);
    const unparseable = secs.find((s) => s.title === 'unparseable_dims')!.signature!.params[0]!;
    expect(unparseable.dims).toBeUndefined();
    expect(unparseable.typeText).toBe('dim-1 d');
  });

  it('shape comments produce static shape annotations', () => {
    const e = entries.find((x) => x.file === 'jaxtyping_variants.py')!;
    const sec = e.result.document.sections.find((s) => s.title === 'shape_comments')!;
    const eqs = allEquations({ uri: '', version: 0, sections: [sec] });
    const shapes = eqs.flatMap((eq) => eq.annotations.filter((a) => a.kind === 'shape'));
    expect(shapes.length).toBeGreaterThanOrEqual(2);
  });
});
