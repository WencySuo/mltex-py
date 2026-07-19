/**
 * Webview panel host: singleton WebviewPanel in ViewColumn.Beside, loads
 * media/webview.js (CSP + nonce), bridges panelProtocol messages, forwards
 * LSP math requests, manages follow/pin state, and relays incremental
 * mathlens/mathUpdated patches (plan §3.2, §7 F2). OWNED BY AGENT C.
 *
 * Render notifications: the shared client→server notification
 * `mathlens/panelDidRender` ({ uri, functionIds }) from core/protocol is sent
 * whenever the panel renders a document; functionIds are the qualnames of
 * rendered function/lemma sections. The server uses this for its conditional
 * "Export PDF" lens.
 */

import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import type {
  Annotation,
  MathDocument,
  Position,
  Range,
} from '@mathlens/core';
import {
  DocumentMathRequest,
  EmitLatexRequest,
  FunctionMathRequest,
  MathUpdatedNotification,
  PanelDidRenderNotification,
  SelectionMathRequest,
  WorkflowMathRequest,
  type DocumentMathParams,
  type PanelDidRenderParams,
  type DocumentMathResult,
  type EmitLatexParams,
  type EmitLatexResult,
  type FunctionMathParams,
  type FunctionMathResult,
  type MathUpdatedParams,
  type SelectionMathParams,
  type SelectionMathResult,
  type WorkflowMathParams,
  type WorkflowMathResult,
} from '@mathlens/core/protocol';
import type { ExpansionPrefs } from '@mathlens/core';
import type {
  HostToWebviewMessage,
  PanelState,
  WebviewToHostMessage,
} from '@mathlens/core/panelProtocol';
import { prefsFromState, withExpansion } from './prefs.js';

const VIEW_TYPE = 'mathlens.panel';

type PanelTarget =
  | { kind: 'function'; uri: string; position: Position }
  | { kind: 'selection'; uri: string; range: Range }
  | { kind: 'workflow'; uri: string; position?: Position; qualname?: string };

function toLspPosition(pos: vscode.Position): Position {
  return { line: pos.line, character: pos.character };
}

function toLspRange(range: vscode.Range): Range {
  return { start: toLspPosition(range.start), end: toLspPosition(range.end) };
}

function toVsRange(range: Range): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

export class PanelHost implements vscode.WebviewPanelSerializer {
  private panel: vscode.WebviewPanel | undefined;
  private webviewReady = false;
  /** Messages queued until the webview posts `ready`. */
  private pendingMessages: HostToWebviewMessage[] = [];

  private state: PanelState = { viewMode: 'derivation', expansions: {} };
  private target: PanelTarget | undefined;
  /** Document currently shown in the panel (for staleness + sync checks). */
  private currentDoc: MathDocument | undefined;
  /**
   * True when currentDoc came from a scoped request (functionMath /
   * selectionMath / workflowMath) — whole-document mathUpdated patches must
   * then be filtered so unrelated sections don't accrete (see scopePatch).
   */
  private currentDocScoped = false;

