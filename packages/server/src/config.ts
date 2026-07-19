/**
 * Workspace configuration: reads `mathlens.toml` at the workspace root when
 * present (plan §3.5, §5), maps it onto the shared MathLensConfig shape, and
 * loads the user preamble file for MathJax + emit injection.
 *
 * Graceful degradation (plan principle 3): a missing/broken toml never breaks
 * the server — we fall back to an empty config and surface the problem as a
 * loader warning the caller may log or publish.
 *
 * OWNED BY AGENT B.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SETTINGS,
  type EffectiveConfig,
  type MathLensConfig,
  type VsCodeSettings,
} from '@mathlens/core';
import { parseToml, TomlParseError, type TomlTable } from './toml.js';

export interface ConfigLoadWarning {
  message: string;
  /** Zero-based line in mathlens.toml, when known. */
  line?: number;
}

export interface LoadedConfig {
  effective: EffectiveConfig;
  /** Contents of the [preamble].include file, when present and readable. */
  userPreamble?: string;
  /** Absolute path of the toml file this was loaded from, if any. */
  tomlPath?: string;
  warnings: ConfigLoadWarning[];
}

function isTable(v: unknown): v is TomlTable {
  return typeof v === 'object' && v !== null;
}

function stringRecord(v: unknown): Record<string, string> | undefined {
  if (!isTable(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

function pickString<T extends string>(v: unknown, allowed?: readonly T[]): T | undefined {
  if (typeof v !== 'string') return undefined;
  if (allowed && !allowed.includes(v as T)) return undefined;
  return v as T;
}

/** Map a parsed TOML table onto the frozen MathLensConfig shape, ignoring unknown keys. */
export function tomlToConfig(table: TomlTable): MathLensConfig {
  const config: MathLensConfig = {};
  const symbols = stringRecord(table['symbols']);
  if (symbols && Object.keys(symbols).length > 0) config.symbols = symbols;
  const functions = stringRecord(table['functions']);
  if (functions && Object.keys(functions).length > 0) config.functions = functions;

  const preamble = table['preamble'];
  if (isTable(preamble)) {
    const include = pickString(preamble['include']);
    if (include) config.preamble = { include };
  }

  const render = table['render'];
  if (isTable(render)) {
    config.render = {
      explicitMatmulDot: typeof render['explicitMatmulDot'] === 'boolean' ? render['explicitMatmulDot'] : undefined,
      elementwiseDefault: pickString(render['elementwiseDefault'], ['odot', 'cdot', 'implicit'] as const),
      solveStyle: pickString(render['solveStyle'], ['inverse', 'setform'] as const),
      statsStyle: pickString(render['statsStyle'], ['blackboard', 'operator'] as const),
      renderAsserts: typeof render['renderAsserts'] === 'boolean' ? render['renderAsserts'] : undefined,
      renderNotes: typeof render['renderNotes'] === 'boolean' ? render['renderNotes'] : undefined,
    };
  }

  const pdf = table['pdf'];
  if (isTable(pdf)) {
    config.pdf = {
      engine: pickString(pdf['engine'], ['tectonic', 'latexmk'] as const),
      defaultProfile: pickString(pdf['defaultProfile'], ['derivation', 'literate'] as const),
    };
  }

  const expansion = table['expansion'];
  if (isTable(expansion)) {
    config.expansion = {
      maxDepth: typeof expansion['maxDepth'] === 'number' ? expansion['maxDepth'] : undefined,
      defaultMode: pickString(expansion['defaultMode'], ['reference', 'inline'] as const),
    };
  }

  return config;
}

/** file:// URI → filesystem path, or undefined for non-file schemes. */
export function uriToFsPath(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return undefined;
    return fileURLToPath(parsed);
  } catch {
    return undefined;
  }
}

/**
 * Load mathlens.toml from `workspaceRoot` (fs path). Missing file → defaults.
 * Broken file → defaults + a warning (never throws).
 */
export function loadWorkspaceConfig(
  workspaceRoot: string | undefined,
  settings: VsCodeSettings = DEFAULT_SETTINGS,
): LoadedConfig {
  const warnings: ConfigLoadWarning[] = [];
  let toml: MathLensConfig = {};
  let userPreamble: string | undefined;
  let tomlPath: string | undefined;

  if (workspaceRoot) {
    const candidate = path.join(workspaceRoot, 'mathlens.toml');
    let text: string | undefined;
    try {
      text = fs.readFileSync(candidate, 'utf8');
      tomlPath = candidate;
    } catch {
      // No mathlens.toml — perfectly fine.
    }
    if (text !== undefined) {
      try {
        toml = tomlToConfig(parseToml(text));
      } catch (err) {
        toml = {};
        if (err instanceof TomlParseError) {
          warnings.push({ message: err.message, line: err.line });
        } else {
          warnings.push({ message: `mathlens.toml: ${String(err)}` });
        }
      }
    }
    const include = toml.preamble?.include;
    if (include) {
      try {
        userPreamble = fs.readFileSync(path.resolve(workspaceRoot, include), 'utf8');
      } catch {
        warnings.push({ message: `mathlens.toml [preamble].include: cannot read "${include}"` });
      }
    }
  }

  return {
    effective: { toml, settings },
    userPreamble,
    tomlPath,
    warnings,
  };
}
