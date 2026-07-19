/**
 * Panel DOM view layer (plan §7 F2, F4, F5).
 *
 * Renders MathDocument sections/blocks into the webview DOM:
 *  - align blocks → display math, typeset PER EQUATION keyed by StableId
 *  - cases / loop / code / prose blocks per kind (code → <pre>)
 *  - section titles + "given …" signature lines
 *  - annotation badges rendered generically from Annotation[] (never
 *    branching on `origin`; styling differs by CSS class only)
 *  - equation click → revealSource; cursorSync highlight bar
 *  - expand/collapse chevrons for call-site lemma refs (F4)
 *  - toolbar (pin, copy LaTeX, export PDF, view-mode toggle)
 *  - two-column literate view (source <pre> left, equation right)
 *
 * The typeset function is injected so tests can run without MathJax.
 */

import type {
  Annotation,
  Block,
  Equation,
  MathDocument,
  MathNode,
  NoteAnnotationPayload,
  PanelState,
  PanelViewMode,
  Section,
  ShapeAnnotationPayload,
  StableId,
  WebviewToHostMessage,
} from '@mathlens/core';

import { PanelDocModel } from './docModel.js';
import {
  buildAnnotationIndex,
  casesTex,
  dimsToTex,
  equationTex,
  loopHeaderTex,
  signatureTex,
  type AnnotationIndex,
  type EquationWithTex,
} from './texEmitter.js';

/** Additive convention (see report): server may attach per-equation source text. */
type EquationWithSource = Equation & { sourceText?: string };

export interface ViewDeps {
  typeset(tex: string, display: boolean): HTMLElement;
  post(message: WebviewToHostMessage): void;
}

function isShapePayload(p: unknown): p is ShapeAnnotationPayload {
  return !!p && typeof p === 'object' && Array.isArray((p as ShapeAnnotationPayload).dims);
}

function isNotePayload(p: unknown): p is NoteAnnotationPayload {
  return !!p && typeof p === 'object' && typeof (p as NoteAnnotationPayload).text === 'string';
}

/** Does this MathNode tree contain a call — i.e. is the equation a call site? */
function containsCall(node: MathNode): boolean {
  if (node.kind === 'call') return true;
  switch (node.kind) {
    case 'frac':
      return containsCall(node.numerator) || containsCall(node.denominator);
    case 'pow':
      return containsCall(node.base) || containsCall(node.exponent);
    case 'sqrt':
      return containsCall(node.radicand) || (node.index ? containsCall(node.index) : false);
    case 'reduction':
      return containsCall(node.body);
    case 'matmul':
      return node.factors.some(containsCall);
    case 'elementwise':
      return containsCall(node.left) || containsCall(node.right);
    case 'transpose':
    case 'inverse':
    case 'norm':
      return containsCall(node.operand);
    case 'subscript':
      return containsCall(node.base);
    case 'tuple':
      return node.elements.some(containsCall);
    case 'matrix':
      return node.rows.some((r) => r.some(containsCall));
    case 'binop':
      return containsCall(node.left) || containsCall(node.right);
    case 'unaryop':
      return containsCall(node.operand);
    case 'compare':
      return containsCall(node.first) || node.rest.some((r) => containsCall(r.operand));
    case 'group':
      return containsCall(node.inner);
    default:
      return false;
  }
}

