/**
 * reportPanel.ts — A VS Code Webview panel that renders the PyPilot doctor
 * report as a rich interactive HTML page instead of a plain markdown file.
 *
 * The panel is created lazily and reused (singleton). The helper writes the
 * report to a temp .md file; this panel reads it and renders it as HTML with
 * color-coded badges and clickable action buttons that invoke VS Code commands.
 */

import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export class ReportPanel {
  private static instance: ReportPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly reportPath: string;
  private watcher?: fs.FSWatcher;

  private constructor() {
    this.reportPath = path.join(os.tmpdir(), "pypilot-report.md");

    this.panel = vscode.window.createWebviewPanel(
      "pypilotReport",
      "PyPilot — Environment Report",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    this.panel.onDidDispose(() => {
      this.watcher?.close();
      ReportPanel.instance = undefined;
    });

    // Handle messages from the webview (action buttons).
    this.panel.webview.onDidReceiveMessage(async (msg: { command: string; arg?: string }) => {
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
      }
    });

    // Watch the report file so the panel refreshes whenever a new scan runs.
    this.watchReport();
    this.refresh();
  }

  static show(): ReportPanel {
    if (ReportPanel.instance) {
      ReportPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      ReportPanel.instance.refresh();
      return ReportPanel.instance;
    }
    ReportPanel.instance = new ReportPanel();
    return ReportPanel.instance;
  }

  private watchReport(): void {
    const dir = path.dirname(this.reportPath);
    this.watcher = fs.watch(dir, (_event, filename) => {
      if (filename === path.basename(this.reportPath)) {
        this.refresh();
      }
    });
  }

  private refresh(): void {
    let markdown = "";
    try {
      markdown = fs.readFileSync(this.reportPath, "utf8");
    } catch {
      markdown = "# PyPilot\n\nNo report yet. Run **PyPilot: Doctor** to generate one.";
    }
    this.panel.webview.html = buildHtml(markdown);
  }
}

// ---------------------------------------------------------------------------
// HTML renderer — converts the markdown report into a styled webview page.
// ---------------------------------------------------------------------------

/**
 * The page for `markdown`. Scripts only run with this render's nonce: no
 * `unsafe-inline`, no inline event handlers (buttons carry `data-command`),
 * so markup that slipped through `markdownToHtml` cannot execute. The nonce
 * is new on every call, i.e. on every refresh of the panel.
 */
export function buildHtml(markdown: string, nonce = randomBytes(16).toString("base64")): string {
  const html = markdownToHtml(markdown);
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>PyPilot Report</title>
<style>
  :root {
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
    <h1>PyPilot — Environment Report</h1>
    <p class="subtitle">Deterministic Python environment doctor · no AI · no API keys</p>
  </div>
</div>

<div class="actions">
  <button data-command="setup">$(rocket) Fix Everything</button>
  <button class="secondary" data-command="fixPython">Fix Python Version</button>
  <button class="secondary" data-command="fixCuda">Fix CUDA / PyTorch</button>
</div>

<hr style="margin: 20px 0; border-color: var(--border);">

${html}

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
for (const button of document.querySelectorAll("button[data-command]")) {
  button.addEventListener("click", () => {
    vscode.postMessage({ command: button.dataset.command, arg: button.dataset.arg });
  });
}
</script>
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