  private followDebounce: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: LanguageClient,
  ) {
    // Server → panel incremental patches (plan §3.4).
    this.client.onNotification(MathUpdatedNotification, (params: MathUpdatedParams) => {
      if (!this.panel || !this.currentDoc || params.uri !== this.currentDoc.uri) return;
      const patch = this.scopePatch(params.patch);
      this.post({ type: 'patch', uri: params.uri, version: params.version, patch });
      if (this.currentDoc.version < params.version) this.currentDoc.version = params.version;
    });

    // Editor → panel cursor sync + follow mode (F2).
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => this.onEditorSelection(e)),
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, this),
    );
    context.subscriptions.push(...this.disposables, { dispose: () => this.dispose() });
  }

  dispose(): void {
    if (this.followDebounce) clearTimeout(this.followDebounce);
    this.panel?.dispose();
  }

  /** Current serializable panel state (also handed to exportPdf — principle 2). */
  getState(): PanelState {
    return this.state;
  }

  /**
   * Target info needed by exportPdf/copyLatex (principle 2: PDF = panel
   * snapshot). `kind` + `range` let the server dispatch to the exact math
   * request the panel used (F6): selection→selectionMath, function→
   * functionMath (no workflow expansion), workflow→workflowMath.
   */
  getExportTarget():
    | {
        uri: string;
        kind: 'function' | 'selection' | 'workflow';
        position?: Position;
        qualname?: string;
        range?: Range;
        prefs?: ExpansionPrefs;
      }
    | undefined {
    if (!this.target) return undefined;
    const base = { uri: this.target.uri, kind: this.target.kind, prefs: this.expansionPrefs() };
    switch (this.target.kind) {
      case 'function':
        return { ...base, position: this.target.position };
      case 'workflow':
        return { ...base, position: this.target.position, qualname: this.target.qualname };
      case 'selection':
        return { ...base, position: this.target.range.start, range: this.target.range };
    }
  }

  /**
   * Client-side annotation push (plan §10.5) — the DAP provider (stub today)
   * calls this; the panel renders the annotations generically.
   */
  pushAnnotations(source: string, annotations: Annotation[], reset?: boolean): void {
    if (!this.panel) return;
    this.post({ type: 'annotations', source, annotations, reset });
  }

  // ---------------------------------------------------------------------------
  // Commands (F1 / F3 / F4)
  // ---------------------------------------------------------------------------

  /**
   * Open/reveal the panel focused on a function (F1 lens / follow mode).
   * When a CodeLens provides `range`, its start position (in `uri`'s
   * document) selects the function — NOT the active editor's cursor, which
   * may sit in a different function than the clicked lens (F9). Pinned mode
   * is only updated when the panel is already pinned (re-pin to the clicked
   * function); an unpinned panel stays in follow mode.
   */
  async showFunction(uri?: string, qualname?: string, range?: Range): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const docUri = uri ?? editor?.document.uri.toString();
    if (!docUri) {
      void vscode.window.showInformationMessage('MathLens: open a Python file first.');
      return;
    }
    let position: Position;
    if (range) {
      position = range.start;
    } else if (editor && (!uri || editor.document.uri.toString() === docUri)) {
      position = toLspPosition(editor.selection.active);
    } else {
      position = { line: 0, character: 0 };
    }
    this.target = { kind: 'function', uri: docUri, position };
    if (qualname && this.state.pinnedQualname) {
      // Already pinned: re-pin to the clicked function; don't flip an
      // unpinned panel into pinned mode as a click side effect.
      this.state = { ...this.state, pinnedQualname: qualname };
    }
    this.ensurePanel();
    await this.refresh();
  }

  /**
   * F3: render the active selection as an ephemeral derivation section.
   * The view is replaced by the NEXT follow event (cursor move) unless
   * pinned; the pending follow debounce from making the selection itself is
   * cancelled so it can't immediately clobber this view.
   */
  async showSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('MathLens: select some Python code first.');
      return;
    }
    if (this.followDebounce) clearTimeout(this.followDebounce);
    this.target = {
      kind: 'selection',
      uri: editor.document.uri.toString(),
      range: toLspRange(editor.selection),
    };
    this.ensurePanel();
    await this.refresh();
  }

  /** F4: workflow view with expansion prefs from panel state. */
  async showWorkflow(uri?: string, qualname?: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const docUri = uri ?? editor?.document.uri.toString();
    if (!docUri) {
      void vscode.window.showInformationMessage('MathLens: open a Python file first.');
      return;
    }
    this.target = {
      kind: 'workflow',
      uri: docUri,
      position: editor ? toLspPosition(editor.selection.active) : undefined,
      qualname,
    };
    this.ensurePanel();
    await this.refresh();
  }

  // ---------------------------------------------------------------------------
  // Panel lifecycle
  // ---------------------------------------------------------------------------

  private ensurePanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'MathLens',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        // Memory hygiene (plan §7 F2): retainContextWhenHidden stays OFF;
        // state survives via getState/setState + this serializer.
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
      },
    );
    this.adoptPanel(panel);
  }

  private adoptPanel(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    this.webviewReady = false;
    this.pendingMessages = [];
    panel.webview.html = this.buildHtml(panel.webview);
    panel.webview.onDidReceiveMessage(
      (msg: WebviewToHostMessage) => this.onMessage(msg),
      undefined,
      this.disposables,
    );
    panel.onDidDispose(
      () => {
        this.panel = undefined;
        this.webviewReady = false;
        this.currentDoc = undefined;
      },
      undefined,
      this.disposables,
    );
  }

  /** WebviewPanelSerializer: revive after window reload (state from setState). */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: PanelState | undefined): Promise<void> {
    if (state) this.state = state;
    this.adoptPanel(panel);
    // No target survives a reload; the webview shows its waiting message and
    // the next follow event or command re-populates it.
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'webview.js'),
    );
    const n = nonce();
    // CSP: nonce-only scripts, no remote resources; inline styles allowed for
    // the injected panel stylesheet + MathJax's generated SVG styles.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MathLens</title>
