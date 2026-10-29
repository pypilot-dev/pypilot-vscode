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
  State,
} from "vscode-languageclient/node";
import { PyPilotStatusBar } from "./statusBar";
import { checkForHelperUpdate, ensureHelper } from "./downloader";

// Must match the command IDs registered in the LSP server (lsp/mod.rs).
const CMD_FIX = "pypilot.fixEverything";
const CMD_DETAILS = "pypilot.showDetails";
const CMD_INSTALL = "pypilot.installPackage";
const CMD_RECREATE = "pypilot.recreateWithPython";
const CMD_INSTALL_UV = "pypilot.installUvGlobally";
const CMD_INSTALL_PIXI = "pypilot.installPixi";

// vscode-languageclient registers every command the server lists in
// executeCommandProvider under its own id, and registering an id twice
// throws. So palette commands never reuse a server id: "PyPilot: Install uv
// Globally" is `pypilot.installUv` -> server `pypilot.installUvGlobally`, and
// "PyPilot: Install pixi" is `pypilot.installPixiCli` -> server
// `pypilot.installPixi`.

/** pixi's official installers (https://pixi.sh). */
const PIXI_INSTALL_WINDOWS =
  'powershell -ExecutionPolicy Bypass -c "irm -useb https://pixi.sh/install.ps1 | iex"';
const PIXI_INSTALL_UNIX = "curl -fsSL https://pixi.sh/install.sh | sh";

/**
 * True if the server advertises `command` (older helpers lack new ones).
 * Waits for a client that is still starting: its capabilities are only
 * known once `initialize` has returned.
 */
export async function serverSupports(client: LanguageClient, command: string): Promise<boolean> {
  if (client.state === State.Starting) {
    // start() returns the pending start promise when already starting (and
    // is never called here on a stopped client, which would restart it).
    await client.start().catch(() => undefined);
  }
  return client.initializeResult?.capabilities.executeCommandProvider?.commands.includes(command) ?? false;
}

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
  statusBar: PyPilotStatusBar,
  /** The binary the extension resolved: a PATH install or the managed download. */
  helperPath: string
): void {
  // VS Code passes extra arguments into command callbacks (keybindings, other
  // extensions). `never[]` keeps the zero-argument handlers type-safe while
  // still letting `pypilot.install` accept an optional package name.
  const r = (id: string, fn: (...args: never[]) => unknown) =>
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
  // The report panel passes the package it offered to install; a palette
  // invocation passes nothing and prompts as before.
  r("pypilot.install", async (presetArg?: string) => {
    const preset = typeof presetArg === "string" && presetArg.trim() ? presetArg.trim() : undefined;
    const pkg = await vscode.window.showInputBox({
      prompt: "Package name to install",
      placeHolder: "e.g. mediapipe, numpy, requests",
      value: preset,
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
          // Run the resolved binary: on a managed download `pypilot` is not
          // necessarily on the shell PATH.
          const task = new vscode.Task(
            { type: "shell" },
            vscode.TaskScope.Workspace,
            "pypilot update-data",
            "PyPilot",
            new vscode.ShellExecution(helperPath, ["update-data"])
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
          // Same as update-data: run the resolved binary, not a bare name.
          const task = new vscode.Task(
            { type: "shell" },
            vscode.TaskScope.Workspace,
            "pypilot migrate-conda",
            "PyPilot",
            new vscode.ShellExecution(helperPath, ["migrate-conda"])
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

  // ── pypilot.installPixiCli ────────────────────────────────────────────────
  // Same shape as installUv: the server runs pixi's installer and reports
  // the outcome itself. A helper too old to know the command gets the
  // official installer in a terminal instead, after asking.
  r("pypilot.installPixiCli", async () => {
    if (!(await serverSupports(client, CMD_INSTALL_PIXI))) {
      const script = process.platform === "win32" ? PIXI_INSTALL_WINDOWS : PIXI_INSTALL_UNIX;
      const answer = await vscode.window.showInformationMessage(
        "PyPilot: this helper cannot install pixi itself. Run pixi's official installer in a terminal?",
        { modal: true, detail: script },
        "Run installer"
      );
      if (answer !== "Run installer") return;
      const task = new vscode.Task(
        { type: "shell" },
        vscode.TaskScope.Workspace,
        "install pixi",
        "PyPilot",
        new vscode.ShellExecution(script)
      );
      try {
        await vscode.tasks.executeTask(task);
      } catch (err) {
        vscode.window.showErrorMessage(`PyPilot: pixi install failed. ${err}`);
      }
      return;
    }

    statusBar.setStatus("checking");
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "PyPilot",
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "Installing pixi…" });
        try {
          const ok = await runServerCommand(client, CMD_INSTALL_PIXI);
          statusBar.setStatus(ok ? "ok" : "idle");
        } catch (err) {
          statusBar.setStatus("idle");
          vscode.window.showErrorMessage(`PyPilot: pixi install failed. ${err}`);
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
