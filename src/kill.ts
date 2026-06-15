import type { Tmux } from "./tmux.js";
import type { Logger } from "./logger.js";
import { sleep } from "./sleep.js";

/**
 * Gentle→hard reclaim ladder for the ONE session this run owns. Adapted from the
 * v2 server's escalation ladder, but deliberately NOT a reaper: it only ever
 * touches the exact session name passed in. There is no `list-sessions` sweep
 * and `tmux kill-server` is never invoked — so it can never affect another
 * tmux session on the host.
 *
 *   1. /exit + Enter   (let the REPL close cleanly)
 *   2. C-c             (interrupt any in-flight work)
 *   3. kill-session    (tmux teardown)
 *   4. SIGTERM → SIGKILL the pane process groups (backstop if tmux is wedged)
 *
 * Each step is best-effort and bounded; a failure is logged and the ladder
 * proceeds. Always converges on a dead session.
 */

export interface ReclaimConfig {
  readonly gentleWaitMs: number;
  readonly interruptWaitMs: number;
}

export const DEFAULT_RECLAIM_CONFIG: ReclaimConfig = {
  gentleWaitMs: 1500,
  interruptWaitMs: 1500,
};

/** Inject `process.kill` so the ladder is unit-testable without real signals. */
export type KillPidFn = (pid: number, signal: "SIGTERM" | "SIGKILL") => void;

const defaultKillPid: KillPidFn = (pid, signal) => {
  // Negative pid targets the whole process group, so a wedged child tree
  // (claude + node + any tool subprocess) goes down together. Falls back to the
  // bare pid if the group send fails (e.g. not a group leader).
  try {
    process.kill(-pid, signal);
  } catch {
    process.kill(pid, signal);
  }
};

export interface ReclaimDeps {
  readonly tmux: Tmux;
  readonly logger: Logger;
  readonly config?: Partial<ReclaimConfig>;
  readonly killPid?: KillPidFn;
}

export async function reclaimSession(
  session: string,
  deps: ReclaimDeps,
): Promise<void> {
  const { tmux, logger } = deps;
  const config = { ...DEFAULT_RECLAIM_CONFIG, ...deps.config };
  const killPid = deps.killPid ?? defaultKillPid;

  if (!(await tmux.hasSession(session))) return;

  // Capture pids up front for the OS backstop, before any teardown.
  const pids = await tmux.listPanePids(session).catch(() => [] as number[]);

  // Step 1: gentle /exit.
  try {
    await tmux.sendKeysLiteral(session, "/exit");
    await tmux.sendEnter(session);
    await sleep(config.gentleWaitMs).catch(() => undefined);
    if (!(await tmux.hasSession(session))) {
      logger.debug("session exited gracefully via /exit", { session });
      return;
    }
  } catch (err) {
    logger.debug("/exit failed; continuing ladder", { session, error: msg(err) });
  }

  // Step 2: C-c interrupt.
  try {
    await tmux.sendCtrlC(session);
    await sleep(config.interruptWaitMs).catch(() => undefined);
    if (!(await tmux.hasSession(session))) {
      logger.debug("session exited after C-c", { session });
      return;
    }
  } catch (err) {
    logger.debug("C-c failed; continuing ladder", { session, error: msg(err) });
  }

  // Step 3: tmux kill-session (the common, reliable path).
  try {
    await tmux.killSession(session);
    if (!(await tmux.hasSession(session))) {
      logger.debug("session killed via kill-session", { session });
      return;
    }
  } catch (err) {
    logger.warn("kill-session failed; falling back to PID kill", {
      session,
      error: msg(err),
    });
  }

  // Step 4: OS-level backstop (kill-session wedged).
  if (pids.length === 0) {
    logger.warn("no pane pids for backstop; session may be wedged", { session });
    return;
  }
  for (const pid of pids) {
    try {
      killPid(pid, "SIGTERM");
    } catch (err) {
      logger.debug("SIGTERM failed", { session, pid, error: msg(err) });
    }
  }
  await sleep(config.interruptWaitMs).catch(() => undefined);
  if (!(await tmux.hasSession(session))) return;
  for (const pid of pids) {
    try {
      killPid(pid, "SIGKILL");
      logger.warn("sent SIGKILL to pane process (last resort)", { session, pid });
    } catch (err) {
      logger.error("SIGKILL failed", { session, pid, error: msg(err) });
    }
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
