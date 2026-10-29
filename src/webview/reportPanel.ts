/**
 * reportPanel.ts — A VS Code Webview panel that renders the PyPilot doctor
 * report as a rich interactive HTML page instead of a plain markdown file.
 *
 * The panel is created lazily and reused (singleton). Its Markdown is the
 * report the server produces for `pypilot.showDetails` (see report.ts); the
 * panel renders it as HTML with color-coded badges and action buttons that
 * invoke VS Code commands, and can export it: "Copy as Markdown" puts the
 * server's Markdown on the clipboard, "Save as HTML" writes a standalone
 * page with inline styles in the panel's current colors and no scripts.
 */

import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

/** Where the server writes the report it opens with window/showDocument. */
export const REPORT_FILE = path.join(os.tmpdir(), "pypilot-report.md");

/** The theme variables the page uses, sent back by the webview on export. */
const THEME_VARS = [
  "--vscode-editor-background",
  "--vscode-editor-foreground",
  "--vscode-textLink-foreground",
  "--vscode-panel-border",
  "--vscode-editor-inactiveSelectionBackground",
  "--vscode-descriptionForeground",
  "--vscode-font-family",
  "--vscode-font-size",
  "--vscode-editor-font-family",
] as const;

/** Used for a variable the webview could not report (VS Code Dark Modern). */
const DEFAULT_THEME: Record<string, string> = {
  "--vscode-editor-background": "#1f1f1f",
  "--vscode-editor-foreground": "#cccccc",
  "--vscode-textLink-foreground": "#4daafc",
  "--vscode-panel-border": "#2b2b2b",
  "--vscode-editor-inactiveSelectionBackground": "#3a3d41",
  "--vscode-descriptionForeground": "#9d9d9d",
  "--vscode-font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  "--vscode-font-size": "13px",
  "--vscode-editor-font-family": "Consolas, 'Courier New', monospace",
};

export interface ReportOptions {
  /** The folder the report is about (shown in multi-root windows). */
  folder?: vscode.WorkspaceFolder;
  /** Show the "Fix CUDA / PyTorch" button. */
  showCuda?: boolean;
}

interface PanelMessage {
  command: string;
  arg?: string;
  theme?: Record<string, unknown>;
}

export class ReportPanel {
  private static instance: ReportPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private markdown = "";
  private options: ReportOptions = {};

