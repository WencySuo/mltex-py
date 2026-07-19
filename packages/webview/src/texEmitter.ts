/**
 * Webview-local MathIR → TeX emitter (pure; no DOM).
 *
 * NOTE ON RECONCILIATION (see agent C report / CONTRACTS.md discussion):
 * plan §4.1 says "nothing outside emit/ produces LaTeX strings for
 * expressions". Core's `emit/` is agent A's stub and cannot be imported into
 * the browser bundle (core's package `exports` map only exposes
 * ".", "./protocol", "./panelProtocol", and the "." entry pulls node-only
 * parse code at runtime). Until reconciled, the convention is:
 *
 *   - ADDITIVE FIELD CONVENTION: the server MAY attach a pre-emitted
 *     `tex?: string` to any `Equation` (display-math body, no wrapper).
 *     When present the webview uses it verbatim and this module is bypassed.
 *   - Otherwise this fallback emitter walks the MathNode tree. It mirrors
 *     plan §6.2 rendering and must be reconciled with core/emit when agent A
 *     lands it.
 *
 * Annotations are rendered GENERICALLY by kind (plan §4.2): `shape`
 * annotations targeting a symbol occurrence become underbraces
 * (\underbrace{x}_{d \times k}); everything else is left to the DOM badge
 * layer. NO code here branches on `origin`.
 */

// Type-only import from core's root export: erased at compile time, so no
// node-only runtime code enters the browser bundle.
import type {
  Annotation,
  CaseBranch,
  Equation,
  LoopHeader,
  MathNode,
  ShapeAnnotationPayload,
  ShapeDim,
  SignatureLine,
  SignatureParam,
  SubscriptIndex,
} from '@mathlens/core';

/** Additive convention: server may pre-emit tex per equation (see header). */
export type EquationWithTex = Equation & { tex?: string };

