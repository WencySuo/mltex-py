/**
 * Expansion-preference conversion — pure logic, unit-tested.
 *
 * Panel state stores per-call-site expansion modes; workflowMath/emitLatex
 * take ExpansionPrefs. Round-tripping these is what makes the PDF an exact
 * snapshot of the panel (plan principle 2, §6.4).
 */

import type { ExpansionMode, ExpansionPrefs, StableId } from '@mathlens/core';
import type { PanelState } from '@mathlens/core/panelProtocol';

export const DEFAULT_MAX_DEPTH = 2;

/** PanelState → request prefs (mathlens/workflowMath, mathlens/emitLatex). */
export function prefsFromState(state: PanelState, maxDepth = DEFAULT_MAX_DEPTH): ExpansionPrefs {
  return {
    maxDepth,
    perCallSite: { ...state.expansions },
    defaultMode: 'reference',
  };
}

/** Apply one chevron toggle to panel state (immutably). */
export function withExpansion(
  state: PanelState,
  callSiteEquationId: StableId,
  mode: ExpansionMode,
): PanelState {
  return {
    ...state,
    expansions: { ...state.expansions, [callSiteEquationId]: mode },
  };
}
