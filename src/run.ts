import { execFile } from "node:child_process";
import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import type { Logger } from "./logger.js";
import { sleep } from "./sleep.js";
import { tmuxOnSocket, type Tmux } from "./tmux.js";
import { buildLaunchCommand } from "./launch.js";
import { reclaimSession } from "./kill.js";
import {
  DEFAULT_TYPING_PROFILE,
  keystrokes,
  mulberry32,
  samplePreDeliverPause,
  samplePreSubmitPause,
  seedFromJobId,
  shouldType,
  typingProfileFromEnv,
  type Keystroke,
  type Rng,
  type TypingProfile,
} from "./human-typing.js";
import type { KeystrokeProducer } from "./tmux.js";
import {
  cleanPaneForLog,
  CompletionTracker,
  detectPhase,
  isTrustDialog,
  signature,
  stripShellStartup,
} from "./idle.js";
import {
  cleanupStopHookArtifacts,
  createStopHookArtifacts,
  waitForStopHook,
} from "./stop-hook.js";
import { waitForTranscriptCompletion } from "./transcript.js";
import { StallWatchdog } from "./stall.js";

const execFileAsync = promisify(execFile);

/** Adapter narrowing `keystrokes` to tmux.ts's `KeystrokeProducer` shape. */
const keystrokeProducer: KeystrokeProducer = (
  text: string,
  profile: unknown,
  rng: () => number,
): Iterable<Keystroke> => keystrokes(text, profile as TypingProfile, rng);