  private constructor() {
    this.panel = vscode.window.createWebviewPanel(
      "pypilotReport",
      "PyPilot: Environment Report",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    this.panel.onDidDispose(() => {
      ReportPanel.instance = undefined;
    });

    // Handle messages from the webview (action buttons).
    this.panel.webview.onDidReceiveMessage(async (msg: PanelMessage) => {
      switch (msg.command) {
        case "setup":
          await vscode.commands.executeCommand("pypilot.setup");
          break;
        case "fixPython":
          await vscode.commands.executeCommand("pypilot.fixPython");
          break;
        case "fixCuda":
          await vscode.commands.executeCommand("pypilot.fixCuda");
          break;
        case "install":
          if (msg.arg) {
            await vscode.commands.executeCommand("pypilot.install", msg.arg);
          }
          break;
        case "copyMarkdown":
          await this.copyMarkdown();
          break;
        case "saveHtml":
          await this.saveHtml(msg.theme);
          break;
      }
    });
  }

  /** True while the panel is open. */
  static isOpen(): boolean {
    return ReportPanel.instance !== undefined;
  }

  /**
   * Show the panel with `markdown`, creating it if needed. Without
   * `markdown` it shows the last report the server wrote.
   */
  static show(markdown?: string, options: ReportOptions = {}): ReportPanel {
    const panel = ReportPanel.instance ?? new ReportPanel();
    ReportPanel.instance = panel;
    panel.set(markdown ?? readReportFile(), options);
    panel.panel.reveal(vscode.ViewColumn.Beside);
    return panel;
  }

  /** Replace the content of an open panel; does nothing when it is closed. */
  static update(markdown: string, options: ReportOptions = {}): void {
    ReportPanel.instance?.set(markdown, options);
  }

  private set(markdown: string, options: ReportOptions): void {
    this.markdown = markdown;
    this.options = options;
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    this.panel.title =
      multiRoot && options.folder
        ? `PyPilot: Environment Report (${options.folder.name})`
        : "PyPilot: Environment Report";
    this.panel.webview.html = buildHtml(markdown, {
      mode: "panel",
      folderName: multiRoot ? options.folder?.name : undefined,
      showCuda: options.showCuda ?? true,
    });
  }

  private async copyMarkdown(): Promise<void> {
    await vscode.env.clipboard.writeText(this.markdown);
    vscode.window.showInformationMessage("PyPilot: report copied to the clipboard as Markdown.");
  }

  private async saveHtml(reported: Record<string, unknown> | undefined): Promise<void> {
    const base = this.options.folder?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
      defaultUri: base
        ? vscode.Uri.joinPath(base, "pypilot-report.html")
        : vscode.Uri.file(path.join(os.homedir(), "pypilot-report.html")),
      filters: { HTML: ["html", "htm"] },
      saveLabel: "Save Report",
      title: "PyPilot: Save Report as HTML",
    });
    if (!target) return;

    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const html = buildHtml(this.markdown, {
      mode: "export",
      folderName: multiRoot ? this.options.folder?.name : undefined,
      theme: exportTheme(reported),
      generated: new Date(),
    });
    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from(html, "utf8"));
    } catch (err) {
      vscode.window.showErrorMessage(`PyPilot: could not save the report. ${err}`);
      return;
    }
    const open = await vscode.window.showInformationMessage(
      `PyPilot: report saved to ${target.fsPath}.`,
      "Open in Browser"
    );
    if (open) await vscode.env.openExternal(target);
  }
}

/** The report the server wrote last, or a placeholder. */
function readReportFile(): string {
  try {
    return fs.readFileSync(REPORT_FILE, "utf8");
  } catch {
    return "# PyPilot\n\nNo report yet. Run **PyPilot: Doctor** to generate one.";
  }
}

/**
 * The theme for an exported page: the values the webview reported for each
 * variable, when they are plain CSS values, else the defaults. Anything that
 * could close the declaration or the style element is dropped.
 */
function exportTheme(reported: Record<string, unknown> | undefined): Record<string, string> {
  const theme: Record<string, string> = {};
  for (const name of THEME_VARS) {
    const value = reported?.[name];
    theme[name] =
      typeof value === "string" && value.trim() && value.length < 300 && !/[<>{};\\]/.test(value)
        ? value.trim()
        : DEFAULT_THEME[name];
  }
  return theme;
}

// ---------------------------------------------------------------------------
// HTML renderer — converts the markdown report into a styled webview page.
// ---------------------------------------------------------------------------

interface HtmlOptions {
  /** "panel": the live webview with buttons; "export": a standalone file. */
  mode: "panel" | "export";
  folderName?: string;
  showCuda?: boolean;
  /** Export only: concrete values for the VS Code theme variables. */
  theme?: Record<string, string>;
  /** Export only: when the file was written. */
  generated?: Date;
  /** Panel only: the script nonce; a fresh random one when omitted. */
  nonce?: string;
}

/**
 * The page for `markdown`. In the panel, scripts only run with this
 * render's nonce: no `unsafe-inline`, no inline event handlers (buttons
 * carry `data-command`), so markup that slipped through `markdownToHtml`
 * cannot execute. The nonce is new on every call, i.e. on every refresh.
 * The exported page has no scripts at all.
 */
