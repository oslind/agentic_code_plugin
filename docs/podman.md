# Run Agentic Code in a Podman container

This sets up VS Code in a container, with Agentic Code already installed. You
use the editor in your browser, and the container sees only the one project
folder you give it. Commands the agents run (checks, tests, scripts) run inside
the container, so even an approved command cannot touch other files on your
computer.

What you get:

- [OpenVSCode Server](https://github.com/gitpod-io/openvscode-server) (VS Code in the browser) on `http://localhost:3000`, behind a secret token.
- Agentic Code built from this checkout and installed.
- Everyday Linux tools, Python 3, and Node.js, plus whatever you add.
- The model server on your computer (Ollama, LM Studio, vLLM...) reachable from inside the container.

Everything lives in [`container/`](../container):

| File | What it is for |
| --- | --- |
| `Containerfile` | The image recipe. |
| `run.sh` | Starts the container for one project folder. |
| `apt-packages.txt` | Linux programs installed with `apt-get`. |
| `python-requirements.txt` | Python packages installed for every project. |
| `bin/` | Your own scripts and programs, put on the `PATH`. |
| `extensions.txt` | Extra VS Code extensions from Open VSX. |
| `vsix/` | Extra VS Code extensions as `.vsix` files. |
| `settings.json` | Default editor settings, including the model address. |
| `start.sh` | Starts the editor inside the container (you rarely need to touch it). |

## 1. Install Podman

On Windows, the simplest setup is Podman inside the same WSL distribution that
has your project and your model server (for example Ubuntu-22.04). In the WSL
terminal:

```sh
sudo apt-get update
sudo apt-get install -y podman
podman --version
podman run --rm docker.io/library/hello-world
```

Ubuntu 22.04 ships Podman 3.4, which works. Ubuntu 24.04 ships Podman 4.9.
Any other Linux works the same way with its own package manager.

Everything below runs as your normal user (rootless Podman). Do not use `sudo`
with `podman`.

If `podman run` complains about cgroups or systemd (WSL without systemd), create
`~/.config/containers/containers.conf` with:

```toml
[engine]
cgroup_manager = "cgroupfs"
events_logger = "file"
```

## 2. Build the image

From the root of this repository:

```sh
podman build -t agentic-code -f container/Containerfile .
```

The first build takes a few minutes. It builds the extension's VSIX (the same
`npm run package` as in the README), then installs it into the editor image
together with everything listed in the `container/` files. Your local
`node_modules`, `out` and `*.vsix` are not used; the build starts clean.

## 3. Start it

```sh
container/run.sh ~/Projects/my-project
```

Without a folder it uses the current folder. It prints an address like:

```
Open:     http://localhost:3000/?tkn=3f9c...&folder=/home/workspace/project
```

Open that address in your browser (on Windows, a normal Windows browser works:
WSL forwards `localhost`). The token stays the same between runs, so you can
bookmark it. It is stored in `~/.config/agentic-code-container/token`; delete
that file to get a new one.

When VS Code asks whether you trust the folder, answer yes: Agentic Code only
runs in trusted folders.

Stop the container with Ctrl+C in the terminal where `run.sh` runs (or
`podman stop agentic-code` from another terminal).

`run.sh` options are environment variables, for example:

