/**
 * F8 — declared-shape ingestion (plan §6.6 Tier 1). Pure syntax:
 *  - jaxtyping annotations: Float[Tensor, "b s d"] → { dims, dtype }
 *  - trailing shape comments: `# (B, T, D)`
 *  - einsum/einops pattern strings: "ij,jk->ik", "b s d -> (b s) d"
 * All normalize to the single `shape` annotation payload (§4.2) /
 * SignatureParam.dims. NO inference, NO propagation.
 *
 * OWNED BY AGENT A.
 */

import type { ShapeDim } from '../ir/types.js';

/** Result of parsing one declared-shape source. */
export interface DeclaredShape {
  dims: ShapeDim[];
  dtype?: string;
  /** Set when the dim string could not be fully parsed → render raw. */
  raw?: string;
}

// ---------------------------------------------------------------------------
// jaxtyping
// ---------------------------------------------------------------------------

/** jaxtyping array-type names → dtype strings (documented core set). */
const JAXTYPING_DTYPES: Record<string, string> = {
  Float: 'float',
  Float16: 'float16',
  Float32: 'float32',
  Float64: 'float64',
  BFloat16: 'bfloat16',
  Int: 'int',
  Int8: 'int8',
  Int16: 'int16',
  Int32: 'int32',
  Int64: 'int64',
  UInt: 'uint',
  UInt8: 'uint8',
  Bool: 'bool',
  Complex: 'complex',
  Complex64: 'complex64',
  Complex128: 'complex128',
  Num: 'number',
  Real: 'real',
  Inexact: 'inexact',
  Integer: 'integer',
  Shaped: '',
  Key: 'key',
};

/**
 * Tokenize a jaxtyping dim string (hand-rolled, plan §6.6):
 * names, ints, `*variadic`, `#broadcast` prefixes, `...` (ellipsis),
 * `name=value` bindings (we keep the name). Anything else → unparseable,
 * caller renders the raw string (fallback discipline §6.5).
 * Returns undefined when unparseable.
 */
export function parseDimString(dimString: string): ShapeDim[] | undefined {
  const dims: ShapeDim[] = [];
  const tokens = dimString.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  for (const tokRaw of tokens) {
    let tok = tokRaw;
    let prefix = '';
    // broadcast (#) and variadic (*) markers, possibly combined (*#name).
    while (tok.startsWith('#') || tok.startsWith('*')) {
      prefix += tok[0];
      tok = tok.slice(1);
    }
    if (tok === '...' || tokRaw === '...') {
      dims.push('...');
      continue;
    }
    // name=value fixed bindings → keep name.
    const eq = tok.indexOf('=');
    if (eq > 0) tok = tok.slice(0, eq);
    if (/^\d+$/.test(tok)) {
      dims.push(prefix ? `${prefix}${tok}` : Number(tok));
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(tok)) {
      dims.push(prefix ? `${prefix}${tok}` : tok);
      continue;
    }
    // symbolic expressions ("dim-1"), anything exotic → unparseable.
    return undefined;
  }
  return dims;
}

/**
 * Parse a jaxtyping annotation expression text, e.g.
 * `Float[Tensor, "batch seq dim"]` or `jaxtyping.Float32[np.ndarray, "*b d"]`.
 * Returns undefined when the text is not a jaxtyping annotation.
 */
export function parseJaxtypingAnnotation(text: string): DeclaredShape | undefined {
  const m = /^(?:[A-Za-z_][A-Za-z0-9_.]*\.)?([A-Za-z][A-Za-z0-9]*)\[\s*[^,\]]+,\s*(['"])(.*?)\2\s*\]$/.exec(
    text.trim(),
  );
  if (!m) return undefined;
  const dtypeName = m[1]!;
  if (!(dtypeName in JAXTYPING_DTYPES)) return undefined;
  const dtype = JAXTYPING_DTYPES[dtypeName] || undefined;
  const dimString = m[3]!;
  const dims = parseDimString(dimString);
  if (dims === undefined) {
    return { dims: [], dtype, raw: dimString };
  }
  return { dims, dtype };
}

// ---------------------------------------------------------------------------
// Trailing shape comments
// ---------------------------------------------------------------------------

/**
 * Parse a trailing shape comment like `(B, T, D)` or `shape: (batch, 128)`.
 * Returns undefined when the comment is not shape-like.
 */
export function parseShapeComment(commentText: string): DeclaredShape | undefined {
  const m = /^(?:shape:?\s*)?\(([^)]*)\)\s*$/.exec(commentText.trim());
  if (!m) return undefined;
  const inner = m[1]!.trim();
  if (!inner) return undefined;
  const parts = inner.split(',').map((p) => p.trim());
  const dims: ShapeDim[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (/^\d+$/.test(p)) dims.push(Number(p));
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) dims.push(p);
    else return undefined;
  }
  if (dims.length === 0) return undefined;
  return { dims };
}

