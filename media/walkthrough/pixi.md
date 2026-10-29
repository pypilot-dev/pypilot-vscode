# This project uses pixi: what's different

A folder with a `pixi.toml`, or a `pyproject.toml` with a
`[tool.pixi.workspace]` table, is a pixi project. PyPilot then works through
pixi instead of a virtual environment:

- **The environment lives in `.pixi/envs/<name>`.** That is `default` unless
  you set `pypilot.pixiEnvironment` (for example `cuda` in a project with
  several `[environments]`). PyPilot selects that interpreter after
  `pixi install`.
- **No `.venv`, no lockfile edits.** PyPilot never creates a `.venv` in a
  pixi project and never touches `pixi.lock`; pixi owns both.
- **Installs go through pixi.** Installing a package runs
  `pixi add --pypi <package>`, so it lands in your manifest.

No pixi yet? **PyPilot: Install pixi** runs pixi's official installer.
Want to move an existing project over? **PyPilot: Initialize pixi project**
shows the `pixi.toml` it would write and asks before writing anything.