const num = (raw: string | undefined, fallback: number): number => {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

/** Timing knobs (env-overridable, same names as the v2 server). */
const POLL_MS = num(process.env.POLL_MS, 4000);
const BOOT_MS = num(process.env.BOOT_MS, 60_000);
const STALL_MS = num(process.env.STALL_MS, 240_000);
const POST_LAUNCH_SETTLE_MS = 750;
const PASTE_SETTLE_MS = 1500;
const TRUST_CONFIRM_SETTLE_MS = 750;
/** Max bytes of harvested text kept as the result. */
const RESULT_MAX = 200_000;

export type RunStatus = "succeeded" | "failed" | "timed_out" | "canceled";

export interface RunOptions {
  readonly prompt: string;
  readonly model: string;
  readonly cwd: string;
  readonly timeoutSeconds: number;
  readonly pluginDir?: string;
  readonly skipPermissions?: boolean;
  /** Live-stream the raw REPL pane to stderr as the run progresses. */
  readonly stream?: boolean;
  /** External cancel (e.g. SIGINT). Composed with the internal timeout. */
  readonly signal?: AbortSignal;
  readonly logger: Logger;
  /** Injectable tmux client (tests pass a fake). Defaults to the real client. */
  readonly tmux?: Tmux;
  /** Session-name prefix. Default `ccr-`. */
  readonly sessionPrefix?: string;
}

export interface RunResult {
  readonly status: RunStatus;
  readonly exitCode: number;
  /** The final assistant message (or harvested pane fallback). */
  readonly result: string;
  readonly changedFiles: readonly string[];
  readonly sessionName: string;
  readonly usage: Record<string, number> | null;
  /** Failure reason when status !== succeeded. */
  readonly error?: string;
}

/**
 * Drive one interactive `claude` turn inside a fresh tmux session and return the
 * harvested result. Always reclaims the session (graceful → hard) and removes
 * the temp workspace, even on timeout/cancel/throw.
 */
export async function run(opts: RunOptions): Promise<RunResult> {
  const { logger } = opts;
  const prefix = opts.sessionPrefix ?? "ccr-";
  const runId = randomUUID().slice(0, 8);
  const sessionName = `${prefix}${runId}`;
  // Each run gets its OWN private tmux server socket — total isolation from the
  // user's default tmux, and immune to environments that reap the shared server.
  const socketName = `ccrun-${runId}`;
  const tmux = opts.tmux ?? tmuxOnSocket(socketName);
  const ownsSocket = !opts.tmux;
  const profile: TypingProfile =
    typingProfileFromEnv(process.env) ?? DEFAULT_TYPING_PROFILE;
  const rng: Rng = mulberry32(seedFromJobId(sessionName));

  // Compose the per-run timeout with any external (SIGINT) signal.
  const controller = new AbortController();
  const onExternalAbort = () =>
    controller.abort(opts.signal?.reason ?? new Error("canceled"));
  if (opts.signal) {
    if (opts.signal.aborted) onExternalAbort();
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new Error("timeout")),
    opts.timeoutSeconds * 1000,
  );
  const signal = controller.signal;

  const workingDir = await realpath(opts.cwd);
  const workspace = await mkdtemp(path.join(os.tmpdir(), "ccrun-"));
  const claudeSessionId = sessionName; // used only for artifact naming / fallback
  const artifacts = await createStopHookArtifacts(workspace, claudeSessionId);

  let harvested: { result: string; usage: Record<string, number> | null } = {
    result: "",
    usage: null,
  };
  let failure: string | null = null;
  const streamer = opts.stream ? new PaneStreamer() : null;

  try {
    // 1. Launch the REPL.
    await tmux.newSession(sessionName, workingDir);
    // --stream: pipe the raw pane to a file and tail it to stderr so the user
    // watches the whole session live. Set up right after the session exists so
    // boot output is captured too. Best-effort — never let it fail the run.
    if (streamer) {
      const streamFile = path.join(workspace, "stream.log");
      await writeFile(streamFile, "").catch(() => undefined);
      await tmux.pipePaneToFile(sessionName, streamFile).catch((e) =>
        logger.debug("pipe-pane failed; stream disabled", { error: errMsg(e) }),
      );
      streamer.start(streamFile);
    }
    const launchCmd = buildLaunchCommand({
      model: opts.model,
      pluginDir: opts.pluginDir,
      settingsPath: artifacts.settingsPath,
      skipPermissions: opts.skipPermissions,
    });
    // The launch command is shell input typed at the bash prompt — Claude never
    // sees its cadence (billing depends on the `entrypoint:cli` signature + no
    // `-p`, not on typing rhythm). Send it in ONE fast literal write; only the
    // prompt itself is human-typed. This also shrinks the flaky window where a
    // long char-by-char send could race the boot shell.
    await tmux.sendKeysLiteral(sessionName, launchCmd);
    await sleep(samplePreSubmitPause(profile, rng), signal);
    await tmux.sendEnter(sessionName);
    await sleep(POST_LAUNCH_SETTLE_MS, signal);
    await waitForBoot(sessionName, tmux, signal, logger);

    // 2. Deliver the prompt.
    const baseline = signature(await tmux.capturePane(sessionName));
    await deliverPrompt(sessionName, opts.prompt, workspace, profile, rng, tmux, signal);
    const submitMs = Date.now();

    // 3. Wait for completion (structured Stop/transcript vs pane polling).
    const completion = await waitForTurnCompletion(
      sessionName,
      baseline,
      submitMs,
      tmux,
      artifacts.stopPath,
      claudeSessionId,
      signal,
      logger,
    );
    failure = completion.failure;

    // 4. Harvest.
    harvested = await harvest(sessionName, tmux, completion);
  } catch (err) {
    failure = abortReason(signal) ?? errMsg(err);
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
    await reclaimSession(sessionName, { tmux, logger }).catch((e) =>
      logger.warn("reclaim failed", { sessionName, error: errMsg(e) }),
    );
    // Flush + stop the live stream before the workspace (holding stream.log) is
    // removed, so the final frames reach stderr.
    if (streamer) await streamer.stop();
    await cleanupStopHookArtifacts(artifacts);
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    // The private tmux server auto-exits once its only session is reclaimed, but
    // tmux leaves the now-stale socket file behind. Remove it so runs don't
    // accumulate dead sockets under the tmux tmpdir.
    if (ownsSocket) await removeStaleSocket(socketName);
  }

  const changedFiles = await collectChangedFiles(workingDir);
  const status = statusFromFailure(failure, signal);
  return {
    status,
    exitCode: status === "succeeded" ? 0 : status === "timed_out" ? 124 : 1,
    result: harvested.result.slice(0, RESULT_MAX),
    changedFiles,
    sessionName,
    usage: harvested.usage,
    error: failure ?? undefined,
  };
}