/** Escape text for use inside \texttt{...}. */
export function escapeTexttt(text: string): string {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([{}$&#%_])/g, '\\$1')
    .replace(/\^/g, '\\^{}')
    .replace(/~/g, '\\~{}');
}

/** Escape plain prose for \text{...}. */
export function escapeText(text: string): string {
  return text.replace(/([{}$&#%_\\^~])/g, (m) => (m === '\\' ? '\\textbackslash{}' : `\\${m}`));
}

function isShapePayload(p: unknown): p is ShapeAnnotationPayload {
  return !!p && typeof p === 'object' && Array.isArray((p as ShapeAnnotationPayload).dims);
}

export function dimsToTex(dims: ShapeDim[]): string {
  return dims.map((d) => (typeof d === 'number' ? String(d) : escapeText(String(d)))).join(' \\times ');
}

/** Index of annotations by target id (equation StableId or SymbolOccurrenceId). */
export type AnnotationIndex = ReadonlyMap<string, readonly Annotation[]>;

export function buildAnnotationIndex(annotations: readonly Annotation[]): Map<string, Annotation[]> {
  const map = new Map<string, Annotation[]>();
  for (const a of annotations) {
    const key = String(a.target);
    const list = map.get(key);
    if (list) list.push(a);
    else map.set(key, [a]);
  }
  return map;
}

/** True when the node needs parentheses as a tight operand (factor/base). */
function needsParens(node: MathNode): boolean {
  switch (node.kind) {
    case 'binop':
    case 'compare':
    case 'elementwise':
    case 'unaryop':
    case 'reduction':
      return true;
    default:
      return false;
  }
}

function paren(tex: string): string {
  return `\\left( ${tex} \\right)`;
}

const BINOP_TEX: Record<string, string> = {
  '+': ' + ',
  '-': ' - ',
  cdot: ' \\cdot ',
  div: ' \\div ',
  mod: ' \\bmod ',
  floordiv: ' \\,\\mathbin{/\\!/}\\, ',
  and: ' \\land ',
  or: ' \\lor ',
};

const COMPARE_TEX: Record<string, string> = {
  lt: ' < ',
  le: ' \\le ',
  gt: ' > ',
  ge: ' \\ge ',
  eq: ' = ',
  ne: ' \\ne ',
  in: ' \\in ',
  notin: ' \\notin ',
};

const REDUCTION_TEX: Record<string, string> = {
  sum: '\\sum',
  prod: '\\prod',
  max: '\\max',
  min: '\\min',
};

function subscriptIndexTex(idx: SubscriptIndex, ann?: AnnotationIndex): string {
  if ('kind' in idx && idx.kind === 'slice') {
    const start = idx.start ? nodeTex(idx.start, ann) : '';
    const stop = idx.stop ? nodeTex(idx.stop, ann) : '';
    if (!start && !stop) return ':';
    return `${start}:${stop}`;
  }
  return nodeTex(idx as MathNode, ann);
}

/**
 * Emit one MathNode as TeX. `ann` (optional) supplies occurrence-targeted
 * annotations; `shape` ones become underbraces, generically by kind.
 */
export function nodeTex(node: MathNode, ann?: AnnotationIndex): string {
  switch (node.kind) {
    case 'sym': {
      let tex = node.tex;
      const anns = ann?.get(String(node.occurrenceId));
      if (anns) {
        for (const a of anns) {
          if (a.kind === 'shape' && isShapePayload(a.payload)) {
            tex = `\\underbrace{${tex}}_{${dimsToTex(a.payload.dims)}}`;
          }
        }
      }
      return tex;
    }
    case 'num':
      return node.text;
    case 'str':
      return `\\text{${escapeText(node.text)}}`;
    case 'call': {
      // Reserved op '<cases>' (args [value, guard, alt]): inline ternary
      // cases — mirrors core emit (packages/core/src/emit/index.ts).
      if (node.op === '<cases>' && node.args.length === 3) {
        const [value, guard, alt] = node.args as [MathNode, MathNode, MathNode];
        return `\\begin{cases} ${nodeTex(value, ann)} & ${nodeTex(guard, ann)} \\\\ ${nodeTex(alt, ann)} & \\text{otherwise} \\end{cases}`;
      }
      const args = node.args.map((a) => nodeTex(a, ann)).join(', ');
      switch (node.display) {
        case 'brackets':
          return `${node.tex}\\left[ ${args} \\right]`;
        case 'juxtapose':
          return `${node.tex}\\, ${args}`;
        case 'builtin':
        case 'operatorname':
        default:
          return `${node.tex}\\left( ${args} \\right)`;
      }
    }
    case 'frac': {
      const n = nodeTex(node.numerator, ann);
      const d = nodeTex(node.denominator, ann);
      if (node.inline) {
        const np = needsParens(node.numerator) ? paren(n) : n;
        const dp = needsParens(node.denominator) ? paren(d) : d;
        return `${np} / ${dp}`;
      }
      return `\\frac{${n}}{${d}}`;
    }
    case 'pow': {
      const base = nodeTex(node.base, ann);
      const wrapped = needsParens(node.base) || node.base.kind === 'frac' ? paren(base) : base;
      return `${wrapped}^{${nodeTex(node.exponent, ann)}}`;
    }
    case 'sqrt':
      return node.index
        ? `\\sqrt[${nodeTex(node.index, ann)}]{${nodeTex(node.radicand, ann)}}`
        : `\\sqrt{${nodeTex(node.radicand, ann)}}`;
    case 'reduction': {
      const op = REDUCTION_TEX[node.op] ?? '\\sum';
      let limits = '';
      if (node.index && node.lower !== undefined) {
        limits = `_{${nodeTex(node.index, ann)}=${nodeTex(node.lower, ann)}}`;
        if (node.upper !== undefined) limits += `^{${nodeTex(node.upper, ann)}}`;
      } else if (node.index && node.domain) {
        limits = `_{${nodeTex(node.index, ann)} \\in ${nodeTex(node.domain, ann)}}`;
      } else if (node.index) {
        limits = `_{${nodeTex(node.index, ann)}}`;
      } else if (node.domain) {
        limits = `_{${nodeTex(node.domain, ann)}}`;
      }
      const body = nodeTex(node.body, ann);
      const bodyTex = needsParens(node.body) && node.body.kind !== 'reduction' ? paren(body) : body;
      return `${op}${limits} ${bodyTex}`;
    }
    case 'matmul':
      return node.factors
        .map((f) => {
          const t = nodeTex(f, ann);
          return needsParens(f) ? paren(t) : t;
        })
        .join(' ');
    case 'elementwise': {
      const op = node.op === 'div' ? ' \\oslash ' : ' \\odot ';
      const l = nodeTex(node.left, ann);
      const r = nodeTex(node.right, ann);
      return `${needsParens(node.left) ? paren(l) : l}${op}${needsParens(node.right) ? paren(r) : r}`;
    }
    case 'transpose': {
      const t = nodeTex(node.operand, ann);
      return `${needsParens(node.operand) || node.operand.kind === 'matmul' ? paren(t) : t}^{\\top}`;
    }
    case 'inverse': {
      const t = nodeTex(node.operand, ann);
      return `${needsParens(node.operand) || node.operand.kind === 'matmul' ? paren(t) : t}^{-1}`;
    }
    case 'norm': {
      const inner = nodeTex(node.operand, ann);
      const order = node.order ? `_{${nodeTex(node.order, ann)}}` : '';
      return `\\lVert ${inner} \\rVert${order}`;
    }
    case 'subscript': {
      const base = nodeTex(node.base, ann);
      const wrapped = needsParens(node.base) ? paren(base) : base;
      const idx = node.indices.map((i) => subscriptIndexTex(i, ann)).join(', ');
      return `${wrapped}_{${idx}}`;
    }
    case 'tuple':
      return `\\left( ${node.elements.map((e) => nodeTex(e, ann)).join(', ')} \\right)`;
    case 'matrix': {
      const delim = node.delim ?? 'bmatrix';
      const rows = node.rows.map((r) => r.map((c) => nodeTex(c, ann)).join(' & ')).join(' \\\\ ');
      return `\\begin{${delim}} ${rows} \\end{${delim}}`;
    }
    case 'binop': {
      const opTex = BINOP_TEX[node.op] ?? ` \\mathbin{${escapeText(node.op)}} `;
      return `${nodeTex(node.left, ann)}${opTex}${nodeTex(node.right, ann)}`;
    }
    case 'unaryop': {
      const inner = nodeTex(node.operand, ann);
      const wrapped = needsParens(node.operand) ? paren(inner) : inner;
      switch (node.op) {
        case 'neg':
          return `-${wrapped}`;
        case 'pos':
          return `+${wrapped}`;
        case 'not':
          return `\\lnot ${wrapped}`;
      }
      return wrapped;
    }
    case 'compare': {
      let out = nodeTex(node.first, ann);
      for (const { op, operand } of node.rest) {
        out += `${COMPARE_TEX[op] ?? ' = '}${nodeTex(operand, ann)}`;
      }
      return out;
    }
    case 'group':
      return paren(nodeTex(node.inner, ann));
    case 'raw':
      // RawNode.math: trusted LaTeX math fragment, emitted verbatim
      // (CONTRACTS.md additive field) — not \texttt code.
      return node.math ? node.text : `\\texttt{${escapeTexttt(node.text)}}`;
    default: {
      // Graceful degradation (plan §6.5): unknown node kinds render verbatim.
      const unknown = node as { kind: string };
      return `\\texttt{${escapeTexttt(`<${unknown.kind}>`)}}`;
    }
  }
}

/**
 * Emit one Equation as a display-math TeX body (no $$ wrapper).
 * Prefers the additive server-emitted `tex` field when present.
 */
export function equationTex(eq: EquationWithTex, ann?: AnnotationIndex): string {
  if (typeof eq.tex === 'string' && eq.tex.length > 0) return eq.tex;
  const index = ann ?? buildAnnotationIndex(eq.annotations ?? []);
  const rhs = nodeTex(eq.rhs, index);
  // Trailing qualifier (", \quad t = 1, \dots, T") — mirrors core emit.
  const qualifier = eq.qualifier ? `, \\quad ${nodeTex(eq.qualifier, index)}` : '';
  if (!eq.lhs) return `${rhs}${qualifier}`;
  const lhs = nodeTex(eq.lhs, index);
  const rel = eq.relation === '=' ? '=' : eq.relation;
  return `${lhs} ${rel} ${rhs}${qualifier}`;
}

/** Emit a cases block body: subject lhs = \begin{cases} ... \end{cases}. */
export function casesTex(subject: EquationWithTex, branches: readonly CaseBranch[], ann?: AnnotationIndex): string {
  const index = ann ?? buildAnnotationIndex(subject.annotations ?? []);
  const lhs = subject.lhs ? `${nodeTex(subject.lhs, index)} ${subject.relation === '=' ? '=' : subject.relation} ` : '';
  const rows = branches
    .map((b) => {
      const value = nodeTex(b.value, index);
      const guard = b.guard ? nodeTex(b.guard, index) : '\\text{otherwise}';
      return `${value} & ${guard}`;
    })
    .join(' \\\\ ');
  return `${lhs}\\begin{cases} ${rows} \\end{cases}`;
}

/** Emit a loop header as a TeX line: \text{for } t = 1, \dots, T: — mirrors core emit. */
export function loopHeaderTex(header: LoopHeader, ann?: AnnotationIndex): string {
  switch (header.kind) {
    case 'while': {
      const cond = header.condition ? nodeTex(header.condition, ann) : '\\dots';
      return `\\text{while } ${cond}:`;
    }
    case 'if':
      return `\\text{if } ${header.condition ? nodeTex(header.condition, ann) : ''}:`;
    case 'elif':
      return `\\text{else if } ${header.condition ? nodeTex(header.condition, ann) : ''}:`;
    case 'else':
      return '\\text{else:}';
    case 'for': {
      const idx = header.index ? nodeTex(header.index, ann) : 'i';
      if (header.lower !== undefined && header.upper !== undefined) {
        return `\\text{for } ${idx} = ${nodeTex(header.lower!, ann)}, \\dots, ${nodeTex(header.upper!, ann)}:`;
      }
      if (header.iterable) {
        return `\\text{for } ${idx} \\in ${nodeTex(header.iterable, ann)}:`;
      }
      return `\\text{for } ${idx}:`;
    }
    default:
      // Unknown kinds render like 'block' (CONTRACTS.md LoopHeader.kind note).
      return '\\text{block:}';
  }
}

function paramTex(p: SignatureParam): string {
  if (p.dims && p.dims.length > 0) {
    const field = p.dtype && /int/i.test(p.dtype) ? '\\mathbb{Z}' : '\\mathbb{R}';
    return `${p.tex} \\in ${field}^{${dimsToTex(p.dims)}}`;
  }
  if (p.typeText) return `${p.tex} : \\text{${escapeText(p.typeText)}}`;
  return p.tex;
}

/** "given W ∈ ℝ^{d×k}, x ∈ ℝ^d, …" line for a section signature. */
export function signatureTex(sig: SignatureLine): string {
  const parts = sig.params.map(paramTex);
  if (parts.length === 0) return '';
  let out = `\\text{given } ${parts.join(',\\; ')}`;
  if (sig.returns && sig.returns.length > 0) {
    out += ` \\;\\rightarrow\\; ${sig.returns.map(paramTex).join(',\\; ')}`;
  }
  return out;
}
