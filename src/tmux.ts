import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

/**
 * Thin, injection-friendly async wrappers over the `tmux` CLI.
 *
 * Design rules (Luis's standards + PLAN §5/§7):
 * - NEVER build a shell string; always pass an argv array to execFile so a
 *   prompt, cwd, or buffer name can never be interpreted as shell syntax.
 * - Every wrapper is pure-ish: it shells out and returns data, never mutates
 *   module state. Returned objects are fresh.
 * - "Session not found" is a normal, expected condition for kill/has/capture
 *   on a reaped session — those paths resolve gracefully instead of throwing.
 * - The exec seam is injectable (`makeTmux(exec)`) so unit tests assert the
 *   exact argv without spawning a real tmux. The default export wires in the
 *   real promisified execFile.
 */

/** Result of a single tmux invocation. */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The exec seam. Matches the shape of `promisify(execFile)` but narrowed to
 * the (file, args) form we use. Injected so tests can assert argv and return
 * canned stdout without touching the host.
 */
export type Exec = (
  file: string,
  args: readonly string[],
) => Promise<ExecResult>;

/** One parsed entry from `tmux list-sessions`. */
export interface SessionInfo {
  readonly name: string;
  readonly activityEpoch: number;
  readonly attached: boolean;
}

/** A single human-cadence keystroke: one char (or chunk) plus the pause that precedes it. */
export interface Keystroke {
  readonly ch: string;
  readonly delayMs: number;
}

/**
 * Producer of human-cadence keystrokes. Structurally identical to
 * `human-typing.ts`'s `keystrokes(text, profile, rng)` so that module can be
 * passed in directly without a hard import (keeps tmux.ts decoupled from the
 * cadence model and trivially testable).
 */
export type KeystrokeProducer = (
  text: string,
  profile: unknown,
  rng: () => number,
) => Iterable<Keystroke>;

/** Abort-aware sleep. Injected so tests run instantly and cancel is testable. */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

const TMUX_BIN = "tmux";
const DEFAULT_CAPTURE_LINES = 5000;

/**
 * The explicit PATH every runner-owned tmux session boots with. We start
 * sessions under a NON-login, NO-rc `bash --norc --noprofile` so the host's
 * interactive shell rc (banners, fastfetch, calendars) NEVER runs and never
 * pollutes the captured pane. But a no-rc shell inherits NO profile PATH, so we
 * must set one explicitly or `claude` (and git/node) become unfindable.
 *
 * The base covers the common per-user and system bin dirs (`claude` typically
 * lives in `~/.local/bin`); `/run/current-system/sw/bin` and `~/.nix-profile/bin`
 * are NixOS-specific and simply absent (harmless) elsewhere. We then APPEND the
 * current `process.env.PATH` so whatever launched ccrun stays reachable.
 * Overridable wholesale via `RUNNER_SESSION_PATH`.
 */
export function defaultSessionPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RUNNER_SESSION_PATH && env.RUNNER_SESSION_PATH.length > 0) {
    return env.RUNNER_SESSION_PATH;
  }
  const home = os.homedir();
  const base = [
    `${home}/.local/bin`,
    `${home}/.nix-profile/bin`,
    "/run/current-system/sw/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
  const inherited = env.PATH ?? "";
  return inherited.length > 0 ? `${base}:${inherited}` : base;
}

/** The clean, no-rc login-free shell used for all runner sessions. */
const SESSION_SHELL = "bash";
const SESSION_SHELL_ARGS = ["--norc", "--noprofile"] as const;

/** tmux exits non-zero with a recognizable message when a target session is gone. */
function isSessionNotFound(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "";
  const haystack = message.toLowerCase();
  return (
    haystack.includes("can't find session") ||
    haystack.includes("session not found") ||
    haystack.includes("no such session") ||
    haystack.includes("can't find pane") ||
    haystack.includes("no server running")
  );
}

/** Options for {@link Tmux.newSession}. */
export interface NewSessionOptions {
  /**
   * Explicit PATH exported into the clean session (so `claude`/git/node are
   * findable under `bash --norc --noprofile`). Defaults to
   * {@link defaultSessionPath}.
   */
  readonly path?: string;
}

