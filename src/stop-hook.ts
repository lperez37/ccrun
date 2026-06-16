import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { shellQuoteArg } from "./shell-quote.js";
import { sleep } from "./sleep.js";

/** How often {@link waitForStopHook} re-reads the append-only stop file. */
const STOP_POLL_MS = 150;

export interface StopHookArtifacts {
  readonly dir: string;
  readonly stopPath: string;
  /** File the injected statusLine overwrites with Claude's latest cost JSON. */
  readonly costPath: string;
  readonly settingsPath: string;
  readonly settingsJson: string;
}

export interface StopHookPayload {
  readonly session_id?: string;
  readonly transcript_path?: string;
  readonly hook_event_name?: string;
  /**
   * The clean final assistant message for the turn (Claude Code >= 2.1.x).
   * This is the same text `claude -p` prints, delivered straight in the Stop
   * payload — so we never need to locate/parse the transcript JSONL file.
   */
  readonly last_assistant_message?: string;
  readonly [key: string]: unknown;
}

export async function createStopHookArtifacts(
  workspace: string,
  sessionId: string,
): Promise<StopHookArtifacts> {
  const dir = path.join(workspace, ".runner", sessionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stopPath = path.join(dir, "stop.jsonl");
  const costPath = path.join(dir, "cost.json");

  // Start from a clean slate so a leftover file from a previous run can't be
  // mistaken for this run's completion signal.
  await rm(stopPath, { force: true });
  await rm(costPath, { force: true });

  const settings = buildStopHookSettings(stopPath, costPath);
  const settingsJson = JSON.stringify(settings);
  // Written to disk and passed to claude as `--settings <path>` (not inline
  // JSON), so the launch command stays short and the model never has a long
  // JSON blob typed into its shell keystroke-by-keystroke.
  const settingsPath = path.join(dir, "settings.json");
  await writeFile(settingsPath, `${settingsJson}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });

  return { dir, stopPath, costPath, settingsPath, settingsJson };
}

export function buildStopHookSettings(
  stopPath: string,
  costPath: string,
): Record<string, unknown> {
  return {
    // Inject our OWN statusLine (overrides the user's for this run) purely to
    // capture Claude Code's built-in cost: the statusLine command receives a
    // JSON payload on stdin that includes `cost.total_cost_usd`. We overwrite a
    // file with the latest payload each render (`cat >` — bounded size, always
    // the freshest cost) and produce no status text. This is host-agnostic: it
    // does NOT depend on whatever statusLine the user has configured.
    statusLine: {
      type: "command",
      command: `cat > ${shellQuoteArg(costPath)}`,
    },
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              // Append-only regular file: `cat >> file` NEVER blocks, so the
              // repeated Stop events that multi-turn sessions fire can never
              // stall the agent waiting on an absent reader (a FIFO would block
              // the second writer until the 600s hook timeout).
              command: `cat >> ${shellQuoteArg(stopPath)}`,
            },
          ],
        },
      ],
    },
  };
}

export async function cleanupStopHookArtifacts(
  artifacts: StopHookArtifacts | null | undefined,
): Promise<void> {
  if (!artifacts) return;
  await rm(artifacts.dir, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Poll the append-only stop file for the FIRST complete Stop-hook JSON payload.
 * Tolerates the hook still writing (partial line / missing trailing newline) and
 * extra payloads appended by later Stop events (only the first is consumed).
 */
export async function waitForStopHook(
  stopPath: string,
  signal: AbortSignal,
  opts: { pollMs?: number } = {},
): Promise<StopHookPayload> {
  const pollMs = opts.pollMs ?? STOP_POLL_MS;
  for (;;) {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    const result = readFirstPayload(await readStopFile(stopPath));
    if (result.state === "ok") return result.payload;
    if (result.state === "invalid") {
      throw new Error(`Invalid Stop hook payload: ${result.message}`);
    }
    await sleep(pollMs, signal);
  }
}

async function readStopFile(stopPath: string): Promise<string | null> {
  try {
    return await readFile(stopPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

type PayloadResult =
  | { state: "pending" }
  | { state: "ok"; payload: StopHookPayload }
  | { state: "invalid"; message: string };

function readFirstPayload(raw: string | null): PayloadResult {
  if (raw === null) return { state: "pending" };
  const newline = raw.indexOf("\n");
  const candidate = (newline === -1 ? raw : raw.slice(0, newline)).trim();
  if (candidate.length === 0) return { state: "pending" };
  try {
    return { state: "ok", payload: JSON.parse(candidate) as StopHookPayload };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // No newline yet → the hook is probably mid-write; keep waiting. A complete
    // line that still fails to parse is a genuine bad payload.
    return newline === -1 ? { state: "pending" } : { state: "invalid", message };
  }
}
