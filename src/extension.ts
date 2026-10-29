/**
 * extension.ts — PyPilot VS Code extension entry point.
 *
 * Activation:
 *   0. Start `.venv` / pixi environment auto-selection (venv.ts); independent of the helper.
 *   1. Register the status bar item (before the helper lookup, so that a
 *      failed download still leaves an indicator behind).
 *   2. Locate / download the `pypilot` helper binary (downloader.ts).
 *   3. Start the language client (LanguageClient wrapping `pypilot lsp`).
 *   4. Register all command palette handlers.
 *   5. Register the task provider.
 *   6. On workspace open: if auto-check is on, run a silent scan and surface
 *      any findings via a VS Code-native popup with action buttons.
 *
 * Deactivation: stop the language client (cleans up the language server process).
 */

import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";

import { ensureHelper, checkForHelperUpdate, installEngineVersion, type HelperInfo } from "./downloader";
import { PyPilotStatusBar } from "./statusBar";
import { registerCommands } from "./commands";
import { PyPilotTaskProvider } from "./tasks";
import { ReportPanel } from "./webview/reportPanel";
import { pixiEnvName, registerVenvSelection } from "./venv";

let client: LanguageClient | undefined;
let statusBar: PyPilotStatusBar | undefined;

/** What `activate` returns when VS Code runs the extension's tests
 *  (`ExtensionMode.Test`, see e2e/); nothing in normal use. */
export interface PyPilotTestApi {
  helper(): HelperInfo | undefined;
  installEngineVersion(version: string, binDir: string): Promise<string>;
}

export async function activate(context: vscode.ExtensionContext): Promise<PyPilotTestApi | undefined> {
  let helperInfo: HelperInfo | undefined;
  const testApi: PyPilotTestApi | undefined =
    context.extensionMode === vscode.ExtensionMode.Test
      ? {
          helper: () => helperInfo,
          installEngineVersion: (version, binDir) => installEngineVersion(context, version, binDir),
        }
      : undefined;

  // ── 0. Project environment selection (.venv or pixi) ─────────────────────
  // Registered first because it only talks to the Python extensions: it must
  // keep working even if the helper binary cannot be found below.
  registerVenvSelection(context);

  // ── 1. Status bar ─────────────────────────────────────────────────────────
  // Created before the helper lookup so that a failed download still leaves a
  // visible indicator behind instead of nothing at all.
  statusBar = new PyPilotStatusBar();
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // ── 2. Resolve the helper binary ─────────────────────────────────────────
  // One "PyPilot" output channel for both the engine lookup (which helper,
  // verified downloads) and the language client below.
  const output = vscode.window.createOutputChannel("PyPilot");
  context.subscriptions.push(output);
  const log = (line: string) => output.appendLine(`[engine] ${line}`);

  let helperPath: string;
  try {
    helperInfo = await ensureHelper(context, log);
    helperPath = helperInfo.path;
    log(`using ${helperInfo.path} v${helperInfo.version} (${helperInfo.source})`);
  } catch (err) {
    log(`no usable helper: ${err}`);
    statusBar.setStatus("unavailable", "helper not found");
    vscode.window.showErrorMessage(
      `PyPilot: could not locate the helper binary. ${err}\n` +
        "Install `pypilot` manually and ensure it is on your PATH, or check your internet connection."
    );
    return testApi;
  }

  // ── 2b. Background update check (non-blocking) ───────────────────────────
  // Runs after activation so it never delays startup.
  if (helperInfo) {
    checkForHelperUpdate(context, helperInfo).catch((err) => {
      console.warn(`PyPilot: update check failed (non-fatal): ${err}`);
    });
  }

  // ── 3. Language client ────────────────────────────────────────────────────
  const serverOptions: ServerOptions = {
    command: helperPath,
    args: ["lsp"],
  };

  const clientOptions: LanguageClientOptions = {
    // Activate for Python files and the manifest formats PyPilot understands.
    documentSelector: [
      { scheme: "file", language: "python" },
      // Python cells inside notebooks (.ipynb). The server does not advertise
      // notebookDocumentSync, so vscode-languageclient syncs each cell as an
      // ordinary text document (didOpen/didChange keyed by the cell URI),
      // which is all diagnostics and code actions need.
      { scheme: "vscode-notebook-cell", language: "python" },
      { scheme: "file", pattern: "**/requirements.txt" },
      { scheme: "file", pattern: "**/pyproject.toml" },
      { scheme: "file", pattern: "**/environment.yml" },
    ],
    // The pixi environment the server should use (the same one venv.ts
    // selects as the interpreter). The server reads it from here at startup;
    // later changes arrive through `configurationSection` below.
    initializationOptions: {
      pixiEnvironment: pixiEnvName(vscode.workspace.workspaceFolders?.[0]),
    },
    synchronize: {
      // Sends workspace/didChangeConfiguration with `{ settings: { pypilot:
      // { ... } } }` once after startup and whenever a pypilot.* setting
      // changes. Servers that do not read it simply ignore the notification.
      configurationSection: "pypilot",
      fileEvents: vscode.workspace.createFileSystemWatcher(
        "**/{requirements.txt,pyproject.toml,pixi.toml,environment.yml,*.py}"
      ),
    },
    outputChannel: output,
  };

  client = new LanguageClient(
    "pypilot",
    "PyPilot",
    serverOptions,
    clientOptions
  );

  // Update the status bar once the server is ready.
  // In vscode-languageclient v9, start() returns Promise<void> (not Disposable),
  // and onReady() was removed. Use start() directly for readiness.
  client.start().then(() => {
    statusBar?.setStatus("ok");
  }).catch((err) => {
    console.error("PyPilot LSP failed to start:", err);
    statusBar?.setStatus("error", "LSP failed to start");
    vscode.window.showErrorMessage(`PyPilot LSP failed to start: ${err}`);
  });

  context.subscriptions.push({ dispose: () => client?.stop() });

  // ── 4. Commands ───────────────────────────────────────────────────────────
  registerCommands(context, client, statusBar, helperPath);

  // ── 5. Task provider ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.tasks.registerTaskProvider(
      PyPilotTaskProvider.taskType,
      new PyPilotTaskProvider(helperPath)
    )
  );

  // ── 6. Workspace onboarding ───────────────────────────────────────────────
  const cfg = vscode.workspace.getConfiguration("pypilot");
  if (cfg.get<boolean>("autoCheckOnOpen", true)) {
    // Delay slightly so the LSP server has time to start and run its first scan.
    setTimeout(() => {
      runOnboardingCheck(context).catch((err) => {
        console.warn(`PyPilot: onboarding check failed (non-fatal): ${err}`);
      });
    }, 3000);
  }

  return testApi;
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}

// ---------------------------------------------------------------------------
// Workspace onboarding popup (VS Code equivalent of the Zed F5 toast)
// ---------------------------------------------------------------------------

async function runOnboardingCheck(context: vscode.ExtensionContext): Promise<void> {
  if (!client) return;

  const notifications = vscode.workspace
    .getConfiguration("pypilot")
    .get<string>("notifications", "problems-only");

  if (notifications === "off") return;

  // The LSP server runs the scan itself and reports anything it finds with
  // window/showMessage(Request), which vscode-languageclient turns into VS
  // Code notifications on its own. `pypilot.notifications` does not filter
  // those yet — this function only adds the "all" hook below.
  //
  // If the user chose "all" notifications, also register a command to open
  // the report panel immediately on any informational finding.
  if (notifications === "all") {
    context.subscriptions.push(
      vscode.commands.registerCommand("pypilot._openReportInternal", () => {
        ReportPanel.show();
      })
    );
  }
}
