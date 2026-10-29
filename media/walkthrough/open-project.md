# Open a Python project

PyPilot starts when the folder contains Python files, a `requirements.txt`,
a `pyproject.toml`, a `pixi.toml` or a conda `environment.yml`.

Several folders in one window? Each folder with a Python project gets its
own PyPilot server, settings and interpreter. Commands act on the folder of
the file you are editing, or ask which folder to use.

On first start it downloads its small native helper (about 3 MB) unless a
`pypilot` binary is already on your `PATH`. Nothing else is sent anywhere:
there is no account, API key or AI service involved.