export class PanelView {
  private highlightedEquationId: StableId | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly model: PanelDocModel,
    private state: PanelState,
    private readonly deps: ViewDeps,
  ) {}

  getState(): PanelState {
    return this.state;
  }

  setState(state: PanelState): void {
    this.state = state;
  }

  // -------------------------------------------------------------------------
  // Full render
  // -------------------------------------------------------------------------

  renderAll(): void {
    this.root.replaceChildren();
    this.root.appendChild(this.renderToolbar());

    const doc = this.model.document;
    const content = document.createElement('div');
    content.className = 'ml-content';
    content.dataset.viewMode = this.state.viewMode;
    this.root.appendChild(content);

    if (!doc || doc.sections.length === 0) {
      content.appendChild(this.renderEmptyState());
      return;
    }
    const annIndex = buildAnnotationIndex(this.model.allAnnotations());
    for (const section of doc.sections) {
      content.appendChild(this.renderSection(section, annIndex));
    }
    if (this.highlightedEquationId) this.applyHighlight(this.highlightedEquationId);
  }

  /** Graceful degradation: empty panel with a message, never a crash. */
  renderMessage(message: string): void {
    this.root.replaceChildren();
    this.root.appendChild(this.renderToolbar());
    const div = document.createElement('div');
    div.className = 'ml-empty';
    div.textContent = message;
    this.root.appendChild(div);
  }

  private renderEmptyState(): HTMLElement {
    const div = document.createElement('div');
    div.className = 'ml-empty';
    div.textContent = 'No math to display. Place the cursor inside a Python function or use "MathLens: Render Selection as Derivation".';
    return div;
  }

  // -------------------------------------------------------------------------
  // Toolbar (F2)
  // -------------------------------------------------------------------------

  private renderToolbar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'ml-toolbar';

    const pinBtn = document.createElement('button');
    pinBtn.className = 'ml-btn ml-pin' + (this.state.pinnedQualname ? ' active' : '');
    pinBtn.title = this.state.pinnedQualname
      ? `Pinned to ${this.state.pinnedQualname} — click to follow cursor`
      : 'Pin panel to current function';
    pinBtn.textContent = this.state.pinnedQualname ? 'Pinned' : 'Pin';
    pinBtn.addEventListener('click', () => {
      const pinnedQualname = this.state.pinnedQualname
        ? undefined
        : this.model.document?.sections[0]?.qualname ?? this.model.document?.sections[0]?.title;
      this.state = { ...this.state, pinnedQualname };
      this.deps.post({ type: 'pinChanged', pinnedQualname });
      this.deps.post({ type: 'stateChanged', state: this.state });
      this.renderAll();
    });

    const copyBtn = document.createElement('button');
    copyBtn.className = 'ml-btn';
    copyBtn.textContent = 'Copy LaTeX';
    copyBtn.title = 'Copy the LaTeX source of the whole document';
    copyBtn.addEventListener('click', () => this.deps.post({ type: 'copyLatex', scope: 'document' }));

    const pdfBtn = document.createElement('button');
    pdfBtn.className = 'ml-btn';
    pdfBtn.textContent = 'Export PDF';
    pdfBtn.title = 'Export the current panel state as a PDF';
    pdfBtn.addEventListener('click', () => this.deps.post({ type: 'exportPdf' }));

    const modeBtn = document.createElement('button');
    modeBtn.className = 'ml-btn';
    modeBtn.textContent = this.state.viewMode === 'derivation' ? 'Two-column' : 'Derivation';
    modeBtn.title = 'Toggle derivation / two-column literate view';
    modeBtn.addEventListener('click', () => {
      const mode: PanelViewMode = this.state.viewMode === 'derivation' ? 'two-column' : 'derivation';
      this.setViewMode(mode);
      this.deps.post({ type: 'viewModeChanged', mode });
      this.deps.post({ type: 'stateChanged', state: this.state });
    });

    bar.append(pinBtn, modeBtn, copyBtn, pdfBtn);
    return bar;
  }

  setViewMode(mode: PanelViewMode): void {
    if (this.state.viewMode === mode) return;
    this.state = { ...this.state, viewMode: mode };
    this.renderAll();
  }

  // -------------------------------------------------------------------------
  // Sections & blocks
  // -------------------------------------------------------------------------

  private renderSection(section: Section, ann: AnnotationIndex): HTMLElement {
    const el = document.createElement('section');
    el.className = `ml-section ml-section-${section.kind}`;
    el.dataset.sectionId = String(section.id);

    const heading = document.createElement('h2');
    heading.className = 'ml-section-title';
    heading.textContent = section.kind === 'lemma' ? `Lemma: ${section.title}` : section.title;
    el.appendChild(heading);

    if (section.prose) {
      const prose = document.createElement('p');
      prose.className = 'ml-section-prose';
      prose.textContent = section.prose;
      el.appendChild(prose);
    }

    if (section.signature) {
      const sigTex = signatureTex(section.signature);
      if (sigTex) {
        const sig = document.createElement('div');
        sig.className = 'ml-signature';
        sig.appendChild(this.deps.typeset(sigTex, false));
        el.appendChild(sig);
      }
    }

    for (const block of section.blocks) {
      el.appendChild(this.renderBlock(block, ann));
    }
    return el;
  }

  private renderBlock(block: Block, ann: AnnotationIndex): HTMLElement {
    switch (block.kind) {
      case 'align': {
        const el = document.createElement('div');
        el.className = 'ml-block ml-align';
        for (const eq of block.equations) {
          el.appendChild(this.renderEquationRow(eq, ann));
        }
        return el;
      }
      case 'cases': {
        const el = document.createElement('div');
        el.className = 'ml-block ml-cases';
        const tex = casesTex(block.subject as EquationWithTex, block.branches, ann);
        el.appendChild(this.renderEquationShell(block.subject, tex, ann));
        return el;
      }
      case 'loop': {
        const el = document.createElement('div');
        el.className = 'ml-block ml-loop';
        const header = document.createElement('div');
        header.className = 'ml-loop-header';
        header.appendChild(this.deps.typeset(loopHeaderTex(block.header, ann), false));
        el.appendChild(header);
        const body = document.createElement('div');
        body.className = 'ml-loop-body';
        for (const child of block.body) body.appendChild(this.renderBlock(child, ann));
        el.appendChild(body);
        return el;
      }
      case 'code': {
        const el = document.createElement('div');
        el.className = 'ml-block ml-code';
        const pre = document.createElement('pre');
        pre.textContent = block.text;
        if (block.reason) pre.title = block.reason;
        el.appendChild(pre);
        return el;
      }
      case 'prose': {
        const el = document.createElement('div');
        el.className = 'ml-block ml-prose';
        const p = document.createElement('p');
        p.textContent = block.text;
        el.appendChild(p);
        return el;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Equations
  // -------------------------------------------------------------------------

  /** Render an equation row (derivation or two-column depending on view mode). */
  private renderEquationRow(eq: Equation, ann: AnnotationIndex): HTMLElement {
    const tex = equationTex(eq as EquationWithTex, ann);
    if (this.state.viewMode === 'two-column') {
      return this.renderTwoColumnRow(eq, tex, ann);
    }
    return this.renderEquationShell(eq, tex, ann);
  }

  /** The common equation container: math, badges, chevron, click sync. */
  private renderEquationShell(eq: Equation, tex: string, ann: AnnotationIndex): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ml-equation';
    row.dataset.equationId = String(eq.id);
    row.dataset.startLine = String(eq.sourceRange.start.line);
    row.dataset.endLine = String(eq.sourceRange.end.line);

    const chevron = this.maybeChevron(eq);
    if (chevron) row.appendChild(chevron);

    const math = document.createElement('div');
    math.className = 'ml-math';
    math.appendChild(this.deps.typeset(tex, true));
    row.appendChild(math);

    if (eq.number) {
      const num = document.createElement('span');
      num.className = 'ml-eq-number';
      num.textContent = eq.number;
      row.appendChild(num);
    }

    const badges = this.renderBadges(eq, ann);
    if (badges) row.appendChild(badges);

    // Panel → editor click sync (F2).
    math.addEventListener('click', () => {
      const uri = this.model.uri;
      if (!uri) return;
      this.deps.post({ type: 'revealSource', uri, equationId: eq.id, range: eq.sourceRange });
    });

    return row;
  }

  /** Two-column literate row: source <pre> left, equation right (F5 panel side). */
  private renderTwoColumnRow(eq: Equation, tex: string, ann: AnnotationIndex): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ml-two-col-row';
    row.dataset.equationId = String(eq.id);

    const left = document.createElement('div');
    left.className = 'ml-col-source';
    const pre = document.createElement('pre');
    const src = (eq as EquationWithSource).sourceText;
    pre.textContent =
      src ?? `# lines ${eq.sourceRange.start.line + 1}–${eq.sourceRange.end.line + 1}`;
    left.appendChild(pre);

    const right = this.renderEquationShell(eq, tex, ann);
    right.classList.add('ml-col-math');

    row.append(left, right);
    return row;
  }

  private maybeChevron(eq: Equation): HTMLElement | undefined {
    const isCallSite = containsCall(eq.rhs) || (eq.lhs ? containsCall(eq.lhs) : false);
    const hasPref = String(eq.id) in this.state.expansions;
    if (!isCallSite && !hasPref) return undefined;
    // Only offer chevrons when a workflow context exists (lemma sections
    // present or an explicit pref recorded) — plain function view keeps quiet.
    const hasLemmas = this.model.document?.sections.some((s) => s.kind === 'lemma') ?? false;
    if (!hasLemmas && !hasPref) return undefined;

    const current = this.state.expansions[eq.id] ?? 'reference';
    const btn = document.createElement('button');
    btn.className = 'ml-chevron';
    btn.textContent = current === 'reference' ? '▸' : '▾';
    btn.title = current === 'reference' ? 'Expand callee inline' : 'Collapse to reference';
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const mode = current === 'reference' ? 'inline' : 'reference';
      this.state = {
        ...this.state,
        expansions: { ...this.state.expansions, [eq.id]: mode },
      };
      this.deps.post({ type: 'toggleExpansion', callSiteEquationId: eq.id, mode });
      this.deps.post({ type: 'stateChanged', state: this.state });
    });
    return btn;
  }

  /**
   * Annotation badges, rendered GENERICALLY from Annotation[] (plan §4.2).
   * Styling differs only via CSS class `ml-badge-<kind>` and
   * `ml-origin-<origin>` — no logic branches on origin.
   */
  private renderBadges(eq: Equation, ann: AnnotationIndex): HTMLElement | undefined {
    const anns = ann.get(String(eq.id)) ?? [];
    if (anns.length === 0) return undefined;
    const wrap = document.createElement('div');
    wrap.className = 'ml-badges';
    for (const a of anns) {
      wrap.appendChild(this.renderBadge(a));
    }
    return wrap;
  }

  private renderBadge(a: Annotation): HTMLElement {
    const badge = document.createElement('span');
    badge.className = `ml-badge ml-badge-${a.kind} ml-origin-${a.origin}`;
    badge.textContent = this.badgeText(a);
    if (isNotePayload(a.payload) && a.payload.severity) {
      badge.classList.add(`ml-severity-${a.payload.severity}`);
    }
    return badge;
  }

  /** Generic, kind-keyed badge text. Unknown kinds render their kind name. */
  private badgeText(a: Annotation): string {
    const p = a.payload;
    switch (a.kind) {
      case 'shape':
        return isShapePayload(p) ? dimsToTex(p.dims).replace(/ \\times /g, '×') : 'shape';
      case 'dtype':
        return typeof (p as { dtype?: string })?.dtype === 'string' ? (p as { dtype: string }).dtype : 'dtype';
      case 'device':
        return typeof (p as { device?: string })?.device === 'string' ? (p as { device: string }).device : 'device';
      case 'note':
        return isNotePayload(p) ? p.text : 'note';
      default:
        return a.kind;
    }
  }

  // -------------------------------------------------------------------------
  // Incremental updates (patch application in docModel; DOM refresh here)
  // -------------------------------------------------------------------------

  /** Re-typeset a single equation in place (patch path, plan §7 F2). */
  refreshEquation(id: StableId): void {
    const eq = this.model.equationById(id);
    const el = this.root.querySelector<HTMLElement>(
      `[data-equation-id="${CSS.escape(String(id))}"]`,
    );
    if (!eq || !el) return;
    const ann = buildAnnotationIndex(this.model.allAnnotations());
    const replacement =
      this.state.viewMode === 'two-column'
        ? this.renderTwoColumnRow(eq, equationTex(eq as EquationWithTex, ann), ann)
        : this.renderEquationShell(eq, equationTex(eq as EquationWithTex, ann), ann);
    el.replaceWith(replacement);
    if (String(this.highlightedEquationId) === String(id)) this.applyHighlight(id);
  }

  /** Re-render one section subtree (structural patch). */
  refreshSection(id: StableId): void {
    const section = this.model.sectionById(id);
    const el = this.root.querySelector<HTMLElement>(`[data-section-id="${CSS.escape(String(id))}"]`);
    const ann = buildAnnotationIndex(this.model.allAnnotations());
    if (section && el) {
      el.replaceWith(this.renderSection(section, ann));
    } else if (section) {
      // New section appended.
      this.root.querySelector('.ml-content')?.appendChild(this.renderSection(section, ann));
    } else if (el) {
      el.remove();
    }
  }

  removeSection(id: StableId): void {
    this.root.querySelector(`[data-section-id="${CSS.escape(String(id))}"]`)?.remove();
  }

  /** Badges only changed: refresh badge strips without re-typesetting math. */
  refreshBadges(): void {
    const ann = buildAnnotationIndex(this.model.allAnnotations());
    for (const el of Array.from(this.root.querySelectorAll<HTMLElement>('.ml-equation'))) {
      const id = el.dataset.equationId;
      if (!id) continue;
      const eq = this.model.equationById(id as StableId);
      if (!eq) continue;
      el.querySelector('.ml-badges')?.remove();
      const badges = this.renderBadges(eq, ann);
      if (badges) el.appendChild(badges);
    }
  }

  // -------------------------------------------------------------------------
  // Cursor sync highlight (editor → panel)
  // -------------------------------------------------------------------------

  highlightLine(line: number): void {
    const eq = this.model.equationAtLine(line);
    this.clearHighlight();
    if (!eq) return;
    this.highlightedEquationId = eq.id;
    this.applyHighlight(eq.id);
  }

  private applyHighlight(id: StableId): void {
    const el = this.root.querySelector<HTMLElement>(
      `[data-equation-id="${CSS.escape(String(id))}"]`,
    );
    if (!el) return;
    el.classList.add('ml-highlight');
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  private clearHighlight(): void {
    this.highlightedEquationId = undefined;
    for (const el of Array.from(this.root.querySelectorAll('.ml-highlight'))) {
      el.classList.remove('ml-highlight');
    }
  }
}
