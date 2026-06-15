/**
 * StallWatchdog — per-run defense against a wedged REPL.
 *
 * Extracted (verbatim logic) from the v2 server's `stale.ts` §7 layer 2. The
 * single-shot CLI owns exactly one session, so the global reaper /
 * StaleSessionManager from the server is intentionally dropped — only this
 * watchdog is needed: if the pane signature stops changing AND the phase is not
 * `working` for `stallMs`, the run is stuck and gets failed + reclaimed.
 *
 * Pure except for the deliberately-held last-observation state. The clock is
 * injected so tests are deterministic.
 */

export const DEFAULT_STALL_MS = 4 * 60 * 1000; // 240_000

export type WatchdogPhase = "booting" | "working" | "idle" | "error" | "limit";

export interface StallWatchdogConfig {
  /** Stall threshold in ms (default 240_000 = 4 min). */
  readonly stallMs: number;
  /** Injectable clock; defaults to Date.now. */
  readonly now: () => number;
}

interface WatchdogState {
  readonly signature: string;
  readonly since: number;
}

/**
 * Fed successive (signature, phase) observations, decides the run is "stuck"
 * when the signature has not changed AND the phase is not `working` for at
 * least `stallMs`. A `working` phase always resets the clock — an actively
 * spinning Claude is not stalled even if the pane tail hashes the same twice.
 */
export class StallWatchdog {
  private readonly stallMs: number;
  private readonly now: () => number;
  private state: WatchdogState | null = null;

  constructor(config: Partial<StallWatchdogConfig> = {}) {
    this.stallMs = config.stallMs ?? DEFAULT_STALL_MS;
    this.now = config.now ?? Date.now;
  }

  /** Record one observation. Returns true if the run is now considered stalled. */
  observe(signature: string, phase: WatchdogPhase): boolean {
    const t = this.now();

    // An actively-working pane can never be stalled — reset the anchor.
    if (phase === "working") {
      this.state = { signature, since: t };
      return false;
    }

    const prev = this.state;
    if (prev === null || prev.signature !== signature) {
      this.state = { signature, since: t };
      return false;
    }

    return t - prev.since >= this.stallMs;
  }

  /** How long the current signature has been stable (ms), or 0 if no state. */
  stableForMs(): number {
    if (this.state === null) return 0;
    return Math.max(0, this.now() - this.state.since);
  }

  /** Reset the watchdog (e.g. after handling a stall). */
  reset(): void {
    this.state = null;
  }
}
