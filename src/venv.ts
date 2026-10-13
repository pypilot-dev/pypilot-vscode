/**
 * venv.ts — point VS Code at the project's environment automatically.
 *
 * The project environment is `<folder>/.venv`, or, in a pixi project (a
 * `pixi.toml`, or a `pyproject.toml` with `[tool.pixi.workspace]` /
 * `[tool.pixi.project]`), pixi's default environment `<folder>/.pixi/envs/default`.
 * pixi projects never get a `.venv` from here.
 *
 * After PyPilot (or uv / pip / pixi) creates it, the Python interpreter
 * picker and the Jupyter kernel picker keep using whatever interpreter was
 * active before. Both read the active environment from the Python extensions'
 * APIs, so that is what we set. `python.defaultInterpreterPath` is not an
 * option: it is ignored once an interpreter has been chosen.
 *
 * Neither Python extension is a hard dependency. Their APIs are fetched with
 * `vscode.extensions.getExtension` and narrowed through the small local
 * interfaces below (shapes taken from `@vscode/python-environments` and
 * `@vscode/python-extension`). Every call is feature-detected and guarded:
 * failures are logged, never thrown and never shown as error popups.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const ENVS_EXTENSION_ID = 'ms-python.vscode-python-envs';
const PYTHON_EXTENSION_ID = 'ms-python.python';

// uv and pip touch pyvenv.cfg several times while the venv is being built, so
// wait for the writes to settle before asking the extensions to resolve it.
const DEBOUNCE_MS = 2000;

// `[tool.pixi.workspace]` (current) or `[tool.pixi.project]` (older pixi) at
// the start of a line. A plain text check is enough to spot pixi projects.
const PIXI_TABLE = /^[ \t]*\[[ \t]*tool\.pixi\.(?:workspace|project)[ \t]*\]/m;

// ── Local views of the Python Environments API (ms-python.vscode-python-envs) ─

interface EnvsEnvironment {
  readonly version?: string;
  readonly environmentPath?: vscode.Uri;
  readonly sysPrefix?: string;
  readonly execInfo?: { run?: { executable?: string } };
}

interface EnvsApi {
  refreshEnvironments?(scope: vscode.Uri | undefined): Promise<void>;
  resolveEnvironment?(context: vscode.Uri): Promise<EnvsEnvironment | undefined>;
  setEnvironment?(scope: vscode.Uri | vscode.Uri[] | undefined, env?: EnvsEnvironment): Promise<void>;
  getEnvironment?(scope: vscode.Uri | undefined): Promise<EnvsEnvironment | undefined>;
}

// ── Local views of the Python extension API (ms-python.python) ────────────────

interface PyResolvedEnvironment {
  readonly version?: { major?: number; minor?: number };
}

interface PyEnvironmentsApi {
  getActiveEnvironmentPath?(resource?: vscode.Uri): { path?: string } | undefined;
  updateActiveEnvironmentPath?(env: string, resource?: vscode.Uri): Promise<void>;
  refreshEnvironments?(options?: { forceRefresh?: boolean }): Promise<void>;
  resolveEnvironment?(env: string): Promise<PyResolvedEnvironment | undefined>;
}

interface PyApi {
  ready?: Promise<void>;
  environments?: PyEnvironmentsApi;
}

export type VenvReason = 'activation' | 'watcher' | 'command';
export type VenvResult = 'missing' | 'unchanged' | 'changed' | 'unavailable';

/** Per-folder chain so a watcher event and the activation check never race. */
const running = new Map<string, Promise<VenvResult>>();

function log(msg: string): void {
  console.log(`PyPilot [venv]: ${msg}`);
}

type EnvKind = 'venv' | 'pixi';

/** The environment PyPilot treats as "the project's" for a folder. */
interface ProjectEnv {
  readonly kind: EnvKind;
  /** Environment root: the venv folder or the conda-style pixi prefix. */
  readonly dir: string;
  /** Interpreter inside `dir`; may not exist yet. */
  readonly python: string;
}

