/**
 * Emit — MathIR → LaTeX strings (plan §7.3 templates, §4.1 "nothing outside
 * emit/ produces LaTeX strings for expressions").
 *
 * OWNED BY AGENT A.
 *
 * RULE (plan §4.2): annotation rendering NEVER branches on `origin` —
 * shape underbraces and note badges render identically for static and
 * runtime annotations.
 */

import type {
  Annotation,
  Block,
  Equation,
  MathDocument,
  MathNode,
  NoteAnnotationPayload,
  Section,
  ShapeAnnotationPayload,
  ShapeDim,
  SignatureLine,
  StableId,
  SubscriptIndex,
} from '../ir/types.js';

/** Emit profile: 'derivation' one-column; 'literate' two-column (plan §7 F5). */
export type EmitProfile = 'derivation' | 'literate';

export interface EmitOptions {
  profile: EmitProfile;
  /**
   * Produce a complete compilable document (template preamble + body).
   * false → body-only fragment (panel "copy LaTeX"). Default true.
   */
  standalone?: boolean;
  /** Contents of the user preamble file to inject (plan §5). */
  userPreamble?: string;
  /** Number equations and emit \hypertarget anchors per equation id (F4/F5). */
  numbered?: boolean;
}

/** Maps a span of the emitted .tex back to the Equation that produced it (plan §7 F5.3). */
export interface EmitSourceMapEntry {
  equationId: StableId;
  /** Zero-based start/end (exclusive) line in the emitted .tex. */
  texStartLine: number;
  texEndLine: number;
}

export interface EmitResult {
  tex: string;
  /** Emit-time source map: equation ↔ tex lines (compile-error jump, PDF anchors). */
  sourceMap: EmitSourceMapEntry[];
}

// ---------------------------------------------------------------------------
// Expression emission
// ---------------------------------------------------------------------------

/** Precedence levels for parenthesization decisions. */
const enum Prec {
  Atom = 100,
  Unary = 60,
  Pow = 55,
  MatMul = 50,
  Mul = 40,
  Add = 30,
  Compare = 20,
  Bool = 10,
  Lowest = 0,
}

function prec(node: MathNode): number {
  switch (node.kind) {
    case 'binop':
      switch (node.op) {
        case '+':
        case '-':
          return Prec.Add;
        case 'cdot':
        case 'div':
        case 'mod':
        case 'floordiv':
          return Prec.Mul;
        case 'and':
        case 'or':
          return Prec.Bool;
      }
      break;
    case 'unaryop':
      return Prec.Unary;
    case 'compare':
      return Prec.Compare;
    case 'matmul':
    case 'elementwise':
      return Prec.MatMul;
    case 'reduction':
      return Prec.Add; // Σ binds loosely to the right
    default:
      return Prec.Atom;
  }
  return Prec.Atom;
}

