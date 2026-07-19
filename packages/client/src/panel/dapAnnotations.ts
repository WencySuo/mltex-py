/**
 * Client-side annotation source — DAP stub (plan §10.5, stretch S2).
 *
 * The runtime-readiness contract requires the panel message bridge to accept
 * annotations from the CLIENT side in the MVP, exercised end-to-end with a
 * stubbed source. The real DapAnnotationProvider (breakpoint shapes via
 * debugpy/DAP) replaces `collect()` later with identical payloads — renderers
 * never branch on origin, so nothing else changes.
 */

import * as vscode from 'vscode';
import type { Annotation } from '@mathlens/core';
import type { PanelHost } from './panelHost.js';

export const DAP_SOURCE_NAME = 'dap-stub';

/**
 * Stubbed DAP annotation source. Wires the `annotations` panel message
 * end-to-end: on debug session start/stop it pushes/clears (empty) runtime
 * annotation sets through the bridge. Produces no real annotations yet —
 * `collect()` is the single seam the real provider fills in.
 */
export class DapAnnotationSource {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly panelHost: PanelHost) {}

  activate(context: vscode.ExtensionContext): void {
    this.disposables.push(
      vscode.debug.onDidChangeActiveDebugSession((session) => {
        if (session) {
          void this.push();
        } else {
          // Debug ended: clear anything this source pushed.
          this.panelHost.pushAnnotations(DAP_SOURCE_NAME, [], true);
        }
      }),
    );
    context.subscriptions.push(...this.disposables);
  }

  private async push(): Promise<void> {
    const annotations = await this.collect();
    this.panelHost.pushAnnotations(DAP_SOURCE_NAME, annotations, true);
  }

  /**
   * STUB: the real implementation evaluates watch/scope variables over DAP at
   * a breakpoint and maps them to StableId / SymbolOccurrenceId targets with
   * `origin: 'runtime'` shape/dtype/value payloads. Returns [] for now.
   */
  protected collect(): Promise<Annotation[]> {
    return Promise.resolve([]);
  }
}
