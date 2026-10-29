/**
 * Runs inside a real VS Code (see run.ts): the extension must activate on a
 * Python project, register every command it contributes, install only
 * downloads that match their SHA-256, and open the report panel.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

import type { PyPilotTestApi } from "../src/extension";

const EXTENSION_ID = "AbdullahMasood-005.pypilot-vscode";
const BIN_NAME = process.platform === "win32" ? "pypilot.exe" : "pypilot";

/** The runner reads this file: the test host's stdout does not always reach it. */
function log(line: string): void {
  console.log(line);
  const file = process.env.PYPILOT_E2E_LOG;
  if (file) appendFileSync(file, `${line}\n`);
}

async function waitFor<T>(
  what: string,
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function rejects(what: string, run: () => Promise<unknown>, pattern: RegExp): Promise<string> {
  try {
    await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check(pattern.test(message), `${what}: unexpected error: ${message}`);
    return message;
  }
  throw new Error(`${what}: was installed, expected a refusal`);
}

export async function run(): Promise<void> {
  log("[e2e] suite started");
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("the e2e suite took longer than 4 minutes")), 240_000),
  );
  try {
    await Promise.race([steps(), deadline]);
  } catch (err) {
    log(`[e2e] FAIL: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

async function steps(): Promise<void> {
  // ── activation on a Python project ──────────────────────────────────────
  const extension = vscode.extensions.getExtension<PyPilotTestApi | undefined>(EXTENSION_ID);
  check(extension, `${EXTENSION_ID} is not loaded`);
  check(vscode.workspace.workspaceFolders?.length, "no workspace folder");
  // workspaceContains:**/*.py starts it on its own; activate() just waits.
  const api = await extension.activate();
  check(extension.isActive, "the extension did not activate");
  check(api, "activate() returned no test API (is the extension in test mode?)");
  const helper = api.helper();
  check(helper, "activation found no helper (see the PyPilot output channel)");
  log(`[e2e] extension active, helper ${helper.path} v${helper.version} (${helper.source})`);
  if (process.env.PYPILOT_E2E_EXPECT_PIN === "1") {
    // No local pypilot: activation must have installed the pinned engine.
    const pin: string = extension.packageJSON.pypilotEngine.version;
    check(helper.source === "managed", `expected the downloaded engine, got ${helper.source}`);
    check(helper.version === pin, `expected the pinned v${pin}, got v${helper.version}`);
    log(`[e2e] activation downloaded and verified the pinned engine v${pin}`);
  }

  // ── one language client for the single-folder workspace ─────────────────
  const clients = await waitFor("a running language client", () => {
    const all = api.clients();
    return all.length > 0 && all.every((c) => c.running) ? all : undefined;
  });
  check(clients.length === 1, `expected 1 language client, got ${clients.length}`);
  log(`[e2e] one language client running, for folder "${clients[0].folder}"`);

  // ── every command is registered, and only once ──────────────────────────
  // Server-advertised commands (pypilot.fixEverything, ...) are routed by
  // the client manager; a second registration would throw or duplicate.
  const contributed: string[] = (extension.packageJSON.contributes?.commands ?? []).map(
    (c: { command: string }) => c.command,
  );
  const ids = await vscode.commands.getCommands(true);
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  const missing = contributed.filter((id) => !counts.has(id));
  check(missing.length === 0, `contributed but not registered: ${missing.join(", ")}`);
  const ours = [...counts.keys()].filter((id) => id.startsWith("pypilot."));
  const twice = ours.filter((id) => (counts.get(id) ?? 0) > 1);
  check(twice.length === 0, `registered more than once: ${twice.join(", ")}`);
  check(counts.has("pypilot.fixEverything"), "the server's pypilot.fixEverything command is not registered");
  log(`[e2e] all ${contributed.length} contributed commands registered; ${ours.length} pypilot.* ids, none twice`);

  // ── downloads: only verified archives are installed ─────────────────────
  const scratch = process.env.PYPILOT_E2E_SCRATCH;
  const base = process.env.PYPILOT_TEST_RELEASES_URL;
  check(scratch && base, "the runner did not pass PYPILOT_E2E_SCRATCH / PYPILOT_TEST_RELEASES_URL");
  const pinned: string = extension.packageJSON.pypilotEngine.version;
  const leftovers = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

  const okDir = join(scratch, "install-ok");
  const installed = await api.installEngineVersion("9.9.1", okDir);
  check(installed === join(okDir, BIN_NAME), `installed to ${installed}`);
  check(
    readFileSync(installed, "utf8") === process.env.PYPILOT_E2E_FAKE_BINARY,
    "the installed binary is not the one from the archive",
  );
  check(
    leftovers(okDir).every((n) => n === BIN_NAME),
    `install left files behind: ${leftovers(okDir).join(", ")}`,
  );
  log("[e2e] v9.9.1 matching its SHA256SUMS was installed");

  const badSumsDir = join(scratch, "install-bad-sums");
  const msg = await rejects("SHA256SUMS mismatch", () => api.installEngineVersion("9.9.2", badSumsDir), /SHA-256 mismatch/);
  check(leftovers(badSumsDir).length === 0, `mismatch left files: ${leftovers(badSumsDir).join(", ")}`);
  log(`[e2e] v9.9.2 with a wrong SHA256SUMS entry was refused, nothing installed: ${msg.split(". ")[0]}`);

  const noSumsDir = join(scratch, "install-no-sums");
  await rejects("no SHA256SUMS", () => api.installEngineVersion("9.9.3", noSumsDir), /no SHA256SUMS/);
  check(!existsSync(join(noSumsDir, BIN_NAME)), "a release without SHA256SUMS was installed");
  log("[e2e] v9.9.3 without SHA256SUMS was refused");

  // The pinned version is checked against package.json, not the server:
  // a tampered archive under the pinned tag must be refused too.
  const tamperedDir = join(scratch, "install-tampered-pin");
  mkdirSync(tamperedDir, { recursive: true });
  process.env.PYPILOT_TEST_RELEASES_URL = `${base}/tampered`;
  try {
    await rejects("tampered pinned archive", () => api.installEngineVersion(pinned, tamperedDir), /SHA-256 mismatch/);
  } finally {
    process.env.PYPILOT_TEST_RELEASES_URL = base;
  }
  check(leftovers(tamperedDir).length === 0, `tampered pin left files: ${leftovers(tamperedDir).join(", ")}`);
  log(`[e2e] a tampered archive for the pinned v${pinned} was refused against the package.json hash`);

  // ── report panel ────────────────────────────────────────────────────────
  // "PyPilot: Open Environment Report Panel" scans with the real engine and
  // renders the server's report in the webview.
  await vscode.commands.executeCommand("pypilot.openReport");
  const tab = await waitFor("the report panel", () =>
    vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith("pypilotReport")),
  );
  log(`[e2e] report panel open: "${tab.label}"`);
  log("[e2e] PASS");
}