</head>
<body>
<div id="root"></div>
<script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  // ---------------------------------------------------------------------------
  // Data flow: fetch → init, patches relayed in constructor
  // ---------------------------------------------------------------------------

  private expansionPrefs(): ExpansionPrefs {
    return prefsFromState(this.state);
  }

  /**
   * (Re)fetch math for the current target and send `init`. Server failures
   * degrade gracefully: the panel keeps its last content and we surface a
   * status-bar-level message — never a crash (plan principle 3).
   */
  private async refresh(): Promise<void> {
    if (!this.target || !this.panel) return;
    let result:
      | { document: MathDocument; annotations?: Annotation[]; preamble?: string }
      | null
      | undefined;
    // functionMath / selectionMath / workflowMath results are scoped views
    // (a subset of the file's sections); whole-document patches must be
    // filtered against them. Only the documentMath fallback is unscoped.
    let scoped = true;
    try {
      switch (this.target.kind) {
        case 'function': {
          const params: FunctionMathParams = {
            uri: this.target.uri,
            position: this.target.position,
          };
          result = await this.client.sendRequest<FunctionMathResult>(FunctionMathRequest, params);
          if (result === null) {
            // No enclosing function: fall back to the whole document.
            const docParams: DocumentMathParams = { uri: this.target.uri };
            result = await this.client.sendRequest<DocumentMathResult>(DocumentMathRequest, docParams);
            scoped = false;
          }
          break;
        }
        case 'selection': {
          const params: SelectionMathParams = { uri: this.target.uri, range: this.target.range };
          result = await this.client.sendRequest<SelectionMathResult>(SelectionMathRequest, params);
          break;
        }
        case 'workflow': {
          const params: WorkflowMathParams = {
            uri: this.target.uri,
            position: this.target.position,
            qualname: this.target.qualname,
            prefs: this.expansionPrefs(),
          };
          result = await this.client.sendRequest<WorkflowMathResult>(WorkflowMathRequest, params);
          break;
        }
      }
    } catch (err) {
      this.sendEmptyDocument(
        this.target.uri,
        `MathLens: math request failed (${err instanceof Error ? err.message : String(err)})`,
      );
      return;
    }
    if (!result?.document) {
      this.sendEmptyDocument(this.target.uri, 'MathLens: nothing to render here.');
      return;
    }
    // Drop stale responses (protocol contract: results echo doc version).
    if (
      this.currentDoc &&
      this.currentDoc.uri === result.document.uri &&
      result.document.version < this.currentDoc.version
    ) {
      return;
    }
    this.currentDoc = result.document;
    this.currentDocScoped = scoped;
    this.post({
      type: 'init',
      document: result.document,
      annotations: result.annotations ?? [],
      state: this.state,
      preamble: result.preamble,
    });
    this.notifyPanelRendered(result.document);
  }

  /**
   * Scope a relayed whole-document patch to the panel's current (scoped)
   * view: added/updated sections whose ids are not in currentDoc are dropped;
   * removals always pass (the panel may need to drop a deleted section);
   * equation patches self-scope (unknown sectionIds no-op in the webview).
   * Documents scoping semantics: see MathPatch in core/protocol.ts.
   */
  private scopePatch(patch: MathUpdatedParams['patch']): MathUpdatedParams['patch'] {
    if (!this.currentDocScoped || !this.currentDoc) return patch;
    const known = new Set(this.currentDoc.sections.map((s) => String(s.id)));
    return {
      ...patch,
      addedSections: patch.addedSections.filter((s) => known.has(String(s.id))),
      updatedSections: patch.updatedSections.filter((s) => known.has(String(s.id))),
    };
  }

  /** Empty panel with a message — graceful degradation, never a crash. */
  private sendEmptyDocument(uri: string, message: string): void {
    const empty: MathDocument = { uri, version: -1, sections: [] };
    this.currentDoc = empty;
    this.currentDocScoped = false;
    this.post({ type: 'init', document: empty, annotations: [], state: this.state });
    void vscode.window.setStatusBarMessage(message, 5000);
  }

  /** Convention: tell the server which functions the panel has rendered (F1 lens 2). */
  private notifyPanelRendered(doc: MathDocument): void {
    const functionIds = doc.sections
      .filter((s) => s.kind === 'function' || s.kind === 'lemma')
      .map((s) => s.qualname ?? s.title);
    const params: PanelDidRenderParams = { uri: doc.uri, functionIds };
    // Fire-and-forget; a server that does not handle it just logs.
    void this.client.sendNotification(PanelDidRenderNotification, params).then(undefined, () => {});
  }

  // ---------------------------------------------------------------------------
  // Editor events (follow + cursorSync)
  // ---------------------------------------------------------------------------

  private onEditorSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.panel || e.textEditor.document.languageId !== 'python') return;
    const uri = e.textEditor.document.uri.toString();
    const line = e.selections[0]?.active.line ?? 0;

    // Always sync the highlight bar when the panel shows this document.
    if (this.currentDoc?.uri === uri) {
      this.post({ type: 'cursorSync', uri, line });
    }

    // Follow mode: refetch the enclosing function, debounced.
    const config = vscode.workspace.getConfiguration('mathlens');
    const follow = config.get<boolean>('panel.follow', true);
    if (!follow || this.state.pinnedQualname) return;
    // F3 ephemerality (plan §7 F3): an UNPINNED selection view is replaced by
    // the next follow event. Workflows stay put until pin/follow changes.
    if (this.target && this.target.kind === 'workflow') return;
    const debounceMs = config.get<number>('panel.debounceMs', 250);
    if (this.followDebounce) clearTimeout(this.followDebounce);
    this.followDebounce = setTimeout(() => {
      this.target = { kind: 'function', uri, position: { line, character: e.selections[0]?.active.character ?? 0 } };
      void this.refresh();
    }, debounceMs);
  }

  // ---------------------------------------------------------------------------
  // Webview → host messages
  // ---------------------------------------------------------------------------

  private onMessage(message: WebviewToHostMessage): void {
    switch (message.type) {
      case 'ready': {
        this.webviewReady = true;
        const queued = this.pendingMessages;
        this.pendingMessages = [];
        for (const m of queued) this.panel?.webview.postMessage(m);
        // A revived/reopened webview with a known target re-fetches.
        if (this.target && !this.currentDoc) void this.refresh();
        break;
      }
      case 'revealSource':
        void this.revealSource(message.uri, message.range);
        break;
      case 'toggleExpansion': {
        this.state = withExpansion(this.state, message.callSiteEquationId, message.mode);
        // Re-request workflowMath with updated prefs (F4).
        if (this.target?.kind === 'workflow') void this.refresh();
        break;
      }
      case 'viewModeChanged':
        this.state = { ...this.state, viewMode: message.mode };
        break;
      case 'pinChanged':
        this.state = { ...this.state, pinnedQualname: message.pinnedQualname };
        break;
      case 'copyLatex':
        void this.copyLatex(message.scope, message.targetId as string | undefined);
        break;
      case 'exportPdf':
        void vscode.commands.executeCommand('mathlens.exportPdf');
        break;
      case 'stateChanged':
        this.state = message.state;
        break;
    }
  }

  /** Panel → editor click sync (F2). */
  private async revealSource(uri: string, range: Range): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
      });
      const vsRange = toVsRange(range);
      editor.revealRange(vsRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      editor.selection = new vscode.Selection(vsRange.start, vsRange.start);
    } catch {
      // Document may be gone; ignore.
    }
  }

  /** Command-palette copy-LaTeX (whole document scope). */
  async copyLatexToClipboard(): Promise<void> {
    await this.copyLatex('document');
  }

  /** Toolbar copy-LaTeX: request emitLatex and put (a slice of) it on the clipboard. */
  private async copyLatex(scope: 'document' | 'section' | 'equation', targetId?: string): Promise<void> {
    const target = this.getExportTarget();
    if (!target) {
      void vscode.window.showInformationMessage('MathLens: nothing rendered yet.');
      return;
    }
    const profile: 'derivation' | 'literate' =
      this.state.viewMode === 'two-column' ? 'literate' : 'derivation';
    try {
      const params: EmitLatexParams = {
        uri: target.uri,
        target: target.kind,
        position: target.position,
        qualname: target.qualname,
        range: target.range,
        prefs: target.prefs,
        profile,
      };
      const result = await this.client.sendRequest<EmitLatexResult>(EmitLatexRequest, params);
      let tex = result.tex;
      if (scope === 'equation' && targetId) {
        const entry = result.sourceMap.find((e) => String(e.equationId) === String(targetId));
        if (entry) {
          tex = result.tex.split('\n').slice(entry.texStartLine, entry.texEndLine).join('\n');
        }
      }
      await vscode.env.clipboard.writeText(tex);
      void vscode.window.setStatusBarMessage('MathLens: LaTeX copied to clipboard.', 3000);
    } catch (err) {
      void vscode.window.showWarningMessage(
        `MathLens: copy LaTeX failed (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Host → webview
  // ---------------------------------------------------------------------------

  /** Post a typed message; queued until the webview reports `ready`. */
  private post(message: HostToWebviewMessage): void {
    if (!this.panel) return;
    if (!this.webviewReady) {
      // Coalesce: a newer init supersedes anything queued before it.
      if (message.type === 'init') this.pendingMessages = [];
      this.pendingMessages.push(message);
      return;
    }
    void this.panel.webview.postMessage(message);
  }
}
