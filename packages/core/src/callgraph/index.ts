/**
 * Call-graph resolution & workflow assembly (plan §6.4, F4).
 *
 * OWNED BY AGENT A.
 * Resolution is syntactic only: same-file first, then workspace-relative
 * imports via tree-sitter over imported files. Never executes user code.
 */

import type { Node as TsNode } from 'web-tree-sitter';
import type { ParseResult } from '../parse/index.js';
import {
  childrenOf,
  translateFunction,
  type TranslateOptions,
} from '../translate/index.js';
import type {
  Block,
  Equation,
  MathDocument,
  MathNode,
  Section,
  StableId,
} from '../ir/types.js';

/** Per-call-site expansion mode (plan §6.4). */
export type ExpansionMode = 'reference' | 'inline';

/**
 * Expansion preferences for one workflow render. Round-trips through
 * `mathlens/workflowMath` and `mathlens/emitLatex` so the PDF matches the
 * panel exactly (plan principle 2).
 */
export interface ExpansionPrefs {
  /** Max expansion depth; cycles always render as references. Default 2. */
  maxDepth: number;
  /** Per-call-site overrides, keyed by the call site's equation StableId. */
  perCallSite: Record<StableId, ExpansionMode>;
  /** Mode for call sites without an override. Default 'reference'. */
  defaultMode: ExpansionMode;
}

export const DEFAULT_EXPANSION_PREFS: ExpansionPrefs = {
  maxDepth: 2,
  perCallSite: {},
  defaultMode: 'reference',
};

/** Provides parsed source for workspace files the callgraph walks into. */
export interface WorkspaceSourceProvider {
  /** Return the parse of the file at `uri`, or undefined if unavailable. */
  getParse(uri: string): Promise<ParseResult | undefined>;
  /** Resolve a Python module path (e.g. "mymodel.ops") to a file uri, syntactically. */
  resolveModule(fromUri: string, modulePath: string): Promise<string | undefined>;
}

export interface WorkflowOptions extends TranslateOptions {
  prefs: ExpansionPrefs;
  workspace: WorkspaceSourceProvider;
}

/** A call site discovered inside a function, for panel chevrons (F4). */
export interface CallSite {
  /** StableId of the equation containing the call. */
  equationId: StableId;
  /** Callee qualname if resolved; undefined → stays \operatorname{f}(x). */
  calleeQualname?: string;
  calleeUri?: string;
}

// ---------------------------------------------------------------------------
// Import scanning (syntactic only, §6.4)
// ---------------------------------------------------------------------------

interface ImportedName {
  /** Local name usable as a bare call in this file. */
  localName: string;
  /** Module path, e.g. "mymodel.ops". */
  modulePath: string;
  /** Original name in the module (differs from localName under `as`). */
  importedName: string;
}

