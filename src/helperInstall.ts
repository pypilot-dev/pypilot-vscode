/**
 * helperInstall.ts — put a downloaded helper archive in place safely.
 *
 * The managed helper is usually the binary the language server is running.
 * Windows refuses to overwrite or delete a running .exe, and `Expand-Archive
 * -Force` over it fails while PowerShell still exits 0, so an "update" used
 * to leave the old binary in place and report success. Instead:
 *
 *   1. extract into a fresh staging folder next to the target,
 *   2. rename the current binary out of the way (Windows allows renaming a
 *      running .exe, only not deleting it),
 *   3. move the staged binary into place.
 *
 * The renamed copy stays until the process using it exits; `removeRetired`
 * deletes it on a later activation. No `vscode` import, so it can be tested
 * on its own.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Unpack a release archive (`.zip` or `.tar.gz`) into `dest`. Throws on any
 *  extraction error. */
export function extractArchive(archive: string, dest: string, fileName: string): void {
  if (fileName.endsWith('.zip')) {
    if (process.platform === 'win32') {
      extractZipWindows(archive, dest);
    } else {
      execFileSync('unzip', ['-o', archive, '-d', dest], { timeout: 60_000 });
    }
  } else {
    // .tar.gz — available on Linux/macOS; also on Windows via Git Bash / WSL
    execFileSync('tar', ['-xzf', archive, '-C', dest], { timeout: 60_000 });
  }
}

/**
 * Windows 10+ ships bsdtar as System32\tar.exe, which reads zip files and
 * exits non-zero on failure. Fall back to Expand-Archive for older systems.
 */
function extractZipWindows(archive: string, dest: string): void {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const tar = path.join(systemRoot, 'System32', 'tar.exe');
  if (fs.existsSync(tar)) {
    execFileSync(tar, ['-xf', archive, '-C', dest], { timeout: 60_000, windowsHide: true });
    return;
  }
  // When VS Code was started from PowerShell 7, its PSModulePath leaks into
  // Windows PowerShell 5.1 and Expand-Archive's module fails to load, so let
  // powershell.exe rebuild its default. -LiteralPath + quoting keeps odd
  // storage paths from breaking the command, and `$ErrorActionPreference =
  // 'Stop'` turns Expand-Archive's non-terminating errors into a non-zero exit.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'psmodulepath') delete env[key];
  }
  const q = (s: string) => s.replace(/'/g, "''");
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath '${q(archive)}' -DestinationPath '${q(dest)}' -Force`,
    ],
    { timeout: 60_000, windowsHide: true, env }
  );
}

/** First file named `binName` under `dir` (archives may nest it). */
function findBinary(dir: string, binName: string): string | undefined {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === binName) return full;
    if (entry.isDirectory()) {
      const nested = findBinary(full, binName);
      if (nested) return nested;
    }
  }
  return undefined;
}

/**
 * Install the helper from `archive` as `<binDir>/<binName>`, replacing any
 * existing copy even while it is running. Returns the installed path.
 */
export function installHelper(
  archive: string,
  fileName: string,
  binDir: string,
  binName: string
): string {
  fs.mkdirSync(binDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(binDir, '.staging-'));
  try {
    extractArchive(archive, staging, fileName);
    const staged = findBinary(staging, binName);
    if (!staged) {
      throw new Error(`${binName} not found in the downloaded archive ${fileName}`);
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(staged, 0o755);
    }

    const target = path.join(binDir, binName);
    let retired: string | undefined;
    if (fs.existsSync(target)) {
      retired = path.join(binDir, `${binName}.old-${Date.now()}`);
      fs.renameSync(target, retired);
    }
    try {
      fs.renameSync(staged, target);
    } catch (err) {
      // Put the previous binary back so the extension still has a helper.
      if (retired) fs.renameSync(retired, target);
      throw err;
    }
    // The old copy is deletable right away unless a process still runs it.
    if (retired) removeRetired(binDir, binName);
    return target;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Delete helpers retired by `installHelper` once nothing runs them.
 *  Best effort: a copy still in use is left for a later activation. */
export function removeRetired(binDir: string, binName: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(binDir);
  } catch {
    return;
  }
  for (const name of entries) {
    const stale = name.startsWith(`${binName}.old-`) || name.startsWith('.staging-');
    if (!stale) continue;
    try {
      fs.rmSync(path.join(binDir, name), { recursive: true, force: true });
    } catch {
      // Still in use (the language server keeps running it until reload).
    }
  }
}
