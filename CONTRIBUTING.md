# Contributing to PyPilot for VS Code

Thanks for your interest in PyPilot. It is a free, open-source project maintained
by [Abdullah Masood](https://github.com/Abdullah-Masood-05), and bug reports, ideas
and pull requests are all welcome.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## How this project is organized

PyPilot is split into a few repositories:

| Part | What it does |
|---|---|
| **This repo**, `pypilot-vscode` | The VS Code extension: activation, status bar, commands, tasks, report panel, and downloading the engine |
| [`pypilot`](https://github.com/pypilot-dev/pypilot) | The Rust engine (the `pypilot` CLI and language server) and the Zed extension. The environment logic, GPU/CUDA tables and diagnostics live here |
| [`pypilot-pip`](https://github.com/pypilot-dev/pypilot-pip) | The `pypilot-cli` package on PyPI, a thin wrapper that downloads the engine |

Problems with *what PyPilot decides* (which Python version, which CUDA build, which
imports are flagged) usually belong in the engine repo. Problems with *how it shows
up in VS Code* belong here. If you are not sure, open the issue here and we will
move it.

## Reporting a bug

Open an [issue](https://github.com/pypilot-dev/pypilot-vscode/issues/new?template=bug_report.md)
and include:

- What you did, what you expected, and what happened instead.
- Your OS, VS Code version, PyPilot extension version, and the helper version
  (`pypilot --version`).
- The **PyPilot** output channel (View → Output → PyPilot) and the doctor report
  (`PyPilot: Doctor: Show Environment Report`) if the problem is about an environment.
- A minimal `requirements.txt` or `pyproject.toml` that reproduces it. Environment
  problems are much easier to fix when we can see the dependencies involved.

For security problems, please do not open a public issue. Contact the maintainer
through the GitHub profile linked above.

## Suggesting a feature

Open a [feature request](https://github.com/pypilot-dev/pypilot-vscode/issues/new?template=feature_request.md).
Describe the problem first, then the change you have in mind. PyPilot answers from
package metadata and local checks, with no AI service and no API keys, so ideas that
keep that property are the easiest to accept.

## Setting up for development

You need [Bun](https://bun.sh) and VS Code 1.85 or later.

```bash
git clone https://github.com/pypilot-dev/pypilot-vscode.git
cd pypilot-vscode
bun install
```

| Command | What it does |
|---|---|
| `bun run build` | Bundle the extension into `out/` |
| `bun run watch` | Rebuild on every change |
| `bun run typecheck` | Run the TypeScript compiler without emitting files |
| `bun run lint` | Check `src/` with Biome |
| `bun run package` | Build a `.vsix` you can install locally |

**Run it:** open the folder in VS Code and press **F5**. The *Run Extension* launch
configuration builds the extension and opens an Extension Development Host window.
Open a Python project in that window to try it.

**Install a build:** `bun run package`, then *Extensions → ⋯ → Install from VSIX…*.

**The helper binary:** the extension runs the `pypilot` engine. By default it uses a
`pypilot` found on your `PATH` and otherwise downloads the latest release. To test
engine changes, build the engine from the
[`pypilot`](https://github.com/pypilot-dev/pypilot) repo
(`cargo install --path helper`) and reload the window. After updating the helper,
run **Developer: Reload Window** so VS Code restarts the language server.

There is no automated test suite for the extension yet. Before sending a pull
request, make sure `bun run typecheck` and `bun run build` pass (CI runs them), and
try your change in the Extension Development Host.

## Sending a pull request

1. Open an issue first for anything larger than a small fix, so we can agree on the
   approach before you spend time on it.
2. Fork the repo and create a branch from `master`.
3. Keep the change focused. Match the style of the surrounding code, and explain *why*
   in comments rather than restating what the code does.
4. Make small, logical commits with clear messages (for example
   `fix(commands): ...` or `feat(venv): ...`).
5. Run `bun run typecheck` and `bun run build`.
6. Open the pull request, describe what changed and why, and link the issue. Mention
   anything you could not test (for example, a platform you do not have).

The maintainer reviews pull requests as time allows, so a short wait is normal.

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license as the project.
