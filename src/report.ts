/**
 * report.ts — where the report panel gets its Markdown.
 *
 * The server builds the doctor report for `pypilot.showDetails`, writes it
 * to `<tmp>/pypilot-report.md` and asks the editor to open that file with
 * window/showDocument (before it answers the command). A showDocument
 * middleware on every client reads the file at that moment, so the panel
 * shows exactly the server's Markdown and knows which folder it is about:
 *
 * - "Open Environment Report Panel" marks its folder as waiting; the next
 *   report from that folder goes to the panel instead of a text editor.
 * - Any other report (Doctor, a "Show details" action) opens as Markdown as
 *   before, and also refreshes the panel if it is open.
 *
 * If the server answers without a showDocument (it falls back to a plain
 * message when the temp file cannot be written), the panel runs
 * `pypilot doctor --markdown` with the resolved helper instead; helpers
 * without that flag get an error message.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CancellationToken, ExecuteCommandRequest, Middleware, ShowDocumentResult } from 'vscode-languageclient/node';
import type { FolderClient } from './clients';
import { dependsOnTorch } from './project';
import { REPORT_FILE, ReportOptions, ReportPanel } from './webview/reportPanel';

const CMD_DETAILS = 'pypilot.showDetails';
const CLI_TIMEOUT_MS = 120_000;

function folderKey(folder: vscode.WorkspaceFolder | undefined): string {
  return folder ? folder.uri.toString() : '';
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

function optionsFor(folder: vscode.WorkspaceFolder | undefined): ReportOptions {
  return { folder, showCuda: folder ? dependsOnTorch(folder) : true };
}

export class ReportRouter {
  /** Folders whose next report goes to the panel, with "it arrived" callbacks. */
  private readonly waiting = new Map<string, () => void>();
  /** The last report any server produced. */
  private last: { markdown: string; folder: vscode.WorkspaceFolder | undefined } | undefined;

  constructor(private readonly helperPath: string) {}

  /** The showDocument middleware for the client serving `folder`. */
  middleware(folder: vscode.WorkspaceFolder | undefined): Middleware {
    return {
      window: {
        showDocument: async (params, next) => {
          // The library's default handler ignores the token.
          const pass = async () => (await next(params, CancellationToken.None)) as ShowDocumentResult;
          let file: string;
          try {
            file = vscode.Uri.parse(params.uri).fsPath;
          } catch {
            return pass();
          }
          if (path.basename(file) !== path.basename(REPORT_FILE)) return pass();

          let markdown: string;
          try {
            markdown = fs.readFileSync(file, 'utf8');
          } catch {
            return pass();
          }
          this.last = { markdown, folder };

          const arrived = this.waiting.get(folderKey(folder));
          if (arrived) {
            arrived();
            ReportPanel.show(markdown, optionsFor(folder));
            return { success: true };
          }
          if (ReportPanel.isOpen()) ReportPanel.update(markdown, optionsFor(folder));
          return pass();
        },
      },
    };
  }

  /** True if `uri` is the report file the server writes. */
  isReportFile(uri: vscode.Uri | undefined): boolean {
    return uri?.scheme === 'file' && samePath(uri.fsPath, REPORT_FILE);
  }

  /** Show the last report in the panel without a new scan; false if there is none. */
  showLast(): boolean {
    if (!this.last) return false;
    ReportPanel.show(this.last.markdown, optionsFor(this.last.folder));
    return true;
  }

  /** Run a fresh scan for `fc`'s folder and show it in the panel. */
  async open(fc: FolderClient): Promise<void> {
    const key = folderKey(fc.folder);
    let captured = false;
    this.waiting.set(key, () => {
      captured = true;
      this.waiting.delete(key);
    });
    try {
      await fc.client.sendRequest(ExecuteCommandRequest.type, { command: CMD_DETAILS, arguments: [] });
    } finally {
      this.waiting.delete(key);
    }
    if (captured) return;

    // No showDocument came: ask the CLI for the same Markdown.
    const markdown = await this.fromCli(fc.folder);
    if (markdown === undefined) {
      vscode.window.showErrorMessage(
        'PyPilot: the helper did not produce a report for the panel. Run "PyPilot: Check for Helper Updates", or use "PyPilot: Doctor".'
      );
      return;
    }
    this.last = { markdown, folder: fc.folder };
    ReportPanel.show(markdown, optionsFor(fc.folder));
  }

  /** `pypilot doctor --markdown` in `folder`; undefined if it prints no report. */
  private fromCli(folder: vscode.WorkspaceFolder | undefined): Promise<string | undefined> {
    const cwd = folder?.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
    return new Promise((resolve) => {
      execFile(
        this.helperPath,
        ['doctor', '--markdown'],
        { cwd, timeout: CLI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          // A report is Markdown starting with a heading. Keep it even with
          // a non-zero exit (a doctor that found problems); an old helper
          // rejects the flag and prints nothing to stdout.
          if (stdout.trimStart().startsWith('#')) {
            resolve(stdout);
            return;
          }
          if (err) console.warn(`PyPilot: pypilot doctor --markdown failed: ${err}`);
          resolve(undefined);
        }
      );
    });
  }
}
