/**
 * MathIR diffing → MathPatch for the `mathlens/mathUpdated` notification
 * (plan §3.4, §4.3). Pure logic over MathIR values, keyed by StableId — no
 * core dependency beyond the shared types, so it is unit-testable with
 * synthetic MathIR versions.
 *
 * Granularity rules:
 *  - New section id            → addedSections (whole Section).
 *  - Vanished section id       → removedSections (id only).
 *  - Same id, same "skeleton"  → per-equation EquationPatch for each changed
 *    equation (skeleton = the section with every Equation reduced to its id;
 *    structural changes — block kinds, order, equation id sequence, prose,
 *    signature — force a wholesale section update instead).
 *  - Same id, different skeleton → updatedSections (whole Section).
 *
 * OWNED BY AGENT B.
 */

import type {
  Annotation,
  Block,
  Equation,
  MathDocument,
  Section,
  StableId,
} from '@mathlens/core';
import type { EquationPatch, MathPatch } from '@mathlens/core/protocol';

/** Structural deep equality (arrays, plain objects, primitives). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i++) {
      if (!deepEqual(aa[i], bb[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  // undefined-valued keys are equivalent to absent keys
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/** Replace every Equation in a block tree with its id (skeleton form). */
function blockSkeleton(block: Block): unknown {
  switch (block.kind) {
    case 'align':
      return { kind: 'align', equations: block.equations.map((e) => e.id) };
    case 'cases':
      return { ...block, subject: block.subject.id };
    case 'loop':
      return { ...block, body: block.body.map(blockSkeleton) };
    default:
      return block;
  }
}

function sectionSkeleton(section: Section): unknown {
  return { ...section, blocks: section.blocks.map(blockSkeleton) };
}

/** All equations in a section, in document order (align runs, cases subjects, loop bodies). */
export function collectEquations(section: Section): Equation[] {
  const out: Equation[] = [];
  const walk = (blocks: readonly Block[]): void => {
    for (const b of blocks) {
      if (b.kind === 'align') out.push(...b.equations);
      else if (b.kind === 'cases') out.push(b.subject);
      else if (b.kind === 'loop') walk(b.body);
    }
  };
  walk(section.blocks);
  return out;
}

export function emptyPatch(): MathPatch {
  return {
    addedSections: [],
    updatedSections: [],
    removedSections: [],
    updatedEquations: [],
  };
}

export function isEmptyPatch(patch: MathPatch): boolean {
  return (
    patch.addedSections.length === 0 &&
    patch.updatedSections.length === 0 &&
    patch.removedSections.length === 0 &&
    patch.updatedEquations.length === 0 &&
    (patch.annotations === undefined || patch.annotations.length === 0)
  );
}

/**
 * Diff two MathIR documents into a MathPatch. `previous === undefined` means
 * "everything is new". Optionally diffs merged annotation sets: when they
 * differ, the patch carries the full refreshed `next` set.
 */
export function diffMathDocuments(
  previous: MathDocument | undefined,
  next: MathDocument,
  annotations?: { previous: readonly Annotation[]; next: readonly Annotation[] },
): MathPatch {
  const patch = emptyPatch();

  const prevSections = new Map<StableId, Section>(
    (previous?.sections ?? []).map((s) => [s.id, s]),
  );
  const nextIds = new Set<StableId>();

  for (const section of next.sections) {
    nextIds.add(section.id);
    const prev = prevSections.get(section.id);
    if (!prev) {
      patch.addedSections.push(section);
      continue;
    }
    if (deepEqual(prev, section)) continue;

    if (deepEqual(sectionSkeleton(prev), sectionSkeleton(section))) {
      // Same structure — equation-level granularity.
      const prevEqs = new Map(collectEquations(prev).map((e) => [e.id, e]));
      const eqPatches: EquationPatch[] = [];
      for (const eq of collectEquations(section)) {
        const prevEq = prevEqs.get(eq.id);
        if (!prevEq || !deepEqual(prevEq, eq)) {
          eqPatches.push({ sectionId: section.id, equation: eq });
        }
      }
      patch.updatedEquations.push(...eqPatches);
    } else {
      patch.updatedSections.push(section);
    }
  }

  for (const id of prevSections.keys()) {
    if (!nextIds.has(id)) patch.removedSections.push(id);
  }

  if (annotations && !deepEqual(annotations.previous, annotations.next)) {
    patch.annotations = [...annotations.next];
  }

  return patch;
}