/** Poll capture-pane until the REPL input box is idle. Auto-confirms trust dialog. */
async function waitForBoot(
  session: string,
  tmux: Tmux,
  signal: AbortSignal,
  logger: Logger,
): Promise<void> {
  const deadline = Date.now() + BOOT_MS;
  while (Date.now() < deadline) {
    const pane = await tmux.capturePane(session);
    if (isTrustDialog(pane)) {
      logger.debug("trust dialog detected during boot — auto-confirming", { session });
      await tmux.sendEnter(session);
      await sleep(TRUST_CONFIRM_SETTLE_MS, signal);
      continue;
    }
    const phase = detectPhase(pane);
    if (phase === "idle") return;
    if (phase === "error" || phase === "limit") {
      throw new Error(`REPL entered '${phase}' phase during boot`);
    }
    await sleep(POLL_MS, signal);
  }
  throw new Error(`Boot timed out after ${BOOT_MS}ms`);
}

/** Type a short single-line prompt; bracketed-paste anything larger/multiline. */
async function deliverPrompt(
  session: string,
  prompt: string,
  workspace: string,
  profile: TypingProfile,
  rng: Rng,
  tmux: Tmux,
  signal: AbortSignal,
): Promise<void> {
  await sleep(samplePreDeliverPause(profile, rng), signal);
  if (shouldType(prompt)) {
    await tmux.humanSendText(session, prompt, profile, rng, {
      produce: keystrokeProducer,
      sleep,
      signal,
    });
  } else {
    const file = path.join(workspace, "prompt.txt");
    await writeFile(file, prompt, "utf-8");
    await tmux.loadBuffer(session, file);
    await sleep(samplePreSubmitPause(profile, rng), signal);
    await tmux.pasteBuffer(session, session);
    await sleep(PASTE_SETTLE_MS, signal);
  }
  await sleep(samplePreSubmitPause(profile, rng), signal);
  await tmux.sendEnter(session);
}

interface Completion {
  readonly failure: string | null;
  /** Clean final assistant text (from the Stop payload or transcript), if any. */
  readonly text: string | null;
  readonly usage: Record<string, number> | null;
}

/** Race the structured Stop/transcript signal against pane polling. */
async function waitForTurnCompletion(
  session: string,
  baseline: string,
  submitMs: number,
  tmux: Tmux,
  stopPath: string,
  claudeSessionId: string,
  signal: AbortSignal,
  logger: Logger,
): Promise<Completion> {
  const structuredController = new AbortController();
  const paneController = new AbortController();
  const abortBoth = () => {
    const reason = signal.reason ?? new Error("aborted");
    structuredController.abort(reason);
    paneController.abort(reason);
  };
  signal.addEventListener("abort", abortBoth, { once: true });

  const structured = (async (): Promise<Completion> => {
    const payload = await waitForStopHook(stopPath, structuredController.signal);
    // Claude Code >= 2.1.x hands the clean final message straight in the Stop
    // payload — same text `claude -p` prints. Prefer it: no transcript file to
    // locate (claude does not reliably persist the JSONL in this flow).
    const last =
      typeof payload.last_assistant_message === "string"
        ? payload.last_assistant_message
        : "";
    if (last.trim().length > 0) {
      logger.debug("structured completion via last_assistant_message", { session });
      return { failure: null, text: last, usage: null };
    }
    // Fallback: parse the transcript file if the payload lacked the message.
    const transcript = await waitForTranscriptCompletion(
      payload,
      claudeSessionId,
      structuredController.signal,
    );
    logger.debug("structured completion via transcript", {
      session,
      stopReason: transcript.stopReason,
    });
    return { failure: null, text: transcript.text, usage: transcript.usage };
  })();

  const pane = pollUntilComplete(
    session,
    baseline,
    submitMs,
    tmux,
    paneController.signal,
    logger,
  ).then((failure): Completion => ({ failure, text: null, usage: null }));

  try {
    return await Promise.race([structured, pane]);
  } catch (err) {
    if (signal.aborted) throw err;
    logger.debug("structured completion failed; using pane polling", {
      session,
      error: errMsg(err),
    });
    return await pane;
  } finally {
    signal.removeEventListener("abort", abortBoth);
    structuredController.abort(new Error("completion race ended"));
    paneController.abort(new Error("completion race ended"));
  }
}

