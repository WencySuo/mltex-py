/**
 * Panel document model — pure logic, no DOM (plan §7 F2).
 *
 * Holds the current MathDocument + annotation store, applies MathPatch
 * updates, and answers "which equations changed?" so the DOM layer
 * re-typesets only those (per-equation MathJax typesetting). Also owns the
 * cursor-line → equation mapping used for editor→panel sync.
 */

import type {
  Annotation,
  Block,
  Equation,
  MathDocument,
  Range,
  Section,
  StableId,
} from '@mathlens/core';
import type { MathPatch } from '@mathlens/core';

export interface PatchOutcome {
  /** Sections added or replaced wholesale — re-render these DOM subtrees. */
  changedSectionIds: StableId[];
  /** Sections removed — remove their DOM subtrees. */
  removedSectionIds: StableId[];
  /** Equations replaced in place — re-typeset only these. */
  changedEquationIds: StableId[];
  /** True when annotations changed (badges refresh; no re-typeset implied). */
  annotationsChanged: boolean;
}

/** Walk every equation in a block tree (loop bodies included). */
export function* equationsInBlocks(blocks: readonly Block[]): Generator<Equation> {
  for (const block of blocks) {
    switch (block.kind) {
      case 'align':
        yield* block.equations;
        break;
      case 'cases':
        yield block.subject;
        break;
      case 'loop':
        yield* equationsInBlocks(block.body);
        break;
      case 'code':
      case 'prose':
        break;
    }
  }
}

export function* equationsInSection(section: Section): Generator<Equation> {
  yield* equationsInBlocks(section.blocks);
}

function containsLine(range: Range, line: number): boolean {
  if (line < range.start.line) return false;
  if (line > range.end.line) return false;
  // End-exclusive ranges that end at character 0 of a line do not include it.
  if (line === range.end.line && range.end.character === 0 && range.start.line !== range.end.line) {
    return false;
  }
  return true;
}

export class PanelDocModel {
  private doc: MathDocument | undefined;
  /** Annotations keyed by source provider name (client pushes are scoped). */
  private annotationsBySource = new Map<string, Annotation[]>();

  get document(): MathDocument | undefined {
    return this.doc;
  }

  get version(): number {
    return this.doc?.version ?? -1;
  }

  get uri(): string | undefined {
    return this.doc?.uri;
  }

  /** Replace the whole document (init message). */
  init(doc: MathDocument, annotations: readonly Annotation[]): void {
    this.doc = doc;
    this.annotationsBySource.clear();
    if (annotations.length > 0) this.annotationsBySource.set('__init__', [...annotations]);
  }

  /**
   * All current annotations, across sources, PLUS annotations embedded on the
   * document's equations (translation attaches shape/note annotations
   * directly to `Equation.annotations`) — deduped structurally so a fact that
   * arrives both embedded and via a push renders once. Renderers never see
   * sources. Equation-embedded annotations live with the doc (refreshed on
   * init/patch); push-source reset semantics apply only to pushed sources.
   */
  allAnnotations(): Annotation[] {
    const out: Annotation[] = [];
    const seen = new Set<string>();
    const keyOf = (a: Annotation): string =>
      `${String(a.target)} ${a.kind} ${a.origin} ${JSON.stringify(a.payload)}`;
    for (const list of this.annotationsBySource.values()) {
      for (const a of list) {
        seen.add(keyOf(a));
        out.push(a);
      }
    }
    // Equation-embedded annotations, deduped against pushed/init sources so a
    // fact arriving both embedded and via the init list renders once.
    if (this.doc) {
      for (const section of this.doc.sections) {
        for (const eq of equationsInSection(section)) {
          for (const a of eq.annotations ?? []) {
            const key = keyOf(a);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(a);
          }
        }
      }
    }
    return out;
  }

  /**
   * Merge a client/server annotation push (panelProtocol `annotations`
   * message). `reset` clears prior annotations from the same source first.
   */
  setAnnotations(source: string, annotations: readonly Annotation[], reset?: boolean): void {
    if (reset) {
      this.annotationsBySource.set(source, [...annotations]);
    } else {
      const existing = this.annotationsBySource.get(source) ?? [];
      this.annotationsBySource.set(source, [...existing, ...annotations]);
    }
  }

