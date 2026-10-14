<p align="center">
  <img src="media/icon.png" width="128" height="128" alt="PyPilot Logo" />
</p>

# PyPilot for VS Code

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=AbdullahMasood-005.pypilot-vscode"><img src="https://vsmarketplacebadges.dev/version-short/AbdullahMasood-005.pypilot-vscode.svg?label=marketplace&color=0078d4" alt="VS Marketplace version" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=AbdullahMasood-005.pypilot-vscode"><img src="https://vsmarketplacebadges.dev/installs-short/AbdullahMasood-005.pypilot-vscode.svg?label=installs&color=2ea44f" alt="Installs" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=AbdullahMasood-005.pypilot-vscode&ssr=false#review-details"><img src="https://vsmarketplacebadges.dev/rating-short/AbdullahMasood-005.pypilot-vscode.svg?label=rating&color=fe7d37" alt="Rating" /></a>
  <a href="https://open-vsx.org/extension/AbdullahMasood-005/pypilot-vscode"><img src="https://img.shields.io/open-vsx/v/AbdullahMasood-005/pypilot-vscode?label=open%20vsx&color=a60ee5" alt="Open VSX version" /></a>
  <a href="https://github.com/pypilot-dev/pypilot-vscode/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0" /></a>
  <a href="https://github.com/pypilot-dev/pypilot-vscode"><img src="https://img.shields.io/github/stars/pypilot-dev/pypilot-vscode?style=social" alt="GitHub stars" /></a>
</p>

> ⭐ **Enjoying PyPilot?** If it saved you from a broken environment, please [star it on GitHub](https://github.com/pypilot-dev/pypilot-vscode) or [leave a rating](https://marketplace.visualstudio.com/items?itemName=AbdullahMasood-005.pypilot-vscode&ssr=false#review-details). It's free and it helps other Python developers find it.

PyPilot inspects Python projects, figures out which Python versions your dependencies actually support, and creates a working virtual environment. It resolves driver and CUDA compatibility for PyTorch or TensorFlow, checks package wheels on PyPI, and flags broken imports directly in the editor without external API calls.

This extension runs the same native Rust engine as [PyPilot for Zed](https://github.com/pypilot-dev/pypilot), integrated with VS Code surfaces: the command palette, status bar, progress indicators, interactive doctor report panel, and workspace tasks.

## Features

- **Environment setup**: Runs `uv init` and `uv add` when no `pyproject.toml` exists. In pip mode, records installations using `pip freeze > requirements.txt`.
- **Python version resolution**: Evaluates PyPI wheel availability against `requires_python` to find an interpreter version that satisfies all dependencies.
- **Hardware matching**: Inspects host NVIDIA drivers via `nvidia-smi` and aligns `torch` or `tensorflow` with the correct CUDA runtime wheel.
- **Import diagnostics**: Flags missing or incompatible package imports in open files, with quick fixes to install or resolve them.
- **Onboarding prompt**: Scans opened folders and displays an actionable alert when environment issues need attention.
- **Status bar**: Displays interpreter state in the status bar with quick access to the report panel.
- **Task integration**: Provides workspace task definitions for environment bootstrap, health checks, and package maintenance.
- **Report panel**: Renders the doctor diagnostics report in an interactive webview panel.

## Requirements

- VS Code 1.85 or later.
- Network access during initial startup to download the native `pypilot` helper binary (approximately 3 MB).
- Python does not need to be installed beforehand when using `uv` mode; `uv` downloads required interpreters directly.

## Getting started

1. Open a Python project directory in VS Code.
2. PyPilot activates and scans the environment.
3. If an issue is found, a prompt appears with options to run the automatic fix or inspect the report.
4. The environment is configured for the Python version supported by your project dependencies.

## Commands

| Command | Action |
|---|---|
| `PyPilot: Set Up Environment` | Bootstraps the environment, installs Python if needed, and installs dependencies |
| `PyPilot: Doctor: Show Environment Report` | Runs a health check and displays the interactive report panel |
| `PyPilot: Fix Python Version` | Recalculates compatible versions and rebuilds the virtual environment |
| `PyPilot: Fix CUDA / PyTorch Build` | Re-pins machine learning dependencies to the driver-supported build |
| `PyPilot: Check Package Compatibility...` | Checks whether a specific package runs on the current Python version |
| `PyPilot: Install Package...` | Installs a package and updates the project manifest |
| `PyPilot: Update Bundled Data Tables` | Updates cached hardware and framework compatibility data |
| `PyPilot: Migrate Conda environment.yml to pyproject.toml` | Translates conda environment definitions into pyproject.toml |
| `PyPilot: Open Environment Report Panel` | Runs the health check and opens the environment report |
| `PyPilot: Install uv Globally` | Installs `uv` so it is available outside this workspace |
| `PyPilot: Check for Helper Updates` | Compares the installed helper against the latest GitHub release |
| `PyPilot: Use Project Environment (.venv / pixi)` | Makes the workspace's `.venv` (or pixi default environment) the active Python interpreter |

## Settings

| Setting | Default | Description |
|---|---|---|
| `pypilot.packageManager` | `"auto"` | `auto` (use `uv` when it is installed, offer to install it, otherwise fall back to `pip`), `uv` project mode, `uv-pip`, or `pip`. |
| `pypilot.notifications` | `"problems-only"` | Configures notification verbosity: `all`, `problems-only`, or `off`. |
| `pypilot.autoCheckOnOpen` | `true` | Automatically checks the environment when opening a workspace. |
| `pypilot.autoSelectVenv` | `true` | Makes the workspace's `.venv` the active Python interpreter when it is created or changed, and on startup when no interpreter inside the workspace is selected. pixi projects (`pixi.toml`, or `[tool.pixi.workspace]` in `pyproject.toml`) are supported: their default environment (`.pixi/envs/default`) is selected after `pixi install`, and no `.venv` is used. |
| `pypilot.dataRefreshDays` | `7` | Refresh interval in days for compatibility data tables (0 disables updates). |

## Architecture

The extension is a TypeScript client wrapping the native Rust `pypilot` helper binary. On startup, the extension checks PATH for an existing binary and downloads a release if none is found. The helper communicates over standard I/O via the Language Server Protocol.

```
pypilot-vscode/
├── src/
│   ├── extension.ts        LanguageClient activation and onboarding flow
│   ├── downloader.ts       Binary resolution and release downloads
│   ├── statusBar.ts        Editor status bar indicator
│   ├── commands.ts         Command palette actions
│   ├── tasks.ts            Workspace task provider
│   ├── venv.ts             .venv / pixi env auto-selection via the Python extension APIs
│   └── webview/
│       └── reportPanel.ts  Interactive HTML doctor report webview
├── build.ts                Bun build script
├── bunfig.toml
└── package.json
```

## Development

Build and package scripts use Bun:

```bash
# Install dependencies
bun install

# Compile extension
bun run build

# Watch mode during development
bun run build --watch

# Build vsix package
bun run package
```

## Support the project

PyPilot is free and open source, built and maintained in spare time. If it helps you:

- ⭐ [Star it on GitHub](https://github.com/pypilot-dev/pypilot-vscode): it's the easiest way to show support.
- 📝 [Rate it on the Marketplace](https://marketplace.visualstudio.com/items?itemName=AbdullahMasood-005.pypilot-vscode&ssr=false#review-details): reviews help others decide to try it.
- 🐛 [Report a bug or request a feature](https://github.com/pypilot-dev/pypilot-vscode/issues): reproducible environment problems are especially welcome.

## License

Apache-2.0. See the project repository license for details.