/** A tmux client bound to a specific exec seam. All methods are async. */
export interface Tmux {
  newSession(name: string, cwd: string, opts?: NewSessionOptions): Promise<void>;
  hasSession(name: string): Promise<boolean>;
  sendKeysLiteral(name: string, text: string): Promise<void>;
  sendEnter(name: string): Promise<void>;
  sendCtrlC(name: string): Promise<void>;
  capturePane(name: string, lines?: number): Promise<string>;
  loadBuffer(name: string, filePath: string): Promise<void>;
  pasteBuffer(name: string, bufferName: string): Promise<void>;
  listSessions(prefix: string): Promise<SessionInfo[]>;
  listPanePids(name: string): Promise<number[]>;
  killSession(name: string): Promise<boolean>;
  humanSendText(
    name: string,
    text: string,
    profile: unknown,
    rng: () => number,
    deps: HumanSendDeps,
  ): Promise<void>;
}

/** Dependencies injected into `humanSendText` to keep it pure-ish and test-friendly. */
export interface HumanSendDeps {
  /** Produces the keystroke stream (e.g. human-typing.ts `keystrokes`). */
  readonly produce: KeystrokeProducer;
  /** Abort-aware sleep. */
  readonly sleep: SleepFn;
  /** Optional abort signal; rejects in-flight sleeps and stops typing. */
  readonly signal?: AbortSignal;
}

/**
 * Build a Tmux client over the given exec seam. The default export below wires
 * in the real promisified execFile; tests pass a stub.
 */
