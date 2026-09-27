/**
 * commands.ts — VSCode command palette handlers for PyPilot.
 *
 * Each command is a thin wrapper that:
 *   1. Shows a VS Code-native progress notification while running.
 *   2. Invokes the underlying LSP command (which calls into the helper binary).
 *   3. Updates the status bar based on the result.
 *
 * Commands that need user input (check, install) use showInputBox / showQuickPick
 * so the user never has to touch a terminal.
 */

import * as vscode from "vscode";
import {
  LanguageClient,
  ExecuteCommandRequest,
} from "vscode-languageclient/node";
import { PyPilotStatusBar } from "./statusBar";
import { checkForHelperUpdate, ensureHelper } from "./downloader";

// Must match the command IDs registered in the LSP server (lsp/mod.rs).
const CMD_FIX = "pypilot.fixEverything";
const CMD_DETAILS = "pypilot.showDetails";
const CMD_INSTALL = "pypilot.installPackage";
const CMD_RECREATE = "pypilot.recreateWithPython";
const CMD_INSTALL_UV = "pypilot.installUvGlobally";

/**
 * Run a server command that changes the environment and report whether it
 * worked. Since helper v1.0.4 these answer `{ ok: boolean }`; older helpers
 * answer `null`, which counts as success as it always has. The server has
 * already shown its own message naming the failed step, so callers only need
 * to avoid claiming success.
 */
