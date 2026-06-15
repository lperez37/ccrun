import { createHash } from "node:crypto";

/**
 * TUI phase detection + content-signature logic for the interactive `claude`
 * REPL driven inside tmux. See PLAN.md §6.
 *
 * This is the riskiest code in the repo: there is no exit code in interactive
 * mode, so completion is *inferred* by scraping the pane. All of the logic here
 * is PURE — no tmux IO, no `Date.now()`, no `Math.random()` — so it is fully
 * unit-testable and deterministic. The tmux/IO layer feeds pane snapshots and a
 * clock value in; this module only computes.
 */

/**
 * Coarse lifecycle state of the REPL pane, derived from a single capture.
 *
 * - `booting`  — session started, input box not yet ready (or a trust dialog
 *                is blocking, which waitForBoot must auto-confirm).
 * - `working`  — model is actively producing output (live "…(Ns)" counter).
 * - `idle`     — input box present, awaiting input (the done state, modulo guards).
 * - `error`    — an API/fatal error string is visible.
 * - `limit`    — a usage/rate-limit string is visible.
 */
export type Phase = "booting" | "working" | "idle" | "error" | "limit";

/**
 * Strip ANSI / CSI escape sequences (colors, cursor moves, OSC, etc.) from a
 * captured pane so the matchers below see plain text.
 *
 * tmux `capture-pane -e` (or a raw PTY scrape) leaves escape codes inline; the
 * detection patterns must run against cleaned text or they will miss matches
 * that are split by a color reset.
 */
/**
 * Strip ANSI escapes AND trailing per-line whitespace from a captured pane for
 * durable log storage. Single canonical implementation, shared with the
 * executor's harvest path so the two never diverge (an earlier executor copy
 * used a different, weaker regex).
 */
export function cleanPaneForLog(pane: string): string {
  return stripAnsi(pane).replace(/[ \t]+$/gm, "");
}

export function stripAnsi(s: string): string {
  // CSI sequences: ESC [ ... final-byte  (cursor/color/etc.)
  // OSC sequences: ESC ] ... (BEL | ESC \)  (window title, hyperlinks)
  // Single two-char escapes: ESC <byte>
  // eslint-disable-next-line no-control-regex
  const csi = /\[[0-?]*[ -/]*[@-~]/g;
  // eslint-disable-next-line no-control-regex
  const osc = /\][^]*(?:|\\)/g;
  // eslint-disable-next-line no-control-regex
  const single = /[@-Z\\-_]/g;
  return s.replace(csi, "").replace(osc, "").replace(single, "");
}

/**
 * Match patterns are TUNED per Claude Code version (current target 2.1.177).
 *
 * IMPORTANT: TUI strings drift across Claude Code releases. These arrays are
 * the single source of truth. They are now seeded from GROUND-TRUTH captures of
 * a live `claude 2.1.177` REPL in tmux 3.5a (the §10 fan-out de-risk pass), not
 * from the original PLAN.md §6 assumptions — several of which proved wrong on
 * 2.1.177 and have been corrected here:
 *
 *   - There is NO "esc to interrupt" string in 2.1.177 (the spec's primary
 *     WORKING signal is gone). Kept ONLY as a legacy fallback OR — never relied
 *     upon. The reliable working signal is the live elapsed counter `…(Ns)`.
 *   - The spinner is NOT braille — it is a star/asterisk animation rotating
 *     through `* · ✢ ✶ ✻ ✽`.
 *   - There is NO "? for shortcuts" idle hint. Idle is the input prompt char
 *     `❯`, the box rule of `─`, the status footer ("… N tokens" + model) and
 *     the bypass-permissions mode line.
 *
 * Treat any edit here as a versioned, evidence-backed change, not a guess.
 */

/**
 * The 2.1.177 working spinner glyph set (rotates every frame):
 * `*` U+002A, `·` U+00B7, `✢` U+2722, `✶` U+2736, `✻` U+273B, `✽` U+273D.
 * NOTE: the spinner glyph ALSO appears in the persisted done-line
 * (`✻ Cooked for 3s`), so glyph presence alone is NOT a working signal — see
 * {@link WORKING_PATTERNS} (it requires the live `…(Ns)` counter) and
 * {@link DONE_SPINNER}.
 */
