import { shellQuoteCommand } from "./shell-quote.js";

/**
 * Build the interactive `claude` launch command typed into the tmux session.
 *
 * Simplified from the v2 server's `buildLaunchCommand`: no job/DB, no
 * `--session-id`/`--resume` (pure one-shot). The load-bearing invariants are
 * preserved:
 *
 *  - NEVER `-p`: the print/programmatic flag bills against the metered pool.
 *    Driving the interactive REPL keeps usage on the subscription pool.
 *  - NEVER `--max-turns`: it is print-mode-only and silently ignored by the
 *    interactive REPL, so it would bound nothing. Bounding is owned by the
 *    per-run timeout + stall watchdog.
 *  - The env-strip (`env -u …`) clears any inherited tmux/claude markers so a
 *    nested launch (running ccrun from inside a claude/tmux session) starts
 *    clean.
 */

/**
 * Markers stripped from the launched process's environment. If ccrun is invoked
 * from within tmux or an existing claude session, these would otherwise leak in
 * and confuse the child REPL.
 */
export const CLAUDE_ENV_STRIP_VARS = [
  "TMUX",
  "TMUX_PANE",
  "TMUX_PLUGIN_MANAGER_PATH",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
] as const;

export interface LaunchOptions {
  readonly model: string;
  /** Passed to `--plugin-dir` only when set. */
  readonly pluginDir?: string;
  /** Stop-hook settings file passed to `--settings` (structured completion). */
  readonly settingsPath?: string;
  /** When false, `--dangerously-skip-permissions` is omitted. Default true. */
  readonly skipPermissions?: boolean;
}

export function buildLaunchCommand(opts: LaunchOptions): string {
  const skipPermissions = opts.skipPermissions ?? true;
  const parts: string[] = [
    "env",
    ...CLAUDE_ENV_STRIP_VARS.flatMap((name) => ["-u", name]),
    "TERM=xterm-256color",
    "claude",
  ];
  if (skipPermissions) parts.push("--dangerously-skip-permissions");
  if (opts.pluginDir) parts.push("--plugin-dir", opts.pluginDir);
  parts.push("--model", opts.model);
  if (opts.settingsPath) parts.push("--settings", opts.settingsPath);
  return shellQuoteCommand(parts);
}
