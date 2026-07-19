import { describe, expect, it } from 'vitest';
import type { PanelState } from '@mathlens/core/panelProtocol';
import { prefsFromState, withExpansion } from '../src/panel/prefs.js';

describe('expansion-prefs round-trip (plan principle 2)', () => {
  const state: PanelState = {
    viewMode: 'derivation',
    expansions: { 'eq-call-1': 'inline' },
  };

  it('converts panel state to ExpansionPrefs for workflowMath/emitLatex', () => {
    const prefs = prefsFromState(state);
    expect(prefs).toEqual({
      maxDepth: 2,
      perCallSite: { 'eq-call-1': 'inline' },
      defaultMode: 'reference',
    });
    // Copies, not aliases: mutating prefs must not touch panel state.
    prefs.perCallSite['eq-call-2'] = 'inline';
    expect(state.expansions['eq-call-2']).toBeUndefined();
  });

  it('applies chevron toggles immutably and round-trips through prefs', () => {
    const toggled = withExpansion(state, 'eq-call-2', 'inline');
    expect(state.expansions['eq-call-2']).toBeUndefined();
    expect(toggled.expansions).toEqual({ 'eq-call-1': 'inline', 'eq-call-2': 'inline' });

    const collapsed = withExpansion(toggled, 'eq-call-1', 'reference');
    const prefs = prefsFromState(collapsed);
    expect(prefs.perCallSite).toEqual({ 'eq-call-1': 'reference', 'eq-call-2': 'inline' });
  });
});
