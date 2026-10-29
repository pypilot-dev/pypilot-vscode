# PyPilot checks it

Right after the folder opens, PyPilot looks at your manifests and your
machine:

- which Python versions every dependency actually ships wheels for;
- whether the environment exists and matches that version;
- for PyTorch and TensorFlow, which CUDA build fits your NVIDIA driver;
- imports in open files that the environment cannot satisfy.

Problems show up as a notification with buttons, and as squiggles with
quick fixes in the editor. The full picture is in the doctor report. Its
panel can copy the report as Markdown or save it as an HTML file to share.

Hover the PyPilot status bar item to see the Python version, environment
path and package manager in use.
