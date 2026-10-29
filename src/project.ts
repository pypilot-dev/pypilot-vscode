/**
 * project.ts — cheap facts about the workspace's Python projects, read from
 * the files on disk (no helper or engine calls), and the context keys built
 * from them.
 *
 * The keys hide palette commands that make no sense for the open project
 * (`menus.commandPalette` in package.json):
 *
 *   pypilot.hasTorch           a manifest mentions torch / tensorflow
 *   pypilot.hasCondaEnv        an environment.yml / environment.yaml exists
 *   pypilot.hasPixiProject     some folder is a pixi project
 *   pypilot.hasNonPixiProject  some folder is not a pixi project yet
 *   pypilot.pixiInstalled      a pixi binary is on PATH or in ~/.pixi/bin
 *
 * Each key is true when any workspace folder qualifies. They are recomputed
 * (debounced) when a manifest changes, a folder is added or removed, or the
 * `pypilot` settings change. The commands stay callable from walkthrough
 * links, keybindings and other extensions; only the palette entry is hidden.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { isPixiProject } from './venv';

const DEBOUNCE_MS = 500;

/** Manifests whose content or presence feeds a context key. */
export const MANIFEST_GLOB =
  '{pyproject.toml,pixi.toml,environment.yml,environment.yaml,requirements*.txt,requirements/*.txt}';

/**
 * A dependency named torch, torchvision, torchaudio, pytorch (conda) or
 * tensorflow (plus its -gpu / -cpu / -intel / -macos variants), not as part
 * of a longer name such as `torchmetrics` or `pytorch-lightning`.
 */
const ML_DEP =
  /(?<![\w.-])(?:torch(?:vision|audio)?|pytorch|tensorflow(?:[-_](?:gpu|cpu|intel|macos))?)(?![\w-])/i;

function read(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function list(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** `requirements*.txt` at the root and `requirements/*.txt`. */
function requirementFiles(root: string): string[] {
  const top = list(root)
    .filter((n) => /^requirements.*\.txt$/i.test(n))
    .map((n) => path.join(root, n));
  const nested = list(path.join(root, 'requirements'))
    .filter((n) => n.toLowerCase().endsWith('.txt'))
    .map((n) => path.join(root, 'requirements', n));
  return [...top, ...nested];
}

/** The conda `environment.yml` (or `.yaml`) of `folder`, if any. */
export function condaEnvFile(folder: vscode.WorkspaceFolder): string | undefined {
  const root = folder.uri.fsPath;
  return ['environment.yml', 'environment.yaml']
    .map((n) => path.join(root, n))
    .find((p) => fs.existsSync(p));
}

/** True if one of the folder's manifests names torch or tensorflow. */
export function dependsOnTorch(folder: vscode.WorkspaceFolder): boolean {
  const root = folder.uri.fsPath;
  const files = [
    path.join(root, 'pyproject.toml'),
    path.join(root, 'pixi.toml'),
    ...['environment.yml', 'environment.yaml'].map((n) => path.join(root, n)),
    ...requirementFiles(root),
  ];
  return files.some((f) => ML_DEP.test(read(f)));
}

/** First file named `name` (plus `.exe` on Windows) in `dirs`, if any. */
function findBinary(name: string, extraDirs: string[] = []): string | undefined {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...extraDirs].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, exe);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** pixi on PATH, or where its installer puts it (`~/.pixi/bin`). */
export function pixiInstalled(): boolean {
  return findBinary('pixi', [path.join(os.homedir(), '.pixi', 'bin')]) !== undefined;
}

/**
 * uv on PATH, or in the standard install locations the engine also checks
 * (`~/.local/bin`, `~/.cargo/bin`).
 */
export function uvInstalled(): boolean {
  const home = os.homedir();
  return findBinary('uv', [path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin')]) !== undefined;
}

export type ResolvedManager = 'uv' | 'uv-pip' | 'pip' | 'pixi';

/**
 * The package manager the engine will use for `folder`, mirroring its
 * `resolve_mode`: pixi projects always use pixi, otherwise the setting, and
 * `auto` means uv when uv is installed, else pip. `auto` is reported so the
 * caller can say the choice was automatic. A project config file
 * (`pypilot.toml`) can still override this inside the engine.
 */
export function resolvePackageManager(folder: vscode.WorkspaceFolder): { manager: ResolvedManager; auto: boolean } {
  const setting = vscode.workspace
    .getConfiguration('pypilot', folder.uri)
    .get<string>('packageManager', 'auto');
  if (isPixiProject(folder)) return { manager: 'pixi', auto: setting !== 'pixi' };
  switch (setting) {
    case 'uv':
    case 'uv-pip':
    case 'pip':
    case 'pixi':
      return { manager: setting, auto: false };
    default:
      return { manager: uvInstalled() ? 'uv' : 'pip', auto: true };
  }
}

/** Compute every context key from scratch; each is a handful of stat/read calls. */
function updateContextKeys(): void {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const pixi = folders.map((f) => isPixiProject(f));
  const keys: Record<string, boolean> = {
    'pypilot.hasTorch': folders.some((f) => dependsOnTorch(f)),
    'pypilot.hasCondaEnv': folders.some((f) => condaEnvFile(f) !== undefined),
    'pypilot.hasPixiProject': pixi.some((p) => p),
    'pypilot.hasNonPixiProject': pixi.some((p) => !p),
    'pypilot.pixiInstalled': pixiInstalled(),
  };
  for (const [key, value] of Object.entries(keys)) {
    void vscode.commands.executeCommand('setContext', key, value);
  }
}

/** Set the context keys now and keep them current. */
export function registerContextKeys(context: vscode.ExtensionContext): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      updateContextKeys();
    }, DEBOUNCE_MS);
  };

  updateContextKeys();

  // `**/` so that every workspace folder root is covered; deeper matches
  // only cost a recompute.
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${MANIFEST_GLOB}`);
  watcher.onDidCreate(schedule);
  watcher.onDidChange(schedule);
  watcher.onDidDelete(schedule);

  context.subscriptions.push(
    watcher,
    vscode.workspace.onDidChangeWorkspaceFolders(schedule),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pypilot')) schedule();
    }),
    // pixi may have been installed in a terminal meanwhile; re-checking PATH
    // when the window regains focus is cheap.
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) schedule();
    }),
    { dispose: () => timer && clearTimeout(timer) }
  );
}