/** True for a pixi project: `pixi.toml`, or pixi tables in `pyproject.toml`. */
function isPixiProject(folder: vscode.WorkspaceFolder): boolean {
  const root = folder.uri.fsPath;
  try {
    if (fs.existsSync(path.join(root, 'pixi.toml'))) return true;
    return PIXI_TABLE.test(fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8'));
  } catch {
    return false;
  }
}

function projectEnv(folder: vscode.WorkspaceFolder): ProjectEnv {
  const win = process.platform === 'win32';
  if (isPixiProject(folder)) {
    // Conda layout: on Windows python.exe sits in the prefix root.
    const dir = path.join(folder.uri.fsPath, '.pixi', 'envs', 'default');
    return { kind: 'pixi', dir, python: win ? path.join(dir, 'python.exe') : path.join(dir, 'bin', 'python') };
  }
  const dir = path.join(folder.uri.fsPath, '.venv');
  return {
    kind: 'venv',
    dir,
    python: win ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python'),
  };
}

function normalize(p: string): string {
  const resolved = path.resolve(p);
  // Windows paths are case-insensitive; the extensions report mixed casing.
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True if `child` is `parent` itself or somewhere beneath it. */
function isWithin(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

async function getEnvsApi(): Promise<EnvsApi | undefined> {
  try {
    const ext = vscode.extensions.getExtension<EnvsApi | undefined>(ENVS_EXTENSION_ID);
    if (!ext) return undefined;
    if (!ext.isActive) await ext.activate();
    // Exports are undefined when `python.useEnvironmentsExtension` is off.
    const api = ext.exports;
    if (api && typeof api.resolveEnvironment === 'function' && typeof api.setEnvironment === 'function') {
      return api;
    }
  } catch (err) {
    log(`Python Environments API unavailable: ${err}`);
  }
  return undefined;
}

async function getPyApi(): Promise<PyEnvironmentsApi | undefined> {
  try {
    const ext = vscode.extensions.getExtension<PyApi | undefined>(PYTHON_EXTENSION_ID);
    if (!ext) return undefined;
    if (!ext.isActive) await ext.activate();
    const api = ext.exports;
    if (api?.ready) await api.ready;
    const envs = api?.environments;
    if (envs && typeof envs.updateActiveEnvironmentPath === 'function') return envs;
  } catch (err) {
    log(`Python extension API unavailable: ${err}`);
  }
  return undefined;
}

/**
 * Paths describing the folder's currently active interpreter (any of them may
 * be the executable, the env folder or sys.prefix, depending on the API), or
 * an empty array when nothing usable is set.
 */
async function activeEnvPaths(
  folder: vscode.WorkspaceFolder,
  envs: EnvsApi | undefined,
  py: PyEnvironmentsApi | undefined
): Promise<string[]> {
  const out: string[] = [];
  try {
    if (envs?.getEnvironment) {
      const env = await envs.getEnvironment(folder.uri);
      if (env?.execInfo?.run?.executable) out.push(env.execInfo.run.executable);
      if (env?.environmentPath?.fsPath) out.push(env.environmentPath.fsPath);
      if (env?.sysPrefix) out.push(env.sysPrefix);
    } else if (py?.getActiveEnvironmentPath) {
      const p = py.getActiveEnvironmentPath(folder.uri)?.path;
      if (p) out.push(p);
    }
  } catch (err) {
    log(`could not read the active interpreter for ${folder.name}: ${err}`);
  }
  // A bare command like "python" means the extension fell back to PATH, which
  // is the same as nothing being selected.
  return out.filter((p) => path.isAbsolute(p));
}

/** Read "X.Y" from pyvenv.cfg (`version` for venv, `version_info` for uv). */
function cfgVersion(dir: string): string | undefined {
  try {
    const text = fs.readFileSync(path.join(dir, 'pyvenv.cfg'), 'utf8');
    const m = /^\s*version(?:_info)?\s*=\s*(\d+)\.(\d+)/m.exec(text);
    return m ? `${m[1]}.${m[2]}` : undefined;
  } catch {
    return undefined;
  }
}

/** Read "X.Y" from the `python-X.Y.Z-<build>.json` record in conda-meta. */
function condaMetaVersion(dir: string): string | undefined {
  try {
    for (const name of fs.readdirSync(path.join(dir, 'conda-meta'))) {
      // Digits right after "python-" skip python-dateutil, python_abi etc.
      const m = /^python-(\d+)\.(\d+)\.[^-]*-.*\.json$/.exec(name);
      if (m) return `${m[1]}.${m[2]}`;
    }
  } catch {
    // Not installed yet, or unreadable.
  }
  return undefined;
}

function majorMinor(version: string | undefined): string | undefined {
  const m = version ? /^(\d+)\.(\d+)/.exec(version) : null;
  return m ? `${m[1]}.${m[2]}` : undefined;
}

async function selectVenv(folder: vscode.WorkspaceFolder, reason: VenvReason): Promise<VenvResult> {
  const target = projectEnv(folder);
  const pythonPath = target.python;
  const name = target.kind === 'pixi' ? 'the pixi environment' : '.venv';
  if (!fs.existsSync(pythonPath)) return 'missing';

  const envs = await getEnvsApi();
  let py = envs ? undefined : await getPyApi();
  if (!envs && !py) {
    log(`no Python extension API available; leaving ${folder.name} alone`);
    return 'unavailable';
  }

  const dir = target.dir;
  const current = await activeEnvPaths(folder, envs, py);
  if (current.some((p) => isWithin(p, dir))) return 'unchanged';

  // On activation only fill a gap: if the user deliberately picked another
  // interpreter inside this folder, respect it.
  if (reason === 'activation' && current.some((p) => isWithin(p, folder.uri.fsPath))) {
    log(`${folder.name} already uses an interpreter inside the folder; not switching to ${name}`);
    return 'unchanged';
  }

  let version: string | undefined;
  try {
    if (envs) {
      // Prefer the Python Environments extension: when it is enabled, the
      // Python extension (and so the Jupyter kernel picker) defers to it.
      await envs.refreshEnvironments?.(folder.uri);
      const env = await envs.resolveEnvironment!(vscode.Uri.file(pythonPath));
      if (env) {
        await envs.setEnvironment!(folder.uri, env);
        version = majorMinor(env.version);
      } else if (target.kind === 'pixi') {
        // Python Environments has no pixi manager yet and may not know the
        // prefix; the Python extension's own discovery finds `.pixi` envs.
        log(`Python Environments could not resolve ${pythonPath}; trying the Python extension`);
        py = await getPyApi();
        if (!py) return 'unavailable';
      } else {
        log(`Python Environments could not resolve ${pythonPath}`);
        return 'unavailable';
      }
    }
    if (py) {
      // Without a refresh the new venv may not be known yet and the kernel
      // picker would not list it.
      await py.refreshEnvironments?.({ forceRefresh: true });
      await py.updateActiveEnvironmentPath!(pythonPath, folder.uri);
      const resolved = await py.resolveEnvironment?.(pythonPath);
      const v = resolved?.version;
      if (v?.major !== undefined && v?.minor !== undefined) version = `${v.major}.${v.minor}`;
    }
  } catch (err) {
    log(`could not select ${pythonPath} for ${folder.name}: ${err}`);
    return 'unavailable';
  }

  version = version ?? (target.kind === 'pixi' ? condaMetaVersion(dir) : cfgVersion(dir));
  log(`${folder.name}: selected ${pythonPath} (${reason})`);
  const suffix = version ? ` (Python ${version})` : '';
  vscode.window.showInformationMessage(
    target.kind === 'pixi'
      ? `PyPilot: this workspace now uses the pixi environment${suffix}. ` +
          "Notebooks: pick the pixi 'default' environment in the kernel picker if one is already open."
      : `PyPilot: this workspace now uses .venv${suffix}. ` +
          "Notebooks: pick '.venv' in the kernel picker if one is already open."
  );
  return 'changed';
}

/**
 * Make the folder's project environment (`.venv`, or pixi's default
 * environment in a pixi project) the active interpreter for `folder`, if it
 * exists and is not already active. Never throws.
 */
export function useProjectVenv(folder: vscode.WorkspaceFolder, reason: VenvReason): Promise<VenvResult> {
  const key = folder.uri.toString();
  const prev = running.get(key) ?? Promise.resolve<VenvResult>('unchanged');
  const next = prev
    .catch(() => 'unavailable' as VenvResult)
    .then(() => selectVenv(folder, reason))
    .catch((err) => {
      log(`unexpected error for ${folder.name}: ${err}`);
      return 'unavailable' as VenvResult;
    });
  running.set(key, next);
  return next;
}

function autoSelectEnabled(folder: vscode.WorkspaceFolder): boolean {
  return vscode.workspace.getConfiguration('pypilot', folder.uri).get<boolean>('autoSelectVenv', true);
}

/** Watch `<folder>/.venv/pyvenv.cfg` and select the venv once it settles. */
function watchFolder(folder: vscode.WorkspaceFolder): vscode.Disposable {
  // RelativePattern keeps the match inside this folder, so a `.venv` elsewhere
  // on disk never triggers anything.
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, '.venv/pyvenv.cfg'),
    false,
    false,
    true
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (autoSelectEnabled(folder)) void useProjectVenv(folder, 'watcher');
    }, DEBOUNCE_MS);
  };
  watcher.onDidCreate(schedule);
  watcher.onDidChange(schedule);
  return {
    dispose: () => {
      if (timer) clearTimeout(timer);
      watcher.dispose();
    },
  };
}

