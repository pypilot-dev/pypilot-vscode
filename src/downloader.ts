/**
 * downloader.ts — locate or download the platform-matching `pypilot` helper
 * binary (the engine).
 *
 * Resolution order:
 *  0. `pypilot.helperPath`, when set: that binary and nothing else (no
 *     download, no update offers). For developers running a local build.
 *  1. `pypilot` on $PATH and the managed copy in the extension's global
 *     storage; the newer of the two wins.
 *  2. Otherwise download the engine version pinned in package.json
 *     (`pypilotEngine`), never "whatever is latest".
 *
 * Every download is checked before anything is extracted: the pinned version
 * against the SHA-256 in package.json, any other version against the
 * release's SHA256SUMS asset. A mismatch, or a release without SHA256SUMS,
 * installs nothing.
 *
 * Update checking (`pypilot.engineUpdates`):
 *  - "pinned" (default): offer the pinned version when it is newer than the
 *    helper in use. Updating the extension is what moves the pin.
 *  - "latest": also offer newer engine releases from GitHub, verified
 *    against their SHA256SUMS.
 *  Managed binaries are replaced in place; a PATH install is left alone and
 *  the managed copy, being newer, wins on the next activation.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  EnginePin,
  EngineUpdatePolicy,
  SHA256SUMS_ASSET,
  Version,
  assetForPlatform,
  compareVersions,
  fmtVersion,
  parseSha256Sums,
  parseVersion,
  pinnedSha256,
  readEnginePin,
  selectUpdateTarget,
  verifySha256,
} from './engine';
import { installHelper, removeRetired } from './helperInstall';
import { HttpStatusError, downloadFile, fetchJson, fetchText, setEnvProxy } from './net';

const HELPER_REPO = 'pypilot-dev/pypilot';
const MIN_VERSION: Version = [0, 1, 0];

/** Test-only: base URL of a local server laid out like GitHub releases
 *  (`/releases/download/<tag>/<asset>`, `/api/releases/latest`). Honoured
 *  only when the extension runs in test mode, so it can never redirect a
 *  user's download. */
export const TEST_RELEASES_ENV = 'PYPILOT_TEST_RELEASES_URL';

/** How often (in ms) to suppress the "update available" prompt after the user
 *  dismisses it.  24 hours keeps it from being annoying.  */
const UPDATE_SNOOZE_MS = 24 * 60 * 60 * 1000;

export interface HelperInfo {
  path: string;
  version: string;
  /** True for the copy in the extension's storage (which updates replace). */
  managed: boolean;
  /** Where it came from: `pypilot.helperPath`, PATH or managed storage. */
  source: 'setting' | 'path' | 'managed';
}

type Log = (line: string) => void;

/**
 * Ensure a working `pypilot` binary exists and return it.
 * Shows a VS Code progress notification while downloading if needed.
 */
export async function ensureHelper(
  context: vscode.ExtensionContext,
  log: Log = (line) => console.log(`PyPilot: ${line}`)
): Promise<HelperInfo> {
  configureProxy();

  // 0. An explicit helper (developers): use it or fail, never download.
  const configured = configuredHelperPath();
  if (configured) {
    const ver = probeVersion(configured);
    if (!ver) {
      throw new Error(
        `pypilot.helperPath is set to "${configured}", but running it with --version failed. ` +
          'Fix the path (it must be the pypilot executable itself) or clear the setting to use the downloaded engine.'
      );
    }
    log(
      `using the helper from pypilot.helperPath: ${configured} (v${fmtVersion(ver)}); ` +
        'engine downloads and update checks are skipped.'
    );
    return { path: configured, version: fmtVersion(ver), managed: false, source: 'setting' };
  }

  // A helper replaced by an update stays on disk while the old language server
  // runs it; delete such leftovers now that nothing should be using them.
  const binDir = managedBinDir(context);
  removeRetired(binDir, helperBinName());

  // 1. Probe both PATH and managed locations, then pick the newer one.
  let pathInfo: HelperInfo | undefined;
  let managedInfo: HelperInfo | undefined;

  const onPath = which('pypilot');
  if (onPath) {
    const ver = probeVersion(onPath);
    if (ver && compareVersions(ver, MIN_VERSION) >= 0) {
      pathInfo = { path: onPath, version: fmtVersion(ver), managed: false, source: 'path' };
    }
  }

  const managed = path.join(binDir, helperBinName());
  if (fs.existsSync(managed)) {
    const ver = probeVersion(managed);
    if (ver && compareVersions(ver, MIN_VERSION) >= 0) {
      managedInfo = { path: managed, version: fmtVersion(ver), managed: true, source: 'managed' };
    } else {
      // Stale binary — remove it so a re-download can happen. `force` only
      // ignores ENOENT: a locked file (Windows EBUSY/EPERM) must not abort
      // activation, so log it and let the download below replace it.
      try {
        fs.rmSync(managed, { force: true });
      } catch (err) {
        log(`could not remove the stale helper at ${managed}: ${err}`);
      }
    }
  }

  if (pathInfo && managedInfo) {
    const pathVer = parseVersion(pathInfo.version)!;
    const managedVer = parseVersion(managedInfo.version)!;
    return compareVersions(managedVer, pathVer) >= 0 ? managedInfo : pathInfo;
  }
  if (pathInfo) return pathInfo;
  if (managedInfo) return managedInfo;

  // 2. Neither exists — download the pinned engine.
  const pin = enginePin(context);
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'PyPilot', cancellable: false },
    async (progress) => {
      progress.report({ message: `Downloading the PyPilot engine v${pin.version}…` });
      const binPath = await installEngineVersion(context, pin.version, binDir, log);
      const ver = probeVersion(binPath);
      return {
        path: binPath,
        version: ver ? fmtVersion(ver) : pin.version,
        managed: true,
        source: 'managed' as const,
      };
    }
  );
}

