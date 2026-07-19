/**
 * Annotations — the runtime-readiness contract (plan §4.2, §10).
 *
 * All augmentation of MathIR flows through `Annotation[]` and
 * `AnnotationProvider`. Stretch goals (static shape inference, DAP breakpoint
 * shapes, value/stats badges) are all "new provider, zero translator changes".
 *
 * RULE (enforced in review): no MVP code may branch on `Annotation.origin`.
 *
 * OWNERSHIP: shared contract (see CONTRACTS.md).
 */

import type { Annotation, MathDocument, NoteAnnotationPayload, StableId } from './types.js';

export type { Annotation } from './types.js';

/**
 * A source of annotations for a MathDocument. Implementations:
 * - MVP: `StaticNoteProvider` (directive-sourced notes) — in core.
 * - Stretch S1: `StaticShapeProvider` — in core.
 * - Stretch S2: `DapAnnotationProvider` — lives in the *client* (DAP access),
 *   pushes annotations to the panel over the message bridge (panelProtocol).
 */
export interface AnnotationProvider {
  /** Stable, unique provider name (used for logging / dedup). */
  readonly name: string;
  provide(doc: MathDocument): Promise<Annotation[]>;
}

/** A note attached at translation time from a `# tex-note:` style directive. */
export interface StaticNote {
  target: StableId;
  payload: NoteAnnotationPayload;
}

/**
 * MVP's single provider (plan §4.2): turns directive-sourced notes collected
 * during translation into `note` annotations.
 *
 * TODO(agent A): populate `notes` from `# tex-note:` directives during
 * translation (translate/ hands them over). The provider itself is complete.
 */
export class StaticNoteProvider implements AnnotationProvider {
  readonly name = 'static-note';

  constructor(private readonly notes: readonly StaticNote[] = []) {}

  provide(_doc: MathDocument): Promise<Annotation[]> {
    return Promise.resolve(
      this.notes.map((n) => ({
        target: n.target,
        kind: 'note' as const,
        origin: 'static' as const,
        payload: n.payload,
      })),
    );
  }
}

/**
 * Run all providers and concatenate their annotations. Provider failures are
 * isolated: a throwing provider contributes nothing (graceful degradation,
 * plan principle 3).
 */
export async function collectAnnotations(
  doc: MathDocument,
  providers: readonly AnnotationProvider[],
): Promise<Annotation[]> {
  const results = await Promise.allSettled(providers.map((p) => p.provide(doc)));
  const out: Annotation[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') out.push(...r.value);
  }
  return out;
}