/**
 * Register the `.venv` watchers, the one-off activation check and the
 * `pypilot.useProjectVenv` command.
 */
export function registerVenvSelection(context: vscode.ExtensionContext): void {
  const watchers = new Map<string, vscode.Disposable>();
  const addFolder = (folder: vscode.WorkspaceFolder) => {
    const key = folder.uri.toString();
    if (!watchers.has(key)) watchers.set(key, watchFolder(folder));
  };

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    addFolder(folder);
    if (autoSelectEnabled(folder)) void useProjectVenv(folder, 'activation');
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const folder of e.removed) {
        const key = folder.uri.toString();
        watchers.get(key)?.dispose();
        watchers.delete(key);
      }
      for (const folder of e.added) {
        addFolder(folder);
        if (autoSelectEnabled(folder)) void useProjectVenv(folder, 'activation');
      }
    }),
    { dispose: () => watchers.forEach((w) => w.dispose()) },
    // Explicit request: ignores `pypilot.autoSelectVenv` and the
    // "user picked something else" guard.
    vscode.commands.registerCommand('pypilot.useProjectVenv', async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const results = await Promise.all(folders.map((f) => useProjectVenv(f, 'command')));
      if (results.includes('changed')) return; // selectVenv already said so.
      if (results.every((r) => r === 'missing')) {
        vscode.window.showInformationMessage(
          'PyPilot: no .venv or installed pixi environment found in this workspace (pixi projects: run "pixi install").'
        );
      } else if (results.includes('unavailable')) {
        vscode.window.showInformationMessage(
          'PyPilot: could not select the project environment. Install or enable the Python extension, or pick it with "Python: Select Interpreter".'
        );
      } else {
        vscode.window.showInformationMessage('PyPilot: the project environment is already the active interpreter.');
      }
    })
  );
}
