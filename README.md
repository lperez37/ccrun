# claude-tmux-run (`ccrun`)

Run **one** Claude Code turn and print the result — like `claude -p`, but it drives
the **interactive** `claude` REPL inside a detached **tmux** session instead of
print mode. That keeps usage on your Claude **subscription (interactive) pool**
rather than the metered programmatic/API pool.

```console
$ ccrun "In one sentence, what is 6 times 7?"
6 times 7 is 42.
```

It's deliberately tiny and single-shot: **no loops, no server, no daemon, no
database.** One prompt in, the final assistant message out, a clean exit code.
Wrap it in your own loop (bash, a Ralph loop, CI, whatever) — see
[Use it in a loop](#use-it-in-a-loop).

## Why

`claude -p "<prompt>"` runs Claude Code in **print mode**, which bills against the
metered programmatic pool. Driving the interactive REPL instead (no `-p`, with the
`entrypoint:cli` signature) keeps the work on your subscription. Doing that by hand
is fiddly — you need a PTY, careful input delivery, and a reliable way to know when
the turn is done. `ccrun` packages that into a single command with the same
ergonomics as `claude -p`.

## Requirements

`ccrun` itself has **zero runtime npm dependencies** (no native build). It only
needs these on the host:

| Requirement | Why | Check |
|-------------|-----|-------|
| **Node ≥ 22** | ESM + built-in `node:util` arg parsing | `node --version` |
| **tmux** | the run drives the REPL inside a detached tmux session | `tmux -V` |
| **`claude` CLI on PATH** | the agent being driven | `claude --version` |
| **Logged into an interactive subscription** | the whole point — keeps usage off the metered pool | run `claude` once; it should open the REPL, not ask for an API key |

`ccrun` runs a fast preflight on startup and exits with a clear message if `tmux`
or `claude` is missing.

## Install

```bash
git clone https://github.com/lperez37/claude-tmux-run.git
cd claude-tmux-run
bash scripts/install.sh
```

`install.sh` builds the project and symlinks `ccrun` into `~/.local/bin`
(override with `CCRUN_BIN_DIR=/some/dir`). It avoids `npm link`/`npm i -g`, which
fail on NixOS (read-only nix-store global prefix) and need `sudo` elsewhere. If
`~/.local/bin` isn't on your `PATH`, the script tells you what to add.

<details>
<summary>Manual install / other options</summary>

```bash
npm ci && npm run build       # produces dist/
node dist/cli.js --help       # run directly

# or run without installing, straight from GitHub:
npx github:lperez37/claude-tmux-run -- "your prompt"
```
</details>

## Usage

```
ccrun [options] "<prompt>"
ccrun [options] < prompt.txt      # prompt read from stdin when no argument
```

| Option | Default | Description |
|--------|---------|-------------|
| `--model <m>` | `claude-sonnet-4-6` | model id or alias (`sonnet`\|`opus`\|`haiku`) |
| `--cwd <dir>` | current dir | working directory for the run |
| `--timeout <seconds>` | `1800` | hard cap; on hit the session is killed and exit is `124` |
| `--plugin-dir <dir>` | — | passed to `claude --plugin-dir` when set |
| `--json` | off | emit a JSON result object on stdout instead of plain text |
| `--no-skip-permissions` | off | drop `--dangerously-skip-permissions` (will block on prompts) |
| `--quiet` / `--verbose` | — | stderr diagnostics verbosity |
| `-h, --help` / `-v, --version` | — | help / version |

**Output contract** (so it composes like `claude -p`):

- **stdout** — the final assistant message (clean text), or the JSON object with `--json`.
- **stderr** — all diagnostics.
- **exit codes** — `0` success · `1` failure (limit/error/stall) · `2` usage error · `124` timeout · `130` interrupted.

`--json` shape:

```json
{ "status": "succeeded", "exitCode": 0, "result": "...", "changedFiles": ["a.txt"], "sessionName": "ccr-1a2b3c4d", "usage": null }
```

## Use it in a loop

`ccrun` is the single-shot primitive; you bring the loop. A minimal Ralph-style
loop with fresh context each iteration and shared state via git:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

while ! grep -q '^DONE' STATUS 2>/dev/null; do
  ccrun --cwd "$PWD" --timeout 1200 "$(cat PROMPT.md)" || break
  git add -A && git commit -m "ralph iteration" || true
done
```

Because the output is the clean final message and the exit code is meaningful,
`ccrun` drops into anywhere you'd have used `claude -p`.

## How it works

1. Create a fresh tmux session `ccr-<id>` on a **private tmux socket** (fully
   isolated from your default tmux — see [Safety](#safety)).
2. Launch the interactive REPL: `env -u … TERM=xterm-256color claude
   --dangerously-skip-permissions --model … --settings <stop-hook>`
   (**never** `-p`, **never** `--max-turns`).
3. Wait for the input box, then deliver the prompt (short prompts are
   human-typed; larger ones are bracketed-pasted).
4. Detect turn completion via a per-run **Stop hook** — Claude writes the turn's
   final message into the hook payload, which `ccrun` reads directly (same text
   `claude -p` prints). A pane-scraping watcher + stall watchdog is the fallback.
5. Print the result, then reclaim the session (graceful `/exit` → `kill-session`
   → SIGTERM/SIGKILL backstop).

## Safety

- **Private socket per run.** Every run uses its own `tmux -L` server socket, so
  `ccrun` can never list, capture, or kill any tmux session you own. There is no
  global reaper and `tmux kill-server` is never called.
- **One owned session.** The run owns exactly one `ccr-<id>` session and always
  reclaims it — in a `finally` block, on timeout, and on SIGINT/SIGTERM.
- **`--dangerously-skip-permissions` is on by default** because the run is
  autonomous (no human to approve tool calls). Pass `--no-skip-permissions` to
  require approval — but then the run will block on the first prompt and time out.

## Credits

The completion-detection approach (interactive REPL in tmux + a Stop hook for
turn detection) is shared with [`claude-code-runner-tmux`] and was informed by
[Finndersen/claude-interactive-sdk](https://github.com/Finndersen/claude-interactive-sdk).

## License

MIT — see [LICENSE](./LICENSE).

[`claude-code-runner-tmux`]: https://github.com/lperez37