function scanImports(parsed: ParseResult): ImportedName[] {
  const out: ImportedName[] = [];
  const tree = parsed.ast.tree as { rootNode: TsNode } | undefined;
  if (!tree) return out;
  const visit = (node: TsNode): void => {
    if (node.type === 'import_from_statement') {
      const moduleNode = node.childForFieldName('module_name');
      const modulePath = moduleNode?.text;
      if (modulePath) {
        for (const child of node.namedChildren) {
          if (!child || child.id === moduleNode?.id) continue;
          if (child.type === 'dotted_name') {
            out.push({ localName: child.text, modulePath, importedName: child.text });
          } else if (child.type === 'aliased_import') {
            const name = child.childForFieldName('name')?.text;
            const alias = child.childForFieldName('alias')?.text;
            if (name) out.push({ localName: alias ?? name, modulePath, importedName: name });
          }
        }
      }
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(tree.rootNode);
  return out;
}

// ---------------------------------------------------------------------------
// Call-site discovery
// ---------------------------------------------------------------------------

interface ResolvedCallee {
  qualname: string;
  uri: string;
  parsed: ParseResult;
  /** Bare name used at the call site (naming-engine key for the call node). */
  callName: string;
}

interface DiscoveredSite extends CallSite {
  equation: Equation;
  callee?: ResolvedCallee;
  /** Argument nodes at the call site (translated MathNodes). */
  args: MathNode[];
}

function callNodesIn(node: MathNode): Array<Extract<MathNode, { kind: 'call' }>> {
  const out: Array<Extract<MathNode, { kind: 'call' }>> = [];
  const visit = (n: MathNode): void => {
    if (n.kind === 'call') out.push(n);
    for (const c of childrenOf(n)) visit(c);
  };
  visit(node);
  return out;
}

function equationsOf(section: Section): Equation[] {
  const out: Equation[] = [];
  const walk = (blocks: Block[]): void => {
    for (const b of blocks) {
      if (b.kind === 'align') out.push(...b.equations);
      else if (b.kind === 'cases') out.push(b.subject);
      else if (b.kind === 'loop') walk(b.body);
    }
  };
  walk(section.blocks);
  return out;
}

async function resolveCallee(
  name: string,
  fromUri: string,
  parsed: ParseResult,
  imports: readonly ImportedName[],
  enclosingQualname: string,
  workspace: WorkspaceSourceProvider,
): Promise<ResolvedCallee | undefined> {
  // Same-file first (§6.4). Prefer a sibling method (Class.name) when the
  // caller is a method, then any function whose qualname tail matches.
  const cls = enclosingQualname.includes('.')
    ? enclosingQualname.slice(0, enclosingQualname.lastIndexOf('.'))
    : undefined;
  const local =
    (cls && parsed.ast.functions.find((f) => f.qualname === `${cls}.${name}`)) ||
    parsed.ast.functions.find((f) => f.qualname === name) ||
    parsed.ast.functions.find((f) => f.name === name && !f.qualname.includes('.'));
  if (local && local.qualname !== enclosingQualname) {
    return { qualname: local.qualname, uri: fromUri, parsed, callName: name };
  }
  // Workspace-relative imports, resolved syntactically.
  const imp = imports.find((i) => i.localName === name);
  if (imp) {
    try {
      const uri = await workspace.resolveModule(fromUri, imp.modulePath);
      if (!uri) return undefined;
      const calleeParse = await workspace.getParse(uri);
      if (!calleeParse) return undefined;
      const fn = calleeParse.ast.functions.find((f) => f.qualname === imp.importedName || f.name === imp.importedName);
      if (!fn) return undefined;
      return { qualname: fn.qualname, uri, parsed: calleeParse, callName: name };
    } catch {
      return undefined; // unresolvable → stays \operatorname{f}(x)
    }
  }
  return undefined;
}

async function discoverSites(
  parsed: ParseResult,
  qualname: string,
  uri: string,
  section: Section,
  workspace: WorkspaceSourceProvider,
): Promise<DiscoveredSite[]> {
  const imports = scanImports(parsed);
  const sites: DiscoveredSite[] = [];
  for (const eq of equationsOf(section)) {
    const calls = [
      ...(eq.lhs ? callNodesIn(eq.lhs) : []),
      ...callNodesIn(eq.rhs),
    ];
    for (const call of calls) {
      // Skip table ops (already rendered as math) — only \operatorname calls
      // that kept their python name are candidate call sites.
      if (call.display !== 'operatorname' || !call.tex.startsWith('\\operatorname')) continue;
      const callee = await resolveCallee(call.op, uri, parsed, imports, qualname, workspace);
      const site: DiscoveredSite = {
        equationId: eq.id,
        equation: eq,
        args: call.args,
      };
      if (callee) {
        site.callee = callee;
        site.calleeQualname = callee.qualname;
        site.calleeUri = callee.uri;
      }
      sites.push(site);
    }
  }
  return sites;
}

// ---------------------------------------------------------------------------
// Public: findCallSites
// ---------------------------------------------------------------------------

/**
 * List resolvable call sites within a function (used by the panel to render
 * expand/collapse chevrons before a full workflow build).
 */
export async function findCallSites(
  parsed: ParseResult,
  qualname: string,
  workspace: WorkspaceSourceProvider,
): Promise<CallSite[]> {
  try {
    const { NamingEngine } = await import('../naming/index.js');
    const naming = new NamingEngine({ directives: parsed.ast.directives });
    const section = translateFunction(parsed, qualname, { uri: 'file:///<callgraph>', version: 0, naming });
    if (!section) return [];
    const sites = await discoverSites(parsed, qualname, 'file:///<callgraph>', section, workspace);
    return sites
      .filter((s) => s.calleeQualname !== undefined)
      .map(({ equationId, calleeQualname, calleeUri }) => {
        const site: CallSite = { equationId };
        if (calleeQualname !== undefined) site.calleeQualname = calleeQualname;
        if (calleeUri !== undefined) site.calleeUri = calleeUri;
        return site;
      });
  } catch {
    return []; // discovery is best-effort; never throws (§6.5 spirit)
  }
}

// ---------------------------------------------------------------------------
// Public: buildWorkflow
// ---------------------------------------------------------------------------

interface WorkflowState {
  /** callee key (uri#qualname) → lemma Section (duplicate callee → one lemma). */
  lemmas: Map<string, Section>;
  /** Qualnames on the current expansion path (cycle detection). */
  path: Set<string>;
  options: WorkflowOptions;
}

/**
 * Build the workflow MathDocument for a top-level function: main function as
 * Section 1, referenced callees as numbered `lemma` Sections, inline call
 * sites substituted with α-renamed arguments (plan §6.4).
 */
export async function buildWorkflow(
  entry: ParseResult,
  entryQualname: string,
  options: WorkflowOptions,
): Promise<MathDocument> {
  const doc: MathDocument = { uri: options.uri, version: options.version, sections: [] };
  const main = translateFunction(entry, entryQualname, options);
  if (!main) return doc;
  doc.sections.push(main);

  const state: WorkflowState = {
    lemmas: new Map(),
    path: new Set([entryQualname]),
    options,
  };
  try {
    await expandSection(main, entry, entryQualname, options.uri, 0, state);
  } catch {
    // Expansion is best-effort; the main section always renders (§6.5).
  }
  doc.sections.push(...state.lemmas.values());
  return doc;
}

async function expandSection(
  section: Section,
  parsed: ParseResult,
  qualname: string,
  uri: string,
  depth: number,
  state: WorkflowState,
): Promise<void> {
  const { prefs, workspace } = state.options;
  if (depth >= prefs.maxDepth) return;
  const sites = await discoverSites(parsed, qualname, uri, section, workspace);
  for (const site of sites) {
    const callee = site.callee;
    if (!callee) continue;
    const key = `${callee.uri}#${callee.qualname}`;
    const isCycle = state.path.has(callee.qualname);
    const mode: ExpansionMode = isCycle
      ? 'reference' // cycles always reference (§6.4)
      : prefs.perCallSite[site.equationId] ?? prefs.defaultMode;

    if (mode === 'inline' && !isCycle) {
      inlineInto(section, site, callee, state);
      continue;
    }

    // Reference mode: one lemma per callee, call site keeps \operatorname +
    // a note annotation carrying the reference (equation numbers are assigned
    // at emit time; the panel links via the lemma section id).
    if (!state.lemmas.has(key) && !isCycle) {
      const lemma = translateFunction(callee.parsed, callee.qualname, state.options);
      if (lemma) {
        lemma.kind = 'lemma';
        state.lemmas.set(key, lemma);
        state.path.add(callee.qualname);
        try {
          await expandSection(lemma, callee.parsed, callee.qualname, callee.uri, depth + 1, state);
        } finally {
          state.path.delete(callee.qualname);
        }
      }
    }
    const lemma = state.lemmas.get(key);
    if (lemma) {
      site.equation.annotations.push({
        target: site.equationId,
        kind: 'note',
        origin: 'static',
        payload: { text: `see ${lemma.title}`, severity: 'info' },
      });
    }
  }
}

/**
 * Inline mode (§6.4): callee body substituted after the call-site equation,
 * with parameter → argument `\mapsto` bindings shown once. α-renaming happens
 * through the shared NamingEngine (collisions get disambiguating subscripts).
 */
function inlineInto(
  section: Section,
  site: DiscoveredSite,
  callee: ResolvedCallee,
  state: WorkflowState,
): void {
  const inlined = translateFunction(callee.parsed, callee.qualname, state.options);
  if (!inlined) return;

  // Parameter ↦ argument bindings, shown once as a prose block.
  const params = inlined.signature?.params ?? [];
  const bindings: string[] = [];
  for (let i = 0; i < Math.min(params.length, site.args.length); i++) {
    const arg = site.args[i]!;
    const argText = arg.kind === 'sym' ? arg.pythonName : sourceTextOf(arg);
    bindings.push(`${params[i]!.pythonName} ↦ ${argText}`);
  }
  const blocks: Block[] = [];
  blocks.push({
    kind: 'prose',
    text:
      bindings.length > 0
        ? `inlining ${inlined.title}: ${bindings.join(', ')}`
        : `inlining ${inlined.title}`,
    sourceRange: site.equation.sourceRange,
  });
  blocks.push(...inlined.blocks);

  // Insert after the block containing the call-site equation.
  const idx = section.blocks.findIndex(
    (b) =>
      (b.kind === 'align' && b.equations.some((e) => e.id === site.equationId)) ||
      (b.kind === 'cases' && b.subject.id === site.equationId),
  );
  if (idx >= 0) section.blocks.splice(idx + 1, 0, ...blocks);
  else section.blocks.push(...blocks);
}

function sourceTextOf(node: MathNode): string {
  // Compact human-readable form for binding prose; python names when known.
  switch (node.kind) {
    case 'sym':
      return node.pythonName;
    case 'num':
      return node.text;
    case 'str':
      return `"${node.text}"`;
    default:
      return '(…)';
  }
}
