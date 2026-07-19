/**
 * Stable ID computation (plan §4.3).
 *
 * StableId = hash of (enclosing function qualname, statement role, LHS symbol,
 * ordinal among same-LHS statements). It survives edits to *other* lines, so
 * the panel patches only what changed and equation cross-references (F4)
 * stay stable.
 *
 * OWNERSHIP: shared contract (see CONTRACTS.md). Determinism is locked by
 * test/stableId.test.ts — do not change the hash without coordinating.
 */

import type { StableId, SymbolOccurrenceId } from './types.js';

/**
 * The role a statement plays, part of the stable-ID key. Distinguishes e.g.
 * an assignment to `y` from a `return` that we render with LHS `y`.
 */
export type StatementRole =
  | 'assign'
  | 'augassign'
  | 'return'
  | 'expr'
  | 'cases'
  | 'loop'
  | 'signature'
  | 'section';

export interface StableIdInput {
  /**
   * Fully qualified name of the enclosing function, e.g. "mymodel.ops.softmax"
   * or "MyClass.forward". Use '<selection>' for synthetic selection sections.
   */
  qualname: string;
  role: StatementRole;
  /**
   * Python name of the LHS symbol ('' when there is no LHS, e.g. bare
   * expression statements; '(a,b)' style joined names for tuple targets).
   */
  lhsSymbol: string;
  /**
   * Zero-based ordinal of this statement among statements in the same
   * function with the same (role, lhsSymbol) key, in source order.
   * `x = 1; x = x + 1` → ordinals 0 and 1.
   */
  ordinal: number;
}

/** FNV-1a 32-bit — small, fast, deterministic, non-cryptographic. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619, in 32-bit arithmetic without overflow:
    hash = (hash + ((hash << 1) >>> 0) + ((hash << 4) >>> 0) + ((hash << 7) >>> 0) + ((hash << 8) >>> 0) + ((hash << 24) >>> 0)) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Compute the StableId for a statement/equation/section.
 *
 * Deterministic: the same input always yields the same id, across processes
 * and platforms. The id embeds a human-readable prefix for debuggability
 * (`softmax/assign/y/0-a1b2c3d4`) but consumers MUST treat it as opaque.
 */
export function computeStableId(input: StableIdInput): StableId {
  const key = [input.qualname, input.role, input.lhsSymbol, String(input.ordinal)].join('\u0000');
  const hash = fnv1a32(key).toString(16).padStart(8, '0');
  const readable = [input.qualname, input.role, input.lhsSymbol || '_', String(input.ordinal)]
    .join('/')
    .replace(/\s+/g, '_');
  return `${readable}-${hash}` as StableId;
}

/**
 * Compute the id of one symbol occurrence within an equation (plan §10.3).
 *
 * @param equationId  StableId of the containing equation.
 * @param ordinal     Zero-based index of this `sym` node among all `sym`
 *                    nodes of the equation, in pre-order traversal of
 *                    lhs (if present) then rhs.
 */
export function computeSymbolOccurrenceId(
  equationId: StableId,
  ordinal: number,
): SymbolOccurrenceId {
  return `${equationId}#${ordinal}` as SymbolOccurrenceId;
}