// ---------------------------------------------------------------------------
// Update checker
// ---------------------------------------------------------------------------

/**
 * Offer the engine version `pypilot.engineUpdates` allows when it is newer
 * than `current`. Call this *after* activation so it never blocks startup.
 * `manual` (the "Check for Helper Updates" command) ignores the snooze and
 * also says when there is nothing to do.
 */
export async function checkForHelperUpdate(
  context: vscode.ExtensionContext,
  current: HelperInfo,
  options: { manual?: boolean } = {}
): Promise<void> {
  const say = (msg: string) => {
    if (options.manual) vscode.window.showInformationMessage(msg);
  };

  if (current.source === 'setting') {
    say(`PyPilot: using the helper from pypilot.helperPath (v${current.version}); updates are not checked.`);
    return;
  }

  // Honour a snooze — don't nag every single activation.
  const lastDismissed = context.globalState.get<number>('pypilot.updateDismissedAt', 0);
  if (!options.manual && Date.now() - lastDismissed < UPDATE_SNOOZE_MS) {
    return;
  }

  const localVer = parseVersion(current.version);
  if (!localVer) return;

  const pin = enginePin(context);
  const pinnedVer = parseVersion(pin.version)!;
  const policy = updatePolicy();

  let latestVer: Version | undefined;
  if (policy === 'latest') {
    try {
      const release = await fetchJson<GithubRelease>(`${endpoints(context).api}/latest`);
      latestVer = parseVersion(release.tag_name ?? '');
    } catch (err) {
      // Offline or rate limited: the pin can still be offered.
      console.warn(`PyPilot: could not look up the latest engine release: ${err}`);
    }
  }

  const target = selectUpdateTarget(policy, localVer, pinnedVer, latestVer);
  if (!target) {
    say(`PyPilot: the helper (v${current.version}) is up to date.`);
    return;
  }
  const targetStr = fmtVersion(target);

  const choice = await vscode.window.showInformationMessage(
    `PyPilot: helper update available (${current.version} → ${targetStr}).`,
    'Update now',
    'Release notes',
    'Later'
  );

  if (choice === 'Update now') {
    let done: string;
    try {
      done = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'PyPilot', cancellable: false },
        async (progress) => {
          progress.report({ message: `Updating helper to v${targetStr}…` });

          // Always into managed storage: a PATH install is the user's to
          // manage, and on the next activation the newer copy wins.
          const binPath = await installEngineVersion(context, targetStr, managedBinDir(context));

          // Only report success once the binary on disk really is the new
          // version. A replace that silently failed used to say "updated",
          // and the same prompt came back after every reload.
          const ver = probeVersion(binPath);
          if (!ver || compareVersions(ver, target) < 0) {
            throw new Error(
              `the helper at ${binPath} still reports ${ver ? fmtVersion(ver) : 'no version'} after installing v${targetStr}`
            );
          }
          return current.managed
            ? `PyPilot: helper updated to v${fmtVersion(ver)}.`
            : `PyPilot: helper v${fmtVersion(ver)} installed in the extension's storage; your PATH copy (${current.path}) was left as is.`;
        }
      );
    } catch (err) {
      vscode.window.showErrorMessage(`PyPilot: helper update failed: ${errorText(err)}`);
      return;
    }

    // One notification: what happened, and the reload that restarts the
    // language server on the new binary.
    const reload = await vscode.window.showInformationMessage(
      `${done} Reload the window to start using it.`,
      'Reload'
    );
    if (reload === 'Reload') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } else if (choice === 'Release notes') {
    vscode.env.openExternal(
      vscode.Uri.parse(`https://github.com/${HELPER_REPO}/releases/tag/v${targetStr}`)
    );
  } else {
    // "Later" or dismissed — snooze for 24h.
    await context.globalState.update('pypilot.updateDismissedAt', Date.now());
  }
}

// ---------------------------------------------------------------------------
// Download + verify + install
// ---------------------------------------------------------------------------

/**
 * Download engine `version` for this platform, verify its SHA-256 and
 * install it as `<binDir>/pypilot[.exe]`. Nothing is extracted unless the
 * archive matches: the pin for the pinned version, otherwise the release's
 * SHA256SUMS. Returns the installed path.
 */