/** Pane-polling completion: CompletionTracker + StallWatchdog. */
async function pollUntilComplete(
  session: string,
  baseline: string,
  submitMs: number,
  tmux: Tmux,
  signal: AbortSignal,
  logger: Logger,
): Promise<string | null> {
  const tracker = new CompletionTracker(baseline, submitMs);
  const watchdog = new StallWatchdog({ stallMs: STALL_MS });
  for (;;) {
    await sleep(POLL_MS, signal);
    const pane = await tmux.capturePane(session);
    const phase = detectPhase(pane);
    const sig = signature(pane);
    const result = tracker.observe({ phase, signature: sig, nowMs: Date.now() });
    if (result.failure) return result.failure;
    if (result.complete) return null;
    if (watchdog.observe(sig, phase)) {
      logger.warn("run stalled — watchdog fired", {
        session,
        stableForMs: watchdog.stableForMs(),
      });
      return "stalled";
    }
  }
}

/**
 * Build the result text + usage. Prefer the clean structured message (from the
 * Stop payload / transcript); fall back to a shell-startup-stripped pane scrape
 * only when the structured signal lost the race (e.g. pane polling completed
 * first). The structured text is what makes stdout match `claude -p`.
 */
async function harvest(
  session: string,
  tmux: Tmux,
  completion: Completion,
): Promise<{ result: string; usage: Record<string, number> | null }> {
  if (completion.text && completion.text.trim().length > 0) {
    return { result: completion.text, usage: completion.usage };
  }
  const pane = await tmux.capturePane(session);
  return { result: stripShellStartup(cleanPaneForLog(pane)), usage: completion.usage };
}

/** git diff (tracked) + untracked files in the working dir, if it is a repo. */
async function collectChangedFiles(workingDir: string): Promise<string[]> {
  try {
    const [tracked, untracked] = await Promise.all([
      execFileAsync("git", ["diff", "--name-only"], { cwd: workingDir }),
      execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], {
        cwd: workingDir,
      }),
    ]);
    return [...splitLines(tracked.stdout), ...splitLines(untracked.stdout)];
  } catch {
    return [];
  }
}

function statusFromFailure(failure: string | null, signal: AbortSignal): RunStatus {
  if (failure === null) return "succeeded";
  const reason = abortReason(signal);
  if (reason === "timeout") return "timed_out";
  if (reason === "canceled") return "canceled";
  return "failed";
}

function abortReason(signal: AbortSignal): string | null {
  if (!signal.aborted) return null;
  const r = signal.reason;
  if (r instanceof Error) return r.message;
  return typeof r === "string" ? r : "aborted";
}

function splitLines(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Tails the pipe-pane output file and writes new bytes to stderr as they appear,
 * so `--stream` shows the live REPL (ANSI included, so colors render). Polls the
 * file from a tracked byte offset; reopening each tick keeps it simple and
 * robust against the file not existing until the first pane output.
 */
class PaneStreamer {
  private offset = 0;
  private running = false;
  private loop: Promise<void> | null = null;
  private file = "";

  start(file: string): void {
    this.file = file;
    this.running = true;
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    const buf = Buffer.allocUnsafe(64 * 1024);
    while (this.running) {
      await this.drain(buf);
      await sleep(120).catch(() => undefined);
    }
    await this.drain(buf); // final flush after stop
  }

  private async drain(buf: Buffer): Promise<void> {
    try {
      const fh = await open(this.file, "r");
      try {
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
          if (bytesRead <= 0) break;
          this.offset += bytesRead;
          process.stderr.write(Buffer.from(buf.subarray(0, bytesRead)));
        }
      } finally {
        await fh.close();
      }
    } catch {
      // File not created yet (no pane output) — try again next tick.
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loop) await this.loop.catch(() => undefined);
  }
}

/**
 * Remove the stale private tmux socket file left behind after our server exits.
 * tmux stores sockets at `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/<socket>`. Best-effort:
 * a missing file or unknown uid is fine.
 */
async function removeStaleSocket(socketName: string): Promise<void> {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) return;
  const dir = path.join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${uid}`);
  await rm(path.join(dir, socketName), { force: true }).catch(() => undefined);
}
