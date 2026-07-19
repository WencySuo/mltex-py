/**
 * Notation & naming engine (plan §5, F7). Runs before translation; owns every
 * symbol's TeX form. Priority: inline `# tex:` directives → project mapping
 * file → heuristics (Greek names, suffix modifiers, trailing digits, …).
 *
 * OWNED BY AGENT A.
 */

import type { TexDirective } from '../parse/index.js';
import type { MathLensConfig } from '../config/types.js';
import type { Range } from '../ir/types.js';

/** How a resolved TeX form was decided (for hint diagnostics + hover binding info). */
export type NamingSource = 'directive' | 'mapping' | 'heuristic' | 'passthrough';

export interface ResolvedName {
  pythonName: string;
  tex: string;
  source: NamingSource;
}

/** Collision or fallback hint surfaced as an LSP hint diagnostic (plan §5.3–5.4). */
export interface NamingHint {
  message: string;
  pythonName: string;
  range?: Range;
}

export interface NamingEngineOptions {
  /** Directives collected at parse time, in source order. */
  directives?: readonly TexDirective[];
  /** [symbols] / [functions] tables from mathlens.toml. */
  config?: Pick<MathLensConfig, 'symbols' | 'functions'>;
}

// ---------------------------------------------------------------------------
// Heuristic tables
// ---------------------------------------------------------------------------

const GREEK: Record<string, string> = {
  alpha: '\\alpha',
  beta: '\\beta',
  gamma: '\\gamma',
  delta: '\\delta',
  epsilon: '\\varepsilon',
  eps: '\\varepsilon',
  zeta: '\\zeta',
  eta: '\\eta',
  theta: '\\theta',
  iota: '\\iota',
  kappa: '\\kappa',
  lam: '\\lambda',
  lamb: '\\lambda',
  lambda: '\\lambda',
  lmbda: '\\lambda',
  mu: '\\mu',
  nu: '\\nu',
  xi: '\\xi',
  pi: '\\pi',
  rho: '\\rho',
  sigma: '\\sigma',
  tau: '\\tau',
  upsilon: '\\upsilon',
  phi: '\\phi',
  chi: '\\chi',
  psi: '\\psi',
  omega: '\\omega',
};

const GREEK_UPPER: Record<string, string> = {
  Gamma: '\\Gamma',
  Delta: '\\Delta',
  Theta: '\\Theta',
  Lambda: '\\Lambda',
  Xi: '\\Xi',
  Pi: '\\Pi',
  Sigma: '\\Sigma',
  Upsilon: '\\Upsilon',
  Phi: '\\Phi',
  Psi: '\\Psi',
  Omega: '\\Omega',
};

/** Suffix modifiers (plan §5.3): base_hat → \hat{base}, etc. */
const SUFFIX_MODIFIERS: Record<string, (base: string) => string> = {
  hat: (b) => `\\hat{${b}}`,
  bar: (b) => `\\bar{${b}}`,
  tilde: (b) => `\\tilde{${b}}`,
  prime: (b) => `${b}'`,
  star: (b) => `${b}^{*}`,
  dot: (b) => `\\dot{${b}}`,
  vec: (b) => `\\vec{${b}}`,
};

