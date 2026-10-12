/**
 * statusBar.ts — a persistent status bar item showing the current environment
 * health at a glance. Clicking it runs setup if the environment has issues,
 * or opens the doctor report if everything is fine.
 */

import * as vscode from 'vscode';

export type EnvStatus = 'ok' | 'warning' | 'error' | 'checking' | 'idle' | 'unavailable';

export class PyPilotStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    // Highest priority puts us to the left of the Python interpreter selector.
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.name = 'PyPilot';
    this.setStatus('idle');
    this.item.show();
  }

  setStatus(status: EnvStatus, detail?: string): void {
    switch (status) {
      case 'ok':
        this.item.text = `$(check) PyPilot${detail ? `: ${detail}` : ''}`;
        this.item.tooltip = detail
          ? `PyPilot: ${detail} — click to open the doctor report`
          : 'PyPilot: environment looks good — click to open the doctor report';
        this.item.backgroundColor = undefined;
        this.item.command = 'pypilot.doctor';
        break;

      case 'warning':
        this.item.text = `$(warning) PyPilot${detail ? `: ${detail}` : ''}`;
        this.item.tooltip = `PyPilot: ${detail ?? 'environment needs attention'} — click to fix`;
        this.item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.warningBackground'
        );
        this.item.command = 'pypilot.setup';
        break;

      case 'error':
        this.item.text = `$(error) PyPilot${detail ? `: ${detail}` : ''}`;
        this.item.tooltip = `PyPilot: ${detail ?? 'environment error'} — click to fix`;
        this.item.backgroundColor = new vscode.ThemeColor(
          'statusBarItem.errorBackground'
        );
        this.item.command = 'pypilot.setup';
        break;

      case 'checking':
        this.item.text = '$(sync~spin) PyPilot: checking…';
        this.item.tooltip = 'PyPilot: scanning the workspace…';
        this.item.backgroundColor = undefined;
        this.item.command = undefined;
        break;

      case 'unavailable':
        this.item.text = `$(warning) PyPilot${detail ? `: ${detail}` : ''}`;
        this.item.tooltip =
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
        this.item.tooltip = 'PyPilot: Python environment manager — click to open report';
        this.item.backgroundColor = undefined;
        this.item.command = 'pypilot.doctor';
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
