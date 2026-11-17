#!/bin/sh
# Starts OpenVSCode Server for the Agentic Code container. The server always
# asks for a connection token, so other programs on your computer cannot open
# the editor (and its terminal) without it.
set -eu

token="${CONNECTION_TOKEN:-}"
if [ -z "$token" ]; then
  token="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
token_file="$(mktemp)"
printf '%s' "$token" > "$token_file"
chmod 600 "$token_file"
# Keep the token out of the environment that terminals and extensions inherit.
unset CONNECTION_TOKEN

port="${PORT:-3000}"
folder="${WORKSPACE_FOLDER:-/home/workspace/project}"
echo "Agentic Code container is starting."
echo "Open: http://localhost:${port}/?tkn=${token}&folder=${folder}"

exec "${OPENVSCODE_SERVER_ROOT}/bin/openvscode-server" \
  --host "${HOST:-0.0.0.0}" \
  --port "$port" \
  --connection-token-file "$token_file" \
  --extensions-dir "$VSCODE_EXTENSIONS_DIR" \
  --telemetry-level off \
  --accept-server-license-terms \
  "$@"
