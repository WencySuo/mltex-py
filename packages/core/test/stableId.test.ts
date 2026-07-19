import { describe, expect, it } from 'vitest';
import {
  computeStableId,
  computeSymbolOccurrenceId,
  fnv1a32,
  type StableIdInput,
} from '../src/ir/stableId.js';

describe('computeStableId', () => {
  const input: StableIdInput = {
    qualname: 'mymodel.attention.forward',
    role: 'assign',
    lhsSymbol: 'attn',
    ordinal: 0,
  };

  it('is deterministic: same input, same id', () => {
    const a = computeStableId(input);
    const b = computeStableId({ ...input });
    expect(a).toBe(b);
  });

  it('matches a pinned value (cross-process/platform determinism lock)', () => {
    // If this test fails, the stable-ID scheme changed — that breaks panel
    // incrementality across server restarts and MUST be coordinated in
    // CONTRACTS.md before landing.
    expect(computeStableId(input)).toBe('mymodel.attention.forward/assign/attn/0-f5ae67b3');
  });

  it('differs when any key component differs', () => {
    const base = computeStableId(input);
    expect(computeStableId({ ...input, qualname: 'other.fn' })).not.toBe(base);
    expect(computeStableId({ ...input, role: 'return' })).not.toBe(base);
    expect(computeStableId({ ...input, lhsSymbol: 'out' })).not.toBe(base);
    expect(computeStableId({ ...input, ordinal: 1 })).not.toBe(base);
  });

  it('handles empty LHS (bare expressions)', () => {
    const id = computeStableId({ qualname: 'f', role: 'expr', lhsSymbol: '', ordinal: 0 });
    expect(id).toContain('/_/');
    expect(id).toBe(computeStableId({ qualname: 'f', role: 'expr', lhsSymbol: '', ordinal: 0 }));
  });

  it('does not collide for a small realistic statement set', () => {
    const ids = new Set<string>();
    const roles = ['assign', 'augassign', 'return', 'expr'] as const;
    for (const qualname of ['a.f', 'a.g', 'b.f', 'MyClass.forward']) {
      for (const role of roles) {
        for (const lhs of ['x', 'y', 'attn', 'h_prev', '']) {
          for (let ordinal = 0; ordinal < 5; ordinal++) {
            ids.add(computeStableId({ qualname, role, lhsSymbol: lhs, ordinal }));
          }
        }
      }
    }
    expect(ids.size).toBe(4 * 4 * 5 * 5);
  });
});

describe('fnv1a32', () => {
  it('matches known FNV-1a vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });
});

describe('computeSymbolOccurrenceId', () => {
  it('is deterministic and embeds the equation id', () => {
    const eq = computeStableId({ qualname: 'f', role: 'assign', lhsSymbol: 'y', ordinal: 0 });
    const occ = computeSymbolOccurrenceId(eq, 2);
    expect(occ).toBe(`${eq}#2`);
    expect(computeSymbolOccurrenceId(eq, 2)).toBe(occ);
  });
});