function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([%#$&_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

function wrapIf(inner: string, needsParens: boolean): string {
  return needsParens ? `\\left( ${inner} \\right)` : inner;
}

/** Is this node atomic enough for a bare superscript (A^{\top})? */
function isAtomic(node: MathNode): boolean {
  return (
    node.kind === 'sym' ||
    node.kind === 'num' ||
    node.kind === 'group' ||
    (node.kind === 'raw' && node.math === true) ||
    node.kind === 'subscript' ||
    node.kind === 'call'
  );
}

const COMPARE_TEX: Record<string, string> = {
  lt: '<',
  le: '\\le',
  gt: '>',
  ge: '\\ge',
  eq: '=',
  ne: '\\ne',
  in: '\\in',
  notin: '\\notin',
};

const REDUCTION_TEX: Record<string, string> = {
  sum: '\\sum',
  prod: '\\prod',
  max: '\\max',
  min: '\\min',
};

/**
 * Emit one MathNode as an inline LaTeX fragment. Exposed for tests and for
 * signature-line rendering.
 */
export function emitNode(node: MathNode): string {
  switch (node.kind) {
    case 'sym':
      return node.tex;
    case 'num': {
      // 1e-5 → 10^{-5} style; keep plain numbers verbatim.
      const sci = /^(\d+(?:\.\d+)?)[eE]([+-]?\d+)$/.exec(node.text);
      if (sci) {
        const mantissa = sci[1]!;
        const exp = String(Number(sci[2]));
        return mantissa === '1' ? `10^{${exp}}` : `${mantissa} \\times 10^{${exp}}`;
      }
      return node.text;
    }
    case 'str':
      return `\\text{${escapeText(node.text)}}`;
    case 'raw':
      return node.math ? node.text : `\\texttt{${escapeText(node.text)}}`;
    case 'group':
      return `\\left( ${emitNode(node.inner)} \\right)`;
    case 'call': {
      // Reserved op: inline ternary cases (§6.3) — args [value, guard, alt].
      if (node.op === '<cases>' && node.args.length === 3) {
        const [value, guard, alt] = node.args as [MathNode, MathNode, MathNode];
        return `\\begin{cases} ${emitNode(value)} & ${emitNode(guard)} \\\\ ${emitNode(alt)} & \\text{otherwise} \\end{cases}`;
      }
      const args = node.args.map(emitNode).join(', ');
      switch (node.display) {
        case 'brackets':
          if (node.op === 'abs') return `\\lvert ${args} \\rvert`;
          if (node.op === 'len') return `\\lvert ${args} \\rvert`;
          return `${node.tex}\\left[ ${args} \\right]`;
        case 'juxtapose':
          return `${node.tex} ${args}`;
        case 'builtin':
        case 'operatorname':
        default:
          return `${node.tex}\\left( ${args} \\right)`;
      }
    }
    case 'frac':
      if (node.inline) {
        return `${wrapIf(emitNode(node.numerator), prec(node.numerator) < Prec.Mul)} / ${wrapIf(
          emitNode(node.denominator),
          prec(node.denominator) <= Prec.Mul,
        )}`;
      }
      return `\\frac{${emitNode(node.numerator)}}{${emitNode(node.denominator)}}`;
    case 'pow': {
      const base = wrapIf(emitNode(node.base), !isAtomic(node.base));
      return `${base}^{${emitNode(node.exponent)}}`;
    }
    case 'sqrt':
      return node.index
        ? `\\sqrt[${emitNode(node.index)}]{${emitNode(node.radicand)}}`
        : `\\sqrt{${emitNode(node.radicand)}}`;
    case 'reduction': {
      const op = REDUCTION_TEX[node.op] ?? '\\sum';
      let sub = '';
      if (node.index && node.lower) {
        sub = `_{${emitNode(node.index)}=${emitNode(node.lower)}}`;
      } else if (node.index && node.domain) {
        sub = `_{${emitNode(node.index)} \\in ${emitNode(node.domain)}}`;
      } else if (node.index) {
        sub = `_{${emitNode(node.index)}}`;
      } else if (node.domain) {
        sub = `_{${emitNode(node.domain)}}`;
      }
      const sup = node.upper && node.index && node.lower ? `^{${emitNode(node.upper)}}` : '';
      const body = wrapIf(emitNode(node.body), prec(node.body) < Prec.MatMul);
      return `${op}${sub}${sup} ${body}`;
    }
    case 'matmul':
      return node.factors
        .map((f) => wrapIf(emitNode(f), prec(f) < Prec.MatMul))
        .join(' ');
    case 'elementwise': {
      const op = node.op === 'mul' ? '\\odot' : '\\oslash';
      const l = wrapIf(emitNode(node.left), prec(node.left) < Prec.MatMul);
      const r = wrapIf(emitNode(node.right), prec(node.right) < Prec.MatMul);
      return `${l} ${op} ${r}`;
    }
    case 'transpose': {
      const inner = wrapIf(emitNode(node.operand), !isAtomic(node.operand));
      return `${inner}^{\\top}`;
    }
    case 'inverse': {
      const inner = wrapIf(emitNode(node.operand), !isAtomic(node.operand));
      return `${inner}^{-1}`;
    }
    case 'norm': {
      const order = node.order ? `_{${emitNode(node.order)}}` : '';
      return `\\lVert ${emitNode(node.operand)} \\rVert${order}`;
    }
    case 'subscript': {
      const base = wrapIf(emitNode(node.base), !isAtomic(node.base));
      const indices = node.indices.map(emitSubscriptIndex).join(',');
      // single short index → x_i, otherwise x_{i,j}
      const compact = node.indices.length === 1 && indices.length === 1;
      return compact ? `${base}_${indices}` : `${base}_{${indices}}`;
    }
    case 'tuple':
      return `\\left( ${node.elements.map(emitNode).join(', ')} \\right)`;
    case 'matrix': {
      const delim = node.delim ?? 'bmatrix';
      const rows = node.rows.map((r) => r.map(emitNode).join(' & ')).join(' \\\\ ');
      return `\\begin{${delim}} ${rows} \\end{${delim}}`;
    }
    case 'binop': {
      const opTex: Record<string, string> = {
        '+': '+',
        '-': '-',
        cdot: '\\cdot',
        div: '/',
        mod: '\\bmod',
        floordiv: '\\mathbin{//}',
        and: '\\land',
        or: '\\lor',
      };
      const myPrec = prec(node);
      const l = wrapIf(emitNode(node.left), prec(node.left) < myPrec);
      // Right side of `-` needs parens at equal precedence: a - (b - c).
      const rightNeeds =
        prec(node.right) < myPrec || (node.op === '-' && prec(node.right) === myPrec);
      const r = wrapIf(emitNode(node.right), rightNeeds);
      return `${l} ${opTex[node.op] ?? node.op} ${r}`;
    }
    case 'unaryop': {
      const inner = wrapIf(emitNode(node.operand), prec(node.operand) < Prec.Unary);
      if (node.op === 'neg') return `-${inner}`;
      if (node.op === 'pos') return `+${inner}`;
      return `\\lnot ${inner}`;
    }
    case 'compare': {
      let out = emitNode(node.first);
      for (const r of node.rest) {
        out += ` ${COMPARE_TEX[r.op] ?? '='} ${emitNode(r.operand)}`;
      }
      return out;
    }
  }
}

function emitSubscriptIndex(ix: SubscriptIndex): string {
  if ('kind' in ix && ix.kind === 'slice') {
    const start = ix.start ? emitNode(ix.start) : '';
    const stop = ix.stop ? emitNode(ix.stop) : '';
    const step = ix.step ? `:${emitNode(ix.step)}` : '';
    return `${start}:${stop}${step}`;
  }
  return emitNode(ix as MathNode);
}

// ---------------------------------------------------------------------------
// Annotation rendering (generic — NEVER branches on `origin`, §4.2)
// ---------------------------------------------------------------------------

function shapeDimsTex(dims: readonly ShapeDim[]): string {
  return dims
    .map((d) => {
      if (typeof d === 'number') return String(d);
      if (d === '...') return '\\dots';
      if (d.startsWith('*') || d.startsWith('#')) {
        return `\\text{${escapeText(d)}}`;
      }
      return d.length === 1 ? d : `\\text{${escapeText(d)}}`;
    })
    .join(' \\times ');
}

/** Render equation-level annotations. Styling differs by KIND only, never origin. */
function annotationSuffix(annotations: readonly Annotation[]): string {
  const parts: string[] = [];
  for (const a of annotations) {
    if (a.kind === 'shape') {
      const payload = a.payload as ShapeAnnotationPayload;
      if (payload?.dims?.length) {
        parts.push(`\\quad \\scriptstyle (${shapeDimsTex(payload.dims)})`);
      }
    } else if (a.kind === 'note') {
      const payload = a.payload as NoteAnnotationPayload;
      if (payload?.text) {
        parts.push(`\\quad \\text{\\footnotesize ${escapeText(payload.text)}}`);
      }
    } else if (a.kind === 'dtype') {
      const payload = a.payload as { dtype?: string };
      if (payload?.dtype) parts.push(`\\quad \\scriptstyle \\text{${escapeText(payload.dtype)}}`);
    }
    // value/stats/grad/device: rendered by the panel as badges; no tex inline.
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Equation & block emission
// ---------------------------------------------------------------------------

/**
 * Emit a single equation as a display-math LaTeX snippet (no document
 * wrapper) — the hover path (F0) and per-equation panel typesetting.
 */
export function emitEquation(eq: Equation): string {
  return emitEquationBody(eq);
}

function emitEquationBody(eq: Equation): string {
  const lhs = eq.lhs ? `${emitNode(eq.lhs)} ${eq.relation === '=' ? '=' : eq.relation} ` : '';
  const qualifier = eq.qualifier ? `, \\quad ${emitNode(eq.qualifier)}` : '';
  return `${lhs}${emitNode(eq.rhs)}${qualifier}${annotationSuffix(eq.annotations)}`;
}

interface EmitCtx {
  lines: string[];
  sourceMap: EmitSourceMapEntry[];
  numbered: boolean;
  eqCounter: { n: number };
}

function pushEquationLine(ctx: EmitCtx, eq: Equation, body: string, last: boolean): void {
  const start = ctx.lines.length;
  let line = body;
  if (ctx.numbered) {
    ctx.eqCounter.n += 1;
    eq.number = `(${ctx.eqCounter.n})`;
    line = `\\hypertarget{${texSafeId(eq.id)}}{}${line} \\tag{${ctx.eqCounter.n}}`;
  }
  ctx.lines.push(last ? line : `${line} \\\\`);
  ctx.sourceMap.push({ equationId: eq.id, texStartLine: start, texEndLine: ctx.lines.length });
}

function texSafeId(id: StableId): string {
  return String(id).replace(/[^A-Za-z0-9.:-]/g, ':');
}

function emitBlock(block: Block, ctx: EmitCtx, indent = ''): void {
  switch (block.kind) {
    case 'align': {
      if (block.equations.length === 0) return;
      ctx.lines.push(`${indent}\\begin{align*}`);
      block.equations.forEach((eq, i) => {
        const body = emitEquationAligned(eq);
        pushEquationLine(ctx, eq, `${indent}  ${body}`, i === block.equations.length - 1);
      });
      ctx.lines.push(`${indent}\\end{align*}`);
      return;
    }
    case 'cases': {
      const subject = block.subject;
      const branches = block.branches
        .map((b) => {
          const guard = b.guard ? emitNode(b.guard) : '\\text{otherwise}';
          return `${emitNode(b.value)} & ${guard}`;
        })
        .join(' \\\\ ');
      const lhs = subject.lhs ? `${emitNode(subject.lhs)} ${subject.relation} ` : '';
      const start = ctx.lines.length;
      ctx.lines.push(`${indent}\\begin{align*}`);
      let line = `${indent}  ${lhs}\\begin{cases} ${branches} \\end{cases}${annotationSuffix(subject.annotations)}`;
      if (ctx.numbered) {
        ctx.eqCounter.n += 1;
        subject.number = `(${ctx.eqCounter.n})`;
        line = `\\hypertarget{${texSafeId(subject.id)}}{}${line} \\tag{${ctx.eqCounter.n}}`;
      }
      ctx.lines.push(line);
      ctx.lines.push(`${indent}\\end{align*}`);
      ctx.sourceMap.push({
        equationId: subject.id,
        texStartLine: start,
        texEndLine: ctx.lines.length,
      });
      return;
    }
    case 'loop': {
      const h = block.header;
      let label: string;
      switch (h.kind) {
        case 'for': {
          const index = h.index ? emitNode(h.index) : 'i';
          if (h.lower && h.upper) {
            label = `\\text{for } ${index} = ${emitNode(h.lower)}, \\dots, ${emitNode(h.upper)}:`;
          } else if (h.iterable) {
            label = `\\text{for } ${index} \\in ${emitNode(h.iterable)}:`;
          } else {
            label = `\\text{for } ${index}:`;
          }
          break;
        }
        case 'while':
          label = `\\text{while } ${h.condition ? emitNode(h.condition) : ''}:`;
          break;
        case 'if':
          label = `\\text{if } ${h.condition ? emitNode(h.condition) : ''}:`;
          break;
        case 'elif':
          label = `\\text{else if } ${h.condition ? emitNode(h.condition) : ''}:`;
          break;
        case 'else':
          label = '\\text{else:}';
          break;
        default:
          label = '\\text{block:}';
      }
      ctx.lines.push(`${indent}\\[ ${label} \\]`);
      ctx.lines.push(`${indent}\\begin{quote}`);
      for (const b of block.body) emitBlock(b, ctx, `${indent}  `);
      ctx.lines.push(`${indent}\\end{quote}`);
      return;
    }
    case 'code': {
      ctx.lines.push(`${indent}\\begin{verbatim}`);
      for (const l of block.text.split('\n')) ctx.lines.push(l);
      ctx.lines.push(`${indent}\\end{verbatim}`);
      return;
    }
    case 'prose': {
      ctx.lines.push(`${indent}\\textit{${escapeText(block.text)}}`);
      ctx.lines.push('');
      return;
    }
  }
}

function emitEquationAligned(eq: Equation): string {
  const lhs = eq.lhs ? `${emitNode(eq.lhs)} &${eq.relation === '=' ? '=' : `\\mathrel{${eq.relation}}`} ` : '&';
  const qualifier = eq.qualifier ? `, \\quad ${emitNode(eq.qualifier)}` : '';
  return `${lhs}${emitNode(eq.rhs)}${qualifier}${annotationSuffix(eq.annotations)}`;
}

// ---------------------------------------------------------------------------
// Signature line ("given W ∈ ℝ^{d×k}, …" — F8 / §6.1 / §10.4)
// ---------------------------------------------------------------------------

export function emitSignatureLine(sig: SignatureLine): string {
  const parts = sig.params.map((p) => {
    if (p.dims && p.dims.length > 0) {
      const space = p.dtype && !p.dtype.startsWith('float') && p.dtype !== 'real' ? '\\mathbb{Z}' : '\\mathbb{R}';
      return `${p.tex} \\in ${space}^{${shapeDimsTex(p.dims)}}`;
    }
    if (p.typeText) {
      return `${p.tex} : \\texttt{${escapeText(p.typeText)}}`;
    }
    return p.tex;
  });
  return `\\text{given } ${parts.join(',\\; ')}`;
}

// ---------------------------------------------------------------------------
// Section / document emission
// ---------------------------------------------------------------------------

function emitSection(section: Section, ctx: EmitCtx, lemmaNumber?: number): void {
  const title = escapeText(section.title);
  if (section.kind === 'lemma') {
    ctx.lines.push(`\\subsection*{Lemma ${lemmaNumber ?? ''}: ${title}}`);
  } else {
    ctx.lines.push(`\\section*{${title}}`);
  }
  ctx.lines.push(`\\hypertarget{${texSafeId(section.id)}}{}`);
  if (section.prose) {
    ctx.lines.push(section.prose);
    ctx.lines.push('');
  }
  if (section.signature) {
    ctx.lines.push(`\\[ ${emitSignatureLine(section.signature)} \\]`);
  }
  for (const block of section.blocks) emitBlock(block, ctx);
  ctx.lines.push('');
}

function emitLiterateSection(section: Section, ctx: EmitCtx): void {
  const title = escapeText(section.title);
  ctx.lines.push(`\\section*{${title}}`);
  if (section.prose) {
    ctx.lines.push(`\\multicolumn{2}{p{\\textwidth}}{${section.prose}}`);
  }
  ctx.lines.push('\\begin{longtable}{p{0.48\\textwidth} p{0.48\\textwidth}}');
  if (section.signature) {
    ctx.lines.push(` & $${emitSignatureLine(section.signature)}$ \\\\`);
  }
  const emitRow = (block: Block): void => {
    switch (block.kind) {
      case 'align':
        for (const eq of block.equations) {
          const start = ctx.lines.length;
          if (ctx.numbered) {
            ctx.eqCounter.n += 1;
            eq.number = `(${ctx.eqCounter.n})`;
          }
          const left = eq.sourceText
            ? `\\texttt{\\footnotesize ${escapeText(eq.sourceText)}}`
            : `\\texttt{\\footnotesize L${eq.sourceRange.start.line + 1}}`;
          ctx.lines.push(`${left} & $${emitEquationBody(eq)}$ \\\\`);
          ctx.sourceMap.push({ equationId: eq.id, texStartLine: start, texEndLine: ctx.lines.length });
        }
        return;
      case 'cases': {
        const start = ctx.lines.length;
        const branches = block.branches
          .map((b) => `${emitNode(b.value)} & ${b.guard ? emitNode(b.guard) : '\\text{otherwise}'}`)
          .join(' \\\\ ');
        const lhs = block.subject.lhs ? `${emitNode(block.subject.lhs)} = ` : '';
        ctx.lines.push(
          `\\texttt{\\footnotesize L${block.sourceRange.start.line + 1}} & $${lhs}\\begin{cases} ${branches} \\end{cases}$ \\\\`,
        );
        ctx.sourceMap.push({
          equationId: block.subject.id,
          texStartLine: start,
          texEndLine: ctx.lines.length,
        });
        return;
      }
      case 'loop':
        ctx.lines.push(`\\multicolumn{2}{l}{\\textit{loop}} \\\\`);
        for (const b of block.body) emitRow(b);
        return;
      case 'code':
        ctx.lines.push(`\\multicolumn{2}{l}{\\texttt{${escapeText(block.text)}}} \\\\`);
        return;
      case 'prose':
        ctx.lines.push(`\\multicolumn{2}{l}{\\textit{${escapeText(block.text)}}} \\\\`);
        return;
    }
  };
  for (const block of section.blocks) emitRow(block);
  ctx.lines.push('\\end{longtable}');
  ctx.lines.push('');
}

const PREAMBLE_COMMON = [
  '\\documentclass{article}',
  '\\usepackage{amsmath}',
  '\\usepackage{amssymb}',
  '\\usepackage{mathtools}',
  '\\usepackage{listings}',
  '\\usepackage{hyperref}',
];

/**
 * Emit a full LaTeX document (or fragment) for a MathDocument.
 */
export function emitLatex(doc: MathDocument, opts: EmitOptions): EmitResult {
  const standalone = opts.standalone ?? true;
  const numbered = opts.numbered ?? false;
  const ctx: EmitCtx = {
    lines: [],
    sourceMap: [],
    numbered,
    eqCounter: { n: 0 },
  };

  if (standalone) {
    ctx.lines.push(...PREAMBLE_COMMON);
    if (opts.profile === 'literate') ctx.lines.push('\\usepackage{longtable}');
    if (opts.userPreamble) {
      ctx.lines.push('% --- user preamble ---');
      for (const l of opts.userPreamble.split('\n')) ctx.lines.push(l);
      ctx.lines.push('% --- end user preamble ---');
    }
    ctx.lines.push('\\begin{document}');
    ctx.lines.push('');
  }

  // Lemma numbering (plan §7 F4): the main section is 1, so the FIRST lemma
  // is "Lemma 2", the second "Lemma 3", … Pinned by emit.test.ts.
  let lemmaCount = 0;
  for (const section of doc.sections) {
    if (opts.profile === 'literate') {
      emitLiterateSection(section, ctx);
    } else {
      let lemmaNumber: number | undefined;
      if (section.kind === 'lemma') {
        lemmaCount += 1;
        lemmaNumber = lemmaCount + 1; // main section is 1 → first lemma is 2
      }
      emitSection(section, ctx, lemmaNumber);
    }
  }

  if (standalone) {
    ctx.lines.push('\\end{document}');
  }

  return { tex: ctx.lines.join('\n'), sourceMap: ctx.sourceMap };
}