export async function installEngineVersion(
  context: vscode.ExtensionContext,
  version: string,
  binDir: string,
  log: Log = (line) => console.log(`PyPilot: ${line}`)
): Promise<string> {
  const asset = assetForPlatform(process.platform, process.arch);
  if (!asset) {
    throw new Error(
      `PyPilot has no engine build for ${process.platform}/${process.arch}. ` +
        'Build it from source (cargo install --path helper) and set pypilot.helperPath.'
    );
  }
  const { download } = endpoints(context);
  const tagUrl = `${download}/v${version}`;

  let expected = pinnedSha256(enginePin(context), version, asset);
  let source = 'the pin in package.json';
  if (!expected) {
    expected = await sha256FromSums(`${tagUrl}/${SHA256SUMS_ASSET}`, version, asset);
    source = `${SHA256SUMS_ASSET} of v${version}`;
  }

  fs.mkdirSync(binDir, { recursive: true });
  const archive = path.join(binDir, `.download-${asset}`);
  try {
    await downloadFile(`${tagUrl}/${asset}`, archive);
    // Deletes the archive and throws on mismatch: nothing below runs.
    await verifySha256(archive, asset, expected);
    log(`verified ${asset} v${version} against ${source} (sha256 ${expected})`);
    // Never unpacks over the current binary: that is usually the one the
    // language server is running, which Windows will not let us replace.
    return installHelper(archive, asset, binDir, helperBinName());
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

/** The expected SHA-256 of `asset` from a release's SHA256SUMS. Releases
 *  without one (engine v1.2.2 and older) are refused: there is nothing to
 *  verify them against, and pinned versions never get here. */
async function sha256FromSums(url: string, version: string, asset: string): Promise<string> {
  let text: string;
  try {
    text = await fetchText(url);
  } catch (err) {
    if (err instanceof HttpStatusError && err.status === 404) {
      throw new Error(
        `engine v${version} has no ${SHA256SUMS_ASSET} file, so its download cannot be verified and was not installed. ` +
          'Set pypilot.engineUpdates to "pinned" to use the version this extension ships with, ' +
          'or install pypilot yourself and point pypilot.helperPath at it.'
      );
    }
    throw err;
  }
  const hex = parseSha256Sums(text).get(asset);
  if (!hex) {
    throw new Error(`${SHA256SUMS_ASSET} of engine v${version} lists no checksum for ${asset}; nothing was installed.`);
  }
  return hex;
}

// --- internals ---------------------------------------------------------------

function endpoints(context: vscode.ExtensionContext): { download: string; api: string } {
  const testBase = process.env[TEST_RELEASES_ENV];
  if (testBase && context.extensionMode === vscode.ExtensionMode.Test) {
    const base = testBase.replace(/\/+$/, '');
    return { download: `${base}/releases/download`, api: `${base}/api/releases` };
  }
  return {
    download: `https://github.com/${HELPER_REPO}/releases/download`,
    api: `https://api.github.com/repos/${HELPER_REPO}/releases`,
  };
}

function enginePin(context: vscode.ExtensionContext): EnginePin {
  return readEnginePin(context.extension.packageJSON);
}

function updatePolicy(): EngineUpdatePolicy {
  const value = vscode.workspace.getConfiguration('pypilot').get<string>('engineUpdates', 'pinned');
  return value === 'latest' ? 'latest' : 'pinned';
}

/** `pypilot.helperPath`, with `~` expanded; undefined when unset. */
function configuredHelperPath(): string | undefined {
  const raw = vscode.workspace.getConfiguration('pypilot').get<string>('helperPath', '').trim();
  if (!raw) return undefined;
  const expanded = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
    ? path.join(os.homedir(), raw.slice(1))
    : raw;
  return path.resolve(expanded);
}

/** With `http.proxySupport` "off", VS Code no longer proxies extension
 *  requests, so fall back to the environment (see net.ts). */
function configureProxy(): void {
  const support = vscode.workspace.getConfiguration('http').get<string>('proxySupport', 'override');
  setEnvProxy(support === 'off');
}

function helperBinName(): string {
  return process.platform === 'win32' ? 'pypilot.exe' : 'pypilot';
}

function managedBinDir(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'bin');
}

/** Probe `<path> --version` and return the parsed version, or undefined. */
function probeVersion(binPath: string): Version | undefined {
  try {
    const out = execFileSync(binPath, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return parseVersion(out.trim());
  } catch {
    return undefined;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Cross-platform `which`. */
function which(name: string): string | undefined {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [name], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const found = out.trim().split(/\r?\n/)[0];
    if (found) return found;
  } catch {
    // Continue to standard fallback
  }

  // Fallback: check ~/.cargo/bin in case PATH was not inherited by VS Code GUI
  const binName = process.platform === 'win32' ? `${name}.exe` : name;
  const cargoBin = path.join(os.homedir(), '.cargo', 'bin', binName);
  if (fs.existsSync(cargoBin)) {
    return cargoBin;
  }

  return undefined;
}

// --- GitHub API types --------------------------------------------------------

interface GithubRelease {
  /** Absent on rate-limited or malformed responses. */
  tag_name?: string;
}
