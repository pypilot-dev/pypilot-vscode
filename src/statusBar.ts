/**
 * statusBar.ts — a persistent status bar item showing the current environment
 * health at a glance. Clicking it runs setup if the environment has issues,
 * or opens the doctor report if everything is fine.
 *
 * The tooltip also describes the project environment of the folder the user
 * is working in (the active editor's, or the only one): the Python version,
 * the environment path, the package manager PyPilot uses and, in pixi
 * projects, the pixi environment. All of it comes from files on disk
 * (`pyvenv.cfg`, pixi's `conda-meta`, the manifests) and a PATH lookup for
 * uv, the same checks venv.ts and project.ts already make: no interpreter
 * or helper process is started for it.
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { activeFolder } from './clients';
import { resolvePackageManager } from './project';
import { cfgVersion, condaMetaVersion, projectEnv } from './venv';

export type EnvStatus = 'ok' | 'warning' | 'error' | 'checking' | 'idle' | 'unavailable';

const REFRESH_DEBOUNCE_MS = 500;

/** The folder the tooltip describes: the active editor's, else the only one. */
function describedFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return activeFolder() ?? (folders.length === 1 ? folders[0] : undefined);
}

/** Markdown lines describing `folder`'s environment, from cheap file checks. */
export function describeEnvironment(folder: vscode.WorkspaceFolder): string[] {
  const env = projectEnv(folder);
  const exists = fs.existsSync(env.python);
  const version = exists ? (env.kind === 'pixi' ? condaMetaVersion(env.dir) : cfgVersion(env.dir)) : undefined;
  const { manager, auto } = resolvePackageManager(folder);
  const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;

  const lines: string[] = [];
  if (multiRoot) lines.push(`$(folder) Folder: **${md(folder.name)}**`);
  lines.push(`$(python) Python: ${version ? `**${version}**` : exists ? 'unknown' : 'no environment yet'}`);
  lines.push(
    exists
      ? `$(folder-opened) Environment: ${code(env.dir)}`
      : `$(folder-opened) Environment: none yet (${code(env.dir)}), run **PyPilot: Set Up Environment**`
  );
  lines.push(`$(package) Package manager: **${manager}**${auto ? ' (auto)' : ''}`);
  if (env.kind === 'pixi') lines.push(`$(layers) pixi environment: **${md(env.name ?? 'default')}**`);
  return lines;
}

/** A path as inline code; backslashes stay literal inside a code span. */
function code(s: string): string {
  return `\`${s.replace(/`/g, "'")}\``;
}

/** Escape Markdown punctuation in a value shown in the tooltip. */
function md(s: string): string {
  return s.replace(/[\\`*_{}[\]<>|]/g, (c) => `\\${c}`);
}

export class PyPilotStatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private status: EnvStatus = 'idle';
  private detail: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // Highest priority puts us to the left of the Python interpreter selector.
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.name = 'PyPilot';
    this.setStatus('idle');
    this.item.show();

    // Keep the environment part of the tooltip current.
    const watcher = vscode.workspace.createFileSystemWatcher(
      '**/{.venv/pyvenv.cfg,.pixi/envs/*/conda-meta/history,pixi.toml,pyproject.toml}'
    );
    const refresh = () => this.scheduleRefresh();
    watcher.onDidCreate(refresh);
    watcher.onDidChange(refresh);
    watcher.onDidDelete(refresh);
    this.disposables.push(
      watcher,
      vscode.window.onDidChangeActiveTextEditor(refresh),
      vscode.workspace.onDidChangeWorkspaceFolders(refresh),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('pypilot')) refresh();
      }),
      // uv may have been installed meanwhile (auto mode).
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) refresh();
      })
    );
  }

  setStatus(status: EnvStatus, detail?: string): void {
    this.status = status;
    this.detail = detail;
    this.render();
  }

  private scheduleRefresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.render();
    }, REFRESH_DEBOUNCE_MS);
  }

  private render(): void {
    const detail = this.detail;
    let headline: string;
    switch (this.status) {
      case 'ok':
        this.item.text = `$(check) PyPilot${detail ? `: ${detail}` : ''}`;
        headline = detail
          ? `PyPilot: ${detail} — click to open the doctor report`
          : 'PyPilot: environment looks good — click to open the doctor report';
        this.item.backgroundColor = undefined;
        this.item.command = 'pypilot.doctor';
        break;

      case 'warning':
        this.item.text = `$(warning) PyPilot${detail ? `: ${detail}` : ''}`;
        headline = `PyPilot: ${detail ?? 'environment needs attention'} — click to fix`;
        this.item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
        this.item.command = 'pypilot.setup';
        break;

      case 'error':
        this.item.text = `$(error) PyPilot${detail ? `: ${detail}` : ''}`;
        headline = `PyPilot: ${detail ?? 'environment error'} — click to fix`;
        this.item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.errorBackground'
        );
        this.item.command = 'pypilot.setup';
        break;

      case 'checking':
        this.item.text = '$(sync~spin) PyPilot: checking…';
        headline = 'PyPilot: scanning the workspace…';
        this.item.backgroundColor = undefined;
        this.item.command = undefined;
        break;

      case 'unavailable':
        this.item.text = `$(warning) PyPilot${detail ? `: ${detail}` : ''}`;
        headline =
          'PyPilot: the pypilot helper binary could not be located — see the error notification for details';
        this.item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
        // No command: activation stopped before any were registered.
        this.item.command = undefined;
        break;

      case 'idle':
      default:
        this.item.text = '$(python) PyPilot';
        headline = 'PyPilot: Python environment manager — click to open report';
        this.item.backgroundColor = undefined;
        this.item.command = 'pypilot.doctor';
        break;
    }

    const folder = describedFolder();
    let lines: string[] = [];
    try {
      lines = folder ? describeEnvironment(folder) : [];
    } catch (err) {
      console.warn(`PyPilot: could not describe the environment: ${err}`);
    }
    const tooltip = new vscode.MarkdownString(
      [md(headline), ...(lines.length ? ['', lines.join('  \n')] : [])].join('\n')
    );
    tooltip.supportThemeIcons = true;
    this.item.tooltip = tooltip;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
    this.item.dispose();
  }
}
