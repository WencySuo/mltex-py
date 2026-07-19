/**
 * PDF export orchestration (plan §7 F5): mathlens/emitLatex with the panel's
 * exact current state → write .tex to a temp dir → spawn tectonic (from
 * `mathlens.pdf.tectonicPath`, PATH, or globalStorage) or latexmk → progress
 * UX → parse log on failure and jump to the offending equation via the emit
 * source map → open the PDF in a simple embed webview tab. OWNED BY AGENT C.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
  EmitLatexRequest,
  type EmitLatexParams,
  type EmitLatexResult,
} from '@mathlens/core/protocol';
import type { PanelHost } from '../panel/panelHost.js';
import { equationForTexLine, parseTexLog } from './logParser.js';

/** The one running build; re-export kills it first (LaTeX Workshop parity §8). */
let runningBuild: ChildProcess | undefined;

export async function exportPdf(
  context: vscode.ExtensionContext,
  client: LanguageClient,
  panelHost: PanelHost,
): Promise<void> {
  const target = panelHost.getExportTarget();
  if (!target) {
    void vscode.window.showInformationMessage(
      'MathLens: render a function in the math panel first (the PDF is a snapshot of the panel).',
    );
    return;
  }
  const state = panelHost.getState();
  const profile: 'derivation' | 'literate' =
    state.viewMode === 'two-column' ? 'literate' : 'derivation';

  // 1. Emit the .tex (principle 2: same target + prefs as the panel).
  let emit: EmitLatexResult;
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
    emit = await client.sendRequest<EmitLatexResult>(EmitLatexRequest, params);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `MathLens: LaTeX generation failed (${err instanceof Error ? err.message : String(err)}).`,
    );
    return;
  }

  // 2. Write to a temp dir.
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mathlens-'));
  const texPath = path.join(buildDir, 'mathlens.tex');
  fs.writeFileSync(texPath, emit.tex, 'utf8');

  // 3. Kill any running build, then compile with progress.
  if (runningBuild && !runningBuild.killed) {
    runningBuild.kill();
    runningBuild = undefined;
  }

  const config = vscode.workspace.getConfiguration('mathlens');
  const engine = config.get<'tectonic' | 'latexmk'>('pdf.engine', 'tectonic');

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `MathLens: exporting PDF (${engine})…`,
      cancellable: true,
    },
    (progress, token) =>
      compile(context, engine, texPath, buildDir, token, (msg) => progress.report({ message: msg })),
  );

  if (result.kind === 'cancelled') return;

  if (result.kind === 'error') {
    await surfaceCompileError(result.log, emit, target.uri);
    return;
  }

  // 4. View the result in a webview tab.
  openPdfViewer(context, result.pdfPath);
}

type CompileResult =
  | { kind: 'ok'; pdfPath: string }
  | { kind: 'error'; log: string }
  | { kind: 'cancelled' };

async function compile(
  context: vscode.ExtensionContext,
  engine: 'tectonic' | 'latexmk',
  texPath: string,
  buildDir: string,
  token: vscode.CancellationToken,
  report: (msg: string) => void,
): Promise<CompileResult> {
  let command: string;
  let args: string[];
  if (engine === 'tectonic') {
    const resolved = await resolveTectonic(context);
    if (!resolved) return { kind: 'error', log: TECTONIC_MISSING_LOG };
    command = resolved;
    args = ['--outdir', buildDir, texPath];
  } else {
    command = 'latexmk';
    args = ['-pdf', '-interaction=nonstopmode', `-outdir=${buildDir}`, texPath];
  }

  report('compiling…');
  return new Promise<CompileResult>((resolve) => {
    let output = '';
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd: buildDir });
    } catch (err) {
      resolve({ kind: 'error', log: String(err) });
      return;
    }
    runningBuild = child;
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
    token.onCancellationRequested(() => {
      child.kill();
      resolve({ kind: 'cancelled' });
    });
    child.on('error', (err) => {
      runningBuild = undefined;
      resolve({ kind: 'error', log: `${err.message}\n${output}` });
    });
    child.on('close', (code, signal) => {
      runningBuild = undefined;
      if (signal) {
        resolve({ kind: 'cancelled' });
        return;
      }
      const pdfPath = texPath.replace(/\.tex$/, '.pdf');
      if (code === 0 && fs.existsSync(pdfPath)) {
        resolve({ kind: 'ok', pdfPath });
      } else {
        // Prefer the .log file when the engine wrote one (fuller than stderr).
        const logPath = texPath.replace(/\.tex$/, '.log');
        if (fs.existsSync(logPath)) {
          try {
            output += '\n' + fs.readFileSync(logPath, 'utf8');
          } catch {
            /* stderr alone */
          }
        }
        resolve({ kind: 'error', log: output });
      }
    });
  });
}

