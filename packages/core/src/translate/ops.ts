/**
 * §6.2 operator table — data-driven, unit-tested row by row, user-extensible
 * via [functions] in mathlens.toml (the NamingEngine handles that layer;
 * unknown calls fall through to \operatorname{f}).
 *
 * Method-call and function-call forms normalize to one internal op before
 * lookup (`x.softmax(-1)` ≡ `torch.softmax(x, -1)`): the translator strips
 * module prefixes and passes the receiver as the first argument.
 *
 * OWNED BY AGENT A.
 */

import type { EffectiveConfig } from '../config/types.js';
import type {
  MathNode,
  MatrixNode,
  RawNode,
  Range,
  ReductionNode,
  SymNode,
} from '../ir/types.js';
import { parseEinsumSpec } from './shapes.js';

/** Helpers the table's build functions may use. Provided by translate/. */
export interface OpBuildContext {
  range: Range;
  config?: EffectiveConfig;
  /** Verbatim-code raw node (\texttt). */
  raw(text: string, reason?: string): RawNode;
  /** Trusted LaTeX math fragment raw node. */
  mathRaw(text: string): RawNode;
  /** Fresh sym node resolved through the naming engine. */
  sym(pythonName: string): SymNode;
}

export interface OpSpec {
  /** Normalized internal operator name. */
  op: string;
  /** All Python spellings that normalize to this op (last dotted segment). */
  aliases: readonly string[];
  /** May be invoked as a method (receiver becomes first argument). */
  methodable?: boolean;
  /**
   * Build the MathNode for this call. `args` are the translated positional
   * arguments (receiver first for method calls); `kwargs` translated keyword
   * arguments. Return undefined to fall through to \operatorname{op}(args).
   */
  build(
    args: MathNode[],
    kwargs: Record<string, MathNode>,
    ctx: OpBuildContext,
  ): MathNode | undefined;
}

// ---------------------------------------------------------------------------
// Small builder helpers
// ---------------------------------------------------------------------------

function builtinCall(op: string, tex: string) {
  return (args: MathNode[], _k: Record<string, MathNode>, ctx: OpBuildContext): MathNode => ({
    kind: 'call',
    op,
    tex,
    display: 'builtin',
    args,
    sourceRange: ctx.range,
  });
}

function operatorCall(op: string, tex?: string) {
  return (args: MathNode[], _k: Record<string, MathNode>, ctx: OpBuildContext): MathNode => ({
    kind: 'call',
    op,
    tex: tex ?? `\\operatorname{${op}}`,
    display: 'operatorname',
    // Drop trailing dim/axis-style integer arguments — softmax(x, -1) ≡
    // softmax(x) mathematically (dims surface via shape annotations instead).
    args: dropDimArgs(args),
    sourceRange: ctx.range,
  });
}

function dropDimArgs(args: MathNode[]): MathNode[] {
  if (args.length < 2) return args;
  const out = [...args];
  while (out.length > 1) {
    const last = out[out.length - 1]!;
    const isIntLike =
      (last.kind === 'num' && /^-?\d+$/.test(last.text)) ||
      (last.kind === 'unaryop' && last.op === 'neg' && last.operand.kind === 'num');
    if (isIntLike) out.pop();
    else break;
  }
  return out;
}

function reductionBuild(op: ReductionNode['op']) {
  return (
    args: MathNode[],
    kwargs: Record<string, MathNode>,
    ctx: OpBuildContext,
  ): MathNode | undefined => {
    if (args.length === 0) return undefined;
    const index = kwargs['dim'] ?? kwargs['axis'] ?? args[1];
    const node: ReductionNode = {
      kind: 'reduction',
      op,
      body: args[0]!,
      sourceRange: ctx.range,
    };
    if (index) node.index = index;
    return node;
  };
}

/** Build Σ_j Σ_l (A_{ij} B_{jl} …) from an einsum pattern — flagship (§6.2). */
export function buildEinsum(
  pattern: string,
  operands: MathNode[],
  ctx: OpBuildContext,
): MathNode | undefined {
  const spec = parseEinsumSpec(pattern);
  if (!spec || spec.operands.length !== operands.length) return undefined;
  // Subscript each operand with its index names.
  const factors: MathNode[] = spec.operands.map((indices, i) => {
    const base = operands[i]!;
    if (indices.length === 0) return base;
    return {
      kind: 'subscript',
      base,
      indices: indices.map((name) => ctx.sym(name)),
      sourceRange: base.sourceRange,
    };
  });
  let body: MathNode =
    factors.length === 1
      ? factors[0]!
      : { kind: 'matmul', factors, sourceRange: ctx.range };
  // Wrap in one reduction per summed index, innermost last-seen.
  for (let i = spec.summed.length - 1; i >= 0; i--) {
    body = {
      kind: 'reduction',
      op: 'sum',
      index: ctx.sym(spec.summed[i]!),
      body,
      sourceRange: ctx.range,
    };
  }
  return body;
}