function escapeUnderscores(name: string): string {
  return name.replace(/_/g, '\\_');
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface DirectiveBinding {
  tex: string;
  fromLine: number;
  range: Range;
}

/**
 * Resolves Python identifiers to TeX forms. One instance per document
 * translation pass (directives are position-sensitive; collision tracking
 * is per scope).
 */
export class NamingEngine {
  private readonly directiveBindings = new Map<string, DirectiveBinding[]>();
  private readonly symbolMap: Record<string, string>;
  private readonly functionMap: Record<string, string>;
  private readonly hintList: NamingHint[] = [];
  private readonly hintedNames = new Set<string>();
  /** tex form → python names that resolved to it (collision detection, §5.4). */
  private readonly texOwners = new Map<string, string>();
  /** python name → final tex once disambiguated (stable within a pass). */
  private readonly resolvedCache = new Map<string, ResolvedName>();

  constructor(options: NamingEngineOptions = {}) {
    this.symbolMap = options.config?.symbols ?? {};
    this.functionMap = options.config?.functions ?? {};
    for (const d of options.directives ?? []) {
      if (d.kind !== 'tex') continue;
      for (const b of d.bindings) {
        if (!b.name || !b.tex) continue;
        const list = this.directiveBindings.get(b.name) ?? [];
        list.push({ tex: b.tex, fromLine: d.effectiveFromLine, range: d.range });
        list.sort((a, z) => a.fromLine - z.fromLine);
        this.directiveBindings.set(b.name, list);
      }
    }
  }

  /**
   * TeX form for a variable name, honoring directives effective at `atLine`
   * (file-wide multi-binding directives apply from their line onward).
   */
  texFor(pythonName: string, atLine?: number): string {
    return this.resolve(pythonName, atLine).tex;
  }

  /**
   * TeX operator form for a function, e.g. "mymodel.ops.softmax" →
   * \operatorname{softmax}. Priority per plan §5: inline directives BEFORE
   * the [functions] mapping, then the fallback \operatorname form.
   */
  texForFunction(qualname: string): string {
    const short = qualname.split('.').pop() ?? qualname;
    // 1. Inline directives (highest priority, plan §5 order).
    const dirList = this.directiveBindings.get(qualname) ?? this.directiveBindings.get(short);
    if (dirList && dirList.length > 0) return dirList[dirList.length - 1]!.tex;
    // 2. [functions] mapping — exact qualname, then trailing name (config key
    // "softmax" matches "mymodel.ops.softmax") — cheap, unambiguous.
    const mapped = this.functionMap[qualname];
    if (mapped !== undefined) return mapped;
    const byShort = this.functionMap[short];
    if (byShort !== undefined) return byShort;
    // 3. Fallback.
    return `\\operatorname{${escapeUnderscores(short)}}`;
  }

  /** Full resolution record (used by hover to show the symbol binding). */
  resolve(pythonName: string, atLine?: number): ResolvedName {
    // 1. Inline directives (position-sensitive → don't use the cache).
    const dirs = this.directiveBindings.get(pythonName);
    if (dirs && dirs.length > 0) {
      const line = atLine ?? Number.MAX_SAFE_INTEGER;
      let best: DirectiveBinding | undefined;
      for (const d of dirs) {
        if (d.fromLine <= line) best = d;
      }
      // A directive later in the file still applies if nothing earlier does —
      // LHS-form directives bind exactly at their definition line, which the
      // fromLine check covers; fall through when none is effective yet.
      if (best) {
        // §5.4: directive-resolved names participate in collision tracking
        // too — register in texOwners so a mapped/heuristic name landing on
        // the same TeX gets disambiguated (and vice versa) with a hint.
        return this.disambiguate({ pythonName, tex: best.tex, source: 'directive' });
      }
    }

    const cached = this.resolvedCache.get(pythonName);
    if (cached) return cached;

    let result: ResolvedName;
    // 2. Project mapping file.
    const mapped = this.symbolMap[pythonName];
    if (mapped !== undefined) {
      result = { pythonName, tex: mapped, source: 'mapping' };
    } else {
      result = this.heuristic(pythonName);
    }

    // 4. Collision handling: two Python names → same TeX in a scope.
    result = this.disambiguate(result);
    this.resolvedCache.set(pythonName, result);
    return result;
  }

  /** Hints accumulated during resolution (multi-word leftovers, collisions). */
  hints(): readonly NamingHint[] {
    return this.hintList;
  }

  // -------------------------------------------------------------------------

  private disambiguate(r: ResolvedName): ResolvedName {
    const owner = this.texOwners.get(r.tex);
    if (owner === undefined) {
      this.texOwners.set(r.tex, r.pythonName);
      return r;
    }
    if (owner === r.pythonName) return r;
    // Collision: add a disambiguating subscript derived from the python name.
    const sub = escapeUnderscores(r.pythonName);
    const tex = `${r.tex}_{\\text{${sub}}}`;
    this.addHint(
      r.pythonName,
      `'${r.pythonName}' and '${owner}' both map to '${r.tex}'; rendered as '${tex}'. ` +
        `Add a '# tex:' directive or a [symbols] mapping to choose a distinct form.`,
    );
    this.texOwners.set(tex, r.pythonName);
    return { ...r, tex };
  }

  private addHint(pythonName: string, message: string): void {
    const key = `${pythonName} ${message}`;
    if (this.hintedNames.has(key)) return;
    this.hintedNames.add(key);
    this.hintList.push({ pythonName, message });
  }

  /** Heuristics, plan §5.3, in priority order. */
  private heuristic(name: string): ResolvedName {
    const h = (tex: string): ResolvedName => ({ pythonName: name, tex, source: 'heuristic' });
    const pass = (tex: string): ResolvedName => ({ pythonName: name, tex, source: 'passthrough' });

    // Greek names (exact match, lowercase or capitalized).
    if (GREEK[name]) return h(GREEK[name]!);
    if (GREEK_UPPER[name]) return h(GREEK_UPPER[name]!);

    // Suffix modifiers: x_hat, alpha_hat, x_bar, x_tilde, x_prime, x_star.
    const parts = name.split('_');
    if (parts.length >= 2) {
      const suffix = parts[parts.length - 1]!;
      const modifier = SUFFIX_MODIFIERS[suffix];
      if (modifier) {
        const baseName = parts.slice(0, -1).join('_');
        const base = this.heuristic(baseName);
        // Only apply when the base renders compactly (a hatted \mathit{...}
        // is worse than the fallback).
        if (base.source !== 'heuristic' || !base.tex.startsWith('\\mathit')) {
          return h(modifier(base.tex));
        }
      }
    }

    // d-prefix differentials: dx → \mathrm{d}x, only when the remainder is
    // itself a "known" compact symbol (single letter or Greek).
    if (name.length >= 2 && name.startsWith('d') && !name.includes('_')) {
      const rest = name.slice(1);
      if (/^[A-Za-z]$/.test(rest) || GREEK[rest] || GREEK_UPPER[rest]) {
        const restTex = GREEK[rest] ?? GREEK_UPPER[rest] ?? rest;
        return h(`\\mathrm{d}${restTex}`);
      }
    }

    // Trailing digits → subscripts: w1 → w_1, h0 → h_0, layer12 → \mathit fallback.
    const digitMatch = /^([A-Za-z]+)(\d+)$/.exec(name);
    if (digitMatch) {
      const stem = digitMatch[1]!;
      const digits = digitMatch[2]!;
      const stemTex = GREEK[stem] ?? GREEK_UPPER[stem] ?? (stem.length === 1 ? stem : undefined);
      if (stemTex !== undefined) {
        return h(digits.length === 1 ? `${stemTex}_${digits}` : `${stemTex}_{${digits}}`);
      }
    }

    // Short text suffixes → text subscripts: h_prev → h_{\text{prev}},
    // x_new → x_{\text{new}}. Applies when base is compact.
    if (parts.length === 2) {
      const [stem, suffix] = parts as [string, string];
      const stemTex = GREEK[stem] ?? GREEK_UPPER[stem] ?? (/^[A-Za-z]$/.test(stem) ? stem : undefined);
      if (stemTex !== undefined && suffix.length > 0) {
        if (/^\d+$/.test(suffix)) {
          return h(suffix.length === 1 ? `${stemTex}_${suffix}` : `${stemTex}_{${suffix}}`);
        }
        if (/^[A-Za-z]$/.test(suffix)) {
          return h(`${stemTex}_${suffix}`);
        }
        if (suffix.length <= 5) {
          return h(`${stemTex}_{\\text{${suffix}}}`);
        }
      }
    }

    // Single letters pass through; capitalized single letters stay upright
    // capitals (matrices by convention).
    if (/^[A-Za-z]$/.test(name)) return pass(name);

    // Multi-word leftovers → \mathit with escaped underscores + one-time hint.
    this.addHint(
      name,
      `No compact TeX form for '${name}'; rendered as \\mathit{${escapeUnderscores(name)}}. ` +
        `Consider a '# tex:' directive or a [symbols] entry in mathlens.toml.`,
    );
    return h(`\\mathit{${escapeUnderscores(name)}}`);
  }
}
