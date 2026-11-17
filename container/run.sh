#!/bin/sh
# Starts the Agentic Code container with Podman (rootless) for one project folder.
#
#   container/run.sh [project-folder]      (default: the current folder)
#
# Only that folder is shared with the container. Open the printed address in
# your browser. Stop with Ctrl+C. Full guide: docs/podman.md
#
# Settings through environment variables:
#   IMAGE          image to run (default: agentic-code)
#   PORT           port on your computer for the editor (default: 3000)
#   NAME           container name (default: agentic-code)
#   DATA_VOLUME    Podman volume for editor settings and data (default: agentic-code-data)
#   MODEL_PORT     port of your model server on this computer (default: 11434)
#   MODEL_NETWORK  how the container reaches the model server:
#                    auto     (default) pasta if available, else slirp4netns
#                    pasta    forward only MODEL_PORT from this computer's localhost
#                    slirp    allow all of this computer's localhost (older Podman)
#                    default  normal container network; use when the model server
#                             is on another computer or listens on all addresses
#   EXTRA_ARGS     more arguments for podman run, e.g. "-v ~/data:/data:ro,Z"
set -eu

project="${1:-$PWD}"
[ -d "$project" ] || { echo "Not a folder: $project" >&2; exit 1; }
project="$(cd "$project" && pwd -P)"
case "$project" in
  /|"$HOME") echo "Refusing to share $project: pick a project folder, not / or your home folder." >&2; exit 1 ;;
esac

image="${IMAGE:-agentic-code}"
port="${PORT:-3000}"
name="${NAME:-agentic-code}"
data_volume="${DATA_VOLUME:-agentic-code-data}"
model_port="${MODEL_PORT:-11434}"
mode="${MODEL_NETWORK:-auto}"

if [ "$mode" = auto ]; then
  if command -v pasta >/dev/null 2>&1 || command -v passt >/dev/null 2>&1; then mode=pasta; else mode=slirp; fi
fi
case "$mode" in
  pasta)   net="--network pasta:-T,$model_port --add-host host.containers.internal:127.0.0.1" ;;
  slirp)   net="--network slirp4netns:allow_host_loopback=true --add-host host.containers.internal:10.0.2.2" ;;
  default) net="" ;;
  *) echo "MODEL_NETWORK must be auto, pasta, slirp or default" >&2; exit 1 ;;
esac

# Files the container writes in the project belong to you, not to a sub-uid.
# Podman 4.3+ can map you onto the image's user (uid 1000) whatever your uid is.
podman_major_minor="$(podman version --format '{{.Client.Version}}' | awk -F. '{ printf "%d%03d", $1, $2 }')"
if [ "$podman_major_minor" -ge 4003 ]; then
  userns="--userns=keep-id:uid=1000,gid=1000"
else
  userns="--userns=keep-id"
  [ "$(id -u)" = 1000 ] || echo "Warning: your uid is $(id -u), not 1000; upgrade Podman to 4.3+ if the editor cannot write its settings." >&2
fi

# A connection token that stays the same between runs, so a bookmark keeps working.
token_dir="${XDG_CONFIG_HOME:-$HOME/.config}/agentic-code-container"
mkdir -p "$token_dir"
chmod 700 "$token_dir"
if [ ! -s "$token_dir/token" ]; then
  (umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$token_dir/token")
fi
token="$(cat "$token_dir/token")"

echo "Project:  $project"
echo "Model:    $mode network, port $model_port"
echo "Open:     http://localhost:$port/?tkn=$token&folder=/home/workspace/project"
echo

# shellcheck disable=SC2086  # $net, $userns and $EXTRA_ARGS are word lists on purpose
exec podman run --rm -it --init --name "$name" \
  $userns \
  $net \
  -p "127.0.0.1:$port:3000" \
  -e CONNECTION_TOKEN="$token" \
  -v "$project:/home/workspace/project:Z" \
  -v "$data_volume:/home/workspace/.openvscode-server" \
  ${EXTRA_ARGS:-} \
  "$image"