async function runServerCommand(
  client: LanguageClient,
  command: string,
  args: unknown[] = []
): Promise<boolean> {
  const result = await client.sendRequest(ExecuteCommandRequest.type, {
    command,
    arguments: args,
  });
  return (result as { ok?: boolean } | null)?.ok !== false;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  client: LanguageClient,
  statusBar: PyPilotStatusBar
): void {
  const r = (id: string, fn: () => Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // ── pypilot.setup ─────────────────────────────────────────────────────────
  r("pypilot.setup", async () => {
    statusBar.setStatus("checking");
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "PyPilot",
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "Setting up the environment…" });
        try {
          if (!(await runServerCommand(client, CMD_FIX))) {
            statusBar.setStatus("error", "setup failed");
            return;
          }
          statusBar.setStatus("ok");
          vscode.window.showInformationMessage(
            "PyPilot: environment set up successfully."
          );
        } catch (err) {
          statusBar.setStatus("error", "setup failed");
          vscode.window.showErrorMessage(`PyPilot: setup failed. ${err}`);
        }
      }
    );
  });

  // ── pypilot.doctor ────────────────────────────────────────────────────────
  r("pypilot.doctor", async () => {
    statusBar.setStatus("checking");
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "PyPilot",
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "Running environment scan…" });
        try {
          await client.sendRequest(ExecuteCommandRequest.type, {
            command: CMD_DETAILS,
            arguments: [],
          });
          // The server opens the report document itself; we just update the bar.
          statusBar.setStatus("idle");
        } catch (err) {
          statusBar.setStatus("idle");
          vscode.window.showErrorMessage(`PyPilot: doctor failed. ${err}`);
        }
      }
    );
  });

  // ── pypilot.fixPython ─────────────────────────────────────────────────────
  r("pypilot.fixPython", async () => {
    statusBar.setStatus("checking");
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "PyPilot", cancellable: false },
      async (progress) => {
        progress.report({ message: "Fixing Python version…" });
        try {
          // Reuse the setup command — it recomputes the intersection and
          // rebuilds the venv on the correct Python.
          if (!(await runServerCommand(client, CMD_FIX))) {
            statusBar.setStatus("error", "fix failed");
            return;
          }
          statusBar.setStatus("ok");
          vscode.window.showInformationMessage("PyPilot: Python version fixed.");
        } catch (err) {
          statusBar.setStatus("error", "fix failed");
          vscode.window.showErrorMessage(`PyPilot: fix failed. ${err}`);
        }
      }
    );
  });

  // ── pypilot.fixCuda ───────────────────────────────────────────────────────
  r("pypilot.fixCuda", async () => {
    statusBar.setStatus("checking");
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "PyPilot", cancellable: false },
      async (progress) => {
        progress.report({ message: "Re-pinning torch/TensorFlow to the driver-matched build…" });
        try {
          if (!(await runServerCommand(client, CMD_FIX))) {
            statusBar.setStatus("error", "CUDA fix failed");
            return;
          }
          statusBar.setStatus("ok");
          vscode.window.showInformationMessage(
            "PyPilot: CUDA build re-pinned for your driver."
          );
        } catch (err) {
          statusBar.setStatus("error", "CUDA fix failed");
          vscode.window.showErrorMessage(`PyPilot: CUDA fix failed. ${err}`);
        }
      }
    );
  });

  // ── pypilot.check ─────────────────────────────────────────────────────────
  r("pypilot.check", async () => {
    const pkg = await vscode.window.showInputBox({
      prompt: "Package name to check compatibility for",
      placeHolder: "e.g. mediapipe, torch, tensorflow",
      validateInput: (v) =>
        v.trim() ? undefined : "Please enter a package name.",
    });
    if (!pkg) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "PyPilot", cancellable: false },
      async (progress) => {
        progress.report({ message: `Checking ${pkg}…` });
        try {
          // Run pypilot check via the details endpoint with a package context.
          // The LSP server surfaces the result as a show-document call.
          await client.sendRequest(ExecuteCommandRequest.type, {
            command: CMD_DETAILS,
            arguments: [pkg],
          });
        } catch (err) {
          vscode.window.showErrorMessage(`PyPilot: check failed. ${err}`);
        }
      }
    );
  });

  // ── pypilot.install ───────────────────────────────────────────────────────
  r("pypilot.install", async () => {
    const pkg = await vscode.window.showInputBox({
      prompt: "Package name to install",
      placeHolder: "e.g. mediapipe, numpy, requests",
      validateInput: (v) => {
        const t = v.trim();
        if (!t) return "Please enter a package name.";
        if (t.startsWith("-")) return "That looks like a flag, not a package name.";
        return undefined;
      },
    });
    if (!pkg) return;

    statusBar.setStatus("checking", `installing ${pkg}`);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "PyPilot", cancellable: false },
      async (progress) => {
        progress.report({ message: `Installing ${pkg}…` });
        try {
          if (!(await runServerCommand(client, CMD_INSTALL, [pkg]))) {
            statusBar.setStatus("error", "install failed");
            return;
          }
          statusBar.setStatus("ok");
          vscode.window.showInformationMessage(`PyPilot: installed ${pkg}.`);
        } catch (err) {
          statusBar.setStatus("error", "install failed");
          vscode.window.showErrorMessage(`PyPilot: install failed. ${err}`);
        }
      }
    );
  });

  // ── pypilot.updateData ────────────────────────────────────────────────────
  r("pypilot.updateData", async () => {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "PyPilot", cancellable: false },
      async (progress) => {
        progress.report({ message: "Refreshing bundled data tables…" });
        try {
          // update-data runs via the CLI helper; trigger via terminal task.
          const task = new vscode.Task(
            { type: "shell" },
            vscode.TaskScope.Workspace,
            "pypilot update-data",
            "PyPilot",
            new vscode.ShellExecution("pypilot update-data")
          );
          await vscode.tasks.executeTask(task);
        } catch (err) {
          vscode.window.showErrorMessage(`PyPilot: data update failed. ${err}`);
        }
      }
    );
  });

  // ── pypilot.migrateConda ──────────────────────────────────────────────────
  r("pypilot.migrateConda", async () => {
    const answer = await vscode.window.showInformationMessage(
      "PyPilot: Migrate environment.yml to pyproject.toml?",
      { modal: true },
      "Migrate"
    );
    if (answer !== "Migrate") return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "PyPilot", cancellable: false },
      async (progress) => {
        progress.report({ message: "Migrating conda environment…" });
        try {
          const task = new vscode.Task(
            { type: "shell" },
            vscode.TaskScope.Workspace,
            "pypilot migrate-conda",
            "PyPilot",
            new vscode.ShellExecution("pypilot migrate-conda")
          );
          await vscode.tasks.executeTask(task);
        } catch (err) {
          vscode.window.showErrorMessage(`PyPilot: migration failed. ${err}`);
        }
      }
    );
  });

  // ── pypilot.openReport ────────────────────────────────────────────────────
  r("pypilot.openReport", async () => {
    // Delegate to doctor — the LSP server opens the markdown doc itself.
    await vscode.commands.executeCommand("pypilot.doctor");
  });

  // ── pypilot.installUv ─────────────────────────────────────────────────────
  r("pypilot.installUv", async () => {
    statusBar.setStatus("checking");
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "PyPilot",
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "Installing uv globally…" });
        try {
          const ok = await runServerCommand(client, CMD_INSTALL_UV);
          statusBar.setStatus(ok ? "ok" : "idle");
        } catch (err) {
          statusBar.setStatus("idle");
          vscode.window.showErrorMessage(`PyPilot: uv install failed. ${err}`);
        }
      }
    );
  });

  // ── pypilot.updateHelper ──────────────────────────────────────────────────
  r("pypilot.updateHelper", async () => {
    // Clear the snooze so the check always runs when manually invoked.
    await context.globalState.update("pypilot.updateDismissedAt", 0);
    try {
      const info = await ensureHelper(context);
      await checkForHelperUpdate(context, info);
    } catch (err) {
      vscode.window.showErrorMessage(`PyPilot: update check failed. ${err}`);
    }
  });
}
