/**
 * clients.ts — one PyPilot language server per workspace folder.
 *
 * The engine works on a single project root: it takes the first entry of
 * `initialize.workspaceFolders` and keeps its editor settings per process.
 * A multi-root workspace therefore gets one `pypilot lsp` per folder that
 * holds a Python project, each started with `clientOptions.workspaceFolder`
 * (so `workspaceFolders` names just that folder and the
 * `didChangeConfiguration` settings are read for it) and a document selector
 * scoped to the folder. This is the standard multi-root pattern from the
 * vscode-extension-samples `lsp-multi-server-sample`.
 *
 * - A single-folder window (the common case) behaves as before: one server,
 *   started right away, that also checks Python files opened from outside
 *   the folder. A window with no folder gets one folder-less server, as
 *   before. If folders are added later, that server is restarted with a
 *   folder-scoped selector so no file is served twice.
 * - In a multi-root window, a folder gets a server when it has a Python
 *   manifest or `.py` file, or as soon as a Python / manifest document from
 *   it is opened. Removing the folder stops its server.
 * - A folder nested inside another workspace folder is served by the
 *   outermost one, so no file is ever watched by two servers.
 *
 * Server commands. vscode-languageclient registers every command a server
 * lists in `executeCommandProvider` under its own id, and a second
 * registration of the same id throws, so a second server would fail to
 * start. Each client's registration is therefore switched off and the ids
 * are registered once here, routed to the server of the folder the user is
 * working in (code actions run from the active editor). PyPilot's command
 * arguments carry no file, so the active editor is the only routing signal.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ExecuteCommandRequest,
  LanguageClient,
  LanguageClientOptions,
  Middleware,
  ServerOptions,
  State,
} from 'vscode-languageclient/node';
import { diagnosticsScope } from './project';
import { pixiEnvName } from './venv';

/** A running (or starting) language client and the folder it serves. */
export interface FolderClient {
  /** Undefined only for the folder-less client of a window without folders. */
  readonly folder: vscode.WorkspaceFolder | undefined;
  readonly client: LanguageClient;
  /** Settles once the client has started (or failed to). */
  readonly started: Promise<boolean>;
}

interface Entry extends FolderClient {
  /** Selector limited to the folder (false: every file, single-folder window). */
  readonly scoped: boolean;
  readonly watcher: vscode.Disposable;
}

export interface ClientManagerOptions {
  helperPath: string;
  /** Extra middleware per client (the report panel hooks showDocument). */
  middleware?: (folder: vscode.WorkspaceFolder | undefined) => Middleware;
  /** Called after each start attempt. */
  onStarted?: (fc: FolderClient, ok: boolean, err?: unknown) => void;
}

/** Root files that mark a folder as a Python project. */
const PROJECT_FILES = [
  'pyproject.toml',
  'requirements.txt',
  'pixi.toml',
  'environment.yml',
  'environment.yaml',
  'setup.py',
  'setup.cfg',
  'Pipfile',
];

/** Documents that make the folder they live in get a server. */
const MANIFEST_NAMES = new Set(['requirements.txt', 'pyproject.toml', 'environment.yml', 'pixi.toml']);

const NO_FOLDER_KEY = '<no folder>';

function key(folder: vscode.WorkspaceFolder | undefined): string {
  return folder ? folder.uri.toString() : NO_FOLDER_KEY;
}

/** The workspace folder that serves `folder`: the outermost one containing it. */
function outermost(folder: vscode.WorkspaceFolder): vscode.WorkspaceFolder {
  let best = folder;
  for (const other of vscode.workspace.workspaceFolders ?? []) {
    if (other.uri.scheme !== folder.uri.scheme) continue;
    const parent = other.uri.path.endsWith('/') ? other.uri.path : `${other.uri.path}/`;
    if (folder.uri.path.startsWith(parent) && other.uri.path.length < best.uri.path.length) best = other;
  }
  return best;
}

/** `vscode-notebook-cell:` URIs share the notebook's path; map them to it. */
function asFileUri(uri: vscode.Uri): vscode.Uri {
  return uri.scheme === 'vscode-notebook-cell' ? uri.with({ scheme: 'file', fragment: '' }) : uri;
}

/** The workspace folder that serves `uri`, if any. */
export function folderFor(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(asFileUri(uri));
  return folder ? outermost(folder) : undefined;
}

/** The folder of the active editor or notebook, if it belongs to one. */
export function activeFolder(): vscode.WorkspaceFolder | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri ?? vscode.window.activeNotebookEditor?.notebook.uri;
  return uri ? folderFor(uri) : undefined;
}

/** True if `folder` holds a Python project: a manifest at its root or any `.py` file. */
async function hasPythonProject(folder: vscode.WorkspaceFolder): Promise<boolean> {
  if (folder.uri.scheme === 'file') {
    const root = folder.uri.fsPath;
    if (PROJECT_FILES.some((n) => fs.existsSync(path.join(root, n)))) return true;
  }
  try {
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*.{py,ipynb}'),
      '**/{node_modules,.venv,.pixi,.git}/**',
      1
    );
    return found.length > 0;
  } catch {
    return false;
  }
}

