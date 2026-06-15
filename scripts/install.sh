#!/usr/bin/env bash
# Install the `ccrun` binary onto your PATH. Idempotent — safe to re-run.
#
# Strategy: build, then symlink dist/cli.js into a user-writable bin dir
# (default ~/.local/bin). This avoids `npm link`/`npm i -g`, which fail on
# NixOS (read-only nix-store global prefix) and need sudo elsewhere.
#
# Override the target dir with: CCRUN_BIN_DIR=/some/dir bash scripts/install.sh
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
BIN_DIR="${CCRUN_BIN_DIR:-$HOME/.local/bin}"

command -v node >/dev/null || { echo "error: node >= 22 is required" >&2; exit 1; }
command -v tmux >/dev/null || echo "warning: tmux not found on PATH (ccrun needs it at runtime)" >&2
command -v claude >/dev/null || echo "warning: claude CLI not found on PATH (ccrun needs it at runtime)" >&2

echo "==> installing dependencies"
npm ci 2>/dev/null || npm install

echo "==> building"
npm run build

chmod +x "$ROOT/dist/cli.js"
mkdir -p "$BIN_DIR"
ln -sf "$ROOT/dist/cli.js" "$BIN_DIR/ccrun"
echo "==> linked $BIN_DIR/ccrun -> $ROOT/dist/cli.js"

case ":$PATH:" in
  *":$BIN_DIR:"*) echo "done. Try: ccrun --help" ;;
  *)
    echo
    echo "NOTE: $BIN_DIR is not on your PATH. Add this to your shell rc:"
    echo "    export PATH=\"$BIN_DIR:\$PATH\""
    echo "Then re-open your shell and run: ccrun --help"
    ;;
esac
