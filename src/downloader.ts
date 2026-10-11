/**
 * downloader.ts — locate or download the platform-matching `pypilot` helper
 * binary, mirroring the logic in the Zed WASM shim.
 *
 * Resolution order:
 *  1. `pypilot` on $PATH (if the version is new enough)
 *  2. A previously-downloaded binary in the extension's global storage
 *  3. Download the latest release asset from GitHub
 *
 * Update checking:
 *  On every activation the extension compares the local helper version against
 *  the latest GitHub release tag.  If a newer version is available the user is
 *  prompted to update.  Managed binaries are replaced in-place; PATH binaries
 *  offer to download the managed copy so the user's system install is untouched.
 */

import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const HELPER_REPO = 'pypilot-dev/pypilot';
const MIN_VERSION: [number, number, number] = [0, 1, 0];

/** How often (in ms) to suppress the "update available" prompt after the user
 *  dismisses it.  24 hours keeps it from being annoying.  */
const UPDATE_SNOOZE_MS = 24 * 60 * 60 * 1000;

export interface HelperInfo {
  path: string;
  version: string;
  managed: boolean;
}

/**
 * Ensure a working `pypilot` binary exists and return its path.
 * Shows a VS Code progress notification while downloading if needed.
 */
export async function ensureHelper(
  context: vscode.ExtensionContext
): Promise<HelperInfo> {
  // Probe both PATH and managed locations, then pick the best one.
  let pathInfo: HelperInfo | undefined;
  let managedInfo: HelperInfo | undefined;

  // 1. Check PATH.
  const onPath = which('pypilot');
  if (onPath) {
    const ver = await probeVersion(onPath);
    if (ver && compareVersions(ver, MIN_VERSION) >= 0) {
      pathInfo = { path: onPath, version: fmtVersion(ver), managed: false };
    }
  }

  // 2. Check previously-downloaded managed binary.
  const managed = managedBinPath(context);
  if (managed && fs.existsSync(managed)) {
    const ver = await probeVersion(managed);
    if (ver && compareVersions(ver, MIN_VERSION) >= 0) {
      managedInfo = { path: managed, version: fmtVersion(ver), managed: true };
    } else {
      // Stale binary — remove it so a re-download can happen.
      fs.rmSync(managed, { force: true });
    }
  }

  // 3. Pick the newer of the two, if both exist.
  if (pathInfo && managedInfo) {
    const pathVer = parseVersion(`pypilot ${pathInfo.version}`)!;
    const managedVer = parseVersion(`pypilot ${managedInfo.version}`)!;
    return compareVersions(managedVer, pathVer) >= 0 ? managedInfo : pathInfo;
  }
  if (pathInfo) return pathInfo;
  if (managedInfo) return managedInfo;

  // 4. Neither exists — download.
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'PyPilot',
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: 'Downloading helper binary…' });
      const binPath = await downloadLatestHelper(context);
      const ver = await probeVersion(binPath);
      return {
        path: binPath,
        version: ver ? fmtVersion(ver) : 'unknown',
        managed: true,
      };
    }
  );
}

// ---------------------------------------------------------------------------
// Update checker
// ---------------------------------------------------------------------------

/**
 * Compare the currently-resolved helper against the latest GitHub release.
 * If an update is available, prompt the user.  Call this *after* the extension
 * has finished activating so it never blocks startup.
 */
export async function checkForHelperUpdate(
  context: vscode.ExtensionContext,
  current: HelperInfo
): Promise<void> {
  // Honour a snooze — don't nag every single activation.
  const lastDismissed = context.globalState.get<number>('pypilot.updateDismissedAt', 0);
  if (Date.now() - lastDismissed < UPDATE_SNOOZE_MS) {
    return;
  }

  let release: GithubRelease;
  try {
    release = await fetchJson<GithubRelease>(
      `https://api.github.com/repos/${HELPER_REPO}/releases/latest`
    );
  } catch {
    // Network offline — silently skip.
    return;
  }

  const remoteVer = parseVersion(release.tag_name.replace(/^v/, 'pypilot '));
  if (!remoteVer) return;

  const localVer = parseVersion(`pypilot ${current.version}`);
  if (!localVer) return;

  if (compareVersions(remoteVer, localVer) <= 0) {
    // Already up to date.
    return;
  }

  const remoteStr = fmtVersion(remoteVer);

  const choice = await vscode.window.showInformationMessage(
    `PyPilot: helper update available (${current.version} → ${remoteStr}).`,
    'Update now',
    'Release notes',
    'Later'
  );

  if (choice === 'Update now') {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'PyPilot',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: `Updating helper to v${remoteStr}…` });

        if (current.managed) {
          // Replace the managed binary in-place.
          const binPath = await downloadLatestHelper(context);
          const ver = await probeVersion(binPath);
          vscode.window.showInformationMessage(
            `PyPilot: helper updated to v${ver ? fmtVersion(ver) : remoteStr}. Reload the window to use the new version.`
          );
        } else {
          // PATH binary — download a managed copy instead of touching the
          // user's system install.  On next activation the managed copy
          // (which is newer) should win the version comparison, but since
          // PATH is checked first and it's still old, we need to update the
          // managed copy and tell the user to reload.
          const binPath = await downloadLatestHelper(context);
          const ver = await probeVersion(binPath);
          vscode.window.showInformationMessage(
            `PyPilot: downloaded v${ver ? fmtVersion(ver) : remoteStr} to managed storage. ` +
            `Your PATH binary (${current.path}) was not modified. Reload the window to pick up the update.`
          );
        }
      }
    );

    // Prompt to reload so the LSP restarts with the new binary.
    const reload = await vscode.window.showInformationMessage(
      'PyPilot: Reload window to use the updated helper?',
      'Reload'
    );
    if (reload === 'Reload') {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  } else if (choice === 'Release notes') {
    vscode.env.openExternal(
      vscode.Uri.parse(`https://github.com/${HELPER_REPO}/releases/latest`)
    );
  } else {
    // "Later" or dismissed — snooze for 24h.
    await context.globalState.update('pypilot.updateDismissedAt', Date.now());
  }
}