export function makeTmux(exec: Exec, socket?: string): Tmux {
  // When a socket name is given, every tmux invocation is pinned to a PRIVATE
  // server via `-L <socket>` (socket lives at /tmp/tmux-<uid>/<socket>). This
  // isolates the run from the user's default tmux server entirely — ccrun can
  // never list, capture, or kill any session the user owns — and sidesteps any
  // environment that reaps the shared default-socket server.
  const socketArgs: readonly string[] = socket ? ["-L", socket] : [];
  async function run(args: readonly string[]): Promise<ExecResult> {
    return exec(TMUX_BIN, [...socketArgs, ...args]);
  }

  const newSession = async (
    name: string,
    cwd: string,
    opts: NewSessionOptions = {},
  ): Promise<void> => {
    // Start a CLEAN, non-login, no-rc shell with an EXPLICIT PATH (TASK 0 root
    // fix). tmux defaults to a LOGIN shell, which on this NixOS host sources the
    // interactive zsh rc → prints a `fastfetch` banner + a 3-month calendar that
    // gets captured into `result_summary`. `bash --norc --noprofile` skips all
    // that. The earlier concern that a no-rc bash "exited immediately" was a
    // PATH problem (no profile PATH → the launch never resolved).
    //
    // We CANNOT rely on tmux `-e PATH=…`: an already-running tmux SERVER passes
    // its OWN inherited environment to new panes, and the per-session `-e`
    // addition does not override a PATH the server already has (ground-truth:
    // the canary launched into the systemd PATH, which lacks ~/.local/bin, so
    // `claude` was not found). The robust fix is to bake the PATH into the shell
    // invocation: a no-rc bash that `export`s the explicit PATH and then `exec`s
    // an interactive no-rc bash. This guarantees PATH regardless of the server's
    // environment AND keeps the banner-free clean shell.
    const sessionPath = opts.path ?? defaultSessionPath();
    const bootShell = `export PATH='${sessionPath.replace(/'/g, "'\\''")}'; exec ${SESSION_SHELL} ${SESSION_SHELL_ARGS.join(" ")}`;
    await run([
      "new-session",
      "-d",
      "-s",
      name,
      "-c",
      cwd,
      SESSION_SHELL,
      ...SESSION_SHELL_ARGS,
      "-c",
      bootShell,
    ]);
    // Belt-and-suspenders: pin a low escape-time on THIS session so literal
    // send-keys is reliable regardless of host tmux.conf. The host default is
    // already 10ms (§10 found no tmux.conf change is REQUIRED — escape-time is
    // fine, and extended-keys/focus-events are irrelevant to `-l` literal byte
    // delivery), but setting it per-session makes the runner self-sufficient.
    // Scoped to `-t <name>` so it never touches the user's other sessions.
    try {
      await run(["set-option", "-t", name, "escape-time", "10"]);
    } catch {
      // Non-fatal: an older tmux that rejects per-session set-option still works
      // at the host default. Never let a cosmetic option block session launch.
    }
  };

  const hasSession = async (name: string): Promise<boolean> => {
    try {
      await run(["has-session", "-t", name]);
      return true;
    } catch (err) {
      // `has-session` exits non-zero when the session is absent. That is the
      // answer, not an error, so any failure here means "no".
      return false;
    }
  };

  const sendKeysLiteral = async (name: string, text: string): Promise<void> => {
    // `-l` = literal: send `text` verbatim, no key-name lookup or
    // space-stripping. `--` terminates option parsing so text starting with
    // `-` (or being any character) can never be read as a flag.
    //
    // SEMICOLON GUARD (tmux 3.5a, §10 ground-truth): a bare `;` sent as the
    // WHOLE argument is silently dropped — tmux's command lexer treats `;` as a
    // command separator before literal semantics apply, and `--` does NOT help.
    // Escaping it as `\;` delivers a literal `;` (incl. `;;`). Crucially this
    // only afflicts a standalone-`;` token; a `;` embedded in a longer argument
    // is delivered fine, so we escape ONLY when `text` is entirely semicolons.
    // (humanSendText sends one char per call, so its `;` chars hit this guard.)
    const escaped = /^;+$/.test(text) ? text.replace(/;/g, "\\;") : text;
    await run(["send-keys", "-t", name, "-l", "--", escaped]);
  };

  const sendEnter = async (name: string): Promise<void> => {
    await run(["send-keys", "-t", name, "Enter"]);
  };

  const sendCtrlC = async (name: string): Promise<void> => {
    await run(["send-keys", "-t", name, "C-c"]);
  };

  const capturePane = async (
    name: string,
    lines: number = DEFAULT_CAPTURE_LINES,
  ): Promise<string> => {
    // -p stdout, -e include escape sequences (so idle.ts can strip ANSI
    // deterministically), -J join wrapped lines, -S -<n> start n lines back
    // in the scrollback history.
    try {
      const { stdout } = await run([
        "capture-pane",
        "-t",
        name,
        "-p",
        "-e",
        "-J",
        "-S",
        `-${lines}`,
      ]);
      return stdout;
    } catch (err) {
      // A reaped session has no pane to capture — return empty rather than
      // throwing, so pollers see "nothing" instead of crashing.
      if (isSessionNotFound(err)) return "";
      throw err;
    }
  };

  const loadBuffer = async (name: string, filePath: string): Promise<void> => {
    // Per-session named buffer (`-b <name>`) avoids clobbering the user's
    // default tmux paste buffer. The buffer is loaded from a file on disk so
    // arbitrary multiline/quoted prompt content never passes through a shell.
    await run(["load-buffer", "-b", name, filePath]);
  };

  const pasteBuffer = async (
    name: string,
    bufferName: string,
  ): Promise<void> => {
    // `-p` requests BRACKETED paste: when the target app has enabled bracketed
    // paste mode (the real `claude` REPL does — §10 ground-truth), tmux wraps
    // the buffer in bracketed-paste control codes so it is ingested as ONE
    // atomic, multiline composer block (`❯ [Pasted text #1 +N lines]`) with NO
    // per-line submit. Without `-p`, paste-buffer's DEFAULT replaces every LF
    // with CR — which against any non-bracketed reader is N premature submits.
    // Making bracketed paste EXPLICIT removes that latent corruption risk
    // rather than depending on the default LF→CR fallback. The held block is
    // submitted later by a separate Enter after a settle pause (executor).
    await run(["paste-buffer", "-p", "-b", bufferName, "-t", name]);
  };

  const listSessions = async (prefix: string): Promise<SessionInfo[]> => {
    let stdout: string;
    try {
      const res = await run([
        "list-sessions",
        "-F",
        "#{session_name} #{session_activity} #{session_attached}",
      ]);
      stdout = res.stdout;
    } catch (err) {
      // No server / no sessions at all → no matching sessions.
      if (isSessionNotFound(err)) return [];
      throw err;
    }
    return parseSessionList(stdout, prefix);
  };

  const listPanePids = async (name: string): Promise<number[]> => {
    try {
      const { stdout } = await run([
        "list-panes",
        "-t",
        name,
        "-F",
        "#{pane_pid}",
      ]);
      return parsePanePids(stdout);
    } catch (err) {
      if (isSessionNotFound(err)) return [];
      throw err;
    }
  };

  const killSession = async (name: string): Promise<boolean> => {
    try {
      await run(["kill-session", "-t", name]);
      return true;
    } catch (err) {
      // Killing an already-gone session is a no-op success from the caller's
      // perspective (idempotent reaping). Distinguish only by return value.
      if (isSessionNotFound(err)) return false;
      throw err;
    }
  };

  const humanSendText = async (
    name: string,
    text: string,
    profile: unknown,
    rng: () => number,
    deps: HumanSendDeps,
  ): Promise<void> => {
    const { produce, sleep, signal } = deps;
    for (const { ch, delayMs } of produce(text, profile, rng)) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("humanSendText aborted");
      }
      // Pause BEFORE the keystroke (the delay is the inter-key interval that
      // precedes this char), then send the single literal char. sleep rejects
      // on abort so cancel/timeout interrupts mid-type.
      await sleep(delayMs, signal);
      await sendKeysLiteral(name, ch);
    }
  };

  return {
    newSession,
    hasSession,
    sendKeysLiteral,
    sendEnter,
    sendCtrlC,
    capturePane,
    loadBuffer,
    pasteBuffer,
    listSessions,
    listPanePids,
    killSession,
    humanSendText,
  };
}

