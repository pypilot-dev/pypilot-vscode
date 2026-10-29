/**
 * extension.ts — PyPilot VS Code extension entry point.
 *
 * Activation:
 *   0. Start `.venv` / pixi environment auto-selection (venv.ts); independent of the helper.
 *   1. Register the status bar item (before the helper lookup, so that a
 *      failed download still leaves an indicator behind).
 *   2. Locate / download the `pypilot` helper binary (downloader.ts).
 *   3. Start the language clients (`pypilot lsp`), one per workspace folder
 *      with a Python project (clients.ts).
 *   4. Register all command palette handlers.
 *   5. Register the task provider.
 *   6. On workspace open: if auto-check is on, run a silent scan and surface
 *      any findings via a VS Code-native popup with action buttons.
 *
 * Deactivation: stop the language clients (cleans up the server processes).
 */

import * as vscode from "vscode";

import { ensureHelper, checkForHelperUpdate } from "./downloader";
import { PyPilotStatusBar } from "./statusBar";
import { registerCommands } from "./commands";
import { PyPilotTaskProvider } from "./tasks";
import { ReportPanel } from "./webview/reportPanel";
import { registerVenvSelection } from "./venv";
import { registerContextKeys } from "./project";
import { ClientManager } from "./clients";
import { ReportRouter } from "./report";

let clients: ClientManager | undefined;
let statusBar: PyPilotStatusBar | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // ── 0. Project environment selection (.venv or pixi) ─────────────────────
  // Registered first because it only talks to the Python extensions: it must
  // keep working even if the helper binary cannot be found below.
  registerVenvSelection(context);
  // Context keys behind the palette's `when` clauses: plain file checks.
  registerContextKeys(context);

  // ── 1. Status bar ─────────────────────────────────────────────────────────
  // Created before the helper lookup so that a failed download still leaves a
  // visible indicator behind instead of nothing at all.
  statusBar = new PyPilotStatusBar();
  context.subscriptions.push({ dispose: () => statusBar?.dispose() });

  // ── 2. Resolve the helper binary ─────────────────────────────────────────
  let helperPath: string;
  let helperInfo: Awaited<ReturnType<typeof ensureHelper>> | undefined;
  try {
    helperInfo = await ensureHelper(context);
    helperPath = helperInfo.path;
    console.log(`PyPilot: using helper ${helperInfo.path} v${helperInfo.version} (managed=${helperInfo.managed})`);
  } catch (err) {
    statusBar.setStatus("unavailable", "helper not found");
    vscode.window.showErrorMessage(
      `PyPilot: could not locate the helper binary. ${err}\n` +
        "Install `pypilot` manually and ensure it is on your PATH, or check your internet connection."
    );
    return;
  }

  // ── 2b. Background update check (non-blocking) ───────────────────────────
  // Runs after activation so it never delays startup.
  if (helperInfo) {
    checkForHelperUpdate(context, helperInfo).catch((err) => {
      console.warn(`PyPilot: update check failed (non-fatal): ${err}`);
    });
  }

  // ── 3. Language clients ───────────────────────────────────────────────────
  // One server per workspace folder that holds a Python project; a
  // single-folder window gets exactly one, as before.
  // The report panel takes its Markdown from the server's report document.
  const reports = new ReportRouter(helperPath);
  clients = new ClientManager({
    helperPath,
    middleware: (folder) => reports.middleware(folder),
    onStarted: (_fc, ok, err) => {
      if (ok) {
        statusBar?.setStatus("ok");
        return;
      }
      statusBar?.setStatus("error", "LSP failed to start");
      vscode.window.showErrorMessage(`PyPilot LSP failed to start: ${err}`);
    },
  });
  context.subscriptions.push({ dispose: () => clients?.dispose() });
  clients.start();

  // ── 4. Commands ───────────────────────────────────────────────────────────
  registerCommands(context, clients, statusBar, helperPath, reports);

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
}

export async function deactivate(): Promise<void> {
  await clients?.dispose();
}

// ---------------------------------------------------------------------------
// Workspace onboarding popup (VS Code equivalent of the Zed F5 toast)
// ---------------------------------------------------------------------------

async function runOnboardingCheck(context: vscode.ExtensionContext): Promise<void> {
  if (!clients) return;

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