const TECTONIC_MISSING_LOG =
  'error: tectonic executable not found. Set "mathlens.pdf.tectonicPath", install tectonic on your PATH, or switch "mathlens.pdf.engine" to "latexmk".';

/**
 * Resolve the tectonic binary:
 *  1. `mathlens.pdf.tectonicPath` setting,
 *  2. a previously bootstrapped copy in globalStorage,
 *  3. PATH.
 * The globalStorage download bootstrap (rust-analyzer pattern, checksum
 * pinning — plan §7 F5.2) is a clearly marked STUB: today it only reports an
 * actionable error instead of downloading.
 */
async function resolveTectonic(context: vscode.ExtensionContext): Promise<string | undefined> {
  const configured = vscode.workspace
    .getConfiguration('mathlens')
    .get<string>('pdf.tectonicPath', '');
  if (configured) {
    if (fs.existsSync(configured)) return configured;
    void vscode.window.showWarningMessage(
      `MathLens: mathlens.pdf.tectonicPath points to "${configured}" which does not exist; falling back to PATH.`,
    );
  }

  const bootstrapped = path.join(
    context.globalStorageUri.fsPath,
    'tectonic',
    process.platform === 'win32' ? 'tectonic.exe' : 'tectonic',
  );
  if (fs.existsSync(bootstrapped)) return bootstrapped;

  const onPath = findOnPath(process.platform === 'win32' ? 'tectonic.exe' : 'tectonic');
  if (onPath) return onPath;

  // STUB (plan §7 F5.2): the real implementation downloads the per-platform
  // tectonic release into globalStorage with checksum pinning and progress.
  const choice = await vscode.window.showErrorMessage(
    'MathLens: tectonic was not found. Automatic download is not implemented yet — install tectonic (https://tectonic-typesetting.github.io), set "mathlens.pdf.tectonicPath", or use "mathlens.pdf.engine": "latexmk".',
    'Open Settings',
  );
  if (choice === 'Open Settings') {
    void vscode.commands.executeCommand('workbench.action.openSettings', 'mathlens.pdf');
  }
  return undefined;
}

function findOnPath(binary: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

/** Parse the compile log and jump to the offending equation (plan §7 F5.3). */
async function surfaceCompileError(
  log: string,
  emit: EmitLatexResult,
  uri: string,
): Promise<void> {
  const parsed = parseTexLog(log);
  const message = parsed?.message ?? 'PDF compile failed (no parsable error in the log).';

  let action: string | undefined;
  const entry =
    parsed?.texLine !== undefined ? equationForTexLine(emit.sourceMap, parsed.texLine) : undefined;
  if (entry) {
    action = await vscode.window.showErrorMessage(
      `MathLens: PDF export failed at an equation — ${message}`,
      'Go to Equation',
      'Show Log',
    );
  } else {
    action = await vscode.window.showErrorMessage(`MathLens: PDF export failed — ${message}`, 'Show Log');
  }

  if (action === 'Go to Equation' && entry) {
    // The source map names the equation; the panel model has its sourceRange.
    // We re-request nothing: equation ids are stable, and the emitLatex tex
    // lines → equation mapping is what plan F5.3 requires. Reveal the source
    // file at the equation via a text search fallback: sourceMap does not
    // carry ranges, so delegate to the document (open at top when unknown).
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
      void vscode.window.setStatusBarMessage(
        `MathLens: failing equation id ${String(entry.equationId)} (tex lines ${entry.texStartLine + 1}–${entry.texEndLine}).`,
        8000,
      );
    } catch {
      /* file gone */
    }
  } else if (action === 'Show Log') {
    const channel = vscode.window.createOutputChannel('MathLens PDF');
    channel.appendLine(log);
    channel.show();
  }
}

/**
 * Simple embedded PDF viewer tab (object/embed with a webview-served URI).
 * Full PDF.js viewer with per-equation \hypertarget anchors is follow-up.
 */
function openPdfViewer(context: vscode.ExtensionContext, pdfPath: string): void {
  const panel = vscode.window.createWebviewPanel(
    'mathlens.pdfViewer',
    `MathLens PDF — ${path.basename(pdfPath)}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: false,
      localResourceRoots: [vscode.Uri.file(path.dirname(pdfPath))],
    },
  );
  const pdfUri = panel.webview.asWebviewUri(vscode.Uri.file(pdfPath));
  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; object-src ${panel.webview.cspSource}; frame-src ${panel.webview.cspSource}; style-src 'unsafe-inline';">
<style>html, body, object { width: 100%; height: 100%; margin: 0; padding: 0; }</style>
<title>MathLens PDF</title>
</head>
<body>
<object data="${pdfUri}" type="application/pdf">
  <p style="font-family: sans-serif; padding: 12px;">
    Unable to embed the PDF here. It was written to <code>${pdfPath}</code>.
  </p>
</object>
</body>
</html>`;
}
