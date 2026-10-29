/**
 * End-to-end check in a real VS Code 1.85 (the oldest the extension
 * supports), kept out of `bun test` because it downloads VS Code and needs
 * a display (`xvfb-run -a bun run e2e` on Linux CI). Uses a throwaway
 * profile and extensions directory, so the developer's own VS Code is
 * untouched.
 *
 *   bun run e2e
 *
 * It also serves a fake GitHub release layout on 127.0.0.1, which the
 * extension uses instead of github.com because PYPILOT_TEST_RELEASES_URL is
 * set and VS Code runs it in test mode:
 *
 *   /releases/download/v9.9.1/  fake archive + correct SHA256SUMS
 *   /releases/download/v9.9.2/  fake archive + SHA256SUMS with a wrong hash
 *   /releases/download/v9.9.3/  fake archive, no SHA256SUMS
 *   /tampered/releases/download/v<pin>/  fake archive under the pinned version
 *   /releases/download/v<pin>/  redirected to the real GitHub release, so a
 *                               machine without pypilot really installs the pin
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { runTests } from "@vscode/test-electron";

import { assetForPlatform, readEnginePin } from "../src/engine";

const root = resolve(import.meta.dir, "..");
const pin = readEnginePin(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
const asset = assetForPlatform(process.platform, process.arch);
if (!asset) throw new Error(`no engine asset for ${process.platform}/${process.arch}`);

const built = await Bun.build({
  entrypoints: [join(import.meta.dir, "suite.ts")],
  outdir: join(root, "out-e2e"),
  target: "node",
  format: "cjs",
  external: ["vscode"],
});
if (!built.success) throw new AggregateError(built.logs, "building the e2e suite failed");

const scratch = mkdtempSync(join(tmpdir(), "pypilot-e2e-"));

// A Python project the extension must activate on.
const project = join(scratch, "project");
mkdirSync(project);
writeFileSync(join(project, "main.py"), "import requests\n\nprint(requests.__version__)\n");
writeFileSync(join(project, "requirements.txt"), "requests==2.32.3\n");

// The fake engine archive: a "pypilot" that is not the real one.
const binName = process.platform === "win32" ? "pypilot.exe" : "pypilot";
const fakeDir = join(scratch, "fake");
mkdirSync(fakeDir);
const fakeBinary = "#!/bin/sh\necho 'pypilot 9.9.1 (fake e2e engine)'\n";
writeFileSync(join(fakeDir, binName), fakeBinary, { mode: 0o755 });
const archive = join(scratch, asset);
if (process.platform === "win32") {
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  execFileSync(tar, ["-a", "-cf", archive, "-C", fakeDir, binName]);
} else {
  execFileSync("tar", ["-czf", archive, "-C", fakeDir, binName]);
}
const archiveBytes = readFileSync(archive);
const archiveSha = createHash("sha256").update(archiveBytes).digest("hex");

const requests: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    requests.push(path);
    const m = path.match(/^(\/tampered)?\/releases\/download\/v([\d.]+)\/(.+)$/);
    if (!m) return new Response("not found", { status: 404 });
    const [, tampered, version, file] = m;
    if (version === pin.version && !tampered) {
      return Response.redirect(`https://github.com/pypilot-dev/pypilot/releases/download/v${version}/${file}`, 302);
    }
    if (file === asset) return new Response(archiveBytes);
    if (file === "SHA256SUMS" && version === "9.9.1") return new Response(`${archiveSha}  ${asset}\n`);
    if (file === "SHA256SUMS" && version === "9.9.2") return new Response(`${"0".repeat(64)}  ${asset}\n`);
    return new Response("not found", { status: 404 });
  },
});

const profile = join(scratch, "profile");
const logFile = join(scratch, "e2e.log");

// PYPILOT_E2E_FRESH=1 hides any installed pypilot (PATH and ~/.cargo/bin)
// from the extension, so activation must download and verify the pinned
// engine from GitHub through the redirect above. CI sets it.
const fresh = process.env.PYPILOT_E2E_FRESH === "1";
const freshEnv: Record<string, string> = {};
if (fresh) {
  const home = join(scratch, "home");
  mkdirSync(home);
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  freshEnv[pathKey] = (process.env[pathKey] ?? "")
    .split(delimiter)
    .filter((dir) => dir && !existsSync(join(dir, binName)))
    .join(delimiter);
  freshEnv.HOME = home;
  freshEnv.USERPROFILE = home;
  freshEnv.PYPILOT_E2E_EXPECT_PIN = "1";
}

let failed = false;
try {
  await runTests({
    version: "1.85.0",
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, "out-e2e", "suite.js"),
    extensionTestsEnv: {
      PYPILOT_E2E_LOG: logFile,
      PYPILOT_E2E_SCRATCH: scratch,
      PYPILOT_E2E_FAKE_BINARY: fakeBinary,
      PYPILOT_TEST_RELEASES_URL: `http://127.0.0.1:${server.port}`,
      ...freshEnv,
    },
    launchArgs: [
      project,
      "--disable-extensions",
      "--disable-workspace-trust",
      `--user-data-dir=${join(profile, "user")}`,
      `--extensions-dir=${join(profile, "extensions")}`,
    ],
  });
} catch (err) {
  failed = true;
  console.error(err);
} finally {
  try {
    console.log(readFileSync(logFile, "utf8"));
  } catch {
    console.log("(the suite wrote no log)");
  }
  console.log(`[e2e] local release server saw: ${requests.join(", ") || "nothing"}`);
  server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