function isServedDocument(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'vscode-notebook-cell') return false;
  return doc.languageId === 'python' || MANIFEST_NAMES.has(path.basename(doc.uri.fsPath));
}

/**
 * Switch off the client's own registration of server commands (see the
 * module docs). Returns false if this vscode-languageclient does not expose
 * the feature the way 9.x does; the caller then serves only one folder.
 */
function disableCommandRegistration(client: LanguageClient): boolean {
  const feature = (client as unknown as { getFeature(method: string): unknown }).getFeature?.(
    ExecuteCommandRequest.method
  ) as { register?: unknown } | undefined;
  if (!feature || typeof feature.register !== 'function') return false;
  feature.register = () => undefined;
  return true;
}

export class ClientManager implements vscode.Disposable {
  private readonly clients = new Map<string, Entry>();
  /** Server command ids registered by this manager. */
  private readonly routed = new Map<string, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly outputChannel = vscode.window.createOutputChannel('PyPilot');
  private readonly changed = new vscode.EventEmitter<void>();
  /** False when command routing cannot be set up: one server only, as before. */
  private multi = true;
  private disposed = false;

  /** Fires when a client is added or removed. */
  readonly onDidChange = this.changed.event;

  constructor(private readonly options: ClientManagerOptions) {}

  /** Start the servers for the current folders and follow later changes. */
  start(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.ensure(undefined);
    } else if (folders.length === 1) {
      // As before: the only folder always gets a server.
      this.ensure(folders[0]);
    } else {
      for (const folder of folders) {
        if (outermost(folder) !== folder) continue;
        void hasPythonProject(folder).then((yes) => yes && this.ensure(folder));
      }
    }

