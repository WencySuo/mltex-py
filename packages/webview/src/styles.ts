/**
 * Panel styles. Theme via VS Code CSS variables only (plan §7 F2) — no
 * hard-coded colors, so light/dark/high-contrast all work. Injected as a
 * <style> element by main.ts (the host CSP allows 'unsafe-inline' for
 * style-src, the standard VS Code webview pattern; scripts stay nonce-only).
 */

export const PANEL_CSS = `
:root {
  color-scheme: light dark;
}
body {
  font-family: var(--vscode-font-family);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  padding: 0 12px 24px;
  margin: 0;
}

/* Toolbar */
.ml-toolbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  gap: 6px;
  padding: 8px 0;
  background: var(--vscode-editor-background);
  border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}
.ml-btn {
  font-family: inherit;
  font-size: 12px;
  padding: 2px 10px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 3px;
  background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
  color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
  cursor: pointer;
}
.ml-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
}
.ml-btn.active {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

/* Empty / message state */
.ml-empty {
  margin: 24px 4px;
  opacity: 0.8;
  font-style: italic;
}

/* Sections */
.ml-section { margin-top: 16px; }
.ml-section-title {
  font-size: 1.1em;
  font-weight: 600;
  margin: 8px 0 4px;
  border-bottom: 1px solid var(--vscode-panel-border, transparent);
  padding-bottom: 2px;
}
.ml-section-lemma .ml-section-title {
  font-style: italic;
  opacity: 0.95;
}
.ml-section-prose { opacity: 0.85; margin: 4px 0; }
.ml-signature { margin: 4px 0 8px; opacity: 0.9; }

/* Blocks */
.ml-block { margin: 6px 0; }
.ml-loop-header { margin: 4px 0; }
.ml-loop-body {
  margin-left: 18px;
  padding-left: 10px;
  border-left: 2px solid var(--vscode-panel-border, var(--vscode-widget-border, #8884));
}
.ml-code pre, .ml-col-source pre, pre.tex-fallback {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  background: var(--vscode-textCodeBlock-background, transparent);
  padding: 6px 8px;
  border-radius: 3px;
  margin: 2px 0;
  overflow-x: auto;
  white-space: pre;
}
.ml-prose p { margin: 4px 0; opacity: 0.85; }

/* Equations */
.ml-equation {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px 4px 10px;
  border-left: 3px solid transparent;
  cursor: pointer;
}
.ml-equation:hover {
  background: var(--vscode-list-hoverBackground, transparent);
}
.ml-equation.ml-highlight {
  border-left-color: var(--vscode-focusBorder, var(--vscode-textLink-foreground));
  background: var(--vscode-editor-selectionHighlightBackground, var(--vscode-list-hoverBackground, transparent));
}
.ml-math { flex: 1; overflow-x: auto; }
.ml-math mjx-container[jax="SVG"] { margin: 4px 0 !important; }
.ml-math svg { fill: currentColor; stroke: currentColor; }
.ml-eq-number { opacity: 0.6; font-size: 0.9em; }

/* Chevrons (F4) */
.ml-chevron {
  background: none;
  border: none;
  color: var(--vscode-foreground);
  cursor: pointer;
  padding: 0 2px;
  font-size: 12px;
  opacity: 0.7;
}
.ml-chevron:hover { opacity: 1; }

/* Annotation badges — style by kind/origin via CSS class ONLY (plan §4.2) */
.ml-badges { display: flex; gap: 4px; flex-wrap: wrap; }
.ml-badge {
  font-size: 10px;
  font-family: var(--vscode-editor-font-family, monospace);
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  white-space: nowrap;
}
.ml-origin-runtime { outline: 1px dashed var(--vscode-focusBorder, currentColor); }
.ml-severity-warning {
  background: var(--vscode-inputValidation-warningBackground, var(--vscode-badge-background));
  color: var(--vscode-inputValidation-warningForeground, var(--vscode-badge-foreground));
}
.ml-severity-error {
  background: var(--vscode-inputValidation-errorBackground, var(--vscode-badge-background));
  color: var(--vscode-errorForeground, var(--vscode-badge-foreground));
}

/* Two-column literate view (F5) */
.ml-two-col-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
  align-items: center;
  border-bottom: 1px dotted var(--vscode-panel-border, transparent);
}
.ml-col-source pre { margin: 0; }
.ml-col-math { cursor: pointer; }
`;
