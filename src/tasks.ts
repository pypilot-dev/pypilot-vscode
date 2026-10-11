/**
 * tasks.ts — VS Code TaskProvider for PyPilot.
 *
 * Provides palette-accessible tasks (via "Tasks: Run Task") that mirror the
 * Zed task templates. Each task runs the `pypilot` CLI directly in the
 * integrated terminal, so the user sees streaming output.
 *
 * Task type: "pypilot" (declared in package.json contributes.taskDefinitions).
 */

import * as vscode from "vscode";

interface PyPilotTaskDefinition extends vscode.TaskDefinition {
  type: "pypilot";
  task: string;
  package?: string;
}

/** All statically-known tasks. Shown in "Tasks: Run Task" without any config. */
const PREDEFINED_TASKS: PyPilotTaskDefinition[] = [
  { type: "pypilot", task: "setup" },
  { type: "pypilot", task: "doctor" },
  { type: "pypilot", task: "fix python" },
  { type: "pypilot", task: "fix cuda" },
  { type: "pypilot", task: "update-data" },
  { type: "pypilot", task: "migrate-conda" },
];

const TASK_LABELS: Record<string, string> = {
  setup: "PyPilot: Set Up Environment",
  doctor: "PyPilot: Doctor (show report)",
  "fix python": "PyPilot: Fix Python Version",
  "fix cuda": "PyPilot: Fix CUDA / PyTorch Build",
  "update-data": "PyPilot: Update Bundled Data Tables",
  "migrate-conda": "PyPilot: Migrate Conda → pyproject.toml",
};

export class PyPilotTaskProvider implements vscode.TaskProvider {
  static readonly taskType = "pypilot";

  /**
   * `helperPath` is the binary the extension actually resolved (a PATH install
   * or the managed download). Tasks run that exact path so they still work on
   * machines where `pypilot` is not on the shell PATH.
   */
  constructor(private readonly helperPath: string = "pypilot") {}

  provideTasks(): vscode.Task[] {
    return PREDEFINED_TASKS.map((def) => buildTask(def, this.helperPath));
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const def = task.definition as PyPilotTaskDefinition;
    if (def.type === PyPilotTaskProvider.taskType && def.task) {
      return buildTask(def, this.helperPath);
    }
    return undefined;
  }
}

function buildTask(def: PyPilotTaskDefinition, helperPath: string): vscode.Task {
  const args = def.task.split(" ");
  if (def.package) {
    args.push(def.package);
  }

  const shellExec = new vscode.ShellExecution(helperPath, args, {
    // Use the workspace root so `pypilot` picks up the project's config.
    cwd: "${workspaceFolder}",
  });

  const task = new vscode.Task(
    def,
    vscode.TaskScope.Workspace,
    TASK_LABELS[def.task] ?? `pypilot ${def.task}`,
    "PyPilot",
    shellExec,
    // Problem matchers: none needed (PyPilot speaks LSP diagnostics directly).
    []
  );

  // Setup and fix tasks are "build" kind so they appear prominently.
  if (def.task === "setup" || def.task.startsWith("fix")) {
    task.group = vscode.TaskGroup.Build;
  }

  // Always run in the panel so the user sees streaming output.
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Shared,
    showReuseMessage: false,
    clear: true,
  };

  // Never allow two setups to run simultaneously.
  task.runOptions = { reevaluateOnRerun: true };

  return task;
}