export function buildHtml(markdown: string, opts: HtmlOptions): string {
  const html = markdownToHtml(markdown);
  const nonce = opts.nonce ?? randomBytes(16).toString("base64");
  const panel = opts.mode === "panel";
  // The exported page has no VS Code to supply the theme variables, so it
  // defines them itself, with the colors the panel had when it was saved.
  const themeVars = opts.theme
    ? `:root {\n${Object.entries(opts.theme)
        .map(([k, v]) => `    ${k}: ${v};`)
        .join("\n")}\n  }\n  `
    : "";
  const csp = panel
    ? `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`
    : "default-src 'none'; style-src 'unsafe-inline';";
  const subtitle = [
    "Deterministic Python environment doctor · no AI · no API keys",
    opts.folderName ? `Folder: ${esc(opts.folderName)}` : "",
    opts.generated ? `Exported ${esc(opts.generated.toLocaleString())}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const actions = panel
    ? `<div class="actions">
  <button data-command="setup">Fix Everything</button>
  <button class="secondary" data-command="fixPython">Fix Python Version</button>
  ${opts.showCuda === false ? "" : `<button class="secondary" data-command="fixCuda">Fix CUDA / PyTorch</button>`}
  <span class="spacer"></span>
  <button class="secondary" data-command="copyMarkdown" title="Copy the report as Markdown">Copy as Markdown</button>
  <button class="secondary" data-command="saveHtml" title="Save a standalone HTML copy of this report">Save as HTML</button>
</div>

<hr style="margin: 20px 0; border-color: var(--border);">`
    : `<hr style="margin: 20px 0; border-color: var(--border);">`;
  const script = panel
    ? `<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const THEME_VARS = ${JSON.stringify(THEME_VARS)};
// The export uses the colors this panel is showing right now.
function saveHtml() {
  const style = getComputedStyle(document.documentElement);
  const theme = {};
  for (const name of THEME_VARS) theme[name] = style.getPropertyValue(name).trim();
  vscode.postMessage({ command: 'saveHtml', theme });
}
for (const button of document.querySelectorAll("button[data-command]")) {
  button.addEventListener("click", () => {
    const command = button.dataset.command;
    if (command === "saveHtml") saveHtml();
    else vscode.postMessage({ command, arg: button.dataset.arg });
  });
}
</script>`
    : "";

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>PyPilot Report${opts.folderName ? ` (${esc(opts.folderName)})` : ""}</title>
<style>
  ${themeVars}:root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --accent: var(--vscode-textLink-foreground, #4fc3f7);
    --ok: #4caf50;
    --warn: #ff9800;
    --err: #f44336;
    --info: #2196f3;
    --border: var(--vscode-panel-border, #333);
    --card: var(--vscode-editor-inactiveSelectionBackground, #1e1e2e);
    --radius: 8px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    background: var(--bg);
    color: var(--fg);
    padding: 24px;
    max-width: 900px;
    margin: 0 auto;
    line-height: 1.6;
  }
  a { color: var(--accent); }
  h1 { font-size: 1.6em; margin-bottom: 4px; }
  h2 { font-size: 1.15em; margin: 20px 0 8px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
  h3 { font-size: 1em; margin: 12px 0 4px; }
  p { margin: 6px 0; }
  ul, ol { margin: 6px 0 6px 20px; }
  li { margin: 2px 0; }
  code {
    font-family: var(--vscode-editor-font-family, 'Cascadia Code', monospace);
    font-size: 0.9em;
    background: rgba(255,255,255,0.08);
    border-radius: 3px;
    padding: 1px 5px;
  }
  pre > code { display: block; padding: 12px; overflow-x: auto; }

  /* Severity badges */
  .badge {
    display: inline-block;
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 0.78em;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    margin-right: 6px;
    vertical-align: middle;
  }
  .badge-error  { background: var(--err);  color: #fff; }
  .badge-warn   { background: var(--warn); color: #000; }
  .badge-info   { background: var(--info); color: #fff; }
  .badge-ok     { background: var(--ok);   color: #fff; }

  /* Finding cards */
  .finding {
    border-left: 4px solid var(--border);
    background: var(--card);
    border-radius: var(--radius);
    padding: 12px 16px;
    margin: 10px 0;
  }
  .finding.error  { border-left-color: var(--err); }
  .finding.warn   { border-left-color: var(--warn); }
  .finding.info   { border-left-color: var(--info); }

  /* Action buttons */
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
  .actions .spacer { flex: 1; }
  button {
    cursor: pointer;
    border: none;
    border-radius: 6px;
    padding: 8px 18px;
    font-size: 13px;
    font-weight: 500;
    transition: opacity 0.15s;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
  }
  button:hover { opacity: 0.85; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
  }

  table { border-collapse: collapse; width: 100%; margin: 10px 0; }
  th, td { text-align: left; padding: 6px 12px; border: 1px solid var(--border); }
  th { background: rgba(255,255,255,0.05); font-weight: 600; }
  tr:hover { background: rgba(255,255,255,0.03); }

  .header-row { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
  .logo { font-size: 2em; }
  .subtitle { color: var(--vscode-descriptionForeground, #888); font-size: 0.9em; }
</style>
</head>
<body>
<div class="header-row">
  <span class="logo">🐍</span>
  <div>
    <h1>PyPilot: Environment Report</h1>
    <p class="subtitle">${subtitle}</p>
  </div>
</div>

${actions}

${html}

${script}
</body>
</html>`;
}

/** Minimal markdown-to-HTML converter for the subset the helper emits. */
function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inTable = false;
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Severity headings → finding cards
    if (/^### (Error|Warning|Note):/.test(line)) {
      if (inList) { out.push("</ul>"); inList = false; }
      const sev = line.match(/^### (Error|Warning|Note):/)?.[1] ?? "";
      const cls = sev === "Error" ? "error" : sev === "Warning" ? "warn" : "info";
      const badgeCls = sev === "Error" ? "badge-error" : sev === "Warning" ? "badge-warn" : "badge-info";
      const title = line.replace(/^### (Error|Warning|Note):/, "").trim();
      out.push(`<div class="finding ${cls}"><p><span class="badge ${badgeCls}">${sev}</span><strong>${esc(title)}</strong></p>`);
      // Next non-empty line is the detail
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && !lines[j].startsWith("#")) {
        out.push(`<p>${inline(lines[j])}</p>`);
        i = j;
      }
      out.push("</div>");
      continue;
    }

    // Table rows
    if (line.startsWith("|")) {
      if (!inTable) { inTable = true; out.push("<table>"); }
      if (line.replace(/\|/g, "").trim().match(/^[-\s]+$/)) continue; // separator
      const cells = line.split("|").slice(1, -1).map(c => c.trim());
      const tag = i === 0 || (i > 0 && lines[i-1].startsWith("|") === false) ? "th" : "td";
      out.push("<tr>" + cells.map(c => `<${tag}>${inline(c)}</${tag}>`).join("") + "</tr>");
      continue;
    } else if (inTable) {
      out.push("</table>"); inTable = false;
    }

    // Headings
    const hm = line.match(/^(#{1,3})\s+(.*)/);
    if (hm) {
      if (inList) { out.push("</ul>"); inList = false; }
      const lvl = hm[1].length;
      out.push(`<h${lvl}>${inline(hm[2])}</h${lvl}>`);
      continue;
    }

    // Bullet lists
    if (/^[-*]\s/.test(line)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(line.replace(/^[-*]\s/, ""))}</li>`);
      continue;
    } else if (inList) {
      out.push("</ul>"); inList = false;
    }

    // Horizontal rules
    if (/^---+$/.test(line.trim())) {
      out.push("<hr>");
      continue;
    }

    // Empty lines → paragraph break
    if (line.trim() === "") {
      out.push("<p></p>");
      continue;
    }

    out.push(`<p>${inline(line)}</p>`);
  }

  if (inList) out.push("</ul>");
  if (inTable) out.push("</table>");

  return out.join("\n");
}

/**
 * HTML-escape. Quotes are escaped too, because this output is also placed
 * inside attributes (`<a href="…">`); without it a `"` in the report could
 * break out of the attribute.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Inline emphasis, inline code and links. Link targets are restricted to
 *  http(s) so a `javascript:` URL in the report never becomes a live link. */
function inline(s: string): string {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/_(.+?)_/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(
      /\[(.+?)\]\((.+?)\)/g,
      (_match, text: string, href: string) =>
        /^https?:\/\//i.test(href)
          ? `<a href="${href}">${text}</a>`
          : `<code>${href}</code>`
    );
}