const SPINNER_GLYPHS = /[*·✢✶✻✽]/;

/** Usage / rate-limit indicators. Highest priority — overrides everything. */
export const LIMIT_PATTERNS: readonly RegExp[] = [
  /usage limit/i,
  /rate limit/i,
  /approaching your .* limit/i,
  /you've reached your .* limit/i,
];

/**
 * Hard error indicators surfaced by the REPL ITSELF (claude's own error chrome),
 * NOT text that merely appears inside a tool result.
 *
 * History: a bare `/\bfatal\b/i` matched the OUTPUT of Claude's own
 * `git log` tool call (`fatal: your current branch 'main' does not have any
 * commits yet`) and killed a live ralph iteration mid-think — a false positive
 * on benign scrollback. Tool output (git, grep, node, file contents) routinely
 * contains the words "fatal", "Error:", "ECONNRESET" etc. without the REPL
 * being in any error state.
 *
 * These are scoped to claude's API-error presentation: `API Error` with a
 * trailing colon/paren, the structured overload code, and DNS/socket failures
 * surfaced by the API client (not a sub-shell). They are additionally gated by
 * detectPhase so they only count when the model is NOT actively working — a
 * genuine terminal API error stops the live `…(Ns)` spinner.
 */
export const ERROR_PATTERNS: readonly RegExp[] = [
  /API Error[:(]/i,
  /\boverloaded_error\b/i,
  /\bConnection error\b/i,
];

/**
 * Active-work indicators.
 *
 * PRIMARY (reliable on 2.1.177): the live elapsed counter `…(Ns)` that the
 * working status line carries, e.g. `✻ Percolating… (2s)`. The trailing
 * ellipsis U+2026 plus the `(\d+s)` counter is the STABLE signal — not any
 * specific verb or glyph. The combined matcher `<glyph> <Word>…(Ns)` is the
 * most specific. `esc to interrupt` is retained ONLY as a legacy/forward-compat
 * fallback; it does not exist in 2.1.177 and must never be required.
 */
// The live counter the working status line carries after the ellipsis. The
// counter has several real-world shapes that MUST all match, or a busy session
// reads as not-working (and then stalls or false-error):
//   `… (2s)`                          — simple seconds
//   `… (19s · thinking with high effort)` — seconds + suffix after `·`
//   `… (1m 9s · ↓ 4.0k tokens)`       — minutes+seconds + token suffix
// The stable, load-bearing signal is: ellipsis, then `(`, then an elapsed time
// (`\d+m? ?\d+s`), then anything up to the closing `)`. A trailing `· …` suffix
// is optional. Earlier this required `\(\d+s\)` exactly and silently missed the
// suffixed/minutes forms — the dominant shapes in long iterations.
const WORKING_ACTIVE = /…\s*\((?:\d+m\s*)?\d+s\b/;
const WORKING_COMBINED = /[*·✢✶✻✽]\s+\p{L}+…\s*\((?:\d+m\s*)?\d+s\b/u;

/**
 * Goal-overlay indicators (PLAN §14.4). When Claude's native `/goal` command is
 * active it renders a `◎ /goal active` overlay; that overlay is a WORKING signal
 * — the goal supervisor is pursuing the objective across turns, so the session
 * must NOT be treated as idle/done while it is present. These mirror
 * `goal.ts`'s `GOAL_ACTIVE_PATTERNS` and are intentionally DUPLICATED here
 * rather than imported: idle.ts is the lower-level module that goal.ts depends
 * on, so importing back would create a module cycle. goal.ts remains the source
 * of truth for goal-mode tracking; this copy only feeds `detectPhase` so a
 * goal-active pane classifies as `working`. Keep the two in sync when tuning.
 */
const GOAL_ACTIVE_PATTERNS: readonly RegExp[] = [
  /◎\s*\/goal\s+active/i,
  /◎.*\bgoal\b.*\b(\d+\s*(?:turns?|tokens?)|\d+s\b)/i,
  /\bgoal\s+active\b/i,
];

export const WORKING_PATTERNS: readonly RegExp[] = [
  WORKING_ACTIVE,
  WORKING_COMBINED,
  ...GOAL_ACTIVE_PATTERNS, // a live /goal overlay means the model is working
  /esc to interrupt/i, // legacy fallback only — absent in 2.1.177
];

/**
 * The persisted DONE line: the spinner verb switches to PAST tense with "for"
 * and NO ellipsis / NO counter, e.g. `✻ Cooked for 3s`. CRITICAL: this line
 * PERSISTS into the idle view, so it must NOT be treated as a working signal.
 * Exported as a positive hint that a turn finished; the authoritative complete
 * check stays the §6 signature-stable-while-idle rule.
 */
export const DONE_SPINNER = /[*·✢✶✻✽]\s+\p{L}+ for \d+s/u;

/**
 * Idle indicators: the input prompt box is present and awaiting input. Only
 * meaningful when NO working signal is also present (priority handles that).
 *
 * Idle ⇔ PROMPT_CHAR present AND (FOOTER or MODE_LINE present). The footer is
 * the status line carrying the model name and "N tokens"; the mode line is the
 * `⏵⏵ bypass permissions on (shift+tab to cycle)` indicator. BOX_RULE alone is
 * too weak (it also frames the trust dialog), so it is not used for idle.
 */
// The 2.1.177 TUI renders the prompt char followed by a NON-BREAKING space
// (U+00A0), not a regular space — confirmed via capture-pane ground truth
// (§10). Matching only a plain space here silently fails idle detection and
// hangs boot until timeout. Accept either whitespace form after `❯`.
const PROMPT_CHAR = /^❯[  ]/m;
const FOOTER = /│\s*\S*\s*\b(?:Haiku|Sonnet|Opus)\b.*\btokens\b/;
const MODE_LINE = /⏵⏵\s+bypass permissions on \(shift\+tab to cycle\)/;
export const IDLE_PATTERNS: readonly RegExp[] = [FOOTER, MODE_LINE];

/**
 * Trust / permission dialog shown on first run in an untrusted dir, even with
 * `--dangerously-skip-permissions`. waitForBoot MUST detect this and auto-Enter
 * (option 1 "Yes, I trust this folder" is pre-selected) or boot hangs forever.
 */
export const TRUST_DIALOG =
  /Quick safety check: Is this a project you created or one you trust\?/;
/** Confirmation hint shown beneath the trust dialog. */
export const TRUST_CONFIRM_HINT = /Enter to confirm · Esc to cancel/;
/** The Claude Code boot banner box, e.g. `╭─── Claude Code v2.1.177 ───`. */
export const BOOT_BANNER = /Claude Code v\d+\.\d+\.\d+/;

function anyMatch(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}

/**
 * Whether the captured pane is the trust / permission dialog that blocks boot.
 * waitForBoot uses this to auto-confirm before expecting the idle box.
 */
export function isTrustDialog(pane: string): boolean {
  return TRUST_DIALOG.test(stripAnsi(pane));
}

/**
 * Classify a single pane capture into a {@link Phase}.
 *
 * Priority order (PLAN.md §6): limit > error > working > idle > booting.
 * The pane is ANSI-stripped first. A pane showing BOTH a working signal and the
 * idle prompt resolves to `working` (the model is mid-turn; the box is stale).
 */
export function detectPhase(pane: string): Phase {
  const text = stripAnsi(pane);
  if (anyMatch(LIMIT_PATTERNS, text)) return "limit";
  // A live working spinner (`…(Ns)`) means the model is mid-turn: any
  // error-looking text in the scrollback is TOOL OUTPUT, not a terminal REPL
  // failure (a real API error halts the spinner). Working therefore takes
  // priority over error while the spinner is ticking. This prevents a benign
  // `fatal:`/`Error:` line in a git/grep result from killing a live iteration.
  const working = anyMatch(WORKING_PATTERNS, text);
  if (!working && anyMatch(ERROR_PATTERNS, text)) return "error";
  if (working) return "working";
  // Idle requires the input prompt char `❯` AND a settled-state marker (the
  // status footer with "N tokens" or the bypass-permissions mode line). The
  // box rule alone is insufficient — it also frames the trust dialog, which is
  // `booting` (handled by waitForBoot's auto-confirm), never idle.
  if (PROMPT_CHAR.test(text) && anyMatch(IDLE_PATTERNS, text)) return "idle";
  return "booting";
}

/**
 * Number of trailing lines hashed into a content signature.
 *
 * This MUST be large enough that a real job's answer still lies within the
 * hashed window at done-time. With a small window (e.g. 40), any non-trivial
 * job scrolls its prompt + response out of the tail, leaving only the static
 * input-box footer — which is byte-identical before submit and after
 * completion. The completion guard `signature ≠ baseline` then never trips and
 * the job hangs until the stall watchdog / timeout reaps it (PLAN §6 defect).
 *
 * Sized to cover effectively the whole `capture-pane -S -5000` scrollback so
 * the produced output region is always part of the signature.
 */
export const SIGNATURE_TAIL_LINES = 5000;

/**
 * Lines that are inherently VOLATILE in the 2.1.177 TUI chrome and must be
 * excluded from the content signature, or it can never stabilize:
 *
 *  - the working/done spinner line: `✻ Percolating… (2s)` mutates every second
 *    while working and persists as `✻ Cooked for 3s` afterwards;
 *  - the status footer: `/tmp │ Haiku 4.5 │ "title" │ $0.028 │ █░░ 15%  N tokens`
 *    — cost, context-window % bar and token count all tick continuously;
 *  - the bypass-permissions mode line and the cosmetic focus-events tip.
 *
 * Excluding these makes the signature hash the CONVERSATION region (the `● …`
 * assistant output lines) only, so a settled answer produces a stable hash even
 * though the footer keeps mutating (the §6 ground-truth recommendation).
 */
const VOLATILE_LINE_PATTERNS: readonly RegExp[] = [
  WORKING_ACTIVE, // live "…(Ns)" working counter line
  DONE_SPINNER, // persisted "for Ns" done line
  MODE_LINE, // ⏵⏵ bypass permissions mode line
  /│.*\btokens\b/, // status footer: cost / context bar / token count
  /focus-events/, // cosmetic tmux focus-events tip
  /◎.*\bgoal\b/i, // live /goal overlay (elapsed/turns/tokens tick constantly)
];

function isVolatileLine(line: string): boolean {
  return VOLATILE_LINE_PATTERNS.some((re) => re.test(line));
}

/**
 * Stable content signature of the pane's scrollback tail.
 *
 * = sha1 of the last {@link SIGNATURE_TAIL_LINES} cleaned lines, with trailing
 * whitespace trimmed per line, blank trailing lines dropped, AND volatile TUI
 * chrome lines removed ({@link VOLATILE_LINE_PATTERNS}). This detects "the pane
 * is still changing" (the model is still producing output) vs "the pane has
 * settled". The footer's cost/tokens/elapsed/context-bar mutate constantly and
 * would otherwise prevent the signature from ever stabilizing, so they are
 * stripped before hashing — the signature reflects the conversation region only.
 */
export function signature(pane: string): string {
  const cleaned = stripAnsi(pane);
  const lines = cleaned
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => !isVolatileLine(l));
  // Drop trailing blank lines so cursor-row churn doesn't change the hash.
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  const trimmed = lines.slice(0, end);
  const tail = trimmed.slice(-SIGNATURE_TAIL_LINES);
  return createHash("sha1").update(tail.join("\n")).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Shell-startup banner stripping (harvest hygiene)                            */
/* -------------------------------------------------------------------------- */

/**
 * Matches the echoed `claude` launch line in the captured pane. tmux starts the
 * host's LOGIN shell, which (on this NixOS host) prints `fastfetch` + a calendar
 * BEFORE `claude` is launched. The launch command itself is the reliable
 * boundary: everything at and above the line that runs `claude
 * --dangerously-skip-permissions …` is shell-startup noise (logo, sysinfo,
 * calendar, prompt) plus the echoed command, none of which belongs in
 * `result_summary`. The model's real output is strictly BELOW this line.
 *
 * Anchored loosely (the command may be preceded by a shell prompt) and tolerant
 * of the long flag list — we only need the `claude … --dangerously-skip-permissions`
 * pair to recognise the launch.
 */
const CLAUDE_LAUNCH_LINE =
  /^.*\bclaude\b.*--dangerously-skip-permissions\b.*$/m;

/**
 * Leading shell-startup noise patterns used ONLY by the fallback path (when no
 * launch line is found). Each must match a SINGLE line. fastfetch box-drawing
 * art (the NixOS snowflake logo built from block glyphs), the `Key: value`
 * sysinfo rows it prints, and a month-calendar weekday header.
 */
const SHELL_NOISE_LINE_PATTERNS: readonly RegExp[] = [
  // fastfetch logo art: lines made of block-drawing / shade glyphs (+ spaces).
  /^[\s▄▟▙█▛▜▝▀▖▗▘▚▞░▒▓]+$/u,
  // fastfetch sysinfo rows, e.g. `OS: NixOS`, `Kernel: 6.12`, `Memory: 4 GiB`.
  /^\s*(?:OS|Host|Kernel|Uptime|Packages|Shell|Memory|CPU|GPU|Resolution|DE|WM|Terminal|Disk|Swap|Locale|Theme|Icons|Battery|Users|Init|Local IP|Display|Board|BIOS):\s/,
  // calendar weekday header (any locale order of the two-letter day names).
  /^\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s+(?:Mo|Tu|We|Th|Fr|Sa|Su)){2,}\s*$/,
  // calendar body: a `cal`/calendar month title or a row of day numbers.
  /^\s*[A-Z][a-z]+\s+\d{4}\s*$/,
  /^\s*(?:\d{1,2}\s*){2,}$/,
];

/**
 * Strip the shell-startup banner (fastfetch logo + sysinfo + calendar + the
 * echoed launch command + shell prompt) from a harvested pane so it never
 * pollutes `result_summary` / the Discord embed. PURE — no IO, no clock.
 *
 * Primary rule: if the echoed `claude --dangerously-skip-permissions` launch
 * line is present, drop everything UP TO AND INCLUDING that line. That single
 * cut removes the entire preamble in one shot and leaves only the conversation
 * the model produced afterwards.
 *
 * Fallback (no launch line found — e.g. it scrolled out of the capture window):
 * conservatively strip a CONTIGUOUS leading run of obvious shell-startup noise
 * (fastfetch art, `Key: value` sysinfo, calendar). Stops at the first line that
 * is not recognised noise. Never strips from the middle or end — a non-noise
 * line followed by more noise keeps everything from that line onward.
 *
 * @param text Cleaned pane text (ANSI already stripped, e.g. via
 *             {@link cleanPaneForLog}).
 */
export function stripShellStartup(text: string): string {
  const launch = CLAUDE_LAUNCH_LINE.exec(text);
  if (launch) {
    // Drop everything up to and including the launch line (and its newline).
    const cutEnd = launch.index + launch[0].length;
    const after = text.slice(cutEnd).replace(/^\r?\n/, "");
    return after;
  }

  // Fallback: trim a leading contiguous block of shell-startup noise only.
  const lines = text.split("\n");
  let start = 0;
  while (start < lines.length) {
    const line = lines[start];
    // Allow blank lines inside the leading noise block (fastfetch pads with them)
    // but only while we are still inside the noise run.
    if (line.trim() === "") {
      start += 1;
      continue;
    }
    if (SHELL_NOISE_LINE_PATTERNS.some((re) => re.test(line))) {
      start += 1;
      continue;
    }
    break;
  }
  // If we never advanced, nothing looked like startup noise — return as-is.
  if (start === 0) return text;
  return lines.slice(start).join("\n").replace(/^\r?\n/, "");
}

/** Default consecutive-stable-poll count required to call a job complete. */
export const DEFAULT_STABLE_POLLS = 2;

/**
 * Minimum elapsed time since prompt submit before an unchanged-from-baseline
 * pane may be considered complete WITHOUT having observed a `working` phase.
 * Guards the case where the model answered so fast we never sampled `working`.
 */
export const DEFAULT_MIN_WORK_MS = 6000;

/** Tunable knobs for {@link CompletionTracker}. */
export interface CompletionConfig {
  /** Consecutive identical signatures required (K). Default {@link DEFAULT_STABLE_POLLS}. */
  readonly stablePolls?: number;
  /** Min ms since submit to allow completion absent a `working` observation. */
  readonly minWorkMs?: number;
}

/** A single poll observation fed to {@link CompletionTracker.observe}. */
export interface PollObservation {
  readonly phase: Phase;
  readonly signature: string;
  /** Caller-supplied clock value (ms). NEVER read from `Date.now()` here. */
  readonly nowMs: number;
}

/** Why a job is considered finished (or not yet). */
export interface CompletionResult {
  /** True iff the full completion rule (PLAN.md §6) is satisfied. */
  readonly complete: boolean;
  /** Terminal failure phase, if the pane shows `limit` or `error`. */
  readonly failure?: "limit" | "error";
  /** Count of consecutive identical signatures observed so far. */
  readonly stableCount: number;
}

/**
 * Stateful completion detector implementing PLAN.md §6:
 *
 *   complete ⇔ phase === 'idle'
 *            ∧ signature unchanged for K consecutive polls (default K=2)
 *            ∧ signature ≠ baseline (baseline captured just before submit)
 *            ∧ (sawWorking ∨ elapsedSinceSubmitMs > MIN_WORK_MS)
 *
 * Immutability note: this class holds a small amount of evolving counter state,
 * which is the explicit point of a *tracker*. It never mutates inputs and each
 * {@link observe} returns a fresh {@link CompletionResult}. The clock is fully
 * injected — every time value arrives via {@link PollObservation.nowMs} — so
 * tests run without real time.
 */
export class CompletionTracker {
  private readonly baseline: string;
  private readonly submittedAtMs: number;
  private readonly stablePolls: number;
  private readonly minWorkMs: number;

  private lastSignature: string | undefined;
  private stableCount = 0;
  private sawWorking = false;

  /**
   * @param baseline    Signature of the pane immediately BEFORE prompt submit.
   * @param submittedAtMs Clock value (ms) at submit. Used for the grace window.
   * @param config      Optional K / min-work overrides.
   */
  constructor(
    baseline: string,
    submittedAtMs: number,
    config: CompletionConfig = {},
  ) {
    this.baseline = baseline;
    this.submittedAtMs = submittedAtMs;
    this.stablePolls = config.stablePolls ?? DEFAULT_STABLE_POLLS;
    this.minWorkMs = config.minWorkMs ?? DEFAULT_MIN_WORK_MS;
  }

  /** Whether a `working` phase has been seen since construction. */
  get hasSeenWorking(): boolean {
    return this.sawWorking;
  }

  /**
   * Feed one poll observation. Returns a fresh result describing whether the
   * completion rule is now satisfied (or a terminal failure is visible).
   */
  observe(obs: PollObservation): CompletionResult {
    if (obs.phase === "working") {
      this.sawWorking = true;
    }

    // Track signature stability across consecutive polls.
    if (this.lastSignature === obs.signature) {
      this.stableCount += 1;
    } else {
      this.lastSignature = obs.signature;
      this.stableCount = 1;
    }

    if (obs.phase === "limit") {
      return { complete: false, failure: "limit", stableCount: this.stableCount };
    }
    if (obs.phase === "error") {
      return { complete: false, failure: "error", stableCount: this.stableCount };
    }

    const elapsedMs = obs.nowMs - this.submittedAtMs;
    const graceSatisfied = this.sawWorking || elapsedMs > this.minWorkMs;
    const complete =
      obs.phase === "idle" &&
      this.stableCount >= this.stablePolls &&
      obs.signature !== this.baseline &&
      graceSatisfied;

    return { complete, stableCount: this.stableCount };
  }
}