  /**
   * Apply an incremental MathPatch (plan §3.4, §4.3). Returns which sections
   * and equations changed so the DOM layer re-typesets only those. Stale
   * patches (older version or different uri) are dropped and return an empty
   * outcome.
   */
  applyPatch(uri: string, version: number, patch: MathPatch): PatchOutcome {
    const empty: PatchOutcome = {
      changedSectionIds: [],
      removedSectionIds: [],
      changedEquationIds: [],
      annotationsChanged: false,
    };
    if (!this.doc || this.doc.uri !== uri || version < this.doc.version) return empty;
    this.doc.version = version;

    const changedSectionIds: StableId[] = [];
    const removedSectionIds: StableId[] = [];
    const changedEquationIds: StableId[] = [];

    const removed = new Set(patch.removedSections.map(String));
    if (removed.size > 0) {
      this.doc.sections = this.doc.sections.filter((s) => {
        if (removed.has(String(s.id))) {
          removedSectionIds.push(s.id);
          return false;
        }
        return true;
      });
    }

    for (const section of [...patch.addedSections, ...patch.updatedSections]) {
      const idx = this.doc.sections.findIndex((s) => String(s.id) === String(section.id));
      if (idx >= 0) this.doc.sections[idx] = section;
      else this.doc.sections.push(section);
      changedSectionIds.push(section.id);
    }

    const changedSectionSet = new Set(changedSectionIds.map(String));
    for (const eqPatch of patch.updatedEquations) {
      // Skip if the containing section was replaced wholesale already.
      if (changedSectionSet.has(String(eqPatch.sectionId))) continue;
      const section = this.doc.sections.find((s) => String(s.id) === String(eqPatch.sectionId));
      if (!section) continue;
      if (this.replaceEquation(section.blocks, eqPatch.equation)) {
        changedEquationIds.push(eqPatch.equation.id);
      }
    }

    let annotationsChanged = false;
    if (patch.annotations && patch.annotations.length > 0) {
      this.setAnnotations('__server__', patch.annotations, true);
      annotationsChanged = true;
    }

    return { changedSectionIds, removedSectionIds, changedEquationIds, annotationsChanged };
  }

  private replaceEquation(blocks: Block[], replacement: Equation): boolean {
    for (const block of blocks) {
      switch (block.kind) {
        case 'align': {
          const idx = block.equations.findIndex((e) => String(e.id) === String(replacement.id));
          if (idx >= 0) {
            block.equations[idx] = replacement;
            return true;
          }
          break;
        }
        case 'cases':
          if (String(block.subject.id) === String(replacement.id)) {
            block.subject = replacement;
            return true;
          }
          break;
        case 'loop':
          if (this.replaceEquation(block.body, replacement)) return true;
          break;
        case 'code':
        case 'prose':
          break;
      }
    }
    return false;
  }

  /** Find the equation whose sourceRange contains the given editor line (F2 sync). */
  equationAtLine(line: number): Equation | undefined {
    if (!this.doc) return undefined;
    let best: Equation | undefined;
    let bestSpan = Number.POSITIVE_INFINITY;
    for (const section of this.doc.sections) {
      for (const eq of equationsInSection(section)) {
        if (containsLine(eq.sourceRange, line)) {
          const span = eq.sourceRange.end.line - eq.sourceRange.start.line;
          if (span < bestSpan) {
            best = eq;
            bestSpan = span;
          }
        }
      }
    }
    return best;
  }

  /** Look up an equation by StableId (panel→editor click sync). */
  equationById(id: StableId): Equation | undefined {
    if (!this.doc) return undefined;
    for (const section of this.doc.sections) {
      for (const eq of equationsInSection(section)) {
        if (String(eq.id) === String(id)) return eq;
      }
    }
    return undefined;
  }

  sectionById(id: StableId): Section | undefined {
    return this.doc?.sections.find((s) => String(s.id) === String(id));
  }
}
