# ccrun

Run one Claude Code turn and print the result. Same idea as `claude -p`, except it drives the interactive `claude` REPL inside a detached tmux session instead of print mode. That is the whole point: it keeps usage on your Claude subscription (the interactive pool) instead of the metered programmatic/API pool.

```console
$ ccrun "In one sentence, what is 6 times 7?"
6 times 7 is 42.
```

It is deliberately tiny and single-shot. No loops, no server, no daemon, no database. One prompt in, the final assistant message out, a clean exit code. Bring your own loop (bash, a Ralph loop, CI, whatever). See [Use it in a loop](#use-it-in-a-loop).

## Why

`claude -p "<prompt>"` runs Claude Code in print mode, which bills against the metered programmatic pool. Drive the interactive REPL instead (no `-p`, with the `entrypoint:cli` signature) and the work stays on your subscription. The problem is that doing this by hand is fiddly. You need a PTY, careful input delivery and a reliable way to know when the turn is actually done. `ccrun` packages all of that into one command with the same ergonomics as `claude -p`.

## Requirements

`ccrun` itself has zero runtime npm dependencies and no native build. It only needs these on the host:

| Requirement | Why | Check |
|-------------|-----|-------|
| **Node ≥ 22** | ESM + built-in `node:util` arg parsing | `node --version` |
| **tmux** | the run drives the REPL inside a detached tmux session | `tmux -V` |
| **`claude` CLI on PATH** | the agent being driven | `claude --version` |
| **Logged into an interactive subscription** | the whole point, keeps usage off the metered pool | run `claude` once; it should open the REPL, not ask for an API key |

`ccrun` runs a fast preflight on startup and exits with a clear message if `tmux` or `claude` is missing.

## Install

```bash
git clone https://github.com/lperez37/ccrun.git
cd ccrun
bash scripts/install.sh
```

`install.sh` builds the project and symlinks `ccrun` into `~/.local/bin` (override with `CCRUN_BIN_DIR=/some/dir`). It does not use `npm link`/`npm i -g` on purpose: those fail on NixOS because of the read-only nix-store global prefix, and they need `sudo` elsewhere. If `~/.local/bin` is not on your `PATH`, the script tells you what to add.

<details>
<summary>Manual install / other options</summary>

```bash
npm ci && npm run build       # produces dist/
node dist/cli.js --help       # run directly

# or run without installing, straight from GitHub:
npx github:lperez37/ccrun -- "your prompt"
```
</details>

## Usage

```
ccrun [options] "<prompt>"
ccrun [options] < prompt.txt      # prompt read from stdin when no argument
```

| Option | Default | Description |
|--------|---------|-------------|
| `-m, --model <m>` | `claude-sonnet-4-6` | model id or alias (`sonnet`\|`opus`\|`haiku`) |
| `-C, --cwd <dir>` | current dir | working directory for the run |
| `-t, --timeout <secs>` | `1800` | hard cap; on hit the session is killed and exit is `124` |
| `--plugin-dir <dir>` | — | passed to `claude --plugin-dir` when set |
| `-j, --json` | off | emit a JSON result object on stdout instead of plain text |
| `--no-skip-permissions` | off | drop `--dangerously-skip-permissions` (will block on prompts) |
| `-q, --quiet` / `--verbose` | — | stderr diagnostics verbosity |
| `-h, --help` / `-v, --version` | — | help / version |

Output contract (this is what lets it compose like `claude -p`):

- **stdout** is the final assistant message (clean text), or the JSON object when you pass `--json`.
- **stderr** is all diagnostics.
- **exit codes**: `0` success, `1` failure (limit/error/stall), `2` usage error, `124` timeout, `130` interrupted.

`--json` shape:

```json
{ "status": "succeeded", "exitCode": 0, "result": "...", "changedFiles": ["a.txt"], "sessionName": "ccr-1a2b3c4d", "usage": null }
```

## Use it in a loop

`ccrun` is the single-shot primitive. You bring the loop. Here is a minimal Ralph-style loop, fresh context every iteration and shared state via git:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

while ! grep -q '^DONE' STATUS 2>/dev/null; do
  ccrun --cwd "$PWD" --timeout 1200 "$(cat PROMPT.md)" || break
  git add -A && git commit -m "ralph iteration" || true
done
```

The output is the clean final message and the exit code means something, so `ccrun` drops in anywhere you were already using `claude -p`.

You do not have to hand-roll the loop, though. `ccrun` is now a first-class engine in [ralph-loop](https://github.com/lperez37/ralph-loop): pass `--engine ccrun` and the loop runs each iteration through `ccrun` instead of `claude -p`, so the iterations land on your subscription. The contract is identical (`stdin → final message on stdout → meaningful exit code`), which is exactly why ralph-loop's completion-promise detection and circuit breaker keep working unchanged.

## How it works

1. Create a fresh tmux session `ccr-<id>` on a private tmux socket (fully isolated from your default tmux, see [Safety](#safety)).
2. Launch the interactive REPL: `env -u … TERM=xterm-256color claude --dangerously-skip-permissions --model … --settings <stop-hook>`. Never `-p`, never `--max-turns`.
3. Wait for the input box, then deliver the prompt. Short prompts are human-typed, larger ones are bracketed-pasted.
4. Detect turn completion via a per-run Stop hook. Claude writes the turn's final message into the hook payload and `ccrun` reads it directly (same text `claude -p` prints). A pane-scraping watcher plus a stall watchdog is the fallback.
5. Print the result, then reclaim the session (graceful `/exit`, then `kill-session`, then a SIGTERM/SIGKILL backstop).

## Safety

This is the part I care about most, because an interactive REPL never self-terminates and a missed completion would otherwise pin a tmux session forever.

- **Private socket per run.** Every run gets its own `tmux -L` server socket, so `ccrun` cannot list, capture or kill any tmux session you own. There is no global reaper and `tmux kill-server` is never called.
- **One owned session.** The run owns exactly one `ccr-<id>` session and always reclaims it: in a `finally` block, on timeout and on SIGINT/SIGTERM.
- **`--dangerously-skip-permissions` is on by default**, because the run is autonomous and there is no human around to approve tool calls. Pass `--no-skip-permissions` if you want approval prompts, but then the run blocks on the first one and times out.

## Reliability

Honest status: solid for your own automation, not yet hardened infra for third parties.

- **Unit tests**: `npm test` runs the suite (170 tests) over the brittle core: pane phase detection, human typing, tmux argv, the kill ladder, private-socket isolation and version parsing.
- **Soak test**: `scripts/soak.sh 50 5` ran 50 instances (5 at a time) and passed 50/50, with zero leftover sockets, sessions or processes. Re-run it yourself: `scripts/soak.sh [runs] [concurrency]`.
- **AFK Ralph validation**: I wired `ccrun` in as a ralph-loop engine (`--engine ccrun`) and let it build four real apps fully unattended — three vanilla-JS browser games (Snake, 2048, Tetris) with pure logic modules tested via `node:test`, and a Python todo CLI tested via stdlib `unittest`. No third-party deps on purpose, so it exercises `ccrun`, not npm or pip. The four ran sequentially and completely AFK, ~6–8 min each, ~26 min total. Every loop exited by emitting its genuine completion promise (`BUILD SUCCEEDS AND ALL TESTS PASS`) — none hit the iteration cap, 0 stalls, 0 circuit-breaker trips, exit 0 each. I re-verified afterward: builds clean, tests green (7, 12, 7 and 14 tests). And **0 leftover tmux sockets, sessions or processes** after the whole run — the per-run private-socket isolation held across all 12 unattended iterations. With no human around, the driven agent was resourceful in the right way: it fixed a broken build script on its own and, when a `make` binary wasn't installed, ran the underlying commands directly — and only emitted the promise once the work actually passed.
- **The one real risk**: the pane-scraping completion fallback in `idle.ts` is tuned to a specific Claude Code release. The happy path (the Stop hook's `last_assistant_message`) does not depend on it, but the fallback does. `ccrun` parses `claude --version` on startup and warns when the installed version drifts from the tuned target (`src/version.ts`). The warning is non-fatal: the structured path still works.

So: the failure modes are safe (a run fails or times out, never a nuked tmux or orphaned processes), the success rate is high, and the one fragile component warns you when it might be out of date. Wrap it in a loop that checks exit codes and you are fine.

The honest trade-off versus `claude -p`: per iteration you only get the **final assistant message**. There is no `--output-format stream-json` equivalent, so you lose the full tool-call audit trail — you cannot replay exactly what the agent did mid-turn. For a loop that does not matter much in practice (the completion promise and git history tell you what happened), but if you need the per-tool stream for compliance or debugging, `claude -p` is still the tool for that. What you get in return is that the work stays on your subscription and the run cleans up after itself. For driving a loop, that is the trade I want.

## Credits

The completion-detection approach (interactive REPL in tmux plus a Stop hook for turn detection) is shared with [`claude-code-runner-tmux`] and was informed by [Finndersen/claude-interactive-sdk](https://github.com/Finndersen/claude-interactive-sdk).

## License

MIT, see [LICENSE](./LICENSE).

[`claude-code-runner-tmux`]: https://github.com/lperez37