```sh
PORT=3100 NAME=agentic-other DATA_VOLUME=agentic-other-data container/run.sh ~/Projects/other-project
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port on your computer for the editor. Use a different one per container. |
| `NAME` | `agentic-code` | Container name. Use a different one per container. |
| `DATA_VOLUME` | `agentic-code-data` | Podman volume for editor settings and saved chats. Use a different one per container running at the same time. |
| `IMAGE` | `agentic-code` | Image to run. |
| `MODEL_PORT` | `11434` | Port of your model server (Ollama's default). LM Studio uses 1234. |
| `MODEL_NETWORK` | `auto` | How the container reaches the model, see below. |
| `EXTRA_ARGS` | | More `podman run` arguments, for example an extra read-only folder: `EXTRA_ARGS="-v $HOME/datasets:/data:ro,Z"`. |

## 4. Connect the model

Inside the container, Agentic Code is set up to use
`http://host.containers.internal:11434/v1` with the model `qwen3:8b`.
`host.containers.internal` means "the computer the container runs on".
`run.sh` makes that name work even when the model server only listens on
`localhost` (Ollama's default), using `MODEL_NETWORK`:

- `auto` (default): `pasta` if it is installed, otherwise `slirp`.
- `pasta` (Podman 4.4+ with the `passt` package): only the model port is forwarded from your computer's `localhost`. Nothing else on your computer's `localhost` is visible to the container.
- `slirp` (older Podman, like 3.4 on Ubuntu 22.04): the container can reach every service on your computer's `localhost`, not just the model. Install `passt` and use `pasta` if that matters to you.
- `default`: the normal container network. Use it when the model server runs on another computer, or listens on all addresses (`OLLAMA_HOST=0.0.0.0`), and set the address in settings as below.

Check it from the editor: run **Agentic: Test model connection** from the
command palette. Or, in the editor's terminal:

```sh
curl http://host.containers.internal:11434/v1/models
```

To use a different model or server, open **Preferences: Open Remote Settings
(JSON)** in the editor and change `agentic.model.name` or
`agentic.model.baseUrl`. These settings are kept between runs (see "Where
things are kept"). To change the defaults for new setups, edit
`container/settings.json` and rebuild.

## 5. Add VS Code extensions

OpenVSCode Server installs extensions from [Open VSX](https://open-vsx.org),
not from Microsoft's marketplace. Most open-source extensions are there
(Python, Ruff, ESLint, Prettier, YAML, Go, Rust...). Microsoft-only extensions
such as Pylance, C/C++, Remote, and Copilot are not available and their
licenses do not allow other editors; use open alternatives (for example
`detachhead.basedpyright` instead of Pylance).

**From Open VSX:** add the id (publisher.name, shown on the extension's Open VSX
page) to `container/extensions.txt`, one per line, then rebuild:

```text
ms-python.python
charliermarsh.ruff
redhat.vscode-yaml@1.18.0
```

`@version` pins a version; without it you get the latest at build time.

**From a `.vsix` file:** put the file in `container/vsix/` and rebuild. Every
`.vsix` there is installed. Use this for extensions that are not on Open VSX or
that you built yourself. Git ignores `.vsix` files, so they stay on your
computer and are not committed.

**From the Extensions view in the editor:** works, but lasts only until the
container stops, because the container is started fresh each time. Use it to
try an extension, then add it to `extensions.txt` to keep it.

Automatic extension updates are turned off in the container. Extensions change
only when you rebuild the image. This also stops the editor from swapping
Agentic Code for some other extension that uses the same name on Open VSX.

## 6. Add programs

All of these take effect after a rebuild (step 2) and a restart (step 3).

**Linux programs from Ubuntu:** add the package name to
`container/apt-packages.txt`. The image is Ubuntu 22.04, so find names with:

```sh
podman run --rm docker.io/library/ubuntu:22.04 sh -c "apt-get update -qq && apt-cache search <word>"
```

The default list already has `less`, `nano`, `vim-tiny`, `file`, `tree`, `zip`,
`unzip`, `jq`, `ripgrep`, `procps`, `ping`, `build-essential`, and Python 3
with `pip` and `venv`. `git` and `curl` come with the base image. Node.js 22
and npm are copied in from the official Node image.

**Python packages for every project:** add them to
`container/python-requirements.txt` (requirements.txt format, for example
`pytest` or `ruff==0.6.9`). For packages that belong to one project, use a
virtual environment in the project instead; it lives in the project folder, so
it survives restarts:

```sh
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

**Your own scripts and programs:** put them in `container/bin/`. Each file is
copied to `/usr/local/bin` and made executable, so you can run it by name from
the editor's terminal and from Agentic Code checks. Shell scripts need a first
line like `#!/bin/sh` or `#!/usr/bin/env python3`. Programs must be built for
Linux x86-64.

**Other software:** for anything that needs more than a file copy (a `.deb`
download, a program unpacked into `/opt`, a vendor's apt repository), add a
`RUN` step in `container/Containerfile` at the "Your own additions" comment.
For example:

```dockerfile
# A .deb file from the web
RUN curl -fsSL -o /tmp/tool.deb https://example.com/tool_1.0_amd64.deb \
 && apt-get update && apt-get install -y /tmp/tool.deb \
 && rm -rf /var/lib/apt/lists/* /tmp/tool.deb

# A program unpacked into /opt and put on the PATH
RUN curl -fsSL https://example.com/tool-linux-x64.tar.gz | tar -xz -C /opt \
 && ln -s /opt/tool/bin/tool /usr/local/bin/tool
```

That spot runs as root. Keep downloads on `https://` and from sources you
trust: whatever you install there runs whenever an agent's command uses it.

Then add the commands to Agentic Code's checks as usual ([README](../README.md#try-it), step 4), for
example `{ "name": "test", "command": "pytest -q" }`.

## 7. Update

**After changes to this repository** (a new version of Agentic Code, or your
edits to `container/`):

```sh
git pull
podman build -t agentic-code -f container/Containerfile .
# stop the running container (Ctrl+C), then start it again
container/run.sh ~/Projects/my-project
podman image prune -f     # removes the old, now unused image layers
```

**Ubuntu packages and Open VSX extensions** only change when the image is
rebuilt. To pick up their latest versions even when nothing in `container/`
changed, rebuild without the cache:

```sh
podman build --no-cache -t agentic-code -f container/Containerfile .
```

**A newer VS Code:** the editor version is pinned in the `Containerfile`
(`VSCODE_IMAGE`). Pick a newer tag from
[gitpod/openvscode-server on Docker Hub](https://hub.docker.com/r/gitpod/openvscode-server/tags)
and either edit the line or pass it at build time:

```sh
podman build --build-arg VSCODE_IMAGE=docker.io/gitpod/openvscode-server:<tag> \
  -t agentic-code -f container/Containerfile .
```

Agentic Code needs VS Code 1.90 or newer.

## Where things are kept

- **Your project:** in your project folder, as always. Agentic Code's own files (`.agentic/`) live there too.
- **Editor settings, saved chats and other editor data:** in the Podman volume `agentic-code-data`, which survives restarts and rebuilds. The first run copies the default `settings.json` into it; later edits to `container/settings.json` only reach a new volume. To start over with fresh defaults: stop the container, then `podman volume rm agentic-code-data`. Containers running at the same time should each have their own volume: set `DATA_VOLUME`.
- **Everything else in the container** (extensions installed from the Extensions view, programs installed by hand with `pip install --user` or `npm -g` in the terminal) is gone when the container stops. Put what you want to keep in the `container/` files.

## Security

- The container sees only the project folder, the `agentic-code-data` volume, and anything you add with `EXTRA_ARGS`. `run.sh` refuses `/` and your home folder.
- Rootless Podman: the container runs as you, without root rights on your computer. Files it creates in the project belong to you (`--userns=keep-id`). `sudo` is turned off in the image, so a command run inside the container cannot become root there either. If you want it for your own terminal use, build with `--build-arg ALLOW_SUDO=true`, but agents' commands then get it too; adding programs through the `container/` files is the better way.
- The editor is only reachable from your own computer (`127.0.0.1`) and needs the token. Anyone with the token can use the editor's terminal, so do not share the address.
- The model server: see `MODEL_NETWORK` above. `pasta` exposes only the model port.
- The browser loads the editor's webviews (including Agentic Code's chat) from Microsoft's `vscode-cdn.net`, as every OpenVSCode Server does. The browser needs internet access for that; your code is not sent there.
- The container has normal internet access, like the commands you run outside it. Agentic Code still asks before writing files and running commands, according to your settings.
- Agentic Code's rule that agents only work inside the open project still applies; the container adds a second wall around the same folder.

## Troubleshooting

- **The page says "Forbidden":** the token is missing or wrong. Use the full address `run.sh` prints.
- **"Address already in use" on start:** another container or program uses port 3000. Use `PORT=3100` (and a different `NAME`).
- **Test model connection fails:** check the model server runs on your computer (`curl http://localhost:11434/v1/models` outside the container), then the `curl` from step 4 inside. With `MODEL_NETWORK=default`, the server must listen on all addresses.
- **Permission denied on project files or settings:** with Podman older than 4.3 your user id must be 1000 (check with `id -u`); otherwise upgrade Podman.
- **An extension in `extensions.txt` fails the build with "not found":** it is not on Open VSX under that id. Search [open-vsx.org](https://open-vsx.org), or use a `.vsix` file.
- **The chat panel stays empty:** the browser could not reach `vscode-cdn.net` (see Security).
