/**
 * MathLens webview entry point (plan §3.2, §3.3, §7 F2). OWNED BY AGENT C.
 *
 * Thin DOM bootstrap: all logic lives in the testable modules
 * (docModel, texEmitter, view). Handles the exhaustive HostToWebviewMessage
 * switch, per-equation incremental re-typesetting on patches, cursor-sync
 * highlighting, annotation badge refreshes, and state persistence via
 * getState/setState.
 */

import type {
  HostToWebviewMessage,
  PanelState,
  WebviewToHostMessage,
} from '@mathlens/core/panelProtocol';

import { PanelDocModel } from './docModel.js';
import { PanelView } from './view.js';
import { injectPreamble, typesetTex } from './mathjaxTypeset.js';
import { PANEL_CSS } from './styles.js';

// --- VS Code webview API -----------------------------------------------------

interface VsCodeApi {
  postMessage(message: WebviewToHostMessage): void;
  getState(): PanelState | undefined;
  setState(state: PanelState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

// --- Boot ---------------------------------------------------------------------

const style = document.createElement('style');
style.textContent = PANEL_CSS;
document.head.appendChild(style);

const root = document.getElementById('root') ?? document.body.appendChild(document.createElement('div'));
root.id = 'root';

const DEFAULT_STATE: PanelState = { viewMode: 'derivation', expansions: {} };
const restoredState = vscode.getState() ?? DEFAULT_STATE;

const model = new PanelDocModel();
const view = new PanelView(root, model, restoredState, {
  typeset: typesetTex,
  post(message: WebviewToHostMessage): void {
    vscode.postMessage(message);
    if (message.type === 'stateChanged') vscode.setState(message.state);
  },
});

view.renderMessage('Waiting for MathLens…');

// --- Message handling ---------------------------------------------------------

function assertNever(x: never): never {
  throw new Error(`Unhandled message type: ${JSON.stringify(x)}`);
}

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'init': {
        // User preamble macros (plan §5, F11): register \newcommand
        // definitions with MathJax before any equation typesets.
        if (msg.preamble) injectPreamble(msg.preamble);
        model.init(msg.document, msg.annotations);
        view.setState(msg.state);
        vscode.setState(msg.state);
        view.renderAll();
        break;
      }
      case 'patch': {
        const outcome = model.applyPatch(msg.uri, msg.version, msg.patch);
        for (const id of outcome.removedSectionIds) view.removeSection(id);
        for (const id of outcome.changedSectionIds) view.refreshSection(id);
        for (const id of outcome.changedEquationIds) view.refreshEquation(id);
        if (outcome.annotationsChanged) view.refreshBadges();
        break;
      }
      case 'cursorSync': {
        if (model.uri === msg.uri) view.highlightLine(msg.line);
        break;
      }
      case 'annotations': {
        // Rendered generically; never branches on origin (plan §4.2 rule).
        model.setAnnotations(msg.source, msg.annotations, msg.reset);
        view.refreshBadges();
        break;
      }
      case 'setViewMode': {
        view.setViewMode(msg.mode);
        vscode.setState(view.getState());
        break;
      }
      default:
        assertNever(msg);
    }
  } catch (err) {
    // Graceful degradation (plan principle 3): never a blank crash.
    view.renderMessage(`MathLens panel error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

// Tell the host we are ready to receive `init`.
vscode.postMessage({ type: 'ready' });