/**
 * Parse `tmux list-sessions -F '#{session_name} #{session_activity} #{session_attached}'`
 * output, keeping only sessions whose name starts with `prefix`. Pure function
 * (exported for unit testing).
 *
 * Each line looks like: `ccr-owl-1234 1718460000 0`
 * - field 0: session name (no spaces — tmux session names cannot contain them)
 * - field 1: last-activity epoch seconds
 * - field 2: attached count (0 = detached, >0 = a client is attached)
 *
 * Malformed lines (wrong arity, non-numeric activity) are skipped rather than
 * throwing — a single bad line must not blind the reaper to every session.
 */
export function parseSessionList(
  stdout: string,
  prefix: string,
): SessionInfo[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line): SessionInfo[] => {
      const parts = line.split(/\s+/);
      if (parts.length < 3) return [];
      const [name, activityRaw, attachedRaw] = parts;
      if (!name.startsWith(prefix)) return [];
      const activityEpoch = Number.parseInt(activityRaw, 10);
      if (!Number.isFinite(activityEpoch)) return [];
      return [
        {
          name,
          activityEpoch,
          attached: attachedRaw !== "0" && attachedRaw !== "",
        },
      ];
    });
}

/**
 * Parse `tmux list-panes -F '#{pane_pid}'` output into a list of PIDs. Pure
 * function (exported for unit testing). Non-numeric or empty lines are skipped.
 */
export function parsePanePids(stdout: string): number[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line): number[] => {
      const pid = Number.parseInt(line, 10);
      return Number.isFinite(pid) && pid > 0 ? [pid] : [];
    });
}

/** Default promisified execFile seam. */
const execFileAsync = promisify(execFile);

const defaultExec: Exec = async (file, args) => {
  const { stdout, stderr } = await execFileAsync(file, [...args]);
  return { stdout, stderr };
};

/** The default, real-tmux client on the shared default socket. */
export const tmux: Tmux = makeTmux(defaultExec);

/**
 * Build a real-tmux client pinned to a PRIVATE server socket. ccrun creates one
 * per run so its tmux server is fully isolated from the user's default tmux —
 * the run can never see or touch any session the user owns.
 */
export function tmuxOnSocket(socket: string): Tmux {
  return makeTmux(defaultExec, socket);
}

export default tmux;