// ---------------------------------------------------------------------------
// einsum / einops patterns
// ---------------------------------------------------------------------------

export interface EinsumSpec {
  /** Per-operand index lists, e.g. [['i','j'], ['j','k']]. */
  operands: string[][];
  /** Output index list, e.g. ['i','k']. Empty for full contraction. */
  output: string[];
  /** Indices summed over (in operands, not in output), in first-seen order. */
  summed: string[];
}

/**
 * Parse an einsum equation string like "ij,jk->ik" (also space-separated
 * einops-style names: "b i j, b j k -> b i k"). Implicit-output form
 * ("ij,jk") derives the output per numpy rules (alphabetical non-repeated).
 * Returns undefined for patterns we do not model ('...' broadcasting).
 */
export function parseEinsumSpec(pattern: string): EinsumSpec | undefined {
  const p = pattern.trim();
  if (p.includes('...')) return undefined; // out of documented core → raw fallback
  const arrow = p.indexOf('->');
  const lhs = arrow >= 0 ? p.slice(0, arrow) : p;
  const rhsText = arrow >= 0 ? p.slice(arrow + 2) : undefined;

  const parseSide = (side: string): string[][] | undefined => {
    const ops: string[][] = [];
    for (const part of side.split(',')) {
      const t = part.trim();
      if (!/^[A-Za-z_ ]*$/.test(t)) return undefined;
      const indices = t.includes(' ')
        ? t.split(/\s+/).filter(Boolean)
        : [...t].filter((c) => c !== ' ');
      ops.push(indices);
    }
    return ops;
  };

  const operands = parseSide(lhs);
  if (!operands || operands.length === 0) return undefined;

  let output: string[];
  if (rhsText !== undefined) {
    const outOps = parseSide(rhsText);
    if (!outOps || outOps.length !== 1) return undefined;
    output = outOps[0]!;
  } else {
    // Implicit output: indices appearing exactly once, sorted alphabetically.
    const counts = new Map<string, number>();
    for (const op of operands) for (const ix of op) counts.set(ix, (counts.get(ix) ?? 0) + 1);
    output = [...counts.entries()]
      .filter(([, n]) => n === 1)
      .map(([ix]) => ix)
      .sort();
  }

  const outSet = new Set(output);
  const summed: string[] = [];
  for (const op of operands) {
    for (const ix of op) {
      if (!outSet.has(ix) && !summed.includes(ix)) summed.push(ix);
    }
  }
  return { operands, output, summed };
}

/**
 * Extract per-operand + result declared shapes from an einsum/einops pattern
 * (the pattern IS a shape declaration, plan §6.6). Index names become dims.
 */
export function einsumDeclaredShapes(
  spec: EinsumSpec,
): { operands: DeclaredShape[]; result: DeclaredShape } {
  return {
    operands: spec.operands.map((op) => ({ dims: [...op] })),
    result: { dims: [...spec.output] },
  };
}

/**
 * Parse an einops rearrange-style pattern "b s d -> (b s) d". Only used for
 * shape declaration of the input operand (grouping on output is kept raw).
 */
export function parseEinopsInputShape(pattern: string): DeclaredShape | undefined {
  const arrow = pattern.indexOf('->');
  if (arrow < 0) return undefined;
  const lhs = pattern.slice(0, arrow).trim();
  if (!/^[A-Za-z_0-9 ]+$/.test(lhs)) return undefined;
  const dims = parseDimString(lhs);
  if (dims === undefined || dims.length === 0) return undefined;
  return { dims };
}