// --- internals ---------------------------------------------------------------

function managedBinPath(context: vscode.ExtensionContext): string | undefined {
  const dir = context.globalStorageUri.fsPath;
  const name = process.platform === 'win32' ? 'pypilot.exe' : 'pypilot';
  return path.join(dir, 'bin', name);
}

async function downloadLatestHelper(
  context: vscode.ExtensionContext
): Promise<string> {
  const asset = assetForPlatform();
  const releaseUrl = `https://api.github.com/repos/${HELPER_REPO}/releases/latest`;

  const release = await fetchJson<GithubRelease>(releaseUrl);
  const assetEntry = release.assets.find((a) => a.name === asset.fileName);
  if (!assetEntry) {
    throw new Error(
      `No PyPilot helper asset "${asset.fileName}" found in the latest release.`
    );
  }

  const dir = path.join(context.globalStorageUri.fsPath, 'bin');
  fs.mkdirSync(dir, { recursive: true });

  const archive = path.join(dir, asset.fileName);
  await downloadFile(assetEntry.browser_download_url, archive);

  const binName = process.platform === 'win32' ? 'pypilot.exe' : 'pypilot';
  const binPath = path.join(dir, binName);

  await extractArchive(archive, dir, asset.fileName);
  fs.rmSync(archive, { force: true });

  if (process.platform !== 'win32') {
    fs.chmodSync(binPath, 0o755);
  }

  return binPath;
}

function assetForPlatform(): { fileName: string } {
  const { platform, arch } = process;
  let slug: string;

  if (platform === 'linux' && arch === 'x64') {
    slug = 'linux-x64';
  } else if (platform === 'linux' && arch === 'arm64') {
    slug = 'linux-arm64';
  } else if (platform === 'darwin' && arch === 'x64') {
    slug = 'darwin-x64';
  } else if (platform === 'darwin' && arch === 'arm64') {
    slug = 'darwin-arm64';
  } else if (platform === 'win32' && arch === 'x64') {
    slug = 'windows-x64';
  } else {
    throw new Error(`Unsupported platform for PyPilot helper: ${platform}/${arch}`);
  }

  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  return { fileName: `pypilot-${slug}.${ext}` };
}

/** Probe `<path> --version` and return parsed semver, or undefined. */
async function probeVersion(
  binPath: string
): Promise<[number, number, number] | undefined> {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(binPath, ['--version'], { encoding: 'utf8', timeout: 5000 });
    return parseVersion(out.trim());
  } catch {
    return undefined;
  }
}

function parseVersion(out: string): [number, number, number] | undefined {
  // "pypilot 0.1.0"
  const m = out.match(/pypilot\s+(\d+)\.(\d+)\.(\d+)/);
  if (!m) return undefined;
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
}

function fmtVersion([ma, mi, pa]: [number, number, number]): string {
  return `${ma}.${mi}.${pa}`;
}

function compareVersions(
  a: [number, number, number],
  b: [number, number, number]
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Cross-platform `which`. */
function which(name: string): string | undefined {
  try {
    const { execFileSync } = require('child_process');
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [name], { encoding: 'utf8', timeout: 3000 });
    const found = out.trim().split(/\r?\n/)[0];
    if (found) return found;
  } catch {
    // Continue to standard fallback
  }

  // Fallback: check ~/.cargo/bin in case PATH was not inherited by VS Code GUI
  const homedir = os.homedir();
  const binName = process.platform === 'win32' ? `${name}.exe` : name;
  const cargoBin = path.join(homedir, '.cargo', 'bin', binName);
  if (fs.existsSync(cargoBin)) {
    return cargoBin;
  }

  return undefined;
}

function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'pypilot-vscode',
        Accept: 'application/vnd.github+json',
      },
    };
    https.get(url, options, (res) => {
      // Follow redirects (GitHub API can redirect).
      if (res.statusCode === 301 || res.statusCode === 302) {
        fetchJson<T>(res.headers.location!).then(resolve, reject);
        return;
      }
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const follow = (u: string) =>
      https.get(u, { headers: { 'User-Agent': 'pypilot-vscode' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          follow(res.headers.location!);
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      }).on('error', reject);
    follow(url);
  });
}

async function extractArchive(archive: string, dest: string, fileName: string): Promise<void> {
  const { execFileSync } = require('child_process');
  if (fileName.endsWith('.zip')) {
    if (process.platform === 'win32') {
      // PowerShell Expand-Archive (always available on Windows 5+)
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `Expand-Archive -Path '${archive}' -DestinationPath '${dest}' -Force`],
        { timeout: 30000 }
      );
    } else {
      execFileSync('unzip', ['-o', archive, '-d', dest], { timeout: 30000 });
    }
  } else {
    // .tar.gz — available on Linux/macOS; also on Windows via Git Bash / WSL
    execFileSync('tar', ['-xzf', archive, '-C', dest], { timeout: 30000 });
  }
}

// --- GitHub API types --------------------------------------------------------

interface GithubRelease {
  tag_name: string;
  assets: GithubAsset[];
}

interface GithubAsset {
  name: string;
  browser_download_url: string;
}
