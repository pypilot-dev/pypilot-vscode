# Changelog

## Unreleased

### Added

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

### Changed

- The extension now passes its settings to the helper:
  `initializationOptions.pixiEnvironment` at startup and the `pypilot`
  settings section through `workspace/didChangeConfiguration`.
- PyPilot also activates in folders that only contain a `pixi.toml`, and
  tells the helper when `pixi.toml` changes.
