/**
 * F1 — CodeLens: "View as math" above every function_definition, including
 * methods and nested functions (plan §7 F1).
 *
 * Function list source: core parse (FunctionInfo) when available; regex scan
 * fallback while core is unimplemented/degraded (plan principle 3), so lenses
 * appear from day one.
 *
 * The conditional "Export PDF" second lens appears only for functions the
 * client has reported as rendered at least once. That report arrives via the
 * client→server notification `mathlens/panelDidRender` defined in
 * @mathlens/core/protocol (shared contract — see CONTRACTS.md).
 *
 * OWNED BY AGENT B.
 */

import type { CodeLens, CodeLensParams, Connection } from 'vscode-languageserver/node';
import { CodeLensRefreshRequest } from 'vscode-languageserver/node';
import type { Range } from '@mathlens/core';
import {
  PanelDidRenderNotification,
  type PanelDidRenderParams,
} from '@mathlens/core/protocol';
import type { MathLensDocuments } from './documents.js';

// Re-exported for backwards compatibility (tests import from here).
export { PanelDidRenderNotification, type PanelDidRenderParams };

/** Functions listed by either core parse or the scan fallback. */
interface LensTarget {
  qualname: string;
  range: Range;
}

export function registerCodeLens(connection: Connection, documents: MathLensDocuments): void {
  /** uri → set of qualnames the panel has rendered (session-scoped). */
  const rendered = new Map<string, Set<string>>();

  connection.onNotification(PanelDidRenderNotification, (params: PanelDidRenderParams) => {
    let set = rendered.get(params.uri);
    if (!set) {
      set = new Set();
      rendered.set(params.uri, set);
    }
    let added = false;
    for (const qualname of params.functionIds ?? []) {
      if (!set.has(qualname)) {
        set.add(qualname);
        added = true;
      }
    }
    if (added) {
      // Surface the new "Export PDF" lens without waiting for an edit.
      connection.sendRequest(CodeLensRefreshRequest.type).catch(() => {});
    }
  });

  connection.onCodeLens(async (params: CodeLensParams): Promise<CodeLens[]> => {
    try {
      const state = await documents.getState(params.textDocument.uri);
      if (!state) return [];

      const targets: LensTarget[] =
        state.parse?.ast.functions.map((f) => ({ qualname: f.qualname, range: f.range })) ??
        state.scannedFunctions.map((f) => ({ qualname: f.qualname, range: f.range }));

      const renderedSet = rendered.get(params.textDocument.uri);
      const lenses: CodeLens[] = [];
      for (const target of targets) {
        const headerRange: Range = {
          start: target.range.start,
          end: { line: target.range.start.line, character: target.range.start.character },
        };
        const args = [params.textDocument.uri, target.qualname, target.range];
        lenses.push({
          range: headerRange,
          command: { title: 'View as math', command: 'mathlens.viewAsMath', arguments: args },
        });
        if (renderedSet?.has(target.qualname)) {
          lenses.push({
            range: headerRange,
            command: { title: 'Export PDF', command: 'mathlens.exportPdf', arguments: args },
          });
        }
      }
      return lenses;
    } catch {
      return []; // lenses must never error the request
    }
  });
}