    // Any already-open document from a folder without a server, and every
    // one opened later, starts that folder's server.
    const onOpen = (doc: vscode.TextDocument) => {
      if (!isServedDocument(doc)) return;
      const folder = folderFor(doc.uri);
      if (folder) this.ensure(folder);
    };
    vscode.workspace.textDocuments.forEach(onOpen);

    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument(onOpen),
      vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
        for (const folder of e.removed) await this.stop(folder);
        const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
        for (const entry of [...this.clients.values()]) {
          if (!entry.folder) continue;
          if (outermost(entry.folder) !== entry.folder) {
            // Adding a parent folder makes nested ones redundant.
            await this.stop(entry.folder);
          } else if (multiRoot && !entry.scoped) {
            // The single-folder server also served files outside its folder;
            // with more folders it must only serve its own.
            await this.stop(entry.folder);
            this.ensure(entry.folder);
          }
        }
        for (const folder of e.added) {
          const top = outermost(folder);
          if (await hasPythonProject(top)) this.ensure(top);
        }
      })
    );
  }

  /** Every client, started or starting. */
  all(): FolderClient[] {
    return [...this.clients.values()];
  }

  /** The client serving `folder`, if one runs. */
  get(folder: vscode.WorkspaceFolder | undefined): FolderClient | undefined {
    return this.clients.get(key(folder ? outermost(folder) : undefined));
  }

  /**
   * The client the user is working with: the active editor's folder, or the
   * only client. Undefined when that is ambiguous.
   */
  current(): FolderClient | undefined {
    const folder = activeFolder();
    const fc = folder ? this.get(folder) : undefined;
    if (fc) return fc;
    return this.clients.size === 1 ? this.all()[0] : undefined;
  }

  /**
   * The client a command should talk to: `current()` when it qualifies,
   * otherwise a quick pick among the qualifying ones (only when there are
   * several). Undefined when there is none or the user cancels.
   */
  async pick(options: { filter?: (fc: FolderClient) => boolean; placeHolder?: string } = {}): Promise<FolderClient | undefined> {
    const candidates = this.all().filter((fc) => options.filter?.(fc) ?? true);
    const cur = this.current();
    if (cur && candidates.includes(cur)) return cur;
    if (candidates.length <= 1) return candidates[0];
    const picked = await vscode.window.showQuickPick(
      candidates.map((fc) => ({
        label: fc.folder?.name ?? 'PyPilot',
        description: fc.folder?.uri.fsPath,
        fc,
      })),
      { placeHolder: options.placeHolder ?? 'PyPilot: which project folder?' }
    );
    return picked?.fc;
  }

  /** Start the server for `folder` unless one runs already. */
  ensure(folder: vscode.WorkspaceFolder | undefined): FolderClient | undefined {
    const existing = this.clients.get(key(folder));
    if (existing || this.disposed) return existing;
    // Without command routing a second server would fail to start.
    if (!this.multi && this.clients.size > 0) return this.all()[0];

    const watched = '**/{requirements.txt,pyproject.toml,pixi.toml,environment.yml,*.py}';
    const fileWatcher = vscode.workspace.createFileSystemWatcher(
      folder ? new vscode.RelativePattern(folder, watched) : watched
    );
    // Folder-scoped selector entries in a multi-root window; otherwise every
    // file, as before. The protocol type only allows string patterns, but
    // vscode-languageclient hands a client-side pattern to
    // vscode.languages.match unchanged, and that accepts a RelativePattern
    // (which, unlike a glob built from fsPath, also works on Windows paths).
    const scopedSelector = folder !== undefined && (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const scoped = (pattern: string): string =>
      scopedSelector && folder ? (new vscode.RelativePattern(folder, pattern) as unknown as string) : pattern;

    const serverOptions: ServerOptions = {
      command: this.options.helperPath,
      args: ['lsp'],
    };
    const clientOptions: LanguageClientOptions = {
      // Python files and the manifest formats PyPilot understands.
      documentSelector: [
        { scheme: 'file', language: 'python', pattern: scoped('**/*') },
        // Python cells inside notebooks (.ipynb). The server does not
        // advertise notebookDocumentSync, so vscode-languageclient syncs each
        // cell as an ordinary text document (didOpen/didChange keyed by the
        // cell URI), which is all diagnostics and code actions need. A cell
        // URI has the notebook's path, so the folder pattern applies.
        { scheme: 'vscode-notebook-cell', language: 'python', pattern: scoped('**/*') },
        { scheme: 'file', pattern: scoped('**/requirements.txt') },
        { scheme: 'file', pattern: scoped('**/pyproject.toml') },
        { scheme: 'file', pattern: scoped('**/environment.yml') },
      ],
      workspaceFolder: folder,
      // Settings the server needs before its first scan: the pixi
      // environment (the same one venv.ts selects as the interpreter) and
      // which files get diagnostics. Later changes arrive through
      // `configurationSection` below as `settings.pypilot.<key>`.
      initializationOptions: {
        pixiEnvironment: pixiEnvName(folder),
        diagnosticsScope: diagnosticsScope(folder),
      },
      synchronize: {
        // Sends workspace/didChangeConfiguration with `{ settings: { pypilot:
        // { ... } } }` once after startup and whenever a pypilot.* setting
        // changes, read for this folder. Servers that do not read it ignore it.
        configurationSection: 'pypilot',
        fileEvents: fileWatcher,
      },
      outputChannel: this.outputChannel,
      middleware: this.options.middleware?.(folder),
    };

    const name = folder && (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? `PyPilot (${folder.name})` : 'PyPilot';
    const client = new LanguageClient('pypilot', name, serverOptions, clientOptions);
    if (!disableCommandRegistration(client)) {
      // Keep the library's own registration; it only works for one server.
      this.multi = false;
    }

    const started = client.start().then(
      () => {
        this.routeCommands(client);
        this.options.onStarted?.(fc, true);
        return true;
      },
      (err: unknown) => {
        console.error(`PyPilot LSP failed to start for ${folder?.name ?? 'this window'}:`, err);
        this.options.onStarted?.(fc, false, err);
        return false;
      }
    );
    const fc: Entry = { folder, client, started, scoped: scopedSelector, watcher: fileWatcher };
    this.clients.set(key(folder), fc);
    this.changed.fire();
    return fc;
  }

  /** Register the server's command ids once, routed to the current folder's server. */
  private routeCommands(client: LanguageClient): void {
    if (!this.multi) return;
    const commands = client.initializeResult?.capabilities.executeCommandProvider?.commands ?? [];
    for (const command of commands) {
      if (this.routed.has(command)) continue;
      try {
        this.routed.set(
          command,
          vscode.commands.registerCommand(command, async (...args: unknown[]) => {
            const fc = await this.pick({
              filter: (c) => c.client.state === State.Running,
            });
            if (!fc) return undefined;
            return fc.client.sendRequest(ExecuteCommandRequest.type, { command, arguments: args });
          })
        );
      } catch (err) {
        // Another extension owns the id; leave it alone.
        console.warn(`PyPilot: could not register server command ${command}: ${err}`);
      }
    }
  }

  private async stop(folder: vscode.WorkspaceFolder): Promise<void> {
    const k = key(folder);
    const fc = this.clients.get(k);
    if (!fc) return;
    this.clients.delete(k);
    fc.watcher.dispose();
    this.changed.fire();
    try {
      await fc.client.dispose();
    } catch (err) {
      console.warn(`PyPilot: stopping the server for ${folder.name} failed: ${err}`);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.disposables.forEach((d) => d.dispose());
    this.routed.forEach((d) => d.dispose());
    this.routed.clear();
    const clients = [...this.clients.values()];
    this.clients.clear();
    clients.forEach((fc) => fc.watcher.dispose());
    await Promise.all(clients.map((fc) => fc.client.stop().catch(() => undefined)));
    this.outputChannel.dispose();
    this.changed.dispose();
  }
}
