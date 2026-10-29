# Changelog

## Unreleased

### Security

- The engine is pinned: the extension installs the version named in
  `package.json` (`pypilotEngine`, currently 1.2.2) instead of whatever is
  latest, and checks every download's SHA-256 before extracting it (the pin
  for the pinned version, the release's `SHA256SUMS` otherwise). Mismatches
  and releases without checksums install nothing.
- The report panel only runs scripts carrying a per-render nonce (no
  `unsafe-inline`).

### Added

- `pypilot.helperPath`: run a locally built helper; no downloads or update
  offers while it is set.
- `pypilot.engineUpdates`: `pinned` (default) or `latest`.
- Downloads honour `HTTPS_PROXY` / `NO_PROXY` when `http.proxySupport` is
  `off` (otherwise VS Code proxies them itself).

- `pypilot.pixiEnvironment` setting: which pixi environment PyPilot and the
  interpreter selection use in multi-environment pixi projects (default
  `default`, so `.pixi/envs/default` as before). Changing it selects the new
  environment right away.
- `PyPilot: Install pixi`: installs pixi through the helper; with an older
  helper it offers to run pixi's official installer in a terminal.
- `PyPilot: Initialize pixi project`: previews the `pixi.toml` the helper
  would write and writes it (optionally running `pixi install`) only after
  confirmation.
- `pixi` value for `pypilot.packageManager`.
- A "Get started with PyPilot" walkthrough, including a step on what changes
  in pixi projects.
- `pypilot.diagnosticsScope` setting: `openFiles` (default) or `workspace`
  (background scan of every Python file, so the Problems panel covers the
  whole project). Sent to the helper as
  `initializationOptions.diagnosticsScope` and
  `settings.pypilot.diagnosticsScope`; needs a helper that supports it.
- Report panel: **Copy as Markdown** and **Save as HTML** (a standalone page
  with inline styles in the current theme colors, no scripts).
- The Markdown report opened by Doctor has an editor title button that shows
  it in the report panel.
- Status bar tooltip: Python version, environment path, package manager
  (`uv` / `uv-pip` / `pip` / `pixi`, marked "auto" when chosen
  automatically) and the pixi environment, read from files on disk.
- Multi-root workspaces: one language server per workspace folder with a
  Python project, each with that folder's settings and files. Commands act on
  the active editor's folder or ask which one; quick fixes go to the file's
  folder; tasks are listed per folder.

### Changed

- Project-specific commands are hidden from the Command Palette where they
  cannot apply: Fix CUDA / PyTorch Build (no torch or tensorflow in the
  manifests), Migrate Conda environment.yml (no `environment.yml`),
  Initialize pixi project (every folder already uses pixi) and Install pixi
  (pixi already installed). They still run from walkthrough links and
  keybindings.
- **PyPilot: Open Environment Report Panel** now opens the webview panel; it
  used to open the same Markdown document as Doctor. The panel shows the
  helper's report as is and no longer watches the temp directory.
- The report panel's Fix CUDA button only shows for projects that use torch
  or tensorflow.

- The extension now passes its settings to the helper:
  `initializationOptions.pixiEnvironment` at startup and the `pypilot`
  settings section through `workspace/didChangeConfiguration`.
- PyPilot also activates in folders that only contain a `pixi.toml`, and
  tells the helper when `pixi.toml` changes.