function matrixFromArgs(
  parts: MathNode[],
  axis: number,
  ctx: OpBuildContext,
): MatrixNode {
  const rows = axis === 1 ? [parts] : parts.map((p) => [p]);
  return { kind: 'matrix', rows, delim: 'bmatrix', sourceRange: ctx.range };
}

function axisOf(kwargs: Record<string, MathNode>, args: MathNode[], argIndex: number): number {
  const node = kwargs['dim'] ?? kwargs['axis'] ?? args[argIndex];
  if (node && node.kind === 'num' && node.text === '1') return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// The table (§6.2, all rows)
// ---------------------------------------------------------------------------

export const OP_TABLE: readonly OpSpec[] = [
  // matmul family → juxtaposition A B (explicit \cdot via config, emit-time)
  {
    op: 'matmul',
    aliases: ['matmul', 'mm', 'bmm', 'dot'],
    methodable: true,
    build: (args, _k, ctx) =>
      args.length >= 2
        ? { kind: 'matmul', factors: args, sourceRange: ctx.range }
        : undefined,
  },
  // transpose
  {
    op: 'transpose',
    aliases: ['transpose', 't'],
    methodable: true,
    build: (args, _k, ctx) =>
      args.length >= 1
        ? { kind: 'transpose', operand: args[0]!, sourceRange: ctx.range }
        : undefined,
  },
  // inverse
  {
    op: 'inverse',
    aliases: ['inv', 'inverse', 'pinv'],
    methodable: true,
    build: (args, _k, ctx) =>
      args.length === 1
        ? { kind: 'inverse', operand: args[0]!, sourceRange: ctx.range }
        : undefined,
  },
  // solve → A^{-1} b (or set form via config)
  {
    op: 'solve',
    aliases: ['solve', 'lstsq'],
    build: (args, _k, ctx) => {
      if (args.length !== 2) return undefined;
      const style = ctx.config?.toml.render?.solveStyle ?? 'inverse';
      if (style === 'setform') {
        return ctx.mathRaw('x : Ax = b');
      }
      return {
        kind: 'matmul',
        factors: [
          { kind: 'inverse', operand: args[0]!, sourceRange: args[0]!.sourceRange },
          args[1]!,
        ],
        sourceRange: ctx.range,
      };
    },
  },
  // norm
  {
    op: 'norm',
    aliases: ['norm'],
    methodable: true,
    build: (args, kwargs, ctx) => {
      if (args.length === 0) return undefined;
      const order = kwargs['p'] ?? kwargs['ord'] ?? args[1];
      const node: MathNode = {
        kind: 'norm',
        operand: args[0]!,
        sourceRange: ctx.range,
      };
      if (order) (node as { order?: MathNode }).order = order;
      return node;
    },
  },
  // reductions
  { op: 'sum', aliases: ['sum', 'nansum'], methodable: true, build: reductionBuild('sum') },
  { op: 'prod', aliases: ['prod'], methodable: true, build: reductionBuild('prod') },
  { op: 'max', aliases: ['max', 'amax', 'maximum'], methodable: true, build: reductionBuild('max') },
  { op: 'min', aliases: ['min', 'amin', 'minimum'], methodable: true, build: reductionBuild('min') },
  // sqrt / exp / log / abs / trig
  {
    op: 'sqrt',
    aliases: ['sqrt', 'rsqrt'],
    methodable: true,
    build: (args, _k, ctx) => {
      if (args.length !== 1) return undefined;
      const s: MathNode = { kind: 'sqrt', radicand: args[0]!, sourceRange: ctx.range };
      return s;
    },
  },
  { op: 'exp', aliases: ['exp'], methodable: true, build: builtinCall('exp', '\\exp') },
  { op: 'log', aliases: ['log'], methodable: true, build: builtinCall('log', '\\log') },
  { op: 'log2', aliases: ['log2'], methodable: true, build: builtinCall('log2', '\\log_2') },
  { op: 'log10', aliases: ['log10'], methodable: true, build: builtinCall('log10', '\\log_{10}') },
  { op: 'sin', aliases: ['sin'], methodable: true, build: builtinCall('sin', '\\sin') },
  { op: 'cos', aliases: ['cos'], methodable: true, build: builtinCall('cos', '\\cos') },
  { op: 'tan', aliases: ['tan'], methodable: true, build: builtinCall('tan', '\\tan') },
  { op: 'sinh', aliases: ['sinh'], methodable: true, build: builtinCall('sinh', '\\sinh') },
  { op: 'cosh', aliases: ['cosh'], methodable: true, build: builtinCall('cosh', '\\cosh') },
  { op: 'tanh', aliases: ['tanh'], methodable: true, build: builtinCall('tanh', '\\tanh') },
  {
    op: 'abs',
    aliases: ['abs', 'absolute', 'fabs'],
    methodable: true,
    build: (args, _k, ctx) =>
      args.length === 1
        ? { kind: 'call', op: 'abs', tex: '', display: 'brackets', args, sourceRange: ctx.range }
        : undefined,
  },
  // softmax / sigmoid family (extensible via [functions] config)
  { op: 'softmax', aliases: ['softmax'], methodable: true, build: operatorCall('softmax') },
  { op: 'log_softmax', aliases: ['log_softmax'], methodable: true, build: operatorCall('log\\_softmax', '\\operatorname{log\\,softmax}') },
  { op: 'sigmoid', aliases: ['sigmoid', 'expit'], methodable: true, build: operatorCall('sigmoid', '\\sigma') },
  { op: 'relu', aliases: ['relu'], methodable: true, build: operatorCall('relu', '\\operatorname{ReLU}') },
  { op: 'gelu', aliases: ['gelu'], methodable: true, build: operatorCall('gelu', '\\operatorname{GELU}') },
  { op: 'silu', aliases: ['silu', 'swish'], methodable: true, build: operatorCall('silu', '\\operatorname{SiLU}') },
  { op: 'logsumexp', aliases: ['logsumexp'], methodable: true, build: operatorCall('logsumexp', '\\operatorname{logsumexp}') },
  { op: 'clamp', aliases: ['clamp', 'clip'], methodable: true, build: operatorCall('clamp', '\\operatorname{clip}') },
  // mean / std / var — blackboard or operator style (config)
  {
    op: 'mean',
    aliases: ['mean', 'average', 'nanmean'],
    methodable: true,
    build: (args, _k, ctx) => {
      if (args.length === 0) return undefined;
      const style = ctx.config?.toml.render?.statsStyle ?? 'blackboard';
      if (style === 'operator') return operatorCall('mean')(args.slice(0, 1), {}, ctx);
      return {
        kind: 'call',
        op: 'mean',
        tex: '\\mathbb{E}',
        display: 'brackets',
        args: args.slice(0, 1),
        sourceRange: ctx.range,
      };
    },
  },
  {
    op: 'std',
    aliases: ['std', 'nanstd'],
    methodable: true,
    build: (args, _k, ctx) => {
      if (args.length === 0) return undefined;
      const style = ctx.config?.toml.render?.statsStyle ?? 'blackboard';
      if (style === 'operator') return operatorCall('std')(args.slice(0, 1), {}, ctx);
      return {
        kind: 'call',
        op: 'std',
        tex: '\\sigma',
        display: 'operatorname',
        args: args.slice(0, 1),
        sourceRange: ctx.range,
      };
    },
  },
  {
    op: 'var',
    aliases: ['var', 'nanvar'],
    methodable: true,
    build: (args, _k, ctx) => {
      if (args.length === 0) return undefined;
      const style = ctx.config?.toml.render?.statsStyle ?? 'blackboard';
      if (style === 'operator') return operatorCall('var')(args.slice(0, 1), {}, ctx);
      return {
        kind: 'call',
        op: 'var',
        tex: '\\operatorname{Var}',
        display: 'brackets',
        args: args.slice(0, 1),
        sourceRange: ctx.range,
      };
    },
  },
  // einsum → expanded explicit sums (flagship)
  {
    op: 'einsum',
    aliases: ['einsum'],
    build: (args, _k, ctx) => {
      if (args.length < 2 || args[0]!.kind !== 'str') return undefined;
      return buildEinsum(args[0]!.text, args.slice(1), ctx);
    },
  },
  // cat / stack → block matrix (axis-aware)
  {
    op: 'cat',
    aliases: ['cat', 'concatenate', 'concat', 'stack', 'vstack', 'hstack'],
    build: (args, kwargs, ctx) => {
      if (args.length === 0) return undefined;
      // torch.cat([a, b], dim=0): first arg is a tuple/list of parts.
      const first = args[0]!;
      const parts = first.kind === 'tuple' ? first.elements : args;
      if (parts.length === 0) return undefined;
      const axis = axisOf(kwargs, args, 1);
      return matrixFromArgs(parts, axis, ctx);
    },
  },
  // zeros / ones / eye / randn
  { op: 'zeros', aliases: ['zeros', 'zeros_like'], build: (_a, _k, ctx) => ctx.mathRaw('\\mathbf{0}') },
  { op: 'ones', aliases: ['ones', 'ones_like'], build: (_a, _k, ctx) => ctx.mathRaw('\\mathbf{1}') },
  { op: 'eye', aliases: ['eye', 'identity'], build: (_a, _k, ctx) => ctx.mathRaw('I') },
  {
    op: 'randn',
    aliases: ['randn', 'randn_like', 'normal'],
    build: (_a, _k, ctx) => ctx.mathRaw('\\mathcal{N}(0, I)'),
  },
];

const byAlias = new Map<string, OpSpec>();
for (const spec of OP_TABLE) {
  for (const alias of spec.aliases) byAlias.set(alias, spec);
}

/** Look up an op row by any alias (case-sensitive, last dotted segment). */
export function lookupOp(name: string): OpSpec | undefined {
  return byAlias.get(name);
}

/** Module roots whose dotted calls are function-style, not method-style. */
export const MODULE_ROOTS = new Set([
  'torch',
  'np',
  'numpy',
  'math',
  'F',
  'nn',
  'jnp',
  'jax',
  'tf',
  'scipy',
  'linalg',
  'functional',
  'einops',
]);
