# Fix the environment

**Fix environment** (or **PyPilot: Set Up Environment**) creates or repairs
the project environment on a Python version your dependencies support,
installs them, and records them in your manifest.

Once the environment exists, PyPilot makes it the active interpreter, so
the Python extension and the notebook kernel picker use it too. Turn this
off with `pypilot.autoSelectVenv`.

`pypilot.packageManager` chooses how: `auto` (uv when available), `uv`,
`uv-pip`, `pip` or `pixi`.
